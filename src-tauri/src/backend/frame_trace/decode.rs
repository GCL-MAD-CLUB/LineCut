use super::{
    source::FrameTraceSource,
    stream::read_frame_trace,
    types::{FrameTraceBatch, FrameTraceData},
    TRACE_HEIGHT, TRACE_WIDTH,
};
use crate::backend::{
    append_ffmpeg_processing_thread_args, available_cpu_threads, clear_running_ffmpeg,
    ffmpeg_program, hidden_command, register_running_ffmpeg,
};
use crate::{app_error, AppResult, AppState, ErrorCode, Preferences, TaskGuard};
use std::{process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;
use uuid::Uuid;

fn frame_trace_args(source: &FrameTraceSource, start_frame: i64) -> Vec<String> {
    // One seek, one decoder, one scaler, one RGB pipe. Metrics are streamed in
    // Rust; there is no split/filter synchronization or temporary statistics file.
    let mut args = vec!["-v".into(), "error".into(), "-nostdin".into()];
    append_ffmpeg_processing_thread_args(
        &mut args,
        available_cpu_threads().saturating_sub(2).clamp(2, 4),
    );
    args.extend([
        "-ss".into(),
        format!("{:.9}", start_frame as f64 / source.frame_rate),
        "-i".into(),
        source.path.clone(),
        "-map".into(),
        format!("0:{}", source.stream_index),
        "-an".into(),
        "-sn".into(),
        "-dn".into(),
        "-vf".into(),
        format!("scale={TRACE_WIDTH}:{TRACE_HEIGHT}:flags=area,format=rgb24"),
        "-frames:v".into(),
        source.frame_count.to_string(),
        "-fps_mode".into(),
        "passthrough".into(),
        "-c:v".into(),
        "rawvideo".into(),
        "-threads:v".into(),
        "1".into(),
        "-f".into(),
        "rawvideo".into(),
        "pipe:1".into(),
    ]);
    args
}

pub(super) async fn decode_frame_trace(
    source: FrameTraceSource,
    start_frame: i64,
    task: &TaskGuard<'_>,
    state: &tauri::State<'_, AppState>,
    preferences: &Preferences,
    channel: Option<&tauri::ipc::Channel<FrameTraceBatch>>,
) -> AppResult<FrameTraceData> {
    let program = ffmpeg_program(preferences);
    task.check_cancelled()?;
    let mut child = hidden_command(&program)
        .args(frame_trace_args(&source, start_frame))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| app_error(ErrorCode::ExternalToolStartFailed, error.to_string()))?;
    let mut stdout = child.stdout.take().ok_or_else(|| {
        app_error(
            ErrorCode::ExternalToolOutputUnavailable,
            "Missing frame trace output",
        )
    })?;
    let mut stderr = child.stderr.take().ok_or_else(|| {
        app_error(
            ErrorCode::ExternalToolOutputUnavailable,
            "Missing frame trace diagnostics",
        )
    })?;
    let process_id = Uuid::new_v4().to_string();
    if let Err(error) = register_running_ffmpeg(
        state,
        process_id.clone(),
        task.task_id.clone(),
        task.cancel.clone(),
        child.id(),
        Vec::new(),
    ) {
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Err(error);
    }
    let decoded = tokio::time::timeout(Duration::from_secs(180), async {
        futures::try_join!(
            read_frame_trace(&mut stdout, source.frame_count, start_frame, channel),
            async {
                let mut diagnostics = Vec::new();
                stderr.read_to_end(&mut diagnostics).await?;
                Ok::<_, std::io::Error>(diagnostics)
            },
            child.wait(),
        )
    })
    .await;
    if !matches!(&decoded, Ok(Ok(_))) {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    clear_running_ffmpeg(state, &process_id);
    task.check_cancelled()?;
    let (values, diagnostics, status) = decoded
        .map_err(|_| {
            app_error(
                ErrorCode::ExternalToolExecutionFailed,
                "Frame trace extraction timed out",
            )
        })?
        .map_err(|error| app_error(ErrorCode::StoryboardFrameDecodeFailed, error.to_string()))?;
    if !status.success() {
        return Err(app_error(
            ErrorCode::ExternalToolExecutionFailed,
            format!(
                "Frame trace extraction failed: {}",
                String::from_utf8_lossy(&diagnostics)
            ),
        ));
    }
    if !values.is_valid(source.frame_count as usize) {
        return Err(app_error(
            ErrorCode::StoryboardFrameDecodeFailed,
            "Incomplete frame trace output",
        ));
    }
    Ok(values)
}
