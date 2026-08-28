use super::*;

/// FFmpeg defaults to reporting progress twice per second. A shorter period
/// keeps the export bar visibly moving for a single output as well as for a
/// parallel batch, while remaining inexpensive compared with encoding work.
const FFMPEG_PROGRESS_PERIOD_SECONDS: &str = "0.10";
const FFMPEG_PROGRESS_MIN_DELTA: f64 = 0.001;
const FFMPEG_PROGRESS_POLL_INTERVAL: Duration = Duration::from_millis(120);
const FFMPEG_PROGRESS_STALL_MIN_SECONDS: u64 = 20;
const FFMPEG_PROGRESS_STALL_MAX_SECONDS: u64 = 60;
const FFMPEG_FINALIZATION_STALL_TIMEOUT: Duration = Duration::from_secs(180);
const FFMPEG_MAX_PROCESSING_THREADS: usize = 16;

pub(crate) fn available_cpu_threads() -> usize {
    std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
}

/// Splits the CPU budget between concurrent FFmpeg processes. Keep the upper
/// bound aligned with the export path so an unusually high core count does not
/// make one short-lived helper process monopolize the machine.
pub(crate) fn ffmpeg_worker_thread_budget(worker_count: usize) -> usize {
    let worker_count = worker_count.max(1);
    let cpu_threads = available_cpu_threads();
    ((cpu_threads + worker_count.saturating_sub(1)) / worker_count)
        .clamp(1, FFMPEG_MAX_PROCESSING_THREADS)
}

pub(crate) fn append_ffmpeg_processing_thread_args(args: &mut Vec<String>, threads: usize) {
    let threads = threads.clamp(1, FFMPEG_MAX_PROCESSING_THREADS).to_string();
    args.extend([
        "-threads".to_string(),
        threads.clone(),
        "-filter_threads".to_string(),
        threads.clone(),
        "-filter_complex_threads".to_string(),
        threads,
    ]);
}

pub(crate) fn append_ffmpeg_video_output_thread_args(args: &mut Vec<String>, threads: usize) {
    args.extend([
        "-threads:v".to_string(),
        threads.clamp(1, FFMPEG_MAX_PROCESSING_THREADS).to_string(),
    ]);
}

fn ffmpeg_progress_stall_timeout(duration_us: i64) -> Duration {
    let duration_seconds = (duration_us.max(1) as u64).div_ceil(1_000_000);
    Duration::from_secs(duration_seconds.saturating_mul(2).saturating_add(8).clamp(
        FFMPEG_PROGRESS_STALL_MIN_SECONDS,
        FFMPEG_PROGRESS_STALL_MAX_SECONDS,
    ))
}

pub(crate) fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    // Kill the child when the owning future is dropped so ffmpeg is never orphaned.
    command.kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

pub(crate) fn register_task<'a>(task_id: &str, state: &'a AppState) -> AppResult<TaskGuard<'a>> {
    if task_id.trim().is_empty() {
        return Err(app_error(
            ErrorCode::TaskIdInvalid,
            "Task identifier is empty",
        ));
    }

    let cancel = Arc::new(AtomicBool::new(false));
    let mut tasks = state.running_tasks.lock().map_err(|_| {
        app_error(
            ErrorCode::TaskStateUnavailable,
            "Task state lock is poisoned",
        )
    })?;
    if tasks.contains_key(task_id) {
        return Err(app_error(
            ErrorCode::TaskAlreadyRunning,
            format!("Task identifier is already registered: {task_id}"),
        ));
    }
    tasks.insert(
        task_id.to_string(),
        RunningTask {
            cancel: cancel.clone(),
            cleanup_paths: Vec::new(),
        },
    );

    Ok(TaskGuard {
        task_id: task_id.to_string(),
        cancel,
        state,
    })
}

pub(crate) fn register_task_cleanup_paths(
    task_id: &str,
    paths: &[PathBuf],
    state: &AppState,
) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut tasks = state.running_tasks.lock().map_err(|_| {
        app_error(
            ErrorCode::TaskStateUnavailable,
            "Task state lock is poisoned",
        )
    })?;
    let task = tasks.get_mut(task_id).ok_or_else(|| {
        app_error(
            ErrorCode::TaskNotFound,
            format!("Task identifier is not registered: {task_id}"),
        )
    })?;
    for path in paths {
        if !task.cleanup_paths.contains(path) {
            task.cleanup_paths.push(path.clone());
        }
    }
    Ok(())
}

pub(crate) fn ensure_not_cancelled(cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(app_error(
            ErrorCode::TaskCancelled,
            "Task cancellation was requested",
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn check_optional_cancel(cancel: Option<&AtomicBool>) -> AppResult<()> {
    cancel.map_or(Ok(()), ensure_not_cancelled)
}

pub(crate) async fn spawn_blocking_cancellable<T, F>(
    cancel: Arc<AtomicBool>,
    operation: &'static str,
    work: F,
) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&AtomicBool) -> AppResult<T> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        ensure_not_cancelled(&cancel)?;
        let result = work(&cancel)?;
        ensure_not_cancelled(&cancel)?;
        Ok(result)
    })
    .await
    .map_err(|error| {
        app_error(
            ErrorCode::BlockingTaskFailed,
            format!("Blocking task join failed during {operation}: {error}"),
        )
    })?
}

pub(crate) fn register_running_ffmpeg(
    state: &AppState,
    id: String,
    task_id: String,
    cancel: Arc<AtomicBool>,
    pid: Option<u32>,
    cleanup_paths: Vec<PathBuf>,
) -> AppResult<()> {
    ensure_not_cancelled(&cancel)?;
    register_task_cleanup_paths(&task_id, &cleanup_paths, state)?;
    let mut running = state.running_ffmpeg.lock().map_err(|_| {
        app_error(
            ErrorCode::TaskStateUnavailable,
            "FFmpeg task state lock is poisoned",
        )
    })?;
    running.insert(
        id.clone(),
        RunningFfmpeg {
            task_id,
            cancel: cancel.clone(),
            pid,
            cleanup_paths,
        },
    );
    if cancel.load(Ordering::SeqCst) {
        running.remove(&id);
        return Err(app_error(
            ErrorCode::TaskCancelled,
            "Task cancellation was requested",
        ));
    }
    Ok(())
}

pub(crate) fn clear_running_ffmpeg(state: &AppState, id: &str) {
    match state.running_ffmpeg.lock() {
        Ok(mut running) => {
            running.remove(id);
        }
        Err(_) => {
            let _ = app_error(
                ErrorCode::TaskStateUnavailable,
                "FFmpeg task state lock is poisoned during cleanup",
            );
        }
    }
}

pub(crate) fn take_task_for_cancellation(
    task_id: &str,
    state: &AppState,
) -> AppResult<(bool, Vec<RunningFfmpeg>, Vec<PathBuf>)> {
    let logical_task = state
        .running_tasks
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::TaskStateUnavailable,
                "Task state lock is poisoned",
            )
        })?
        .get(task_id)
        .cloned();
    if let Some(task) = &logical_task {
        task.cancel.store(true, Ordering::SeqCst);
    }

    let processes = {
        let mut running = state.running_ffmpeg.lock().map_err(|_| {
            app_error(
                ErrorCode::TaskStateUnavailable,
                "FFmpeg task state lock is poisoned",
            )
        })?;
        let matching_ids = running
            .iter()
            .filter(|(_, task)| task.task_id == task_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        matching_ids
            .into_iter()
            .filter_map(|id| running.remove(&id))
            .collect::<Vec<_>>()
    };

    let logical_task_found = logical_task.is_some();
    let cleanup_paths = logical_task
        .map(|task| task.cleanup_paths)
        .unwrap_or_default();
    Ok((
        logical_task_found || !processes.is_empty(),
        processes,
        cleanup_paths,
    ))
}

pub(crate) fn cancel_all_tasks(state: &AppState) -> AppResult<bool> {
    let logical_tasks = state
        .running_tasks
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::TaskStateUnavailable,
                "Task state lock is poisoned",
            )
        })?
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for task in &logical_tasks {
        task.cancel.store(true, Ordering::SeqCst);
    }

    let processes = {
        let mut running = state.running_ffmpeg.lock().map_err(|_| {
            app_error(
                ErrorCode::TaskStateUnavailable,
                "FFmpeg task state lock is poisoned",
            )
        })?;
        running.drain().map(|(_, task)| task).collect::<Vec<_>>()
    };

    if logical_tasks.is_empty() && processes.is_empty() {
        return Ok(false);
    }

    stop_running_ffmpeg(processes);
    for task in logical_tasks {
        remove_cleanup_paths(&task.cleanup_paths);
    }
    Ok(true)
}

pub(crate) fn stop_running_ffmpeg(tasks: Vec<RunningFfmpeg>) {
    for task in tasks {
        task.cancel.store(true, Ordering::SeqCst);
        if let Some(pid) = task.pid {
            kill_process_tree(pid);
        }
        remove_cleanup_paths(&task.cleanup_paths);
    }
}

pub(crate) fn remove_cleanup_paths(paths: &[PathBuf]) {
    for path in paths.iter().rev() {
        if path.is_dir() {
            if let Err(error) = fs::remove_dir_all(path) {
                let _ = app_error(
                    ErrorCode::TaskCleanupFailed,
                    format!(
                        "Failed to remove task cleanup directory {}: {error}",
                        path.display()
                    ),
                );
            }
        } else {
            if let Err(error) = fs::remove_file(path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    let _ = app_error(
                        ErrorCode::TaskCleanupFailed,
                        format!(
                            "Failed to remove task cleanup file {}: {error}",
                            path.display()
                        ),
                    );
                }
            }
        }
    }
}

pub(crate) async fn remove_cleanup_paths_async(paths: Vec<PathBuf>) {
    if let Err(error) = tokio::task::spawn_blocking(move || remove_cleanup_paths(&paths)).await {
        let _ = app_error(
            ErrorCode::BlockingTaskFailed,
            format!("Task cleanup worker failed to join: {error}"),
        );
    }
}

pub(crate) fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        if let Err(error) = StdCommand::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            let _ = app_error(
                ErrorCode::ProcessTerminationFailed,
                format!("Failed to execute taskkill for process {pid}: {error}"),
            );
        }
    }

    #[cfg(not(windows))]
    {
        if let Err(error) = StdCommand::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            let _ = app_error(
                ErrorCode::ProcessTerminationFailed,
                format!("Failed to execute kill for process {pid}: {error}"),
            );
        }
    }
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

/// Removes only the paths that have completed successfully.  Parallel export
/// jobs must not clear each other's in-flight cleanup entries.
pub(crate) fn unregister_task_cleanup_paths(
    task_id: &str,
    completed_paths: &[PathBuf],
    state: &AppState,
) -> AppResult<()> {
    if completed_paths.is_empty() {
        return Ok(());
    }
    let mut tasks = state.running_tasks.lock().map_err(|_| {
        app_error(
            ErrorCode::TaskStateUnavailable,
            "Task state lock is poisoned",
        )
    })?;
    if let Some(task) = tasks.get_mut(task_id) {
        task.cleanup_paths
            .retain(|path| !completed_paths.contains(path));
    }
    Ok(())
}

fn emit_context_progress(progress: &FfmpegProgressContext<'_>, value: f64) {
    let value = value.clamp(0.0, 1.0);
    if let Some(callback) = &progress.progress_callback {
        callback(value);
    } else {
        emit_ffmpeg_progress(progress.app, progress.task_id, value);
    }
}

async fn run_output_bytes_inner(
    program: &str,
    args: &[String],
    state: &AppState,
    logical_task_id: &str,
    cancel: Arc<AtomicBool>,
    max_duration: Option<Duration>,
) -> AppResult<Vec<u8>> {
    ensure_not_cancelled(&cancel)?;
    let process_id = Uuid::new_v4().to_string();
    let started_at = tokio::time::Instant::now();
    let mut child = hidden_command(program)
        .args(args)
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
    tracing::info!(
        process_id = %process_id,
        pid,
        logical_task_id,
        program,
        argument_count = args.len(),
        timeout_ms = max_duration.map(|duration| duration.as_millis() as u64),
        "external tool process started"
    );
    if let Err(error) = register_running_ffmpeg(
        state,
        process_id.clone(),
        logical_task_id.to_string(),
        cancel.clone(),
        pid,
        Vec::new(),
    ) {
        let _ = child.start_kill();
        return Err(error);
    }

    let output = if let Some(max_duration) = max_duration {
        match tokio::time::timeout(max_duration, child.wait_with_output()).await {
            Ok(output) => output,
            Err(_) => {
                clear_running_ffmpeg(state, &process_id);
                tracing::warn!(
                    process_id = %process_id,
                    pid,
                    logical_task_id,
                    program,
                    elapsed_ms = started_at.elapsed().as_millis() as u64,
                    timeout_ms = max_duration.as_millis() as u64,
                    "external tool process timed out"
                );
                return Err(app_error(
                    ErrorCode::ExternalToolExecutionFailed,
                    format!(
                        "External tool {program} exceeded its {} second execution limit",
                        max_duration.as_secs()
                    ),
                ));
            }
        }
    } else {
        child.wait_with_output().await
    };
    clear_running_ffmpeg(state, &process_id);
    let output = output.map_err(|error| {
        app_error(
            ErrorCode::ExternalToolWaitFailed,
            format!("Failed to wait for external tool {program}: {error}"),
        )
    })?;
    ensure_not_cancelled(&cancel)?;
    tracing::info!(
        process_id = %process_id,
        pid,
        logical_task_id,
        program,
        elapsed_ms = started_at.elapsed().as_millis() as u64,
        exit_code = output.status.code(),
        success = output.status.success(),
        stdout_bytes = output.stdout.len(),
        stderr_bytes = output.stderr.len(),
        "external tool process exited"
    );
    if output.status.success() {
        Ok(output.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(app_error(
            ErrorCode::ExternalToolExecutionFailed,
            format!("External tool {program} exited unsuccessfully; stderr={stderr}"),
        ))
    }
}

pub(crate) async fn run_output(
    program: &str,
    args: &[String],
    state: &AppState,
    logical_task_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<String> {
    let output =
        run_output_bytes_inner(program, args, state, logical_task_id, cancel, None).await?;
    Ok(String::from_utf8_lossy(&output).into_owned())
}

pub(crate) async fn run_output_with_timeout(
    program: &str,
    args: &[String],
    state: &AppState,
    logical_task_id: &str,
    cancel: Arc<AtomicBool>,
    max_duration: Duration,
) -> AppResult<String> {
    let output = run_output_bytes_inner(
        program,
        args,
        state,
        logical_task_id,
        cancel,
        Some(max_duration),
    )
    .await?;
    Ok(String::from_utf8_lossy(&output).into_owned())
}

pub(crate) async fn run_output_bytes(
    program: &str,
    args: &[String],
    state: &AppState,
    logical_task_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<Vec<u8>> {
    run_output_bytes_inner(program, args, state, logical_task_id, cancel, None).await
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
    fn processing_thread_arguments_cover_input_filters_and_software_output() {
        let mut args = Vec::new();
        append_ffmpeg_processing_thread_args(&mut args, usize::MAX);
        append_ffmpeg_video_output_thread_args(&mut args, usize::MAX);
        assert_eq!(
            args,
            [
                "-threads",
                "16",
                "-filter_threads",
                "16",
                "-filter_complex_threads",
                "16",
                "-threads:v",
                "16",
            ]
        );
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
