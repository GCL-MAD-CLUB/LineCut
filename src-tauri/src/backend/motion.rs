use super::*;

#[tauri::command]
pub(crate) async fn storyboard_motion(
    asset_id: String,
    start_frame: i64,
    end_frame: i64,
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<Vec<f64>> {
    let frame_count = end_frame
        .checked_sub(start_frame)
        .and_then(|n| n.checked_add(1));
    let frame_count = frame_count
        .filter(|n| start_frame >= 0 && *n > 0)
        .ok_or_else(|| {
            app_error(
                ErrorCode::StoryboardMotionRangeInvalid,
                "Invalid motion frame range",
            )
        })?;
    let project = state
        .projects
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::ProjectStateUnavailable,
                "Project state lock is poisoned",
            )
        })?
        .get(&asset_id)
        .cloned()
        .ok_or_else(|| {
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
    if frame_count == 1 {
        return Ok(Vec::new());
    }
    let frame_rate = project
        .streams
        .iter()
        .find(|stream| stream.index == stream_index)
        .and_then(|stream| {
            parse_frame_rate(stream.avg_frame_rate.as_deref())
                .or_else(|| parse_frame_rate(stream.r_frame_rate.as_deref()))
        })
        .unwrap_or(25.0);
    let preferences = preferences_clone(&state)?;
    let task = register_task(&task_id, &state)?;
    // Match by frame number after shifting one branch, independent of source timestamps.
    let filter = format!(
        "[0:{stream_index}]trim=end_frame={frame_count},scale=96:54:flags=area,format=gbrp,split=2[a][b];\
         [a]trim=start_frame=1,setpts=N/TB[current];\
         [b]trim=end_frame={},setpts=N/TB[previous];\
         [current][previous]ssim=stats_file=-:shortest=1[out]",
        frame_count - 1
    );
    let mut args = vec!["-v".into(), "error".into(), "-nostdin".into()];
    append_ffmpeg_processing_thread_args(&mut args, 2);
    args.extend([
        "-ss".into(),
        format!("{:.9}", start_frame as f64 / frame_rate),
        "-i".into(),
        project.asset.path.clone(),
        "-filter_complex".into(),
        filter,
        "-map".into(),
        "[out]".into(),
        "-frames:v".into(),
        (frame_count - 1).to_string(),
        "-fps_mode".into(),
        "passthrough".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]);
    let output = run_output_with_timeout(
        &ffmpeg_program(&preferences),
        &args,
        &state,
        &task_id,
        task.cancel.clone(),
        Duration::from_secs(180),
    )
    .await?;
    let values = parse_motion_stats(&output)?;
    if values.len() as i64 != frame_count - 1 {
        return Err(app_error(
            ErrorCode::StoryboardFrameDecodeFailed,
            format!(
                "Expected {} motion samples, received {}",
                frame_count - 1,
                values.len()
            ),
        ));
    }
    Ok(values)
}

fn parse_motion_stats(output: &str) -> AppResult<Vec<f64>> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let ssim = line
                .split_whitespace()
                .find_map(|field| field.strip_prefix("All:"))
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite() && (-1.0..=1.0).contains(value))
                .ok_or_else(|| {
                    app_error(
                        ErrorCode::ExternalToolOutputInvalid,
                        "Invalid SSIM statistics",
                    )
                })?;
            Ok(1.0 - ssim)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn motion_preserves_ssim_difference_including_negative_similarity() {
        let values = parse_motion_stats(
            "n:1 R:1 G:1 B:1 All:1.000000 (inf)\nn:2 All:0.750000 (6)\nn:3 All:-0.250000 (0)\n",
        )
        .unwrap();
        assert_eq!(values, vec![0.0, 0.25, 1.25]);
    }

    #[test]
    fn invalid_statistics_are_rejected() {
        for output in ["n:1", "n:1 All:NaN", "n:1 All:inf", "n:1 All:1.1"] {
            assert!(parse_motion_stats(output).is_err());
        }
    }
}
