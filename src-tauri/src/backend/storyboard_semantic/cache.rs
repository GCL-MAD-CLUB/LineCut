//! Completed CSES source data, grouped by the existing media fingerprint.
//! Files are independent of panel IDs and source paths; no media is rehashed.
use super::*;
use bincode::Options;
use std::collections::VecDeque;
use std::io::Write;

const CACHE_REVISION: &str = "dinov3-cses-v1";
const MODEL_REVISION: &str =
    "dinov3-vits16plus-81f43e32cbf964b3c284da6cfd3be9fcba6d82ef-cls-l2-224";
const MAX_RECORD_BYTES: u64 = 2 * 1024 * 1024;
const MEMORY_BYTES: usize = 32 * 1024 * 1024;
const SHARD_BYTES: u64 = 256 * 1024 * 1024;
const FILE_MAGIC: &[u8; 8] = b"LCKF0002";
const FILE_HEADER_BYTES: u64 = 16;
const RECORD_COMMIT: &[u8; 8] = b"LCKFDONE";
const RECORD_MAGIC: &[u8; 8] = b"LCKFSHOT";
const RECORD_HEADER_BYTES: u64 = 48;

#[derive(Clone, Copy)]
struct Record {
    offset: u64,
    length: u64,
}

struct MediaIndex {
    path: PathBuf,
    stamp: (u64, SystemTime),
    valid_end: u64,
    records: HashMap<[u8; 32], Record>,
}

// Offsets let a media contain many shots without loading/re-writing its vectors.
// The same lock also serializes append/repair against readers in this process.
static INDEXES: Mutex<VecDeque<MediaIndex>> = Mutex::new(VecDeque::new());

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

struct WarmShot {
    path: PathBuf,
    key: [u8; 32],
    offset: u64,
    data: Arc<ShotData>,
    bytes: usize,
}

#[derive(Default)]
struct WarmShots {
    entries: VecDeque<WarmShot>,
    bytes: usize,
}

static WARM: OnceLock<Mutex<WarmShots>> = OnceLock::new();

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
    if identity.fingerprint.len() != 64
        || !identity.fingerprint.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return None;
    }
    Some(root.join(&identity.fingerprint))
}

fn shard_sequence(path: &Path) -> Option<u64> {
    let mut file = fs::File::open(path).ok()?;
    let mut header = [0u8; FILE_HEADER_BYTES as usize];
    file.read_exact(&mut header).ok()?;
    if &header[..8] != FILE_MAGIC {
        return None;
    }
    let mut sequence = [0u8; 8];
    sequence.copy_from_slice(&header[8..]);
    Some(u64::from_le_bytes(sequence))
}

#[cfg(test)]
fn path(root: &Path, identity: &ShotIdentity) -> Option<PathBuf> {
    shards(&media_directory(root, identity)?).into_iter().next()
}

fn shards(directory: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            if !entry.file_type().ok()?.is_file() {
                return None;
            }
            let name = entry.file_name();
            let stem = name.to_str()?.strip_suffix(".bin")?;
            Uuid::parse_str(stem).ok()?;
            let path = entry.path();
            Some((shard_sequence(&path).unwrap_or_default(), path))
        })
        .collect();
    files.sort_unstable_by(|(a, ap), (b, bp)| a.cmp(b).then(ap.cmp(bp)));
    files.into_iter().map(|(_, path)| path).collect()
}

fn record_key(identity: &ShotIdentity) -> [u8; 32] {
    // This hashes a small identity tuple, never the media file or its vectors.
    let mut hash = Sha256::new();
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

fn invalidate_warm(path: &Path) {
    if let Some(cache) = WARM.get() {
        if let Ok(mut cache) = cache.lock() {
            cache.entries.retain(|entry| entry.path != path);
            cache.bytes = cache.entries.iter().map(|entry| entry.bytes).sum();
        }
    }
}

// Scan only record headers and commit markers; seek over vector payloads.
// A torn tail does not hide earlier completed records.
fn scan(path: &Path, stamp: (u64, SystemTime)) -> Option<MediaIndex> {
    let mut index = MediaIndex {
        path: path.into(),
        stamp,
        valid_end: 0,
        records: HashMap::new(),
    };
    let mut file = fs::File::open(path).ok()?;
    let mut header = [0u8; FILE_HEADER_BYTES as usize];
    if file.read_exact(&mut header).is_err() || &header[..8] != FILE_MAGIC {
        let Some(next) = next_record(&mut file, 0) else {
            return Some(index);
        };
        index.valid_end = next;
        file.seek(SeekFrom::Start(next)).ok()?;
    } else {
        index.valid_end = FILE_HEADER_BYTES;
    }
    while index.valid_end < stamp.0 {
        let mut header = [0u8; RECORD_HEADER_BYTES as usize];
        if file.read_exact(&mut header).is_err() {
            break;
        }
        let mut length = [0u8; 8];
        length.copy_from_slice(&header[8..16]);
        let length = u64::from_le_bytes(length);
        if &header[..8] != RECORD_MAGIC || length == 0 || length > MAX_RECORD_BYTES {
            if let Some(next) = next_record(&mut file, index.valid_end + 1) {
                index.valid_end = next;
                file.seek(SeekFrom::Start(next)).ok()?;
                continue;
            }
            break;
        }
        let offset = index.valid_end.checked_add(RECORD_HEADER_BYTES)?;
        let footer = offset.checked_add(length)?;
        let end = footer.checked_add(RECORD_COMMIT.len() as u64)?;
        if end > stamp.0 {
            if let Some(next) = next_record(&mut file, index.valid_end + 1) {
                index.valid_end = next;
                file.seek(SeekFrom::Start(next)).ok()?;
                continue;
            }
            break;
        }
        file.seek(SeekFrom::Start(footer)).ok()?;
        let mut commit = [0u8; 8];
        if file.read_exact(&mut commit).is_err() || &commit != RECORD_COMMIT {
            if let Some(next) = next_record(&mut file, index.valid_end + 1) {
                index.valid_end = next;
                file.seek(SeekFrom::Start(next)).ok()?;
                continue;
            }
            break;
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&header[16..]);
        index.records.insert(key, Record { offset, length });
        index.valid_end = end;
    }
    Some(index)
}

fn next_record(file: &mut fs::File, start: u64) -> Option<u64> {
    file.seek(SeekFrom::Start(start)).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut window = 0u64;
    let target = u64::from_be_bytes(*RECORD_MAGIC);
    for (i, byte) in reader.bytes().enumerate() {
        window = (window << 8) | u64::from(byte.ok()?);
        if i >= 7 && window == target {
            return Some(start + i as u64 - 7);
        }
    }
    None
}

fn index_for(indexes: &mut VecDeque<MediaIndex>, path: &Path) -> Option<usize> {
    let metadata = fs::metadata(&path).ok()?;
    let stamp = (metadata.len(), metadata.modified().ok()?);
    if let Some(position) = indexes.iter().position(|index| index.path == path) {
        if indexes[position].stamp == stamp {
            let index = indexes.remove(position)?;
            indexes.push_back(index);
            return Some(indexes.len() - 1);
        }
        indexes.remove(position);
    }
    // External changes require fresh offsets and invalidate payloads warmed
    // before that change. Our own appends update the index without rescanning.
    invalidate_warm(path);
    let index = scan(path, stamp)?;
    while indexes.len() >= 8 {
        indexes.pop_front();
    }
    indexes.push_back(index);
    Some(indexes.len() - 1)
}

fn read_record(path: &Path, record: Record) -> Option<ShotData> {
    let mut file = fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(record.offset)).ok()?;
    let mut bytes = vec![0; record.length as usize];
    file.read_exact(&mut bytes).ok()?;
    codec().deserialize(&bytes).ok()
}

pub(super) fn read(root: &Path, identity: &ShotIdentity) -> Option<Arc<ShotData>> {
    let directory = media_directory(root, identity)?;
    let key = record_key(identity);
    let mut indexes = INDEXES.lock().ok()?;
    // Newer shards/records win. Missing shots require only small offset indexes,
    // not deserialization of other shots' vectors.
    let (path, record) = shards(&directory).into_iter().rev().find_map(|path| {
        let position = index_for(&mut indexes, &path)?;
        let record = *indexes[position].records.get(&key)?;
        Some((path, record))
    })?;
    let cache = WARM.get_or_init(Default::default);
    if let Ok(mut cache) = cache.lock() {
        if let Some(position) = cache
            .entries
            .iter()
            .position(|entry| entry.path == path && entry.key == key)
        {
            let entry = cache.entries.remove(position)?;
            cache.bytes -= entry.bytes;
            if entry.offset == record.offset && entry.data.identity == *identity {
                let data = Arc::clone(&entry.data);
                cache.bytes += entry.bytes;
                cache.entries.push_back(entry);
                return Some(data);
            }
        }
    }
    let data = read_record(&path, record)?;
    if !valid(&data, identity) {
        tracing::warn!(path = %path.display(), "Invalid storyboard keyframe source will be rebuilt");
        return None;
    }
    let footprint = record.length as usize
        + data.selection.frames.len() * std::mem::size_of::<cses::EncodedFrame>();
    let data = Arc::new(data);
    if footprint <= MEMORY_BYTES {
        if let Ok(mut cache) = cache.lock() {
            if let Some(position) = cache
                .entries
                .iter()
                .position(|entry| entry.path == path && entry.key == key)
            {
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
            cache.entries.push_back(WarmShot {
                path,
                key,
                offset: record.offset,
                data: Arc::clone(&data),
                bytes: footprint,
            });
        }
    }
    Some(data)
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
    let io_error = |error: std::io::Error| {
        app_error(
            ErrorCode::StoryboardKeyframeWriteFailed,
            format!(
                "Cannot write storyboard keyframe source {}: {error}",
                directory.display()
            ),
        )
    };
    ensure_not_cancelled(cancel)?;
    let mut indexes = INDEXES.lock().map_err(inference_error)?;
    fs::create_dir_all(&directory).map_err(io_error)?;
    let mut path = shards(&directory)
        .pop()
        .unwrap_or_else(|| directory.join(format!("{}.bin", Uuid::new_v4())));
    let mut sequence = shard_sequence(&path).unwrap_or_default();
    if let Some(position) = index_for(&mut indexes, &path) {
        let current = &indexes[position];
        if current.valid_end > FILE_HEADER_BYTES
            && current.valid_end.saturating_add(
                RECORD_HEADER_BYTES + bytes.len() as u64 + RECORD_COMMIT.len() as u64,
            ) > limit
        {
            sequence = sequence
                .checked_add(1)
                .ok_or_else(|| inference_error("Keyframe shard sequence overflow"))?;
            path = directory.join(format!("{}.bin", Uuid::new_v4()));
        }
    }
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(io_error)?;
    let position = index_for(&mut indexes, &path)
        .ok_or_else(|| inference_error("Cannot read keyframe media index"))?;
    let index = &mut indexes[position];
    // Discard only a previously incomplete suffix. Completed shots stay intact.
    file.set_len(index.valid_end).map_err(io_error)?;
    file.seek(SeekFrom::Start(index.valid_end))
        .map_err(io_error)?;
    if index.valid_end == 0 {
        file.write_all(FILE_MAGIC).map_err(io_error)?;
        file.write_all(&sequence.to_le_bytes()).map_err(io_error)?;
        index.valid_end = FILE_HEADER_BYTES;
    }
    let start = index.valid_end;
    let key = record_key(&data.identity);
    let outcome = (|| {
        file.write_all(RECORD_MAGIC).map_err(io_error)?;
        file.write_all(&(bytes.len() as u64).to_le_bytes())
            .map_err(io_error)?;
        file.write_all(&key).map_err(io_error)?;
        file.write_all(&bytes).map_err(io_error)?;
        ensure_not_cancelled(cancel)?;
        file.write_all(RECORD_COMMIT).map_err(io_error)?;
        file.flush().map_err(io_error)?;
        Ok(())
    })();
    if outcome.is_err() {
        let _ = file.set_len(start);
    } else {
        index.records.insert(
            key,
            Record {
                offset: start + RECORD_HEADER_BYTES,
                length: bytes.len() as u64,
            },
        );
        index.valid_end =
            start + RECORD_HEADER_BYTES + bytes.len() as u64 + RECORD_COMMIT.len() as u64;
    }
    let metadata = file.metadata().map_err(io_error)?;
    index.stamp = (metadata.len(), metadata.modified().map_err(io_error)?);
    outcome
}

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
    let available = reusable_vectors(root, &source.identity);
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
    write(root, &data, cancel)?;
    Ok(Arc::new(data))
}

fn reusable_vectors(root: &Path, identity: &ShotIdentity) -> HashMap<usize, Vec<f32>> {
    let mut vectors = HashMap::new();
    let Some(directory) = media_directory(root, identity) else {
        return vectors;
    };
    let Ok(mut indexes) = INDEXES.lock() else {
        return vectors;
    };
    let key = record_key(identity);
    for path in shards(&directory).into_iter().rev() {
        let Some(position) = index_for(&mut indexes, &path) else {
            continue;
        };
        let Some(record) = indexes[position].records.get(&key).copied() else {
            continue;
        };
        let Some(data) = read_record(&path, record) else {
            continue;
        };
        if data.version != 1 || data.model != MODEL_REVISION || data.identity != *identity {
            continue;
        }
        let mut duplicates = HashSet::new();
        for frame in data.selection.frames {
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
            if vectors.insert(frame.frame, frame.e_i).is_some() {
                vectors.remove(&frame.frame);
                duplicates.insert(frame.frame);
            }
        }
        // Use the newest decodable snapshot. Invalid scores, flags or a missing
        // vector do not require re-encoding its other valid image embeddings.
        break;
    }
    vectors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invalidate(path: &Path) {
        INDEXES.lock().unwrap().retain(|index| index.path != path);
        invalidate_warm(path);
    }

    fn overwrite_record(path: &Path, data: &ShotData) {
        let bytes = codec().serialize(data).unwrap();
        let mut output = FILE_MAGIC.to_vec();
        output.extend_from_slice(&0u64.to_le_bytes());
        output.extend_from_slice(RECORD_MAGIC);
        output.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        output.extend_from_slice(&record_key(&data.identity));
        output.extend_from_slice(&bytes);
        output.extend_from_slice(RECORD_COMMIT);
        fs::write(path, output).unwrap();
    }

    struct TestRoot(PathBuf);
    impl TestRoot {
        fn new() -> Self {
            Self(env::temp_dir().join(format!("linecut-keyframe-test-{}", Uuid::new_v4())))
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
            Ok(positions
                .iter()
                .map(|&frame| {
                    let mut vector = vec![0.0; DIMENSIONS];
                    vector[frame % DIMENSIONS] = 1.0;
                    vector
                })
                .collect())
        })
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
            fixture.0.join(&source.shot.fingerprint)
        );
        assert!(Uuid::parse_str(file.file_stem().unwrap().to_str().unwrap()).is_ok());
        let metadata = fs::metadata(&file).unwrap();
        let index = scan(&file, (metadata.len(), metadata.modified().unwrap())).unwrap();
        let disk = read_record(&file, index.records[&record_key(&source.identity)]).unwrap();
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
        let metadata = fs::metadata(&file).unwrap();
        let index = scan(&file, (metadata.len(), metadata.modified().unwrap())).unwrap();
        assert_eq!(index.records.len(), 3);
        assert_eq!(index.valid_end, metadata.len());
    }

    #[test]
    fn large_media_rotates_shards_by_size_without_version_directories() {
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
        let directory = fixture.0.join(&source.shot.fingerprint);
        let files = shards(&directory);
        assert_eq!(files.len(), 2);
        assert_eq!(shard_sequence(&files[0]), Some(0));
        assert_eq!(shard_sequence(&files[1]), Some(1));
        for file in &files {
            assert!(Uuid::parse_str(file.file_stem().unwrap().to_str().unwrap()).is_ok());
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
                    })
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
        let metadata = fs::metadata(&file).unwrap();
        let index = scan(&file, (metadata.len(), metadata.modified().unwrap())).unwrap();
        let damaged = index.records[&record_key(&saved[1].identity)];
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
