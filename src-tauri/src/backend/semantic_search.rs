//! Local subtitle retrieval. Content-addressed indexes survive source changes,
//! but are invalidated by text, model revision, or embedding recipe changes.
use super::*;
use ort::{session::Session, value::Tensor};
use std::sync::{OnceLock, TryLockError};
use tauri::{ipc::Channel, path::BaseDirectory};
use tokenizers::{Tokenizer, TruncationParams};

const MODEL_REVISION: &str = "jina-v5-nano-retrieval-int8-ac5d898c-last-token-l2-v1";
const DIMENSIONS: usize = 768;
const MAX_TOKENS: usize = 8192;
static MODEL: OnceLock<Mutex<Option<EmbeddingModel>>> = OnceLock::new();

#[derive(Deserialize)]
pub(crate) struct SemanticSubtitle {
    id: String,
    text: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct SemanticSearchProgress {
    phase: &'static str,
    completed: usize,
    total: usize,
}

#[derive(Serialize)]
pub(crate) struct SemanticMatch {
    id: String,
    similarity: f32,
}

struct EmbeddingModel {
    session: Session,
    tokenizer: Tokenizer,
}

fn inference_error(error: impl std::fmt::Display) -> AppError {
    app_error(ErrorCode::SemanticInferenceFailed, error.to_string())
}

fn resource_directory(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let name = "semantic-search";
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
    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("src-tauri/resources").join(name));
        candidates.push(cwd.join("resources").join(name));
    }
    candidates
        .into_iter()
        .find(|path| {
            [
                "model_quantized.onnx",
                "model_quantized.onnx_data",
                "tokenizer.json",
            ]
            .iter()
            .all(|name| path.join(name).is_file())
        })
        .ok_or_else(|| {
            app_error(
                ErrorCode::SemanticModelMissing,
                "Jina INT8 model or tokenizer is missing; run npm run prepare:semantic",
            )
        })
}

impl EmbeddingModel {
    fn load(app: &tauri::AppHandle) -> AppResult<Self> {
        let directory = resource_directory(app)?;
        storyboard::init_shared_ort(app)?;
        let (session, provider) =
            storyboard::create_model_session(&directory.join("model_quantized.onnx"))?;
        tracing::info!(%provider, "Selected subtitle semantic search provider");
        Self::from_session(session, &directory)
    }

    fn from_session(session: Session, directory: &Path) -> AppResult<Self> {
        let mut tokenizer =
            Tokenizer::from_file(directory.join("tokenizer.json")).map_err(inference_error)?;
        tokenizer.with_padding(None);
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_TOKENS,
                ..Default::default()
            }))
            .map_err(inference_error)?;
        Ok(Self { session, tokenizer })
    }

    fn embed(&self, text: &str, query: bool) -> AppResult<Vec<f32>> {
        let prefix = if query { "Query: " } else { "Document: " };
        let encoding = self
            .tokenizer
            .encode(format!("{prefix}{text}"), true)
            .map_err(inference_error)?;
        let length = encoding.len();
        let ids = encoding
            .get_ids()
            .iter()
            .map(|id| i64::from(*id))
            .collect::<Vec<_>>();
        let mask = encoding
            .get_attention_mask()
            .iter()
            .map(|value| i64::from(*value))
            .collect::<Vec<_>>();
        let last_token = mask
            .iter()
            .rposition(|value| *value != 0)
            .ok_or_else(|| inference_error("Empty token sequence"))?;
        let ids =
            Tensor::from_array(([1, length], ids.into_boxed_slice())).map_err(inference_error)?;
        let mask =
            Tensor::from_array(([1, length], mask.into_boxed_slice())).map_err(inference_error)?;
        let outputs = self
            .session
            .run(
                ort::inputs!["input_ids" => ids, "attention_mask" => mask]
                    .map_err(inference_error)?,
            )
            .map_err(inference_error)?;
        let output = outputs
            .get("last_hidden_state")
            .ok_or_else(|| inference_error("Missing last_hidden_state output"))?;
        let (shape, values) = output
            .try_extract_raw_tensor::<f32>()
            .map_err(inference_error)?;
        if shape != [1, length as i64, DIMENSIONS as i64] {
            return Err(inference_error(format!(
                "Unexpected Jina output shape: {shape:?}"
            )));
        }
        normalize_embedding(&values[last_token * DIMENSIONS..(last_token + 1) * DIMENSIONS])
    }
}

fn normalize_embedding(values: &[f32]) -> AppResult<Vec<f32>> {
    let norm = values.iter().map(|value| value * value).sum::<f32>().sqrt();
    if !norm.is_finite() || norm <= f32::EPSILON {
        return Err(inference_error("Invalid embedding norm"));
    }
    Ok(values.iter().map(|value| value / norm).collect())
}

fn index_key(text: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(MODEL_REVISION.as_bytes());
    hash.update([0]);
    hash.update(text.as_bytes());
    format!("{:x}", hash.finalize())
}

#[derive(Serialize, Deserialize)]
struct IndexEntry {
    key: String,
    embedding: Vec<f32>,
}

fn read_embedding(path: &Path, key: &str) -> Option<Vec<f32>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(%error, path = %path.display(), "Semantic index will be rebuilt");
            }
            return None;
        }
    };
    let entry: IndexEntry = match bincode::deserialize(&bytes) {
        Ok(entry) => entry,
        Err(error) => {
            tracing::warn!(%error, "Invalid semantic index will be rebuilt");
            return None;
        }
    };
    let norm = entry
        .embedding
        .iter()
        .map(|value| value * value)
        .sum::<f32>();
    (entry.key == key
        && entry.embedding.len() == DIMENSIONS
        && norm.is_finite()
        && (norm - 1.0).abs() < 0.001)
        .then_some(entry.embedding)
}

fn write_embedding(path: &Path, key: String, embedding: Vec<f32>) -> AppResult<()> {
    let bytes = bincode::serialize(&IndexEntry { key, embedding }).map_err(inference_error)?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = fs::write(&temporary, bytes).and_then(|_| fs::rename(&temporary, path));
    if let Err(error) = result {
        if let Err(cleanup_error) = fs::remove_file(&temporary) {
            tracing::warn!(%cleanup_error, "Could not remove temporary semantic index");
        }
        return Err(app_error(
            ErrorCode::SemanticIndexWriteFailed,
            format!("Cannot write semantic index {}: {error}", path.display()),
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn search_subtitles_semantic(
    query: String,
    subtitles: Vec<SemanticSubtitle>,
    task_id: String,
    on_progress: Channel<SemanticSearchProgress>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<Vec<SemanticMatch>> {
    let task = register_task(&task_id, state.inner())?;
    let root = configured_cache_root(&preferences_clone(&state)?)
        .join("semantic-search")
        .join(MODEL_REVISION);
    let total = subtitles.len();
    let report = move |phase, completed| {
        if let Err(error) = on_progress.send(SemanticSearchProgress {
            phase,
            completed,
            total,
        }) {
            tracing::debug!(%error, "Semantic search progress receiver closed");
        }
    };
    report("indexing", 0); // Also acknowledges registration for cancellation races.
    spawn_blocking_cancellable(
        task.cancel_token(),
        "semantic subtitle search",
        move |cancel| {
            if query.trim().is_empty() || subtitles.is_empty() {
                return Ok(Vec::new());
            }
            let mutex = MODEL.get_or_init(|| Mutex::new(None));
            let mut guard = loop {
                ensure_not_cancelled(cancel)?;
                match mutex.try_lock() {
                    Ok(guard) => break guard,
                    Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(25)),
                    Err(error) => return Err(inference_error(error)),
                }
            };
            if guard.is_none() {
                *guard = Some(EmbeddingModel::load(&app)?);
            }
            let model = guard
                .as_ref()
                .ok_or_else(|| inference_error("Embedding model was not initialized"))?;
            fs::create_dir_all(&root).map_err(|error| {
                app_error(ErrorCode::SemanticIndexWriteFailed, error.to_string())
            })?;
            let mut vectors = Vec::with_capacity(total);
            for (index, subtitle) in subtitles.iter().enumerate() {
                ensure_not_cancelled(cancel)?;
                if subtitle.text.trim().is_empty() {
                    vectors.push(None);
                } else {
                    let key = index_key(&subtitle.text);
                    let path = root.join(format!("{key}.bin"));
                    let embedding = if let Some(value) = read_embedding(&path, &key) {
                        value
                    } else {
                        let value = model.embed(&subtitle.text, false)?;
                        ensure_not_cancelled(cancel)?;
                        write_embedding(&path, key, value.clone())?;
                        value
                    };
                    vectors.push(Some(embedding));
                }
                if index % 32 == 0 || index + 1 == total {
                    report("indexing", index + 1);
                }
            }
            ensure_not_cancelled(cancel)?;
            report("searching", total);
            let query_embedding = model.embed(query.trim(), true)?;
            Ok(subtitles
                .into_iter()
                .zip(vectors)
                .filter_map(|(subtitle, vector)| {
                    vector.map(|vector| SemanticMatch {
                        id: subtitle.id,
                        similarity: vector
                            .iter()
                            .zip(&query_embedding)
                            .map(|(a, b)| a * b)
                            .sum::<f32>()
                            .clamp(-1.0, 1.0),
                    })
                })
                .collect())
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_and_content_invalidation() {
        assert_eq!(normalize_embedding(&[3.0, 4.0]).unwrap(), vec![0.6, 0.8]);
        assert!(normalize_embedding(&[0.0, 0.0]).is_err());
        assert!(normalize_embedding(&[f32::NAN]).is_err());
        assert_ne!(index_key("original subtitle"), index_key("edited subtitle"));
        assert_eq!(index_key("same text"), index_key("same text"));
    }

    #[test]
    fn index_roundtrip_rejects_stale_and_corrupt_entries() {
        let root = env::temp_dir().join(format!("linecut-semantic-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("index.bin");
        let vector = normalize_embedding(&vec![1.0; DIMENSIONS]).unwrap();
        write_embedding(&path, "key".into(), vector.clone()).unwrap();
        assert_eq!(read_embedding(&path, "key"), Some(vector));
        assert!(read_embedding(&path, "changed-key").is_none());
        fs::write(&path, b"broken").unwrap();
        assert!(read_embedding(&path, "key").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires npm run prepare:semantic and prepare:transnetv2"]
    fn packaged_int8_retrieval_smoke() {
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
        let directory = resources.join("semantic-search");
        let model_path = directory.join("model_quantized.onnx");
        for automatic_provider in [false, true] {
            let (session, provider) = if automatic_provider {
                storyboard::create_model_session(&model_path).unwrap()
            } else {
                (
                    storyboard::create_cpu_model_session(&model_path).unwrap(),
                    "CPU".to_string(),
                )
            };
            let model = EmbeddingModel::from_session(session, &directory).unwrap();
            let query = model
                .embed("Which planet is known as the Red Planet?", true)
                .unwrap();
            let related = model
                .embed("火星因其红色的外观而被称为红色星球。", false)
                .unwrap();
            let unrelated = model
                .embed("Mix flour, eggs and milk to bake a cake.", false)
                .unwrap();
            let cosine = |value: &[f32]| value.iter().zip(&query).map(|(a, b)| a * b).sum::<f32>();
            assert_eq!(query.len(), DIMENSIONS);
            assert!(
                cosine(&related) > cosine(&unrelated) + 0.05,
                "{provider}: related {}, unrelated {}",
                cosine(&related),
                cosine(&unrelated)
            );
            assert_eq!(
                related,
                model
                    .embed("火星因其红色的外观而被称为红色星球。", false)
                    .unwrap()
            );
            eprintln!(
                "{provider}: related={:.4}, unrelated={:.4}",
                cosine(&related),
                cosine(&unrelated)
            );
        }
    }
}
