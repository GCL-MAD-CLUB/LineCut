//! Completed CSES source data, grouped by the existing media fingerprint.
//! Files are independent of panel IDs and source paths; no media is rehashed.
use super::storage::{self, SHARD_BYTES};
use super::*;
use bincode::Options;

const CACHE_REVISION: &str = "dinov3-cses-v1";
const MODEL_REVISION: &str =
    "dinov3-vits16plus-81f43e32cbf964b3c284da6cfd3be9fcba6d82ef-cls-l2-224";
const MAX_RECORD_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct ShotIdentity {
    pub(super) fingerprint: String,
    pub(super) media_length: u64,
    pub(super) media_modified_ns: Option<u128>,
    pub(super) stream: i32,
    pub(super) rate: f64,
    pub(super) start_frame: usize,
    pub(super) end_frame: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct ShotData {
    version: u32,
    recipe: String,
    model: String,
    pub(super) identity: ShotIdentity,
    // Provenance only. Reuse depends on media/stream/range, not these UI IDs.
    shot_id: String,
    source: String,
    pub(super) selection: cses::Selection,
}

static WARM: OnceLock<Mutex<storage::Warm<ShotData>>> = OnceLock::new();

pub(super) fn root(preferences: &Preferences) -> PathBuf {
    configured_cache_root(preferences).join("Storyboard Keyframe")
}

fn codec() -> impl Options {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(MAX_RECORD_BYTES)
        .reject_trailing_bytes()
}

fn media_directory(root: &Path, identity: &ShotIdentity) -> Option<PathBuf> {
    // A recipe/model change or new source-media version owns a separate log.
    // Streams/rates remain independent keys within the same media generation.
    let revision = codec()
        .serialize(&(
            CACHE_REVISION,
            MODEL_REVISION,
            identity.media_length,
            identity.media_modified_ns,
        ))
        .ok()?;
    storage::directory(root, &identity.fingerprint, &revision)
}

#[cfg(test)]
fn path(root: &Path, identity: &ShotIdentity) -> Option<PathBuf> {
    storage::shards(&media_directory(root, identity)?)
        .into_iter()
        .next()
}

fn record_key(identity: &ShotIdentity) -> [u8; 32] {
    // This hashes a small identity tuple, never the media file or its vectors.
    let mut hash = Sha256::new();
    hash.update(CACHE_REVISION.as_bytes());
    hash.update(MODEL_REVISION.as_bytes());
    hash.update(identity.fingerprint.as_bytes());
    hash.update(identity.media_length.to_le_bytes());
    hash.update([u8::from(identity.media_modified_ns.is_some())]);
    hash.update(identity.media_modified_ns.unwrap_or_default().to_le_bytes());
    hash.update(identity.stream.to_le_bytes());
    hash.update(identity.rate.to_bits().to_le_bytes());
    hash.update((identity.start_frame as u64).to_le_bytes());
    hash.update((identity.end_frame as u64).to_le_bytes());
    hash.finalize().into()
}

fn valid(data: &ShotData, identity: &ShotIdentity) -> bool {
    let Some(count) = identity
        .end_frame
        .checked_sub(identity.start_frame)
        .and_then(|n| n.checked_add(1))
    else {
        return false;
    };
    if !identity.rate.is_finite() || identity.rate <= 0.0 {
        return false;
    }
    let expected = cses::Parameters::for_shot(count, identity.rate);
    let selection = &data.selection;
    if data.version != 1
        || data.recipe != CACHE_REVISION
        || data.model != MODEL_REVISION
        || &data.identity != identity
        || selection.parameters != expected
        || selection.frames.len() < expected.probes
        || selection.frames.len() > expected.scored
    {
        return false;
    }
    let mut observed = HashSet::new();
    let mut selected = 0;
    for (i, frame) in selection.frames.iter().enumerate() {
        if frame.frame < identity.start_frame
            || frame.frame > identity.end_frame
            || !observed.insert(frame.frame)
            || frame.probe != (i < expected.probes)
            || !frame.v_i.is_finite()
            || !(0.0..=1.0).contains(&frame.v_i)
            || frame.e_i.len() != DIMENSIONS
            || frame.e_i.iter().any(|v| !v.is_finite())
        {
            return false;
        }
        let norm: f64 = frame.e_i.iter().map(|&v| f64::from(v).powi(2)).sum();
        if (norm - 1.0).abs() > 0.001 {
            return false;
        }
        selected += usize::from(frame.selected);
    }
    let calibration = &selection.calibration;
    selected > 0
        && selected <= expected.selected
        && [
            calibration.background_median,
            calibration.background_mad,
            calibration.initial_peak,
            calibration.final_peak,
        ]
        .iter()
        .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
        && [calibration.initial_bandwidth, calibration.final_bandwidth]
            .iter()
            .all(|v| v.is_finite() && (1.0..=expected.bandwidth_max).contains(v))
}

fn load_data(root: &Path, identity: &ShotIdentity) -> Option<Arc<ShotData>> {
    let directory = media_directory(root, identity)?;
    let snapshot = storage::locate(&directory, &[record_key(identity)])?.pop()??;
    let cache = WARM.get_or_init(Default::default);
    if let Some(data) = cache.lock().ok()?.get(&snapshot.token) {
        return Some(data);
    }
    let token = snapshot.token.clone();
    // The media lock was released by locate; verification precedes decoding.
    let bytes = snapshot.read()?;
    let data = Arc::new(codec().deserialize::<ShotData>(&bytes).ok()?);
    let footprint =
        bytes.len() + data.selection.frames.len() * std::mem::size_of::<cses::EncodedFrame>();
    if let Ok(mut cache) = cache.lock() {
        cache.insert(token, Arc::clone(&data), footprint);
    }
    Some(data)
}

pub(super) fn read(root: &Path, identity: &ShotIdentity) -> Option<Arc<ShotData>> {
    let data = load_data(root, identity)?;
    valid(&data, identity).then_some(data)
}

fn write(root: &Path, data: &ShotData, cancel: &AtomicBool) -> AppResult<()> {
    write_with_limit(root, data, cancel, SHARD_BYTES)
}

fn write_with_limit(
    root: &Path,
    data: &ShotData,
    cancel: &AtomicBool,
    limit: u64,
) -> AppResult<()> {
    let directory = media_directory(root, &data.identity)
        .ok_or_else(|| inference_error("Invalid keyframe media fingerprint"))?;
    let bytes = codec().serialize(data).map_err(inference_error)?;
    storage::append(
        &directory,
        record_key(&data.identity),
        &bytes,
        cancel,
        limit,
    )
    .map_err(|error| {
        if error.is(ErrorCode::TaskCancelled) {
            error
        } else {
            app_error(ErrorCode::StoryboardKeyframeWriteFailed, error.to_string())
        }
    })
}

#[cfg(test)]
pub(super) fn get_or_build(
    root: &Path,
    source: &ShotSource,
    cancel: &AtomicBool,
    build: impl FnOnce(&HashMap<usize, Vec<f32>>) -> AppResult<cses::Selection>,
) -> AppResult<Arc<ShotData>> {
    ensure_not_cancelled(cancel)?;
    if let Some(data) = read(root, &source.identity) {
        return Ok(data);
    }
    let data = prepare(root, source, cancel, build)?;
    commit(root, &data, cancel)?;
    Ok(data)
}

pub(super) fn commit(root: &Path, data: &ShotData, cancel: &AtomicBool) -> AppResult<()> {
    write(root, data, cancel)
}

// Selection may consume RGB before its merged decoder exits. The caller commits
// this completed record only after validating that decoder's successful exit.
pub(super) fn prepare(
    root: &Path,
    source: &ShotSource,
    cancel: &AtomicBool,
    build: impl FnOnce(&HashMap<usize, Vec<f32>>) -> AppResult<cses::Selection>,
) -> AppResult<Arc<ShotData>> {
    ensure_not_cancelled(cancel)?;
    if let Some(data) = read(root, &source.identity) {
        return Ok(data);
    }
    let available = reusable_vectors(root, &source.identity);
    tracing::debug!(fingerprint = %source.identity.fingerprint,
        media_length = source.identity.media_length,
        media_modified_ns = ?source.identity.media_modified_ns,
        recipe = CACHE_REVISION, start_frame = source.identity.start_frame,
        end_frame = source.identity.end_frame, reusable_vectors = available.len(),
        "Building missing or invalid storyboard selection");
    let mut selection = build(&available)?;
    ensure_not_cancelled(cancel)?;
    for frame in &mut selection.frames {
        frame.frame += source.shot.start_frame;
    }
    let data = ShotData {
        version: 1,
        recipe: CACHE_REVISION.into(),
        model: MODEL_REVISION.into(),
        identity: source.identity.clone(),
        shot_id: source.shot.id.clone(),
        source: source.shot.source.clone(),
        selection,
    };
    if !valid(&data, &source.identity) {
        return Err(inference_error(
            "Invalid completed storyboard keyframe source",
        ));
    }
    Ok(Arc::new(data))
}

fn reusable_vectors(root: &Path, identity: &ShotIdentity) -> HashMap<usize, Vec<f32>> {
    let mut vectors = HashMap::new();
    if let Some(data) = load_data(root, identity) {
        if data.version != 1
            || data.model != MODEL_REVISION
            || data.recipe != CACHE_REVISION
            || data.identity != *identity
        {
            return vectors;
        }
        let mut duplicates = HashSet::new();
        for frame in &data.selection.frames {
            if frame.frame < identity.start_frame
                || frame.frame > identity.end_frame
                || frame.e_i.len() != DIMENSIONS
                || frame.e_i.iter().any(|v| !v.is_finite())
                || (frame.e_i.iter().map(|&v| f64::from(v).powi(2)).sum::<f64>() - 1.0).abs()
                    > 0.001
                || duplicates.contains(&frame.frame)
            {
                continue;
            }
            if vectors.insert(frame.frame, frame.e_i.clone()).is_some() {
                vectors.remove(&frame.frame);
                duplicates.insert(frame.frame);
            }
        }
        // Use the newest decodable snapshot. Invalid scores, flags or a missing
        // vector do not require re-encoding its other valid image embeddings.
    }
    vectors
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::{Seek, SeekFrom, Write};
    use storage::{
        sequence as shard_sequence, shards, FILE_HEADER_BYTES, RECORD_COMMIT, RECORD_HEADER_BYTES,
    };

    fn invalidate(_path: &Path) {
        *WARM.get_or_init(Default::default).lock().unwrap() = storage::Warm::default();
    }

    fn overwrite_record(file: &Path, data: &ShotData) {
        storage::overwrite_fixture(
            file,
            record_key(&data.identity),
            &codec().serialize(data).unwrap(),
        );
    }

    struct TestRoot(PathBuf);
    impl TestRoot {
        fn new() -> Self {
            Self(env::temp_dir().join(format!("locution-pro-keyframe-test-{}", Uuid::new_v4())))
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            assert_eq!(self.0.parent(), Some(env::temp_dir().as_path()));
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn source() -> ShotSource {
        let fingerprint = "a".repeat(64);
        ShotSource {
            shot: SemanticShot {
                id: "shot-1".into(),
                source: "source-1".into(),
                asset_id: "asset-1".into(),
                fingerprint: fingerprint.clone(),
                start_frame: 100,
                end_frame: 1099,
            },
            identity: ShotIdentity {
                fingerprint,
                media_length: 123456,
                media_modified_ns: Some(1234567890),
                stream: 0,
                rate: 25.0,
                start_frame: 100,
                end_frame: 1099,
            },
            path: "original.mp4".into(),
            stream: 0,
            rate: 25.0,
            frames: 1000,
        }
    }

    fn select_fixture(source: &ShotSource, cancel: &AtomicBool) -> AppResult<cses::Selection> {
        cses::select(source.frames, source.rate, cancel, |positions| {
            Ok((
                positions
                    .iter()
                    .map(|&frame| {
                        let mut vector = vec![0.0; DIMENSIONS];
                        vector[frame % DIMENSIONS] = 1.0;
                        vector
                    })
                    .collect(),
                vec![1.0; positions.len()],
            ))
        })
    }

    #[test]
    fn validated_media_metadata_reuses_existing_nanosecond_cache_without_encoding() {
        let fixture = TestRoot::new();
        let mut source = source();
        let cancel = AtomicBool::new(false);
        let cached = get_or_build(&fixture.0, &source, &cancel, |_| {
            select_fixture(&source, &cancel)
        })
        .unwrap();
        let original_identity = source.identity.clone();
        let original_directory = media_directory(&fixture.0, &original_identity).unwrap();
        let original_key = record_key(&original_identity);
        let modified = Duration::from_nanos(original_identity.media_modified_ns.unwrap() as u64);
        source.identity.media_modified_ns = canonical_media_timestamp(
            source.identity.media_length as i64,
            modified.as_secs() as i64,
            source.identity.media_length,
            modified,
        )
        .unwrap();
        assert_eq!(source.identity, original_identity);
        assert_eq!(
            media_directory(&fixture.0, &source.identity).unwrap(),
            original_directory
        );
        assert_eq!(record_key(&source.identity), original_key);
        let reused = get_or_build(&fixture.0, &source, &cancel, |_| {
            panic!("existing cache must not encode again")
        })
        .unwrap();
        assert_eq!(*reused, *cached);
    }

    #[test]
    fn prepared_selection_is_not_published_until_decoder_validation_and_commit() {
        let fixture = TestRoot::new();
        let source = source();
        let cancel = AtomicBool::new(false);
        let data = prepare(&fixture.0, &source, &cancel, |_| {
            select_fixture(&source, &cancel)
        })
        .unwrap();
        assert!(read(&fixture.0, &source.identity).is_none());
        assert!(!fixture.0.exists());
        commit(&fixture.0, &data, &cancel).unwrap();
        assert_eq!(*read(&fixture.0, &source.identity).unwrap(), *data);
        // A later build adopts this exact selection, without another sample.
        let reused = prepare(&fixture.0, &source, &cancel, |_| {
            panic!("must reuse completed selection")
        })
        .unwrap();
        assert_eq!(*reused, *data);
    }

    #[test]
    fn persisted_source_round_trips_all_frames_and_reuses_selected_flags() {
        let fixture = TestRoot::new();
        let source = source();
        let cancel = AtomicBool::new(false);
        let data = get_or_build(&fixture.0, &source, &cancel, |_| {
            select_fixture(&source, &cancel)
        })
        .unwrap();
        let file = path(&fixture.0, &source.identity).unwrap();
        assert_eq!(
            file.parent().unwrap(),
            media_directory(&fixture.0, &source.identity).unwrap()
        );
        assert!(shard_sequence(&file).is_some());
        let disk = (*load_data(&fixture.0, &source.identity).unwrap()).clone();
        assert_eq!(disk, *data);
        assert!(disk.selection.frames.iter().any(|frame| !frame.selected));
        assert!(disk.selection.frames.iter().all(|frame| frame.frame >= 100
            && frame.frame <= 1099
            && frame.e_i.len() == DIMENSIONS));
        for frame in &disk.selection.frames {
            assert_eq!(frame.e_i[(frame.frame - 100) % DIMENSIONS], 1.0);
        }
        // Simulate reopening under a different panel, asset ID and file path.
        // Also drop the warm entry: the persisted file is sufficient on its own.
        invalidate(&file);
        let mut reopened = self::source();
        reopened.shot.id = "another-shot-id".into();
        reopened.shot.source = "another-panel-scope".into();
        reopened.shot.asset_id = "another-asset-id".into();
        reopened.path = "moved.mp4".into();
        let cached = get_or_build(&fixture.0, &reopened, &cancel, |_| {
            panic!("cache reuse must not decode, embed or replay CSES")
        })
        .unwrap();
        assert_eq!(
            cached.selection.selected_frames(),
            data.selection.selected_frames()
        );
        assert_eq!(cached.selection, data.selection);
        // A changed preferences cache root cannot reuse the old warm entry.
        assert!(read(&fixture.0.join("other-root"), &reopened.identity).is_none());
    }

    #[test]
    fn media_range_stream_rate_and_stamp_changes_invalidate_cached_source() {
        let fixture = TestRoot::new();
        let source = source();
        let cancel = AtomicBool::new(false);
        get_or_build(&fixture.0, &source, &cancel, |_| {
            select_fixture(&source, &cancel)
        })
        .unwrap();
        for variant in 0..6 {
            let mut identity = source.identity.clone();
            match variant {
                0 => identity.fingerprint = "b".repeat(64),
                1 => identity.start_frame += 1,
                2 => identity.end_frame += 1,
                3 => identity.stream += 1,
                4 => identity.rate = 30.0,
                _ => identity.media_modified_ns = Some(2),
            }
            assert!(read(&fixture.0, &identity).is_none(), "variant={variant}");
        }
        let mut invalid = source.identity.clone();
        invalid.fingerprint = "../outside".into();
        assert!(path(&fixture.0, &invalid).is_none());
    }

    #[test]
    fn invalid_or_truncated_sources_are_rebuilt_instead_of_being_reused() {
        let fixture = TestRoot::new();
        let source = source();
        let cancel = AtomicBool::new(false);
        let data = get_or_build(&fixture.0, &source, &cancel, |_| {
            select_fixture(&source, &cancel)
        })
        .unwrap();
        let file = path(&fixture.0, &source.identity).unwrap();
        for variant in 0..9 {
            let mut broken = (*data).clone();
            match variant {
                0 => broken.model = "obsolete-model".into(),
                1 => broken.recipe = "obsolete-recipe".into(),
                2 => broken.selection.frames[0].v_i = f64::NAN,
                3 => broken.selection.frames[0].e_i[0] = f32::NAN,
                4 => {
                    broken.selection.frames[0].e_i.pop();
                }
                5 => broken.selection.frames[0].frame = source.shot.end_frame + 1,
                6 => {
                    let frame = broken.selection.frames[0].frame;
                    broken.selection.frames[1].frame = frame;
                }
                7 => {
                    for frame in &mut broken.selection.frames {
                        frame.selected = false;
                    }
                }
                _ => broken.selection.calibration.final_bandwidth = f64::NAN,
            }
            invalidate(&file);
            overwrite_record(&file, &broken);
            assert!(
                read(&fixture.0, &source.identity).is_none(),
                "variant={variant}"
            );
        }
        fs::write(&file, b"truncated").unwrap();
        let mut rebuilt = false;
        let repaired = get_or_build(&fixture.0, &source, &cancel, |_| {
            rebuilt = true;
            select_fixture(&source, &cancel)
        })
        .unwrap();
        assert!(rebuilt);
        assert_eq!(repaired.selection, data.selection);
        assert!(read(&fixture.0, &source.identity).is_some());
        assert_eq!(
            fs::read_dir(file.parent().unwrap()).unwrap().count(),
            1,
            "no temporary files remain"
        );
    }

    #[test]
    fn cancellation_never_publishes_partial_source_data() {
        let fixture = TestRoot::new();
        let source = source();
        let cancel = AtomicBool::new(false);
        let result = get_or_build(&fixture.0, &source, &cancel, |_| {
            let selection = select_fixture(&source, &cancel)?;
            cancel.store(true, Ordering::SeqCst);
            Ok(selection)
        });
        assert!(result.is_err());
        assert!(!fixture.0.exists());
        assert!(read(&fixture.0, &source.identity).is_none());
    }

    #[test]
    fn cancelled_storage_write_preserves_the_cancellation_error_and_previous_record() {
        let fixture = TestRoot::new();
        let source = source();
        let cancel = AtomicBool::new(false);
        let data = get_or_build(&fixture.0, &source, &cancel, |_| {
            select_fixture(&source, &cancel)
        })
        .unwrap();
        cancel.store(true, Ordering::SeqCst);
        let error = write(&fixture.0, &data, &cancel).unwrap_err();
        assert!(error.is(ErrorCode::TaskCancelled));
        assert_eq!(*read(&fixture.0, &source.identity).unwrap(), *data);
    }

    #[test]
    fn media_uses_one_file_for_many_shots_and_recovers_an_incomplete_tail() {
        let fixture = TestRoot::new();
        let cancel = AtomicBool::new(false);
        let mut sources: Vec<ShotSource> = Vec::new();
        let mut selections: Vec<Vec<usize>> = Vec::new();
        for i in 0..3 {
            let mut source = source();
            source.shot.id = format!("shot-{i}");
            source.shot.start_frame += i * 1000;
            source.shot.end_frame += i * 1000;
            source.identity.start_frame = source.shot.start_frame;
            source.identity.end_frame = source.shot.end_frame;
            if i == 2 {
                let file = path(&fixture.0, &source.identity).unwrap();
                // A crash after record length/payload but before the commit.
                let mut writer = fs::OpenOptions::new().append(true).open(&file).unwrap();
                writer.write_all(&1234u64.to_le_bytes()).unwrap();
                writer.write_all(b"unfinished").unwrap();
                drop(writer);
                invalidate(&file);
                for (source, selected) in sources.iter().zip(&selections) {
                    assert_eq!(
                        read(&fixture.0, &source.identity)
                            .unwrap()
                            .selection
                            .selected_frames(),
                        *selected
                    );
                }
            }
            let data = get_or_build(&fixture.0, &source, &cancel, |_| {
                select_fixture(&source, &cancel)
            })
            .unwrap();
            selections.push(data.selection.selected_frames());
            sources.push(source);
            assert_eq!(
                shards(
                    path(&fixture.0, &sources[0].identity)
                        .unwrap()
                        .parent()
                        .unwrap()
                )
                .len(),
                1
            );
        }
        let file = path(&fixture.0, &sources[0].identity).unwrap();
        invalidate(&file);
        for (source, selected) in sources.iter().zip(selections) {
            let data = get_or_build(&fixture.0, source, &cancel, |_| {
                panic!("all shots must survive in the media file")
            })
            .unwrap();
            assert_eq!(data.selection.selected_frames(), selected);
        }
        assert!(fs::metadata(&file).unwrap().len() > FILE_HEADER_BYTES);
    }

    #[test]
    fn large_media_rotates_shards_by_size() {
        let fixture = TestRoot::new();
        let source = source();
        let cancel = AtomicBool::new(false);
        let first = get_or_build(&fixture.0, &source, &cancel, |_| {
            select_fixture(&source, &cancel)
        })
        .unwrap();
        let length = codec().serialize(&*first).unwrap().len() as u64;
        let limit =
            FILE_HEADER_BYTES + 2 * (RECORD_HEADER_BYTES + length + RECORD_COMMIT.len() as u64);
        let mut expected = vec![(*first).clone()];
        for i in 1..3 {
            let mut data = (*first).clone();
            data.identity.start_frame += i * 1000;
            data.identity.end_frame += i * 1000;
            for frame in &mut data.selection.frames {
                frame.frame += i * 1000;
            }
            write_with_limit(&fixture.0, &data, &cancel, limit).unwrap();
            expected.push(data);
        }
        let directory = media_directory(&fixture.0, &source.identity).unwrap();
        let files = shards(&directory);
        assert_eq!(files.len(), 2);
        assert_eq!(shard_sequence(&files[0]), Some(0));
        assert_eq!(shard_sequence(&files[1]), Some(1));
        for file in &files {
            assert!(shard_sequence(file).is_some());
        }
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);
        for file in &files {
            assert!(fs::metadata(file).unwrap().len() <= limit);
            invalidate(file);
        }
        for data in expected {
            assert_eq!(*read(&fixture.0, &data.identity).unwrap(), data);
        }
    }

    #[test]
    fn repairs_only_missing_embeddings_and_reuses_other_frame_vectors() {
        let fixture = TestRoot::new();
        let source = source();
        let cancel = AtomicBool::new(false);
        let first = get_or_build(&fixture.0, &source, &cancel, |_| {
            select_fixture(&source, &cancel)
        })
        .unwrap();
        let file = path(&fixture.0, &source.identity).unwrap();
        for scores_only in [false, true] {
            let mut partial = (*first).clone();
            let mut expected_missing = Vec::new();
            if scores_only {
                partial.selection.frames[0].v_i = f64::NAN;
            } else {
                expected_missing.push(partial.selection.frames[3].frame - source.shot.start_frame);
                partial.selection.frames[3].e_i[0] = f32::NAN;
                expected_missing
                    .push(partial.selection.frames.remove(7).frame - source.shot.start_frame);
            }
            overwrite_record(&file, &partial);
            invalidate(&file);
            let mut encoded = Vec::new();
            let repaired = get_or_build(&fixture.0, &source, &cancel, |available| {
                cses::select(source.frames, source.rate, &cancel, |positions| {
                    let vectors =
                        encode_missing(positions, source.shot.start_frame, available, |missing| {
                            encoded.extend_from_slice(missing);
                            Ok(missing
                                .iter()
                                .map(|frame| {
                                    let mut vector = vec![0.0; DIMENSIONS];
                                    vector[frame % DIMENSIONS] = 1.0;
                                    vector
                                })
                                .collect())
                        })?;
                    Ok((vectors, vec![1.0; positions.len()]))
                })
            })
            .unwrap();
            assert_eq!(encoded, expected_missing);
            assert_eq!(repaired.selection, first.selection);
        }
    }

    #[test]
    fn a_damaged_middle_record_does_not_hide_later_healthy_shots() {
        let fixture = TestRoot::new();
        let source = source();
        let cancel = AtomicBool::new(false);
        let first = get_or_build(&fixture.0, &source, &cancel, |_| {
            select_fixture(&source, &cancel)
        })
        .unwrap();
        let mut saved = vec![(*first).clone()];
        for i in 1..3 {
            let mut data = (*first).clone();
            data.identity.start_frame += i * 1000;
            data.identity.end_frame += i * 1000;
            for frame in &mut data.selection.frames {
                frame.frame += i * 1000;
            }
            write(&fixture.0, &data, &cancel).unwrap();
            saved.push(data);
        }
        let file = path(&fixture.0, &source.identity).unwrap();
        let snapshot = storage::locate(file.parent().unwrap(), &[record_key(&saved[1].identity)])
            .unwrap()
            .pop()
            .unwrap()
            .unwrap();
        let damaged = storage::fixture_record(&snapshot);
        drop(snapshot);
        let mut writer = fs::OpenOptions::new().write(true).open(&file).unwrap();
        writer
            .seek(SeekFrom::Start(damaged.offset - RECORD_HEADER_BYTES))
            .unwrap();
        writer
            .write_all(&[0; RECORD_HEADER_BYTES as usize])
            .unwrap();
        drop(writer);
        invalidate(&file);
        assert_eq!(*read(&fixture.0, &saved[0].identity).unwrap(), saved[0]);
        assert!(read(&fixture.0, &saved[1].identity).is_none());
        assert_eq!(*read(&fixture.0, &saved[2].identity).unwrap(), saved[2]);
        write(&fixture.0, &saved[1], &cancel).unwrap();
        for data in saved {
            assert_eq!(*read(&fixture.0, &data.identity).unwrap(), data);
        }
    }
}
