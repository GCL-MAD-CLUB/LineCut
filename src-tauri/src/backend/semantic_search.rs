//! Local subtitle retrieval. Content-addressed indexes survive source changes,
//! but are invalidated by text, model revision, or embedding recipe changes.
use super::*;
use ort::{session::Session, value::Tensor};
use std::sync::{OnceLock, TryLockError};
use tauri::{ipc::Channel, path::BaseDirectory};
use tokenizers::{Tokenizer, TruncationParams};

const MAX_INDEX_BATCH: usize = 16;
const INDEX_TOKEN_BUDGET: usize = 1024;

const MODEL_REVISION: &str = "jina-v5-nano-retrieval-int8-ac5d898c-last-token-l2-file-v2";
const DIMENSIONS: usize = 768;
const MAX_TOKENS: usize = 8192;
static MODEL: OnceLock<Mutex<Option<EmbeddingModel>>> = OnceLock::new();
static QUERY_WAITERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
struct QueryPriority;
impl QueryPriority {
    fn new() -> Self {
        QUERY_WAITERS.fetch_add(1, Ordering::SeqCst);
        Self
    }
}
impl Drop for QueryPriority {
    fn drop(&mut self) {
        QUERY_WAITERS.fetch_sub(1, Ordering::SeqCst);
    }
}

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
    tokenizer: Arc<Tokenizer>,
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
        Ok(Self {
            session,
            tokenizer: Arc::new(tokenizer),
        })
    }

    fn encode(&self, text: &str, query: bool) -> AppResult<Vec<i64>> {
        encode_text(&self.tokenizer, text, query)
    }

    fn embed_tokens(&self, sequences: &[&[i64]], length: usize) -> AppResult<Vec<Vec<f32>>> {
        if sequences.is_empty() {
            return Ok(Vec::new());
        }
        let batch = sequences.len();
        let pad = i64::from(self.tokenizer.token_to_id("<|pad|>").unwrap_or(0));
        let mut ids = vec![pad; batch * length];
        let mut mask = vec![0i64; batch * length];
        for (row, sequence) in sequences.iter().enumerate() {
            if sequence.is_empty() || sequence.len() > length {
                return Err(inference_error("Invalid padded sequence length"));
            }
            ids[row * length..row * length + sequence.len()].copy_from_slice(sequence);
            mask[row * length..row * length + sequence.len()].fill(1);
        }
        let ids = Tensor::from_array(([batch, length], ids.into_boxed_slice()))
            .map_err(inference_error)?;
        let mask = Tensor::from_array(([batch, length], mask.into_boxed_slice()))
            .map_err(inference_error)?;
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
        if shape != [batch as i64, length as i64, DIMENSIONS as i64] {
            return Err(inference_error(format!(
                "Unexpected Jina output shape: {shape:?}"
            )));
        }
        sequences
            .iter()
            .enumerate()
            .map(|(row, sequence)| {
                // Right padding keeps real-token positions unchanged. Pool each
                // row's last real token, never the last padded tensor position.
                let offset = (row * length + sequence.len() - 1) * DIMENSIONS;
                normalize_embedding(&values[offset..offset + DIMENSIONS])
            })
            .collect()
    }

    fn embed(&self, text: &str, query: bool) -> AppResult<Vec<f32>> {
        let sequence = self.encode(text, query)?;
        self.embed_tokens(&[&sequence], sequence.len())?
            .pop()
            .ok_or_else(|| inference_error("Missing embedding"))
    }

    fn publish_batch(
        &self,
        batch: &[(usize, Vec<i64>)],
        length: usize,
        cancel: &AtomicBool,
        publish: &mut DocumentPublisher<'_>,
    ) -> AppResult<()> {
        publish_batch_with(
            batch,
            length,
            cancel,
            &mut |tokens, padded| self.embed_tokens(tokens, padded),
            publish,
        )
    }

    #[cfg(test)]
    fn embed_documents(
        &self,
        texts: &[&str],
        cancel: &AtomicBool,
        publish: &mut dyn FnMut(Vec<(usize, Vec<f32>)>) -> AppResult<()>,
    ) -> AppResult<()> {
        embed_documents_with(
            &self.tokenizer,
            texts,
            cancel,
            publish,
            |batch, length, publish| self.publish_batch(batch, length, cancel, publish),
        )
    }
}

fn encode_text(tokenizer: &Tokenizer, text: &str, query: bool) -> AppResult<Vec<i64>> {
    let prefix = if query { "Query: " } else { "Document: " };
    let encoding = tokenizer
        .encode(format!("{prefix}{text}"), true)
        .map_err(inference_error)?;
    if encoding.is_empty() {
        return Err(inference_error("Empty token sequence"));
    }
    Ok(encoding.get_ids().iter().map(|id| i64::from(*id)).collect())
}

type DocumentBatch = Vec<(usize, Vec<f32>)>;
type DocumentPublisher<'a> = dyn FnMut(DocumentBatch) -> AppResult<()> + 'a;

fn publish_batch_with(
    batch: &[(usize, Vec<i64>)],
    length: usize,
    cancel: &AtomicBool,
    infer: &mut dyn FnMut(&[&[i64]], usize) -> AppResult<Vec<Vec<f32>>>,
    publish: &mut DocumentPublisher<'_>,
) -> AppResult<()> {
    ensure_not_cancelled(cancel)?;
    let tokens = batch
        .iter()
        .map(|(_, ids)| ids.as_slice())
        .collect::<Vec<_>>();
    match infer(&tokens, length) {
        Ok(vectors) => {
            if vectors.len() != batch.len() {
                return Err(inference_error("Incomplete ONNX batch output"));
            }
            publish(
                batch
                    .iter()
                    .zip(vectors)
                    .map(|((index, _), vector)| (*index, vector))
                    .collect(),
            )
        }
        Err(error) if batch.len() > 1 => {
            tracing::warn!(rows = batch.len(), length, %error, "Retrying semantic inference with smaller batches");
            let middle = batch.len() / 2;
            publish_batch_with(&batch[..middle], length, cancel, infer, publish)?;
            publish_batch_with(&batch[middle..], length, cancel, infer, publish)
        }
        Err(_) if batch.len() == 1 && length != batch[0].1.len() => {
            publish_batch_with(batch, batch[0].1.len(), cancel, infer, publish)
        }
        Err(error) => Err(error),
    }
}

fn embed_documents_with(
    tokenizer: &Tokenizer,
    texts: &[&str],
    cancel: &AtomicBool,
    publish: &mut DocumentPublisher<'_>,
    mut infer: impl FnMut(&[(usize, Vec<i64>)], usize, &mut DocumentPublisher<'_>) -> AppResult<()>,
) -> AppResult<()> {
    let mut sequences = Vec::with_capacity(texts.len());
    for (index, text) in texts.iter().enumerate() {
        ensure_not_cancelled(cancel)?;
        sequences.push((index, encode_text(tokenizer, text, false)?));
    }
    sequences.sort_by_key(|(_, ids)| ids.len());
    let mut offset = 0;
    while offset < sequences.len() {
        ensure_not_cancelled(cancel)?;
        let length = padded_index_length(sequences[offset].1.len());
        let capacity = index_batch_capacity(length);
        let end = sequences[offset..]
            .iter()
            .take(capacity)
            .take_while(|(_, ids)| padded_index_length(ids.len()) == length)
            .count()
            + offset;
        let batch = &sequences[offset..end];
        let length = if batch.len() == 1 {
            batch[0].1.len()
        } else {
            length
        };
        infer(batch, length, publish)?;
        offset = end;
    }
    ensure_not_cancelled(cancel)
}

fn padded_index_length(length: usize) -> usize {
    if length <= 512 {
        length.max(16).next_power_of_two()
    } else {
        length
    }
}

fn index_batch_capacity(length: usize) -> usize {
    // Bound both token volume and quadratic attention memory. Long cues are
    // inferred alone, preserving the model's full 8192-token limit.
    (INDEX_TOKEN_BUDGET / length).clamp(1, MAX_INDEX_BATCH)
}

fn normalize_embedding(values: &[f32]) -> AppResult<Vec<f32>> {
    let norm = values.iter().map(|value| value * value).sum::<f32>().sqrt();
    if !norm.is_finite() || norm <= f32::EPSILON {
        return Err(inference_error("Invalid embedding norm"));
    }
    Ok(values.iter().map(|value| value / norm).collect())
}

mod index;
use index::{build_file_indexes, read_file_index, subtitle_files};

fn model_guard(
    cancel: &AtomicBool,
    indexing: bool,
) -> AppResult<std::sync::MutexGuard<'static, Option<EmbeddingModel>>> {
    let mutex = MODEL.get_or_init(|| Mutex::new(None));
    loop {
        ensure_not_cancelled(cancel)?;
        if indexing && QUERY_WAITERS.load(Ordering::SeqCst) > 0 {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }
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
    let mut last_progress = None;
    let mut last_sent = std::time::Instant::now();
    let mut report = move |completed, total| {
        if last_progress == Some((completed, total)) {
            return;
        }
        if completed != total
            && last_progress.is_some_and(|(_, old_total)| old_total == total)
            && last_sent.elapsed() < Duration::from_millis(100)
        {
            return;
        }
        last_progress = Some((completed, total));
        last_sent = std::time::Instant::now();
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
            // Cached files can be validated without acquiring the model lock.
            build_file_indexes(
                &root,
                &subtitle_files(&subtitles),
                cancel,
                |texts, publish| {
                    if texts.is_empty() {
                        return Ok(());
                    }
                    let tokenizer = {
                        let mut guard = model_guard(cancel, true)?;
                        if guard.is_none() {
                            *guard = Some(EmbeddingModel::load(&app)?);
                        }
                        Arc::clone(
                            &guard
                                .as_ref()
                                .ok_or_else(|| {
                                    inference_error("Embedding model was not initialized")
                                })?
                                .tokenizer,
                        )
                    };
                    // Tokenize outside the session lock and release it after
                    // every batch so another panel's ready query can run.
                    embed_documents_with(
                        &tokenizer,
                        texts,
                        cancel,
                        publish,
                        |batch, length, publish| {
                            let guard = model_guard(cancel, true)?;
                            let model = guard.as_ref().ok_or_else(|| {
                                inference_error("Embedding model was not initialized")
                            })?;
                            model.publish_batch(batch, length, cancel, publish)
                        },
                    )
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
        let query_embedding = {
            let _priority = QueryPriority::new();
            let mut guard = model_guard(&cancel, false)?;
            if guard.is_none() {
                *guard = Some(EmbeddingModel::load(&app)?);
            }
            let model = guard
                .as_ref()
                .ok_or_else(|| inference_error("Embedding model was not initialized"))?;
            model.embed(query.trim(), true)?
        };
        let mut matches = Vec::new();
        for file in subtitle_files(&subtitles) {
            let index = read_file_index(&root, &file).ok_or_else(|| {
                inference_error(
                    "Subtitle file index is missing or invalid; rebuild it before retrieval",
                )
            })?;
            for (subtitle, vector) in file.cues.iter().zip(&index.embeddings) {
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
    use super::index::{write_file_index, SubtitleFileIndex};
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
            |texts, publish| {
                publish(
                    texts
                        .iter()
                        .enumerate()
                        .map(|(i, _)| (i, vector()))
                        .collect(),
                )
            },
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
            |texts, publish| {
                for (i, text) in texts.iter().enumerate() {
                    embedded.push(text.to_string());
                    publish(vec![(i, vector())])?;
                }
                Ok(())
            },
            |done, total| progress.push((done, total)),
        )
        .unwrap();
        assert_eq!(embedded, vec!["third"]);
        assert_eq!(progress, vec![(0, 2), (1, 2), (2, 2)]);
        assert_eq!(fs::metadata(&a_path).unwrap().modified().unwrap(), before);
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "bin"))
                .count(),
            2
        );
        // Editing A invalidates its whole file, while B remains reusable.
        let mut edited = scope;
        edited[1].text = "edited".into();
        embedded.clear();
        build_file_indexes(
            &root,
            &subtitle_files(&edited),
            &cancel,
            |texts, publish| {
                for (i, text) in texts.iter().enumerate() {
                    embedded.push(text.to_string());
                    publish(vec![(i, vector())])?;
                }
                Ok(())
            },
            |_, _| {},
        )
        .unwrap();
        assert_eq!(embedded, vec!["edited"]);
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
            |texts, publish| {
                for (i, text) in texts.iter().enumerate() {
                    ensure_not_cancelled(&cancel)?;
                    if *text == "second" {
                        cancel.store(true, Ordering::SeqCst);
                    }
                    publish(vec![(i, vector())])?;
                }
                ensure_not_cancelled(&cancel)
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
            |texts, publish| {
                for (i, text) in texts.iter().enumerate() {
                    embedded.push(text.to_string());
                    publish(vec![(i, vector())])?;
                }
                Ok(())
            },
            |_, _| {},
        )
        .unwrap();
        assert_eq!(embedded, vec!["third"]);
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
    fn batch_failures_split_without_losing_rows_and_honor_cancellation() {
        let batch = (0..7).map(|i| (i, vec![i as i64])).collect::<Vec<_>>();
        let cancel = AtomicBool::new(false);
        let mut published = Vec::new();
        publish_batch_with(
            &batch,
            16,
            &cancel,
            &mut |tokens, _| {
                if tokens.len() > 2 {
                    return Err(inference_error("simulated device memory limit"));
                }
                Ok(tokens.iter().map(|_| vector()).collect())
            },
            &mut |vectors| {
                published.extend(vectors.into_iter().map(|(index, _)| index));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(published, (0..7).collect::<Vec<_>>());
        let mut emitted = 0;
        let error = publish_batch_with(
            &batch,
            16,
            &cancel,
            &mut |tokens, _| {
                if tokens.len() > 2 {
                    return Err(inference_error("simulated device memory limit"));
                }
                Ok(tokens.iter().map(|_| vector()).collect())
            },
            &mut |vectors| {
                emitted += vectors.len();
                cancel.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.is(ErrorCode::TaskCancelled));
        assert!(emitted > 0 && emitted < batch.len());
    }

    #[test]
    fn pending_queries_get_priority_over_background_model_acquisition() {
        let priority = QueryPriority::new();
        let (send, receive) = std::sync::mpsc::channel();
        let background = std::thread::spawn(move || {
            let guard = model_guard(&AtomicBool::new(false), true).unwrap();
            drop(guard);
            send.send(()).unwrap();
        });
        assert!(receive.recv_timeout(Duration::from_millis(40)).is_err());
        let query = model_guard(&AtomicBool::new(false), false).unwrap();
        drop(query);
        drop(priority);
        receive.recv_timeout(Duration::from_secs(2)).unwrap();
        background.join().unwrap();
        let _priority = QueryPriority::new();
        assert!(model_guard(&AtomicBool::new(true), true)
            .err()
            .unwrap()
            .is(ErrorCode::TaskCancelled));
    }

    #[test]
    fn index_batches_bound_padding_and_long_cue_memory() {
        assert_eq!(padded_index_length(10), 16);
        assert_eq!(padded_index_length(33), 64);
        for length in [16, 32, 64, 128, 256, 512, 513, 1024, 8192] {
            let batch = index_batch_capacity(length);
            assert!((1..=MAX_INDEX_BATCH).contains(&batch));
            if length <= INDEX_TOKEN_BUDGET {
                assert!(batch * length <= INDEX_TOKEN_BUDGET);
            }
        }
        assert_eq!(padded_index_length(8192), 8192);
        assert_eq!(index_batch_capacity(8192), 1);
    }

    #[test]
    #[ignore = "requires packaged assets; compares production indexing to the original scalar path"]
    fn packaged_int8_optimized_indexing_smoke() {
        use std::time::Instant;
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let runtime = resources.join("transnetv2");
        let current = env::var_os("PATH").unwrap_or_default();
        env::set_var(
            "PATH",
            env::join_paths(std::iter::once(runtime.clone()).chain(env::split_paths(&current)))
                .unwrap(),
        );
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
        let phrases = [
            "我们明天出发。",
            "请准备好行李，我们明天一早出发去海边，晚上回来。",
            "明天一起去海边欣赏风景，请准备行李和相机，经过小镇后晚上回家。",
            "日本語の字幕も同じ検索で使います。",
            "Which planet is known as the Red Planet?",
            "Mars is the Red Planet. We are traveling tomorrow and will return in the evening.",
        ];
        for automatic in [true, false] {
            let (session, provider) = if automatic {
                storyboard::create_model_session(&directory.join("model_quantized.onnx")).unwrap()
            } else {
                (
                    storyboard::create_cpu_model_session(&directory.join("model_quantized.onnx"))
                        .unwrap(),
                    "CPU".to_string(),
                )
            };
            let model = EmbeddingModel::from_session(session, &directory).unwrap();
            let count = if automatic { 96 } else { 24 };
            let subtitles = (0..count)
                .map(|i| {
                    cue(
                        "A",
                        &i.to_string(),
                        &format!("{} {i}", phrases[i % phrases.len()]),
                    )
                })
                .collect::<Vec<_>>();
            let root = root();
            model.embed(phrases[0], false).unwrap();
            let started = Instant::now();
            let references = subtitles
                .iter()
                .map(|cue| model.embed(&cue.text, false).unwrap())
                .collect::<Vec<_>>();
            let scalar_ms = started.elapsed().as_secs_f64() * 1000.0;
            let started = Instant::now();
            build_file_indexes(
                &root,
                &subtitle_files(&subtitles),
                &AtomicBool::new(false),
                |texts, publish| model.embed_documents(texts, &AtomicBool::new(false), publish),
                |_, _| {},
            )
            .unwrap();
            let optimized_ms = started.elapsed().as_secs_f64() * 1000.0;
            let files = subtitle_files(&subtitles);
            let index = read_file_index(&root, &files[0]).unwrap();
            let minimum = index
                .embeddings
                .iter()
                .zip(&references)
                .map(|(actual, expected)| {
                    actual
                        .as_ref()
                        .unwrap()
                        .iter()
                        .zip(expected)
                        .map(|(a, b)| a * b)
                        .sum::<f32>()
                })
                .fold(1.0, f32::min);
            assert!(
                minimum > 0.999,
                "{provider}: batching changed embeddings: cosine={minimum}"
            );
            let started = Instant::now();
            build_file_indexes(
                &root,
                &files,
                &AtomicBool::new(false),
                |_, _| panic!("A must remain cached in A+B"),
                |_, _| {},
            )
            .unwrap();
            let cached_ms = started.elapsed().as_secs_f64() * 1000.0;
            eprintln!("OPTIMIZED {provider} unique_cues={count} scalar_ms={scalar_ms:.2} optimized_ms={optimized_ms:.2} speedup={:.2} cached_ms={cached_ms:.2} minimum_cosine={minimum:.6}", scalar_ms/optimized_ms);
            // Validate actual reuse across A+B and after editing one cue.
            let mut scope = subtitles;
            scope.push(cue("B", "b", "One new document in the additional scope."));
            let mut computed = 0;
            build_file_indexes(
                &root,
                &subtitle_files(&scope),
                &AtomicBool::new(false),
                |texts, publish| {
                    computed += texts.len();
                    model.embed_documents(texts, &AtomicBool::new(false), publish)
                },
                |_, _| {},
            )
            .unwrap();
            assert_eq!(computed, 1);
            scope[0].text = "Edited document only.".into();
            computed = 0;
            build_file_indexes(
                &root,
                &subtitle_files(&scope),
                &AtomicBool::new(false),
                |texts, publish| {
                    computed += texts.len();
                    model.embed_documents(texts, &AtomicBool::new(false), publish)
                },
                |_, _| {},
            )
            .unwrap();
            assert_eq!(computed, 1);
            let tokens = model
                .encode(&"word ".repeat(MAX_TOKENS * 2), false)
                .unwrap();
            assert_eq!(tokens.len(), MAX_TOKENS);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    #[ignore = "requires packaged semantic and runtime assets; manual batching benchmark"]
    fn packaged_int8_batch_probe() {
        use std::time::Instant;
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let runtime = resources.join("transnetv2");
        let current = env::var_os("PATH").unwrap_or_default();
        env::set_var(
            "PATH",
            env::join_paths(std::iter::once(runtime.clone()).chain(env::split_paths(&current)))
                .unwrap(),
        );
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
        let texts = ["Tomorrow we travel.", "We will leave early tomorrow to visit the seaside and return home in the evening.", "Please bring your camera and luggage. Tomorrow we will travel together through several towns, enjoy the scenery on the coast, and come home after sunset."];
        for automatic in [true, false] {
            let (session, provider) = if automatic {
                storyboard::create_model_session(&directory.join("model_quantized.onnx")).unwrap()
            } else {
                (
                    storyboard::create_cpu_model_session(&directory.join("model_quantized.onnx"))
                        .unwrap(),
                    "CPU".to_string(),
                )
            };
            let model = EmbeddingModel::from_session(session, &directory).unwrap();
            let encoded = texts
                .iter()
                .map(|text| model.encode(text, false).unwrap())
                .collect::<Vec<_>>();
            let reference = texts
                .iter()
                .map(|text| model.embed(text, false).unwrap())
                .collect::<Vec<_>>();
            for batch in [1, 4, 8, 16, 32] {
                let sequences = encoded
                    .iter()
                    .cycle()
                    .take(batch)
                    .map(Vec::as_slice)
                    .collect::<Vec<_>>();
                let length = sequences.iter().map(|ids| ids.len()).max().unwrap();
                for padded in [length, padded_index_length(length)] {
                    let vectors = model.embed_tokens(&sequences, padded).unwrap();
                    let minimum = vectors
                        .iter()
                        .enumerate()
                        .map(|(i, vector)| {
                            vector
                                .iter()
                                .zip(&reference[i % texts.len()])
                                .map(|(a, b)| a * b)
                                .sum::<f32>()
                        })
                        .fold(1.0, f32::min);
                    assert!(minimum > 0.99, "{provider} batch={batch} cosine={minimum}");
                    let started = Instant::now();
                    for _ in 0..3 {
                        model.embed_tokens(&sequences, padded).unwrap();
                    }
                    eprintln!("BATCH {provider} rows={batch} tokens={padded} mean_ms={:.2} per_cue_ms={:.2} cosine={minimum:.6}", started.elapsed().as_secs_f64()*1000.0/3.0, started.elapsed().as_secs_f64()*1000.0/3.0/batch as f64);
                }
            }
        }
    }

    #[test]
    #[ignore = "manual performance probe; requires packaged semantic and ONNX Runtime assets"]
    fn packaged_int8_indexing_profile() {
        use ort::session::builder::GraphOptimizationLevel;
        use std::time::Instant;

        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let runtime = resources.join("transnetv2");
        let current = env::var_os("PATH").unwrap_or_default();
        env::set_var(
            "PATH",
            env::join_paths(std::iter::once(runtime.clone()).chain(env::split_paths(&current)))
                .unwrap(),
        );
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
        let texts = [
            "我们明天出发。",
            "请准备好行李，我们明天一早出发去海边，晚上回来。",
            "我们明天一早出发去海边，请准备好行李和相机，途中会经过几座小镇，大家可以一起欣赏风景，晚上再回家。",
        ];
        for kind in ["CPU-8", "CPU-1", "automatic"] {
            let started = Instant::now();
            let (session, provider) = match kind {
                "CPU-8" => (
                    storyboard::create_cpu_model_session(&model_path).unwrap(),
                    kind.to_string(),
                ),
                "CPU-1" => (
                    Session::builder()
                        .unwrap()
                        .with_optimization_level(GraphOptimizationLevel::Level3)
                        .unwrap()
                        .with_intra_threads(1)
                        .unwrap()
                        .commit_from_file(&model_path)
                        .unwrap(),
                    kind.to_string(),
                ),
                _ => storyboard::create_model_session(&model_path).unwrap(),
            };
            eprintln!(
                "PROFILE {provider} session_load_ms={:.2}",
                started.elapsed().as_secs_f64() * 1000.0
            );
            let started = Instant::now();
            let model = EmbeddingModel::from_session(session, &directory).unwrap();
            eprintln!(
                "PROFILE {provider} tokenizer_load_ms={:.2}",
                started.elapsed().as_secs_f64() * 1000.0
            );
            for text in texts {
                let tokens = model
                    .tokenizer
                    .encode(format!("Document: {text}"), true)
                    .unwrap()
                    .len();
                let started = Instant::now();
                for _ in 0..20 {
                    model
                        .tokenizer
                        .encode(format!("Document: {text}"), true)
                        .unwrap();
                }
                let tokenize_ms = started.elapsed().as_secs_f64() * 1000.0 / 20.0;
                let started = Instant::now();
                model.embed(text, false).unwrap();
                let first_ms = started.elapsed().as_secs_f64() * 1000.0;
                let started = Instant::now();
                for _ in 0..5 {
                    model.embed(text, false).unwrap();
                }
                eprintln!("PROFILE {provider} tokens={tokens} tokenize_ms={tokenize_ms:.3} first_ms={first_ms:.2} warm_mean_ms={:.2}", started.elapsed().as_secs_f64() * 1000.0 / 5.0);
            }
            let started = Instant::now();
            for text in texts.iter().cycle().take(9) {
                model.embed(text, false).unwrap();
            }
            eprintln!(
                "PROFILE {provider} alternating_lengths_mean_ms={:.2}",
                started.elapsed().as_secs_f64() * 1000.0 / 9.0
            );
        }

        // A separate trace avoids profiling overhead in the timing runs above.
        let root = root();
        let session = Session::builder()
            .unwrap()
            .with_parallel_execution(false)
            .unwrap()
            .with_memory_pattern(false)
            .unwrap()
            .with_execution_providers([
                ort::execution_providers::DirectMLExecutionProvider::default()
                    .with_device_id(0)
                    .build()
                    .error_on_failure(),
            ])
            .unwrap()
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .unwrap()
            .with_intra_threads(1)
            .unwrap()
            .with_profiling(root.join("ort-profile"))
            .unwrap()
            .commit_from_file(&model_path)
            .unwrap();
        let model = EmbeddingModel::from_session(session, &directory).unwrap();
        model.embed(texts[1], false).unwrap();
        let profile_path = model.session.end_profiling().unwrap();
        let events: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(&profile_path).unwrap()).unwrap();
        let mut providers = std::collections::BTreeMap::<String, (usize, u64)>::new();
        let mut cpu_ops = std::collections::BTreeMap::<String, usize>::new();
        for event in events {
            if let Some(provider) = event["args"]["provider"].as_str() {
                let entry = providers.entry(provider.to_string()).or_default();
                entry.0 += 1;
                entry.1 += event["dur"].as_u64().unwrap_or_default();
                if provider == "CPUExecutionProvider" {
                    *cpu_ops
                        .entry(
                            event["args"]["op_name"]
                                .as_str()
                                .unwrap_or("unknown")
                                .to_string(),
                        )
                        .or_default() += 1;
                }
            }
        }
        eprintln!("PROFILE DirectML node_counts_and_total_us={providers:?} cpu_ops={cpu_ops:?}");
        drop(model);

        let subtitles = (0..1000)
            .map(|id| cue("A", &id.to_string(), texts[1]))
            .collect::<Vec<_>>();
        let started = Instant::now();
        let files = subtitle_files(&subtitles);
        eprintln!(
            "PROFILE 1000_cues_hash_ms={:.2}",
            started.elapsed().as_secs_f64() * 1000.0
        );
        let index = SubtitleFileIndex {
            key: files[0].key.clone(),
            embeddings: vec![Some(vector()); 1000],
        };
        let started = Instant::now();
        write_file_index(&root, &index).unwrap();
        eprintln!(
            "PROFILE 1000_cues_cache_write_ms={:.2}",
            started.elapsed().as_secs_f64() * 1000.0
        );
        let started = Instant::now();
        assert!(read_file_index(&root, &files[0]).is_some());
        eprintln!(
            "PROFILE 1000_cues_cache_read_validate_ms={:.2}",
            started.elapsed().as_secs_f64() * 1000.0
        );
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
