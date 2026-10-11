//! File-granularity indexes, bounded warm cache, and resumable batch checkpoints.
use super::*;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Seek, Write};
use std::time::SystemTime;

const MEMORY_BYTES: usize = 32 * 1024 * 1024;
const MAX_REUSE_DOCUMENTS: usize = 8192;
const CHECKPOINT_MAGIC: &[u8; 8] = b"LCSI0001";

pub(super) struct SubtitleFile<'a> {
    pub(super) key: String,
    source_key: String,
    hashes: Vec<[u8; 32]>,
    pub(super) cues: Vec<&'a SemanticSubtitle>,
}

fn text_hash(text: &str) -> [u8; 32] {
    Sha256::digest(text.as_bytes()).into()
}

pub(super) fn subtitle_files(subtitles: &[SemanticSubtitle]) -> Vec<SubtitleFile<'_>> {
    let mut sources = std::collections::BTreeMap::<&str, Vec<&SemanticSubtitle>>::new();
    for subtitle in subtitles {
        sources.entry(&subtitle.source).or_default().push(subtitle);
    }
    sources
        .into_iter()
        .map(|(source, cues)| {
            let mut hash = Sha256::new();
            hash.update(MODEL_REVISION.as_bytes());
            hash.update((cues.len() as u64).to_le_bytes());
            for cue in &cues {
                hash.update((cue.text.len() as u64).to_le_bytes());
                hash.update(cue.text.as_bytes());
            }
            SubtitleFile {
                key: format!("{:x}", hash.finalize()),
                source_key: format!("{:x}", Sha256::digest(source.as_bytes())),
                hashes: cues.iter().map(|cue| text_hash(&cue.text)).collect(),
                cues,
            }
        })
        .collect()
}

#[derive(Serialize, Deserialize)]
pub(super) struct SubtitleFileIndex {
    pub(super) key: String,
    pub(super) embeddings: Vec<Option<Vec<f32>>>,
}

fn valid_vector(vector: &[f32]) -> bool {
    let norm = vector.iter().map(|value| value * value).sum::<f32>();
    vector.len() == DIMENSIONS && norm.is_finite() && (norm - 1.0).abs() < 0.001
}

struct WarmIndex {
    path: PathBuf,
    stamp: (u64, SystemTime),
    index: Arc<SubtitleFileIndex>,
    bytes: usize,
}
#[derive(Default)]
struct WarmIndexes {
    entries: VecDeque<WarmIndex>,
    bytes: usize,
}
static WARM: OnceLock<Mutex<WarmIndexes>> = OnceLock::new();
// A different window can request an overlapping scope. Serialize cache writers
// independently of the model lock, then recheck complete files after waiting.
static BUILD: Mutex<()> = Mutex::new(());

fn read_index(root: &Path, key: &str) -> Option<Arc<SubtitleFileIndex>> {
    if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let path = root.join(format!("{key}.bin"));
    let metadata = fs::metadata(&path).ok()?;
    let stamp = (metadata.len(), metadata.modified().ok()?);
    let cache = WARM.get_or_init(Default::default);
    if let Ok(mut cache) = cache.lock() {
        if let Some(position) = cache.entries.iter().position(|entry| entry.path == path) {
            let entry = cache.entries.remove(position)?;
            cache.bytes -= entry.bytes;
            if entry.stamp == stamp {
                let index = Arc::clone(&entry.index);
                cache.bytes += entry.bytes;
                cache.entries.push_back(entry);
                return Some(index);
            }
        }
    }
    let bytes = fs::read(&path).ok()?;
    let index: SubtitleFileIndex = match bincode::deserialize(&bytes) {
        Ok(index) => index,
        Err(error) => {
            tracing::warn!(%error, "Invalid semantic file index will be rebuilt");
            return None;
        }
    };
    if index.key != key
        || !index
            .embeddings
            .iter()
            .flatten()
            .all(|vector| valid_vector(vector))
    {
        return None;
    }
    let footprint = index.key.capacity()
        + index.embeddings.capacity() * std::mem::size_of::<Option<Vec<f32>>>()
        + index
            .embeddings
            .iter()
            .flatten()
            .map(|vector| vector.capacity() * std::mem::size_of::<f32>())
            .sum::<usize>();
    let index = Arc::new(index);
    if footprint <= MEMORY_BYTES {
        if let Ok(mut cache) = cache.lock() {
            // A concurrent reader can have inserted the same file while we read it.
            if let Some(position) = cache.entries.iter().position(|entry| entry.path == path) {
                if let Some(old) = cache.entries.remove(position) {
                    cache.bytes -= old.bytes;
                }
            }
            while cache.bytes + footprint > MEMORY_BYTES {
                if let Some(old) = cache.entries.pop_front() {
                    cache.bytes -= old.bytes;
                } else {
                    break;
                }
            }
            cache.bytes += footprint;
            cache.entries.push_back(WarmIndex {
                path,
                stamp,
                index: Arc::clone(&index),
                bytes: footprint,
            });
        }
    }
    Some(index)
}

pub(super) fn read_file_index(
    root: &Path,
    file: &SubtitleFile<'_>,
) -> Option<Arc<SubtitleFileIndex>> {
    let index = read_index(root, &file.key)?;
    (index.embeddings.len() == file.cues.len()
        && index
            .embeddings
            .iter()
            .zip(&file.cues)
            .all(|(vector, cue)| vector.is_none() == cue.text.trim().is_empty()))
    .then_some(index)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    if let Err(error) = fs::write(&temporary, bytes).and_then(|_| fs::rename(&temporary, path)) {
        let _ = fs::remove_file(&temporary);
        return Err(app_error(
            ErrorCode::SemanticIndexWriteFailed,
            format!("Cannot write semantic index {}: {error}", path.display()),
        ));
    }
    Ok(())
}

pub(super) fn write_file_index(root: &Path, index: &SubtitleFileIndex) -> AppResult<()> {
    let path = root.join(format!("{}.bin", index.key));
    atomic_write(&path, &bincode::serialize(index).map_err(inference_error)?)?;
    if let Some(cache) = WARM.get() {
        if let Ok(mut cache) = cache.lock() {
            if let Some(position) = cache.entries.iter().position(|entry| entry.path == path) {
                if let Some(old) = cache.entries.remove(position) {
                    cache.bytes -= old.bytes;
                }
            }
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct SourceSnapshot {
    key: String,
    hashes: Vec<[u8; 32]>,
}
fn snapshot_path(root: &Path, file: &SubtitleFile<'_>) -> PathBuf {
    root.join("sources")
        .join(format!("{}.bin", file.source_key))
}
fn read_snapshot(root: &Path, file: &SubtitleFile<'_>) -> Option<SourceSnapshot> {
    bincode::deserialize(&fs::read(snapshot_path(root, file)).ok()?).ok()
}
fn save_snapshot(root: &Path, file: &SubtitleFile<'_>) -> AppResult<()> {
    if read_snapshot(root, file).is_some_and(|snapshot| snapshot.key == file.key) {
        return Ok(());
    }
    fs::create_dir_all(root.join("sources")).map_err(index_io_error)?;
    atomic_write(
        &snapshot_path(root, file),
        &bincode::serialize(&SourceSnapshot {
            key: file.key.clone(),
            hashes: file.hashes.clone(),
        })
        .map_err(inference_error)?,
    )
}
fn index_io_error(error: std::io::Error) -> AppError {
    app_error(ErrorCode::SemanticIndexWriteFailed, error.to_string())
}

struct Checkpoint {
    path: PathBuf,
    writer: fs::File,
}
impl Checkpoint {
    fn open(root: &Path, file: &SubtitleFile<'_>) -> AppResult<(Self, Vec<Option<Vec<f32>>>)> {
        let path = root.join(format!("{}.partial", file.key));
        let mut writer = fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .map_err(index_io_error)?;
        let mut embeddings = vec![None; file.cues.len()];
        let mut header = Vec::new();
        header.extend_from_slice(CHECKPOINT_MAGIC);
        header.extend_from_slice(&(file.cues.len() as u64).to_le_bytes());
        header.extend_from_slice(file.key.as_bytes());
        let mut actual = vec![0; header.len()];
        let mut valid_end = 0;
        if writer.read_exact(&mut actual).is_ok() && actual == header {
            valid_end = header.len() as u64;
            loop {
                let mut size = [0u8; 8];
                if writer.read_exact(&mut size).is_err() {
                    break;
                }
                let size = u64::from_le_bytes(size);
                if size > 4 * 1024 * 1024 {
                    break;
                }
                let mut checksum = [0u8; 32];
                let mut payload = vec![0; size as usize];
                if writer
                    .read_exact(&mut checksum)
                    .and_then(|_| writer.read_exact(&mut payload))
                    .is_err()
                    || text_hash_bytes(&payload) != checksum
                {
                    break;
                }
                let Ok(batch) = bincode::deserialize::<Vec<(usize, Vec<f32>)>>(&payload) else {
                    break;
                };
                if !batch.iter().all(|(position, vector)| {
                    *position < file.cues.len()
                        && !file.cues[*position].text.trim().is_empty()
                        && valid_vector(vector)
                }) {
                    break;
                }
                for (position, vector) in batch {
                    embeddings[position] = Some(vector);
                }
                valid_end = writer.stream_position().map_err(index_io_error)?;
            }
        }
        writer.set_len(valid_end).map_err(index_io_error)?;
        writer
            .seek(std::io::SeekFrom::End(0))
            .map_err(index_io_error)?;
        if valid_end == 0 {
            writer.write_all(&header).map_err(index_io_error)?;
        }
        Ok((Self { path, writer }, embeddings))
    }
    fn append(&mut self, batch: &[(usize, Vec<f32>)]) -> AppResult<()> {
        let payload = bincode::serialize(batch).map_err(inference_error)?;
        self.writer
            .write_all(&(payload.len() as u64).to_le_bytes())
            .and_then(|_| self.writer.write_all(&text_hash_bytes(&payload)))
            .and_then(|_| self.writer.write_all(&payload))
            .and_then(|_| self.writer.flush())
            .map_err(index_io_error)
    }
    fn remove(self) {
        drop(self.writer);
        if let Err(error) = fs::remove_file(&self.path) {
            tracing::debug!(%error, "Could not remove completed semantic checkpoint");
        }
    }
}
fn text_hash_bytes(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub(super) fn build_file_indexes(
    root: &Path,
    files: &[SubtitleFile<'_>],
    cancel: &AtomicBool,
    mut embed: impl FnMut(
        &[&str],
        &mut dyn FnMut(Vec<(usize, Vec<f32>)>) -> AppResult<()>,
    ) -> AppResult<()>,
    mut report: impl FnMut(usize, usize),
) -> AppResult<()> {
    let _writer = loop {
        ensure_not_cancelled(cancel)?;
        match BUILD.try_lock() {
            Ok(guard) => break guard,
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => return Err(inference_error(error)),
        }
    };
    let started = std::time::Instant::now();
    let mut computed_documents = 0;
    let mut seen = HashSet::new();
    let mut memo = HashMap::<[u8; 32], Vec<f32>>::new();
    let mut pending = Vec::new();
    for file in files {
        ensure_not_cancelled(cancel)?;
        if !seen.insert(&file.key) {
            continue;
        }
        if let Some(index) = read_file_index(root, file) {
            for (hash, vector) in file.hashes.iter().zip(&index.embeddings) {
                if memo.len() < MAX_REUSE_DOCUMENTS {
                    if let Some(vector) = vector {
                        memo.entry(*hash).or_insert_with(|| vector.clone());
                    }
                }
            }
            save_snapshot(root, file)?;
        } else {
            pending.push(file);
        }
    }
    let total = pending.iter().map(|file| file.cues.len()).sum();
    let mut completed = 0;
    report(completed, total);
    for file in pending {
        ensure_not_cancelled(cancel)?;
        let (mut checkpoint, mut embeddings) = Checkpoint::open(root, file)?;
        // Map hashes to positions rather than cloning a bounded prefix of the
        // previous file: editing a large file must also reuse its final cues.
        let previous = read_snapshot(root, file).and_then(|snapshot| {
            let index = read_index(root, &snapshot.key)?;
            (index.embeddings.len() == snapshot.hashes.len()).then_some((snapshot, index))
        });
        let previous_positions = previous
            .as_ref()
            .map(|(snapshot, index)| {
                snapshot
                    .hashes
                    .iter()
                    .enumerate()
                    .filter(|(position, _)| index.embeddings[*position].is_some())
                    .map(|(position, hash)| (*hash, position))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        let mut recovered_positions = file
            .hashes
            .iter()
            .enumerate()
            .filter(|(position, _)| embeddings[*position].is_some())
            .map(|(position, hash)| (*hash, position))
            .collect::<HashMap<_, _>>();
        let mut texts = Vec::new();
        let mut positions = Vec::<Vec<usize>>::new();
        let mut unique = HashMap::<&str, usize>::new();
        for (position, cue) in file.cues.iter().enumerate() {
            if embeddings[position].is_none() {
                let hash = &file.hashes[position];
                embeddings[position] = recovered_positions
                    .get(hash)
                    .and_then(|previous| embeddings[*previous].clone())
                    .or_else(|| {
                        previous_positions
                            .get(hash)
                            .and_then(|position| previous.as_ref()?.1.embeddings[*position].clone())
                    })
                    .or_else(|| memo.get(hash).cloned());
            }
            if embeddings[position].is_some() {
                recovered_positions.insert(file.hashes[position], position);
            }
            if cue.text.trim().is_empty() || embeddings[position].is_some() {
                completed += 1;
                continue;
            }
            if let Some(index) = unique.get(cue.text.as_str()) {
                positions[*index].push(position);
            } else {
                unique.insert(&cue.text, texts.len());
                texts.push(cue.text.as_str());
                positions.push(vec![position]);
            }
        }
        drop(previous);
        computed_documents += texts.len();
        report(completed, total);
        embed(&texts, &mut |batch| {
            let mut saved = Vec::with_capacity(batch.len());
            for (index, vector) in batch {
                let Some(rows) = positions.get(index) else {
                    return Err(inference_error("Invalid embedding document position"));
                };
                if !valid_vector(&vector) {
                    return Err(inference_error("Invalid document embedding"));
                }
                saved.push((rows[0], vector.clone()));
                if memo.len() < MAX_REUSE_DOCUMENTS {
                    memo.insert(file.hashes[rows[0]], vector.clone());
                }
                for position in rows {
                    embeddings[*position] = Some(vector.clone());
                    completed += 1;
                }
            }
            // Append only new vectors: checkpoint traffic is linear in file size.
            checkpoint.append(&saved)?;
            report(completed, total);
            Ok(())
        })?;
        ensure_not_cancelled(cancel)?;
        if file
            .cues
            .iter()
            .zip(&embeddings)
            .any(|(cue, vector)| !cue.text.trim().is_empty() && vector.is_none())
        {
            return Err(inference_error("Incomplete semantic document batch"));
        }
        write_file_index(
            root,
            &SubtitleFileIndex {
                key: file.key.clone(),
                embeddings,
            },
        )?;
        save_snapshot(root, file)?;
        checkpoint.remove();
    }
    tracing::info!(
        files = files.len(),
        missing_file_cues = total,
        computed_documents,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "Subtitle semantic indexes ready"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cue(id: &str, text: &str) -> SemanticSubtitle {
        SemanticSubtitle {
            source: "A".into(),
            id: id.into(),
            text: text.into(),
        }
    }
    fn vector() -> Vec<f32> {
        normalize_embedding(&vec![1.0; DIMENSIONS]).unwrap()
    }
    struct Temporary(PathBuf);
    impl Temporary {
        fn new() -> Self {
            let path = env::temp_dir().join(format!("semantic-cache-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temporary {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn duplicate_documents_and_out_of_order_batches_restore_original_rows() {
        let root = Temporary::new();
        let subtitles = [
            cue("1", "duplicate"),
            cue("2", "different"),
            cue("3", "duplicate"),
            cue("4", ""),
        ];
        let files = subtitle_files(&subtitles);
        let mut calls = Vec::new();
        build_file_indexes(
            &root.0,
            &files,
            &AtomicBool::new(false),
            |texts, publish| {
                calls.extend(texts.iter().map(|text| text.to_string()));
                publish(vec![(1, vector())])?;
                publish(vec![(0, vector())])
            },
            |_, _| {},
        )
        .unwrap();
        assert_eq!(calls, ["duplicate", "different"]);
        let index = read_file_index(&root.0, &files[0]).unwrap();
        assert_eq!(index.embeddings[0], index.embeddings[2]);
        assert!(index.embeddings[1].is_some());
        assert!(index.embeddings[3].is_none());
    }

    #[test]
    fn checkpoint_recovers_completed_batch_and_ignores_torn_tail() {
        let root = Temporary::new();
        let subtitles = [cue("1", "first"), cue("2", "second"), cue("3", "third")];
        let files = subtitle_files(&subtitles);
        let cancel = AtomicBool::new(false);
        let error = build_file_indexes(
            &root.0,
            &files,
            &cancel,
            |_, publish| {
                publish(vec![(0, vector())])?;
                cancel.store(true, Ordering::SeqCst);
                ensure_not_cancelled(&cancel)
            },
            |_, _| {},
        )
        .unwrap_err();
        assert!(error.is(ErrorCode::TaskCancelled));
        assert!(read_file_index(&root.0, &files[0]).is_none());
        let partial = root.0.join(format!("{}.partial", files[0].key));
        fs::OpenOptions::new()
            .append(true)
            .open(&partial)
            .unwrap()
            .write_all(&[7, 2, 9])
            .unwrap();
        cancel.store(false, Ordering::SeqCst);
        let mut computed = Vec::new();
        build_file_indexes(
            &root.0,
            &files,
            &cancel,
            |texts, publish| {
                computed.extend(texts.iter().map(|text| text.to_string()));
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
        assert_eq!(computed, ["second", "third"]);
        assert!(read_file_index(&root.0, &files[0]).is_some());
        assert!(!partial.exists());
    }

    #[test]
    fn bad_checkpoint_checksum_and_header_do_not_reuse_vectors() {
        let root = Temporary::new();
        let subtitles = [cue("1", "first")];
        let files = subtitle_files(&subtitles);
        let (mut checkpoint, _) = Checkpoint::open(&root.0, &files[0]).unwrap();
        checkpoint.append(&[(0, vector())]).unwrap();
        let path = checkpoint.path.clone();
        drop(checkpoint);
        let mut bytes = fs::read(&path).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        fs::write(&path, bytes).unwrap();
        let (checkpoint, vectors) = Checkpoint::open(&root.0, &files[0]).unwrap();
        assert!(vectors[0].is_none());
        drop(checkpoint);
        fs::write(&path, b"invalid").unwrap();
        let (_, vectors) = Checkpoint::open(&root.0, &files[0]).unwrap();
        assert!(vectors[0].is_none());
    }

    #[test]
    fn overlapping_native_requests_compute_the_file_once() {
        let root = Temporary::new();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let threads = (0..2)
            .map(|_| {
                let path = root.0.clone();
                let calls = Arc::clone(&calls);
                std::thread::spawn(move || {
                    let subtitles = [cue("1", "shared file")];
                    build_file_indexes(
                        &path,
                        &subtitle_files(&subtitles),
                        &AtomicBool::new(false),
                        |texts, publish| {
                            calls.fetch_add(texts.len(), Ordering::SeqCst);
                            std::thread::sleep(Duration::from_millis(20));
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
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn complete_cache_hits_skip_embedding_and_warm_reads_share_vectors() {
        let root = Temporary::new();
        let subtitles = [cue("1", "first")];
        let files = subtitle_files(&subtitles);
        build_file_indexes(
            &root.0,
            &files,
            &AtomicBool::new(false),
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
        let a = read_file_index(&root.0, &files[0]).unwrap();
        let b = read_file_index(&root.0, &files[0]).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        build_file_indexes(
            &root.0,
            &files,
            &AtomicBool::new(false),
            |_, _| panic!("cached file must not enter model inference"),
            |_, _| {},
        )
        .unwrap();
        let mut replacement = vec![0.0; DIMENSIONS];
        replacement[0] = 1.0;
        write_file_index(
            &root.0,
            &SubtitleFileIndex {
                key: files[0].key.clone(),
                embeddings: vec![Some(replacement.clone())],
            },
        )
        .unwrap();
        let c = read_file_index(&root.0, &files[0]).unwrap();
        assert!(!Arc::ptr_eq(&a, &c));
        assert_eq!(c.embeddings[0].as_ref().unwrap(), &replacement);
    }
}
