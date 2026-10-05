use super::motion_cache::FrameTraceCache;
use super::*;

const TRACE_WIDTH: usize = 96;
const TRACE_HEIGHT: usize = 54;
const COLOR_FRAME_BYTES: usize = TRACE_WIDTH * TRACE_HEIGHT * 3;

struct FrameTraceSource {
    path: String,
    fingerprint: String,
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

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct FrameTraceData {
    pub(super) motion: Vec<f64>,
    pub(super) colors: Vec<[f64; 4]>,
    pub(super) sharpness: Vec<f64>,
}

impl FrameTraceData {
    pub(super) fn is_valid(&self, frame_count: usize) -> bool {
        self.motion.len() == frame_count.saturating_sub(1)
            && self.colors.len() == frame_count
            && self.sharpness.len() == frame_count
            && self
                .motion
                .iter()
                .all(|value| value.is_finite() && (0.0..=2.0).contains(value))
            && self
                .colors
                .iter()
                .flatten()
                .all(|value| value.is_finite() && (0.0..=1.0).contains(value))
            && self
                .sharpness
                .iter()
                .all(|value| value.is_finite() && *value >= 0.0)
    }
}

#[tauri::command]
pub(crate) async fn storyboard_frame_trace(
    asset_id: String,
    start_frame: i64,
    end_frame: i64,
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<FrameTraceData> {
    let source = frame_trace_source(&asset_id, start_frame, end_frame, &state)?;
    let preferences = preferences_clone(&state)?;
    let task = register_task(&task_id, &state)?;
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
        return Ok(data);
    }
    let data = decode_frame_trace(source, start_frame, &task, &state, &preferences).await?;
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

struct TraceTemporaryDirectory(PathBuf);

impl TraceTemporaryDirectory {
    fn new() -> AppResult<Self> {
        let path = std::env::temp_dir().join(format!("linecut-frame-trace-{}", Uuid::new_v4()));
        fs::create_dir(&path).map_err(|error| {
            app_error(
                ErrorCode::FrameTraceCacheWriteFailed,
                format!("Failed to create frame trace workspace: {error}"),
            )
        })?;
        Ok(Self(path))
    }
}

impl Drop for TraceTemporaryDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn frame_trace_args(source: &FrameTraceSource, start_frame: i64) -> Vec<String> {
    let base = format!(
        "[0:{}]trim=end_frame={},scale=96:54:flags=area,format=gbrp",
        source.stream_index, source.frame_count
    );
    // Keep FFmpeg's RGB SSIM algorithm; both outputs share the same decoder and scaling.
    let filter = if source.frame_count > 1 {
        format!(
            "{base},split=3[rgb][a][b];[rgb]format=rgb24,setpts=N/TB[rgbout];\
            [a]trim=start_frame=1,setpts=N/TB[current];\
            [b]trim=end_frame={},setpts=N/TB[previous];\
            [current][previous]ssim=stats_file=motion.stats:shortest=1[out]",
            source.frame_count - 1
        )
    } else {
        format!("{base},format=rgb24[rgbout]")
    };
    let mut args = vec!["-v".into(), "error".into(), "-nostdin".into()];
    append_ffmpeg_processing_thread_args(&mut args, 2);
    args.extend([
        "-ss".into(),
        format!("{:.9}", start_frame as f64 / source.frame_rate),
        "-i".into(),
        source.path.clone(),
        "-filter_complex".into(),
        filter,
        "-map".into(),
        "[rgbout]".into(),
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
    if source.frame_count > 1 {
        args.extend([
            "-map".into(),
            "[out]".into(),
            "-frames:v".into(),
            (source.frame_count - 1).to_string(),
            "-fps_mode".into(),
            "passthrough".into(),
            "-f".into(),
            "null".into(),
            "-".into(),
        ]);
    }
    args
}

async fn decode_frame_trace(
    mut source: FrameTraceSource,
    start_frame: i64,
    task: &TaskGuard<'_>,
    state: &tauri::State<'_, AppState>,
    preferences: &Preferences,
) -> AppResult<FrameTraceData> {
    // The child uses a temporary working directory for its small SSIM statistics file.
    source.path = std::path::absolute(&source.path)
        .map_err(|error| {
            app_error(
                ErrorCode::FileNotFound,
                format!("Frame trace source is unavailable: {error}"),
            )
        })?
        .to_string_lossy()
        .into_owned();
    let temporary = TraceTemporaryDirectory::new()?;
    let program = ffmpeg_program(preferences);
    let program_path = Path::new(&program);
    let program = if program_path.is_relative() && program_path.components().count() > 1 {
        std::path::absolute(program_path)
            .map_err(|error| app_error(ErrorCode::ExternalToolStartFailed, error.to_string()))?
            .to_string_lossy()
            .into_owned()
    } else {
        program
    };
    task.check_cancelled()?;
    let mut child = hidden_command(&program)
        .current_dir(&temporary.0)
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
            read_frame_trace(&mut stdout, source.frame_count),
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
    let (mut values, diagnostics, status) = decoded
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
    if source.frame_count > 1 {
        let stats_path = temporary.0.join("motion.stats");
        values.motion = tokio::task::spawn_blocking(move || {
            let stats = fs::read_to_string(stats_path).map_err(|error| {
                app_error(
                    ErrorCode::ExternalToolOutputInvalid,
                    format!("Missing SSIM statistics: {error}"),
                )
            })?;
            parse_motion_stats(&stats)
        })
        .await
        .map_err(|error| app_error(ErrorCode::BlockingTaskFailed, error.to_string()))??;
    }
    if !values.is_valid(source.frame_count as usize) {
        return Err(app_error(
            ErrorCode::StoryboardFrameDecodeFailed,
            "Incomplete frame trace output",
        ));
    }
    Ok(values)
}

async fn read_frame_trace(
    reader: &mut (impl AsyncReadExt + Unpin),
    frame_count: i64,
) -> std::io::Result<FrameTraceData> {
    let mut frame = vec![0; COLOR_FRAME_BYTES];
    let mut gray = Vec::with_capacity(TRACE_WIDTH * TRACE_HEIGHT);
    let mut values = FrameTraceData {
        motion: Vec::new(),
        colors: Vec::new(),
        sharpness: Vec::new(),
    };
    for _ in 0..frame_count {
        reader.read_exact(&mut frame).await?;
        values.colors.push(mean_frame_colors(&frame));
        values.sharpness.push(frame_sharpness(&frame, &mut gray));
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

#[cfg(test)]
fn normalized_frame_sharpness(frame: &[u8]) -> f64 {
    frame_sharpness(frame, &mut Vec::new())
}

fn frame_sharpness(frame: &[u8], gray: &mut Vec<f64>) -> f64 {
    gray.clear();
    gray.extend(frame.chunks_exact(3).map(|pixel| {
        0.30 * f64::from(pixel[0]) + 0.59 * f64::from(pixel[1]) + 0.11 * f64::from(pixel[2])
    }));
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
            let values = read_frame_trace(&mut frames.as_slice(), 2).await.unwrap();
            assert_eq!(values.colors[0], [0.0; 4]);
            assert_eq!(&values.colors[1][..3], &[1.0; 3]);
            assert_eq!(values.sharpness, vec![0.0; 2]);
            assert!(read_frame_trace(&mut &frames[..frames.len() - 1], 2)
                .await
                .is_err());
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
            let values = read_frame_trace(&mut frame.as_slice(), 1).await.unwrap();
            assert_eq!(values.sharpness, vec![0.0]);
            assert!(values.is_valid(1));
            assert!(read_frame_trace(&mut &frame[..frame.len() - 1], 1)
                .await
                .is_err());
        });
    }
}
