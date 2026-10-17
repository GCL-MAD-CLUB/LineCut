//! Per-media SigLIP2 indexes in size-rotated UUID shards, independent of CSES.
use super::storage::{self, MAX_RECORD_BYTES, SHARD_BYTES};
use super::*;
use bincode::Options;

const RECIPE: &str =
    "siglip2-d1114256522a37ffa257a0a58017348ab0058db2-vision-fp16-text-int8-rgb256-l2-v1";
static WARM: OnceLock<Mutex<storage::Warm<ShotIndex>>> = OnceLock::new();

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

pub(super) struct ShotRequest {
    pub(super) start_frame: usize,
    pub(super) end_frame: usize,
    pub(super) frames: Vec<usize>,
}

pub(super) struct PendingShot {
    pub(super) position: usize,
    pub(super) frames: Vec<usize>,
}

#[derive(Clone, Serialize, Deserialize)]
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
}

struct Index {
    media: MediaIdentity,
    shots: Vec<ShotIndex>,
}

#[derive(Serialize, Deserialize)]
struct StoredShot {
    recipe: String,
    media: MediaIdentity,
    shot: ShotIndex,
}

pub(super) fn root(preferences: &Preferences) -> PathBuf {
    configured_cache_root(preferences).join("Storyboard Semantic Search")
}

fn path(root: &Path, media: &MediaIdentity) -> AppResult<PathBuf> {
    let revision = codec()
        .serialize(&(RECIPE, media.media_length, media.media_modified_ns))
        .map_err(inference_error)?;
    storage::directory(root, &media.fingerprint, &revision)
        .ok_or_else(|| inference_error("Invalid semantic media fingerprint"))
}

fn shot_key(media: &MediaIdentity, start: usize, end: usize) -> AppResult<[u8; 32]> {
    let bytes = codec()
        .serialize(&(RECIPE, media, start, end))
        .map_err(inference_error)?;
    Ok(Sha256::digest(bytes).into())
}

fn codec() -> impl Options {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(MAX_RECORD_BYTES)
        .reject_trailing_bytes()
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

fn valid_frames(start_frame: usize, end_frame: usize, frames: &[usize]) -> bool {
    !frames.is_empty()
        && frames.len() <= 32
        && frames.windows(2).all(|pair| pair[0] < pair[1])
        && frames
            .iter()
            .all(|&frame| frame >= start_frame && frame <= end_frame)
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

fn empty_index(media: &MediaIdentity) -> Index {
    Index {
        media: media.clone(),
        shots: Vec::new(),
    }
}

fn load(directory: &Path, media: &MediaIdentity, requests: &[ShotRequest]) -> Option<Index> {
    let keys: Vec<_> = requests
        .iter()
        .map(|request| shot_key(media, request.start_frame, request.end_frame))
        .collect::<AppResult<_>>()
        .ok()?;
    let snapshots = storage::locate(directory, &keys)?;
    let cache = WARM.get_or_init(Default::default);
    let mut index = empty_index(media);
    for (request, snapshot) in requests.iter().zip(snapshots) {
        let Some(snapshot) = snapshot else {
            continue;
        };
        let warmed = cache.lock().ok()?.get(&snapshot.token);
        let shot = if let Some(shot) = warmed {
            shot
        } else {
            let token = snapshot.token.clone();
            let Some(bytes) = snapshot.read() else {
                continue;
            };
            let Ok(mut stored) = codec().deserialize::<StoredShot>(&bytes) else {
                continue;
            };
            if stored.recipe != RECIPE
                || stored.media != *media
                || stored.shot.start_frame != request.start_frame
                || stored.shot.end_frame != request.end_frame
                || stored.shot.frames != request.frames
                || !repair_shot(&mut stored.shot)
            {
                continue;
            }
            let shot = Arc::new(stored.shot);
            if let Ok(mut cache) = cache.lock() {
                cache.insert(token, Arc::clone(&shot), bytes.len());
            }
            shot
        };
        if shot.frames == request.frames {
            index.shots.push((*shot).clone());
        }
    }
    Some(index)
}

struct Checkpoint {
    path: PathBuf,
    media: MediaIdentity,
    limit: u64,
}
impl Checkpoint {
    fn new(path: &Path, media: &MediaIdentity) -> Self {
        Self {
            path: path.into(),
            media: media.clone(),
            limit: SHARD_BYTES,
        }
    }
    fn append(&mut self, shots: &[&ShotIndex], cancel: &AtomicBool) -> AppResult<()> {
        ensure_not_cancelled(cancel)?;
        let payloads = shots
            .iter()
            .map(|shot| {
                Ok((
                    shot_key(&self.media, shot.start_frame, shot.end_frame)?,
                    codec()
                        .serialize(&(RECIPE, &self.media, shot))
                        .map_err(inference_error)?,
                ))
            })
            .collect::<AppResult<Vec<_>>>()?;
        let records: Vec<_> = payloads
            .iter()
            .map(|(key, payload)| (*key, payload.as_slice()))
            .collect();
        storage::append_batch(&self.path, &records, cancel, self.limit)
    }
}

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
    let index = load(path, media, requests)?;
    ready(&index, media, requests).then(|| Arc::new(index))
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
    mut report: impl FnMut(f64),
    encode: impl FnOnce(
        &[PendingShot],
        &mut dyn FnMut(&[Vec<f32>], usize) -> AppResult<()>,
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
        report(requests.len() as f64);
        return Ok(());
    }
    let mut index = load(&path, &media, requests).unwrap_or_else(|| empty_index(&media));
    let mut checkpoint = Checkpoint::new(&path, &media);
    let slots = reconcile(&mut index, &media, requests);
    let mut copies = HashMap::<usize, usize>::new();
    for &slot in &slots {
        *copies.entry(slot).or_default() += 1;
    }
    let mut jobs = Vec::new();
    let mut job_slots = Vec::new();
    let mut flat = Vec::new();
    let mut seen = HashSet::new();
    let mut seeded = HashSet::new();
    for (position, &slot) in slots.iter().enumerate() {
        ensure_not_cancelled(cancel)?;
        if !seen.insert(slot) {
            continue;
        }
        let shot = &mut index.shots[slot];
        let mut frames = Vec::new();
        for (frame, vector) in shot.vectors.iter().enumerate() {
            if vector.is_none() {
                flat.push((slot, frame));
                frames.push(shot.frames[frame] - shot.start_frame);
            }
        }
        if frames.is_empty() {
            // Fully encoded checkpoints can be promoted without inference.
            if !shot.complete {
                seeded.insert(slot);
            }
            shot.complete = true;
        } else {
            shot.complete = false;
            jobs.push(PendingShot { position, frames });
            job_slots.push(slot);
        }
    }
    // Persist adopted/promoted shots once. Following records contain only the
    // shots touched by one inference batch, never the whole media index.
    let existing: Vec<_> = seeded.iter().map(|&slot| &index.shots[slot]).collect();
    for batch in existing.chunks(batch::MAX_BATCH) {
        checkpoint.append(batch, cancel)?;
    }
    let credit = |shot: &ShotIndex| {
        if shot.complete {
            1.0
        } else {
            shot.vectors
                .iter()
                .filter(|vector| vector.is_some())
                .count() as f64
                / (shot.frames.len() + 1) as f64
        }
    };
    let mut credits: HashMap<usize, f64> = copies
        .keys()
        .map(|&slot| (slot, credit(&index.shots[slot])))
        .collect();
    let mut progress: f64 = credits
        .iter()
        .map(|(slot, credit)| *credit * copies[slot] as f64)
        .sum();
    let report_progress = |progress: f64| progress.min(requests.len() as f64 - 0.001);
    report(report_progress(progress));
    let mut written = 0;
    let mut validated = 0;
    let mut promoted = 0;
    if !jobs.is_empty() {
        encode(&jobs, &mut |vectors, decoded| {
            ensure_not_cancelled(cancel)?;
            if decoded < validated
                || decoded > jobs.len()
                || written + vectors.len() > flat.len()
                || vectors.iter().any(|vector| !valid_vector(vector))
            {
                return Err(inference_error("Invalid SigLIP2 index batch"));
            }
            let mut touched = HashSet::new();
            for vector in vectors {
                let (slot, frame) = flat[written];
                index.shots[slot].vectors[frame] = Some(vector.clone());
                touched.insert(slot);
                written += 1;
            }
            validated = decoded;
            // Decoding can finish before inference consumes its queued RGB. Only
            // validated shots whose vectors are all present may become searchable.
            while promoted < validated {
                let slot = job_slots[promoted];
                let shot = &mut index.shots[slot];
                if shot.vectors.iter().any(Option::is_none) {
                    break;
                }
                shot.complete = true;
                touched.insert(slot);
                promoted += 1;
            }
            let snapshots: Vec<_> = touched.iter().map(|&slot| &index.shots[slot]).collect();
            for batch in snapshots.chunks(batch::MAX_BATCH) {
                checkpoint.append(batch, cancel)?;
            }
            for slot in touched {
                let next = credit(&index.shots[slot]);
                progress += (next - credits[&slot]) * copies[&slot] as f64;
                credits.insert(slot, next);
            }
            report(report_progress(progress));
            Ok(())
        })?;
    }
    ensure_not_cancelled(cancel)?;
    if written != flat.len() || validated != jobs.len() || !ready(&index, &media, requests) {
        return Err(inference_error("Incomplete SigLIP2 encoding"));
    }
    // Every batch is already committed to its shard; no source-wide snapshot
    // or temporary journal is needed, regardless of the media's total size.
    report(requests.len() as f64);
    Ok(())
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
    use std::io::{Seek, SeekFrom, Write};
    use storage::{shards as shard_files, FILE_HEADER_BYTES, RECORD_COMMIT, RECORD_HEADER_BYTES};

    fn save(path: &Path, index: &Index, cancel: &AtomicBool) -> AppResult<()> {
        let mut checkpoint = Checkpoint {
            path: path.into(),
            media: index.media.clone(),
            limit: SHARD_BYTES,
        };
        for batch in index.shots.chunks(batch::MAX_BATCH) {
            checkpoint.append(&batch.iter().collect::<Vec<_>>(), cancel)?;
        }
        Ok(())
    }

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
        build_reporting(root, identity, requests, cancel, |_| {}, encode)
    }

    fn build_reporting(
        root: &Path,
        identity: &cache::ShotIdentity,
        requests: &[ShotRequest],
        cancel: &AtomicBool,
        report: impl FnMut(f64),
        mut encode: impl FnMut(
            usize,
            &[usize],
            &mut dyn FnMut(&[Vec<f32>]) -> AppResult<()>,
        ) -> AppResult<()>,
    ) -> AppResult<()> {
        get_or_build(root, identity, requests, cancel, report, |jobs, publish| {
            for (position, job) in jobs.iter().enumerate() {
                encode(job.position, &job.frames, &mut |vectors| {
                    publish(vectors, position)
                })?;
                publish(&[], position + 1)?;
            }
            Ok(())
        })
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
        assert!(build_reporting(
            &root,
            &identity,
            &requests,
            &cancel,
            |completed| {
                if completed > 0.0 && completed.fract() == 0.0 {
                    assert!(read(&root, &identity, &requests[..completed as usize]).is_ok());
                    if progress.last() != Some(&(completed as usize)) {
                        progress.push(completed as usize);
                    }
                }
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
        assert_eq!(progress, vec![2]);
        assert_eq!(encoded, vec![0, 2]);
        let mut progress = Vec::new();
        build_reporting(
            &root,
            &identity,
            &requests,
            &cancel,
            |completed| {
                if completed > 0.0 && completed.fract() == 0.0 {
                    assert!(read(&root, &identity, &requests[..completed as usize]).is_ok());
                    if progress.last() != Some(&(completed as usize)) {
                        progress.push(completed as usize);
                    }
                }
            },
            |position, positions, publish| {
                assert_eq!(position, 2);
                encode_offsets(positions, publish, 0)
            },
        )
        .unwrap();
        assert_eq!(progress, vec![2, 3]);
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
    fn changed_media_reclaims_the_obsolete_generation() {
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
        let media_directory = root.join(&original.fingerprint);
        assert_eq!(fs::read_dir(media_directory).unwrap().count(), 1);
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
            shard_files(&path(&root, &MediaIdentity::of(&identity)).unwrap())
                .pop()
                .unwrap(),
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
            let mut index = load(&file, &media, &requests).unwrap();
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
    fn media_batches_append_to_one_shard_and_recover_torn_tails() {
        let root = cache_directory().join("semantic");
        let identity = identity(0, 1000);
        let cancel = AtomicBool::new(false);
        let original = [request(0, &[0, 1, 2])];
        build(
            &root,
            &identity,
            &original,
            &cancel,
            |_, positions, publish| encode_offsets(positions, publish, 0),
        )
        .unwrap();
        let directory = path(&root, &MediaIdentity::of(&identity)).unwrap();
        let file = shard_files(&directory).pop().unwrap();
        let committed = fs::read(&file).unwrap();
        let requests: Vec<_> = (0..20)
            .map(|i| request(100 + i * 10, &[100 + i * 10]))
            .collect();
        assert!(get_or_build(
            &root,
            &identity,
            &requests,
            &cancel,
            |_| {},
            |jobs, publish| {
                assert_eq!(jobs.len(), 20);
                publish(&(0..8).map(vector).collect::<Vec<_>>(), 8)?;
                assert!(
                    fs::read(&file).unwrap().starts_with(&committed),
                    "batch appends must preserve committed bytes"
                );
                cancel.store(true, Ordering::SeqCst);
                Err(inference_error("cancelled"))
            }
        )
        .is_err());
        assert!(read(&root, &identity, &original).is_ok());
        assert!(read(&root, &identity, &requests[..8]).is_ok());
        assert!(read(&root, &identity, &requests).is_err());
        let valid_length = fs::metadata(&file).unwrap().len();
        let mut writer = fs::OpenOptions::new().append(true).open(&file).unwrap();
        writer.write_all(b"unfinished batch").unwrap();
        drop(writer);
        cancel.store(false, Ordering::SeqCst);
        get_or_build(
            &root,
            &identity,
            &requests,
            &cancel,
            |_| {},
            |jobs, publish| {
                assert_eq!(jobs.len(), 12);
                assert_eq!(jobs[0].position, 8);
                publish(&(8..20).map(vector).collect::<Vec<_>>(), jobs.len())
            },
        )
        .unwrap();
        assert!(fs::metadata(&file).unwrap().len() > valid_length);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        assert_eq!(
            read(&root, &identity, &requests).unwrap(),
            (0..20).map(|i| vec![vector(i)]).collect::<Vec<_>>()
        );
        assert!(read(&root, &identity, &original).is_ok());
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn inferred_frames_require_decoder_validation_before_becoming_searchable() {
        let root = cache_directory().join("revision");
        let identity = identity(10, 20);
        let requests = [request(10, &[10, 20])];
        let cancel = AtomicBool::new(false);
        let mut updates = Vec::new();
        get_or_build(
            &root,
            &identity,
            &requests,
            &cancel,
            |value| updates.push(value),
            |jobs, publish| {
                assert_eq!(jobs.len(), 1);
                publish(&[vector(0), vector(1)], 0)?;
                assert!(read(&root, &identity, &requests).is_err());
                publish(&[], 1)?;
                assert!(read(&root, &identity, &requests).is_ok());
                Ok(())
            },
        )
        .unwrap();
        assert!(updates.windows(2).all(|pair| pair[0] <= pair[1]));
        assert!(updates[..updates.len() - 1]
            .iter()
            .all(|&value| value < 1.0));
        assert_eq!(updates.last(), Some(&1.0));
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn media_indexes_reuse_shots_across_shards_and_isolate_streams() {
        let root = cache_directory();
        let identity = identity(0, 100);
        let media = MediaIdentity::of(&identity);
        let directory = path(&root, &media).unwrap();
        let requests: Vec<_> = (0..5)
            .map(|i| request(i * 10, &[i * 10, i * 10 + 1]))
            .collect();
        let shots: Vec<_> = requests
            .iter()
            .enumerate()
            .map(|(i, request)| {
                let mut shot = ShotIndex::new(request);
                shot.vectors = vec![Some(vector(i * 2)), Some(vector(i * 2 + 1))];
                shot.complete = true;
                shot
            })
            .collect();
        let records = [&shots[0]];
        let bytes = codec()
            .serialize(&(RECIPE, &media, records[0]))
            .unwrap()
            .len() as u64;
        let limit =
            FILE_HEADER_BYTES + 2 * (RECORD_HEADER_BYTES + bytes + RECORD_COMMIT.len() as u64);
        let cancel = AtomicBool::new(false);
        let mut writer = Checkpoint {
            path: directory.clone(),
            media: media.clone(),
            limit,
        };
        for shot in &shots {
            writer.append(&[shot], &cancel).unwrap();
        }
        let files = shard_files(&directory);
        assert_eq!(files.len(), 3);
        assert!(files
            .iter()
            .all(|path| fs::metadata(path).unwrap().len() <= limit));
        let expected: Vec<_> = (0..5)
            .map(|i| vec![vector(i * 2), vector(i * 2 + 1)])
            .collect();
        assert_eq!(read(&root, &identity, &requests).unwrap(), expected);
        build(&root, &identity, &requests, &cancel, |_, _, _| {
            panic!("all sharded shots must be reusable")
        })
        .unwrap();
        let mut another = identity.clone();
        another.stream += 1;
        assert!(read(&root, &another, &requests[..1]).is_err());
        writer.media = MediaIdentity::of(&another);
        writer.append(&[&shots[0]], &cancel).unwrap();
        assert_eq!(path(&root, &writer.media).unwrap(), directory);
        assert_eq!(
            read(&root, &another, &requests[..1]).unwrap()[0],
            expected[0]
        );
        assert_eq!(read(&root, &identity, &requests).unwrap(), expected);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn load_decodes_only_requested_shots_and_append_keeps_unrelated_warm_records() {
        let root = cache_directory();
        let media = MediaIdentity::of(&identity(0, 100));
        let directory = path(&root, &media).unwrap();
        let requests: Vec<_> = (0..3).map(|i| request(i * 10, &[i * 10])).collect();
        let shots: Vec<_> = requests
            .iter()
            .enumerate()
            .map(|(i, request)| {
                let mut shot = ShotIndex::new(request);
                shot.vectors = vec![Some(vector(i))];
                shot.complete = true;
                shot
            })
            .collect();
        let mut writer = Checkpoint::new(&directory, &media);
        writer
            .append(&shots.iter().collect::<Vec<_>>(), &AtomicBool::new(false))
            .unwrap();
        let keys: Vec<_> = requests
            .iter()
            .map(|request| shot_key(&media, request.start_frame, request.end_frame).unwrap())
            .collect();
        let snapshots = storage::locate(&directory, &keys).unwrap();
        let tokens: Vec<_> = snapshots
            .into_iter()
            .map(|snapshot| snapshot.unwrap().token)
            .collect();
        assert_eq!(
            load(&directory, &media, &requests[..1])
                .unwrap()
                .shots
                .len(),
            1
        );
        let warm = WARM.get().unwrap();
        let decoded = warm.lock().unwrap().get(&tokens[0]).unwrap();
        assert!(warm.lock().unwrap().get(&tokens[1]).is_none());
        assert!(warm.lock().unwrap().get(&tokens[2]).is_none());
        writer
            .append(&[&shots[1]], &AtomicBool::new(false))
            .unwrap();
        let latest = storage::locate(&directory, &keys[..1])
            .unwrap()
            .pop()
            .unwrap()
            .unwrap();
        assert!(Arc::ptr_eq(
            &decoded,
            &warm.lock().unwrap().get(&latest.token).unwrap()
        ));
        assert_eq!(
            read(&root, &identity(0, 100), &requests).unwrap(),
            vec![vec![vector(0)], vec![vector(1)], vec![vector(2)]]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_middle_shot_then_append_preserves_later_healthy_shots() {
        for damage_payload in [false, true] {
            let root = cache_directory();
            let identity = identity(0, 100);
            let media = MediaIdentity::of(&identity);
            let directory = path(&root, &media).unwrap();
            let requests: Vec<_> = (0..4).map(|i| request(i * 10, &[i * 10])).collect();
            let shots: Vec<_> = requests
                .iter()
                .enumerate()
                .map(|(i, request)| {
                    let mut shot = ShotIndex::new(request);
                    shot.vectors = vec![Some(vector(i))];
                    shot.complete = true;
                    shot
                })
                .collect();
            let mut writer = Checkpoint::new(&directory, &media);
            writer
                .append(
                    &shots[..3].iter().collect::<Vec<_>>(),
                    &AtomicBool::new(false),
                )
                .unwrap();
            let middle_key = shot_key(&media, shots[1].start_frame, shots[1].end_frame).unwrap();
            let snapshot = storage::locate(&directory, &[middle_key])
                .unwrap()
                .pop()
                .unwrap()
                .unwrap();
            let record = storage::fixture_record(&snapshot);
            drop(snapshot);
            let file = shard_files(&directory).pop().unwrap();
            let mut output = fs::OpenOptions::new().write(true).open(&file).unwrap();
            let offset = if damage_payload {
                record.offset
            } else {
                record.offset - RECORD_HEADER_BYTES + 16
            };
            output.seek(SeekFrom::Start(offset)).unwrap();
            output.write_all(&[255]).unwrap();
            output.seek(SeekFrom::End(0)).unwrap();
            output.write_all(b"torn suffix").unwrap();
            drop(output);
            assert!(read(&root, &identity, &requests[1..2]).is_err());
            assert_eq!(
                read(&root, &identity, &requests[2..3]).unwrap(),
                vec![vec![vector(2)]]
            );
            writer
                .append(&[&shots[3]], &AtomicBool::new(false))
                .unwrap();
            assert_eq!(
                read(&root, &identity, &requests[2..]).unwrap(),
                vec![vec![vector(2)], vec![vector(3)]]
            );
            assert_eq!(
                read(&root, &identity, &requests[..1]).unwrap(),
                vec![vec![vector(0)]]
            );
            fs::remove_dir_all(root).unwrap();
        }
    }
}
