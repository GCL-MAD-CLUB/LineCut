use super::*;

const EXPORT_AUDIO_SAMPLE_RATE_DEFAULT: i64 = 48000;
const EXPORT_FRAME_RATE_FALLBACK: f64 = 30.0;
const EXPORT_MATCH_SOURCE_FALLBACK_WIDTH: i64 = 640;
const EXPORT_MATCH_SOURCE_FALLBACK_HEIGHT: i64 = 360;

struct ProbedClip {
    id: String,
    source_path: String,
    label: String,
    start_us: i64,
    dur_us: i64,
    has_video: bool,
    has_audio: bool,
    width: i64,
    height: i64,
    fps: f64,
    audio_sample_rate: i64,
}

struct ExportTargets {
    width: i64,
    height: i64,
    fps: f64,
    pix_fmt: &'static str,
    audio_sample_rate: i64,
}

/// Normalizes an export clip time range against the probed source duration.
/// `end_us <= 0` means "up to the end of the source".
fn clamp_range(start_us: i64, end_us: i64, duration_us: i64) -> (i64, i64) {
    let duration_us = duration_us.max(0);
    let start = start_us.clamp(0, duration_us);
    let effective_end = if end_us <= 0 { duration_us } else { end_us };
    let end = effective_end.clamp(0, duration_us);
    (start, end.max(start))
}

fn validate_export_options(options: &ExportOptions) -> AppResult<()> {
    if options.output_dir.trim().is_empty() {
        return Err(app_error(
            ErrorCode::ExportOutputRequired,
            "Export output directory is empty",
        ));
    }
    if options.output_stem.trim().is_empty() {
        return Err(app_error(
            ErrorCode::ExportOutputRequired,
            "Export output file name is empty",
        ));
    }
    if matches!(options.resolution, ExportResolution::Custom)
        && (options.custom_width < 2 || options.custom_height < 2)
    {
        return Err(app_error(
            ErrorCode::ExportDimensionsInvalid,
            "Custom resolution must be at least 2x2 pixels",
        ));
    }
    if let Some(frame_rate) = options.frame_rate {
        if !frame_rate.is_finite() || !(1.0..=120.0).contains(&frame_rate) {
            return Err(app_error(
                ErrorCode::ExportOptionsInvalid,
                "Export frame rate must be between 1 and 120",
            ));
        }
    }
    Ok(())
}

async fn probe_export_clip(
    clip: &ExportClip,
    preferences: &Preferences,
    state: &AppState,
    task_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<ProbedClip> {
    let probe = probe_media(
        Path::new(&clip.source_path),
        preferences,
        state,
        task_id,
        cancel,
    )
    .await?;
    let duration_us = probe
        .format
        .as_ref()
        .and_then(|format| format.duration.as_deref())
        .map(parse_decimal_seconds_to_us)
        .unwrap_or(0);
    let video_stream = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"));
    let audio_stream = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("audio"));
    let has_video = video_stream.is_some();
    let has_audio = audio_stream.is_some();
    let width = video_stream.and_then(|stream| stream.width).unwrap_or(0);
    let height = video_stream.and_then(|stream| stream.height).unwrap_or(0);
    let fps = video_stream
        .and_then(|stream| {
            parse_frame_rate(stream.avg_frame_rate.as_deref())
                .or_else(|| parse_frame_rate(stream.r_frame_rate.as_deref()))
        })
        .unwrap_or(0.0);
    let audio_sample_rate = audio_stream
        .and_then(|stream| stream.sample_rate.as_deref())
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(EXPORT_AUDIO_SAMPLE_RATE_DEFAULT);
    let (start_us, end_us) = clamp_range(clip.start_us, clip.end_us, duration_us);
    Ok(ProbedClip {
        id: clip.id.clone(),
        source_path: clip.source_path.clone(),
        label: clip.label.clone(),
        start_us,
        dur_us: end_us - start_us,
        has_video,
        has_audio,
        width,
        height,
        fps,
        audio_sample_rate,
    })
}

fn plan_merge_targets(clips: &[ProbedClip], options: &ExportOptions) -> AppResult<ExportTargets> {
    let (width, height) = match options.resolution {
        ExportResolution::Custom => (
            even_proxy_dimension(options.custom_width),
            even_proxy_dimension(options.custom_height),
        ),
        // "Match source" normalizes every input to the first clip (with known
        // dimensions) so concatenated streams are uniform; smaller inputs are
        // letterboxed and larger ones are downscaled to it.
        ExportResolution::MatchSource => {
            let first_known = clips
                .iter()
                .find(|clip| clip.width >= 2 && clip.height >= 2);
            match first_known {
                Some(clip) => (
                    even_proxy_dimension(clip.width),
                    even_proxy_dimension(clip.height),
                ),
                None => (
                    EXPORT_MATCH_SOURCE_FALLBACK_WIDTH,
                    EXPORT_MATCH_SOURCE_FALLBACK_HEIGHT,
                ),
            }
        }
    };
    let fps = match options.frame_rate {
        Some(frame_rate) if frame_rate.is_finite() && frame_rate > 0.0 => frame_rate,
        _ => clips
            .iter()
            .find_map(|clip| (clip.fps > 0.0).then_some(clip.fps))
            .unwrap_or(EXPORT_FRAME_RATE_FALLBACK),
    };
    let pix_fmt = match options.container {
        ExportContainer::MovProres => "yuv422p10le",
        _ => "yuv420p",
    };
    let audio_sample_rate = clips
        .first()
        .map(|clip| clip.audio_sample_rate)
        .unwrap_or(EXPORT_AUDIO_SAMPLE_RATE_DEFAULT);
    Ok(ExportTargets {
        width,
        height,
        fps,
        pix_fmt,
        audio_sample_rate,
    })
}

/// Builds the `filter_complex` graph for a merge export.
///
/// All per-input normalization (scaling, fps, pixel format, audio resample) happens
/// inside the graph so concatenated streams share identical dimensions, frame rate,
/// pixel format, sample rate, and channel layout. `setpts`/`aresample` resets make
/// `-ss`-trimmed inputs safe to concatenate.
///
/// Returns `(graph, has_audio_output)`. Audio is dropped for the whole merge when
/// `include_audio` is false or any input lacks an audio stream.
fn build_merge_filter_complex(
    clips: &[ProbedClip],
    targets: &ExportTargets,
    include_audio: bool,
) -> (String, bool) {
    let all_have_audio = include_audio && clips.iter().all(|clip| clip.has_audio);
    let scale = format!(
        "scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2",
        targets.width, targets.height, targets.width, targets.height
    );
    let mut parts = Vec::new();
    for (index, _) in clips.iter().enumerate() {
        parts.push(format!(
            "[{index}:v:0]setpts=PTS-STARTPTS,{scale},setsar=1,fps={:.6},format={}[{index}v]",
            targets.fps, targets.pix_fmt
        ));
        if all_have_audio {
            parts.push(format!(
                "[{index}:a:0]aresample={}:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo[{index}a]",
                targets.audio_sample_rate
            ));
        }
    }
    let mut concat_inputs = String::new();
    for index in 0..clips.len() {
        concat_inputs.push_str(&format!("[{index}v]"));
        if all_have_audio {
            concat_inputs.push_str(&format!("[{index}a]"));
        }
    }
    if all_have_audio {
        parts.push(format!(
            "{concat_inputs}concat=n={}:v=1:a=1[v][a]",
            clips.len()
        ));
    } else {
        parts.push(format!(
            "{concat_inputs}concat=n={}:v=1:a=0[v]",
            clips.len()
        ));
    }
    (parts.join(";"), all_have_audio)
}

fn export_extension(container: ExportContainer) -> &'static str {
    match container {
        ExportContainer::Mp4H264 | ExportContainer::Mp4Hevc => "mp4",
        ExportContainer::MovProres => "mov",
        ExportContainer::WebmVp9 => "webm",
    }
}

fn export_crf(container: ExportContainer, quality: ExportQuality) -> i32 {
    match (container, quality) {
        (ExportContainer::Mp4H264 | ExportContainer::Mp4Hevc, ExportQuality::Low) => 28,
        (ExportContainer::Mp4H264 | ExportContainer::Mp4Hevc, ExportQuality::Medium) => 23,
        (ExportContainer::Mp4H264 | ExportContainer::Mp4Hevc, ExportQuality::High) => 20,
        (ExportContainer::Mp4H264 | ExportContainer::Mp4Hevc, ExportQuality::VeryHigh) => 17,
        (ExportContainer::WebmVp9, ExportQuality::Low) => 40,
        (ExportContainer::WebmVp9, ExportQuality::Medium) => 34,
        (ExportContainer::WebmVp9, ExportQuality::High) => 28,
        (ExportContainer::WebmVp9, ExportQuality::VeryHigh) => 24,
        (ExportContainer::MovProres, _) => 0,
    }
}

fn prores_profile(quality: ExportQuality) -> i32 {
    match quality {
        ExportQuality::Low => 0,
        ExportQuality::Medium => 2,
        ExportQuality::High | ExportQuality::VeryHigh => 3,
    }
}

fn encoder_speed_args(container: ExportContainer, speed: ExportEncoderSpeed) -> Vec<&'static str> {
    match container {
        ExportContainer::Mp4H264 | ExportContainer::Mp4Hevc => match speed {
            ExportEncoderSpeed::Fast => vec!["-preset", "veryfast"],
            ExportEncoderSpeed::Balanced => vec!["-preset", "medium"],
            ExportEncoderSpeed::Quality => vec!["-preset", "slow"],
        },
        ExportContainer::WebmVp9 => match speed {
            ExportEncoderSpeed::Fast => vec!["-deadline", "good", "-cpu-used", "8"],
            ExportEncoderSpeed::Balanced => vec!["-deadline", "good", "-cpu-used", "4"],
            ExportEncoderSpeed::Quality => vec!["-deadline", "best", "-cpu-used", "2"],
        },
        ExportContainer::MovProres => vec![],
    }
}

fn append_video_encode_args(args: &mut Vec<String>, options: &ExportOptions) {
    match options.container {
        ExportContainer::Mp4H264 => {
            push_args(args, &["-c:v", "libx264"]);
            push_args(
                args,
                &encoder_speed_args(options.container, options.encoder_speed),
            );
            push_args(args, &["-crf"]);
            args.push(export_crf(options.container, options.quality).to_string());
            push_args(args, &["-pix_fmt", "yuv420p", "-movflags", "+faststart"]);
        }
        ExportContainer::Mp4Hevc => {
            push_args(args, &["-c:v", "libx265"]);
            push_args(
                args,
                &encoder_speed_args(options.container, options.encoder_speed),
            );
            push_args(args, &["-crf"]);
            args.push(export_crf(options.container, options.quality).to_string());
            push_args(
                args,
                &[
                    "-pix_fmt",
                    "yuv420p",
                    "-tag:v",
                    "hvc1",
                    "-movflags",
                    "+faststart",
                    "-x265-params",
                    "log-level=error",
                ],
            );
        }
        ExportContainer::MovProres => {
            push_args(args, &["-c:v", "prores_ks", "-profile:v"]);
            args.push(prores_profile(options.quality).to_string());
            push_args(args, &["-pix_fmt", "yuv422p10le"]);
        }
        ExportContainer::WebmVp9 => {
            push_args(
                args,
                &["-c:v", "libvpx-vp9", "-row-mt", "1", "-b:v", "0", "-crf"],
            );
            args.push(export_crf(options.container, options.quality).to_string());
            push_args(
                args,
                &encoder_speed_args(options.container, options.encoder_speed),
            );
            push_args(args, &["-pix_fmt", "yuv420p"]);
        }
    }
}

fn append_audio_encode_args(args: &mut Vec<String>, options: &ExportOptions, enabled: bool) {
    if !enabled {
        args.push("-an".to_string());
        return;
    }
    let bitrate = options.audio_bitrate_kbps.clamp(32, 512);
    match options.container {
        ExportContainer::WebmVp9 => {
            push_args(args, &["-c:a", "libopus", "-b:a"]);
            args.push(format!("{bitrate}k"));
        }
        _ => {
            push_args(args, &["-c:a", "aac", "-b:a"]);
            args.push(format!("{bitrate}k"));
            push_args(args, &["-ar", "48000"]);
        }
    }
}

async fn run_export_merge(
    clips: &[ProbedClip],
    options: &ExportOptions,
    preferences: &Preferences,
    output_path: &Path,
    app: &tauri::AppHandle,
    task_id: &str,
    state: &AppState,
    cancel: Arc<AtomicBool>,
    warnings: &mut Vec<UserNotice>,
) -> AppResult<ExportOutput> {
    let targets = plan_merge_targets(clips, options)?;
    let (graph, has_audio_output) =
        build_merge_filter_complex(clips, &targets, options.include_audio);
    if options.include_audio && !has_audio_output {
        warnings.push(UserNotice::warning(
            "EXPORT_AUDIO_DROPPED",
            "部分片段不包含音轨，合并导出将仅保留画面",
        ));
    }

    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
    ];
    for clip in clips {
        args.push("-ss".to_string());
        args.push(format!("{:.6}", clip.start_us as f64 / 1_000_000.0));
        args.push("-t".to_string());
        args.push(format!("{:.6}", clip.dur_us as f64 / 1_000_000.0));
        args.push("-i".to_string());
        args.push(clip.source_path.clone());
    }
    args.push("-filter_complex".to_string());
    args.push(graph);
    args.push("-map".to_string());
    args.push("[v]".to_string());
    if has_audio_output {
        args.push("-map".to_string());
        args.push("[a]".to_string());
    }
    append_video_encode_args(&mut args, options);
    append_audio_encode_args(&mut args, options, has_audio_output);
    args.push("-sn".to_string());
    args.push(output_path.to_string_lossy().into_owned());

    let total_duration_us: i64 = clips.iter().map(|clip| clip.dur_us).sum();
    run_status_with_ffmpeg_progress(
        &ffmpeg_program(preferences),
        &args,
        FfmpegProgressContext {
            app,
            state,
            task_id,
            cancel,
            base_progress: 0.0,
            progress_span: 1.0,
            duration_us: total_duration_us,
            cleanup_paths: vec![output_path.to_path_buf()],
        },
    )
    .await?;
    // The completed file must survive a later cancellation, so drop it from the
    // logical task's cleanup list immediately.
    prune_task_cleanup_paths(task_id, &[], state)?;
    Ok(ExportOutput {
        clip_id: None,
        path: output_path.to_string_lossy().into_owned(),
        status: "completed".to_string(),
        error: None,
        duration_us: total_duration_us,
    })
}

async fn run_export_individual(
    clips: &[ProbedClip],
    options: &ExportOptions,
    preferences: &Preferences,
    dir: &Path,
    stem: &str,
    ext: &str,
    app: &tauri::AppHandle,
    task_id: &str,
    state: &AppState,
    cancel: Arc<AtomicBool>,
    outputs: &mut Vec<ExportOutput>,
    warnings: &mut Vec<UserNotice>,
) -> AppResult<()> {
    let count = clips.len();
    for (index, clip) in clips.iter().enumerate() {
        ensure_not_cancelled(&cancel)?;
        let file_name = format!(
            "{stem}_{:03}_{}.{ext}",
            index + 1,
            safe_component(&clip.label)
        );
        let output_path = dir.join(file_name);
        // Only the in-flight file may be cleaned up on cancel; completed files survive.
        prune_task_cleanup_paths(task_id, &[output_path.clone()], state)?;

        let mut args = vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-ss".to_string(),
            format!("{:.6}", clip.start_us as f64 / 1_000_000.0),
            "-t".to_string(),
            format!("{:.6}", clip.dur_us as f64 / 1_000_000.0),
            "-i".to_string(),
            clip.source_path.clone(),
            "-map".to_string(),
            "0:v:0".to_string(),
        ];
        let mut video_filters = Vec::new();
        match options.resolution {
            ExportResolution::Custom => {
                let width = even_proxy_dimension(options.custom_width);
                let height = even_proxy_dimension(options.custom_height);
                video_filters.push(format!(
                    "scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1"
                ));
            }
            ExportResolution::MatchSource => {
                video_filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2".to_string());
            }
        }
        if let Some(frame_rate) = options.frame_rate {
            if frame_rate.is_finite() && frame_rate > 0.0 {
                video_filters.push(format!("fps={frame_rate}"));
            }
        }
        if !video_filters.is_empty() {
            args.push("-vf".to_string());
            args.push(video_filters.join(","));
        }
        let audio_enabled = options.include_audio && clip.has_audio;
        if audio_enabled {
            args.push("-map".to_string());
            args.push("0:a:0?".to_string());
        }
        append_video_encode_args(&mut args, options);
        append_audio_encode_args(&mut args, options, audio_enabled);
        args.push("-sn".to_string());
        args.push(output_path.to_string_lossy().into_owned());

        let base_progress = index as f64 / count as f64;
        let progress_span = 1.0 / count as f64;
        let run = run_status_with_ffmpeg_progress(
            &ffmpeg_program(preferences),
            &args,
            FfmpegProgressContext {
                app,
                state,
                task_id,
                cancel: cancel.clone(),
                base_progress,
                progress_span,
                duration_us: clip.dur_us,
                cleanup_paths: vec![output_path.clone()],
            },
        )
        .await;
        match run {
            Ok(()) => {
                // Forget the completed file so a later cancellation does not delete it.
                prune_task_cleanup_paths(task_id, &[], state)?;
                outputs.push(ExportOutput {
                    clip_id: Some(clip.id.clone()),
                    path: output_path.to_string_lossy().into_owned(),
                    status: "completed".to_string(),
                    error: None,
                    duration_us: clip.dur_us,
                });
            }
            Err(error) if error.is(ErrorCode::TaskCancelled) => return Err(error),
            Err(error) => {
                warnings.push(UserNotice::warning_with_detail(
                    "EXPORT_CLIP_FAILED",
                    format!("片段导出失败：{}", clip.label),
                    error.detail(),
                ));
                outputs.push(ExportOutput {
                    clip_id: Some(clip.id.clone()),
                    path: output_path.to_string_lossy().into_owned(),
                    status: "failed".to_string(),
                    error: Some(error.detail().to_string()),
                    duration_us: 0,
                });
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn export_clips(
    clips: Vec<ExportClip>,
    options: ExportOptions,
    task_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<ExportResult> {
    let task = register_task(&task_id, state.inner())?;
    let preferences = preferences_clone(&state)?;
    emit_ffmpeg_progress(&app, &task_id, 0.0);
    validate_export_options(&options)?;
    if clips.is_empty() {
        return Err(app_error(
            ErrorCode::ExportClipsEmpty,
            "There are no clips to export",
        ));
    }

    let mut probed = Vec::new();
    let mut warnings = Vec::new();
    for clip in &clips {
        task.check_cancelled()?;
        if !Path::new(&clip.source_path).is_file() {
            warnings.push(UserNotice::warning_with_detail(
                "EXPORT_SOURCE_MISSING",
                format!("源文件不存在，已跳过：{}", clip.label),
                format!("missing export source: {}", clip.source_path),
            ));
            continue;
        }
        match probe_export_clip(
            clip,
            &preferences,
            state.inner(),
            &task_id,
            task.cancel_token(),
        )
        .await
        {
            Ok(probed_clip) => {
                if probed_clip.dur_us <= 0 {
                    warnings.push(UserNotice::warning(
                        "EXPORT_CLIP_ZERO_DURATION",
                        format!("片段时长无效，已跳过：{}", probed_clip.label),
                    ));
                    continue;
                }
                if !probed_clip.has_video {
                    warnings.push(UserNotice::warning(
                        "EXPORT_CLIP_NO_VIDEO",
                        format!("片段不包含视频流，已跳过：{}", probed_clip.label),
                    ));
                    continue;
                }
                probed.push(probed_clip);
            }
            Err(error) => {
                if error.is(ErrorCode::TaskCancelled) {
                    return Err(error);
                }
                warnings.push(UserNotice::warning_with_detail(
                    "EXPORT_PROBE_FAILED",
                    format!("无法读取片段，已跳过：{}", clip.label),
                    error.detail(),
                ));
            }
        }
    }
    task.check_cancelled()?;
    if probed.is_empty() {
        return Err(app_error(
            ErrorCode::ExportClipsEmpty,
            "No usable clips remain after probing",
        ));
    }

    let output_dir = options.output_dir.trim().to_string();
    let dir = PathBuf::from(&output_dir);
    let dir_for_task = dir.clone();
    spawn_blocking_cancellable(
        task.cancel_token(),
        "create export output directory",
        move |_| {
            fs::create_dir_all(&dir_for_task).map_err(|error| {
                app_error(
                    ErrorCode::ExportWriteFailed,
                    format!(
                        "Failed to create export output directory {}: {error}",
                        dir_for_task.display()
                    ),
                )
            })
        },
    )
    .await?;
    task.check_cancelled()?;

    let stem = safe_component(&options.output_stem);
    let ext = export_extension(options.container);
    let mut outputs = Vec::new();
    match options.mode {
        ExportMode::Merge => {
            let output_path = dir.join(format!("{stem}.{ext}"));
            let output = run_export_merge(
                &probed,
                &options,
                &preferences,
                &output_path,
                &app,
                &task_id,
                state.inner(),
                task.cancel_token(),
                &mut warnings,
            )
            .await?;
            outputs.push(output);
        }
        ExportMode::Individual => {
            run_export_individual(
                &probed,
                &options,
                &preferences,
                &dir,
                &stem,
                &ext,
                &app,
                &task_id,
                state.inner(),
                task.cancel_token(),
                &mut outputs,
                &mut warnings,
            )
            .await?;
        }
    }

    task.check_cancelled()?;
    emit_ffmpeg_progress(&app, &task_id, 1.0);
    Ok(ExportResult { outputs, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_clip(has_audio: bool, width: i64, height: i64) -> ProbedClip {
        ProbedClip {
            id: "clip".to_string(),
            source_path: "/source.mp4".to_string(),
            label: "片段".to_string(),
            start_us: 0,
            dur_us: 10_000_000,
            has_video: true,
            has_audio,
            width,
            height,
            fps: 30.0,
            audio_sample_rate: 48000,
        }
    }

    fn options_with(container: ExportContainer) -> ExportOptions {
        ExportOptions {
            mode: ExportMode::Merge,
            container,
            resolution: ExportResolution::Custom,
            custom_width: 1280,
            custom_height: 720,
            frame_rate: Some(30.0),
            quality: ExportQuality::High,
            encoder_speed: ExportEncoderSpeed::Balanced,
            include_audio: true,
            audio_bitrate_kbps: 192,
            output_dir: "/out".to_string(),
            output_stem: "result".to_string(),
        }
    }

    #[test]
    fn merge_graph_concats_audio_when_all_clips_have_audio() {
        let clips = vec![test_clip(true, 1920, 1080), test_clip(true, 1280, 720)];
        let targets = ExportTargets {
            width: 1280,
            height: 720,
            fps: 30.0,
            pix_fmt: "yuv420p",
            audio_sample_rate: 48000,
        };
        let (graph, has_audio) = build_merge_filter_complex(&clips, &targets, true);
        assert!(has_audio);
        assert!(graph.ends_with("[0v][0a][1v][1a]concat=n=2:v=1:a=1[v][a]"));
        assert!(graph.contains("[0:a:0]aresample=48000:async=1:first_pts=0"));
        assert!(graph.contains("setpts=PTS-STARTPTS"));
        assert!(graph.contains(
            "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2"
        ));
        assert!(graph.contains("fps=30.000000"));
        assert!(graph.contains("format=yuv420p"));
    }

    #[test]
    fn merge_graph_drops_audio_when_a_clip_lacks_audio() {
        let clips = vec![test_clip(true, 1920, 1080), test_clip(false, 1280, 720)];
        let targets = ExportTargets {
            width: 1280,
            height: 720,
            fps: 30.0,
            pix_fmt: "yuv420p",
            audio_sample_rate: 48000,
        };
        let (graph, has_audio) = build_merge_filter_complex(&clips, &targets, true);
        assert!(!has_audio);
        assert!(graph.ends_with("[0v][1v]concat=n=2:v=1:a=0[v]"));
        assert!(!graph.contains("[0:a:0]"));
    }

    #[test]
    fn merge_graph_ignores_audio_when_disabled() {
        let clips = vec![test_clip(true, 1920, 1080)];
        let targets = ExportTargets {
            width: 1920,
            height: 1080,
            fps: 30.0,
            pix_fmt: "yuv420p",
            audio_sample_rate: 48000,
        };
        let (graph, has_audio) = build_merge_filter_complex(&clips, &targets, false);
        assert!(!has_audio);
        assert!(graph.contains("concat=n=1:v=1:a=0[v]"));
    }

    #[test]
    fn clamp_range_normalizes_bounds() {
        assert_eq!(clamp_range(0, 0, 10_000_000), (0, 10_000_000));
        assert_eq!(clamp_range(-100, 5_000_000, 10_000_000), (0, 5_000_000));
        assert_eq!(
            clamp_range(9_000_000, 99_000_000, 10_000_000),
            (9_000_000, 10_000_000)
        );
        assert_eq!(
            clamp_range(12_000_000, 0, 10_000_000),
            (10_000_000, 10_000_000)
        );
        assert_eq!(
            clamp_range(3_000_000, 2_000_000, 10_000_000),
            (3_000_000, 3_000_000)
        );
    }

    #[test]
    fn crf_and_profile_mapping_is_stable() {
        assert_eq!(export_crf(ExportContainer::Mp4H264, ExportQuality::Low), 28);
        assert_eq!(
            export_crf(ExportContainer::Mp4H264, ExportQuality::High),
            20
        );
        assert_eq!(
            export_crf(ExportContainer::Mp4Hevc, ExportQuality::VeryHigh),
            17
        );
        assert_eq!(
            export_crf(ExportContainer::WebmVp9, ExportQuality::Medium),
            34
        );
        assert_eq!(prores_profile(ExportQuality::Low), 0);
        assert_eq!(prores_profile(ExportQuality::Medium), 2);
        assert_eq!(prores_profile(ExportQuality::High), 3);
    }

    #[test]
    fn output_extensions_match_containers() {
        assert_eq!(export_extension(ExportContainer::Mp4H264), "mp4");
        assert_eq!(export_extension(ExportContainer::Mp4Hevc), "mp4");
        assert_eq!(export_extension(ExportContainer::MovProres), "mov");
        assert_eq!(export_extension(ExportContainer::WebmVp9), "webm");
    }

    #[test]
    fn encoder_args_include_container_specific_flags() {
        let mut args = Vec::new();
        append_video_encode_args(&mut args, &options_with(ExportContainer::Mp4H264));
        assert!(args.iter().any(|arg| arg == "libx264"));
        assert!(args.iter().any(|arg| arg == "+faststart"));

        let mut webm_args = Vec::new();
        append_video_encode_args(&mut webm_args, &options_with(ExportContainer::WebmVp9));
        assert!(webm_args.iter().any(|arg| arg == "libvpx-vp9"));
        assert!(webm_args.iter().any(|arg| arg == "-row-mt"));
        assert!(webm_args.iter().any(|arg| arg == "0"));
        assert!(webm_args.iter().any(|arg| arg == "-deadline"));

        let mut prores_args = Vec::new();
        append_video_encode_args(&mut prores_args, &options_with(ExportContainer::MovProres));
        assert!(prores_args.iter().any(|arg| arg == "prores_ks"));
        assert!(prores_args.iter().any(|arg| arg == "yuv422p10le"));
    }

    #[test]
    fn audio_encode_args_choose_container_codec() {
        let mut mp4 = Vec::new();
        append_audio_encode_args(&mut mp4, &options_with(ExportContainer::Mp4H264), true);
        assert!(mp4.iter().any(|arg| arg == "aac"));
        assert!(mp4.iter().any(|arg| arg == "192k"));

        let mut webm = Vec::new();
        append_audio_encode_args(&mut webm, &options_with(ExportContainer::WebmVp9), true);
        assert!(webm.iter().any(|arg| arg == "libopus"));

        let mut none = Vec::new();
        append_audio_encode_args(&mut none, &options_with(ExportContainer::Mp4H264), false);
        assert!(none.iter().any(|arg| arg == "-an"));
    }
}
