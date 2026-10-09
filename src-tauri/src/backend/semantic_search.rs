//! Local subtitle retrieval. Content-addressed indexes survive source changes,
//! but are invalidated by text, model revision, or embedding recipe changes.
use super::*;
use ort::{session::Session, value::Tensor};
use std::sync::{OnceLock, TryLockError};
use tauri::{ipc::Channel, path::BaseDirectory};
use tokenizers::{Tokenizer, TruncationParams};

const MODEL_REVISION: &str = "jina-v5-nano-retrieval-int8-ac5d898c-last-token-l2-file-v2";
const DIMENSIONS: usize = 768;
const MAX_TOKENS: usize = 8192;
static MODEL: OnceLock<Mutex<Option<EmbeddingModel>>> = OnceLock::new();

#[derive(Deserialize)]
pub(crate) struct SemanticSubtitle {
    id: String,
    text: String,
    source: String,
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

// Group by stable subtitle file/track identity, preserving its original cue order.
// Display row IDs, source IDs, query, and scope are deliberately excluded from
// the content hash so reopening a file or selecting A+B can reuse A's index.
struct SubtitleFile<'a> {
    key: String,
    cues: Vec<&'a SemanticSubtitle>,
}

fn subtitle_files(subtitles: &[SemanticSubtitle]) -> Vec<SubtitleFile<'_>> {
    let mut sources = std::collections::BTreeMap::<&str, Vec<&SemanticSubtitle>>::new();
    for subtitle in subtitles {
        sources.entry(&subtitle.source).or_default().push(subtitle);
    }
    sources
        .into_values()
        .map(|cues| {
            let mut hash = Sha256::new();
            hash.update(MODEL_REVISION.as_bytes());
            hash.update((cues.len() as u64).to_le_bytes());
            for cue in &cues {
                hash.update((cue.text.len() as u64).to_le_bytes());
                hash.update(cue.text.as_bytes());
            }
            SubtitleFile {
                key: format!("{:x}", hash.finalize()),
                cues,
            }
        })
        .collect()
}

#[derive(Serialize, Deserialize)]
struct SubtitleFileIndex {
    key: String,
    // Empty text has no embedding but retains its position in the file.
    embeddings: Vec<Option<Vec<f32>>>,
}

fn read_file_index(root: &Path, file: &SubtitleFile<'_>) -> Option<SubtitleFileIndex> {
    let path = root.join(format!("{}.bin", file.key));
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(%error, path = %path.display(), "Semantic file index will be rebuilt");
            }
            return None;
        }
    };
    let index: SubtitleFileIndex = match bincode::deserialize(&bytes) {
        Ok(index) => index,
        Err(error) => {
            tracing::warn!(%error, "Invalid semantic file index will be rebuilt");
            return None;
        }
    };
    let valid = index.key == file.key
        && index.embeddings.len() == file.cues.len()
        && index
            .embeddings
            .iter()
            .zip(&file.cues)
            .all(|(vector, cue)| match vector {
                None => cue.text.trim().is_empty(),
                Some(vector) => {
                    let norm = vector.iter().map(|value| value * value).sum::<f32>();
                    !cue.text.trim().is_empty()
                        && vector.len() == DIMENSIONS
                        && norm.is_finite()
                        && (norm - 1.0).abs() < 0.001
                }
            });
    valid.then_some(index)
}

fn write_file_index(root: &Path, index: &SubtitleFileIndex) -> AppResult<()> {
    let path = root.join(format!("{}.bin", index.key));
    let bytes = bincode::serialize(index).map_err(inference_error)?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = fs::write(&temporary, bytes).and_then(|_| fs::rename(&temporary, &path));
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

fn build_file_indexes(
    root: &Path,
    files: &[SubtitleFile<'_>],
    cancel: &AtomicBool,
    mut embed: impl FnMut(&str) -> AppResult<Vec<f32>>,
    mut report: impl FnMut(usize, usize),
) -> AppResult<()> {
    let mut seen = std::collections::HashSet::new();
    let pending = files
        .iter()
        .filter(|file| seen.insert(&file.key) && read_file_index(root, file).is_none())
        .collect::<Vec<_>>();
    let total = pending.iter().map(|file| file.cues.len()).sum();
    let mut completed = 0;
    report(completed, total);
    for file in pending {
        ensure_not_cancelled(cancel)?;
        let mut embeddings = Vec::with_capacity(file.cues.len());
        for cue in &file.cues {
            ensure_not_cancelled(cancel)?;
            let vector = if cue.text.trim().is_empty() {
                None
            } else {
                Some(embed(&cue.text)?)
            };
            ensure_not_cancelled(cancel)?;
            embeddings.push(vector);
            completed += 1;
            report(completed, total);
        }
        ensure_not_cancelled(cancel)?;
        // Persist complete files only. Cancelling B preserves already completed A.
        write_file_index(
            root,
            &SubtitleFileIndex {
                key: file.key.clone(),
                embeddings,
            },
        )?;
    }
    Ok(())
}

fn model_guard(
    cancel: &AtomicBool,
) -> AppResult<std::sync::MutexGuard<'static, Option<EmbeddingModel>>> {
    let mutex = MODEL.get_or_init(|| Mutex::new(None));
    loop {
        ensure_not_cancelled(cancel)?;
        match mutex.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => return Err(inference_error(error)),
        }
    }
}

fn semantic_index_root(state: &tauri::State<'_, AppState>) -> AppResult<PathBuf> {
    Ok(configured_cache_root(&preferences_clone(state)?)
        .join("semantic-search")
        .join(MODEL_REVISION))
}

// Indexing is query-independent and owns its cancellable background task.
#[tauri::command]
pub(crate) async fn index_subtitles_semantic(
    subtitles: Vec<SemanticSubtitle>,
    task_id: String,
    on_progress: Channel<SemanticSearchProgress>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<()> {
    let task = register_task(&task_id, state.inner())?;
    let root = semantic_index_root(&state)?;
    let report = move |completed, total| {
        if let Err(error) = on_progress.send(SemanticSearchProgress {
            phase: "indexing",
            completed,
            total,
        }) {
            tracing::debug!(%error, "Semantic index progress receiver closed");
        }
    };
    report(0, 0); // Acknowledge registration even if cancellation raced it.
    spawn_blocking_cancellable(
        task.cancel_token(),
        "semantic subtitle indexing",
        move |cancel| {
            fs::create_dir_all(&root).map_err(|error| {
                app_error(ErrorCode::SemanticIndexWriteFailed, error.to_string())
            })?;
            let mut guard = model_guard(cancel)?;
            build_file_indexes(
                &root,
                &subtitle_files(&subtitles),
                cancel,
                |text| {
                    if guard.is_none() {
                        *guard = Some(EmbeddingModel::load(&app)?);
                    }
                    let model = guard
                        .as_ref()
                        .ok_or_else(|| inference_error("Embedding model was not initialized"))?;
                    model.embed(text, false)
                },
                report,
            )
        },
    )
    .await
}

// Retrieval only consumes complete indexes. The caller chooses the current query
// after the indexing task settles, rather than passing an obsolete query into it.
#[tauri::command]
pub(crate) async fn search_subtitles_semantic(
    query: String,
    subtitles: Vec<SemanticSubtitle>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<Vec<SemanticMatch>> {
    let root = semantic_index_root(&state)?;
    tokio::task::spawn_blocking(move || {
        if query.trim().is_empty() || subtitles.is_empty() {
            return Ok(Vec::new());
        }
        let cancel = AtomicBool::new(false);
        let mut guard = model_guard(&cancel)?;
        if guard.is_none() {
            *guard = Some(EmbeddingModel::load(&app)?);
        }
        let model = guard
            .as_ref()
            .ok_or_else(|| inference_error("Embedding model was not initialized"))?;
        let query_embedding = model.embed(query.trim(), true)?;
        let mut matches = Vec::new();
        for file in subtitle_files(&subtitles) {
            let index = read_file_index(&root, &file).ok_or_else(|| {
                inference_error(
                    "Subtitle file index is missing or invalid; rebuild it before retrieval",
                )
            })?;
            for (subtitle, vector) in file.cues.iter().zip(index.embeddings) {
                if let Some(vector) = vector {
                    matches.push(SemanticMatch {
                        id: subtitle.id.clone(),
                        similarity: vector
                            .iter()
                            .zip(&query_embedding)
                            .map(|(a, b)| a * b)
                            .sum::<f32>()
                            .clamp(-1.0, 1.0),
                    });
                }
            }
        }
        Ok(matches)
    })
    .await
    .map_err(|error| {
        app_error(
            ErrorCode::BlockingTaskFailed,
            format!("Semantic retrieval task failed: {error}"),
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(source: &str, id: &str, text: &str) -> SemanticSubtitle {
        SemanticSubtitle {
            source: source.into(),
            id: id.into(),
            text: text.into(),
        }
    }

    fn root() -> PathBuf {
        let root = env::temp_dir().join(format!("linecut-semantic-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn vector() -> Vec<f32> {
        normalize_embedding(&vec![1.0; DIMENSIONS]).unwrap()
    }

    #[test]
    fn normalization_and_file_content_invalidation() {
        assert_eq!(normalize_embedding(&[3.0, 4.0]).unwrap(), vec![0.6, 0.8]);
        assert!(normalize_embedding(&[0.0, 0.0]).is_err());
        assert!(normalize_embedding(&[f32::NAN]).is_err());
        let a = [cue("A", "a", "original"), cue("A", "b", "text")];
        let renamed = [
            cue("reopened-A", "new-id", "original"),
            cue("reopened-A", "other-id", "text"),
        ];
        assert_eq!(subtitle_files(&a)[0].key, subtitle_files(&renamed)[0].key);
        let edited = [cue("A", "a", "edited"), cue("A", "b", "text")];
        assert_ne!(subtitle_files(&a)[0].key, subtitle_files(&edited)[0].key);
        let ambiguous = [cue("A", "a", "originalt"), cue("A", "b", "ext")];
        assert_ne!(subtitle_files(&a)[0].key, subtitle_files(&ambiguous)[0].key);
    }

    #[test]
    fn expanded_scope_reuses_a_and_only_indexes_b() {
        let root = root();
        let cancel = AtomicBool::new(false);
        let a = [cue("A", "a", "first"), cue("A", "b", "second")];
        build_file_indexes(
            &root,
            &subtitle_files(&a),
            &cancel,
            |_| Ok(vector()),
            |_, _| {},
        )
        .unwrap();
        let a_path = root.join(format!("{}.bin", subtitle_files(&a)[0].key));
        let before = fs::metadata(&a_path).unwrap().modified().unwrap();
        let scope = [
            cue("B", "B:a", "third"),
            cue("A", "A:a", "first"),
            cue("A", "A:b", "second"),
            cue("B", "B:b", ""),
        ];
        let mut embedded = Vec::new();
        let mut progress = Vec::new();
        build_file_indexes(
            &root,
            &subtitle_files(&scope),
            &cancel,
            |text| {
                embedded.push(text.to_string());
                Ok(vector())
            },
            |done, total| progress.push((done, total)),
        )
        .unwrap();
        assert_eq!(embedded, vec!["third"]);
        assert_eq!(progress, vec![(0, 2), (1, 2), (2, 2)]);
        assert_eq!(fs::metadata(&a_path).unwrap().modified().unwrap(), before);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        // Editing A invalidates its whole file, while B remains reusable.
        let mut edited = scope;
        edited[1].text = "edited".into();
        embedded.clear();
        build_file_indexes(
            &root,
            &subtitle_files(&edited),
            &cancel,
            |text| {
                embedded.push(text.to_string());
                Ok(vector())
            },
            |_, _| {},
        )
        .unwrap();
        assert_eq!(embedded, vec!["edited", "second"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancelled_file_is_not_persisted_completed_files_survive() {
        let root = root();
        let cancel = AtomicBool::new(false);
        let subtitles = [
            cue("A", "a", "first"),
            cue("B", "b", "second"),
            cue("B", "c", "third"),
        ];
        let files = subtitle_files(&subtitles);
        let result = build_file_indexes(
            &root,
            &files,
            &cancel,
            |text| {
                if text == "second" {
                    cancel.store(true, Ordering::SeqCst);
                }
                Ok(vector())
            },
            |_, _| {},
        );
        assert!(result.is_err());
        assert!(read_file_index(&root, &files[0]).is_some());
        assert!(read_file_index(&root, &files[1]).is_none());
        cancel.store(false, Ordering::SeqCst);
        let mut embedded = Vec::new();
        build_file_indexes(
            &root,
            &files,
            &cancel,
            |text| {
                embedded.push(text.to_string());
                Ok(vector())
            },
            |_, _| {},
        )
        .unwrap();
        assert_eq!(embedded, vec!["second", "third"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn file_index_rejects_stale_corrupt_and_invalid_vectors() {
        let root = root();
        let subtitles = [cue("A", "a", "first")];
        let files = subtitle_files(&subtitles);
        let file = &files[0];
        let mut index = SubtitleFileIndex {
            key: file.key.clone(),
            embeddings: vec![Some(vector())],
        };
        write_file_index(&root, &index).unwrap();
        assert!(read_file_index(&root, file).is_some());
        index.embeddings[0] = Some(vec![f32::NAN; DIMENSIONS]);
        write_file_index(&root, &index).unwrap();
        assert!(read_file_index(&root, file).is_none());
        index.embeddings[0] = None;
        write_file_index(&root, &index).unwrap();
        assert!(read_file_index(&root, file).is_none());
        index.key = "stale".into();
        fs::write(
            root.join(format!("{}.bin", file.key)),
            bincode::serialize(&index).unwrap(),
        )
        .unwrap();
        assert!(read_file_index(&root, file).is_none());
        fs::write(root.join(format!("{}.bin", file.key)), b"broken").unwrap();
        assert!(read_file_index(&root, file).is_none());
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
