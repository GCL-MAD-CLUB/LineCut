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
mod index;
mod siglip;
mod storage;
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
    next_size: usize,
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
    completed: f64,
    total: usize,
}

// Both stages advance the same task. Fractional shots let inference batches
// report progress even when a source contains only one long storyboard.
const SELECTION_PROGRESS_WEIGHT: f64 = 0.75;

struct BuildProgress<F> {
    total: usize,
    report: F,
    selected: f64,
    indexed: f64,
}

impl<F: FnMut(f64, usize)> BuildProgress<F> {
    fn selection(&mut self, completed: f64) {
        self.selected = completed;
        self.publish();
    }

    fn indexing(&mut self, completed: f64) {
        self.indexed = completed;
        self.publish();
    }

    fn publish(&mut self) {
        (self.report)(
            self.selected * SELECTION_PROGRESS_WEIGHT
                + self.indexed * (1.0 - SELECTION_PROGRESS_WEIGHT),
            self.total,
        );
    }
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
    Ok(resource_directory(&app).is_some() && siglip::directory(&app).is_some())
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
    let engine = guard.get_or_insert_with(BatchEngine::default);
    let size = engine
        .policy
        .choose_resident(remaining, engine.sessions.iter().map(|s| s.size));
    engine.next_size = size;
    Ok(size)
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
            engine.next_size = 0;
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
    let size = if engine.next_size >= batch {
        engine.next_size
    } else if batch.is_power_of_two() && batch >= 2 {
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
        // The shape set is bounded. Retain challengers, the winner and tails
        // across batches, stages and builds; provider recovery alone resets it.
        debug_assert!(engine.sessions.len() < batch::RESIDENT_SHAPES);
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
    if !became_cpu {
        engine
            .policy
            .observe(size, batch, model.warmed.then_some(elapsed));
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
                    let metadata = fs::metadata(&project.asset.path).map_err(inference_error)?;
                    let modified = canonical_media_version(&project.asset, &metadata)?;
                    let path = project.asset.path;
                    let fingerprint = project.asset.fingerprint;
                    tracing::debug!(%fingerprint, media_length = metadata.len(),
                        media_modified_ns = ?modified, stream, rate,
                        "Resolved storyboard media cache identity");
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

fn canonical_media_version(asset: &MediaAsset, metadata: &fs::Metadata) -> AppResult<Option<u128>> {
    let modified = metadata.modified().map_err(inference_error)?;
    let elapsed = modified
        .duration_since(UNIX_EPOCH)
        .map_err(inference_error)?;
    canonical_media_timestamp(asset.file_size, asset.modified_at, metadata.len(), elapsed)
}

fn canonical_media_timestamp(
    imported_length: i64,
    imported_seconds: i64,
    length: u64,
    modified: Duration,
) -> AppResult<Option<u128>> {
    // fingerprint_file incorporates length and whole seconds. Validate those
    // before trusting the imported fingerprint, but preserve the nanosecond
    // identity used by existing cache directories, keys and stored records.
    if u64::try_from(imported_length).ok() != Some(length)
        || u64::try_from(imported_seconds).ok() != Some(modified.as_secs())
    {
        tracing::warn!(
            imported_length,
            imported_seconds,
            length,
            modified_seconds = modified.as_secs(),
            "Storyboard media metadata changed since import"
        );
        return Err(inference_error(
            "Storyboard source changed; reimport the media",
        ));
    }
    Ok(Some(modified.as_nanos()))
}

fn frame_decode_args(source: &ShotSource, positions: &[usize], side: usize) -> Vec<String> {
    let first = positions[0];
    let select = positions
        .iter()
        .map(|p| format!("eq(n\\,{})", p - first))
        .collect::<Vec<_>>()
        .join("+");
    decode_args(source, first, positions.len(), side, Some(select))
}

fn decode_args(
    source: &ShotSource,
    first: usize,
    count: usize,
    side: usize,
    select: Option<String>,
) -> Vec<String> {
    let mut args = vec!["-v".into(), "error".into(), "-nostdin".into()];
    append_ffmpeg_processing_thread_args(
        &mut args,
        available_cpu_threads().saturating_sub(2).clamp(2, 16),
    );
    #[cfg(windows)]
    args.extend(["-hwaccel".into(), "d3d11va".into()]);
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
        format!(
            "{}scale={side}:{side}:flags=bilinear,format=rgb24",
            select.map(|s| format!("select='{s}',")).unwrap_or_default()
        ),
        "-frames:v".into(),
        count.to_string(),
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
    args
}

// Integer-coordinate, center-aligned bilinear resampling. CSES calculation and
// selection order remain unchanged.
fn downsample_rgb(rgb: &[u8]) -> AppResult<Vec<u8>> {
    const INPUT: usize = 256;
    if rgb.is_empty() || rgb.len() % (INPUT * INPUT * 3) != 0 {
        return Err(inference_error("Invalid shared storyboard RGB"));
    }
    static AXIS: OnceLock<[(usize, usize, u32); SIDE]> = OnceLock::new();
    let axis = AXIS.get_or_init(|| {
        std::array::from_fn(|x| {
            let numerator = (2 * x + 1) * INPUT - SIDE;
            let left = numerator / (2 * SIDE);
            (
                left,
                (left + 1).min(INPUT - 1),
                (numerator % (2 * SIDE)) as u32,
            )
        })
    });
    let frames = rgb.len() / (INPUT * INPUT * 3);
    let mut output = vec![0; frames * SIDE * SIDE * 3];
    let denominator = (2 * SIDE) as u32;
    let area = denominator * denominator;
    for (source, target) in rgb
        .chunks_exact(INPUT * INPUT * 3)
        .zip(output.chunks_exact_mut(SIDE * SIDE * 3))
    {
        for (y, &(top, bottom, wy)) in axis.iter().enumerate() {
            for (x, &(left, right, wx)) in axis.iter().enumerate() {
                for c in 0..3 {
                    let a = u32::from(source[(top * INPUT + left) * 3 + c]);
                    let b = u32::from(source[(top * INPUT + right) * 3 + c]);
                    let d = u32::from(source[(bottom * INPUT + left) * 3 + c]);
                    let e = u32::from(source[(bottom * INPUT + right) * 3 + c]);
                    let value = (a * (denominator - wx) + b * wx) * (denominator - wy)
                        + (d * (denominator - wx) + e * wx) * wy;
                    target[(y * SIDE + x) * 3 + c] = ((value + area / 2) / area) as u8;
                }
            }
        }
    }
    Ok(output)
}

fn encode_shot_pixels(
    app: &tauri::AppHandle,
    stream: &mut decode::FrameStream,
    pixels: &mut Vec<u8>,
    positions: &[usize],
    cancel: &AtomicBool,
    mut report: impl FnMut(usize),
) -> AppResult<Vec<Vec<f32>>> {
    const FRAME: usize = 256 * 256 * 3;
    let mut output = Vec::with_capacity(positions.len());
    while output.len() < positions.len() {
        let end = (output.len() + preferred_batch(positions.len() - output.len(), cancel)?)
            .min(positions.len());
        let batch = &positions[output.len()..end];
        let needed = batch.iter().max().copied().unwrap() + 1;
        if needed > pixels.len() / FRAME {
            stream.append_frames(pixels, needed - pixels.len() / FRAME, cancel)?;
        }
        let mut rgb = Vec::with_capacity(batch.len() * FRAME);
        for &position in batch {
            rgb.extend_from_slice(&pixels[position * FRAME..(position + 1) * FRAME]);
        }
        output.extend(embed(app, &downsample_rgb(&rgb)?, cancel)?);
        report(output.len());
    }
    Ok(output)
}

// One continuous decoder per run of adjacent uncached shots. Group boundaries
// are also validation boundaries, allowing the next media to prefetch while the
// preceding media is indexed. Full-shot RGB is retained only by the consumer.
fn selection_decode_jobs(
    sources: &[ShotSource],
    groups: &[Vec<usize>],
    cached: &[Option<Arc<cache::ShotData>>],
) -> Vec<decode::DecodeJob> {
    let mut jobs: Vec<decode::DecodeJob> = Vec::new();
    for group in groups {
        let mut previous = None;
        let mut seen = HashSet::new();
        for &i in group {
            let source = &sources[i];
            if !seen.insert((source.shot.start_frame, source.shot.end_frame)) {
                continue;
            }
            if cached[i].is_some() {
                previous = None;
                continue;
            }
            if previous.is_some_and(|last: usize| {
                sources[last].shot.end_frame.checked_add(1) == Some(source.shot.start_frame)
            }) {
                let job = jobs.last_mut().unwrap();
                job.count += source.frames;
                let frames_arg = job.args.iter().position(|a| a == "-frames:v").unwrap() + 1;
                job.args[frames_arg] = job.count.to_string();
            } else {
                jobs.push(decode::DecodeJob {
                    args: decode_args(source, 0, source.frames, 256, None),
                    count: source.frames,
                    completed_shots: 0,
                    rgb: None,
                });
            }
            previous = Some(i);
        }
    }
    jobs
}

#[derive(Clone)]
struct SelectedPixels {
    frames: Vec<usize>,
    rgb: Vec<u8>,
}

struct IndexWork {
    group: Vec<usize>,
    selections: Vec<Vec<usize>>,
    pixels: HashMap<usize, SelectedPixels>,
}

fn selected_pixel_jobs(
    sources: &[ShotSource],
    work: &IndexWork,
    pending: &[index::PendingShot],
) -> AppResult<Vec<decode::DecodeJob>> {
    let mut jobs = Vec::new();
    let mut position = 0;
    while position < pending.len() {
        let shot = &pending[position];
        let source_index = work.group[shot.position];
        if let Some(pixels) = work.pixels.get(&source_index) {
            let source = &sources[source_index];
            let mut rgb = Vec::with_capacity(shot.frames.len() * 256 * 256 * 3);
            for &frame in &shot.frames {
                let slot = pixels
                    .frames
                    .binary_search(&(source.shot.start_frame + frame))
                    .map_err(|_| inference_error("Missing selected storyboard pixels"))?;
                rgb.extend_from_slice(
                    &pixels.rgb[slot * 256 * 256 * 3..(slot + 1) * 256 * 256 * 3],
                );
            }
            jobs.push(decode::DecodeJob {
                args: Vec::new(),
                count: shot.frames.len(),
                completed_shots: position + 1,
                rgb: Some(rgb),
            });
            position += 1;
        } else {
            let start = position;
            while position < pending.len()
                && !work
                    .pixels
                    .contains_key(&work.group[pending[position].position])
            {
                position += 1;
            }
            let mut missing = selected_decode_jobs(sources, &work.group, &pending[start..position]);
            for job in &mut missing {
                job.completed_shots += start;
            }
            jobs.extend(missing);
        }
    }
    Ok(jobs)
}

// Coalesce nearby selected frames across shots, but seek over long sparse gaps.
// Every process emits frames in pending-job order so the index can publish batches
// without retaining a source-wide RGB buffer or reordering embeddings.
fn selected_decode_jobs(
    sources: &[ShotSource],
    group: &[usize],
    pending: &[index::PendingShot],
) -> Vec<decode::DecodeJob> {
    let mut jobs = Vec::new();
    let mut source_index = 0;
    let mut absolute = Vec::<usize>::new();
    let mut completed_shots = 0;
    let flush = |jobs: &mut Vec<decode::DecodeJob>,
                 source_index: usize,
                 absolute: &mut Vec<usize>,
                 completed_shots| {
        if absolute.is_empty() {
            return;
        }
        let source = &sources[source_index];
        let positions: Vec<_> = absolute
            .iter()
            .map(|frame| frame - source.shot.start_frame)
            .collect();
        jobs.push(decode::DecodeJob {
            args: frame_decode_args(source, &positions, 256),
            count: positions.len(),
            completed_shots,
            rgb: None,
        });
        absolute.clear();
    };
    for (position, shot) in pending.iter().enumerate() {
        let current = group[shot.position];
        let source = &sources[current];
        for (frame_position, &relative) in shot.frames.iter().enumerate() {
            let frame = source.shot.start_frame + relative;
            let adjacent = absolute.last().is_none_or(|&last| {
                frame > last
                    && (frame - last) as f64 <= source.rate * 2.0
                    && (frame - absolute[0]) as f64 <= source.rate * 30.0
                    && absolute.len() < 256
            });
            if !adjacent {
                flush(&mut jobs, source_index, &mut absolute, completed_shots);
            }
            if absolute.is_empty() {
                source_index = current;
            }
            absolute.push(frame);
            completed_shots = position + usize::from(frame_position + 1 == shot.frames.len());
        }
    }
    flush(&mut jobs, source_index, &mut absolute, completed_shots);
    jobs
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
    let mut report = move |completed: f64, total: usize| {
        if last_progress == Some((completed, total)) {
            return;
        }
        if completed != total as f64
            && completed != total as f64 * SELECTION_PROGRESS_WEIGHT
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
    report(0.0, 0);
    let sources = resolve_shots(shots, &state)?;
    let preferences = preferences_clone(&state)?;
    let program = ffmpeg_program(&preferences);
    let root = cache::root(&preferences);
    let semantic_root = index::root(&preferences);
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
            let total = sources.len();
            report(0.0, total);
            let progress = Mutex::new(BuildProgress {
                total,
                report,
                selected: 0.0,
                indexed: 0.0,
            });
            let groups = media_groups(&sources);
            let cached: Vec<_> = sources
                .iter()
                .map(|source| cache::read(&root, &source.identity))
                .collect();
            let mut stream = decode::FrameStream::start(
                decode::StreamContext {
                    app: &app,
                    program: &program,
                    task_id: &task_id,
                    cancel: &token,
                },
                selection_decode_jobs(&sources, &groups, &cached),
            );
            // Each encoder owns its own session lock. A bounded media handoff
            // lets SigLIP2 for media A overlap selection/decoding for media B.
            std::thread::scope(|scope| {
                let (sender, receiver) = std::sync::mpsc::sync_channel::<IndexWork>(1);
                let worker = scope.spawn(|| -> AppResult<Vec<SelectedShotFrames>> {
                    let mut output = Vec::with_capacity(total);
                    let mut processed = 0;
                    for work in receiver {
                        ensure_not_cancelled(cancel)?;
                        let requests: Vec<_> = work
                            .group
                            .iter()
                            .zip(&work.selections)
                            .map(|(&i, frames)| index::ShotRequest {
                                start_frame: sources[i].shot.start_frame,
                                end_frame: sources[i].shot.end_frame,
                                frames: frames.clone(),
                            })
                            .collect();
                        index::get_or_build(
                            &semantic_root,
                            &sources[work.group[0]].identity,
                            &requests,
                            cancel,
                            |completed| {
                                progress
                                    .lock()
                                    .unwrap()
                                    .indexing(processed as f64 + completed)
                            },
                            |pending, publish| {
                                decode::embed_jobs(
                                    decode::StreamContext {
                                        app: &app,
                                        program: &program,
                                        task_id: &task_id,
                                        cancel: &token,
                                    },
                                    selected_pixel_jobs(&sources, &work, pending)?,
                                    256,
                                    |remaining| siglip::preferred_batch(remaining, cancel),
                                    |rgb| siglip::embed(&app, rgb, cancel),
                                    publish,
                                )
                            },
                        )?;
                        processed += work.group.len();
                        for (&i, frames) in work.group.iter().zip(work.selections) {
                            output.push(SelectedShotFrames {
                                id: sources[i].shot.id.clone(),
                                frames,
                            });
                        }
                    }
                    Ok(output)
                });
                let selected = (|| -> AppResult<()> {
                    let mut completed = 0;
                    for group in groups {
                        let mut work = IndexWork {
                            group: group.clone(),
                            selections: Vec::new(),
                            pixels: HashMap::new(),
                        };
                        let mut records = Vec::new();
                        let mut prepared =
                            HashMap::<(usize, usize), (Arc<cache::ShotData>, usize)>::new();
                        for (position, &i) in group.iter().enumerate() {
                            ensure_not_cancelled(cancel)?;
                            let source = &sources[i];
                            let range = (source.shot.start_frame, source.shot.end_frame);
                            let duplicate = prepared.get(&range).cloned();
                            let mut rgb = Vec::new();
                            let budget =
                                cses::Parameters::for_shot(source.frames, source.rate).scored;
                            let mut observed = 0;
                            let data = if let Some(data) = &cached[i] {
                                Arc::clone(data)
                            } else if let Some((data, _)) = &duplicate {
                                Arc::clone(data)
                            } else {
                                let data = cache::prepare(&root, source, cancel, |available| {
                                    cses::select(source.frames, source.rate, cancel, |positions| {
                                        let vectors = encode_missing(
                                            positions,
                                            source.shot.start_frame,
                                            available,
                                            |missing| {
                                                let reused = positions.len() - missing.len();
                                                encode_shot_pixels(
                                                    &app,
                                                    &mut stream,
                                                    &mut rgb,
                                                    missing,
                                                    cancel,
                                                    |encoded| {
                                                        let fraction = (observed + reused + encoded)
                                                            as f64
                                                            / (budget + 1) as f64;
                                                        progress.lock().unwrap().selection(
                                                            (completed + position) as f64
                                                                + fraction,
                                                        );
                                                    },
                                                )
                                            },
                                        )?;
                                        observed += positions.len();
                                        progress.lock().unwrap().selection(
                                            (completed + position) as f64
                                                + observed as f64 / (budget + 1) as f64,
                                        );
                                        Ok(vectors)
                                    })
                                })?;
                                // Missing probe endpoints can already have cached
                                // vectors. Still consume/cache the rest of this shot
                                // once, so acquisition and SigLIP2 never reseek it.
                                let missing = source.frames - rgb.len() / (256 * 256 * 3);
                                stream.append_frames(&mut rgb, missing, cancel)?;
                                records.push(Arc::clone(&data));
                                data
                            };
                            let frames = data.selection.selected_frames();
                            if !rgb.is_empty() {
                                let mut selected_rgb =
                                    Vec::with_capacity(frames.len() * 256 * 256 * 3);
                                for &frame in &frames {
                                    let offset = (frame - source.shot.start_frame) * 256 * 256 * 3;
                                    selected_rgb
                                        .extend_from_slice(&rgb[offset..offset + 256 * 256 * 3]);
                                }
                                work.pixels.insert(
                                    i,
                                    SelectedPixels {
                                        frames: frames.clone(),
                                        rgb: selected_rgb,
                                    },
                                );
                            } else if let Some((_, original)) = duplicate {
                                if let Some(pixels) = work.pixels.get(&original).cloned() {
                                    work.pixels.insert(i, pixels);
                                }
                            }
                            prepared.entry(range).or_insert((Arc::clone(&data), i));
                            work.selections.push(frames);
                        }
                        // All merged processes for this media must succeed before
                        // either cache can expose the inferred results.
                        stream.validate(cancel)?;
                        for record in records {
                            cache::commit(&root, &record, cancel)?;
                        }
                        completed += group.len();
                        progress.lock().unwrap().selection(completed as f64);
                        sender
                            .send(work)
                            .map_err(|_| inference_error("Storyboard indexing worker stopped"))?;
                    }
                    Ok(())
                })();
                drop(sender);
                drop(stream);
                let indexed = worker
                    .join()
                    .map_err(|_| inference_error("Storyboard indexing worker panicked"))?;
                // Prefer the underlying encoder error if it closed the handoff.
                if let Err(error) = indexed {
                    return Err(error);
                }
                selected?;
                indexed
            })
        },
    )
    .await
}

/// Groups storyboards of one media source so each source owns a single index.
fn media_groups(sources: &[ShotSource]) -> Vec<Vec<usize>> {
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut keys: HashMap<_, usize> = HashMap::new();
    for (index, source) in sources.iter().enumerate() {
        let key = (
            &source.identity.fingerprint,
            source.identity.media_length,
            source.identity.media_modified_ns,
            source.identity.stream,
            source.identity.rate.to_bits(),
        );
        match keys.get(&key) {
            Some(&position) => groups[position].push(index),
            None => {
                keys.insert(key, groups.len());
                groups.push(vec![index]);
            }
        }
    }
    groups
}

// Retrieval only consumes completed SigLIP2 indexes. The best frame of each
// shot decides its score, and that score is the calibrated SigLIP2 match
// probability, which is monotone in the cosine and therefore equal to the
// maximum probability over the shot's frames.
fn search_completed_shots(
    app: &tauri::AppHandle,
    query: &str,
    sources: &[ShotSource],
    selection_root: &Path,
    semantic_root: &Path,
) -> AppResult<Vec<StoryboardSemanticMatch>> {
    if query.trim().is_empty() || sources.is_empty() {
        return Ok(Vec::new());
    }
    let query_embedding = siglip::text_embedding(app, query)?;
    let mut matches = Vec::with_capacity(sources.len());
    for group in media_groups(sources) {
        let mut requests = Vec::with_capacity(group.len());
        for &index in &group {
            let source = &sources[index];
            let data = cache::read(selection_root, &source.identity).ok_or_else(|| {
                inference_error("Storyboard selection must complete before retrieval")
            })?;
            requests.push(index::ShotRequest {
                start_frame: source.shot.start_frame,
                end_frame: source.shot.end_frame,
                frames: data.selection.selected_frames(),
            });
        }
        let vectors = index::read(semantic_root, &sources[group[0]].identity, &requests)?;
        for (slot, &index) in group.iter().enumerate() {
            matches.push(StoryboardSemanticMatch {
                id: sources[index].shot.id.clone(),
                similarity: siglip::match_probability(index::max_similarity(
                    &vectors[slot],
                    &query_embedding,
                )?),
            });
        }
    }
    Ok(matches)
}

#[tauri::command]
pub(crate) async fn initialize_storyboard_semantic_search(
    app: tauri::AppHandle,
) -> CommandResult<()> {
    tokio::task::spawn_blocking(move || siglip::initialize_text_model(&app))
        .await
        .map_err(|error| {
            app_error(
                ErrorCode::BlockingTaskFailed,
                format!("Storyboard semantic initialization failed: {error}"),
            )
        })?
}

#[tauri::command]
pub(crate) async fn search_storyboards_semantic(
    query: String,
    shots: Vec<SemanticShot>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<Vec<StoryboardSemanticMatch>> {
    let sources = resolve_shots(shots, &state)?;
    let preferences = preferences_clone(&state)?;
    let selection_root = cache::root(&preferences);
    let semantic_root = index::root(&preferences);
    tokio::task::spawn_blocking(move || {
        search_completed_shots(&app, &query, &sources, &selection_root, &semantic_root)
    })
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
    fn shared_rgb_resize_preserves_frame_order_channels_and_constant_pixels() {
        let mut pixels = Vec::new();
        for color in [[10, 60, 240], [255, 0, 127]] {
            for _ in 0..256 * 256 {
                pixels.extend_from_slice(&color);
            }
        }
        let resized = downsample_rgb(&pixels).unwrap();
        assert_eq!(resized.len(), 2 * SIDE * SIDE * 3);
        for (frame, color) in resized
            .chunks_exact(SIDE * SIDE * 3)
            .zip([[10, 60, 240], [255, 0, 127]])
        {
            assert!(frame.chunks_exact(3).all(|pixel| pixel == color));
        }
        let ramp: Vec<_> = (0..256)
            .flat_map(|_| (0..256u16).flat_map(|x| [x as u8; 3]))
            .collect();
        let resized = downsample_rgb(&ramp).unwrap();
        for x in 0..SIDE {
            let expected = (((2 * x + 1) as f64 * 256.0 / (2 * SIDE) as f64) - 0.5).round() as u8;
            assert_eq!(&resized[x * 3..x * 3 + 3], &[expected; 3]);
        }
        assert!(downsample_rgb(&[]).is_err());
        assert!(downsample_rgb(&pixels[..pixels.len() - 1]).is_err());
    }

    #[test]
    fn imported_fingerprint_validation_preserves_nanosecond_cache_identity() {
        let original = canonical_media_timestamp(1000, 123, 1000, Duration::new(123, 1)).unwrap();
        let touched =
            canonical_media_timestamp(1000, 123, 1000, Duration::new(123, 999_999_999)).unwrap();
        assert_eq!(original, Some(123_000_000_001));
        assert_eq!(touched, Some(123_999_999_999));
        assert!(canonical_media_timestamp(1000, 123, 1001, Duration::new(123, 1)).is_err());
        assert!(canonical_media_timestamp(1000, 123, 1000, Duration::new(124, 1)).is_err());
        assert!(canonical_media_timestamp(-1, 123, 1000, Duration::new(123, 1)).is_err());
    }

    #[test]
    fn progress_combines_overlapping_media_stages_without_jumps_or_regression() {
        let mut updates = Vec::new();
        let mut progress = BuildProgress {
            total: 4,
            selected: 0.0,
            indexed: 0.0,
            report: |completed, _| updates.push(completed),
        };
        progress.selection(2.0);
        progress.indexing(0.5);
        progress.selection(2.5);
        progress.indexing(2.0);
        progress.selection(4.0);
        progress.indexing(4.0);
        assert_eq!(updates, vec![1.5, 1.625, 2.0, 2.375, 3.5, 4.0]);
    }

    #[test]
    fn selected_decode_jobs_coalesce_neighbors_and_seek_over_sparse_gaps() {
        let source = |start_frame, end_frame| ShotSource {
            shot: SemanticShot {
                id: "shot".into(),
                source: "panel".into(),
                asset_id: "asset".into(),
                fingerprint: "a".repeat(64),
                start_frame,
                end_frame,
            },
            identity: cache::ShotIdentity {
                fingerprint: "a".repeat(64),
                media_length: 1,
                media_modified_ns: None,
                stream: 0,
                rate: 25.0,
                start_frame,
                end_frame,
            },
            path: "original.mp4".into(),
            stream: 0,
            rate: 25.0,
            frames: end_frame - start_frame + 1,
        };
        let sources = [source(100, 149), source(150, 199), source(1000, 1800)];
        let duplicates = [source(100, 149), source(100, 149), source(150, 199)];
        let deduplicated =
            selection_decode_jobs(&duplicates, &[vec![0, 1, 2]], &[None, None, None]);
        assert_eq!(deduplicated.len(), 1);
        assert_eq!(
            deduplicated[0].count, 100,
            "repeated panel requests must not decode or sample the shot again"
        );
        let full = selection_decode_jobs(&sources, &[vec![0, 1, 2]], &[None, None, None]);
        assert_eq!(
            full.iter().map(|job| job.count).collect::<Vec<_>>(),
            vec![100, 801]
        );
        assert!(full.iter().all(|job| job.rgb.is_none()));
        assert!(full[0]
            .args
            .iter()
            .any(|arg| arg == "scale=256:256:flags=bilinear,format=rgb24"));
        #[cfg(windows)]
        assert!(full[0]
            .args
            .windows(2)
            .any(|args| args == ["-hwaccel", "d3d11va"]));
        let split = selection_decode_jobs(&sources, &[vec![0], vec![1, 2]], &[None, None, None]);
        assert_eq!(split.len(), 3, "media boundaries cannot share a process");
        let pending = [
            index::PendingShot {
                position: 0,
                frames: vec![0, 25],
            },
            index::PendingShot {
                position: 1,
                frames: vec![0, 25],
            },
            index::PendingShot {
                position: 2,
                frames: vec![0, 400, 800],
            },
        ];
        let work = IndexWork {
            group: vec![0, 1, 2],
            selections: Vec::new(),
            pixels: HashMap::from([
                (
                    0,
                    SelectedPixels {
                        frames: vec![100, 125],
                        rgb: vec![7; 2 * 256 * 256 * 3],
                    },
                ),
                (
                    2,
                    SelectedPixels {
                        frames: vec![1000, 1400, 1800],
                        rgb: [
                            vec![8; 256 * 256 * 3],
                            vec![9; 256 * 256 * 3],
                            vec![10; 256 * 256 * 3],
                        ]
                        .concat(),
                    },
                ),
            ]),
        };
        let mixed = selected_pixel_jobs(&sources, &work, &pending).unwrap();
        assert_eq!(
            mixed
                .iter()
                .map(|job| (job.count, job.completed_shots, job.rgb.is_some()))
                .collect::<Vec<_>>(),
            vec![(2, 1, true), (2, 2, false), (3, 3, true)]
        );
        assert!(mixed[0].args.is_empty());
        assert_eq!(mixed[2].rgb.as_ref().unwrap()[256 * 256 * 3], 9);
        let jobs = selected_decode_jobs(&sources, &[0, 1, 2], &pending);
        assert_eq!(
            jobs.iter()
                .map(|job| (job.count, job.completed_shots))
                .collect::<Vec<_>>(),
            vec![(4, 2), (1, 2), (1, 2), (1, 3)]
        );
        let seeks: Vec<_> = jobs
            .iter()
            .map(|job| {
                let position = job.args.iter().position(|arg| arg == "-ss").unwrap();
                job.args[position + 1].parse::<f64>().unwrap()
            })
            .collect();
        assert_eq!(seeks, vec![4.0, 40.0, 56.0, 72.0]);
        assert!(jobs[0].args.iter().any(|arg| arg.contains("eq(n\\,75)")));
        // Descending UI order must create a new seek, preserving output order.
        let jobs = selected_decode_jobs(
            &sources,
            &[2, 0, 1],
            &[
                index::PendingShot {
                    position: 0,
                    frames: vec![800],
                },
                index::PendingShot {
                    position: 1,
                    frames: vec![0],
                },
            ],
        );
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[1].completed_shots, 2);

        let sources: Vec<_> = (0..16).map(|i| source(i * 32, i * 32 + 31)).collect();
        let pending: Vec<_> = (0..16)
            .map(|position| index::PendingShot {
                position,
                frames: (0..32).collect(),
            })
            .collect();
        let jobs = selected_decode_jobs(&sources, &(0..16).collect::<Vec<_>>(), &pending);
        assert_eq!(
            jobs.iter()
                .map(|job| (job.count, job.completed_shots))
                .collect::<Vec<_>>(),
            vec![(256, 8), (256, 16)]
        );

        let sources: Vec<_> = (0..20).map(|i| source(i * 50, i * 50)).collect();
        let pending: Vec<_> = (0..20)
            .map(|position| index::PendingShot {
                position,
                frames: vec![0],
            })
            .collect();
        let jobs = selected_decode_jobs(&sources, &(0..20).collect::<Vec<_>>(), &pending);
        assert_eq!(
            jobs.iter().map(|job| job.count).collect::<Vec<_>>(),
            vec![16, 4]
        );
    }

    #[test]
    fn one_task_progress_weights_selection_and_siglip_batches_three_to_one() {
        let mut updates = Vec::new();
        let mut progress = BuildProgress {
            total: 2,
            selected: 0.0,
            indexed: 0.0,
            report: |completed, total| updates.push((completed, total)),
        };
        // A partial selection, a completed selection, and a cached selection.
        progress.selection(0.5);
        progress.selection(1.0);
        progress.selection(2.0);
        // Vector batches advance before each shot's final publication.
        progress.indexing(0.5);
        progress.indexing(1.0);
        progress.indexing(1.5);
        progress.indexing(2.0);
        assert_eq!(
            updates,
            vec![
                (0.375, 2),
                (0.75, 2),
                (1.5, 2),
                (1.625, 2),
                (1.75, 2),
                (1.875, 2),
                (2.0, 2)
            ]
        );
        assert!(updates.windows(2).all(|pair| pair[0].0 < pair[1].0));
        assert!(updates[..updates.len() - 1]
            .iter()
            .all(|&(completed, total)| completed < total as f64));
    }

    #[test]
    fn media_groups_reuse_interleaved_sources_but_separate_media_versions() {
        let make_source = |fingerprint: &str, stream, modified, rate| ShotSource {
            shot: SemanticShot {
                id: "shot".into(),
                source: "panel".into(),
                asset_id: "asset".into(),
                fingerprint: fingerprint.into(),
                start_frame: 0,
                end_frame: 0,
            },
            identity: cache::ShotIdentity {
                fingerprint: fingerprint.into(),
                stream,
                rate,
                media_length: 10,
                media_modified_ns: modified,
                start_frame: 0,
                end_frame: 0,
            },
            path: "original.mp4".into(),
            stream,
            rate,
            frames: 1,
        };
        let sources = [
            make_source("a", 0, Some(1), 24.0),
            make_source("b", 0, Some(1), 24.0),
            make_source("a", 0, Some(1), 24.0),
            make_source("a", 1, Some(1), 24.0),
            make_source("a", 0, Some(2), 24.0),
            make_source("a", 0, Some(1), 25.0),
        ];
        assert_eq!(
            media_groups(&sources),
            vec![vec![0, 2], vec![1], vec![3], vec![4], vec![5]]
        );
        assert!(media_groups(&[]).is_empty());
    }

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
