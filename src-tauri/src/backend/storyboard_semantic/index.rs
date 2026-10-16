//! Complete SigLIP2 indexes and resumable per-shot checkpoints, separate from CSES.
use super::*;
use bincode::Options;

const RECIPE: &str =
    "siglip2-d1114256522a37ffa257a0a58017348ab0058db2-vision-fp16-text-int8-rgb256-l2-v1";
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const MEMORY_BYTES: usize = 32 * 1024 * 1024;
struct WarmIndex {
    path: PathBuf,
    stamp: (u64, SystemTime),
    index: Arc<Index>,
    bytes: usize,
}
static WARM: Mutex<std::collections::VecDeque<WarmIndex>> =
    Mutex::new(std::collections::VecDeque::new());

#[derive(Serialize, Deserialize)]
struct Index {
    recipe: String,
    identity: cache::ShotIdentity,
    frames: Vec<usize>,
    vectors: Vec<Option<Vec<f32>>>,
    complete: bool,
}

pub(super) fn root(preferences: &Preferences) -> PathBuf {
    configured_cache_root(preferences).join("Storyboard Semantic Search")
}

fn path(root: &Path, identity: &cache::ShotIdentity, frames: &[usize]) -> AppResult<PathBuf> {
    let key = serde_json::to_vec(&(RECIPE, identity, frames)).map_err(inference_error)?;
    // Hash only the small identity, never the media or model files.
    Ok(root.join(format!("{:x}.bin", Sha256::digest(key))))
}

fn codec() -> impl Options {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(MAX_BYTES)
        .reject_trailing_bytes()
}

fn valid(index: &Index, identity: &cache::ShotIdentity, frames: &[usize]) -> bool {
    index.recipe == RECIPE
        && &index.identity == identity
        && index.frames == frames
        && !frames.is_empty()
        && frames.len() <= 32
        && frames.windows(2).all(|p| p[0] < p[1])
        && frames
            .iter()
            .all(|&f| f >= identity.start_frame && f <= identity.end_frame)
        && index.vectors.len() == frames.len()
        && index.vectors.iter().flatten().all(|v| {
            v.len() == siglip::DIMENSIONS
                && v.iter().all(|x| x.is_finite())
                && (v.iter().map(|&x| f64::from(x).powi(2)).sum::<f64>() - 1.0).abs() < 0.001
        })
}

fn load(path: &Path, identity: &cache::ShotIdentity, frames: &[usize]) -> Option<Index> {
    if fs::metadata(path).ok()?.len() > MAX_BYTES {
        return None;
    }
    let index: Index = codec().deserialize(&fs::read(path).ok()?).ok()?;
    valid(&index, identity, frames).then_some(index)
}

fn complete(path: &Path, identity: &cache::ShotIdentity, frames: &[usize]) -> Option<Arc<Index>> {
    let metadata = fs::metadata(path).ok()?;
    let stamp = (metadata.len(), metadata.modified().ok()?);
    if let Ok(mut warm) = WARM.lock() {
        if let Some(position) = warm.iter().position(|entry| entry.path == path) {
            let entry = warm.remove(position)?;
            if entry.stamp == stamp
                && &entry.index.identity == identity
                && entry.index.frames == frames
            {
                let index = Arc::clone(&entry.index);
                warm.push_back(entry);
                return Some(index);
            }
        }
    }
    let index = load(path, identity, frames)?;
    if !index.complete || index.vectors.iter().any(Option::is_none) {
        return None;
    }
    let index = Arc::new(index);
    if let Ok(mut warm) = WARM.lock() {
        warm.retain(|entry| entry.path != path);
        warm.push_back(WarmIndex {
            path: path.into(),
            stamp,
            index: Arc::clone(&index),
            bytes: metadata.len() as usize,
        });
        let mut bytes: usize = warm.iter().map(|entry| entry.bytes).sum();
        while bytes > MEMORY_BYTES {
            bytes -= warm.pop_front()?.bytes;
        }
    }
    Some(index)
}

fn save(path: &Path, index: &Index, cancel: &AtomicBool) -> AppResult<()> {
    use std::io::Write;
    ensure_not_cancelled(cancel)?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let write = (|| {
        let bytes = codec().serialize(index).map_err(inference_error)?;
        let mut file = fs::File::create(&temporary).map_err(inference_error)?;
        file.write_all(&bytes).map_err(inference_error)?;
        file.sync_all().map_err(inference_error)?;
        drop(file);
        ensure_not_cancelled(cancel)?;
        fs::rename(&temporary, path).map_err(inference_error)
    })();
    if write.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write
}

pub(super) fn read(
    root: &Path,
    identity: &cache::ShotIdentity,
    frames: &[usize],
) -> AppResult<Vec<Vec<f32>>> {
    let path = path(root, identity, frames)?;
    complete(&path, identity, frames)
        .and_then(|index| index.vectors.iter().cloned().collect::<Option<Vec<_>>>())
        .ok_or_else(|| {
            inference_error(
                "Storyboard semantic index is missing or incomplete; rebuild before retrieval",
            )
        })
}

pub(super) fn get_or_build(
    root: &Path,
    source: &ShotSource,
    frames: &[usize],
    cancel: &AtomicBool,
    build: impl FnOnce(&[usize], &mut dyn FnMut(&[Vec<f32>]) -> AppResult<()>) -> AppResult<()>,
) -> AppResult<()> {
    ensure_not_cancelled(cancel)?;
    fs::create_dir_all(root).map_err(inference_error)?;
    let path = path(root, &source.identity, frames)?;
    if complete(&path, &source.identity, frames).is_some() {
        return Ok(());
    }
    let mut index = load(&path, &source.identity, frames).unwrap_or_else(|| Index {
        recipe: RECIPE.into(),
        identity: source.identity.clone(),
        frames: frames.to_vec(),
        vectors: vec![None; frames.len()],
        complete: false,
    });
    let pending: Vec<usize> = (0..frames.len())
        .filter(|&i| index.vectors[i].is_none())
        .collect();
    if pending.is_empty() {
        // All batches survived a cancellation before final publication.
        // A new uncancelled build can promote that validated checkpoint.
        index.complete = true;
        return save(&path, &index, cancel);
    }
    let positions: Vec<usize> = pending
        .iter()
        .map(|&i| frames[i] - source.shot.start_frame)
        .collect();
    let mut completed = 0;
    build(&positions, &mut |vectors| {
        ensure_not_cancelled(cancel)?;
        if completed + vectors.len() > pending.len() {
            return Err(inference_error("Too many SigLIP2 vectors"));
        }
        for vector in vectors {
            index.vectors[pending[completed]] = Some(vector.clone());
            completed += 1;
        }
        if !valid(&index, &source.identity, frames) {
            return Err(inference_error("Invalid SigLIP2 index batch"));
        }
        save(&path, &index, cancel)
    })?;
    ensure_not_cancelled(cancel)?;
    if completed != pending.len() {
        return Err(inference_error("Incomplete SigLIP2 encoding"));
    }
    index.complete = true;
    save(&path, &index, cancel)
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
    fn checkpoints_resume_missing_frames_and_reject_stale_or_corrupt_indexes() {
        let directory = env::temp_dir().join(format!("linecut-siglip-{}", Uuid::new_v4()));
        let source = ShotSource {
            shot: SemanticShot {
                id: "shot".into(),
                source: "source".into(),
                asset_id: "asset".into(),
                fingerprint: "a".repeat(64),
                start_frame: 10,
                end_frame: 30,
            },
            identity: cache::ShotIdentity {
                fingerprint: "a".repeat(64),
                media_length: 100,
                media_modified_ns: Some(1),
                stream: 0,
                rate: 25.0,
                start_frame: 10,
                end_frame: 30,
            },
            path: "unused".into(),
            stream: 0,
            rate: 25.0,
            frames: 21,
        };
        let frames = [10, 20];
        let mut vector = vec![0.0; siglip::DIMENSIONS];
        vector[0] = 1.0;
        let cancel = AtomicBool::new(false);
        assert!(get_or_build(
            &directory,
            &source,
            &frames,
            &cancel,
            |positions, publish| {
                assert_eq!(positions, &[0, 10]);
                publish(&[vector.clone()])?;
                cancel.store(true, Ordering::SeqCst);
                ensure_not_cancelled(&cancel)
            }
        )
        .is_err());
        assert!(read(&directory, &source.identity, &frames).is_err());
        cancel.store(false, Ordering::SeqCst);
        get_or_build(
            &directory,
            &source,
            &frames,
            &cancel,
            |positions, publish| {
                assert_eq!(positions, &[10]);
                publish(&[vector.clone()])
            },
        )
        .unwrap();
        assert_eq!(
            read(&directory, &source.identity, &frames).unwrap(),
            vec![vector.clone(), vector]
        );
        get_or_build(&directory, &source, &frames, &cancel, |_, _| {
            panic!("must reuse complete index")
        })
        .unwrap();
        let mut changed = source.identity.clone();
        changed.media_length += 1;
        assert!(read(&directory, &changed, &frames).is_err());
        assert!(read(&directory, &source.identity, &[10, 21]).is_err());
        fs::write(
            path(&directory, &source.identity, &frames).unwrap(),
            b"broken",
        )
        .unwrap();
        assert!(read(&directory, &source.identity, &frames).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
