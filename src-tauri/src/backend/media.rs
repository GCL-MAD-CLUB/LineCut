use super::*;

const AUDIO_INTERVAL_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const AUDIO_INTERVAL_PROBE_PADDING_US: i64 = 250_000;
const AUDIO_INTERVAL_MIN_COVERAGE_US: i64 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AudioIntervalCoverage {
    pub(crate) start_offset_us: i64,
    pub(crate) end_offset_us: i64,
}

/// FFprobe treats a relative path starting with `-` as an option. Resolve all
/// media-tool inputs before turning them into command arguments so callers do
/// not have to remember that command-line detail.
fn absolute_media_tool_path(path: &Path) -> AppResult<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(app_error(
            ErrorCode::MediaNotFound,
            "Media tool input path is empty",
        ));
    }
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    std::env::current_dir()
        .map(|working_dir| working_dir.join(path))
        .map_err(|error| {
            app_error(
                ErrorCode::MediaReadFailed,
                format!("Failed to resolve the current directory for media input: {error}"),
            )
        })
}

fn parse_optional_frame_time_us(value: Option<&str>) -> Option<i64> {
    let value = value?.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("N/A") {
        None
    } else {
        Some(parse_decimal_seconds_to_us(value))
    }
}

fn parse_audio_interval_coverage(
    output: &str,
    interval_start_us: i64,
    interval_end_us: i64,
) -> Option<AudioIntervalCoverage> {
    let mut first_us: Option<i64> = None;
    let mut last_us: Option<i64> = None;
    for line in output.lines() {
        let mut columns = line.trim().split(',');
        let Some(frame_start_us) = parse_optional_frame_time_us(columns.next()) else {
            continue;
        };
        let frame_duration_us = parse_optional_frame_time_us(columns.next())
            .unwrap_or(1)
            .max(1);
        let frame_end_us = frame_start_us.saturating_add(frame_duration_us);
        if frame_end_us <= interval_start_us || frame_start_us >= interval_end_us {
            continue;
        }
        let covered_start_us = frame_start_us.max(interval_start_us);
        let covered_end_us = frame_end_us.min(interval_end_us);
        first_us = Some(first_us.map_or(covered_start_us, |value| value.min(covered_start_us)));
        last_us = Some(last_us.map_or(covered_end_us, |value| value.max(covered_end_us)));
    }
    let first_us = first_us?;
    let last_us = last_us?;
    if last_us.saturating_sub(first_us) < AUDIO_INTERVAL_MIN_COVERAGE_US {
        return None;
    }
    Some(AudioIntervalCoverage {
        start_offset_us: first_us.saturating_sub(interval_start_us),
        end_offset_us: last_us.saturating_sub(interval_start_us),
    })
}

pub(crate) async fn probe_audio_interval(
    path: &Path,
    audio_track_index: usize,
    interval_us: std::ops::Range<i64>,
    preferences: &Preferences,
    state: &AppState,
    task_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<Option<AudioIntervalCoverage>> {
    let path = absolute_media_tool_path(path)?;
    let interval_start_us = interval_us.start;
    let interval_end_us = interval_us.end;
    if interval_end_us <= interval_start_us {
        return Ok(None);
    }
    let read_start_us = interval_start_us
        .saturating_sub(AUDIO_INTERVAL_PROBE_PADDING_US)
        .max(0);
    let read_end_us = interval_end_us.saturating_add(AUDIO_INTERVAL_PROBE_PADDING_US);
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-read_intervals".to_string(),
        format!(
            "{:.6}%{:.6}",
            read_start_us as f64 / 1_000_000.0,
            read_end_us as f64 / 1_000_000.0
        ),
        "-select_streams".to_string(),
        format!("a:{audio_track_index}"),
        "-show_frames".to_string(),
        "-show_entries".to_string(),
        "frame=pts_time,duration_time".to_string(),
        "-of".to_string(),
        "csv=p=0".to_string(),
        path.to_string_lossy().into_owned(),
    ];
    let output = run_output_with_timeout(
        &ffprobe_program(preferences),
        &args,
        state,
        task_id,
        cancel,
        AUDIO_INTERVAL_PROBE_TIMEOUT,
    )
    .await?;
    Ok(parse_audio_interval_coverage(
        &output,
        interval_start_us,
        interval_end_us,
    ))
}

async fn probe_media_inner(
    path: &Path,
    preferences: &Preferences,
    state: &AppState,
    task_id: &str,
    cancel: Arc<AtomicBool>,
    max_duration: Option<Duration>,
) -> AppResult<ProbeOutput> {
    let path = absolute_media_tool_path(path)?;
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
    let stdout = if let Some(max_duration) = max_duration {
        run_output_with_timeout(
            &program,
            &args,
            state,
            task_id,
            cancel.clone(),
            max_duration,
        )
        .await?
    } else {
        run_output(&program, &args, state, task_id, cancel.clone()).await?
    };
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

pub(crate) async fn probe_media(
    path: &Path,
    preferences: &Preferences,
    state: &AppState,
    task_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<ProbeOutput> {
    probe_media_inner(path, preferences, state, task_id, cancel, None).await
}

pub(crate) async fn probe_media_with_timeout(
    path: &Path,
    preferences: &Preferences,
    state: &AppState,
    task_id: &str,
    cancel: Arc<AtomicBool>,
    max_duration: Duration,
) -> AppResult<ProbeOutput> {
    probe_media_inner(
        path,
        preferences,
        state,
        task_id,
        cancel,
        Some(max_duration),
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_interval_coverage_ignores_frames_outside_the_clip() {
        let output = "75.900000,0.020000\n76.100000,0.020000\n77.820000,0.020000\n";
        assert_eq!(
            parse_audio_interval_coverage(output, 76_000_000, 77_800_000),
            Some(AudioIntervalCoverage {
                start_offset_us: 100_000,
                end_offset_us: 120_000,
            })
        );
        assert_eq!(
            parse_audio_interval_coverage("75.900000,0.020000\n", 76_000_000, 77_800_000),
            None
        );
    }

    #[test]
    fn media_tool_paths_are_absolute_before_being_passed_to_ffprobe() {
        let path = absolute_media_tool_path(Path::new("-media.mp4")).unwrap();
        assert!(path.is_absolute());
    }
}
