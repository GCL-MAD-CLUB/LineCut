//! Query-independent storyboard frame selection. Results live only in memory.
use super::onnx::OnnxModel;
use super::*;
use ort::{session::Session, value::Tensor};
use std::sync::{OnceLock, TryLockError};
use tauri::{ipc::Channel, path::BaseDirectory};

mod cses;
const SIDE: usize = 224;
const DIMENSIONS: usize = 384;
const BATCH: usize = 8;
// Symbolic input dimensions of the pinned ONNX graph. Fixing these before graph
// optimization folds the RoPE Range/Reshape shape subgraph for DirectML.
const INPUT_DIMENSIONS: [(&str, i64); 3] = [
    ("s99", BATCH as i64),
    ("s100", SIDE as i64),
    ("s4", SIDE as i64),
];
static MODEL: OnceLock<Mutex<Option<OnnxModel>>> = OnceLock::new();
static RESULTS: OnceLock<Mutex<HashMap<String, Vec<usize>>>> = OnceLock::new();
// Like subtitle indexing, overlapping windows serialize preparation and recheck
// completed items after acquiring the slot. Search only needs the result lock.
static BUILD: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticShot {
    id: String,
    source: String,
    asset_id: String,
    fingerprint: String,
    start_frame: usize,
    end_frame: usize,
}

#[derive(Serialize)]
pub(crate) struct SelectedShotFrames {
    id: String,
    frames: Vec<usize>,
}

#[derive(Serialize)]
pub(crate) struct StoryboardSemanticMatch {
    id: String,
    similarity: f32,
}

#[derive(Clone, Serialize)]
pub(crate) struct SelectionProgress {
    phase: &'static str,
    completed: usize,
    total: usize,
}

struct ShotSource {
    shot: SemanticShot,
    key: String,
    path: String,
    stream: i32,
    rate: f64,
    frames: usize,
}

fn inference_error(error: impl std::fmt::Display) -> AppError {
    app_error(ErrorCode::SemanticInferenceFailed, error.to_string())
}

fn resource_directory(app: &tauri::AppHandle) -> Option<PathBuf> {
    let name = "storyboard-semantic";
    let mut candidates = Vec::new();
    if let Ok(path) = app.path().resolve(name, BaseDirectory::Resource) {
        candidates.push(path);
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(name));
            candidates.push(parent.join("resources").join(name));
        }
    }
    #[cfg(debug_assertions)]
    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("src-tauri/resources").join(name));
        candidates.push(cwd.join("resources").join(name));
    }
    candidates.into_iter().find(|path| {
        ["model.onnx", "model.onnx_data"]
            .iter()
            .all(|name| path.join(name).is_file())
    })
}

#[tauri::command]
pub(crate) fn storyboard_semantic_search_available(app: tauri::AppHandle) -> CommandResult<bool> {
    Ok(resource_directory(&app).is_some())
}

fn model_guard(
    cancel: &AtomicBool,
) -> AppResult<std::sync::MutexGuard<'static, Option<OnnxModel>>> {
    loop {
        ensure_not_cancelled(cancel)?;
        match MODEL.get_or_init(|| Mutex::new(None)).try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => return Err(inference_error(error)),
        }
    }
}

fn embed(app: &tauri::AppHandle, rgb: &[u8], cancel: &AtomicBool) -> AppResult<Vec<Vec<f32>>> {
    let pixels = SIDE * SIDE;
    let batch = rgb.len() / (pixels * 3);
    // Short tail batches use padding to keep one fixed-shape GPU session.
    // DINOv3 processes rows independently; padding rows are never published.
    let mut input = vec![0.0_f32; BATCH * pixels * 3];
    // Pinned model's preprocessor_config.json: RGB, bilinear 224x224,
    // channels_first, rescale 1/255 and ImageNet mean/std, no center crop.
    for b in 0..batch {
        for p in 0..pixels {
            for c in 0..3 {
                input[(b * 3 + c) * pixels + p] =
                    (f32::from(rgb[(b * pixels + p) * 3 + c]) / 255.0 - [0.485, 0.456, 0.406][c])
                        / [0.229, 0.224, 0.225][c];
            }
        }
    }
    let mut guard = model_guard(cancel)?;
    if guard.is_none() {
        let directory = resource_directory(app).ok_or_else(|| {
            app_error(
                ErrorCode::SemanticModelMissing,
                "DINOv3 is missing; run npm run prepare:storyboard-semantic",
            )
        })?;
        storyboard::init_shared_ort(app)?;
        let model = OnnxModel::load(
            &directory.join("model.onnx"),
            &INPUT_DIMENSIONS,
            ErrorCode::SemanticInferenceFailed,
        )?;
        tracing::info!(provider = %model.provider(), "Selected storyboard DINOv3 provider");
        *guard = Some(model);
    }
    let model = guard
        .as_ref()
        .ok_or_else(|| inference_error("DINOv3 was not initialized"))?;
    let values = model.run(Some(cancel), |session| run_embedding_batch(session, &input))?;
    let result = values
        .chunks_exact(DIMENSIONS)
        .take(batch)
        .map(|row| {
            let norm = row
                .iter()
                .map(|v| f64::from(*v).powi(2))
                .sum::<f64>()
                .sqrt();
            if !norm.is_finite() || norm <= f64::EPSILON {
                return Err(inference_error("Invalid DINOv3 embedding"));
            }
            Ok(row.iter().map(|v| (f64::from(*v) / norm) as f32).collect())
        })
        .collect::<AppResult<Vec<_>>>()?;
    ensure_not_cancelled(cancel)?;
    Ok(result)
}

fn run_embedding_batch(session: &Session, input: &[f32]) -> ort::Result<Vec<f32>> {
    let tensor = Tensor::from_array(([BATCH, 3, SIDE, SIDE], input.to_vec().into_boxed_slice()))?;
    let output = session.run(ort::inputs!["pixel_values" => tensor]?)?;
    // pooler_output is the normalized backbone CLS token, not patch averaging.
    let pooled = output
        .get("pooler_output")
        .ok_or_else(|| ort::Error::new("DINOv3 pooler_output is missing"))?;
    let values = pooled.try_extract_tensor::<f32>()?;
    if values.shape() != [BATCH, DIMENSIONS] {
        return Err(ort::Error::new("Unexpected DINOv3 output shape"));
    }
    let values = values
        .as_slice()
        .ok_or_else(|| ort::Error::new("Non-contiguous DINOv3 output"))?;
    Ok(values.to_vec())
}

fn resolve_shots(
    shots: Vec<SemanticShot>,
    state: &tauri::State<'_, AppState>,
) -> AppResult<Vec<ShotSource>> {
    shots
        .into_iter()
        .map(|shot| {
            let frames = shot
                .end_frame
                .checked_sub(shot.start_frame)
                .and_then(|n| n.checked_add(1))
                .filter(|_| shot.end_frame <= i64::MAX as usize)
                .ok_or_else(|| inference_error("Invalid storyboard frame range"))?;
            let project = project_clone(&shot.asset_id, state)?;
            if project.asset.fingerprint != shot.fingerprint {
                return Err(inference_error("Storyboard source changed"));
            }
            let stream = project.asset.video_stream_index.ok_or_else(|| {
                app_error(
                    ErrorCode::VideoStreamMissing,
                    "Storyboard source has no video stream",
                )
            })?;
            let rate = project
                .streams
                .iter()
                .find(|s| s.index == stream)
                .and_then(|s| {
                    parse_frame_rate(s.avg_frame_rate.as_deref())
                        .or_else(|| parse_frame_rate(s.r_frame_rate.as_deref()))
                })
                .unwrap_or(25.0);
            let path = project.asset.path;
            let metadata = fs::metadata(&path).map_err(inference_error)?;
            let modified = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_nanos());
            // No media hashing, embeddings, or selection data are written to disk.
            let key = serde_json::to_string(&(
                &shot.asset_id,
                &shot.fingerprint,
                &path,
                stream,
                rate,
                shot.start_frame,
                shot.end_frame,
                metadata.len(),
                modified,
            ))
            .map_err(inference_error)?;
            Ok(ShotSource {
                shot,
                key,
                path,
                stream,
                rate,
                frames,
            })
        })
        .collect()
}

fn results() -> AppResult<std::sync::MutexGuard<'static, HashMap<String, Vec<usize>>>> {
    RESULTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(inference_error)
}

fn decode_and_embed(
    app: &tauri::AppHandle,
    source: &ShotSource,
    positions: &[usize],
    program: &str,
    task_id: &str,
    cancel: &Arc<AtomicBool>,
) -> AppResult<Vec<Vec<f32>>> {
    if positions.is_empty() {
        return Ok(Vec::new());
    }
    let first = positions[0];
    let select = positions
        .iter()
        .map(|p| format!("eq(n\\,{})", p - first))
        .collect::<Vec<_>>()
        .join("+");
    let mut args = vec!["-v".into(), "error".into(), "-nostdin".into()];
    append_ffmpeg_processing_thread_args(
        &mut args,
        available_cpu_threads().saturating_sub(2).clamp(2, 4),
    );
    args.extend([
        "-ss".into(),
        format!(
            "{:.9}",
            (source.shot.start_frame + first) as f64 / source.rate
        ),
        "-i".into(),
        source.path.clone(),
        "-map".into(),
        format!("0:{}", source.stream),
        "-an".into(),
        "-sn".into(),
        "-dn".into(),
        "-vf".into(),
        format!("select='{select}',scale={SIDE}:{SIDE}:flags=bilinear,format=rgb24"),
        "-frames:v".into(),
        positions.len().to_string(),
        "-fps_mode".into(),
        "passthrough".into(),
        "-c:v".into(),
        "rawvideo".into(),
        "-threads:v".into(),
        "1".into(),
        "-f".into(),
        "rawvideo".into(),
        "pipe:1".into(),
    ]);
    let state = app.state::<AppState>();
    let rgb = tauri::async_runtime::block_on(run_output_bytes(
        program,
        &args,
        state.inner(),
        task_id,
        Arc::clone(cancel),
    ))?;
    let bytes = SIDE * SIDE * 3;
    if rgb.len() != positions.len() * bytes {
        return Err(inference_error("Incomplete storyboard frame decode"));
    }
    let mut embeddings = Vec::with_capacity(positions.len());
    for batch in rgb.chunks(bytes * BATCH) {
        ensure_not_cancelled(cancel)?;
        embeddings.extend(embed(app, batch, cancel)?);
    }
    Ok(embeddings)
}

#[tauri::command]
pub(crate) async fn select_storyboard_frames(
    shots: Vec<SemanticShot>,
    task_id: String,
    on_progress: Channel<SelectionProgress>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<Vec<SelectedShotFrames>> {
    let task = register_task(&task_id, state.inner())?;
    let mut last_progress = None;
    let mut last_sent = std::time::Instant::now();
    let mut report = move |completed, total| {
        if last_progress == Some((completed, total)) {
            return;
        }
        if completed != total
            && last_progress.is_some_and(|(_, previous)| previous == total)
            && last_sent.elapsed() < Duration::from_millis(100)
        {
            return;
        }
        last_progress = Some((completed, total));
        last_sent = std::time::Instant::now();
        if let Err(error) = on_progress.send(SelectionProgress {
            phase: "indexing",
            completed,
            total,
        }) {
            tracing::debug!(%error, "Storyboard selection progress receiver closed");
        }
    };
    report(0, 0);
    let sources = resolve_shots(shots, &state)?;
    let program = ffmpeg_program(&preferences_clone(&state)?);
    let token = task.cancel_token();
    spawn_blocking_cancellable(
        task.cancel_token(),
        "storyboard frame selection",
        move |cancel| {
            let _build = loop {
                ensure_not_cancelled(cancel)?;
                match BUILD.try_lock() {
                    Ok(guard) => break guard,
                    Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(25)),
                    Err(error) => return Err(inference_error(error)),
                }
            };
            let mut output = Vec::with_capacity(sources.len());
            let total = sources.len();
            report(0, total);
            for source in sources {
                ensure_not_cancelled(cancel)?;
                let existing = results()?.get(&source.key).cloned();
                let frames = if let Some(frames) = existing {
                    frames
                } else {
                    let selected = cses::select(source.frames, source.rate, cancel, |positions| {
                        decode_and_embed(&app, &source, positions, &program, &task_id, &token)
                    })?;
                    let frames: Vec<usize> = selected
                        .into_iter()
                        .map(|frame| frame + source.shot.start_frame)
                        .collect();
                    ensure_not_cancelled(cancel)?;
                    results()?.insert(source.key.clone(), frames.clone());
                    frames
                };
                output.push(SelectedShotFrames {
                    id: source.shot.id,
                    frames,
                });
                report(output.len(), total);
            }
            Ok(output)
        },
    )
    .await
}

// The only placeholder: replace this function with actual retrieval later.
fn search_completed_shots(
    query: &str,
    sources: &[ShotSource],
) -> AppResult<Vec<StoryboardSemanticMatch>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let ready = results()?;
    for source in sources {
        if !ready.contains_key(&source.key) {
            return Err(inference_error(
                "Storyboard frame selection must complete before retrieval",
            ));
        }
    }
    Ok(sources
        .iter()
        .map(|source| StoryboardSemanticMatch {
            id: source.shot.id.clone(),
            similarity: 1.0,
        })
        .collect())
}

#[tauri::command]
pub(crate) async fn search_storyboards_semantic(
    query: String,
    shots: Vec<SemanticShot>,
    state: tauri::State<'_, AppState>,
) -> CommandResult<Vec<StoryboardSemanticMatch>> {
    let sources = resolve_shots(shots, &state)?;
    tokio::task::spawn_blocking(move || search_completed_shots(&query, &sources))
        .await
        .map_err(|error| {
            app_error(
                ErrorCode::BlockingTaskFailed,
                format!("Storyboard retrieval task failed: {error}"),
            )
        })?
}
