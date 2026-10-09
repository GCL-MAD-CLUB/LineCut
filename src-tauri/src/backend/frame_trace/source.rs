use crate::backend::parse_frame_rate;
use crate::{app_error, AppResult, AppState, ErrorCode};

pub(super) struct FrameTraceSource {
    pub(super) path: String,
    pub(super) fingerprint: String,
    pub(super) stream_index: i32,
    pub(super) frame_count: i64,
    pub(super) frame_rate: f64,
}

pub(super) fn frame_trace_source(
    asset_id: &str,
    start_frame: i64,
    end_frame: i64,
    state: &AppState,
) -> AppResult<FrameTraceSource> {
    let frame_count = end_frame
        .checked_sub(start_frame)
        .and_then(|n| n.checked_add(1))
        .filter(|n| start_frame >= 0 && *n > 0)
        .ok_or_else(|| {
            app_error(
                ErrorCode::StoryboardMotionRangeInvalid,
                "Invalid frame trace range",
            )
        })?;
    let projects = state.projects.lock().map_err(|_| {
        app_error(
            ErrorCode::ProjectStateUnavailable,
            "Project state lock is poisoned",
        )
    })?;
    let project = projects.get(asset_id).ok_or_else(|| {
        app_error(
            ErrorCode::MediaNotFound,
            format!("Media asset was not found: {asset_id}"),
        )
    })?;
    let stream_index = project.asset.video_stream_index.ok_or_else(|| {
        app_error(
            ErrorCode::VideoStreamMissing,
            "Media asset has no video stream",
        )
    })?;
    let frame_rate = project
        .streams
        .iter()
        .find(|stream| stream.index == stream_index)
        .and_then(|stream| {
            parse_frame_rate(stream.avg_frame_rate.as_deref())
                .or_else(|| parse_frame_rate(stream.r_frame_rate.as_deref()))
        })
        .unwrap_or(25.0);
    Ok(FrameTraceSource {
        path: project.asset.path.clone(),
        fingerprint: project.asset.fingerprint.clone(),
        stream_index,
        frame_count,
        frame_rate,
    })
}
