//! Child-process creation, termination and captured output.
use crate::backend::{
    clear_running_ffmpeg, ensure_not_cancelled, register_running_ffmpeg, AppState,
};
use crate::error::{app_error, AppResult, ErrorCode};
#[cfg(windows)]
use crate::CREATE_NO_WINDOW;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    process::{Command as StdCommand, Stdio},
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};
use tokio::process::Command;
use uuid::Uuid;

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
