use super::*;

const TRACE_WIDTH: usize = 96;
const TRACE_HEIGHT: usize = 54;
const COLOR_FRAME_BYTES: usize = TRACE_WIDTH * TRACE_HEIGHT * 3;

struct FrameTraceSource {
    path: String,
    stream_index: i32,
    frame_count: i64,
    frame_rate: f64,
}

fn frame_trace_source(
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
    let project = state
        .projects
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::ProjectStateUnavailable,
                "Project state lock is poisoned",
            )
        })?
        .get(asset_id)
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
        path: project.asset.path,
        stream_index,
        frame_count,
        frame_rate,
    })
}

#[tauri::command]
pub(crate) async fn storyboard_motion(
    asset_id: String,
    start_frame: i64,
    end_frame: i64,
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<Vec<f64>> {
    let source = frame_trace_source(&asset_id, start_frame, end_frame, &state)?;
    let FrameTraceSource {
        frame_count,
        stream_index,
        frame_rate,
        ..
    } = source;
    if frame_count == 1 {
        return Ok(Vec::new());
    }
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
        source.path,
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

#[tauri::command]
pub(crate) async fn storyboard_frame_colors(
    asset_id: String,
    start_frame: i64,
    end_frame: i64,
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<Vec<[f64; 4]>> {
    let source = frame_trace_source(&asset_id, start_frame, end_frame, &state)?;
    decode_frame_trace_rgb(source, start_frame, task_id, &state, mean_frame_colors).await
}

#[tauri::command]
pub(crate) async fn storyboard_frame_sharpness(
    asset_id: String,
    start_frame: i64,
    end_frame: i64,
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<Vec<f64>> {
    let source = frame_trace_source(&asset_id, start_frame, end_frame, &state)?;
    decode_frame_trace_rgb(
        source,
        start_frame,
        task_id,
        &state,
        normalized_frame_sharpness,
    )
    .await
}

async fn decode_frame_trace_rgb<T: Send>(
    source: FrameTraceSource,
    start_frame: i64,
    task_id: String,
    state: &tauri::State<'_, AppState>,
    analyze: fn(&[u8]) -> T,
) -> AppResult<Vec<T>> {
    let preferences = preferences_clone(state)?;
    let task = register_task(&task_id, state)?;
    let mut args = vec!["-v".into(), "error".into(), "-nostdin".into()];
    append_ffmpeg_processing_thread_args(&mut args, 2);
    args.extend([
        "-ss".into(),
        format!("{:.9}", start_frame as f64 / source.frame_rate),
        "-i".into(),
        source.path,
        "-map".into(),
        format!("0:{}", source.stream_index),
        "-vf".into(),
        "scale=96:54:flags=area,format=rgb24".into(),
        "-frames:v".into(),
        source.frame_count.to_string(),
        "-fps_mode".into(),
        "passthrough".into(),
        "-c:v".into(),
        "rawvideo".into(),
        "-f".into(),
        "rawvideo".into(),
        "pipe:1".into(),
    ]);
    let mut child = hidden_command(&ffmpeg_program(&preferences))
        .args(args)
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
    register_running_ffmpeg(
        state,
        process_id.clone(),
        task_id,
        task.cancel.clone(),
        child.id(),
        Vec::new(),
    )?;
    let decoded = tokio::time::timeout(Duration::from_secs(180), async {
        futures::try_join!(
            read_frame_trace(&mut stdout, source.frame_count, analyze),
            async {
                let mut diagnostics = Vec::new();
                stderr.read_to_end(&mut diagnostics).await?;
                Ok::<_, std::io::Error>(diagnostics)
            },
            child.wait(),
        )
    })
    .await;
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
    Ok(values)
}

async fn read_frame_trace<T>(
    reader: &mut (impl AsyncReadExt + Unpin),
    frame_count: i64,
    analyze: fn(&[u8]) -> T,
) -> std::io::Result<Vec<T>> {
    let mut frame = vec![0; COLOR_FRAME_BYTES];
    let mut values = Vec::new();
    for _ in 0..frame_count {
        reader.read_exact(&mut frame).await?;
        values.push(analyze(&frame));
    }
    Ok(values)
}

fn mean_frame_colors(frame: &[u8]) -> [f64; 4] {
    let mut sums = [0_u64; 3];
    for pixel in frame.chunks_exact(3) {
        for channel in 0..3 {
            sums[channel] += u64::from(pixel[channel]);
        }
    }
    let divisor = (frame.len() / 3) as f64 * 255.0;
    let [red, green, blue] = sums.map(|sum| sum as f64 / divisor);
    [red, green, blue, 0.30 * red + 0.59 * green + 0.11 * blue]
}

fn normalized_frame_sharpness(frame: &[u8]) -> f64 {
    let gray: Vec<f64> = frame
        .chunks_exact(3)
        .map(|pixel| {
            0.30 * f64::from(pixel[0]) + 0.59 * f64::from(pixel[1]) + 0.11 * f64::from(pixel[2])
        })
        .collect();
    let mean_gray = gray.iter().sum::<f64>() / gray.len() as f64;
    if mean_gray == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut square_sum = 0.0;
    // Use only interior pixels so artificial image borders do not add sharpness.
    for y in 1..TRACE_HEIGHT - 1 {
        for x in 1..TRACE_WIDTH - 1 {
            let index = y * TRACE_WIDTH + x;
            let laplacian = gray[index - TRACE_WIDTH]
                + gray[index + TRACE_WIDTH]
                + gray[index - 1]
                + gray[index + 1]
                - 4.0 * gray[index];
            sum += laplacian;
            square_sum += laplacian * laplacian;
        }
    }
    let count = ((TRACE_WIDTH - 2) * (TRACE_HEIGHT - 2)) as f64;
    let mean_laplacian = sum / count;
    let variance = (square_sum / count - mean_laplacian * mean_laplacian).max(0.0);
    variance / (mean_gray * mean_gray)
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

    #[test]
    fn frame_colors_average_channels_and_use_305911_gray() {
        let [red, green, blue, gray] = mean_frame_colors(&[255, 0, 0, 0, 255, 0]);
        assert_eq!([red, green, blue], [0.5, 0.5, 0.0]);
        assert!((gray - 0.445).abs() < 1e-12);
        assert_eq!(mean_frame_colors(&[0, 0, 0]), [0.0; 4]);
        for value in mean_frame_colors(&[255, 255, 255]) {
            assert!((value - 1.0).abs() < 1e-12);
        }
    }

    #[test]
    fn color_stream_keeps_each_frame_and_rejects_truncation() {
        futures::executor::block_on(async {
            let mut frames = vec![0; COLOR_FRAME_BYTES];
            frames.extend(vec![255; COLOR_FRAME_BYTES]);
            let values = read_frame_trace(&mut frames.as_slice(), 2, mean_frame_colors)
                .await
                .unwrap();
            assert_eq!(values[0], [0.0; 4]);
            assert_eq!(&values[1][..3], &[1.0; 3]);
            assert!(
                read_frame_trace(&mut &frames[..frames.len() - 1], 2, mean_frame_colors)
                    .await
                    .is_err()
            );
        });
    }

    #[test]
    fn sharpness_of_uniform_frames_is_zero_including_black() {
        for brightness in [0, 1, 64, 255] {
            assert!(normalized_frame_sharpness(&vec![brightness; COLOR_FRAME_BYTES]).abs() < 1e-12);
        }
    }

    #[test]
    fn sharpness_uses_brightness_squared_without_clamping() {
        let mut frame = vec![0; COLOR_FRAME_BYTES];
        let center = (TRACE_HEIGHT / 2 * TRACE_WIDTH + TRACE_WIDTH / 2) * 3;
        frame[center..center + 3].fill(60);
        let score = normalized_frame_sharpness(&frame);
        let expected = 20.0 * (TRACE_WIDTH * TRACE_HEIGHT).pow(2) as f64
            / ((TRACE_WIDTH - 2) * (TRACE_HEIGHT - 2)) as f64;
        assert!((score - expected).abs() < 1e-8);
        frame[center..center + 3].fill(120);
        assert!((normalized_frame_sharpness(&frame) - score).abs() < 1e-8);
    }

    #[test]
    fn sharpness_stream_returns_a_sample_for_single_frame() {
        futures::executor::block_on(async {
            let frame = vec![0; COLOR_FRAME_BYTES];
            let values = read_frame_trace(&mut frame.as_slice(), 1, normalized_frame_sharpness)
                .await
                .unwrap();
            assert_eq!(values, vec![0.0]);
            assert!(read_frame_trace(
                &mut &frame[..frame.len() - 1],
                1,
                normalized_frame_sharpness
            )
            .await
            .is_err());
        });
    }
}
