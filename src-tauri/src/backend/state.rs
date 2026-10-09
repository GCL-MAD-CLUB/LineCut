//! Application state and task lifetime ownership.
use super::{ensure_not_cancelled, load_preferences, remove_cleanup_paths};
use crate::error::{app_error, AppError, AppResult, ErrorCode};
use crate::models::{Preferences, Project};
use crate::PROJECT_FILE_EXTENSION;
use std::{
    collections::HashMap,
    env,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

pub(crate) struct AppState {
    pub(crate) projects: Mutex<HashMap<String, Project>>,
    pub(crate) preferences: Mutex<Preferences>,
    pub(crate) startup_preferences_error: Mutex<Option<AppError>>,
    pub(crate) launch_project_path: Mutex<Option<String>>,
    pub(crate) running_tasks: Mutex<HashMap<String, RunningTask>>,
    pub(crate) running_ffmpeg: Mutex<HashMap<String, RunningFfmpeg>>,
    /// Serializes read-modify-write cycles over WorkspaceConfig.xml so panel
    /// autosaves and per-project state updates never clobber each other.
    pub(crate) workspace_config_lock: Mutex<()>,
}

impl AppState {
    pub(crate) fn new() -> Self {
        Self::from_preferences_result(load_preferences())
    }

    fn from_preferences_result(result: AppResult<Preferences>) -> Self {
        let (preferences, startup_preferences_error) = match result {
            Ok(preferences) => (preferences, None),
            Err(error) => (Preferences::default(), Some(error)),
        };
        Self {
            projects: Mutex::new(HashMap::new()),
            preferences: Mutex::new(preferences),
            startup_preferences_error: Mutex::new(startup_preferences_error),
            launch_project_path: Mutex::new(project_path_from_launch_args()),
            running_tasks: Mutex::new(HashMap::new()),
            running_ffmpeg: Mutex::new(HashMap::new()),
            workspace_config_lock: Mutex::new(()),
        }
    }
}

fn project_path_from_launch_args() -> Option<String> {
    env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case(PROJECT_FILE_EXTENSION))
        })
        .map(|path| path.to_string_lossy().into_owned())
}

#[derive(Clone)]
pub(crate) struct RunningTask {
    pub(crate) cancel: Arc<AtomicBool>,
    pub(crate) cleanup_paths: Vec<PathBuf>,
}

pub(crate) struct TaskGuard<'a> {
    pub(crate) task_id: String,
    pub(crate) cancel: Arc<AtomicBool>,
    pub(crate) state: &'a AppState,
}

impl TaskGuard<'_> {
    pub(crate) fn cancel_token(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    pub(crate) fn check_cancelled(&self) -> AppResult<()> {
        ensure_not_cancelled(&self.cancel)
    }
}

impl Drop for TaskGuard<'_> {
    fn drop(&mut self) {
        let mut cancelled_cleanup_paths = Vec::new();
        if let Ok(mut tasks) = self.state.running_tasks.lock() {
            if tasks
                .get(&self.task_id)
                .is_some_and(|task| Arc::ptr_eq(&task.cancel, &self.cancel))
            {
                if let Some(task) = tasks.remove(&self.task_id) {
                    if task.cancel.load(Ordering::SeqCst) {
                        cancelled_cleanup_paths = task.cleanup_paths;
                    }
                }
            }
        } else {
            app_error(
                ErrorCode::TaskStateUnavailable,
                "Task state lock is poisoned while releasing a task guard",
            );
        }
        if !cancelled_cleanup_paths.is_empty() {
            tauri::async_runtime::spawn_blocking(move || {
                remove_cleanup_paths(&cancelled_cleanup_paths)
            });
        }
    }
}

pub(crate) struct RunningFfmpeg {
    pub(crate) task_id: String,
    pub(crate) cancel: Arc<AtomicBool>,
    pub(crate) pid: Option<u32>,
    pub(crate) cleanup_paths: Vec<PathBuf>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_startup_failure_uses_defaults_and_preserves_the_diagnostic() {
        let state = AppState::from_preferences_result(Err(app_error(
            ErrorCode::PreferencesDecodeFailed,
            "Preferences fixture is invalid",
        )));

        assert_eq!(
            state
                .preferences
                .lock()
                .expect("preferences lock")
                .ffmpeg_path,
            crate::DEFAULT_FFMPEG_PROGRAM
        );
        assert!(state
            .startup_preferences_error
            .lock()
            .expect("startup diagnostic lock")
            .as_ref()
            .is_some_and(|error| error.is(ErrorCode::PreferencesDecodeFailed)));
    }
}
