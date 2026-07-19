use super::*;

pub(crate) fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
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
    let mut next = Vec::with_capacity(args.len() + 3);
    let mut inserted = false;

    for arg in args {
        next.push(arg.clone());
        if !inserted && arg == "-hide_banner" {
            next.push("-nostats".to_string());
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
                "-progress".to_string(),
                "pipe:1".to_string(),
            ],
        );
    }

    next
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

pub(crate) async fn run_output(
    program: &str,
    args: &[String],
    state: &AppState,
    logical_task_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<String> {
    ensure_not_cancelled(&cancel)?;
    let process_id = Uuid::new_v4().to_string();
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

    let output = child.wait_with_output().await;
    clear_running_ffmpeg(state, &process_id);
    let output = output.map_err(|error| {
        app_error(
            ErrorCode::ExternalToolWaitFailed,
            format!("Failed to wait for external tool {program}: {error}"),
        )
    })?;
    ensure_not_cancelled(&cancel)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(app_error(
            ErrorCode::ExternalToolExecutionFailed,
            format!("External tool {program} exited unsuccessfully; stderr={stderr}"),
        ))
    }
}

pub(crate) async fn run_status(program: &str, args: &[String]) -> AppResult<()> {
    let output = hidden_command(program)
        .args(args)
        .output()
        .await
        .map_err(|error| {
            app_error(
                ErrorCode::ExternalToolStartFailed,
                format!("Failed to start external tool {program}: {error}"),
            )
        })?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(app_error(
            ErrorCode::ExternalToolExecutionFailed,
            format!("External tool {program} exited unsuccessfully; stderr={stderr}"),
        ))
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

    emit_ffmpeg_progress(progress.app, progress.task_id, progress.base_progress);

    let mut lines = BufReader::new(stdout).lines();
    let mut last_emitted = progress.base_progress;
    let duration_us = progress.duration_us.max(1) as f64;
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = stderr_task.await;
            remove_cleanup_paths_async(progress.cleanup_paths.clone()).await;
            clear_running_ffmpeg(progress.state, &task_id);
            emit_ffmpeg_progress(progress.app, progress.task_id, last_emitted);
            return Err(app_error(
                ErrorCode::TaskCancelled,
                "Task cancellation was requested",
            ));
        }

        let line = match tokio::time::timeout(Duration::from_millis(120), lines.next_line()).await {
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

        if let Some(value) = line.strip_prefix("out_time_us=") {
            if let Ok(out_time_us) = value.trim().parse::<i64>() {
                let local_progress = (out_time_us.max(0) as f64 / duration_us).clamp(0.0, 1.0);
                let overall_progress =
                    progress.base_progress + local_progress * progress.progress_span;
                if overall_progress - last_emitted >= 0.005 || overall_progress >= 1.0 {
                    emit_ffmpeg_progress(progress.app, progress.task_id, overall_progress);
                    last_emitted = overall_progress;
                }
            }
        } else if line.trim() == "progress=end" {
            last_emitted = progress.base_progress + progress.progress_span;
            emit_ffmpeg_progress(progress.app, progress.task_id, last_emitted);
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

    if status.success() && !was_cancelled {
        emit_ffmpeg_progress(
            progress.app,
            progress.task_id,
            progress.base_progress + progress.progress_span,
        );
        Ok(())
    } else {
        remove_cleanup_paths_async(progress.cleanup_paths.clone()).await;
        emit_ffmpeg_progress(progress.app, progress.task_id, last_emitted);
        if was_cancelled {
            Err(app_error(
                ErrorCode::TaskCancelled,
                "Task cancellation was requested",
            ))
        } else {
            Err(app_error(
                ErrorCode::ExternalToolExecutionFailed,
                format!("External tool {program} exited unsuccessfully; stderr={stderr}"),
            ))
        }
    }
}
