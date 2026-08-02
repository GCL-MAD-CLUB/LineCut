use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{atomic::AtomicBool, Arc, Mutex as StdMutex, OnceLock};
use std::{env, fmt};

use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
use tokio::io::{AsyncRead, AsyncReadExt, BufReader};
use tokio::process::Child;
use uuid::Uuid;

use super::low_level_features::{
    LowLevelFeatureExtractor, FEATURE_FRAME_BYTES, FEATURE_FRAME_HEIGHT, FEATURE_FRAME_WIDTH,
};
use super::scene_cut_refiner::{
    refine_full_video, FrameCutPrediction, RawFrameFeatures, RefinerConfig, RefinerEngine,
    RefinerManifest,
};
use super::transnet::{
    create_transnet_session, downsample_for_transnet, run_transnet_window, TransNetPrediction,
    TRANSNET_CENTER_START, TRANSNET_STRIDE_FRAMES, TRANSNET_WINDOW_FRAMES,
};
use super::*;

const TRANSNET_RESOURCE_DIR: &str = "transnetv2";
const TRANSNET_MODEL_FILE: &str = "transnetv2.onnx";
const REFINER_MODEL_FILE: &str = "scene_cut_refiner.onnx";
const REFINER_MANIFEST_FILE: &str = "scene_cut_refiner.manifest.json";
const ONNXRUNTIME_DLL_FILE: &str = "onnxruntime.dll";
const DIRECTML_DLL_FILE: &str = "DirectML.dll";
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
    transnet_model: PathBuf,
    refiner_manifest: PathBuf,
    refiner_model: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoryboardCut {
    cut_frame: usize,
    pts: i64,
    base_logit: f32,
    delta_logit: f32,
    final_logit: f32,
    probability: f32,
}

impl From<FrameCutPrediction> for StoryboardCut {
    fn from(prediction: FrameCutPrediction) -> Self {
        debug_assert!(prediction.is_cut);
        Self {
            cut_frame: prediction.frame_index,
            pts: prediction.pts,
            base_logit: prediction.base_logit,
            delta_logit: prediction.delta_logit,
            final_logit: prediction.final_logit,
            probability: prediction.probability,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StoryboardShot {
    id: String,
    sequence: usize,
    start_frame: usize,
    end_frame: usize,
    start_us: i64,
    end_us: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoryboardDetectionResult {
    asset_id: String,
    duration_us: i64,
    frame_count: usize,
    frame_rate: f64,
    provider: String,
    cuts: Vec<StoryboardCut>,
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
    project.asset.video_stream_index.ok_or_else(|| {
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
        &preferences,
        &runtime,
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
        let transnet_model = dir.join(TRANSNET_MODEL_FILE);
        let refiner_manifest = dir.join(REFINER_MANIFEST_FILE);
        if onnxruntime.is_file()
            && directml.is_file()
            && transnet_model.is_file()
            && refiner_manifest.is_file()
        {
            let refiner_model = dir.join(REFINER_MODEL_FILE);
            return Ok(StoryboardRuntimePaths {
                runtime_dir: dir,
                onnxruntime,
                directml,
                transnet_model,
                refiner_manifest,
                refiner_model: refiner_model.is_file().then_some(refiner_model),
            });
        }
    }

    let searched = inspected
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join("; ");
    let resource_hint = format!(
        "Expected {ONNXRUNTIME_DLL_FILE}, {DIRECTML_DLL_FILE}, {TRANSNET_MODEL_FILE}, and {REFINER_MANIFEST_FILE} under one transnetv2 resource directory; {REFINER_MODEL_FILE} is optional; searched: {searched}"
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
            .with_name("linecut-scene-cut")
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

fn prepend_runtime_path(runtime_dir: &Path) {
    let current = env::var_os("PATH").unwrap_or_default();
    let mut paths = env::split_paths(&current).collect::<Vec<_>>();
    if !paths.iter().any(|path| path == runtime_dir) {
        paths.insert(0, runtime_dir.to_path_buf());
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
    preferences: &Preferences,
    runtime: &StoryboardRuntimePaths,
    cancel: Arc<AtomicBool>,
) -> AppResult<StoryboardDetectionResult> {
    let stream_index = project
        .asset
        .video_stream_index
        .expect("video stream was validated by the command boundary");
    let frame_pts = probe_storyboard_frame_pts(
        project,
        stream_index,
        preferences,
        state,
        task_id,
        cancel.clone(),
    )
    .await?;
    let manifest = RefinerManifest::load(&runtime.refiner_manifest, &runtime.transnet_model)?;
    let mut refiner = RefinerEngine::load(runtime.refiner_model.as_deref(), manifest)?;
    if runtime.refiner_model.is_none() {
        tracing::info!(
            "scene_cut_refiner.onnx is absent; using the dual-head calibrator with delta_logits=0"
        );
    }
    let provider = refiner.provider_name().to_string();
    let frame_rate = storyboard_frame_rate(project);
    let mut progress = StoryboardProgressReporter::new(app, task_id, frame_pts.len());
    let mut transnet_session = create_transnet_session(&runtime.transnet_model)?;
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
        let mut last_transnet_frame: Option<Vec<u8>> = None;
        let mut window = VecDeque::<Vec<u8>>::with_capacity(TRANSNET_WINDOW_FRAMES);
        let mut transnet_predictions = Vec::<TransNetPrediction>::new();
        let mut low_level_extractor = LowLevelFeatureExtractor::new();
        let mut decoded_frames = 0usize;
        let mut frame = vec![0u8; FEATURE_FRAME_BYTES];

        loop {
            ensure_not_cancelled(&cancel)?;
            if !read_storyboard_frame(&mut reader, &mut frame).await? {
                break;
            }
            low_level_extractor.push_rgb(&frame)?;
            let transnet_frame = downsample_for_transnet(&frame)?;
            if !saw_first_frame {
                saw_first_frame = true;
                for _ in 0..TRANSNET_CENTER_START {
                    window.push_back(transnet_frame.clone());
                }
            }
            decoded_frames += 1;
            last_transnet_frame = Some(transnet_frame.clone());
            window.push_back(transnet_frame);
            run_ready_storyboard_windows(
                &mut transnet_session,
                &mut window,
                &mut transnet_predictions,
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
        if decoded_frames != frame_pts.len() {
            return Err(app_error(
                ErrorCode::StoryboardFrameDecodeFailed,
                format!(
                    "Decoded frame/PTS alignment failed: FFmpeg decoded {decoded_frames} frames but ffprobe reported {} display frames",
                    frame_pts.len()
                ),
            ));
        }

        let end_frame = last_transnet_frame.expect("decoded frame count is non-zero");
        while transnet_predictions.len() < decoded_frames {
            ensure_not_cancelled(&cancel)?;
            while window.len() < TRANSNET_WINDOW_FRAMES {
                window.push_back(end_frame.clone());
            }
            run_ready_storyboard_windows(
                &mut transnet_session,
                &mut window,
                &mut transnet_predictions,
                &mut progress,
                decoded_frames,
                &cancel,
            )?;
        }
        transnet_predictions.truncate(decoded_frames);
        let low_level_features = low_level_extractor.into_features();
        if low_level_features.len() != decoded_frames {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                format!(
                    "Low-level feature alignment failed: features={}, frames={decoded_frames}",
                    low_level_features.len()
                ),
            ));
        }
        let raw_features = transnet_predictions
            .into_iter()
            .zip(low_level_features)
            .enumerate()
            .map(|(frame_index, (transnet, low_level))| {
                RawFrameFeatures::from_predictions(transnet, low_level).map_err(|error| {
                    app_error(
                        ErrorCode::StoryboardInferenceFailed,
                        format!("Invalid features at frame {frame_index}: {error}"),
                    )
                })
            })
            .collect::<AppResult<Vec<_>>>()?;
        let predictions = refine_full_video(
            &raw_features,
            &frame_pts,
            &mut refiner,
            RefinerConfig::default(),
        )?;
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

    let cuts = predictions
        .into_iter()
        .filter(|prediction| prediction.is_cut)
        .map(StoryboardCut::from)
        .collect::<Vec<_>>();
    let shots = storyboard_cuts_to_shots(&frame_pts, &cuts, project.asset.duration_us);
    Ok(StoryboardDetectionResult {
        asset_id: project.asset.id.clone(),
        duration_us: project.asset.duration_us,
        frame_count: decoded_frames,
        frame_rate,
        provider,
        cuts,
        shots,
    })
}

#[derive(Deserialize)]
struct FrameProbeOutput {
    #[serde(default)]
    frames: Vec<FrameProbeEntry>,
}

#[derive(Deserialize)]
struct FrameProbeEntry {
    best_effort_timestamp_time: Option<String>,
}

async fn probe_storyboard_frame_pts(
    project: &Project,
    stream_index: i32,
    preferences: &Preferences,
    state: &AppState,
    task_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<Vec<i64>> {
    let video_ordinal = project
        .streams
        .iter()
        .filter(|stream| stream.codec_type == "video")
        .position(|stream| stream.index == stream_index)
        .ok_or_else(|| {
            app_error(
                ErrorCode::VideoStreamMissing,
                format!("Video stream {stream_index} is absent from the project stream list"),
            )
        })?;
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-select_streams".to_string(),
        format!("v:{video_ordinal}"),
        "-show_frames".to_string(),
        "-show_entries".to_string(),
        "frame=best_effort_timestamp_time".to_string(),
        "-of".to_string(),
        "json".to_string(),
        project.asset.path.clone(),
    ];
    let body = run_output(&ffprobe_program(preferences), &args, state, task_id, cancel).await?;
    let output = serde_json::from_str::<FrameProbeOutput>(&body).map_err(|error| {
        app_error(
            ErrorCode::StoryboardFrameDecodeFailed,
            format!("Failed to parse storyboard frame timestamps: {error}"),
        )
    })?;
    if output.frames.is_empty() {
        return Err(app_error(
            ErrorCode::StoryboardFrameDecodeFailed,
            "ffprobe reported no display-frame timestamps for storyboard detection",
        ));
    }

    let mut pts = Vec::with_capacity(output.frames.len());
    for (frame_index, frame) in output.frames.into_iter().enumerate() {
        let raw = frame.best_effort_timestamp_time.ok_or_else(|| {
            app_error(
                ErrorCode::StoryboardFrameDecodeFailed,
                format!("Frame {frame_index} has no best-effort presentation timestamp"),
            )
        })?;
        let seconds = raw.parse::<f64>().map_err(|error| {
            app_error(
                ErrorCode::StoryboardFrameDecodeFailed,
                format!("Frame {frame_index} has invalid presentation timestamp {raw:?}: {error}"),
            )
        })?;
        if !seconds.is_finite() {
            return Err(app_error(
                ErrorCode::StoryboardFrameDecodeFailed,
                format!("Frame {frame_index} has non-finite presentation timestamp {raw:?}"),
            ));
        }
        pts.push((seconds * 1_000_000.0).round() as i64);
    }
    let first = pts[0];
    for value in &mut pts {
        *value -= first;
    }
    if let Some((index, pair)) = pts
        .windows(2)
        .enumerate()
        .find(|(_, pair)| pair[1] < pair[0])
    {
        return Err(app_error(
            ErrorCode::StoryboardFrameDecodeFailed,
            format!(
                "Presentation timestamps are not in display order at frames {} and {}: {} > {}",
                index,
                index + 1,
                pair[0],
                pair[1]
            ),
        ));
    }
    Ok(pts)
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
        format!("scale={FEATURE_FRAME_WIDTH}:{FEATURE_FRAME_HEIGHT}:flags=bilinear,format=rgb24"),
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
    session: &mut ort::session::Session,
    window: &mut VecDeque<Vec<u8>>,
    predictions: &mut Vec<TransNetPrediction>,
    progress: &mut StoryboardProgressReporter<'_>,
    known_frames: usize,
    cancel: &AtomicBool,
) -> AppResult<()> {
    while window.len() >= TRANSNET_WINDOW_FRAMES {
        ensure_not_cancelled(cancel)?;
        predictions.extend(run_transnet_window(session, window)?);
        for _ in 0..TRANSNET_STRIDE_FRAMES {
            window.pop_front();
        }
        progress.report_predicted(predictions.len(), known_frames);
    }
    Ok(())
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

fn storyboard_cuts_to_shots(
    frame_pts: &[i64],
    cuts: &[StoryboardCut],
    duration_us: i64,
) -> Vec<StoryboardShot> {
    if frame_pts.is_empty() {
        return Vec::new();
    }

    let mut boundaries = cuts
        .iter()
        .map(|cut| cut.cut_frame)
        .filter(|frame| *frame > 0 && *frame < frame_pts.len())
        .collect::<Vec<_>>();
    boundaries.sort_unstable();
    boundaries.dedup();

    let mut ranges = Vec::with_capacity(boundaries.len() + 1);
    let mut start = 0usize;
    for boundary in boundaries {
        ranges.push((start, boundary - 1));
        start = boundary;
    }
    ranges.push((start, frame_pts.len() - 1));

    ranges
        .into_iter()
        .enumerate()
        .map(|(index, (start_frame, end_frame))| {
            let start_us = frame_pts[start_frame].clamp(0, duration_us.max(0));
            let end_us = frame_pts
                .get(end_frame + 1)
                .copied()
                .unwrap_or(duration_us)
                .clamp(start_us, duration_us.max(start_us));
            StoryboardShot {
                id: format!("shot:{start_frame}:{end_frame}"),
                sequence: index + 1,
                start_frame,
                end_frame,
                start_us,
                end_us,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cut(frame: usize, pts: i64) -> StoryboardCut {
        StoryboardCut {
            cut_frame: frame,
            pts,
            base_logit: 1.0,
            delta_logit: 0.0,
            final_logit: 1.0,
            probability: 0.731,
        }
    }

    #[test]
    fn boundary_frame_is_first_frame_of_new_shot() {
        let pts = (0..100).map(|index| index * 40_000).collect::<Vec<_>>();
        let shots = storyboard_cuts_to_shots(&pts, &[cut(40, pts[40])], 4_000_000);

        assert_eq!(shots.len(), 2);
        assert_eq!((shots[0].start_frame, shots[0].end_frame), (0, 39));
        assert_eq!((shots[1].start_frame, shots[1].end_frame), (40, 99));
        assert_eq!(shots[0].end_us, pts[40]);
        assert_eq!(shots[1].start_us, pts[40]);
        assert_eq!(shots[1].end_us, 4_000_000);
    }

    #[test]
    fn variable_frame_rate_pts_drive_shot_times() {
        let pts = vec![0, 33_000, 75_000, 115_000];
        let shots = storyboard_cuts_to_shots(&pts, &[cut(2, pts[2])], 160_000);

        assert_eq!(shots[0].end_us, 75_000);
        assert_eq!(shots[1].start_us, 75_000);
        assert_eq!(shots[1].end_us, 160_000);
    }

    #[test]
    fn adjacent_boundaries_preserve_single_frame_shot() {
        let pts = vec![0, 40_000, 80_000, 120_000];
        let shots = storyboard_cuts_to_shots(&pts, &[cut(1, pts[1]), cut(2, pts[2])], 160_000);

        assert_eq!(shots.len(), 3);
        assert_eq!((shots[0].start_frame, shots[0].end_frame), (0, 0));
        assert_eq!((shots[1].start_frame, shots[1].end_frame), (1, 1));
        assert_eq!((shots[2].start_frame, shots[2].end_frame), (2, 3));
    }
}
