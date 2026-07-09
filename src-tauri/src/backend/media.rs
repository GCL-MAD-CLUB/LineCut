use super::*;

pub(crate) async fn probe_media(
    path: &Path,
    preferences: &Preferences,
    state: &AppState,
    task_id: &str,
    cancel: Arc<AtomicBool>,
) -> Result<ProbeOutput, String> {
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
    spawn_blocking_cancellable(cancel, "解析媒体信息", move |_| {
        serde_json::from_str(&stdout).map_err(|e| format!("ffprobe JSON 解析失败: {e}"))
    })
    .await
}

pub(crate) fn fingerprint_file(
    path: &Path,
    meta: &fs::Metadata,
    modified_at: i64,
    cancel: &AtomicBool,
) -> Result<String, String> {
    ensure_not_cancelled(cancel)?;
    let mut file = fs::File::open(path).map_err(|e| format!("打开媒体文件失败: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(meta.len().to_le_bytes());
    hasher.update(modified_at.to_le_bytes());

    let head_len = meta.len().min(HEAD_TAIL_HASH_BYTES) as usize;
    let mut head = vec![0u8; head_len];
    file.read_exact(&mut head)
        .map_err(|e| format!("读取媒体文件头失败: {e}"))?;
    hasher.update(&head);
    ensure_not_cancelled(cancel)?;

    if meta.len() > HEAD_TAIL_HASH_BYTES {
        let tail_len = meta.len().min(HEAD_TAIL_HASH_BYTES) as usize;
        file.seek(SeekFrom::End(-(tail_len as i64)))
            .map_err(|e| format!("定位媒体文件尾失败: {e}"))?;
        let mut tail = vec![0u8; tail_len];
        file.read_exact(&mut tail)
            .map_err(|e| format!("读取媒体文件尾失败: {e}"))?;
        hasher.update(&tail);
    }

    ensure_not_cancelled(cancel)?;
    Ok(format!("{:x}", hasher.finalize()))
}

pub(crate) fn modified_secs(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
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
