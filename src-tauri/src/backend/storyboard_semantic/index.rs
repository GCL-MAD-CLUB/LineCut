//! Per-media SigLIP2 indexes, bounded warm cache, and resumable storyboard checkpoints.
use super::*;
use bincode::Options;
use std::collections::VecDeque;

const RECIPE: &str =
    "siglip2-d1114256522a37ffa257a0a58017348ab0058db2-vision-fp16-text-int8-rgb256-l2-v1";
const MAX_BYTES: u64 = 128 * 1024 * 1024;
const LEGACY_BYTES: u64 = 2 * 1024 * 1024;
const MEMORY_BYTES: usize = 32 * 1024 * 1024;

struct WarmIndex {
    path: PathBuf,
    stamp: (u64, SystemTime),
    index: Arc<Index>,
    bytes: usize,
}
static WARM: Mutex<VecDeque<WarmIndex>> = Mutex::new(VecDeque::new());

/// Media-level identity stored inside an index file. One source file owns one
/// index holding every storyboard, the way one subtitle source owns one file.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct MediaIdentity {
    fingerprint: String,
    stream: i32,
    media_length: u64,
    media_modified_ns: Option<u128>,
    rate: f64,
}

impl MediaIdentity {
    fn of(identity: &cache::ShotIdentity) -> Self {
        Self {
            fingerprint: identity.fingerprint.clone(),
            stream: identity.stream,
            media_length: identity.media_length,
            media_modified_ns: identity.media_modified_ns,
            rate: identity.rate,
        }
    }
}

/// Selected frames of one storyboard, as requested by the storyboard panel.
pub(super) struct ShotRequest {
    pub(super) start_frame: usize,
    pub(super) end_frame: usize,
    pub(super) frames: Vec<usize>,
}

/// One storyboard inside a media index. Missing vectors stay resumable.
#[derive(Serialize, Deserialize)]
struct ShotIndex {
    start_frame: usize,
    end_frame: usize,
    frames: Vec<usize>,
    vectors: Vec<Option<Vec<f32>>>,
    complete: bool,
}

impl ShotIndex {
    fn new(request: &ShotRequest) -> Self {
        Self {
            start_frame: request.start_frame,
            end_frame: request.end_frame,
            frames: request.frames.clone(),
            vectors: vec![None; request.frames.len()],
            complete: false,
        }
    }

    fn matches(&self, request: &ShotRequest) -> bool {
        self.start_frame == request.start_frame
            && self.end_frame == request.end_frame
            && self.frames == request.frames
    }
}

#[derive(Serialize, Deserialize)]
struct Index {
    recipe: String,
    media: MediaIdentity,
    shots: Vec<ShotIndex>,
    // Retained for file compatibility. Retrieval is gated per requested shot.
    complete: bool,
}

/// Storyboard files written before media-granularity indexes: adopted once,
/// then removed so the cache root keeps a single revision directory.
#[derive(Serialize, Deserialize)]
struct LegacyIndex {
    recipe: String,
    identity: cache::ShotIdentity,
    frames: Vec<usize>,
    vectors: Vec<Option<Vec<f32>>>,
    complete: bool,
}

/// Revision-scoped directory, mirroring `Subtitle Semantic Search/<revision>`.
pub(super) fn root(preferences: &Preferences) -> PathBuf {
    configured_cache_root(preferences)
        .join("Storyboard Semantic Search")
        .join(format!("{:x}", Sha256::digest(RECIPE.as_bytes())))
}

fn path(root: &Path, media: &MediaIdentity) -> AppResult<PathBuf> {
    // Hash only the small identity, never the media or model files. Media
    // length and timestamps stay inside the file, so a re-encoded source
    // replaces its own index instead of leaving an orphan behind.
    let key =
        serde_json::to_vec(&(RECIPE, &media.fingerprint, media.stream)).map_err(inference_error)?;
    Ok(root.join(format!("{:x}.bin", Sha256::digest(key))))
}

fn legacy_path(root: &Path, identity: &cache::ShotIdentity, frames: &[usize]) -> Option<PathBuf> {
    let directory = root.parent()?;
    let key = serde_json::to_vec(&(RECIPE, identity, frames)).ok()?;
    Some(directory.join(format!("{:x}.bin", Sha256::digest(key))))
}

fn remove_legacy(root: &Path, identity: &cache::ShotIdentity, request: &ShotRequest) {
    let identity = cache::ShotIdentity {
        start_frame: request.start_frame,
        end_frame: request.end_frame,
        ..identity.clone()
    };
    if let Some(path) = legacy_path(root, &identity, &request.frames) {
        let _ = fs::remove_file(path);
    }
}

fn codec(limit: u64) -> impl Options {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(limit)
        .reject_trailing_bytes()
}

fn valid_shot(shot: &ShotIndex) -> bool {
    valid_frames(shot.start_frame, shot.end_frame, &shot.frames)
        && shot.vectors.len() == shot.frames.len()
        && shot
            .vectors
            .iter()
            .flatten()
            .all(|vector| valid_vector(vector))
}

fn valid_vector(vector: &[f32]) -> bool {
    vector.len() == siglip::DIMENSIONS
        && vector.iter().all(|value| value.is_finite())
        && (vector
            .iter()
            .map(|&value| f64::from(value).powi(2))
            .sum::<f64>()
            - 1.0)
            .abs()
            < 0.001
}

fn repair_shot(shot: &mut ShotIndex) -> bool {
    if !valid_frames(shot.start_frame, shot.end_frame, &shot.frames)
        || shot.vectors.len() != shot.frames.len()
    {
        return false;
    }
    for vector in &mut shot.vectors {
        if vector.as_ref().is_some_and(|vector| !valid_vector(vector)) {
            *vector = None;
        }
    }
    if shot.vectors.iter().any(Option::is_none) {
        shot.complete = false;
    }
    true
}

fn valid_frames(start_frame: usize, end_frame: usize, frames: &[usize]) -> bool {
    !frames.is_empty()
        && frames.len() <= 32
        && frames.windows(2).all(|pair| pair[0] < pair[1])
        && frames
            .iter()
            .all(|&frame| frame >= start_frame && frame <= end_frame)
}

fn load(path: &Path, media: &MediaIdentity) -> Option<Index> {
    if fs::metadata(path).ok()?.len() > MAX_BYTES {
        return None;
    }
    let mut index: Index = codec(MAX_BYTES).deserialize(&fs::read(path).ok()?).ok()?;
    if index.recipe != RECIPE
        || index.media.fingerprint != media.fingerprint
        || index.media.stream != media.stream
    {
        return None;
    }
    // Validate once and preserve healthy vectors when a shot needs repair.
    index.shots.retain_mut(repair_shot);
    Some(index)
}

/// Keep shots from other panels/projects and share duplicate requests. Only a
/// changed media identity invalidates all vectors of a source.
fn reconcile(index: &mut Index, media: &MediaIdentity, requests: &[ShotRequest]) -> Vec<usize> {
    if index.media != *media {
        index.shots.clear();
    }
    let mut positions: HashMap<_, _> = index
        .shots
        .iter()
        .enumerate()
        .map(|(position, shot)| {
            (
                (shot.start_frame, shot.end_frame, shot.frames.clone()),
                position,
            )
        })
        .collect();
    index.media = media.clone();
    index.complete = false;
    requests
        .iter()
        .map(|request| {
            *positions
                .entry((
                    request.start_frame,
                    request.end_frame,
                    request.frames.clone(),
                ))
                .or_insert_with(|| {
                    let position = index.shots.len();
                    index.shots.push(ShotIndex::new(request));
                    position
                })
        })
        .collect()
}

fn shot_map(index: &Index) -> HashMap<(usize, usize, &[usize]), &ShotIndex> {
    index
        .shots
        .iter()
        .map(|shot| {
            (
                (shot.start_frame, shot.end_frame, shot.frames.as_slice()),
                shot,
            )
        })
        .collect()
}

fn ready(index: &Index, media: &MediaIdentity, requests: &[ShotRequest]) -> bool {
    let shots = shot_map(index);
    // Publishing a checkpoint for another scope must not hide completed shots.
    index.media == *media
        && requests.iter().all(|request| {
            shots
                .get(&(
                    request.start_frame,
                    request.end_frame,
                    request.frames.as_slice(),
                ))
                .is_some_and(|shot| shot.complete && shot.vectors.iter().all(Option::is_some))
        })
}

fn complete(path: &Path, media: &MediaIdentity, requests: &[ShotRequest]) -> Option<Arc<Index>> {
    let metadata = fs::metadata(path).ok()?;
    let stamp = (metadata.len(), metadata.modified().ok()?);
    if let Ok(mut warm) = WARM.lock() {
        if let Some(position) = warm.iter().position(|entry| entry.path == path) {
            let entry = warm.remove(position)?;
            if entry.stamp == stamp && ready(&entry.index, media, requests) {
                let index = Arc::clone(&entry.index);
                warm.push_back(entry);
                return Some(index);
            }
        }
    }
    let index = load(path, media)?;
    if !ready(&index, media, requests) {
        return None;
    }
    let index = Arc::new(index);
    let bytes = metadata.len() as usize;
    if let Ok(mut warm) = WARM.lock() {
        warm.retain(|entry| entry.path != path);
        warm.push_back(WarmIndex {
            path: path.into(),
            stamp,
            index: Arc::clone(&index),
            bytes,
        });
        let mut total: usize = warm.iter().map(|entry| entry.bytes).sum();
        while total > MEMORY_BYTES {
            total -= warm.pop_front()?.bytes;
        }
    }
    Some(index)
}

fn save(path: &Path, index: &Index, cancel: &AtomicBool) -> AppResult<()> {
    use std::io::Write;
    ensure_not_cancelled(cancel)?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let write = (|| {
        let bytes = codec(MAX_BYTES).serialize(index).map_err(inference_error)?;
        let mut file = fs::File::create(&temporary).map_err(inference_error)?;
        file.write_all(&bytes).map_err(inference_error)?;
        file.sync_all().map_err(inference_error)?;
        drop(file);
        ensure_not_cancelled(cancel)?;
        fs::rename(&temporary, path).map_err(inference_error)
    })();
    if write.is_err() {
        let _ = fs::remove_file(&temporary);
    } else if let Ok(mut warm) = WARM.lock() {
        // A rewritten media file invalidates any cached copy for its path.
        warm.retain(|entry| entry.path != path);
    }
    write
}

fn load_legacy(
    path: &Path,
    identity: &cache::ShotIdentity,
    request: &ShotRequest,
) -> Option<ShotIndex> {
    if fs::metadata(path).ok()?.len() > LEGACY_BYTES {
        return None;
    }
    let index: LegacyIndex = codec(LEGACY_BYTES)
        .deserialize(&fs::read(path).ok()?)
        .ok()?;
    let LegacyIndex {
        recipe,
        identity: stored_identity,
        frames,
        vectors,
        complete,
    } = index;
    let mut shot = ShotIndex {
        start_frame: request.start_frame,
        end_frame: request.end_frame,
        frames: frames.clone(),
        vectors,
        complete,
    };
    if recipe != RECIPE
        || &stored_identity != identity
        || !shot.matches(request)
        || !repair_shot(&mut shot)
    {
        return None;
    }
    Some(shot)
}

pub(super) fn read(
    root: &Path,
    identity: &cache::ShotIdentity,
    requests: &[ShotRequest],
) -> AppResult<Vec<Vec<Vec<f32>>>> {
    let media = MediaIdentity::of(identity);
    let index = complete(&path(root, &media)?, &media, requests).ok_or_else(incomplete_index)?;
    let shots = shot_map(&index);
    requests
        .iter()
        .map(|request| {
            shots
                .get(&(
                    request.start_frame,
                    request.end_frame,
                    request.frames.as_slice(),
                ))
                .and_then(|shot| shot.vectors.iter().cloned().collect::<Option<Vec<_>>>())
                .ok_or_else(incomplete_index)
        })
        .collect()
}

fn incomplete_index() -> AppError {
    inference_error("Storyboard semantic index is missing or incomplete; rebuild before retrieval")
}

pub(super) fn get_or_build(
    root: &Path,
    identity: &cache::ShotIdentity,
    requests: &[ShotRequest],
    cancel: &AtomicBool,
    mut report: impl FnMut(usize),
    mut encode: impl FnMut(
        usize,
        &[usize],
        &mut dyn FnMut(&[Vec<f32>]) -> AppResult<()>,
    ) -> AppResult<()>,
) -> AppResult<()> {
    ensure_not_cancelled(cancel)?;
    if requests.is_empty() {
        return Ok(());
    }
    if requests
        .iter()
        .any(|request| !valid_frames(request.start_frame, request.end_frame, &request.frames))
    {
        return Err(inference_error("Invalid SigLIP2 frame request"));
    }
    fs::create_dir_all(root).map_err(inference_error)?;
    let media = MediaIdentity::of(identity);
    let path = path(root, &media)?;
    if complete(&path, &media, requests).is_some() {
        for request in requests {
            remove_legacy(root, identity, request);
        }
        report(requests.len());
        return Ok(());
    }
    let mut index = load(&path, &media).unwrap_or_else(|| Index {
        recipe: RECIPE.into(),
        media: media.clone(),
        shots: Vec::new(),
        complete: false,
    });
    let slots = reconcile(&mut index, &media, requests);
    for position in 0..requests.len() {
        ensure_not_cancelled(cancel)?;
        let request = &requests[position];
        let slot = slots[position];
        if index.shots[slot].complete && index.shots[slot].vectors.iter().all(Option::is_some) {
            remove_legacy(root, identity, request);
            report(position + 1);
            continue;
        }
        if index.shots[slot].vectors.iter().any(Option::is_none) {
            let shot_identity = cache::ShotIdentity {
                start_frame: request.start_frame,
                end_frame: request.end_frame,
                ..identity.clone()
            };
            if let Some(shot) = legacy_path(root, &shot_identity, &request.frames)
                .and_then(|source| load_legacy(&source, &shot_identity, request))
            {
                // A cancelled migration may have a newer media checkpoint.
                // Adopt only missing vectors so the old file cannot undo it.
                for (current, legacy) in index.shots[slot].vectors.iter_mut().zip(shot.vectors) {
                    if current.is_none() {
                        *current = legacy;
                    }
                }
            }
        }
        let pending: Vec<usize> = (0..request.frames.len())
            .filter(|&frame| index.shots[slot].vectors[frame].is_none())
            .collect();
        if !pending.is_empty() {
            index.shots[slot].complete = false;
            let positions: Vec<usize> = pending
                .iter()
                .map(|&frame| request.frames[frame] - request.start_frame)
                .collect();
            let mut completed = 0;
            encode(position, &positions, &mut |vectors| {
                ensure_not_cancelled(cancel)?;
                if completed + vectors.len() > pending.len() {
                    return Err(inference_error("Too many SigLIP2 vectors"));
                }
                for vector in vectors {
                    index.shots[slot].vectors[pending[completed]] = Some(vector.clone());
                    completed += 1;
                }
                if !valid_shot(&index.shots[slot]) {
                    return Err(inference_error("Invalid SigLIP2 index batch"));
                }
                // Persist each validated batch so cancellation or a later
                // decoder failure resumes only the missing frames.
                save(&path, &index, cancel)
            })?;
            if completed != pending.len() {
                return Err(inference_error("Incomplete SigLIP2 encoding"));
            }
        }
        index.shots[slot].complete = true;
        save(&path, &index, cancel)?;
        // Delete the old file only after this shot is durably complete.
        remove_legacy(root, identity, request);
        report(position + 1);
    }
    ensure_not_cancelled(cancel)
}

pub(super) fn max_similarity(vectors: &[Vec<f32>], query: &[f32]) -> AppResult<f32> {
    if vectors.is_empty() || query.len() != siglip::DIMENSIONS {
        return Err(inference_error("Invalid retrieval vectors"));
    }
    Ok(vectors
        .iter()
        .map(|v| {
            v.iter()
                .zip(query)
                .map(|(a, b)| a * b)
                .sum::<f32>()
                .clamp(-1.0, 1.0)
        })
        .fold(f32::NEG_INFINITY, f32::max))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(
        root: &Path,
        identity: &cache::ShotIdentity,
        requests: &[ShotRequest],
        cancel: &AtomicBool,
        encode: impl FnMut(
            usize,
            &[usize],
            &mut dyn FnMut(&[Vec<f32>]) -> AppResult<()>,
        ) -> AppResult<()>,
    ) -> AppResult<()> {
        get_or_build(root, identity, requests, cancel, |_| {}, encode)
    }

    fn vector(index: usize) -> Vec<f32> {
        let mut vector = vec![0.0; siglip::DIMENSIONS];
        vector[index] = 1.0;
        vector
    }

    fn request(start_frame: usize, frames: &[usize]) -> ShotRequest {
        ShotRequest {
            start_frame,
            end_frame: frames.iter().copied().max().unwrap_or(start_frame),
            frames: frames.to_vec(),
        }
    }

    fn identity(start_frame: usize, end_frame: usize) -> cache::ShotIdentity {
        cache::ShotIdentity {
            fingerprint: "a".repeat(64),
            media_length: 1_000,
            media_modified_ns: Some(7),
            stream: 0,
            rate: 24.0,
            start_frame,
            end_frame,
        }
    }

    fn cache_directory() -> PathBuf {
        env::temp_dir().join(format!("linecut-siglip-{}", Uuid::new_v4()))
    }

    fn encode_offsets(
        positions: &[usize],
        publish: &mut dyn FnMut(&[Vec<f32>]) -> AppResult<()>,
        salt: usize,
    ) -> AppResult<()> {
        for offset in positions {
            publish(&[vector(offset + salt)])?;
        }
        Ok(())
    }

    #[test]
    fn retrieval_uses_best_frame_not_mean_and_preserves_negative_scores() {
        let mut query = vec![0.0; siglip::DIMENSIONS];
        query[0] = 1.0;
        let negative: Vec<_> = query.iter().map(|v| -v).collect();
        assert_eq!(
            max_similarity(&[negative.clone(), query.clone()], &query).unwrap(),
            1.0
        );
        assert_eq!(max_similarity(&[negative], &query).unwrap(), -1.0);
        assert!(max_similarity(&[], &query).is_err());
    }

    #[test]
    fn media_index_resumes_missing_frames_and_reuses_completed_shots() {
        let root = cache_directory().join("revision");
        let identity = identity(10, 40);
        let requests = [request(10, &[10, 20]), request(30, &[30, 40])];
        let cancel = AtomicBool::new(false);
        let mut encoded = Vec::new();
        assert!(build(
            &root,
            &identity,
            &requests,
            &cancel,
            |position, positions, publish| {
                encoded.push((position, positions.to_vec()));
                if position == 0 {
                    return encode_offsets(positions, publish, 0);
                }
                publish(&[vector(1)])?;
                cancel.store(true, Ordering::SeqCst);
                Err(inference_error("Storyboard index build cancelled"))
            }
        )
        .is_err());
        assert_eq!(encoded, vec![(0, vec![0, 10]), (1, vec![0, 10])]);
        assert!(read(&root, &identity, &requests).is_err());
        cancel.store(false, Ordering::SeqCst);
        let mut encoded = Vec::new();
        build(
            &root,
            &identity,
            &requests,
            &cancel,
            |position, positions, publish| {
                encoded.push((position, positions.to_vec()));
                encode_offsets(positions, publish, position + 1)
            },
        )
        .unwrap();
        // The storyboard that finished before the cancellation keeps its vectors.
        assert_eq!(encoded, vec![(1, vec![10])]);
        let vectors = read(&root, &identity, &requests).unwrap();
        assert_eq!(vectors[0], vec![vector(0), vector(10)]);
        assert_eq!(vectors[1], vec![vector(1), vector(12)]);
        build(&root, &identity, &requests, &cancel, |_, _, _| {
            panic!("complete media index must be reused")
        })
        .unwrap();
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn building_another_scope_keeps_completed_shots_readable_during_cancellation() {
        let root = cache_directory().join("revision");
        let identity = identity(10, 40);
        let cancel = AtomicBool::new(false);
        let first = [request(10, &[10, 20])];
        build(
            &root,
            &identity,
            &first,
            &cancel,
            |_, positions, publish| encode_offsets(positions, publish, 0),
        )
        .unwrap();
        let other = [request(30, &[30, 40]), request(50, &[50, 60])];
        assert!(build(
            &root,
            &identity,
            &other,
            &cancel,
            |position, positions, publish| {
                assert_eq!(
                    read(&root, &identity, &first).unwrap()[0],
                    vec![vector(0), vector(10)]
                );
                if position == 0 {
                    return encode_offsets(positions, publish, 1);
                }
                cancel.store(true, Ordering::SeqCst);
                Err(inference_error("cancelled"))
            },
        )
        .is_err());
        assert_eq!(
            read(&root, &identity, &first).unwrap()[0],
            vec![vector(0), vector(10)]
        );
        assert_eq!(
            read(&root, &identity, &other[..1]).unwrap()[0],
            vec![vector(1), vector(11)]
        );
        assert!(read(&root, &identity, &other).is_err());
        cancel.store(false, Ordering::SeqCst);
        let both = [request(10, &[10, 20]), request(30, &[30, 40])];
        build(&root, &identity, &both, &cancel, |_, _, _| {
            panic!("completed scopes must remain reusable")
        })
        .unwrap();
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn invalid_frame_requests_fail_before_encoding() {
        let root = cache_directory().join("revision");
        let identity = identity(10, 20);
        let cancel = AtomicBool::new(false);
        for frames in [vec![], vec![9], vec![21], vec![20, 10], vec![10, 10]] {
            let requests = [ShotRequest {
                start_frame: 10,
                end_frame: 20,
                frames,
            }];
            assert!(
                build(&root, &identity, &requests, &cancel, |_, _, _| panic!(
                    "invalid request must not reach decoder"
                ))
                .is_err()
            );
        }
        assert!(!root.exists());
    }

    #[test]
    fn progress_counts_persisted_shots_and_duplicate_requests_share_encoding() {
        let root = cache_directory().join("revision");
        let identity = identity(10, 40);
        let cancel = AtomicBool::new(false);
        let requests = [
            request(10, &[10, 20]),
            request(10, &[10, 20]),
            request(30, &[30, 40]),
        ];
        let mut progress = Vec::new();
        let mut encoded = Vec::new();
        assert!(get_or_build(
            &root,
            &identity,
            &requests,
            &cancel,
            |completed| {
                assert!(read(&root, &identity, &requests[..completed]).is_ok());
                progress.push(completed);
            },
            |position, positions, publish| {
                encoded.push(position);
                if position == 2 {
                    return Err(inference_error("decoder failed"));
                }
                encode_offsets(positions, publish, 0)
            },
        )
        .is_err());
        assert_eq!(progress, vec![1, 2]);
        assert_eq!(encoded, vec![0, 2]);
        let mut progress = Vec::new();
        get_or_build(
            &root,
            &identity,
            &requests,
            &cancel,
            |completed| {
                assert!(read(&root, &identity, &requests[..completed]).is_ok());
                progress.push(completed);
            },
            |position, positions, publish| {
                assert_eq!(position, 2);
                encode_offsets(positions, publish, 0)
            },
        )
        .unwrap();
        assert_eq!(progress, vec![1, 2, 3]);
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn changed_frame_selection_reencodes_only_that_shot() {
        let root = cache_directory().join("revision");
        let identity = identity(10, 40);
        let cancel = AtomicBool::new(false);
        let requests = [request(10, &[10, 20]), request(30, &[30, 40])];
        build(
            &root,
            &identity,
            &requests,
            &cancel,
            |_, positions, publish| encode_offsets(positions, publish, 0),
        )
        .unwrap();
        let changed = [request(10, &[10, 20]), request(30, &[30, 50])];
        let mut encoded = Vec::new();
        build(
            &root,
            &identity,
            &changed,
            &cancel,
            |position, positions, publish| {
                encoded.push((position, positions.to_vec()));
                encode_offsets(positions, publish, 0)
            },
        )
        .unwrap();
        // A changed selection replaces that storyboard; the other shot is kept.
        assert_eq!(encoded, vec![(1, vec![0, 20])]);
        assert_eq!(
            read(&root, &identity, &changed).unwrap()[1],
            vec![vector(0), vector(20)]
        );
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn changed_media_reencodes_in_place_without_orphan_files() {
        let root = cache_directory().join("revision");
        let cancel = AtomicBool::new(false);
        let requests = [request(10, &[10, 20])];
        let original = identity(10, 20);
        build(
            &root,
            &original,
            &requests,
            &cancel,
            |_, positions, publish| encode_offsets(positions, publish, 0),
        )
        .unwrap();
        let mut replaced = original.clone();
        replaced.media_length += 1;
        let mut encoded = 0;
        build(
            &root,
            &replaced,
            &requests,
            &cancel,
            |_, positions, publish| {
                encoded += positions.len();
                encode_offsets(positions, publish, 1)
            },
        )
        .unwrap();
        assert_eq!(encoded, 2);
        assert_eq!(
            read(&root, &replaced, &requests).unwrap()[0],
            vec![vector(1), vector(11)]
        );
        assert!(read(&root, &original, &requests).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn corrupt_index_is_rebuilt_instead_of_read() {
        let root = cache_directory().join("revision");
        let identity = identity(10, 20);
        let requests = [request(10, &[10, 20])];
        let cancel = AtomicBool::new(false);
        build(
            &root,
            &identity,
            &requests,
            &cancel,
            |_, positions, publish| encode_offsets(positions, publish, 0),
        )
        .unwrap();
        fs::write(
            path(&root, &MediaIdentity::of(&identity)).unwrap(),
            b"broken",
        )
        .unwrap();
        assert!(read(&root, &identity, &requests).is_err());
        let mut encoded = 0;
        build(
            &root,
            &identity,
            &requests,
            &cancel,
            |_, positions, publish| {
                encoded += positions.len();
                encode_offsets(positions, publish, 0)
            },
        )
        .unwrap();
        assert_eq!(encoded, 2);
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn damaged_vectors_reencode_only_their_positions_and_keep_other_shots_readable() {
        let root = cache_directory().join("revision");
        let identity = identity(10, 50);
        let requests = [request(10, &[10, 20, 30]), request(40, &[40, 50])];
        let cancel = AtomicBool::new(false);
        build(
            &root,
            &identity,
            &requests,
            &cancel,
            |_, positions, publish| encode_offsets(positions, publish, 0),
        )
        .unwrap();
        let media = MediaIdentity::of(&identity);
        let file = path(&root, &media).unwrap();
        for damage in 0..4 {
            let mut index = load(&file, &media).unwrap();
            index.shots[0].vectors[1] = match damage {
                0 => None,
                1 => Some(vec![f32::NAN; siglip::DIMENSIONS]),
                2 => Some(Vec::new()),
                _ => Some(vec![0.0; siglip::DIMENSIONS]),
            };
            save(&file, &index, &cancel).unwrap();
            assert!(read(&root, &identity, &requests[..1]).is_err());
            assert!(read(&root, &identity, &requests[1..]).is_ok());
            let mut encoded = 0;
            build(
                &root,
                &identity,
                &requests,
                &cancel,
                |position, positions, publish| {
                    assert_eq!(position, 0);
                    assert_eq!(positions, &[10]);
                    encoded += positions.len();
                    encode_offsets(positions, publish, 0)
                },
            )
            .unwrap();
            assert_eq!(encoded, 1);
            assert_eq!(
                read(&root, &identity, &requests).unwrap()[0],
                vec![vector(0), vector(10), vector(20)]
            );
        }
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn legacy_per_shot_files_are_adopted_then_removed() {
        let cache = cache_directory();
        let root = cache.join("revision");
        fs::create_dir_all(&root).unwrap();
        let identity = identity(10, 20);
        let requests = [request(10, &[10, 20])];
        let legacy = legacy_path(&root, &identity, &[10, 20]).unwrap();
        fs::write(
            &legacy,
            codec(LEGACY_BYTES)
                .serialize(&LegacyIndex {
                    recipe: RECIPE.into(),
                    identity: identity.clone(),
                    frames: vec![10, 20],
                    vectors: vec![Some(vector(0)), Some(vector(1))],
                    complete: true,
                })
                .unwrap(),
        )
        .unwrap();
        let cancel = AtomicBool::new(false);
        build(&root, &identity, &requests, &cancel, |_, _, _| {
            panic!("adopted vectors must not be re-encoded")
        })
        .unwrap();
        assert_eq!(
            read(&root, &identity, &requests).unwrap()[0],
            vec![vector(0), vector(1)]
        );
        assert!(!legacy.exists());
        fs::remove_dir_all(cache).unwrap();
    }

    #[test]
    fn partial_legacy_checkpoint_resumes_only_missing_vectors() {
        let cache = cache_directory();
        let root = cache.join("revision");
        fs::create_dir_all(&root).unwrap();
        let identity = identity(10, 30);
        let requests = [request(10, &[10, 20, 30])];
        let legacy = legacy_path(&root, &identity, &[10, 20, 30]).unwrap();
        fs::write(
            &legacy,
            codec(LEGACY_BYTES)
                .serialize(&LegacyIndex {
                    recipe: RECIPE.into(),
                    identity: identity.clone(),
                    frames: vec![10, 20, 30],
                    vectors: vec![Some(vector(3)), None, None],
                    complete: false,
                })
                .unwrap(),
        )
        .unwrap();
        let cancel = AtomicBool::new(false);
        assert!(
            build(&root, &identity, &requests, &cancel, |_, positions, _| {
                assert_eq!(positions, &[10, 20]);
                cancel.store(true, Ordering::SeqCst);
                Err(inference_error("cancelled"))
            })
            .is_err()
        );
        assert!(
            legacy.exists(),
            "unpublished migration must preserve the original checkpoint"
        );
        cancel.store(false, Ordering::SeqCst);
        assert!(build(
            &root,
            &identity,
            &requests,
            &cancel,
            |_, positions, publish| {
                assert_eq!(positions, &[10, 20]);
                publish(&[vector(7)])?;
                cancel.store(true, Ordering::SeqCst);
                Err(inference_error("cancelled after a persisted batch"))
            },
        )
        .is_err());
        assert!(legacy.exists());
        cancel.store(false, Ordering::SeqCst);
        build(
            &root,
            &identity,
            &requests,
            &cancel,
            |_, positions, publish| {
                assert_eq!(positions, &[20]);
                encode_offsets(positions, publish, 0)
            },
        )
        .unwrap();
        assert_eq!(
            read(&root, &identity, &requests).unwrap()[0],
            vec![vector(3), vector(7), vector(20)]
        );
        assert!(!legacy.exists());
        fs::remove_dir_all(cache).unwrap();
    }
}
