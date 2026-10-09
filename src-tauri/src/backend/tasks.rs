//! Logical task registration, cancellation and cleanup ownership.
use super::{kill_process_tree, AppState, RunningFfmpeg, RunningTask, TaskGuard};
use crate::error::{app_error, AppResult, ErrorCode};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

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
