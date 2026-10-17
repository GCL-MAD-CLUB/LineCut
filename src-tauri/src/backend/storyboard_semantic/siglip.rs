//! SigLIP2 paired encoders. Independent vision and query sessions share ONNX recovery.
use super::*;
use tokenizers::{PaddingParams, PaddingStrategy, Tokenizer, TruncationParams};
const SIDE: usize = 256;
pub(super) const DIMENSIONS: usize = 768;
const TOKENS: usize = 64;
// The exported graphs stop at the normalized `pooler_output` pair, so the
// pairwise logits SiglipModel applies next are not part of the ONNX assets.
// Both values come from the upstream checkpoint
// `google/siglip2-base-patch16-256` that the pinned ONNX revision exports:
// logits = exp(logit_scale) * cosine + logit_bias, then sigmoid, exactly like
// `SiglipModel.forward` and the zero-shot pipeline.
const LOGIT_SCALE: f64 = 4.726513;
const LOGIT_BIAS: f64 = -16.771803;

/// Calibrated SigLIP2 image/text match probability for one exact cosine.
/// Raw cosine values of this checkpoint live in a narrow band, so retrieval
/// needs the trained pair calibration to produce a usable 0..1 score.
pub(super) fn match_probability(cosine: f32) -> f32 {
    let logits = f64::from(cosine).mul_add(LOGIT_SCALE.exp(), LOGIT_BIAS);
    (1.0 / (1.0 + (-logits).exp())) as f32
}

pub(super) fn directory(app: &tauri::AppHandle) -> Option<PathBuf> {
    let path = super::resource_directory(app)?.join("siglip2");
    [
        "vision_model_fp16.onnx",
        "text_model_int8.onnx",
        "tokenizer.json",
    ]
    .iter()
    .all(|name| path.join(name).is_file())
    .then_some(path)
}

struct TextModel {
    runtime: OnnxModel,
    tokenizer: Tokenizer,
}
static TEXT: OnceLock<Mutex<Option<TextModel>>> = OnceLock::new();

fn text_tokenizer(path: PathBuf) -> AppResult<Tokenizer> {
    let mut tokenizer = Tokenizer::from_file(path).map_err(inference_error)?;
    tokenizer
        .with_truncation(Some(TruncationParams {
            max_length: TOKENS,
            ..Default::default()
        }))
        .map_err(inference_error)?;
    tokenizer.with_padding(Some(PaddingParams {
        strategy: PaddingStrategy::Fixed(TOKENS),
        pad_id: 0,
        pad_token: "<pad>".into(),
        ..Default::default()
    }));
    Ok(tokenizer)
}

fn query_ids(tokenizer: &Tokenizer, query: &str) -> AppResult<Vec<i64>> {
    // The model's tokenizer owns EOS insertion and normalization. Do not use
    // Jina's Query: prefix or turn the query into a classification prompt.
    let encoding = tokenizer
        .encode(query.trim(), true)
        .map_err(inference_error)?;
    let ids: Vec<i64> = encoding.get_ids().iter().map(|&id| i64::from(id)).collect();
    if ids.len() != TOKENS {
        return Err(inference_error("Unexpected SigLIP2 token length"));
    }
    Ok(ids)
}

fn run_text_embedding(session: &Session, input: &Tensor<i64>) -> ort::Result<Vec<f32>> {
    let options =
        RunOptions::new()?.with_outputs(OutputSelector::no_default().with("pooler_output"));
    let outputs = session.run_with_options([input.view().into()], &options)?;
    let values = outputs
        .get("pooler_output")
        .ok_or_else(|| ort::Error::new("Missing SigLIP2 pooler_output"))?
        .try_extract_tensor::<f32>()?;
    if values.shape() != [1, DIMENSIONS] {
        return Err(ort::Error::new("Unexpected SigLIP2 text embedding shape"));
    }
    Ok(values.iter().copied().collect())
}

struct QueryPriority;
impl Drop for QueryPriority {
    fn drop(&mut self) {
        QUERY_WAITERS.fetch_sub(1, Ordering::SeqCst);
    }
}

pub(super) fn text_embedding(app: &tauri::AppHandle, query: &str) -> AppResult<Vec<f32>> {
    QUERY_WAITERS.fetch_add(1, Ordering::SeqCst);
    let _priority = QueryPriority;
    let mut guard = TEXT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(inference_error)?;
    if guard.is_none() {
        let directory = directory(app).ok_or_else(|| {
            app_error(
                ErrorCode::SemanticModelMissing,
                "SigLIP2 assets are missing; run npm run prepare:storyboard-semantic",
            )
        })?;
        storyboard::init_shared_ort(app)?;
        // Use CPU for the quantized text graph because DirectML can produce
        // inconsistent embeddings without an inference error. Vision batches
        // continue to use the shared accelerated provider policy.
        let runtime = OnnxModel::load_cpu(
            &directory.join("text_model_int8.onnx"),
            &[("batch_size", 1), ("sequence_length", TOKENS as i64)],
            inference_error,
        )?;
        tracing::info!(provider = %runtime.provider(), "Selected SigLIP2 query provider");
        let tokenizer = text_tokenizer(directory.join("tokenizer.json"))?;
        *guard = Some(TextModel { runtime, tokenizer });
    }
    let model = guard
        .as_ref()
        .ok_or_else(|| inference_error("Missing SigLIP2 text model"))?;
    let ids = query_ids(&model.tokenizer, query)?;
    let input = Tensor::from_array(([1, TOKENS], ids)).map_err(inference_error)?;
    let values = model
        .runtime
        .run(None, |session| run_text_embedding(session, &input))?;
    normalize(&values)
}

fn normalize(values: &[f32]) -> AppResult<Vec<f32>> {
    let norm = values
        .iter()
        .map(|&v| f64::from(v).powi(2))
        .sum::<f64>()
        .sqrt();
    if values.len() != DIMENSIONS || !norm.is_finite() || norm <= f64::EPSILON {
        return Err(inference_error("Invalid SigLIP2 embedding"));
    }
    Ok(values
        .iter()
        .map(|&v| (f64::from(v) / norm) as f32)
        .collect())
}
static QUERY_WAITERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
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
fn model_guard(
    cancel: &AtomicBool,
) -> AppResult<std::sync::MutexGuard<'static, Option<BatchEngine>>> {
    loop {
        ensure_not_cancelled(cancel)?;
        if QUERY_WAITERS.load(Ordering::SeqCst) > 0 {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }
        match MODEL.get_or_init(|| Mutex::new(None)).try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => return Err(inference_error(error)),
        }
    }
}

pub(super) fn preferred_batch(remaining: usize, cancel: &AtomicBool) -> AppResult<usize> {
    let mut guard = model_guard(cancel)?;
    Ok(guard
        .get_or_insert_with(BatchEngine::default)
        .policy
        .choose(remaining))
}

pub(super) fn embed(
    app: &tauri::AppHandle,
    rgb: &[u8],
    cancel: &AtomicBool,
) -> AppResult<Vec<Vec<f32>>> {
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
            tracing::warn!(size, %error, "Retrying SigLIP2 with smaller real batches");
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
        return Err(inference_error("Invalid SigLIP2 RGB batch"));
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
        let directory = directory(app).ok_or_else(|| {
            app_error(
                ErrorCode::SemanticModelMissing,
                "SigLIP2 is missing; run npm run prepare:storyboard-semantic",
            )
        })?;
        storyboard::init_shared_ort(app)?;
        let dimensions = [
            ("batch_size", size as i64),
            ("num_channels", 3),
            ("height", SIDE as i64),
            ("width", SIDE as i64),
        ];
        let runtime = if engine.cpu {
            OnnxModel::load_cpu(
                &directory.join("vision_model_fp16.onnx"),
                &dimensions,
                inference_error,
            )?
        } else {
            OnnxModel::load(
                &directory.join("vision_model_fp16.onnx"),
                &dimensions,
                inference_error,
            )?
        };
        if runtime.provider().to_string() == "CPU"
            && !engine.cpu
            && engine
                .sessions
                .iter()
                .any(|s| s.runtime.provider().to_string() != "CPU")
        {
            return Err(inference_error(
                "Larger SigLIP2 shape could not use the active GPU; retry a smaller batch",
            ));
        }
        if runtime.provider().to_string() == "CPU" && !engine.cpu {
            engine.cpu = true;
            engine.sessions.clear();
            engine.policy = batch::BatchPolicy::default();
        }
        tracing::info!(size, provider = %runtime.provider(), "Prepared SigLIP2 batch shape");
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
        .ok_or_else(|| inference_error("Missing SigLIP2 batch session"))?;
    let started = std::time::Instant::now();
    let (_, input) = model
        .input
        .try_extract_raw_tensor_mut::<f32>()
        .map_err(inference_error)?;
    // Lookup preserves the original f32 operations exactly, but performs only
    // 3*256 normalizations once rather than two divisions per channel/pixel.
    static NORMALIZED_RGB: OnceLock<[[f32; 256]; 3]> = OnceLock::new();
    let table = NORMALIZED_RGB.get_or_init(|| {
        std::array::from_fn(|_| std::array::from_fn(|v| (v as f32 / 255.0 - 0.5) / 0.5))
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
                return Err(inference_error("Invalid SigLIP2 embedding"));
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
    // Do not materialize/copy the unused 256-token last_hidden_state output.
    // Borrow the reusable input; a CPU recovery retries this identical tensor.
    let output = session.run_with_options([input.view().into()], options)?;
    // SigLIP2 exports the attention-pooled image projection as pooler_output.
    let pooled = output
        .get("pooler_output")
        .ok_or_else(|| ort::Error::new("SigLIP2 pooler_output is missing"))?;
    let values = pooled.try_extract_tensor::<f32>()?;
    if values.shape() != [size, DIMENSIONS] {
        return Err(ort::Error::new("Unexpected SigLIP2 output shape"));
    }
    let values = values
        .as_slice()
        .ok_or_else(|| ort::Error::new("Non-contiguous SigLIP2 output"))?;
    Ok(values.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibrated_match_probability_separates_matches_from_background() {
        // Check both sides of the trained logit midpoint and its tails.
        assert!(match_probability(0.1752) > 0.9);
        assert!(match_probability(0.1237) < 0.1);
        assert!(match_probability(0.05) < 0.001);
        assert!(match_probability(-0.2) < 1e-6);
        assert_eq!(match_probability(1.0), 1.0);
        assert!(match_probability(0.2) > match_probability(0.1));
    }

    #[test]
    #[ignore = "requires packaged SigLIP2 models, ONNX Runtime and a DirectML GPU"]
    fn siglip2_query_encoder_provider_diagnostics() {
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
        let directory = resources.join("storyboard-semantic").join("siglip2");
        let model = directory.join("text_model_int8.onnx");
        let dimensions = [("batch_size", 1), ("sequence_length", TOKENS as i64)];
        let tokenizer = text_tokenizer(directory.join("tokenizer.json")).unwrap();
        let ids = query_ids(&tokenizer, "an anime girl crying in a room").unwrap();
        let input = Tensor::from_array(([1, TOKENS], ids)).unwrap();
        let gpu = super::super::onnx::create_directml_model_session_with_dimensions(
            &model,
            0,
            &dimensions,
        )
        .unwrap();
        let cpu = super::super::onnx::create_cpu_model_session_with_dimensions(&model, &dimensions)
            .unwrap();
        let actual = normalize(&run_text_embedding(&gpu, &input).unwrap()).unwrap();
        let expected = normalize(&run_text_embedding(&cpu, &input).unwrap()).unwrap();
        let norm = |row: &[f32]| {
            row.iter()
                .map(|&x| f64::from(x).powi(2))
                .sum::<f64>()
                .sqrt()
        };
        let cosine = |a: &[f32], b: &[f32]| {
            a.iter()
                .zip(b)
                .map(|(&x, &y)| f64::from(x) * f64::from(y))
                .sum::<f64>()
                / (norm(a) * norm(b))
        };
        let deviation = cosine(&actual, &expected);
        eprintln!("SigLIP2 text DirectML/CPU cosine: {deviation}");
        // Diagnose provider drift without requiring a particular GPU defect.
        // The production query encoder always uses the validated CPU path.
        assert!(deviation.is_finite());
        assert!((norm(&expected) - 1.0).abs() < 1e-6);
        assert!((norm(&actual) - 1.0).abs() < 1e-6);
    }
}
