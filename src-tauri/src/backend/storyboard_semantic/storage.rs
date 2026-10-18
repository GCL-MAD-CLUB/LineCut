//! Shared, single-process media log. Only headers are scanned under a per-media
//! lock; readers pin file handles before releasing it. Payloads are verified
//! before callers deserialize them. Old formats are deliberately unsupported.
use super::*;
use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom, Write};

pub(super) const SHARD_BYTES: u64 = 256 * 1024 * 1024;
pub(super) const MAX_RECORD_BYTES: u64 = 4 * 1024 * 1024;
pub(super) const FILE_HEADER_BYTES: u64 = 8;
pub(super) const RECORD_HEADER_BYTES: u64 = 112;
pub(super) const RECORD_COMMIT: &[u8; 8] = b"LCRLDONE";
const FILE_MAGIC: &[u8; 8] = b"LCRL0001";
const RECORD_MAGIC: &[u8; 8] = b"LCRLSHOT";
const GC_MIN_BYTES: u64 = 64 * 1024;
pub(super) type Key = [u8; 32];
type Stamp = (u64, SystemTime);
type MediaLocks = VecDeque<(PathBuf, Arc<Mutex<State>>)>;
static MEDIA: Mutex<MediaLocks> = Mutex::new(VecDeque::new());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Record {
    pub(super) key: Key,
    pub(super) offset: u64,
    pub(super) length: u64,
    checksum: Key,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Token {
    path: PathBuf,
    epoch: Uuid,
    record: Record,
}

pub(super) struct Snapshot {
    pub(super) token: Token,
    file: fs::File,
}
impl Snapshot {
    pub(super) fn read(mut self) -> Option<Vec<u8>> {
        read_payload(&mut self.file, self.token.record)
    }
}

struct Shard {
    path: PathBuf,
    stamp: Stamp,
    epoch: Uuid,
    // High-water mark of the last committed record, including any recovered
    // records after a corrupt middle. Append may truncate only AFTER this mark.
    valid_end: u64,
    records: HashMap<Key, Record>,
}

#[derive(Default)]
struct State {
    shards: VecDeque<Shard>,
    cleaned_generation: Option<PathBuf>,
}

fn media_lock(directory: &Path) -> AppResult<Arc<Mutex<State>>> {
    let parent = directory
        .parent()
        .ok_or_else(|| inference_error("Invalid log directory"))?;
    let mut locks = MEDIA.lock().map_err(inference_error)?;
    if let Some(position) = locks.iter().position(|(path, _)| path == parent) {
        let entry = locks.remove(position).expect("existing media lock");
        let lock = Arc::clone(&entry.1);
        locks.push_back(entry);
        return Ok(lock);
    }
    // Never evict a lock with active users: that could create two writers.
    while locks.len() >= 32 {
        let Some(position) = locks
            .iter()
            .position(|(_, lock)| Arc::strong_count(lock) == 1)
        else {
            break;
        };
        locks.remove(position);
    }
    let lock = Arc::new(Mutex::new(State::default()));
    locks.push_back((parent.into(), Arc::clone(&lock)));
    Ok(lock)
}

pub(super) fn directory(root: &Path, fingerprint: &str, revision: &[u8]) -> Option<PathBuf> {
    if fingerprint.len() != 64 || !fingerprint.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(
        root.join(fingerprint)
            .join(format!("{:x}", Sha256::digest(revision))),
    )
}

pub(super) fn sequence(path: &Path) -> Option<u64> {
    let stem = path.file_stem()?.to_str()?;
    let (sequence, uuid) = stem.split_once('-')?;
    if path.extension()?.to_str()? != "bin" || sequence.len() != 16 {
        return None;
    }
    Uuid::parse_str(uuid).ok()?;
    u64::from_str_radix(sequence, 16).ok()
}

pub(super) fn shards(directory: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            if !entry.file_type().ok()?.is_file() {
                return None;
            }
            let path = entry.path();
            Some((sequence(&path)?, path))
        })
        .collect();
    files.sort_unstable();
    files.into_iter().map(|(_, path)| path).collect()
}

fn filename(directory: &Path, sequence: u64) -> PathBuf {
    directory.join(format!("{sequence:016x}-{}.bin", Uuid::new_v4()))
}

fn header(key: Key, payload: &[u8]) -> Vec<u8> {
    let mut bytes = RECORD_MAGIC.to_vec();
    bytes.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&key);
    bytes.extend_from_slice(&Sha256::digest(payload));
    // Verify length/key/payload digest BEFORE trusting offsets or keys.
    bytes.extend_from_slice(&Sha256::digest(&bytes));
    bytes
}

fn read_header(file: &mut fs::File, start: u64) -> Option<Record> {
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = [0; RECORD_HEADER_BYTES as usize];
    file.read_exact(&mut bytes).ok()?;
    if &bytes[..8] != RECORD_MAGIC || Sha256::digest(&bytes[..80])[..] != bytes[80..] {
        return None;
    }
    let length = u64::from_le_bytes(bytes[8..16].try_into().ok()?);
    if length == 0 || length > MAX_RECORD_BYTES {
        return None;
    }
    Some(Record {
        key: bytes[16..48].try_into().ok()?,
        offset: start.checked_add(RECORD_HEADER_BYTES)?,
        length,
        checksum: bytes[48..80].try_into().ok()?,
    })
}

fn committed(file: &mut fs::File, record: Record, length: u64) -> Option<u64> {
    let footer = record.offset.checked_add(record.length)?;
    let end = footer.checked_add(8)?;
    if end > length {
        return None;
    }
    file.seek(SeekFrom::Start(footer)).ok()?;
    let mut commit = [0; 8];
    file.read_exact(&mut commit).ok()?;
    (&commit == RECORD_COMMIT).then_some(end)
}

fn next_record(file: &mut fs::File, start: u64) -> Option<u64> {
    file.seek(SeekFrom::Start(start)).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut window = 0u64;
    for (i, byte) in reader.bytes().enumerate() {
        window = (window << 8) | u64::from(byte.ok()?);
        if i >= 7 && window == u64::from_be_bytes(*RECORD_MAGIC) {
            return Some(start + i as u64 - 7);
        }
    }
    None
}

fn scan(path: &Path, stamp: Stamp) -> Option<Shard> {
    let mut file = fs::File::open(path).ok()?;
    let mut magic = [0; 8];
    let valid_header = file.read_exact(&mut magic).is_ok() && &magic == FILE_MAGIC;
    let mut shard = Shard {
        path: path.into(),
        stamp,
        epoch: Uuid::new_v4(),
        valid_end: if valid_header { FILE_HEADER_BYTES } else { 0 },
        records: HashMap::new(),
    };
    let mut cursor = shard.valid_end;
    while cursor < stamp.0 {
        if let Some((record, end)) = read_header(&mut file, cursor)
            .and_then(|record| Some((record, committed(&mut file, record, stamp.0)?)))
        {
            shard.records.insert(record.key, record);
            shard.valid_end = end;
            cursor = end;
        } else if let Some(next) = next_record(&mut file, cursor + 1) {
            cursor = next;
        } else {
            break;
        }
    }
    Some(shard)
}

impl State {
    fn index(&mut self, path: &Path) -> Option<&mut Shard> {
        let metadata = fs::metadata(path).ok()?;
        let stamp = (metadata.len(), metadata.modified().ok()?);
        if let Some(position) = self.shards.iter().position(|shard| shard.path == path) {
            let shard = self.shards.remove(position)?;
            if shard.stamp == stamp {
                self.shards.push_back(shard);
                return self.shards.back_mut();
            }
        }
        let shard = scan(path, stamp)?;
        while self.shards.len() >= 32 {
            self.shards.pop_front();
        }
        self.shards.push_back(shard);
        self.shards.back_mut()
    }

    fn latest(&mut self, directory: &Path) -> HashMap<Key, Token> {
        let mut records = HashMap::new();
        for path in shards(directory) {
            if let Some(shard) = self.index(&path) {
                for (&key, &record) in &shard.records {
                    records.insert(
                        key,
                        Token {
                            path: path.clone(),
                            epoch: shard.epoch,
                            record,
                        },
                    );
                }
            }
        }
        records
    }
}

pub(super) fn locate(directory: &Path, keys: &[Key]) -> Option<Vec<Option<Snapshot>>> {
    let lock = media_lock(directory).ok()?;
    let mut state = lock.lock().ok()?;
    let latest = state.latest(directory);
    // Opening under the lock pins the old inode across concurrent compaction/GC.
    // No payload I/O or decoding is performed here.
    Some(
        keys.iter()
            .map(|key| {
                let token = latest.get(key)?.clone();
                let file = fs::File::open(&token.path).ok()?;
                Some(Snapshot { token, file })
            })
            .collect(),
    )
}

fn read_payload(file: &mut fs::File, record: Record) -> Option<Vec<u8>> {
    let observed = read_header(file, record.offset.checked_sub(RECORD_HEADER_BYTES)?)?;
    if observed != record || committed(file, record, file.metadata().ok()?.len()).is_none() {
        return None;
    }
    file.seek(SeekFrom::Start(record.offset)).ok()?;
    let mut bytes = vec![0; record.length as usize];
    file.read_exact(&mut bytes).ok()?;
    (Sha256::digest(&bytes)[..] == record.checksum).then_some(bytes)
}

// Unix supports fsync on directories. Windows std does not provide a durable
// directory barrier; file contents are synced, but namespace changes are only
// crash-recoverable, not guaranteed to survive power loss (see maintained docs).
fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn create_directory(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            create_directory(parent)?;
        }
    }
    fs::create_dir(path).or_else(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() {
            Ok(())
        } else {
            Err(error)
        }
    })?;
    if let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn write_record(
    file: &mut fs::File,
    key: Key,
    payload: &[u8],
    cancel: &AtomicBool,
) -> AppResult<()> {
    file.write_all(&header(key, payload))
        .and_then(|_| file.write_all(payload))
        .map_err(inference_error)?;
    ensure_not_cancelled(cancel)?;
    file.write_all(RECORD_COMMIT).map_err(inference_error)
}

// One open writer per touched shard. Rotation and the final batch boundary sync
// each file once; records before an interrupted record remain committed.
struct AppendShard {
    path: PathBuf,
    file: fs::File,
    end: u64,
    records: Vec<Record>,
    synced: bool,
}

#[derive(Clone, Copy)]
enum AppendEvent {
    Committed,
    FileSynced,
    DirectorySynced,
    Maintenance,
}

impl AppendShard {
    fn open(path: PathBuf, mut end: u64) -> AppResult<Self> {
        let mut file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(inference_error)?;
        file.set_len(end).map_err(inference_error)?;
        file.seek(SeekFrom::Start(end)).map_err(inference_error)?;
        if end == 0 {
            file.write_all(FILE_MAGIC).map_err(inference_error)?;
            end = FILE_HEADER_BYTES;
        }
        Ok(Self {
            path,
            file,
            end,
            records: Vec::new(),
            synced: false,
        })
    }

    fn write(&mut self, key: Key, payload: &[u8], cancel: &AtomicBool) -> AppResult<()> {
        self.synced = false;
        if let Err(error) = write_record(&mut self.file, key, payload, cancel) {
            // Roll back only this uncommitted record, retaining the batch prefix.
            self.file.set_len(self.end).map_err(inference_error)?;
            return Err(error);
        }
        self.records.push(Record {
            key,
            offset: self.end + RECORD_HEADER_BYTES,
            length: payload.len() as u64,
            checksum: Sha256::digest(payload).into(),
        });
        self.end += RECORD_HEADER_BYTES + payload.len() as u64 + 8;
        Ok(())
    }

    fn finish(
        &mut self,
        state: &mut State,
        checkpoint: &mut impl FnMut(AppendEvent),
    ) -> AppResult<()> {
        if self.synced {
            return Ok(());
        }
        self.file.sync_all().map_err(inference_error)?;
        checkpoint(AppendEvent::FileSynced);
        let metadata = self.file.metadata().map_err(inference_error)?;
        let stamp = (
            metadata.len(),
            metadata.modified().map_err(inference_error)?,
        );
        // Preserve tokens for unrelated records on our own appends. External
        // changes still get a fresh scan epoch in State::index.
        if let Some(shard) = state
            .shards
            .iter_mut()
            .find(|shard| shard.path == self.path)
        {
            shard.stamp = stamp;
            shard.valid_end = self.end;
            shard
                .records
                .extend(self.records.drain(..).map(|record| (record.key, record)));
        } else {
            while state.shards.len() >= 32 {
                state.shards.pop_front();
            }
            state.shards.push_back(Shard {
                path: self.path.clone(),
                stamp,
                epoch: Uuid::new_v4(),
                valid_end: self.end,
                records: self
                    .records
                    .drain(..)
                    .map(|record| (record.key, record))
                    .collect(),
            });
        }
        self.synced = true;
        Ok(())
    }
}

pub(super) fn append(
    directory: &Path,
    key: Key,
    payload: &[u8],
    cancel: &AtomicBool,
    limit: u64,
) -> AppResult<()> {
    append_batch(directory, &[(key, payload)], cancel, limit)
}

/// Each record has its own commit marker; a cancelled batch keeps its completed
/// prefix. Sync/metadata work is once per touched shard, with one directory
/// barrier and maintenance pass per successful batch, rather than per shot.
pub(super) fn append_batch(
    directory: &Path,
    records: &[(Key, &[u8])],
    cancel: &AtomicBool,
    limit: u64,
) -> AppResult<()> {
    append_batch_with(directory, records, cancel, limit, |_| {})
}

fn append_batch_with(
    directory: &Path,
    records: &[(Key, &[u8])],
    cancel: &AtomicBool,
    limit: u64,
    mut checkpoint: impl FnMut(AppendEvent),
) -> AppResult<()> {
    ensure_not_cancelled(cancel)?;
    // Validate the entire batch before creating files or committing a prefix.
    for (_, payload) in records {
        let size = RECORD_HEADER_BYTES + payload.len() as u64 + 8;
        if payload.is_empty()
            || payload.len() as u64 > MAX_RECORD_BYTES
            || FILE_HEADER_BYTES.saturating_add(size) > limit
        {
            return Err(inference_error("Invalid storyboard log record size"));
        }
    }
    if records.is_empty() {
        return Ok(());
    }
    let lock = media_lock(directory)?;
    let mut state = lock.lock().map_err(inference_error)?;
    ensure_not_cancelled(cancel)?;
    create_directory(directory).map_err(inference_error)?;
    clean_temporary(directory)?;
    let (mut path, mut end) = match shards(directory).pop() {
        Some(path) => {
            let end = state
                .index(&path)
                .ok_or_else(|| inference_error("Cannot scan storyboard log"))?
                .valid_end;
            (path, end)
        }
        None => (filename(directory, 0), 0),
    };
    let first_size = RECORD_HEADER_BYTES + records[0].1.len() as u64 + 8;
    if end > FILE_HEADER_BYTES && end.saturating_add(first_size) > limit {
        let next = sequence(&path)
            .and_then(|n| n.checked_add(1))
            .ok_or_else(|| inference_error("Shard sequence overflow"))?;
        path = filename(directory, next);
        end = 0;
    }
    let mut writer = AppendShard::open(path, end)?;
    let result = (|| {
        for &(key, payload) in records {
            ensure_not_cancelled(cancel)?;
            let size = RECORD_HEADER_BYTES + payload.len() as u64 + 8;
            if writer.end > FILE_HEADER_BYTES && writer.end.saturating_add(size) > limit {
                writer.finish(&mut state, &mut checkpoint)?;
                let next = sequence(&writer.path)
                    .and_then(|n| n.checked_add(1))
                    .ok_or_else(|| inference_error("Shard sequence overflow"))?;
                writer = AppendShard::open(filename(directory, next), 0)?;
            }
            writer.write(key, payload, cancel)?;
            checkpoint(AppendEvent::Committed);
        }
        Ok(())
    })();
    // Also sync a cancelled batch's committed prefix before returning the error.
    // If I/O fails, force fresh offsets on the next operation instead of keeping
    // an index whose stamp might now describe incomplete/unpublished writes.
    let finish = writer.finish(&mut state, &mut checkpoint);
    if finish.is_err() {
        state.shards.retain(|shard| shard.path != writer.path);
    }
    drop(writer);
    let directory_sync = sync_directory(directory).map_err(inference_error);
    if directory_sync.is_ok() {
        checkpoint(AppendEvent::DirectorySynced);
    }
    finish?;
    directory_sync?;
    result?;
    // Records are committed. Maintenance failure/cancellation must not report
    // that successful persistence failed or remove its predecessors.
    checkpoint(AppendEvent::Maintenance);
    if let Err(error) = maintain(&mut state, directory, cancel, limit, false) {
        if !error.is(ErrorCode::TaskCancelled) {
            tracing::warn!(?error, "Storyboard log maintenance deferred");
        }
    }
    Ok(())
}

fn clean_temporary(directory: &Path) -> AppResult<()> {
    for entry in fs::read_dir(directory).map_err(inference_error)? {
        let entry = entry.map_err(inference_error)?;
        if entry.file_type().map_err(inference_error)?.is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "tmp")
        {
            fs::remove_file(entry.path()).map_err(inference_error)?;
        }
    }
    Ok(())
}

fn maintain(
    state: &mut State,
    directory: &Path,
    cancel: &AtomicBool,
    limit: u64,
    force: bool,
) -> AppResult<()> {
    ensure_not_cancelled(cancel)?;
    let files = shards(directory);
    // Never publish a compacted view that silently omitted an unreadable shard.
    for path in &files {
        state
            .index(path)
            .ok_or_else(|| inference_error("Cannot scan shard for compaction"))?;
    }
    let latest = state.latest(directory);
    let total: u64 = files
        .iter()
        .filter_map(|path| fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .sum();
    let live: u64 = latest
        .values()
        .map(|token| RECORD_HEADER_BYTES + token.record.length + 8)
        .sum();
    let dead = total.saturating_sub(live + files.len() as u64 * FILE_HEADER_BYTES);
    if force || dead >= GC_MIN_BYTES.max(live / 2) {
        compact(state, directory, &files, latest, cancel, limit, |_| Ok(()))?;
    }
    ensure_not_cancelled(cancel)?;
    // A successful cleanup stays valid for this single-process generation.
    // Revisit it only after a generation switch (or after a failed cleanup).
    if state.cleaned_generation.as_deref() == Some(directory) {
        return Ok(());
    }
    // This directory's recipe/media version has a durable committed record.
    // Siblings are obsolete recipes/media stamps, never other fingerprints.
    let parent = directory
        .parent()
        .ok_or_else(|| inference_error("Invalid media directory"))?;
    let resolved_parent = fs::canonicalize(parent).map_err(inference_error)?;
    let mut removed = false;
    for entry in fs::read_dir(parent).map_err(inference_error)? {
        let entry = entry.map_err(inference_error)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if entry.path() != directory
            && entry.file_type().map_err(inference_error)?.is_dir()
            && name.len() == 64
            && name.bytes().all(|c| c.is_ascii_hexdigit())
        {
            ensure_not_cancelled(cancel)?;
            let resolved = fs::canonicalize(entry.path()).map_err(inference_error)?;
            if resolved != resolved_parent.join(entry.file_name()) {
                continue;
            }
            fs::remove_dir_all(entry.path()).map_err(inference_error)?;
            removed = true;
            state
                .shards
                .retain(|shard| !shard.path.starts_with(entry.path()));
        }
    }
    if removed {
        sync_directory(parent).map_err(inference_error)?;
    }
    state.cleaned_generation = Some(directory.into());
    Ok(())
}

fn compact(
    state: &mut State,
    directory: &Path,
    old: &[PathBuf],
    latest: HashMap<Key, Token>,
    cancel: &AtomicBool,
    limit: u64,
    mut checkpoint: impl FnMut(bool) -> AppResult<()>,
) -> AppResult<()> {
    let mut sequence = old
        .last()
        .and_then(|path| self::sequence(path))
        .unwrap_or(0);
    let mut staged = Vec::<(PathBuf, PathBuf)>::new();
    let result = (|| {
        let mut output: Option<fs::File> = None;
        let mut size = 0;
        // Stream one payload at a time; memory use does not grow with media size.
        for token in latest.into_values() {
            ensure_not_cancelled(cancel)?;
            let mut input = fs::File::open(&token.path).map_err(inference_error)?;
            let payload = read_payload(&mut input, token.record).ok_or_else(|| {
                inference_error(format!(
                    "Cannot read or verify latest storyboard record at {}:{}; compaction aborted",
                    token.path.display(),
                    token.record.offset,
                ))
            })?;
            let record_size = RECORD_HEADER_BYTES + payload.len() as u64 + 8;
            if FILE_HEADER_BYTES + record_size > limit {
                return Err(inference_error(
                    "Compaction record exceeds shard size limit",
                ));
            }
            if output.is_none() || size + record_size > limit {
                if let Some(file) = output.take() {
                    file.sync_all().map_err(inference_error)?;
                }
                sequence = sequence
                    .checked_add(1)
                    .ok_or_else(|| inference_error("Shard sequence overflow"))?;
                let target = filename(directory, sequence);
                let temporary = target.with_extension("tmp");
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)
                    .map_err(inference_error)?;
                staged.push((temporary, target));
                file.write_all(FILE_MAGIC).map_err(inference_error)?;
                size = FILE_HEADER_BYTES;
                output = Some(file);
            }
            write_record(
                output.as_mut().expect("compaction output"),
                token.record.key,
                &payload,
                cancel,
            )?;
            size += record_size;
            checkpoint(false)?;
        }
        if let Some(file) = output {
            file.sync_all().map_err(inference_error)?;
        }
        ensure_not_cancelled(cancel)?;
        // Publication is non-cancellable. Partial publication after a crash is
        // safe: the new higher-sequence records are identical to the latest old
        // records, and ALL old shards remain until ALL replacements are synced.
        for (temporary, target) in &staged {
            fs::rename(temporary, target).map_err(inference_error)?;
            checkpoint(true)?;
        }
        sync_directory(directory).map_err(inference_error)?;
        for path in old {
            fs::remove_file(path).map_err(inference_error)?;
        }
        sync_directory(directory).map_err(inference_error)?;
        state.shards.retain(|shard| !old.contains(&shard.path));
        Ok(())
    })();
    for (temporary, _) in staged {
        let _ = fs::remove_file(temporary);
    }
    result
}

// Decoded record LRU shared by both callers. A token changes only when that
// record is replaced, compacted, or externally modified; append does not flush
// unrelated shots, including incomplete checkpoints.
pub(super) struct Warm<T> {
    entries: VecDeque<(Token, Arc<T>, usize)>,
    bytes: usize,
}
impl<T> Default for Warm<T> {
    fn default() -> Self {
        Self {
            entries: VecDeque::new(),
            bytes: 0,
        }
    }
}
impl<T> Warm<T> {
    pub(super) fn get(&mut self, token: &Token) -> Option<Arc<T>> {
        let position = self.entries.iter().position(|(key, _, _)| key == token)?;
        let entry = self.entries.remove(position)?;
        let data = Arc::clone(&entry.1);
        self.entries.push_back(entry);
        Some(data)
    }
    pub(super) fn insert(&mut self, token: Token, data: Arc<T>, bytes: usize) {
        const LIMIT: usize = 32 * 1024 * 1024;
        if bytes > LIMIT {
            return;
        }
        self.entries
            .retain(|(old, _, _)| old.path != token.path || old.record.key != token.record.key);
        self.bytes = self.entries.iter().map(|(_, _, bytes)| bytes).sum();
        while self.bytes + bytes > LIMIT {
            if let Some((_, _, bytes)) = self.entries.pop_front() {
                self.bytes -= bytes;
            }
        }
        self.bytes += bytes;
        self.entries.push_back((token, data, bytes));
    }
}

#[cfg(test)]
pub(super) fn overwrite_fixture(path: &Path, key: Key, bytes: &[u8]) {
    let mut file = fs::File::create(path).unwrap();
    file.write_all(FILE_MAGIC).unwrap();
    write_record(&mut file, key, bytes, &AtomicBool::new(false)).unwrap();
    file.sync_all().unwrap();
}

#[cfg(test)]
pub(super) fn fixture_record(snapshot: &Snapshot) -> Record {
    snapshot.token.record
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    struct Fixture {
        root: PathBuf,
        directory: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = env::temp_dir().join(format!("locution-pro-record-log-{}", Uuid::new_v4()));
            let directory = directory(&root, &"a".repeat(64), b"recipe-model-media-v1").unwrap();
            Self { root, directory }
        }
        fn append(&self, key: u8, bytes: &[u8]) {
            append(
                &self.directory,
                [key; 32],
                bytes,
                &AtomicBool::new(false),
                SHARD_BYTES,
            )
            .unwrap();
        }
        fn read(&self, key: u8) -> Option<Vec<u8>> {
            locate(&self.directory, &[[key; 32]])?.pop()??.read()
        }
        fn compact(&self) {
            let lock = media_lock(&self.directory).unwrap();
            let mut state = lock.lock().unwrap();
            maintain(
                &mut state,
                &self.directory,
                &AtomicBool::new(false),
                SHARD_BYTES,
                true,
            )
            .unwrap();
        }
        fn forget(&self) {
            media_lock(&self.directory)
                .unwrap()
                .lock()
                .unwrap()
                .shards
                .clear();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            assert_eq!(self.root.parent(), Some(env::temp_dir().as_path()));
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn a_batch_syncs_once_per_touched_shard_and_runs_maintenance_once() {
        let fixture = Fixture::new();
        let records: Vec<_> = (0..5)
            .map(|key| ([key; 32], b"payload".as_slice()))
            .collect();
        let cancel = AtomicBool::new(false);
        for per_shard in [5, 2] {
            let limit = FILE_HEADER_BYTES + per_shard * (RECORD_HEADER_BYTES + 7 + 8);
            let mut counts = [0; 4];
            append_batch_with(&fixture.directory, &records, &cancel, limit, |event| {
                counts[match event {
                    AppendEvent::Committed => 0,
                    AppendEvent::FileSynced => 1,
                    AppendEvent::DirectorySynced => 2,
                    AppendEvent::Maintenance => 3,
                }] += 1;
            })
            .unwrap();
            // The second batch starts with a full shard: do not reopen or sync
            // that untouched shard merely to rotate away from it.
            assert_eq!(
                counts,
                if per_shard == 5 {
                    [5, 1, 1, 1]
                } else {
                    [5, 3, 1, 1]
                }
            );
            fixture.forget();
            for key in 0..5 {
                assert_eq!(fixture.read(key).unwrap(), b"payload");
            }
        }
    }

    #[test]
    fn cancelled_batch_keeps_its_committed_prefix_across_rotations_and_reopen() {
        for per_shard in [5, 2] {
            let fixture = Fixture::new();
            fixture.append(10, b"previous");
            let records: Vec<_> = (0..5)
                .map(|key| ([key; 32], b"payload".as_slice()))
                .collect();
            let cancel = AtomicBool::new(false);
            let limit = FILE_HEADER_BYTES + per_shard * (RECORD_HEADER_BYTES + 8 + 8);
            let mut committed = 0;
            let mut syncs = 0;
            let error =
                append_batch_with(
                    &fixture.directory,
                    &records,
                    &cancel,
                    limit,
                    |event| match event {
                        AppendEvent::Committed => {
                            committed += 1;
                            if committed == 3 {
                                cancel.store(true, Ordering::SeqCst);
                            }
                        }
                        AppendEvent::FileSynced => syncs += 1,
                        _ => {}
                    },
                )
                .unwrap_err();
            assert!(error.is(ErrorCode::TaskCancelled));
            assert_eq!(committed, 3);
            assert_eq!(syncs, if per_shard == 5 { 1 } else { 2 });
            fixture.forget();
            assert_eq!(fixture.read(10).unwrap(), b"previous");
            for key in 0..3 {
                assert_eq!(fixture.read(key).unwrap(), b"payload");
            }
            assert!(fixture.read(3).is_none());
            assert!(fixture.read(4).is_none());
            append_batch(
                &fixture.directory,
                &records[3..],
                &AtomicBool::new(false),
                limit,
            )
            .unwrap();
            fixture.forget();
            for key in 0..5 {
                assert_eq!(fixture.read(key).unwrap(), b"payload");
            }
        }
    }

    #[test]
    fn empty_or_invalid_batches_do_not_publish_any_records() {
        let fixture = Fixture::new();
        let cancel = AtomicBool::new(false);
        append_batch(&fixture.directory, &[], &cancel, SHARD_BYTES).unwrap();
        assert!(!fixture.directory.exists());
        assert!(append_batch(
            &fixture.directory,
            &[([1; 32], b"valid"), ([2; 32], b"")],
            &cancel,
            SHARD_BYTES
        )
        .is_err());
        assert!(!fixture.directory.exists());
    }

    #[test]
    fn batches_recover_a_torn_tail_keep_latest_duplicate_keys_and_preserve_warm_tokens() {
        let fixture = Fixture::new();
        fixture.append(10, b"previous");
        let snapshot = locate(&fixture.directory, &[[10; 32]])
            .unwrap()
            .pop()
            .unwrap()
            .unwrap();
        let token = snapshot.token;
        let path = shards(&fixture.directory).pop().unwrap();
        // An externally torn suffix requires a fresh scan epoch. Establish that
        // epoch before checking that our subsequent batch preserves its tokens.
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"torn suffix").unwrap();
        drop(file);
        let fresh = locate(&fixture.directory, &[[10; 32]])
            .unwrap()
            .pop()
            .unwrap()
            .unwrap();
        assert!(fresh.token != token);
        let token = fresh.token;
        append_batch(
            &fixture.directory,
            &[
                ([1; 32], b"first"),
                ([2; 32], b"second"),
                ([1; 32], b"latest"),
            ],
            &AtomicBool::new(false),
            SHARD_BYTES,
        )
        .unwrap();
        let latest = locate(&fixture.directory, &[[10; 32]])
            .unwrap()
            .pop()
            .unwrap()
            .unwrap();
        assert!(latest.token == token);
        fixture.forget();
        assert_eq!(fixture.read(10).unwrap(), b"previous");
        assert_eq!(fixture.read(1).unwrap(), b"latest");
        assert_eq!(fixture.read(2).unwrap(), b"second");
    }

    #[test]
    fn unreadable_latest_payload_aborts_compaction_without_publishing_or_removing_shards() {
        for missing_file in [false, true] {
            let fixture = Fixture::new();
            fixture.append(1, b"original");
            fixture.append(1, b"latest");
            fixture.append(2, b"healthy");
            let old = shards(&fixture.directory);
            let lock = media_lock(&fixture.directory).unwrap();
            let mut state = lock.lock().unwrap();
            let mut latest = state.latest(&fixture.directory);
            if missing_file {
                // Simulate an I/O failure after indexing, without deleting any
                // real shard. A missing input must abort just like bad payloads.
                latest.get_mut(&[1; 32]).unwrap().path = fixture.directory.join("unavailable.bin");
            } else {
                let record = latest[&[1; 32]].record;
                let mut file = fs::OpenOptions::new().write(true).open(&old[0]).unwrap();
                file.seek(SeekFrom::Start(record.offset)).unwrap();
                file.write_all(&[255]).unwrap();
            }
            let before: Vec<_> = old.iter().map(|path| fs::read(path).unwrap()).collect();
            let result = compact(
                &mut state,
                &fixture.directory,
                &old,
                latest,
                &AtomicBool::new(false),
                SHARD_BYTES,
                |_| Ok(()),
            );
            assert!(result.is_err());
            assert_eq!(shards(&fixture.directory), old);
            assert_eq!(
                fs::read_dir(&fixture.directory).unwrap().count(),
                old.len(),
                "temporary files must be removed"
            );
            for (path, bytes) in old.iter().zip(before) {
                assert_eq!(fs::read(path).unwrap(), bytes);
            }
            drop(state);
            fixture.forget();
            assert_eq!(fixture.read(2).unwrap(), b"healthy");
            if missing_file {
                assert_eq!(fixture.read(1).unwrap(), b"latest");
            }
        }
    }

    #[test]
    fn maintenance_failure_stays_in_backend_logs_and_does_not_fail_the_append() {
        let fixture = Fixture::new();
        fixture.append(1, &[0; 40_000]);
        fixture.append(1, &[1; 40_000]);
        let snapshot = locate(&fixture.directory, &[[1; 32]])
            .unwrap()
            .pop()
            .unwrap()
            .unwrap();
        let record = snapshot.token.record;
        let path = snapshot.token.path.clone();
        drop(snapshot);
        let mut file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start(record.offset)).unwrap();
        file.write_all(&[255]).unwrap();
        drop(file);
        let old_bytes = fs::read(&path).unwrap();
        fixture.append(2, &[0; 40_000]);
        // Replacing the unrelated key crosses the automatic GC threshold. The
        // bad latest payload aborts maintenance, while this commit still succeeds.
        append_batch(
            &fixture.directory,
            &[([2; 32], &[1; 40_000])],
            &AtomicBool::new(false),
            SHARD_BYTES,
        )
        .unwrap();
        assert_eq!(shards(&fixture.directory), vec![path.clone()]);
        assert!(fs::read(path).unwrap().starts_with(&old_bytes));
        fixture.forget();
        assert_eq!(fixture.read(2).unwrap(), vec![1; 40_000]);
    }

    #[test]
    fn sequence_is_available_from_uuid_filename_and_rotation_is_size_only() {
        let fixture = Fixture::new();
        let limit = FILE_HEADER_BYTES + 2 * (RECORD_HEADER_BYTES + 1024 + 8);
        for key in 0..5 {
            append(
                &fixture.directory,
                [key; 32],
                &[key; 1024],
                &AtomicBool::new(false),
                limit,
            )
            .unwrap();
        }
        let files = shards(&fixture.directory);
        assert_eq!(files.len(), 3);
        for (i, path) in files.iter().enumerate() {
            assert_eq!(sequence(path), Some(i as u64));
            assert!(fs::metadata(path).unwrap().len() <= limit);
        }
        // Renaming the directory does not change sequence discovery; even an
        // unreadable/empty file would not require opening its header to sort it.
        let fake = filename(&fixture.directory, 42);
        fs::write(&fake, []).unwrap();
        assert_eq!(
            sequence(shards(&fixture.directory).last().unwrap()),
            Some(42)
        );
        for key in 0..5 {
            assert_eq!(fixture.read(key).unwrap(), vec![key; 1024]);
        }
    }

    #[test]
    fn every_torn_tail_boundary_keeps_committed_records_and_allows_append() {
        let fixture = Fixture::new();
        fixture.append(1, b"first");
        let path = shards(&fixture.directory).pop().unwrap();
        let prefix = fs::read(&path).unwrap();
        fixture.append(2, b"second");
        let complete = fs::read(&path).unwrap();
        for cut in prefix.len()..complete.len() {
            fs::write(&path, &complete[..cut]).unwrap();
            fixture.forget();
            assert_eq!(fixture.read(1).unwrap(), b"first");
            assert!(fixture.read(2).is_none(), "cut={cut}");
            fixture.append(3, b"third");
            fixture.forget();
            assert_eq!(fixture.read(1).unwrap(), b"first");
            assert_eq!(fixture.read(3).unwrap(), b"third");
            assert_eq!(
                fs::metadata(&path).unwrap().len(),
                prefix.len() as u64 + RECORD_HEADER_BYTES + 5 + 8
            );
        }
    }

    #[test]
    fn corrupt_middle_header_payload_or_commit_does_not_truncate_later_commits() {
        for damage in [
            0,
            8,
            16,
            48,
            80,
            RECORD_HEADER_BYTES,
            RECORD_HEADER_BYTES + 100,
        ] {
            let fixture = Fixture::new();
            for key in 0..3 {
                fixture.append(key, &[key; 100]);
            }
            let path = shards(&fixture.directory).pop().unwrap();
            let end = fs::metadata(&path).unwrap().len();
            let middle = FILE_HEADER_BYTES + RECORD_HEADER_BYTES + 100 + 8;
            let mut file = fs::OpenOptions::new().write(true).open(&path).unwrap();
            file.seek(SeekFrom::Start(middle + damage)).unwrap();
            file.write_all(&[255]).unwrap();
            file.seek(SeekFrom::End(0)).unwrap();
            file.write_all(b"torn tail").unwrap();
            drop(file);
            fixture.forget();
            assert_eq!(fixture.read(0).unwrap(), vec![0; 100]);
            assert!(fixture.read(1).is_none(), "damage={damage}");
            assert_eq!(fixture.read(2).unwrap(), vec![2; 100]);
            fixture.append(3, &[3; 100]);
            fixture.forget();
            assert_eq!(
                fs::metadata(&path).unwrap().len(),
                end + RECORD_HEADER_BYTES + 100 + 8
            );
            assert_eq!(fixture.read(0).unwrap(), vec![0; 100]);
            assert_eq!(fixture.read(2).unwrap(), vec![2; 100]);
            assert_eq!(fixture.read(3).unwrap(), vec![3; 100]);
        }
    }

    #[test]
    fn damaged_file_header_and_embedded_magic_resynchronize_only_to_checked_headers() {
        let fixture = Fixture::new();
        fixture.append(1, b"first");
        let mut payload = vec![0; 512];
        payload[20..28].copy_from_slice(RECORD_MAGIC);
        fixture.append(2, &payload);
        fixture.append(3, b"last");
        let path = shards(&fixture.directory).pop().unwrap();
        let mut file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.write_all(&[0; FILE_HEADER_BYTES as usize]).unwrap();
        file.seek(SeekFrom::Start(
            FILE_HEADER_BYTES + RECORD_HEADER_BYTES + 5 + 8,
        ))
        .unwrap();
        file.write_all(&[0; RECORD_HEADER_BYTES as usize]).unwrap();
        drop(file);
        fixture.forget();
        fixture.append(4, b"appended");
        fixture.forget();
        assert_eq!(fixture.read(1).unwrap(), b"first");
        assert!(fixture.read(2).is_none());
        assert_eq!(fixture.read(3).unwrap(), b"last");
        assert_eq!(fixture.read(4).unwrap(), b"appended");
    }

    #[test]
    fn cancelling_before_commit_never_publishes_the_partial_record() {
        let fixture = Fixture::new();
        fixture.append(1, b"committed");
        let path = shards(&fixture.directory).pop().unwrap();
        let length = fs::metadata(&path).unwrap().len();
        let cancel = AtomicBool::new(true);
        assert!(append(
            &fixture.directory,
            [2; 32],
            b"cancelled",
            &cancel,
            SHARD_BYTES
        )
        .is_err());
        assert_eq!(fs::metadata(&path).unwrap().len(), length);
        // Model cancellation after writing payload but before the commit marker.
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        assert!(write_record(&mut file, [2; 32], b"cancelled", &cancel).is_err());
        drop(file);
        fixture.forget();
        assert!(fixture.read(2).is_none());
        fixture.append(3, b"next");
        assert_eq!(fixture.read(1).unwrap(), b"committed");
        assert_eq!(fixture.read(3).unwrap(), b"next");
        assert!(fixture.read(2).is_none());
    }

    #[test]
    fn automatic_compaction_bounds_overwrites_and_pins_unlocked_readers() {
        let fixture = Fixture::new();
        fixture.append(0, &[0; 40_000]);
        let snapshot = locate(&fixture.directory, &[[0; 32]])
            .unwrap()
            .pop()
            .unwrap()
            .unwrap();
        let old_path = snapshot.token.path.clone();
        fixture.append(1, b"unrelated");
        for value in 1..10 {
            fixture.append(0, &[value; 40_000]);
        }
        assert!(
            !old_path.exists(),
            "automatic compaction must reclaim old shards"
        );
        assert_eq!(snapshot.read().unwrap(), vec![0; 40_000]);
        assert_eq!(fixture.read(0).unwrap(), vec![9; 40_000]);
        assert_eq!(fixture.read(1).unwrap(), b"unrelated");
        let total: u64 = shards(&fixture.directory)
            .iter()
            .map(|path| fs::metadata(path).unwrap().len())
            .sum();
        assert!(
            total < 3 * 40_000,
            "overwrites must have bounded disk use: {total}"
        );
        fixture.compact();
        fixture.forget();
        assert_eq!(shards(&fixture.directory).len(), 1);
        assert_eq!(fixture.read(0).unwrap(), vec![9; 40_000]);
    }

    #[test]
    fn cancelled_compaction_and_interrupted_publication_preserve_all_latest_records() {
        for interrupt_publication in [false, true] {
            let fixture = Fixture::new();
            for key in 0..5 {
                fixture.append(key, &[0; 1024]);
                fixture.append(key, &[key; 1024]);
            }
            let old = shards(&fixture.directory);
            let cancel = AtomicBool::new(false);
            let lock = media_lock(&fixture.directory).unwrap();
            let mut state = lock.lock().unwrap();
            let latest = state.latest(&fixture.directory);
            let result = compact(
                &mut state,
                &fixture.directory,
                &old,
                latest,
                &cancel,
                FILE_HEADER_BYTES + 2 * (RECORD_HEADER_BYTES + 1024 + 8),
                |published| {
                    if published && interrupt_publication {
                        return Err(inference_error("simulated publication interruption"));
                    }
                    if !published && !interrupt_publication {
                        cancel.store(true, Ordering::SeqCst);
                    }
                    Ok(())
                },
            );
            assert!(result.is_err());
            assert!(old.iter().all(|path| path.exists()));
            drop(state);
            fixture.forget();
            fixture.append(6, b"after interruption");
            fixture.compact();
            fixture.forget();
            for key in 0..5 {
                assert_eq!(fixture.read(key).unwrap(), vec![key; 1024]);
            }
            assert_eq!(fixture.read(6).unwrap(), b"after interruption");
            assert!(fs::read_dir(&fixture.directory).unwrap().all(|entry| entry
                .unwrap()
                .path()
                .extension()
                .unwrap()
                == "bin"));
        }
    }

    #[test]
    fn concurrent_appends_readers_and_compaction_share_one_media_lock() {
        let fixture = Fixture::new();
        let barrier = Barrier::new(5);
        std::thread::scope(|scope| {
            for worker in 0..4 {
                let fixture = &fixture;
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    for step in 0..12 {
                        let key = worker * 12 + step;
                        fixture.append(key, &[key; 512]);
                        assert_eq!(fixture.read(key).unwrap(), vec![key; 512]);
                        if step % 4 == 0 {
                            fixture.compact();
                        }
                    }
                });
            }
            barrier.wait();
        });
        fixture.forget();
        for key in 0..48 {
            assert_eq!(fixture.read(key).unwrap(), vec![key; 512]);
        }
    }

    #[test]
    fn obsolete_recipe_and_media_generations_are_pruned_only_after_commit() {
        let fixture = Fixture::new();
        fixture.append(1, b"old generation");
        let snapshot = locate(&fixture.directory, &[[1; 32]])
            .unwrap()
            .pop()
            .unwrap()
            .unwrap();
        let next = directory(&fixture.root, &"a".repeat(64), b"recipe-model-media-v2").unwrap();
        let other = directory(&fixture.root, &"b".repeat(64), b"other media").unwrap();
        append(
            &other,
            [1; 32],
            b"preserved",
            &AtomicBool::new(false),
            SHARD_BYTES,
        )
        .unwrap();
        assert!(append(&next, [1; 32], b"new", &AtomicBool::new(true), SHARD_BYTES).is_err());
        assert!(fixture.directory.exists());
        append(&next, [1; 32], b"new", &AtomicBool::new(false), SHARD_BYTES).unwrap();
        assert!(!fixture.directory.exists());
        assert!(other.exists());
        assert_eq!(snapshot.read().unwrap(), b"old generation");
        assert_eq!(
            locate(&next, &[[1; 32]])
                .unwrap()
                .pop()
                .unwrap()
                .unwrap()
                .read()
                .unwrap(),
            b"new"
        );
        assert!(directory(&fixture.root, "../bad", b"v1").is_none());
    }

    #[test]
    fn record_lru_keeps_other_shots_on_append_and_invalidates_external_changes() {
        let fixture = Fixture::new();
        fixture.append(1, b"one");
        let first = locate(&fixture.directory, &[[1; 32]])
            .unwrap()
            .pop()
            .unwrap()
            .unwrap();
        let data = Arc::new("decoded one");
        let mut warm = Warm::default();
        warm.insert(first.token, Arc::clone(&data), 100);
        fixture.append(2, b"two");
        let first = locate(&fixture.directory, &[[1; 32]])
            .unwrap()
            .pop()
            .unwrap()
            .unwrap();
        assert!(Arc::ptr_eq(&warm.get(&first.token).unwrap(), &data));
        fixture.append(1, b"updated");
        let first = locate(&fixture.directory, &[[1; 32]])
            .unwrap()
            .pop()
            .unwrap()
            .unwrap();
        assert!(warm.get(&first.token).is_none());
        warm.insert(first.token.clone(), Arc::clone(&data), 100);
        overwrite_fixture(&first.token.path, [1; 32], b"external rewrite");
        let changed = locate(&fixture.directory, &[[1; 32]])
            .unwrap()
            .pop()
            .unwrap()
            .unwrap();
        assert!(warm.get(&changed.token).is_none());
    }
}
