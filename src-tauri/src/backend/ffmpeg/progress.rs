//! Machine-readable progress, cancellation and stall monitoring.
use super::process::hidden_command;
use crate::backend::{
    clear_running_ffmpeg, ensure_not_cancelled, register_running_ffmpeg,
    remove_cleanup_paths_async, AppState,
};
use crate::error::{app_error, AppResult, ErrorCode};
use crate::FFMPEG_PROGRESS_EVENT;
use serde::Serialize;
use std::{
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct FfmpegProgressPayload {
    pub(crate) task_id: String,
    pub(crate) progress: f64,
}

pub(crate) struct FfmpegProgressContext<'a> {
    pub(crate) app: &'a tauri::AppHandle,
    pub(crate) state: &'a AppState,
    pub(crate) task_id: &'a str,
    /// Identifies the exact clip/output guarded by this FFmpeg process in logs.
    pub(crate) watchdog_label: String,
    pub(crate) cancel: Arc<AtomicBool>,
    pub(crate) base_progress: f64,
    pub(crate) progress_span: f64,
    pub(crate) duration_us: i64,
    pub(crate) cleanup_paths: Vec<PathBuf>,
    /// A logical operation may run more than one FFmpeg process.  In that
    /// case the caller aggregates every child process' local progress before
    /// publishing it to the UI.
    pub(crate) progress_callback: Option<Arc<dyn Fn(f64) + Send + Sync>>,
}

/// FFmpeg defaults to reporting progress twice per second. A shorter period
/// keeps the export bar visibly moving for a single output as well as for a
/// parallel batch, while remaining inexpensive compared with encoding work.
const FFMPEG_PROGRESS_PERIOD_SECONDS: &str = "0.10";
const FFMPEG_PROGRESS_MIN_DELTA: f64 = 0.001;
const FFMPEG_PROGRESS_POLL_INTERVAL: Duration = Duration::from_millis(120);
const FFMPEG_PROGRESS_STALL_MIN_SECONDS: u64 = 20;
const FFMPEG_PROGRESS_STALL_MAX_SECONDS: u64 = 60;
const FFMPEG_FINALIZATION_STALL_TIMEOUT: Duration = Duration::from_secs(180);

fn ffmpeg_progress_stall_timeout(duration_us: i64) -> Duration {
    let duration_seconds = (duration_us.max(1) as u64).div_ceil(1_000_000);
    Duration::from_secs(duration_seconds.saturating_mul(2).saturating_add(8).clamp(
        FFMPEG_PROGRESS_STALL_MIN_SECONDS,
        FFMPEG_PROGRESS_STALL_MAX_SECONDS,
    ))
}

pub(crate) fn ffmpeg_args_with_progress(args: &[String]) -> Vec<String> {
    let mut next = Vec::with_capacity(args.len() + 5);
    let mut inserted = false;

    for arg in args {
        next.push(arg.clone());
        if !inserted && arg == "-hide_banner" {
            next.push("-nostats".to_string());
            next.push("-stats_period".to_string());
            next.push(FFMPEG_PROGRESS_PERIOD_SECONDS.to_string());
            next.push("-progress".to_string());
            next.push("pipe:1".to_string());
            inserted = true;
        }
    }

    if !inserted {
        next.splice(
            0..0,
            [
                "-nostats".to_string(),
                "-stats_period".to_string(),
                FFMPEG_PROGRESS_PERIOD_SECONDS.to_string(),
                "-progress".to_string(),
                "pipe:1".to_string(),
            ],
        );
    }

    next
}

/// FFmpeg's modern and older builds use slightly different progress keys.
/// `out_time_ms` is a historical name but, per FFmpeg's progress protocol,
/// carries microseconds just like `out_time_us`.
fn ffmpeg_progress_time_us(line: &str) -> Option<i64> {
    let value = line
        .strip_prefix("out_time_us=")
        .or_else(|| line.strip_prefix("out_time_ms="));
    if let Some(value) = value {
        return value.trim().parse::<i64>().ok();
    }

    let value = line.strip_prefix("out_time=")?.trim();
    let mut fields = value.split(':');
    let hours = fields.next()?.parse::<i64>().ok()?;
    let minutes = fields.next()?.parse::<i64>().ok()?;
    let seconds = fields.next()?.parse::<f64>().ok()?;
    if fields.next().is_some() || hours < 0 || minutes < 0 || seconds < 0.0 {
        return None;
    }
    let microseconds = (hours as f64 * 3600.0 + minutes as f64 * 60.0 + seconds) * 1_000_000.0;
    if !microseconds.is_finite() {
        return None;
    }

    Some(microseconds.min(i64::MAX as f64).round() as i64)
}

pub(crate) fn emit_ffmpeg_progress(app: &tauri::AppHandle, task_id: &str, progress: f64) {
    if let Err(error) = app.emit(
        FFMPEG_PROGRESS_EVENT,
        FfmpegProgressPayload {
            task_id: task_id.to_string(),
            progress: progress.clamp(0.0, 1.0),
        },
    ) {
        let _ = app_error(
            ErrorCode::EventEmitFailed,
            format!("Failed to emit FFmpeg progress event: {error}"),
        );
    }
}

fn emit_context_progress(progress: &FfmpegProgressContext<'_>, value: f64) {
    let value = value.clamp(0.0, 1.0);
    if let Some(callback) = &progress.progress_callback {
        callback(value);
    } else {
        emit_ffmpeg_progress(progress.app, progress.task_id, value);
    }
}

pub(crate) async fn run_status_with_ffmpeg_progress(
    program: &str,
    args: &[String],
    progress: FfmpegProgressContext<'_>,
) -> AppResult<()> {
    ensure_not_cancelled(&progress.cancel)?;
    let progress_args = ffmpeg_args_with_progress(args);
    let task_id = Uuid::new_v4().to_string();
    let started_at = tokio::time::Instant::now();
    let cancel = progress.cancel.clone();
    let mut child = hidden_command(program)
        .args(&progress_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            app_error(
                ErrorCode::ExternalToolStartFailed,
                format!("Failed to start external tool {program}: {error}"),
            )
        })?;
    let pid = child.id();
    if let Err(err) = register_running_ffmpeg(
        progress.state,
        task_id.clone(),
        progress.task_id.to_string(),
        cancel.clone(),
        pid,
        progress.cleanup_paths.clone(),
    ) {
        let _ = child.start_kill();
        return Err(err);
    }
    tracing::info!(
        pid,
        logical_task_id = progress.task_id,
        watchdog_label = %progress.watchdog_label,
        expected_duration_us = progress.duration_us,
        process_id = %task_id,
        program,
        argument_count = progress_args.len(),
        "started monitored FFmpeg process"
    );

    let stdout = child.stdout.take().ok_or_else(|| {
        app_error(
            ErrorCode::ExternalToolOutputUnavailable,
            format!("External tool {program} did not expose a progress stream"),
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        app_error(
            ErrorCode::ExternalToolOutputUnavailable,
            format!("External tool {program} did not expose a diagnostic stream"),
        )
    })?;

    let stderr_task = tokio::spawn(async move {
        let mut body = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut body).await;
        body
    });

    emit_context_progress(&progress, progress.base_progress);

    let mut lines = BufReader::new(stdout).lines();
    let mut last_emitted = progress.base_progress;
    let duration_us_i64 = progress.duration_us.max(1);
    let duration_us = duration_us_i64 as f64;
    let media_stall_timeout = ffmpeg_progress_stall_timeout(duration_us_i64);
    let mut greatest_out_time_us = 0_i64;
    let mut last_media_progress_at = tokio::time::Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = stderr_task.await;
            remove_cleanup_paths_async(progress.cleanup_paths.clone()).await;
            clear_running_ffmpeg(progress.state, &task_id);
            emit_context_progress(&progress, last_emitted);
            return Err(app_error(
                ErrorCode::TaskCancelled,
                "Task cancellation was requested",
            ));
        }

        let reached_output_end = greatest_out_time_us >= duration_us_i64.saturating_sub(100_000);
        let stall_timeout = if reached_output_end {
            FFMPEG_FINALIZATION_STALL_TIMEOUT
        } else {
            media_stall_timeout
        };
        if last_media_progress_at.elapsed() >= stall_timeout {
            tracing::warn!(
                pid,
                logical_task_id = progress.task_id,
                watchdog_label = %progress.watchdog_label,
                greatest_out_time_us,
                duration_us = duration_us_i64,
                stall_seconds = stall_timeout.as_secs(),
                "terminating stalled FFmpeg export"
            );
            let _ = child.start_kill();
            let _ = child.wait().await;
            let stderr = stderr_task.await.unwrap_or_default();
            remove_cleanup_paths_async(progress.cleanup_paths.clone()).await;
            clear_running_ffmpeg(progress.state, &task_id);
            emit_context_progress(&progress, last_emitted);
            return Err(app_error(
                ErrorCode::ExternalToolExecutionFailed,
                format!(
                    "External tool {program} made no media progress for {} seconds at {:.3}/{:.3} seconds; stderr={}",
                    stall_timeout.as_secs(),
                    greatest_out_time_us as f64 / 1_000_000.0,
                    duration_us / 1_000_000.0,
                    stderr.trim()
                ),
            ));
        }

        let line =
            match tokio::time::timeout(FFMPEG_PROGRESS_POLL_INTERVAL, lines.next_line()).await {
                Ok(Ok(Some(line))) => line,
                Ok(Ok(None)) => break,
                Ok(Err(err)) => {
                    clear_running_ffmpeg(progress.state, &task_id);
                    return Err(app_error(
                        ErrorCode::ExternalToolOutputInvalid,
                        format!("Failed to read progress from external tool {program}: {err}"),
                    ));
                }
                Err(_) => continue,
            };

        if let Some(out_time_us) = ffmpeg_progress_time_us(&line) {
            if out_time_us > greatest_out_time_us {
                greatest_out_time_us = out_time_us;
                last_media_progress_at = tokio::time::Instant::now();
            }
            let local_progress = (out_time_us.max(0) as f64 / duration_us).clamp(0.0, 1.0);
            let overall_progress = progress.base_progress + local_progress * progress.progress_span;
            if overall_progress - last_emitted >= FFMPEG_PROGRESS_MIN_DELTA
                || overall_progress >= 1.0
            {
                emit_context_progress(&progress, overall_progress);
                last_emitted = overall_progress;
            }
        } else if line.trim() == "progress=end" {
            last_media_progress_at = tokio::time::Instant::now();
            last_emitted = progress.base_progress + progress.progress_span;
            emit_context_progress(&progress, last_emitted);
        }
    }

    let status = match child.wait().await {
        Ok(status) => status,
        Err(err) => {
            clear_running_ffmpeg(progress.state, &task_id);
            return Err(app_error(
                ErrorCode::ExternalToolWaitFailed,
                format!("Failed to wait for external tool {program}: {err}"),
            ));
        }
    };
    let stderr = stderr_task.await.map_err(|error| {
        app_error(
            ErrorCode::BlockingTaskFailed,
            format!("External tool diagnostic reader failed to join: {error}"),
        )
    })?;
    let was_cancelled = cancel.load(Ordering::SeqCst);
    clear_running_ffmpeg(progress.state, &task_id);

    if status.success() {
        // Completed files survive: a cancel arriving after completion must not
        // delete the finished output (mid-encode cancels are handled above).
        tracing::info!(
            pid,
            logical_task_id = progress.task_id,
            watchdog_label = %progress.watchdog_label,
            greatest_out_time_us,
            elapsed_ms = started_at.elapsed().as_millis() as u64,
            exit_code = status.code(),
            stderr_bytes = stderr.len(),
            "monitored FFmpeg process completed"
        );
        emit_context_progress(&progress, progress.base_progress + progress.progress_span);
        Ok(())
    } else {
        remove_cleanup_paths_async(progress.cleanup_paths.clone()).await;
        emit_context_progress(&progress, last_emitted);
        if was_cancelled {
            Err(app_error(
                ErrorCode::TaskCancelled,
                "Task cancellation was requested",
            ))
        } else {
            tracing::warn!(
                pid,
                process_id = %task_id,
                logical_task_id = progress.task_id,
                program,
                elapsed_ms = started_at.elapsed().as_millis() as u64,
                exit_code = status.code(),
                greatest_out_time_us,
                stderr_bytes = stderr.len(),
                "monitored FFmpeg process failed"
            );
            Err(app_error(
                ErrorCode::ExternalToolExecutionFailed,
                format!("External tool {program} exited unsuccessfully; stderr={stderr}"),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffmpeg_progress_arguments_request_frequent_machine_readable_updates() {
        let args = vec![
            "-hide_banner".to_string(),
            "-i".to_string(),
            "input.mp4".to_string(),
        ];
        let progress_args = ffmpeg_args_with_progress(&args);
        assert!(progress_args.windows(2).any(|window| {
            window[0] == "-stats_period" && window[1] == FFMPEG_PROGRESS_PERIOD_SECONDS
        }));
        assert!(progress_args
            .windows(2)
            .any(|window| { window[0] == "-progress" && window[1] == "pipe:1" }));
    }

    #[test]
    fn ffmpeg_progress_stall_timeout_scales_for_short_clips_and_is_bounded() {
        assert_eq!(
            ffmpeg_progress_stall_timeout(1_390_000),
            Duration::from_secs(20)
        );
        assert_eq!(
            ffmpeg_progress_stall_timeout(4_890_000),
            Duration::from_secs(20)
        );
        assert_eq!(
            ffmpeg_progress_stall_timeout(20_000_000),
            Duration::from_secs(48)
        );
        assert_eq!(
            ffmpeg_progress_stall_timeout(i64::MAX),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn ffmpeg_progress_time_supports_modern_legacy_and_text_keys() {
        assert_eq!(
            ffmpeg_progress_time_us("out_time_us=1234567"),
            Some(1_234_567)
        );
        assert_eq!(
            ffmpeg_progress_time_us("out_time_ms=1234567"),
            Some(1_234_567)
        );
        assert_eq!(
            ffmpeg_progress_time_us("out_time=01:02:03.500000"),
            Some(3_723_500_000)
        );
        assert_eq!(ffmpeg_progress_time_us("out_time=N/A"), None);
    }
}
