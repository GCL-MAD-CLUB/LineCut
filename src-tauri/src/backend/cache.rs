//! Shared private-cache encoding and integrity checks.
//! Domain modules retain ownership of identities, locking and eviction policy.
use crate::error::{app_error, AppResult, ErrorCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

#[derive(Serialize, Deserialize)]
struct PrivateCacheEnvelope {
    version: u16,
    digest: [u8; 32],
    payload: Vec<u8>,
}

pub(super) fn read_private_cache<Value>(path: &Path, key: &str, context: &[u8]) -> Option<Value>
where
    Value: for<'de> Deserialize<'de>,
{
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            app_error(
                ErrorCode::ThumbnailCacheReadFailed,
                format!(
                    "Failed to read thumbnail cache file {}: {error}",
                    path.display()
                ),
            );
            return None;
        }
    };
    let envelope = match bincode::deserialize::<PrivateCacheEnvelope>(&bytes) {
        Ok(envelope) => envelope,
        Err(error) => {
            app_error(
                ErrorCode::ThumbnailCacheInvalid,
                format!(
                    "Failed to decode thumbnail cache envelope {}: {error}",
                    path.display()
                ),
            );
            return None;
        }
    };
    if envelope.version != 1 {
        return None;
    }
    let serialized = transform_private_payload(&envelope.payload, key, context);
    if private_cache_digest(&serialized, key, context) != envelope.digest {
        app_error(
            ErrorCode::ThumbnailCacheInvalid,
            format!(
                "Thumbnail cache digest does not match for {}",
                path.display()
            ),
        );
        return None;
    }
    match bincode::deserialize(&serialized) {
        Ok(value) => Some(value),
        Err(error) => {
            app_error(
                ErrorCode::ThumbnailCacheInvalid,
                format!(
                    "Failed to decode thumbnail cache payload {}: {error}",
                    path.display()
                ),
            );
            None
        }
    }
}

pub(super) fn write_private_cache<Value>(
    path: &Path,
    key: &str,
    context: &[u8],
    value: &Value,
) -> AppResult<()>
where
    Value: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            app_error(
                ErrorCode::ThumbnailCacheWriteFailed,
                format!("Failed to create the thumbnail cache directory: {error}"),
            )
        })?;
    }
    let serialized = bincode::serialize(value).map_err(|error| {
        app_error(
            ErrorCode::ThumbnailCacheWriteFailed,
            format!("Failed to encode thumbnail cache data: {error}"),
        )
    })?;
    let envelope = PrivateCacheEnvelope {
        version: 1,
        digest: private_cache_digest(&serialized, key, context),
        payload: transform_private_payload(&serialized, key, context),
    };
    let output = bincode::serialize(&envelope).map_err(|error| {
        app_error(
            ErrorCode::ThumbnailCacheWriteFailed,
            format!("Failed to encode the thumbnail cache envelope: {error}"),
        )
    })?;
    fs::write(path, output).map_err(|error| {
        app_error(
            ErrorCode::ThumbnailCacheWriteFailed,
            format!(
                "Failed to write thumbnail cache file {}: {error}",
                path.display()
            ),
        )
    })
}

/// Read older formats only inside our copied cache tree, without a runtime migration.
pub(super) fn read_renamed_private_cache<Value>(
    path: &Path,
    key: &str,
    context: &[u8],
    legacy_path: &Path,
    legacy_key: &str,
    legacy_context: &[u8],
) -> Option<Value>
where
    Value: Serialize + for<'de> Deserialize<'de>,
{
    if let Some(value) = read_private_cache(path, key, context) {
        return Some(value);
    }
    read_private_cache(legacy_path, legacy_key, legacy_context)
}

fn private_cache_digest(bytes: &[u8], key: &str, context: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(context);
    hasher.update(key.as_bytes());
    hasher.update(bytes);
    hasher.finalize().into()
}

fn transform_private_payload(bytes: &[u8], key: &str, context: &[u8]) -> Vec<u8> {
    let mut transformed = Vec::with_capacity(bytes.len());
    for (block_index, chunk) in bytes.chunks(32).enumerate() {
        let mut hasher = Sha256::new();
        hasher.update(context);
        hasher.update(key.as_bytes());
        hasher.update((block_index as u64).to_le_bytes());
        let key_stream = hasher.finalize();
        transformed.extend(
            chunk
                .iter()
                .zip(key_stream.iter())
                .map(|(byte, key_byte)| byte ^ key_byte),
        );
    }
    transformed
}

pub(super) fn hash_name(context: &[u8], value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(context);
    hasher.update(value);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copied_legacy_cache_is_read_without_runtime_writes() {
        let root =
            std::env::temp_dir().join(format!("locution-cache-migration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let legacy = root.join("legacy");
        write_private_cache(&legacy, "old-key", b"old-context", &vec![1u8, 2, 3]).unwrap();
        let blocker = root.join("blocker");
        fs::write(&blocker, b"file").unwrap();
        let current = blocker.join("new");
        let value: Vec<u8> = read_renamed_private_cache(
            &current,
            "new-key",
            b"new-context",
            &legacy,
            "old-key",
            b"old-context",
        )
        .unwrap();
        assert_eq!(value, vec![1, 2, 3]);
        assert!(!current.exists());
        assert!(legacy.exists());
        fs::remove_file(&blocker).unwrap();
        assert!(read_renamed_private_cache::<Vec<u8>>(
            &current,
            "new-key",
            b"new-context",
            &legacy,
            "old-key",
            b"old-context"
        )
        .is_some());
        assert!(!current.exists());
        assert_eq!(
            fs::read(&blocker).err().unwrap().kind(),
            std::io::ErrorKind::NotFound
        );
        fs::remove_dir_all(root).unwrap();
    }
}
