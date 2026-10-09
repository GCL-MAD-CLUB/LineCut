use super::{
    cache::FrameTraceCache,
    decode::decode_frame_trace,
    source::frame_trace_source,
    stream::send_trace_batch,
    types::{FrameTraceBatch, FrameTraceData},
};
use crate::backend::{preferences_clone, register_task};
use crate::{app_error, AppState, CommandResult, ErrorCode};
use std::time::Duration;

#[tauri::command]
pub(crate) async fn storyboard_frame_trace(
    asset_id: String,
    start_frame: i64,
    end_frame: i64,
    task_id: String,
    on_samples: tauri::ipc::Channel<FrameTraceBatch>,
    state: tauri::State<'_, AppState>,
) -> CommandResult<FrameTraceData> {
    let source = frame_trace_source(&asset_id, start_frame, end_frame, &state)?;
    let preferences = preferences_clone(&state)?;
    let task = register_task(&task_id, &state)?;
    // Establish registration before the frontend retries an early cancellation.
    {
        let channel = &on_samples;
        send_trace_batch(
            channel,
            &FrameTraceData {
                motion: Vec::new(),
                colors: Vec::new(),
                sharpness: Vec::new(),
            },
            start_frame,
            0,
            0,
        )
        .map_err(|error| app_error(ErrorCode::StoryboardFrameDecodeFailed, error.to_string()))?;
    }
    let cache = FrameTraceCache::new(
        &preferences,
        &source.fingerprint,
        source.stream_index,
        source.frame_rate,
        start_frame,
        end_frame,
    );
    let lock = cache.generation_lock();
    let mut acquisition = Box::pin(lock.lock());
    let _guard = loop {
        match tokio::time::timeout(Duration::from_millis(120), acquisition.as_mut()).await {
            Ok(guard) => break guard,
            Err(_) => task.check_cancelled()?,
        }
    };
    task.check_cancelled()?;
    let lookup = cache.clone();
    let cached = tokio::task::spawn_blocking(move || lookup.read())
        .await
        .map_err(|error| {
            app_error(
                ErrorCode::BlockingTaskFailed,
                format!("Frame trace cache read failed: {error}"),
            )
        })?;
    task.check_cancelled()?;
    if let Some(data) = cached {
        {
            let channel = &on_samples;
            send_trace_batch(channel, &data, start_frame, 0, data.colors.len()).map_err(
                |error| app_error(ErrorCode::StoryboardFrameDecodeFailed, error.to_string()),
            )?;
        }
        return Ok(data);
    }
    let data = decode_frame_trace(
        source,
        start_frame,
        &task,
        &state,
        &preferences,
        Some(&on_samples),
    )
    .await?;
    task.check_cancelled()?;
    // A full cache file is published before releasing the per-range generation lock.
    let (data, write_result) = tokio::task::spawn_blocking(move || {
        let written = cache.write(&data);
        (data, written)
    })
    .await
    .map_err(|error| {
        app_error(
            ErrorCode::BlockingTaskFailed,
            format!("Frame trace cache write task failed: {error}"),
        )
    })?;
    if let Err(error) = write_result {
        tracing::warn!(detail = %error, "frame trace cache write failed");
    }
    task.check_cancelled()?;
    Ok(data)
}
