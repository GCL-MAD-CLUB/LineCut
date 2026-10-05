use super::motion::FrameTraceData;
use super::thumbnail::{hash_name, read_private_cache, write_private_cache};
use super::*;

// Bump the context when scaling, color conversion, seek policy or any metric changes.
const CACHE_CONTEXT: &[u8] = b"linecut-frame-trace-rgb96x54-area-ssim-rgb-laplacian305911-v1";
const CACHE_FOLDER: &str = "Frame Trace Cache";
const CACHE_BUDGET_BYTES: u64 = 256 * 1024 * 1024;
static MAINTENANCE: Mutex<Option<std::time::Instant>> = Mutex::new(None);
static GENERATION_LOCKS: Mutex<Vec<(PathBuf, std::sync::Weak<futures::lock::Mutex<()>>)>> =
    Mutex::new(Vec::new());

#[derive(Clone)]
pub(super) struct FrameTraceCache {
    root: PathBuf,
    path: PathBuf,
    key: String,
    frame_count: usize,
}

impl FrameTraceCache {
    pub(super) fn new(
        preferences: &Preferences,
        fingerprint: &str,
        stream_index: i32,
        frame_rate: f64,
        start_frame: i64,
        end_frame: i64,
    ) -> Self {
        let identity = bincode::serialize(&(
            fingerprint,
            stream_index,
            frame_rate.to_bits(),
            start_frame,
            end_frame,
        ))
        .expect("fixed cache identity is serializable");
        let key = hash_name(CACHE_CONTEXT, &identity);
        let root = configured_cache_root(preferences).join(CACHE_FOLDER);
        let path = root.join(&key[..2]).join(format!("{key}.lcft"));
        Self {
            root,
            path,
            key,
            frame_count: (end_frame - start_frame + 1) as usize,
        }
    }

    pub(super) fn generation_lock(&self) -> Arc<futures::lock::Mutex<()>> {
        let mut locks = GENERATION_LOCKS
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        locks.retain(|(_, weak)| weak.strong_count() > 0);
        if let Some(lock) = locks
            .iter()
            .find(|(path, _)| *path == self.path)
            .and_then(|(_, weak)| weak.upgrade())
        {
            return lock;
        }
        let lock = Arc::new(futures::lock::Mutex::new(()));
        locks.push((self.path.clone(), Arc::downgrade(&lock)));
        lock
    }

    pub(super) fn read(&self) -> Option<FrameTraceData> {
        // Bound the file before deserializing; each frame has six f64 samples.
        let expected_max = (self.frame_count as u64)
            .checked_mul(48)?
            .checked_add(1024)?;
        if fs::metadata(&self.path).ok()?.len() > expected_max {
            return None;
        }
        let data: FrameTraceData = read_private_cache(&self.path, &self.key, CACHE_CONTEXT)?;
        if !data.is_valid(self.frame_count) {
            return None;
        }
        if let Ok(file) = fs::OpenOptions::new().write(true).open(&self.path) {
            let _ = file.set_times(fs::FileTimes::new().set_modified(SystemTime::now()));
        }
        Some(data)
    }

    pub(super) fn write(&self, data: &FrameTraceData) -> AppResult<()> {
        if !data.is_valid(self.frame_count) {
            return Err(app_error(
                ErrorCode::ExternalToolOutputInvalid,
                "Invalid frame trace cache samples",
            ));
        }
        let temporary = self.path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let result =
            write_private_cache(&temporary, &self.key, CACHE_CONTEXT, data).and_then(|_| {
                fs::rename(&temporary, &self.path).map_err(|error| {
                    app_error(
                        ErrorCode::FrameTraceCacheWriteFailed,
                        format!("Failed to publish frame trace cache: {error}"),
                    )
                })
            });
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        let mut last = MAINTENANCE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if last.is_none_or(|time| time.elapsed() >= Duration::from_secs(60)) {
            prune_cache(&self.root, CACHE_BUDGET_BYTES);
            *last = Some(std::time::Instant::now());
        }
        Ok(())
    }
}

fn prune_cache(root: &Path, budget: u64) {
    let mut files = Vec::new();
    let Ok(shards) = fs::read_dir(root) else {
        return;
    };
    for shard in shards.flatten() {
        if !shard.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(shard.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
            if path.extension().is_some_and(|extension| extension == "tmp") {
                if SystemTime::now()
                    .duration_since(modified)
                    .is_ok_and(|age| age > Duration::from_secs(3600))
                {
                    let _ = fs::remove_file(path);
                }
            } else if path
                .extension()
                .is_some_and(|extension| extension == "lcft")
            {
                files.push((modified, metadata.len(), path));
            }
        }
    }
    let mut total: u64 = files.iter().map(|(_, size, _)| *size).sum();
    files.sort_unstable_by_key(|(modified, _, _)| *modified);
    for (_, size, path) in files {
        if total <= budget {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache(root: &Path, fingerprint: &str, start: i64, end: i64) -> FrameTraceCache {
        FrameTraceCache::new(
            &Preferences {
                cache_dir: root.to_string_lossy().into_owned(),
                ..Preferences::default()
            },
            fingerprint,
            0,
            25.0,
            start,
            end,
        )
    }

    #[test]
    fn cache_is_a_sibling_and_identity_invalidates_media_range_and_stream() {
        let root = std::env::temp_dir().join("trace-layout-test");
        let first = cache(&root, "media-a", 0, 1);
        assert_eq!(first.root, root.join("Frame Trace Cache"));
        assert_ne!(first.path, cache(&root, "media-b", 0, 1).path);
        assert_ne!(first.path, cache(&root, "media-a", 1, 2).path);
        let preferences = Preferences {
            cache_dir: root.to_string_lossy().into_owned(),
            ..Preferences::default()
        };
        assert_ne!(
            first.path,
            FrameTraceCache::new(&preferences, "media-a", 1, 25.0, 0, 1).path
        );
        assert_ne!(
            first.path,
            FrameTraceCache::new(&preferences, "media-a", 0, 30.0, 0, 1).path
        );
    }

    #[test]
    fn roundtrip_corruption_and_sample_validation() {
        let root = std::env::temp_dir().join(format!("trace-cache-test-{}", Uuid::new_v4()));
        let cache = cache(&root, "media", 0, 1);
        let data = FrameTraceData {
            motion: vec![0.25],
            colors: vec![[0.0; 4]; 2],
            sharpness: vec![0.0, 1.0],
        };
        cache.write(&data).unwrap();
        assert_eq!(cache.read().unwrap().motion, data.motion);
        let mut invalid = data.clone();
        invalid.sharpness[0] = f64::NAN;
        assert!(cache.write(&invalid).is_err());
        let mut bytes = fs::read(&cache.path).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        fs::write(&cache.path, bytes).unwrap();
        assert!(cache.read().is_none());
        cache.write(&data).unwrap();
        assert!(cache.read().is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_budget_evicts_oldest_and_generation_is_coalesced() {
        let root = std::env::temp_dir().join(format!("trace-budget-test-{}", Uuid::new_v4()));
        let a = cache(&root, "a", 0, 0);
        let b = cache(&root, "b", 0, 0);
        assert!(Arc::ptr_eq(&a.generation_lock(), &a.generation_lock()));
        let data = FrameTraceData {
            motion: vec![],
            colors: vec![[0.0; 4]],
            sharpness: vec![0.0],
        };
        a.write(&data).unwrap();
        b.write(&data).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&a.path).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1)))
            .unwrap();
        prune_cache(&a.root, fs::metadata(&b.path).unwrap().len());
        assert!(!a.path.exists());
        assert!(b.read().is_some());
        fs::remove_dir_all(root).unwrap();
    }
}
