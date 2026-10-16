//! Query-independent storyboard frame selection and persistent CSES source data.
use super::onnx::OnnxModel;
use super::*;
use ort::{
    session::{
        run_options::{HasSelectedOutputs, OutputSelector, RunOptions},
        Session,
    },
    value::Tensor,
};
use std::sync::{OnceLock, TryLockError};
use tauri::{ipc::Channel, path::BaseDirectory};

mod batch;
mod cache;
mod cses;
mod decode;
const SIDE: usize = 224;
const DIMENSIONS: usize = 384;
#[cfg(test)]
const BATCH: usize = 8;
// Symbolic input dimensions of the pinned ONNX graph. Fixing these before graph
// optimization folds the RoPE Range/Reshape shape subgraph for DirectML.
// The asset preparation also fixes allowzero on attention output reshapes;
// fixing input dimensions alone does not work around DirectML's -1 shape bug.
#[cfg(test)]
const INPUT_DIMENSIONS: [(&str, i64); 3] = [
    ("s99", BATCH as i64),
    ("s100", SIDE as i64),
    ("s4", SIDE as i64),
];
struct EmbeddingModel {
    runtime: OnnxModel,
    input: Tensor<f32>,
    options: RunOptions<HasSelectedOutputs>,
    size: usize,
    warmed: bool,
}

#[derive(Default)]
struct BatchEngine {
    sessions: Vec<EmbeddingModel>,
    policy: batch::BatchPolicy,
    cpu: bool,
    last_size: usize,
}
static MODEL: OnceLock<Mutex<Option<BatchEngine>>> = OnceLock::new();
// Like subtitle indexing, overlapping windows serialize preparation and recheck
// completed items after acquiring the slot. Search only reads completed files.
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
    identity: cache::ShotIdentity,
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
) -> AppResult<std::sync::MutexGuard<'static, Option<BatchEngine>>> {
    loop {
        ensure_not_cancelled(cancel)?;
        match MODEL.get_or_init(|| Mutex::new(None)).try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => return Err(inference_error(error)),
        }
    }
}

fn preferred_batch(remaining: usize, cancel: &AtomicBool) -> AppResult<usize> {
    let mut guard = model_guard(cancel)?;
    Ok(guard
        .get_or_insert_with(BatchEngine::default)
        .policy
        .choose(remaining))
}

fn embed(app: &tauri::AppHandle, rgb: &[u8], cancel: &AtomicBool) -> AppResult<Vec<Vec<f32>>> {
    let mut guard = model_guard(cancel)?;
    let engine = guard.get_or_insert_with(BatchEngine::default);
    embed_resilient(app, engine, rgb, cancel)
}

fn embed_resilient(
    app: &tauri::AppHandle,
    engine: &mut BatchEngine,
    rgb: &[u8],
    cancel: &AtomicBool,
) -> AppResult<Vec<Vec<f32>>> {
    ensure_not_cancelled(cancel)?;
    let frames = rgb.len() / (SIDE * SIDE * 3);
    match embed_attempt(app, engine, rgb, cancel) {
        Ok(result) => Ok(result),
        Err(error) => {
            ensure_not_cancelled(cancel)?;
            if !engine.cpu
                && engine
                    .sessions
                    .iter()
                    .any(|s| s.runtime.provider().to_string() == "CPU")
            {
                engine.cpu = true;
                engine.policy = batch::BatchPolicy::default();
            }
            if frames == 0 || (frames == 1 && engine.last_size <= 1) {
                return Err(error);
            }
            let size = engine.last_size;
            engine.policy.failed(size);
            engine.sessions.retain(|session| session.size < size);
            tracing::warn!(size, %error, "Retrying DINOv3 with smaller real batches");
            if frames == 1 {
                return embed_resilient(app, engine, rgb, cancel);
            }
            let middle = frames / 2 * SIDE * SIDE * 3;
            let mut result = embed_resilient(app, engine, &rgb[..middle], cancel)?;
            result.extend(embed_resilient(app, engine, &rgb[middle..], cancel)?);
            Ok(result)
        }
    }
}

fn embed_attempt(
    app: &tauri::AppHandle,
    engine: &mut BatchEngine,
    rgb: &[u8],
    cancel: &AtomicBool,
) -> AppResult<Vec<Vec<f32>>> {
    let pixels = SIDE * SIDE;
    let batch = rgb.len() / (pixels * 3);
    if batch == 0 || batch > batch::MAX_BATCH || rgb.len() != batch * pixels * 3 {
        return Err(inference_error("Invalid DINOv3 RGB batch"));
    }
    // Tails use an already resident shape when possible. Never compile another
    // large graph just to eliminate a few padded rows.
    let size = if batch.is_power_of_two() && batch >= 2 {
        batch
    } else {
        engine
            .sessions
            .iter()
            .filter(|s| s.size >= batch)
            .map(|s| s.size)
            .min()
            .unwrap_or(batch.next_power_of_two())
    };
    engine.last_size = size;
    if !engine.sessions.iter().any(|s| s.size == size) {
        // Keep at most the current throughput winner and one challenger.
        // Evict BEFORE allocating a new session to bound peak model memory.
        if engine.sessions.len() >= 2 {
            let best = engine.policy.best();
            let victim = engine
                .sessions
                .iter()
                .position(|s| s.size != best)
                .unwrap_or(0);
            engine.sessions.remove(victim);
        }
        let directory = resource_directory(app).ok_or_else(|| {
            app_error(
                ErrorCode::SemanticModelMissing,
                "DINOv3 is missing; run npm run prepare:storyboard-semantic",
            )
        })?;
        storyboard::init_shared_ort(app)?;
        let dimensions = [
            ("s99", size as i64),
            ("s100", SIDE as i64),
            ("s4", SIDE as i64),
        ];
        let runtime = if engine.cpu {
            OnnxModel::load_cpu(&directory.join("model.onnx"), &dimensions, inference_error)?
        } else {
            OnnxModel::load(&directory.join("model.onnx"), &dimensions, inference_error)?
        };
        if runtime.provider().to_string() == "CPU"
            && !engine.cpu
            && engine
                .sessions
                .iter()
                .any(|s| s.runtime.provider().to_string() != "CPU")
        {
            return Err(inference_error(
                "Larger DINOv3 shape could not use the active GPU; retry a smaller batch",
            ));
        }
        if runtime.provider().to_string() == "CPU" && !engine.cpu {
            engine.cpu = true;
            engine.sessions.clear();
            engine.policy = batch::BatchPolicy::default();
        }
        tracing::info!(size, provider = %runtime.provider(), "Prepared DINOv3 batch shape");
        engine.sessions.push(EmbeddingModel {
            runtime,
            input: Tensor::from_array(([size, 3, SIDE, SIDE], vec![0.0_f32; size * pixels * 3]))
                .map_err(inference_error)?,
            options: RunOptions::new()
                .map_err(inference_error)?
                .with_outputs(OutputSelector::no_default().with("pooler_output")),
            size,
            warmed: false,
        });
    }
    let model = engine
        .sessions
        .iter_mut()
        .find(|s| s.size == size)
        .ok_or_else(|| inference_error("Missing DINOv3 batch session"))?;
    let started = std::time::Instant::now();
    let (_, input) = model
        .input
        .try_extract_raw_tensor_mut::<f32>()
        .map_err(inference_error)?;
    // Lookup preserves the original f32 operations exactly, but performs only
    // 3*256 normalizations once rather than two divisions per channel/pixel.
    static NORMALIZED_RGB: OnceLock<[[f32; 256]; 3]> = OnceLock::new();
    let table = NORMALIZED_RGB.get_or_init(|| {
        std::array::from_fn(|c| {
            std::array::from_fn(|v| {
                (v as f32 / 255.0 - [0.485, 0.456, 0.406][c]) / [0.229, 0.224, 0.225][c]
            })
        })
    });
    for (b, frame) in rgb.chunks_exact(pixels * 3).enumerate() {
        for c in 0..3 {
            let plane = &mut input[(b * 3 + c) * pixels..(b * 3 + c + 1) * pixels];
            for (target, pixel) in plane.iter_mut().zip(frame.chunks_exact(3)) {
                *target = table[c][pixel[c] as usize];
            }
        }
    }
    // Preserve fixed-shape DirectML specialization and deterministic tail rows.
    input[batch * pixels * 3..].fill(0.0);
    let infer =
        |session: &Session| run_embedding_batch(session, &model.input, &model.options, size);
    let values = if !engine.cpu && size > 2 {
        model.runtime.run_without_recovery(cancel, infer)?
    } else {
        model.runtime.run(Some(cancel), infer)?
    };
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
    let elapsed = started.elapsed().as_secs_f64();
    let became_cpu = model.runtime.provider().to_string() == "CPU" && !engine.cpu;
    if model.warmed && batch == size && !became_cpu {
        engine.policy.observe(size, elapsed);
    }
    model.warmed = true;
    if became_cpu {
        engine.cpu = true;
        engine.policy = batch::BatchPolicy::default();
        engine.sessions.retain(|session| session.size == size);
        // The recovery run includes initialization; never use it as a sample.
    }
    ensure_not_cancelled(cancel)?;
    Ok(result)
}

fn run_embedding_batch(
    session: &Session,
    input: &Tensor<f32>,
    options: &RunOptions<HasSelectedOutputs>,
    size: usize,
) -> ort::Result<Vec<f32>> {
    // Do not materialize/copy the unused 201-token last_hidden_state output.
    // Borrow the reusable input; a CPU recovery retries this identical tensor.
    let output = session.run_with_options([input.view().into()], options)?;
    // pooler_output is the normalized backbone CLS token, not patch averaging.
    let pooled = output
        .get("pooler_output")
        .ok_or_else(|| ort::Error::new("DINOv3 pooler_output is missing"))?;
    let values = pooled.try_extract_tensor::<f32>()?;
    if values.shape() != [size, DIMENSIONS] {
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
    // Resolve project metadata once per asset, not once per storyboard.
    let mut assets = HashMap::new();
    shots
        .into_iter()
        .map(|shot| {
            let frames = shot
                .end_frame
                .checked_sub(shot.start_frame)
                .and_then(|n| n.checked_add(1))
                .filter(|_| shot.end_frame <= i64::MAX as usize)
                .ok_or_else(|| inference_error("Invalid storyboard frame range"))?;
            let asset = match assets.entry(shot.asset_id.clone()) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    let project = project_clone(&shot.asset_id, state)?;
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
                    let fingerprint = project.asset.fingerprint;
                    let metadata = fs::metadata(&path).map_err(inference_error)?;
                    let modified = metadata
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_nanos());
                    entry.insert((path, fingerprint, stream, rate, metadata.len(), modified))
                }
            };
            let (path, fingerprint, stream, rate, length, modified) = asset;
            if *fingerprint != shot.fingerprint {
                return Err(inference_error("Storyboard source changed"));
            }
            // Reuse the imported media hash without reading media bytes again.
            // Asset IDs and paths are deliberately absent from persisted identity.
            let identity = cache::ShotIdentity {
                fingerprint: shot.fingerprint.clone(),
                media_length: *length,
                media_modified_ns: *modified,
                stream: *stream,
                rate: *rate,
                start_frame: shot.start_frame,
                end_frame: shot.end_frame,
            };
            Ok(ShotSource {
                shot,
                identity,
                path: path.clone(),
                stream: *stream,
                rate: *rate,
                frames,
            })
        })
        .collect()
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
    decode::embed_stream(app, program, args, task_id, cancel, positions.len())
}

fn encode_missing(
    positions: &[usize],
    start_frame: usize,
    available: &HashMap<usize, Vec<f32>>,
    mut encode: impl FnMut(&[usize]) -> AppResult<Vec<Vec<f32>>>,
) -> AppResult<Vec<Vec<f32>>> {
    let missing: Vec<usize> = positions
        .iter()
        .copied()
        .filter(|frame| !available.contains_key(&(start_frame + frame)))
        .collect();
    let encoded = if missing.is_empty() {
        Vec::new()
    } else {
        encode(&missing)?
    };
    if encoded.len() != missing.len() {
        return Err(inference_error(
            "Incomplete replacement storyboard embeddings",
        ));
    }
    let mut encoded = encoded.into_iter();
    positions
        .iter()
        .map(|frame| {
            available
                .get(&(start_frame + frame))
                .cloned()
                .or_else(|| encoded.next())
                .ok_or_else(|| inference_error("Missing replacement storyboard embedding"))
        })
        .collect()
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
    let preferences = preferences_clone(&state)?;
    let program = ffmpeg_program(&preferences);
    let root = cache::root(&preferences);
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
                let data = cache::get_or_build(&root, &source, cancel, |available| {
                    cses::select(source.frames, source.rate, cancel, |positions| {
                        encode_missing(positions, source.shot.start_frame, available, |missing| {
                            decode_and_embed(&app, &source, missing, &program, &task_id, &token)
                        })
                    })
                })?;
                output.push(SelectedShotFrames {
                    id: source.shot.id,
                    frames: data.selection.selected_frames(),
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
    root: &Path,
) -> AppResult<Vec<StoryboardSemanticMatch>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    for source in sources {
        if cache::read(root, &source.identity).is_none() {
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
    let root = cache::root(&preferences_clone(&state)?);
    tokio::task::spawn_blocking(move || search_completed_shots(&query, &sources, &root))
        .await
        .map_err(|error| {
            app_error(
                ErrorCode::BlockingTaskFailed,
                format!("Storyboard retrieval task failed: {error}"),
            )
        })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires packaged DINOv3, ONNX Runtime and a DirectML GPU"]
    fn dinov3_directml_matches_cpu() {
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let runtime = resources.join("transnetv2");
        let current = env::var_os("PATH").unwrap_or_default();
        let paths = std::iter::once(runtime.clone()).chain(env::split_paths(&current));
        env::set_var("PATH", env::join_paths(paths).unwrap());
        ort::init_from(
            runtime
                .join("onnxruntime.dll")
                .to_string_lossy()
                .into_owned(),
        )
        .with_telemetry(false)
        .commit()
        .unwrap();
        let path = resources.join("storyboard-semantic/model.onnx");
        let input = Tensor::from_array((
            [BATCH, 3, SIDE, SIDE],
            (0..BATCH * 3 * SIDE * SIDE)
                .map(|i| ((i * 17 % 509) as f32 - 254.0) / 128.0)
                .collect::<Vec<_>>(),
        ))
        .unwrap();
        let options = RunOptions::new()
            .unwrap()
            .with_outputs(OutputSelector::no_default().with("pooler_output"));
        // Explicit provider: failures cannot be hidden by automatic CPU recovery.
        let gpu = super::super::onnx::create_directml_model_session_with_dimensions(
            &path,
            0,
            &INPUT_DIMENSIONS,
        )
        .unwrap();
        let actual = run_embedding_batch(&gpu, &input, &options, BATCH).unwrap();
        let cpu =
            super::super::onnx::create_cpu_model_session_with_dimensions(&path, &INPUT_DIMENSIONS)
                .unwrap();
        let expected = run_embedding_batch(&cpu, &input, &options, BATCH).unwrap();
        for (a, b) in actual
            .chunks_exact(DIMENSIONS)
            .zip(expected.chunks_exact(DIMENSIONS))
        {
            let dot: f64 = a
                .iter()
                .zip(b)
                .map(|(&x, &y)| f64::from(x) * f64::from(y))
                .sum();
            let norm = |row: &[f32]| {
                row.iter()
                    .map(|&x| f64::from(x).powi(2))
                    .sum::<f64>()
                    .sqrt()
            };
            let cosine = dot / (norm(a) * norm(b));
            assert!(cosine > 0.9999, "DirectML/CPU embedding cosine: {cosine}");
        }
        eprintln!(
            "DINOv3 DirectML batch completed; all eight embeddings match CPU (cosine > 0.9999)"
        );
    }
}
