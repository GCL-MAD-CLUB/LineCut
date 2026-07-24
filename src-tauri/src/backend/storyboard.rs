use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{atomic::AtomicBool, Arc, Mutex as StdMutex, OnceLock};
use std::{env, fmt};

use ort::{
    execution_providers::DirectMLExecutionProvider,
    session::{builder::GraphOptimizationLevel, Session},
    value::Tensor,
};
use tauri::path::BaseDirectory;
use tokio::io::{AsyncRead, AsyncReadExt, BufReader};
use tokio::process::Child;
use uuid::Uuid;

use super::*;

const TRANSNET_RESOURCE_DIR: &str = "transnetv2";
const TRANSNET_MODEL_FILE: &str = "transnetv2.onnx";
const ONNXRUNTIME_DLL_FILE: &str = "onnxruntime.dll";
const DIRECTML_DLL_FILE: &str = "DirectML.dll";
const STORYBOARD_FRAME_WIDTH: usize = 48;
const STORYBOARD_FRAME_HEIGHT: usize = 27;
const STORYBOARD_FRAME_CHANNELS: usize = 3;
const STORYBOARD_FRAME_BYTES: usize =
    STORYBOARD_FRAME_WIDTH * STORYBOARD_FRAME_HEIGHT * STORYBOARD_FRAME_CHANNELS;
const TRANSNET_WINDOW_FRAMES: usize = 100;
const TRANSNET_CENTER_START: usize = 25;
const TRANSNET_CENTER_END: usize = 75;
const TRANSNET_STRIDE_FRAMES: usize = 50;
const STORYBOARD_DETECTION_THRESHOLD: f32 = 0.1;
const STORYBOARD_PROGRESS_PREDICT_END: f64 = 0.98;
const STORYBOARD_PROGRESS_MIN_DELTA: f64 = 0.0025;
const STORYBOARD_PROGRESS_FRAME_REPORT_INTERVAL: usize = 25;
const DEFAULT_STORYBOARD_FRAME_RATE: f64 = 25.0;

static ORT_INIT_LOCK: StdMutex<()> = StdMutex::new(());
static ORT_ENV_READY: OnceLock<()> = OnceLock::new();

#[derive(Clone)]
struct StoryboardRuntimePaths {
    runtime_dir: PathBuf,
    onnxruntime: PathBuf,
    directml: PathBuf,
    model: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoryboardShot {
    id: String,
    sequence: usize,
    start_frame: usize,
    end_frame: usize,
    start_us: i64,
    end_us: i64,
    score: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoryboardDetectionResult {
    asset_id: String,
    duration_us: i64,
    frame_count: usize,
    frame_rate: f64,
    threshold: f32,
    provider: String,
    shots: Vec<StoryboardShot>,
}

#[tauri::command]
pub(crate) async fn detect_storyboard_shots(
    asset_id: String,
    task_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<StoryboardDetectionResult> {
    let task = register_task(&task_id, state.inner())?;
    emit_ffmpeg_progress(&app, &task_id, 0.0);
    let project = project_clone(&asset_id, &state)?;
    let stream_index = project.asset.video_stream_index.ok_or_else(|| {
        app_error(
            ErrorCode::VideoStreamMissing,
            format!("Media asset has no video stream for storyboard detection: {asset_id}"),
        )
    })?;
    let preferences = preferences_clone(&state)?;
    let runtime = storyboard_runtime_paths(&app)?;
    init_storyboard_ort(&runtime)?;
    task.check_cancelled()?;

    let result = run_storyboard_detection(
        &app,
        state.inner(),
        &task_id,
        &project,
        stream_index,
        &preferences,
        &runtime,
        STORYBOARD_DETECTION_THRESHOLD,
        task.cancel_token(),
    )
    .await?;
    task.check_cancelled()?;
    emit_ffmpeg_progress(&app, &task_id, 1.0);
    Ok(result)
}

fn storyboard_runtime_paths(app: &tauri::AppHandle) -> AppResult<StoryboardRuntimePaths> {
    let mut candidates = Vec::new();
    if let Ok(path) = app
        .path()
        .resolve(TRANSNET_RESOURCE_DIR, BaseDirectory::Resource)
    {
        candidates.push(path);
    }
    if let Ok(current_exe) = env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            candidates.push(dir.join(TRANSNET_RESOURCE_DIR));
            candidates.push(dir.join("resources").join(TRANSNET_RESOURCE_DIR));
        }
    }
    if let Ok(current_dir) = env::current_dir() {
        candidates.push(
            current_dir
                .join("src-tauri")
                .join("resources")
                .join(TRANSNET_RESOURCE_DIR),
        );
        candidates.push(current_dir.join("resources").join(TRANSNET_RESOURCE_DIR));
    }

    let mut inspected = Vec::new();
    for dir in candidates {
        if inspected.iter().any(|known: &PathBuf| known == &dir) {
            continue;
        }
        inspected.push(dir.clone());
        let onnxruntime = dir.join(ONNXRUNTIME_DLL_FILE);
        let directml = dir.join(DIRECTML_DLL_FILE);
        let model = dir.join(TRANSNET_MODEL_FILE);
        if onnxruntime.is_file() && directml.is_file() && model.is_file() {
            return Ok(StoryboardRuntimePaths {
                runtime_dir: dir,
                onnxruntime,
                directml,
                model,
            });
        }
    }

    let searched = inspected
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join("; ");
    let resource_hint = format!(
        "Expected {ONNXRUNTIME_DLL_FILE}, {DIRECTML_DLL_FILE}, and {TRANSNET_MODEL_FILE} under one transnetv2 resource directory; searched: {searched}"
    );
    if inspected
        .iter()
        .any(|dir| dir.join(TRANSNET_MODEL_FILE).is_file())
    {
        Err(app_error(
            ErrorCode::StoryboardRuntimeMissing,
            resource_hint,
        ))
    } else {
        Err(app_error(ErrorCode::StoryboardModelMissing, resource_hint))
    }
}

fn init_storyboard_ort(runtime: &StoryboardRuntimePaths) -> AppResult<()> {
    if ORT_ENV_READY.get().is_some() {
        return Ok(());
    }
    let _guard = ORT_INIT_LOCK.lock().map_err(|_| {
        app_error(
            ErrorCode::StoryboardInferenceFailed,
            "ONNX Runtime initialization lock is poisoned",
        )
    })?;
    if ORT_ENV_READY.get().is_some() {
        return Ok(());
    }

    prepend_runtime_path(&runtime.runtime_dir);
    let onnxruntime = runtime.onnxruntime.to_string_lossy().into_owned();
    let init_result = std::panic::catch_unwind(|| {
        ort::init_from(onnxruntime)
            .with_name("linecut-transnetv2")
            .with_telemetry(false)
            .commit()
    });
    match init_result {
        Ok(Ok(_)) => {
            let _ = ORT_ENV_READY.set(());
            Ok(())
        }
        Ok(Err(error)) => Err(storyboard_ort_error("initialize ONNX Runtime", error)),
        Err(_) => Err(app_error(
            ErrorCode::StoryboardRuntimeMissing,
            format!(
                "Failed to load ONNX Runtime from {} with DirectML dependency {}",
                runtime.onnxruntime.display(),
                runtime.directml.display()
            ),
        )),
    }
}

fn prepend_runtime_path(runtime_dir: &PathBuf) {
    let current = env::var_os("PATH").unwrap_or_default();
    let mut paths = env::split_paths(&current).collect::<Vec<_>>();
    if !paths.iter().any(|path| path == runtime_dir) {
        paths.insert(0, runtime_dir.clone());
        if let Ok(joined) = env::join_paths(paths) {
            env::set_var("PATH", joined);
        }
    }
}

fn storyboard_ort_error(error_context: &str, error: impl fmt::Display) -> AppError {
    app_error(
        ErrorCode::StoryboardInferenceFailed,
        format!("Failed to {error_context}: {error}"),
    )
}

async fn run_storyboard_detection(
    app: &tauri::AppHandle,
    state: &AppState,
    task_id: &str,
    project: &Project,
    stream_index: i32,
    preferences: &Preferences,
    runtime: &StoryboardRuntimePaths,
    threshold: f32,
    cancel: Arc<AtomicBool>,
) -> AppResult<StoryboardDetectionResult> {
    let frame_rate = storyboard_frame_rate(project);
    let expected_frames = expected_frame_count(project.asset.duration_us, frame_rate);
    let mut progress = StoryboardProgressReporter::new(app, task_id, expected_frames);
    let mut session = create_transnet_session(&runtime.model)?;
    let mut child = spawn_storyboard_ffmpeg(project, stream_index, preferences)?;
    let process_id = Uuid::new_v4().to_string();
    let pid = child.id();
    if let Err(error) = register_running_ffmpeg(
        state,
        process_id.clone(),
        task_id.to_string(),
        cancel.clone(),
        pid,
        Vec::new(),
    ) {
        let _ = child.start_kill();
        return Err(error);
    }

    let stdout = child.stdout.take().ok_or_else(|| {
        app_error(
            ErrorCode::ExternalToolOutputUnavailable,
            "FFmpeg did not expose a storyboard frame stream",
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        app_error(
            ErrorCode::ExternalToolOutputUnavailable,
            "FFmpeg did not expose storyboard diagnostics",
        )
    })?;
    let stderr_task = tokio::spawn(async move {
        let mut body = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut body).await;
        body
    });

    let prediction_result = async {
        let mut reader = BufReader::new(stdout);
        let mut saw_first_frame = false;
        let mut last_frame: Option<Vec<u8>> = None;
        let mut window = VecDeque::<Vec<u8>>::with_capacity(TRANSNET_WINDOW_FRAMES);
        let mut predictions = Vec::<f32>::new();
        let mut decoded_frames = 0usize;
        let mut frame = vec![0u8; STORYBOARD_FRAME_BYTES];

        loop {
            ensure_not_cancelled(&cancel)?;
            let has_frame = read_storyboard_frame(&mut reader, &mut frame).await?;
            if !has_frame {
                break;
            }
            if !saw_first_frame {
                saw_first_frame = true;
                for _ in 0..TRANSNET_CENTER_START {
                    window.push_back(frame.clone());
                }
            }
            decoded_frames += 1;
            last_frame = Some(frame.clone());
            window.push_back(frame.clone());
            run_ready_storyboard_windows(
                &mut session,
                &mut window,
                &mut predictions,
                &mut progress,
                decoded_frames,
                &cancel,
            )?;
        }

        if decoded_frames == 0 {
            return Err(app_error(
                ErrorCode::StoryboardFrameDecodeFailed,
                "FFmpeg decoded no frames for storyboard detection",
            ));
        }

        let end_frame = last_frame.expect("decoded frame count is non-zero");
        while predictions.len() < decoded_frames {
            ensure_not_cancelled(&cancel)?;
            while window.len() < TRANSNET_WINDOW_FRAMES {
                window.push_back(end_frame.clone());
            }
            run_ready_storyboard_windows(
                &mut session,
                &mut window,
                &mut predictions,
                &mut progress,
                decoded_frames,
                &cancel,
            )?;
        }
        predictions.truncate(decoded_frames);
        progress.report_prediction_complete();
        Ok::<_, AppError>((decoded_frames, predictions))
    }
    .await;

    let (decoded_frames, predictions) = match prediction_result {
        Ok(result) => result,
        Err(error) => {
            kill_storyboard_ffmpeg(child, state, &process_id).await;
            let _ = stderr_task.await;
            return Err(error);
        }
    };

    let status = child.wait().await.map_err(|error| {
        app_error(
            ErrorCode::ExternalToolWaitFailed,
            format!("Failed to wait for FFmpeg storyboard extraction: {error}"),
        )
    })?;
    clear_running_ffmpeg(state, &process_id);
    let stderr = stderr_task.await.map_err(|error| {
        app_error(
            ErrorCode::BlockingTaskFailed,
            format!("Storyboard diagnostic reader failed to join: {error}"),
        )
    })?;
    ensure_not_cancelled(&cancel)?;
    if !status.success() {
        return Err(app_error(
            ErrorCode::ExternalToolExecutionFailed,
            format!("FFmpeg storyboard extraction exited unsuccessfully; stderr={stderr}"),
        ));
    }

    let shots = predictions_to_storyboard_shots(
        &predictions,
        STORYBOARD_DETECTION_THRESHOLD,
        frame_rate,
        project.asset.duration_us,
    );
    Ok(StoryboardDetectionResult {
        asset_id: project.asset.id.clone(),
        duration_us: project.asset.duration_us,
        frame_count: decoded_frames,
        frame_rate,
        threshold,
        provider: "DirectML".to_string(),
        shots,
    })
}

fn create_transnet_session(model_path: &PathBuf) -> AppResult<Session> {
    Session::builder()
        .map_err(|error| storyboard_ort_error("create TransNetV2 session builder", error))?
        .with_execution_providers([DirectMLExecutionProvider::default()
            .build()
            .error_on_failure()])
        .map_err(|error| storyboard_ort_error("enable DirectML execution provider", error))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|error| storyboard_ort_error("configure graph optimization", error))?
        .with_intra_threads(1)
        .map_err(|error| storyboard_ort_error("configure inference threads", error))?
        .commit_from_file(model_path)
        .map_err(|error| storyboard_ort_error("load TransNetV2 ONNX model", error))
}

fn spawn_storyboard_ffmpeg(
    project: &Project,
    stream_index: i32,
    preferences: &Preferences,
) -> AppResult<Child> {
    let args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-i".to_string(),
        project.asset.path.clone(),
        "-map".to_string(),
        format!("0:{stream_index}"),
        "-an".to_string(),
        "-sn".to_string(),
        "-dn".to_string(),
        "-vf".to_string(),
        format!(
            "scale={STORYBOARD_FRAME_WIDTH}:{STORYBOARD_FRAME_HEIGHT}:flags=bilinear,format=rgb24"
        ),
        "-vsync".to_string(),
        "0".to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "pipe:1".to_string(),
    ];
    hidden_command(&ffmpeg_program(preferences))
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            app_error(
                ErrorCode::ExternalToolStartFailed,
                format!("Failed to start FFmpeg storyboard extraction: {error}"),
            )
        })
}

async fn read_storyboard_frame<R>(reader: &mut R, frame: &mut [u8]) -> AppResult<bool>
where
    R: AsyncRead + Unpin,
{
    let mut filled = 0usize;
    while filled < frame.len() {
        let read = reader.read(&mut frame[filled..]).await.map_err(|error| {
            app_error(
                ErrorCode::StoryboardFrameDecodeFailed,
                format!("Failed to read storyboard frame bytes: {error}"),
            )
        })?;
        if read == 0 {
            if filled == 0 {
                return Ok(false);
            }
            return Err(app_error(
                ErrorCode::StoryboardFrameDecodeFailed,
                format!(
                    "FFmpeg ended in the middle of a storyboard frame: read {filled}/{} bytes",
                    frame.len()
                ),
            ));
        }
        filled += read;
    }
    Ok(true)
}

fn run_ready_storyboard_windows(
    session: &mut Session,
    window: &mut VecDeque<Vec<u8>>,
    predictions: &mut Vec<f32>,
    progress: &mut StoryboardProgressReporter<'_>,
    known_frames: usize,
    cancel: &AtomicBool,
) -> AppResult<()> {
    while window.len() >= TRANSNET_WINDOW_FRAMES {
        ensure_not_cancelled(cancel)?;
        let next = run_transnet_window(session, window)?;
        predictions.extend(next);
        for _ in 0..TRANSNET_STRIDE_FRAMES {
            window.pop_front();
        }
        progress.report_predicted(predictions.len(), known_frames);
    }
    Ok(())
}

fn run_transnet_window(session: &mut Session, window: &VecDeque<Vec<u8>>) -> AppResult<Vec<f32>> {
    let mut input = Vec::with_capacity(TRANSNET_WINDOW_FRAMES * STORYBOARD_FRAME_BYTES);
    for frame in window.iter().take(TRANSNET_WINDOW_FRAMES) {
        input.extend(frame.iter().map(|value| *value as f32));
    }
    let tensor = Tensor::<f32>::from_array((
        vec![
            1_i64,
            TRANSNET_WINDOW_FRAMES as i64,
            STORYBOARD_FRAME_HEIGHT as i64,
            STORYBOARD_FRAME_WIDTH as i64,
            STORYBOARD_FRAME_CHANNELS as i64,
        ],
        input,
    ))
    .map_err(|error| storyboard_ort_error("create TransNetV2 input tensor", error))?;
    let input_name = session
        .inputs
        .first()
        .map(|input| input.name.clone())
        .unwrap_or_else(|| "input".to_string());
    let outputs = session
        .run(
            ort::inputs! {
                input_name => tensor
            }
            .map_err(|error| storyboard_ort_error("bind TransNetV2 input", error))?,
        )
        .map_err(|error| storyboard_ort_error("run TransNetV2 inference", error))?;
    if outputs.len() == 0 {
        return Err(app_error(
            ErrorCode::StoryboardInferenceFailed,
            "TransNetV2 produced no output tensors",
        ));
    }
    let output = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|error| storyboard_ort_error("extract TransNetV2 predictions", error))?;
    let values = output.iter().copied().collect::<Vec<_>>();
    if values.len() < TRANSNET_CENTER_END {
        return Err(app_error(
            ErrorCode::StoryboardInferenceFailed,
            format!(
                "TransNetV2 output is too short: {} values, expected at least {TRANSNET_CENTER_END}",
                values.len()
            ),
        ));
    }
    let needs_sigmoid = values.iter().any(|value| *value < 0.0 || *value > 1.0);
    Ok(values[TRANSNET_CENTER_START..TRANSNET_CENTER_END]
        .iter()
        .map(|value| {
            if needs_sigmoid {
                1.0 / (1.0 + (-*value).exp())
            } else {
                value.clamp(0.0, 1.0)
            }
        })
        .collect())
}

struct StoryboardProgressReporter<'a> {
    app: &'a tauri::AppHandle,
    task_id: &'a str,
    expected_frames: usize,
    last_progress: f64,
    last_predicted_frames: usize,
}

impl<'a> StoryboardProgressReporter<'a> {
    fn new(app: &'a tauri::AppHandle, task_id: &'a str, expected_frames: usize) -> Self {
        Self {
            app,
            task_id,
            expected_frames,
            last_progress: 0.0,
            last_predicted_frames: 0,
        }
    }

    fn report_predicted(&mut self, predicted_frames: usize, known_frames: usize) {
        if !Self::should_report_frames(self.last_predicted_frames, predicted_frames) {
            return;
        }
        self.last_predicted_frames = predicted_frames;
        let denominator = self.frame_denominator(known_frames.max(predicted_frames));
        self.emit(
            (predicted_frames as f64 / denominator as f64).clamp(0.0, 1.0)
                * STORYBOARD_PROGRESS_PREDICT_END,
            false,
        );
    }

    fn report_prediction_complete(&mut self) {
        self.emit(STORYBOARD_PROGRESS_PREDICT_END, true);
    }

    fn frame_denominator(&self, observed_frames: usize) -> usize {
        if self.expected_frames > 0 {
            return self.expected_frames.max(observed_frames).max(1);
        }
        observed_frames
            .saturating_add(TRANSNET_WINDOW_FRAMES * 8)
            .max(1)
    }

    fn should_report_frames(previous: usize, current: usize) -> bool {
        current > previous
            && current.saturating_sub(previous) >= STORYBOARD_PROGRESS_FRAME_REPORT_INTERVAL
    }

    fn emit(&mut self, progress: f64, force: bool) {
        let progress = progress.clamp(0.0, STORYBOARD_PROGRESS_PREDICT_END);
        if progress <= self.last_progress {
            return;
        }
        if force || progress - self.last_progress >= STORYBOARD_PROGRESS_MIN_DELTA {
            self.last_progress = progress;
            emit_ffmpeg_progress(self.app, self.task_id, progress);
        }
    }
}

async fn kill_storyboard_ffmpeg(mut child: Child, state: &AppState, process_id: &str) {
    let _ = child.start_kill();
    let _ = child.wait().await;
    clear_running_ffmpeg(state, process_id);
}

fn storyboard_frame_rate(project: &Project) -> f64 {
    let stream = project
        .streams
        .iter()
        .find(|stream| Some(stream.index) == project.asset.video_stream_index)
        .or_else(|| {
            project
                .streams
                .iter()
                .find(|stream| stream.codec_type == "video")
        });
    stream
        .and_then(|stream| {
            parse_frame_rate(stream.avg_frame_rate.as_deref())
                .or_else(|| parse_frame_rate(stream.r_frame_rate.as_deref()))
        })
        .unwrap_or(DEFAULT_STORYBOARD_FRAME_RATE)
}

fn parse_frame_rate(value: Option<&str>) -> Option<f64> {
    let value = value?.trim();
    if value.is_empty() || value == "0/0" {
        return None;
    }
    if let Some((numerator, denominator)) = value.split_once('/') {
        let numerator = numerator.parse::<f64>().ok()?;
        let denominator = denominator.parse::<f64>().ok()?;
        if denominator <= 0.0 {
            return None;
        }
        let rate = numerator / denominator;
        return (rate.is_finite() && rate > 0.0).then_some(rate);
    }
    let rate = value.parse::<f64>().ok()?;
    (rate.is_finite() && rate > 0.0).then_some(rate)
}

fn expected_frame_count(duration_us: i64, frame_rate: f64) -> usize {
    if duration_us <= 0 || !frame_rate.is_finite() || frame_rate <= 0.0 {
        return 0;
    }
    ((duration_us as f64 / 1_000_000.0) * frame_rate).ceil() as usize
}

fn frame_to_time_us(frame: usize, frame_rate: f64, duration_us: i64) -> i64 {
    if !frame_rate.is_finite() || frame_rate <= 0.0 {
        return 0;
    }
    (((frame as f64 / frame_rate) * 1_000_000.0).round() as i64).clamp(0, duration_us.max(0))
}

fn predictions_to_storyboard_shots(
    predictions: &[f32],
    threshold: f32,
    frame_rate: f64,
    duration_us: i64,
) -> Vec<StoryboardShot> {
    if predictions.is_empty() {
        return Vec::new();
    }

    let mut raw_ranges = Vec::<(usize, usize)>::new();
    let mut previous_cut = false;
    let mut start = 0usize;
    let mut last_index = 0usize;
    for (index, prediction) in predictions.iter().enumerate() {
        let cut = *prediction > threshold;
        if previous_cut && !cut {
            start = index;
        }
        if !previous_cut && cut && index != 0 {
            raw_ranges.push((start, index));
        }
        previous_cut = cut;
        last_index = index;
    }
    if !previous_cut {
        raw_ranges.push((start, last_index));
    }
    if raw_ranges.is_empty() {
        raw_ranges.push((0, predictions.len() - 1));
    }

    raw_ranges
        .into_iter()
        .enumerate()
        .map(|(index, (start_frame, end_frame))| {
            let start_us = frame_to_time_us(start_frame, frame_rate, duration_us);
            let mut end_us = frame_to_time_us(end_frame.saturating_add(1), frame_rate, duration_us);
            if end_us <= start_us {
                end_us = (start_us + frame_to_time_us(1, frame_rate, duration_us).max(1))
                    .min(duration_us.max(start_us));
            }
            StoryboardShot {
                id: format!("shot:{start_frame}:{end_frame}"),
                sequence: index + 1,
                start_frame,
                end_frame,
                start_us,
                end_us,
                score: shot_boundary_score(predictions, end_frame),
            }
        })
        .collect()
}

fn shot_boundary_score(predictions: &[f32], end_frame: usize) -> f32 {
    let start = end_frame.saturating_sub(2);
    let end = end_frame
        .saturating_add(2)
        .min(predictions.len().saturating_sub(1));
    predictions[start..=end]
        .iter()
        .copied()
        .fold(0.0_f32, f32::max)
        .clamp(0.0, 1.0)
}
