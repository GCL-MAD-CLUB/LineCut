use super::*;

pub(crate) async fn probe_media(
    path: &Path,
    preferences: &Preferences,
    state: &AppState,
    task_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<ProbeOutput> {
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-show_format".to_string(),
        "-show_streams".to_string(),
        "-show_chapters".to_string(),
        "-of".to_string(),
        "json".to_string(),
        path.to_string_lossy().into_owned(),
    ];
    let program = ffprobe_program(preferences);
    let stdout = run_output(&program, &args, state, task_id, cancel.clone()).await?;
    spawn_blocking_cancellable(cancel, "parse media probe output", move |_| {
        serde_json::from_str(&stdout).map_err(|error| {
            app_error(
                ErrorCode::MediaProbeDecodeFailed,
                format!("Failed to decode ffprobe JSON output: {error}"),
            )
        })
    })
    .await
}

pub(crate) fn fingerprint_file(
    path: &Path,
    meta: &fs::Metadata,
    modified_at: i64,
    cancel: &AtomicBool,
) -> AppResult<String> {
    ensure_not_cancelled(cancel)?;
    let mut file = fs::File::open(path).map_err(|error| {
        app_error(
            ErrorCode::MediaReadFailed,
            format!("Failed to open media file: {error}"),
        )
    })?;
    let mut hasher = Sha256::new();
    hasher.update(meta.len().to_le_bytes());
    hasher.update(modified_at.to_le_bytes());

    let head_len = meta.len().min(HEAD_TAIL_HASH_BYTES) as usize;
    let mut head = vec![0u8; head_len];
    file.read_exact(&mut head).map_err(|error| {
        app_error(
            ErrorCode::MediaReadFailed,
            format!("Failed to read the media file header: {error}"),
        )
    })?;
    hasher.update(&head);
    ensure_not_cancelled(cancel)?;

    if meta.len() > HEAD_TAIL_HASH_BYTES {
        let tail_len = meta.len().min(HEAD_TAIL_HASH_BYTES) as usize;
        file.seek(SeekFrom::End(-(tail_len as i64)))
            .map_err(|error| {
                app_error(
                    ErrorCode::MediaReadFailed,
                    format!("Failed to seek to the media file tail: {error}"),
                )
            })?;
        let mut tail = vec![0u8; tail_len];
        file.read_exact(&mut tail).map_err(|error| {
            app_error(
                ErrorCode::MediaReadFailed,
                format!("Failed to read the media file tail: {error}"),
            )
        })?;
        hasher.update(&tail);
    }

    ensure_not_cancelled(cancel)?;
    Ok(format!("{:x}", hasher.finalize()))
}

pub(crate) fn modified_secs(meta: &fs::Metadata) -> i64 {
    let modified = match meta.modified() {
        Ok(modified) => modified,
        Err(error) => {
            app_error(
                ErrorCode::MediaReadFailed,
                format!("Failed to read media modification time: {error}"),
            );
            return 0;
        }
    };
    match modified.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs() as i64,
        Err(error) => {
            app_error(
                ErrorCode::MediaReadFailed,
                format!("Media modification time is earlier than the Unix epoch: {error}"),
            );
            0
        }
    }
}

pub(crate) fn tag_value(tags: &HashMap<String, String>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = tags.get(*key) {
            if !value.trim().is_empty() {
                return Some(value.clone());
            }
        }
    }
    None
}
