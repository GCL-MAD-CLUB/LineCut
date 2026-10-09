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
