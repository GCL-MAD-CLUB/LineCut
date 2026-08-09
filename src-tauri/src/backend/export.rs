use super::*;
use futures::stream::{self, StreamExt};

const EXPORT_AUDIO_SAMPLE_RATE_DEFAULT: i64 = 48000;
const EXPORT_FRAME_RATE_FALLBACK: f64 = 30.0;
const EXPORT_MATCH_SOURCE_FALLBACK_WIDTH: i64 = 640;
const EXPORT_MATCH_SOURCE_FALLBACK_HEIGHT: i64 = 360;

#[derive(Clone)]
struct ProbedClip {
    id: String,
    source_path: String,
    label: String,
    output_name: String,
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
    audio_channel_layout: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExportVideoEncoderKind {
    Software,
    Nvenc,
    QuickSync,
    Amf,
    MediaFoundation,
    VideoToolbox,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Vaapi,
}

#[derive(Clone)]
struct ExportVideoEncoder {
    kind: ExportVideoEncoderKind,
    vaapi_device: Option<String>,
}

impl ExportVideoEncoder {
    const fn software() -> Self {
        Self {
            kind: ExportVideoEncoderKind::Software,
            vaapi_device: None,
        }
    }

    const fn is_hardware(&self) -> bool {
        !matches!(self.kind, ExportVideoEncoderKind::Software)
    }

    const fn requires_vaapi_frames(&self) -> bool {
        matches!(self.kind, ExportVideoEncoderKind::Vaapi)
    }

    fn name(&self) -> &'static str {
        match self.kind {
            ExportVideoEncoderKind::Software => "software",
            ExportVideoEncoderKind::Nvenc => "NVIDIA NVENC",
            ExportVideoEncoderKind::QuickSync => "Intel Quick Sync",
            ExportVideoEncoderKind::Amf => "AMD AMF",
            ExportVideoEncoderKind::MediaFoundation => "Media Foundation",
            ExportVideoEncoderKind::VideoToolbox => "VideoToolbox",
            ExportVideoEncoderKind::Vaapi => "VAAPI",
        }
    }
}

struct IndividualExportResult {
    index: usize,
    output: ExportOutput,
    warnings: Vec<UserNotice>,
}

#[derive(Clone)]
struct ExportRuntime<'a> {
    options: &'a ExportOptions,
    preferences: &'a Preferences,
    app: &'a tauri::AppHandle,
    task_id: &'a str,
    state: &'a AppState,
    cancel: Arc<AtomicBool>,
}

#[derive(Clone)]
struct IndividualExportContext<'a> {
    runtime: ExportRuntime<'a>,
    dir: PathBuf,
    stem: String,
    ext: String,
    worker_threads: usize,
    hardware_disabled: Arc<AtomicBool>,
    progress: ExportProgressReporter,
}

#[derive(Clone)]
struct ExportProgressReporter {
    app: tauri::AppHandle,
    task_id: String,
    fractions: Arc<Mutex<Vec<f64>>>,
    weights: Arc<Vec<f64>>,
}

impl ExportProgressReporter {
    fn new(app: &tauri::AppHandle, task_id: &str, clips: &[ProbedClip]) -> Self {
        let weights = clips
            .iter()
            .map(|clip| clip.dur_us.max(1) as f64)
            .collect::<Vec<_>>();
        Self {
            app: app.clone(),
            task_id: task_id.to_string(),
            fractions: Arc::new(Mutex::new(vec![0.0; clips.len()])),
            weights: Arc::new(weights),
        }
    }

    fn report(&self, index: usize, fraction: f64) {
        let Ok(mut fractions) = self.fractions.lock() else {
            return;
        };
        let Some(current) = fractions.get_mut(index) else {
            return;
        };
        // A hardware fallback restarts a clip at zero.  Do not let that make
        // the overall progress bar move backwards.
        *current = (*current).max(fraction.clamp(0.0, 1.0));
        let total_weight = self.weights.iter().sum::<f64>().max(1.0);
        let overall = fractions
            .iter()
            .zip(self.weights.iter())
            .map(|(progress, weight)| progress * weight)
            .sum::<f64>()
            / total_weight;
        emit_ffmpeg_progress(&self.app, &self.task_id, overall);
    }

    fn callback(&self, index: usize) -> Arc<dyn Fn(f64) + Send + Sync> {
        let reporter = self.clone();
        Arc::new(move |fraction| reporter.report(index, fraction))
    }
}

fn monotonic_progress_callback(
    app: &tauri::AppHandle,
    task_id: &str,
) -> Arc<dyn Fn(f64) + Send + Sync> {
    let app = app.clone();
    let task_id = task_id.to_string();
    let last_progress = Arc::new(Mutex::new(0.0_f64));
    Arc::new(move |progress| {
        let Ok(mut last) = last_progress.lock() else {
            return;
        };
        *last = (*last).max(progress.clamp(0.0, 1.0));
        emit_ffmpeg_progress(&app, &task_id, *last);
    })
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
    if !options.include_video && !options.include_audio {
        return Err(app_error(
            ErrorCode::ExportOptionsInvalid,
            "At least one of video or audio must be enabled",
        ));
    }
    let audio_only_container = matches!(
        options.container,
        ExportContainer::Mp3Audio | ExportContainer::AacAudio
    );
    if audio_only_container && options.include_video {
        return Err(app_error(
            ErrorCode::ExportOptionsInvalid,
            "The selected audio container cannot contain video",
        ));
    }
    if options.include_video
        && matches!(options.resolution, ExportResolution::Custom)
        && (options.custom_width < 2 || options.custom_height < 2)
    {
        return Err(app_error(
            ErrorCode::ExportDimensionsInvalid,
            "Custom resolution must be at least 2x2 pixels",
        ));
    }
    if let Some(frame_rate) = options.frame_rate.filter(|_| options.include_video) {
        if !frame_rate.is_finite() || !(1.0..=120.0).contains(&frame_rate) {
            return Err(app_error(
                ErrorCode::ExportOptionsInvalid,
                "Export frame rate must be between 1 and 120",
            ));
        }
    }
    // Codec/container compatibility only matters when audio is included (video-only uses `-an`).
    if options.include_audio {
        let codec_matches_container = match options.container {
            ExportContainer::WebmVp9 => matches!(options.audio_codec, ExportAudioCodec::Opus),
            ExportContainer::Mp3Audio => matches!(options.audio_codec, ExportAudioCodec::Mp3),
            ExportContainer::AacAudio => matches!(options.audio_codec, ExportAudioCodec::Aac),
            ExportContainer::Mp4H264 | ExportContainer::Mp4Hevc | ExportContainer::MovProres => {
                matches!(
                    options.audio_codec,
                    ExportAudioCodec::Aac | ExportAudioCodec::Mp2 | ExportAudioCodec::Mp3
                )
            }
        };
        if !codec_matches_container {
            return Err(app_error(
                ErrorCode::ExportOptionsInvalid,
                "Audio codec is not supported by the selected container",
            ));
        }
    }
    if let Some(rate) = options.audio_sample_rate_hz {
        if !(8000..=192000).contains(&rate) {
            return Err(app_error(
                ErrorCode::ExportOptionsInvalid,
                "Audio sample rate must be between 8000 and 192000 Hz",
            ));
        }
    }
    Ok(())
}

fn probe_export_clip(clip: &ExportClip, probe: &ProbeOutput) -> ProbedClip {
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
    ProbedClip {
        id: clip.id.clone(),
        source_path: clip.source_path.clone(),
        label: clip.label.clone(),
        output_name: clip.output_name.clone(),
        start_us,
        dur_us: end_us - start_us,
        has_video,
        has_audio,
        width,
        height,
        fps,
        audio_sample_rate,
    }
}

fn available_cpu_threads() -> usize {
    std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
}

fn probe_parallelism(source_count: usize) -> usize {
    source_count
        .min((available_cpu_threads().saturating_mul(2)).clamp(2, 8))
        .max(1)
}

async fn probe_export_sources(
    clips: &[ExportClip],
    options: &ExportOptions,
    preferences: &Preferences,
    state: &AppState,
    task_id: &str,
    cancel: Arc<AtomicBool>,
    warnings: &mut Vec<UserNotice>,
) -> AppResult<Vec<ProbedClip>> {
    let mut source_paths = Vec::new();
    let mut seen_paths = HashSet::new();
    for clip in clips {
        if !Path::new(&clip.source_path).is_file() {
            warnings.push(UserNotice::warning_with_detail(
                "EXPORT_SOURCE_MISSING",
                format!("源文件不存在，已跳过：{}", clip.label),
                format!("missing export source: {}", clip.source_path),
            ));
        } else if seen_paths.insert(clip.source_path.clone()) {
            source_paths.push(clip.source_path.clone());
        }
    }

    let concurrency = probe_parallelism(source_paths.len());
    let probe_results = stream::iter(source_paths.into_iter().map(|source_path| {
        let cancel = cancel.clone();
        async move {
            let result =
                probe_media(Path::new(&source_path), preferences, state, task_id, cancel).await;
            (source_path, result)
        }
    }))
    .buffer_unordered(concurrency)
    .collect::<Vec<_>>()
    .await;

    let mut probes = HashMap::new();
    let mut probe_failures = HashMap::new();
    for (source_path, result) in probe_results {
        match result {
            Ok(probe) => {
                probes.insert(source_path, probe);
            }
            Err(error) if error.is(ErrorCode::TaskCancelled) => return Err(error),
            Err(error) => {
                probe_failures.insert(source_path, error.detail().to_string());
            }
        }
    }

    let mut probed = Vec::new();
    for clip in clips {
        let Some(probe) = probes.get(&clip.source_path) else {
            if let Some(detail) = probe_failures.get(&clip.source_path) {
                warnings.push(UserNotice::warning_with_detail(
                    "EXPORT_PROBE_FAILED",
                    format!("无法读取片段，已跳过：{}", clip.label),
                    detail,
                ));
            }
            continue;
        };
        let probed_clip = probe_export_clip(clip, probe);
        if probed_clip.dur_us <= 0 {
            warnings.push(UserNotice::warning(
                "EXPORT_CLIP_ZERO_DURATION",
                format!("片段时长无效，已跳过：{}", probed_clip.label),
            ));
        } else if options.include_video && !probed_clip.has_video {
            warnings.push(UserNotice::warning(
                "EXPORT_CLIP_NO_VIDEO",
                format!("片段不包含视频流，已跳过：{}", probed_clip.label),
            ));
        } else if !options.include_video && options.include_audio && !probed_clip.has_audio {
            warnings.push(UserNotice::warning(
                "EXPORT_CLIP_NO_AUDIO",
                format!("片段不包含音频流，已跳过：{}", probed_clip.label),
            ));
        } else {
            probed.push(probed_clip);
        }
    }
    Ok(probed)
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
        ExportContainer::Mp4H264
        | ExportContainer::Mp4Hevc
        | ExportContainer::WebmVp9
        | ExportContainer::Mp3Audio
        | ExportContainer::AacAudio => "yuv420p",
    };
    let audio_sample_rate = options
        .audio_sample_rate_hz
        .filter(|rate| *rate > 0)
        .unwrap_or_else(|| {
            clips
                .first()
                .map(|clip| clip.audio_sample_rate)
                .unwrap_or(EXPORT_AUDIO_SAMPLE_RATE_DEFAULT)
        });
    let audio_channel_layout = audio_channel_layout(options.audio_channels);
    Ok(ExportTargets {
        width,
        height,
        fps,
        pix_fmt,
        audio_sample_rate,
        audio_channel_layout,
    })
}

fn audio_channel_layout(channels: ExportAudioChannels) -> &'static str {
    match channels {
        ExportAudioChannels::Stereo => "stereo",
        ExportAudioChannels::Mono => "mono",
        ExportAudioChannels::FivePointOne => "5.1",
    }
}

fn plan_audio_targets(clips: &[ProbedClip], options: &ExportOptions) -> (i64, &'static str) {
    let sample_rate = options
        .audio_sample_rate_hz
        .filter(|rate| *rate > 0)
        .unwrap_or_else(|| {
            clips
                .first()
                .map(|clip| clip.audio_sample_rate)
                .unwrap_or(EXPORT_AUDIO_SAMPLE_RATE_DEFAULT)
        });
    (sample_rate, audio_channel_layout(options.audio_channels))
}

/// Builds a concat graph that touches only audio streams. This avoids all
/// video decoding, scaling and hardware setup for audio-only exports.
fn build_audio_merge_filter_complex(
    clips: &[ProbedClip],
    sample_rate: i64,
    channel_layout: &str,
) -> String {
    let mut parts = Vec::new();
    let mut concat_inputs = String::new();
    for (index, clip) in clips.iter().enumerate() {
        let dur_sec = clip.dur_us as f64 / 1_000_000.0;
        parts.push(format!(
            "[{index}:a:0]atrim=start=0:end={dur_sec:.6},aresample={sample_rate}:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts={channel_layout}[{index}a]"
        ));
        concat_inputs.push_str(&format!("[{index}a]"));
    }
    parts.push(format!(
        "{concat_inputs}concat=n={}:v=0:a=1[a]",
        clips.len()
    ));
    parts.join(";")
}

/// Builds the `filter_complex` graph for a merge export.
///
/// All per-input normalization (scaling, fps, pixel format, audio resample) happens
/// inside the graph so concatenated streams share identical dimensions, frame rate,
/// pixel format, sample rate, and channel layout. The input-side `-ss` fast seek
/// lands on the cut point (and resets each stream's PTS to 0), so `trim`/`atrim`
/// keep the first `dur` seconds of each input, and `setpts`/`aresample` resets
/// make the trimmed inputs safe to concatenate.
///
/// Returns `(graph, has_audio_output, video_output_label)`. Audio is dropped for
/// the whole merge when `include_audio` is false or any input lacks an audio stream.
fn build_merge_filter_complex(
    clips: &[ProbedClip],
    targets: &ExportTargets,
    include_audio: bool,
    encoder: &ExportVideoEncoder,
) -> (String, bool, &'static str) {
    let all_have_audio = include_audio && clips.iter().all(|clip| clip.has_audio);
    let scale = format!(
        "scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2",
        targets.width, targets.height, targets.width, targets.height
    );
    let mut parts = Vec::new();
    for (index, clip) in clips.iter().enumerate() {
        let dur_sec = clip.dur_us as f64 / 1_000_000.0;
        parts.push(format!(
            "[{index}:v:0]trim=start=0:end={dur_sec:.6},setpts=PTS-STARTPTS,{scale},setsar=1,fps={:.6},format={}[{index}v]",
            targets.fps, targets.pix_fmt
        ));
        if all_have_audio {
            parts.push(format!(
                "[{index}:a:0]atrim=start=0:end={dur_sec:.6},aresample={}:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts={}[{index}a]",
                targets.audio_sample_rate, targets.audio_channel_layout
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
    let video_output_label = if encoder.requires_vaapi_frames() {
        parts.push("[v]format=nv12,hwupload[encoded_v]".to_string());
        "encoded_v"
    } else {
        "v"
    };
    (parts.join(";"), all_have_audio, video_output_label)
}

fn export_extension(container: ExportContainer) -> &'static str {
    match container {
        ExportContainer::Mp4H264 | ExportContainer::Mp4Hevc => "mp4",
        ExportContainer::MovProres => "mov",
        ExportContainer::WebmVp9 => "webm",
        ExportContainer::Mp3Audio => "mp3",
        ExportContainer::AacAudio => "aac",
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
        (ExportContainer::Mp3Audio | ExportContainer::AacAudio, _) => 0,
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
        ExportContainer::Mp3Audio | ExportContainer::AacAudio => vec![],
    }
}

fn hardware_encoder_name(
    kind: ExportVideoEncoderKind,
    container: ExportContainer,
) -> Option<&'static str> {
    match (kind, container) {
        (ExportVideoEncoderKind::Nvenc, ExportContainer::Mp4H264) => Some("h264_nvenc"),
        (ExportVideoEncoderKind::Nvenc, ExportContainer::Mp4Hevc) => Some("hevc_nvenc"),
        (ExportVideoEncoderKind::QuickSync, ExportContainer::Mp4H264) => Some("h264_qsv"),
        (ExportVideoEncoderKind::QuickSync, ExportContainer::Mp4Hevc) => Some("hevc_qsv"),
        (ExportVideoEncoderKind::Amf, ExportContainer::Mp4H264) => Some("h264_amf"),
        (ExportVideoEncoderKind::Amf, ExportContainer::Mp4Hevc) => Some("hevc_amf"),
        (ExportVideoEncoderKind::MediaFoundation, ExportContainer::Mp4H264) => Some("h264_mf"),
        (ExportVideoEncoderKind::MediaFoundation, ExportContainer::Mp4Hevc) => Some("hevc_mf"),
        (ExportVideoEncoderKind::VideoToolbox, ExportContainer::Mp4H264) => {
            Some("h264_videotoolbox")
        }
        (ExportVideoEncoderKind::VideoToolbox, ExportContainer::Mp4Hevc) => {
            Some("hevc_videotoolbox")
        }
        (ExportVideoEncoderKind::Vaapi, ExportContainer::Mp4H264) => Some("h264_vaapi"),
        (ExportVideoEncoderKind::Vaapi, ExportContainer::Mp4Hevc) => Some("hevc_vaapi"),
        _ => None,
    }
}

fn encoder_is_listed(encoders: &str, name: &str) -> bool {
    encoders
        .lines()
        .any(|line| line.split_whitespace().any(|token| token == name))
}

fn hardware_encoder_candidates(container: ExportContainer) -> Vec<ExportVideoEncoder> {
    if !matches!(
        container,
        ExportContainer::Mp4H264 | ExportContainer::Mp4Hevc
    ) {
        return Vec::new();
    }
    let candidates = vec![
        ExportVideoEncoder {
            kind: ExportVideoEncoderKind::Nvenc,
            vaapi_device: None,
        },
        ExportVideoEncoder {
            kind: ExportVideoEncoderKind::QuickSync,
            vaapi_device: None,
        },
        ExportVideoEncoder {
            kind: ExportVideoEncoderKind::Amf,
            vaapi_device: None,
        },
        ExportVideoEncoder {
            kind: ExportVideoEncoderKind::MediaFoundation,
            vaapi_device: None,
        },
        ExportVideoEncoder {
            kind: ExportVideoEncoderKind::VideoToolbox,
            vaapi_device: None,
        },
    ];
    #[cfg(target_os = "linux")]
    {
        let mut candidates = candidates;
        for device in ["/dev/dri/renderD128", "/dev/dri/renderD129"] {
            if Path::new(device).exists() {
                candidates.push(ExportVideoEncoder {
                    kind: ExportVideoEncoderKind::Vaapi,
                    vaapi_device: Some(device.to_string()),
                });
                break;
            }
        }
        return candidates;
    }
    #[cfg(not(target_os = "linux"))]
    candidates
}

fn append_encoder_input_args(args: &mut Vec<String>, encoder: &ExportVideoEncoder) {
    if let Some(device) = &encoder.vaapi_device {
        push_args(args, &["-vaapi_device", device]);
    }
}

fn append_individual_input_args(args: &mut Vec<String>, clip: &ProbedClip) {
    // Input-side seeking is fast and remains frame-accurate while transcoding:
    // FFmpeg's accurate-seek path decodes/discards the short keyframe lead-in.
    // This avoids decoding from the beginning of a long source for every clip.
    push_args(args, &["-ss"]);
    args.push(format!("{:.6}", clip.start_us as f64 / 1_000_000.0));
    push_args(args, &["-accurate_seek", "-i", &clip.source_path]);
}

fn append_processing_thread_args(args: &mut Vec<String>, threads: usize) {
    let threads = threads.clamp(1, 16).to_string();
    push_args(
        args,
        &[
            "-threads",
            &threads,
            "-filter_threads",
            &threads,
            "-filter_complex_threads",
            &threads,
        ],
    );
}

fn append_output_thread_args(args: &mut Vec<String>, threads: usize) {
    let threads = threads.clamp(1, 16).to_string();
    push_args(args, &["-threads:v", &threads]);
}

fn hardware_quality(options: &ExportOptions) -> i32 {
    export_crf(options.container, options.quality)
}

fn append_hardware_video_encoder_args(
    args: &mut Vec<String>,
    options: &ExportOptions,
    encoder: &ExportVideoEncoder,
) {
    let name = hardware_encoder_name(encoder.kind, options.container)
        .expect("hardware encoder selected for an unsupported export container");
    push_args(args, &["-c:v", name]);
    match encoder.kind {
        ExportVideoEncoderKind::Nvenc => {
            let preset = match options.encoder_speed {
                ExportEncoderSpeed::Fast => "p1",
                ExportEncoderSpeed::Balanced => "p4",
                ExportEncoderSpeed::Quality => "p6",
            };
            push_args(args, &["-preset", preset, "-rc:v", "vbr", "-cq:v"]);
            args.push(hardware_quality(options).to_string());
            push_args(args, &["-b:v", "0"]);
        }
        ExportVideoEncoderKind::QuickSync => {
            let preset = match options.encoder_speed {
                ExportEncoderSpeed::Fast => "fast",
                ExportEncoderSpeed::Balanced => "medium",
                ExportEncoderSpeed::Quality => "slow",
            };
            push_args(args, &["-preset", preset, "-global_quality"]);
            args.push(hardware_quality(options).to_string());
        }
        ExportVideoEncoderKind::Amf => {
            let quality = match options.encoder_speed {
                ExportEncoderSpeed::Fast => "speed",
                ExportEncoderSpeed::Balanced => "balanced",
                ExportEncoderSpeed::Quality => "quality",
            };
            push_args(args, &["-quality", quality, "-rc", "cqp", "-qp_i"]);
            args.push(hardware_quality(options).to_string());
            push_args(args, &["-qp_p"]);
            args.push(hardware_quality(options).to_string());
        }
        ExportVideoEncoderKind::MediaFoundation => {
            push_args(
                args,
                &["-hw_encoding", "1", "-rate_control", "quality", "-quality"],
            );
            args.push(
                match options.quality {
                    ExportQuality::Low => "45",
                    ExportQuality::Medium => "60",
                    ExportQuality::High => "75",
                    ExportQuality::VeryHigh => "85",
                }
                .to_string(),
            );
        }
        ExportVideoEncoderKind::VideoToolbox => {
            push_args(args, &["-q:v"]);
            args.push(
                match options.quality {
                    ExportQuality::Low => "45",
                    ExportQuality::Medium => "60",
                    ExportQuality::High => "75",
                    ExportQuality::VeryHigh => "85",
                }
                .to_string(),
            );
        }
        ExportVideoEncoderKind::Vaapi => {
            push_args(args, &["-qp"]);
            args.push(hardware_quality(options).to_string());
        }
        ExportVideoEncoderKind::Software => unreachable!("software is not a hardware encoder"),
    }
}

fn append_hardware_video_encode_args(
    args: &mut Vec<String>,
    options: &ExportOptions,
    encoder: &ExportVideoEncoder,
) {
    append_hardware_video_encoder_args(args, options, encoder);
    match options.container {
        ExportContainer::Mp4H264 => {
            let pixel_format = match encoder.kind {
                ExportVideoEncoderKind::QuickSync => "nv12",
                ExportVideoEncoderKind::Vaapi => "vaapi",
                _ => "yuv420p",
            };
            push_args(args, &["-pix_fmt", pixel_format, "-movflags", "+faststart"])
        }
        ExportContainer::Mp4Hevc => push_args(
            args,
            &[
                "-pix_fmt",
                match encoder.kind {
                    ExportVideoEncoderKind::QuickSync => "nv12",
                    ExportVideoEncoderKind::Vaapi => "vaapi",
                    _ => "yuv420p",
                },
                "-tag:v",
                "hvc1",
                "-movflags",
                "+faststart",
            ],
        ),
        ExportContainer::MovProres
        | ExportContainer::WebmVp9
        | ExportContainer::Mp3Audio
        | ExportContainer::AacAudio => {}
    }
}

async fn verify_hardware_encoder(
    encoder: &ExportVideoEncoder,
    options: &ExportOptions,
    preferences: &Preferences,
    state: &AppState,
    task_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    if hardware_encoder_name(encoder.kind, options.container).is_none() {
        return Err(app_error(
            ErrorCode::ExportOptionsInvalid,
            "Hardware encoder does not support the selected container",
        ));
    }
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
    ];
    append_encoder_input_args(&mut args, encoder);
    push_args(
        &mut args,
        &[
            "-f",
            "lavfi",
            "-i",
            "color=black:s=64x64:d=0.04",
            "-frames:v",
            "1",
        ],
    );
    if encoder.requires_vaapi_frames() {
        push_args(&mut args, &["-vf", "format=nv12,hwupload"]);
    }
    append_hardware_video_encoder_args(&mut args, options, encoder);
    push_args(&mut args, &["-f", "null", "-"]);
    run_output(&ffmpeg_program(preferences), &args, state, task_id, cancel)
        .await
        .map(|_| ())
}

async fn select_video_encoder(
    options: &ExportOptions,
    preferences: &Preferences,
    state: &AppState,
    task_id: &str,
    cancel: Arc<AtomicBool>,
) -> ExportVideoEncoder {
    if !options.include_video {
        return ExportVideoEncoder::software();
    }
    if matches!(
        options.hardware_acceleration,
        ExportHardwareAcceleration::Software
    ) {
        return ExportVideoEncoder::software();
    }
    let candidates = hardware_encoder_candidates(options.container);
    if candidates.is_empty() {
        return ExportVideoEncoder::software();
    }
    let encoder_list_args = vec!["-hide_banner".to_string(), "-encoders".to_string()];
    let Ok(encoders) = run_output(
        &ffmpeg_program(preferences),
        &encoder_list_args,
        state,
        task_id,
        cancel.clone(),
    )
    .await
    else {
        return ExportVideoEncoder::software();
    };

    for candidate in candidates {
        let Some(name) = hardware_encoder_name(candidate.kind, options.container) else {
            continue;
        };
        if !encoder_is_listed(&encoders, name) {
            continue;
        }
        match verify_hardware_encoder(
            &candidate,
            options,
            preferences,
            state,
            task_id,
            cancel.clone(),
        )
        .await
        {
            Ok(()) => return candidate,
            Err(error) if error.is(ErrorCode::TaskCancelled) => {
                return ExportVideoEncoder::software()
            }
            Err(error) => tracing::debug!(
                encoder = candidate.name(),
                detail = error.detail(),
                "export hardware encoder is unavailable"
            ),
        }
    }
    ExportVideoEncoder::software()
}

fn append_software_video_encode_args(args: &mut Vec<String>, options: &ExportOptions) {
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
        ExportContainer::Mp3Audio | ExportContainer::AacAudio => {}
    }
}

fn append_video_encode_args(
    args: &mut Vec<String>,
    options: &ExportOptions,
    encoder: &ExportVideoEncoder,
) {
    if encoder.is_hardware() {
        append_hardware_video_encode_args(args, options, encoder);
    } else {
        append_software_video_encode_args(args, options);
    }
}

fn append_audio_encode_args(args: &mut Vec<String>, options: &ExportOptions, enabled: bool) {
    if !enabled {
        args.push("-an".to_string());
        return;
    }
    const MP2_BITRATES: &[u32] = &[128, 160, 192, 224, 256, 320, 384];
    const MP3_BITRATES: &[u32] = &[128, 160, 192, 224, 256, 320];
    let bitrate = match options.audio_codec {
        ExportAudioCodec::Mp2 => *MP2_BITRATES
            .iter()
            .min_by_key(|value| value.abs_diff(options.audio_bitrate_kbps))
            .expect("MP2 bitrate list is non-empty"),
        ExportAudioCodec::Mp3 => *MP3_BITRATES
            .iter()
            .min_by_key(|value| value.abs_diff(options.audio_bitrate_kbps))
            .expect("MP3 bitrate list is non-empty"),
        ExportAudioCodec::Aac | ExportAudioCodec::Opus => options.audio_bitrate_kbps.clamp(16, 512),
    };
    match options.audio_codec {
        ExportAudioCodec::Aac => {
            push_args(args, &["-c:a", "aac", "-b:a"]);
            args.push(format!("{bitrate}k"));
        }
        ExportAudioCodec::Mp2 => {
            push_args(args, &["-c:a", "mp2", "-b:a"]);
            args.push(format!("{bitrate}k"));
        }
        ExportAudioCodec::Mp3 => {
            push_args(args, &["-c:a", "libmp3lame", "-b:a"]);
            args.push(format!("{bitrate}k"));
        }
        ExportAudioCodec::Opus => {
            push_args(args, &["-c:a", "libopus", "-b:a"]);
            args.push(format!("{bitrate}k"));
        }
    }
    // Without an explicit rate the stream keeps its (filter-normalized) source rate.
    if let Some(rate) = options.audio_sample_rate_hz.filter(|rate| *rate > 0) {
        push_args(args, &["-ar"]);
        args.push(rate.to_string());
    }
}

async fn run_export_merge(
    clips: &[ProbedClip],
    encoder: &ExportVideoEncoder,
    output_path: &Path,
    runtime: &ExportRuntime<'_>,
    warnings: &mut Vec<UserNotice>,
) -> AppResult<ExportOutput> {
    if runtime.options.include_video
        && runtime.options.include_audio
        && clips.iter().any(|clip| !clip.has_audio)
    {
        warnings.push(UserNotice::warning(
            "EXPORT_AUDIO_DROPPED",
            "部分片段不包含音轨，合并导出将仅保留画面",
        ));
    }

    let progress_callback = monotonic_progress_callback(runtime.app, runtime.task_id);
    let run = run_export_merge_ffmpeg(
        clips,
        encoder,
        output_path,
        runtime,
        Some(progress_callback.clone()),
    )
    .await;
    match run {
        Ok(()) => {}
        Err(error) if error.is(ErrorCode::TaskCancelled) => return Err(error),
        Err(error) if encoder.is_hardware() => {
            warnings.push(UserNotice::warning_with_detail(
                "EXPORT_HARDWARE_FALLBACK",
                format!(
                    "{} 硬件编码不可用，已自动切换到 CPU 编码继续导出",
                    encoder.name()
                ),
                error.detail(),
            ));
            run_export_merge_ffmpeg(
                clips,
                &ExportVideoEncoder::software(),
                output_path,
                runtime,
                Some(progress_callback),
            )
            .await?;
        }
        Err(error) => return Err(error),
    }
    unregister_task_cleanup_paths(runtime.task_id, &[output_path.to_path_buf()], runtime.state)?;
    Ok(ExportOutput {
        clip_id: None,
        path: output_path.to_string_lossy().into_owned(),
        status: "completed".to_string(),
        error: None,
        duration_us: clips.iter().map(|clip| clip.dur_us).sum(),
    })
}

async fn run_export_merge_ffmpeg(
    clips: &[ProbedClip],
    encoder: &ExportVideoEncoder,
    output_path: &Path,
    runtime: &ExportRuntime<'_>,
    progress_callback: Option<Arc<dyn Fn(f64) + Send + Sync>>,
) -> AppResult<()> {
    let (graph, has_audio_output, video_output_label) = if runtime.options.include_video {
        let targets = plan_merge_targets(clips, runtime.options)?;
        let (graph, has_audio, video_label) =
            build_merge_filter_complex(clips, &targets, runtime.options.include_audio, encoder);
        (graph, has_audio, Some(video_label))
    } else {
        let (sample_rate, channel_layout) = plan_audio_targets(clips, runtime.options);
        (
            build_audio_merge_filter_complex(clips, sample_rate, channel_layout),
            true,
            None,
        )
    };

    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
    ];
    append_processing_thread_args(&mut args, available_cpu_threads());
    append_encoder_input_args(&mut args, encoder);
    for clip in clips {
        args.push("-ss".to_string());
        args.push(format!("{:.6}", clip.start_us as f64 / 1_000_000.0));
        args.push("-i".to_string());
        args.push(clip.source_path.clone());
    }
    args.push("-filter_complex".to_string());
    args.push(graph);
    if let Some(video_output_label) = video_output_label {
        args.push("-map".to_string());
        args.push(format!("[{video_output_label}]"));
    }
    if has_audio_output {
        args.push("-map".to_string());
        args.push("[a]".to_string());
    }
    if runtime.options.include_video {
        append_video_encode_args(&mut args, runtime.options, encoder);
        append_output_thread_args(&mut args, available_cpu_threads());
    } else {
        args.push("-vn".to_string());
    }
    append_audio_encode_args(&mut args, runtime.options, has_audio_output);
    args.push("-sn".to_string());
    args.push(output_path.to_string_lossy().into_owned());

    let total_duration_us: i64 = clips.iter().map(|clip| clip.dur_us).sum();
    run_status_with_ffmpeg_progress(
        &ffmpeg_program(runtime.preferences),
        &args,
        FfmpegProgressContext {
            app: runtime.app,
            state: runtime.state,
            task_id: runtime.task_id,
            cancel: runtime.cancel.clone(),
            base_progress: 0.0,
            progress_span: 1.0,
            duration_us: total_duration_us,
            cleanup_paths: vec![output_path.to_path_buf()],
            progress_callback,
        },
    )
    .await
}

/// Output file name for a clip: prefer the frontend-computed rename rule
/// result, falling back to the legacy stem-based name when it is empty.
fn output_file_name(clip: &ProbedClip, stem: &str, index: usize, ext: &str) -> String {
    let renamed = safe_component(&clip.output_name);
    if renamed.is_empty() {
        format!(
            "{stem}_{:03}_{}.{ext}",
            index + 1,
            safe_component(&clip.label)
        )
    } else {
        renamed
    }
}

fn planned_individual_export_parallelism(
    cpu_threads: usize,
    hardware_encoder: bool,
    video_enabled: bool,
    clip_count: usize,
) -> usize {
    if clip_count <= 1 {
        return 1;
    }
    let workers = if !video_enabled {
        // Audio encoders and filters are comparatively light. Scale higher so
        // short batches do not spend most of their time on process startup.
        match cpu_threads {
            0..=2 => 1,
            3..=4 => 2,
            5..=8 => 4,
            9..=16 => 6,
            _ => 8,
        }
    } else if hardware_encoder {
        // Hardware encoders need a CPU worker for decode/filtering too.  Two
        // concurrent jobs keep most GPUs/iGPUs busy without swamping their
        // encode-session limits; higher-core machines can sustain three.
        match cpu_threads {
            0..=3 => 1,
            4..=11 => 2,
            _ => 3,
        }
    } else {
        match cpu_threads {
            0..=4 => 1,
            5..=8 => 2,
            9..=16 => 3,
            _ => 4,
        }
    };
    workers.min(clip_count).max(1)
}

fn individual_export_parallelism(
    encoder: &ExportVideoEncoder,
    video_enabled: bool,
    clip_count: usize,
) -> usize {
    planned_individual_export_parallelism(
        available_cpu_threads(),
        encoder.is_hardware(),
        video_enabled,
        clip_count,
    )
}

fn per_export_thread_budget(worker_count: usize) -> usize {
    let cpu_threads = available_cpu_threads();
    ((cpu_threads + worker_count.saturating_sub(1)) / worker_count).clamp(1, 16)
}

async fn run_individual_export_ffmpeg(
    index: usize,
    clip: &ProbedClip,
    encoder: &ExportVideoEncoder,
    output_path: &Path,
    context: &IndividualExportContext<'_>,
) -> AppResult<()> {
    let options = context.runtime.options;
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
    ];
    append_processing_thread_args(&mut args, context.worker_threads);
    append_encoder_input_args(&mut args, encoder);
    append_individual_input_args(&mut args, clip);
    push_args(&mut args, &["-t"]);
    args.push(format!("{:.6}", clip.dur_us as f64 / 1_000_000.0));
    if options.include_video {
        push_args(&mut args, &["-map", "0:v:0"]);

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
        if encoder.requires_vaapi_frames() {
            video_filters.push("format=nv12,hwupload".to_string());
        }
        args.push("-vf".to_string());
        args.push(video_filters.join(","));
    }

    let audio_enabled = options.include_audio && clip.has_audio;
    if audio_enabled {
        push_args(&mut args, &["-map", "0:a:0?"]);
        let channel_layout = audio_channel_layout(options.audio_channels);
        let audio_filter = match options.audio_sample_rate_hz.filter(|rate| *rate > 0) {
            Some(rate) => format!(
                "aresample={rate}:async=1:first_pts=0,aformat=channel_layouts={channel_layout}"
            ),
            None => format!("aformat=channel_layouts={channel_layout}"),
        };
        push_args(&mut args, &["-af", &audio_filter]);
    }
    if options.include_video {
        append_video_encode_args(&mut args, options, encoder);
        append_output_thread_args(&mut args, context.worker_threads);
    } else {
        args.push("-vn".to_string());
    }
    append_audio_encode_args(&mut args, options, audio_enabled);
    push_args(&mut args, &["-sn"]);
    args.push(output_path.to_string_lossy().into_owned());

    run_status_with_ffmpeg_progress(
        &ffmpeg_program(context.runtime.preferences),
        &args,
        FfmpegProgressContext {
            app: context.runtime.app,
            state: context.runtime.state,
            task_id: context.runtime.task_id,
            cancel: context.runtime.cancel.clone(),
            base_progress: 0.0,
            progress_span: 1.0,
            duration_us: clip.dur_us,
            cleanup_paths: vec![output_path.to_path_buf()],
            progress_callback: Some(context.progress.callback(index)),
        },
    )
    .await
}

async fn run_export_individual_clip(
    index: usize,
    clip: ProbedClip,
    encoder: ExportVideoEncoder,
    context: &IndividualExportContext<'_>,
) -> AppResult<IndividualExportResult> {
    ensure_not_cancelled(&context.runtime.cancel)?;
    let output_path = context
        .dir
        .join(output_file_name(&clip, &context.stem, index, &context.ext));
    let active_encoder =
        if encoder.is_hardware() && context.hardware_disabled.load(Ordering::SeqCst) {
            ExportVideoEncoder::software()
        } else {
            encoder
        };
    let mut warnings = Vec::new();
    let run =
        run_individual_export_ffmpeg(index, &clip, &active_encoder, &output_path, context).await;
    let run = match run {
        Err(error) if error.is(ErrorCode::TaskCancelled) => return Err(error),
        Err(error) if active_encoder.is_hardware() => {
            let is_first_failure = !context.hardware_disabled.swap(true, Ordering::SeqCst);
            if is_first_failure {
                warnings.push(UserNotice::warning_with_detail(
                    "EXPORT_HARDWARE_FALLBACK",
                    format!(
                        "{} 硬件编码不可用，已自动切换到 CPU 编码继续导出",
                        active_encoder.name()
                    ),
                    error.detail(),
                ));
            }
            run_individual_export_ffmpeg(
                index,
                &clip,
                &ExportVideoEncoder::software(),
                &output_path,
                context,
            )
            .await
        }
        result => result,
    };

    let output = match run {
        Ok(()) => {
            unregister_task_cleanup_paths(
                context.runtime.task_id,
                std::slice::from_ref(&output_path),
                context.runtime.state,
            )?;
            context.progress.report(index, 1.0);
            ExportOutput {
                clip_id: Some(clip.id),
                path: output_path.to_string_lossy().into_owned(),
                status: "completed".to_string(),
                error: None,
                duration_us: clip.dur_us,
            }
        }
        Err(error) if error.is(ErrorCode::TaskCancelled) => return Err(error),
        Err(error) => {
            context.progress.report(index, 1.0);
            warnings.push(UserNotice::warning_with_detail(
                "EXPORT_CLIP_FAILED",
                format!("片段导出失败：{}", clip.label),
                error.detail(),
            ));
            ExportOutput {
                clip_id: Some(clip.id),
                path: output_path.to_string_lossy().into_owned(),
                status: "failed".to_string(),
                error: Some(error.detail().to_string()),
                duration_us: 0,
            }
        }
    };
    Ok(IndividualExportResult {
        index,
        output,
        warnings,
    })
}

async fn run_export_individual(
    clips: &[ProbedClip],
    encoder: &ExportVideoEncoder,
    dir: &Path,
    stem: &str,
    ext: &str,
    runtime: &ExportRuntime<'_>,
) -> AppResult<(Vec<ExportOutput>, Vec<UserNotice>)> {
    let worker_count =
        individual_export_parallelism(encoder, runtime.options.include_video, clips.len());
    let worker_threads = per_export_thread_budget(worker_count);
    tracing::info!(
        clip_count = clips.len(),
        worker_count,
        threads_per_worker = worker_threads,
        hardware_encoder = encoder.is_hardware(),
        "planned individual export concurrency"
    );
    let context = IndividualExportContext {
        runtime: runtime.clone(),
        dir: dir.to_path_buf(),
        stem: stem.to_string(),
        ext: ext.to_string(),
        worker_threads,
        hardware_disabled: Arc::new(AtomicBool::new(false)),
        progress: ExportProgressReporter::new(runtime.app, runtime.task_id, clips),
    };
    let mut results = stream::iter(clips.iter().cloned().enumerate().map(|(index, clip)| {
        let encoder = encoder.clone();
        let context = context.clone();
        async move { run_export_individual_clip(index, clip, encoder, &context).await }
    }))
    .buffer_unordered(worker_count);

    let mut completed = Vec::new();
    while let Some(result) = results.next().await {
        completed.push(result?);
    }
    completed.sort_by_key(|result| result.index);
    let warnings = completed
        .iter_mut()
        .flat_map(|result| std::mem::take(&mut result.warnings))
        .collect();
    let outputs = completed.into_iter().map(|result| result.output).collect();
    Ok((outputs, warnings))
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

    let mut warnings = Vec::new();
    let probed = probe_export_sources(
        &clips,
        &options,
        &preferences,
        state.inner(),
        &task_id,
        task.cancel_token(),
        &mut warnings,
    )
    .await?;
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

    let encoder = select_video_encoder(
        &options,
        &preferences,
        state.inner(),
        &task_id,
        task.cancel_token(),
    )
    .await;
    task.check_cancelled()?;
    tracing::info!(
        encoder = encoder.name(),
        hardware = encoder.is_hardware(),
        cpu_threads = available_cpu_threads(),
        "selected export video encoder"
    );

    let stem = safe_component(&options.output_stem);
    let ext = export_extension(options.container);
    let runtime = ExportRuntime {
        options: &options,
        preferences: &preferences,
        app: &app,
        task_id: &task_id,
        state: state.inner(),
        cancel: task.cancel_token(),
    };
    let mut outputs = Vec::new();
    match options.mode {
        ExportMode::Merge => {
            let merged_name = if options.output_name.trim().is_empty() {
                safe_component(&probed[0].output_name)
            } else {
                safe_component(&options.output_name)
            };
            let output_path = if merged_name.is_empty() {
                dir.join(format!("{stem}.{ext}"))
            } else {
                dir.join(merged_name)
            };
            let output =
                run_export_merge(&probed, &encoder, &output_path, &runtime, &mut warnings).await?;
            outputs.push(output);
        }
        ExportMode::Individual => {
            let (individual_outputs, individual_warnings) =
                run_export_individual(&probed, &encoder, &dir, &stem, ext, &runtime).await?;
            outputs.extend(individual_outputs);
            warnings.extend(individual_warnings);
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
            output_name: "result.mp4".to_string(),
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
            hardware_acceleration: ExportHardwareAcceleration::Auto,
            include_video: true,
            include_audio: true,
            audio_codec: ExportAudioCodec::Aac,
            audio_sample_rate_hz: None,
            audio_channels: ExportAudioChannels::Stereo,
            audio_bitrate_kbps: 192,
            import_into_project: false,
            use_proxy: false,
            destination: ExportDestination::Specified,
            use_subfolder: false,
            subfolder_name: String::new(),
            output_dir: "/out".to_string(),
            output_stem: "result".to_string(),
            output_name: String::new(),
            existing_file_mode: ExportExistingFileMode::Overwrite,
            rename_rule: ExportRenameRule::Filename,
            custom_name: String::new(),
            start_number: 1,
            extension_case: ExportExtensionCase::Lower,
        }
    }

    fn test_targets() -> ExportTargets {
        ExportTargets {
            width: 1280,
            height: 720,
            fps: 30.0,
            pix_fmt: "yuv420p",
            audio_sample_rate: 48000,
            audio_channel_layout: "stereo",
        }
    }

    #[test]
    fn merge_graph_concats_audio_when_all_clips_have_audio() {
        let clips = vec![test_clip(true, 1920, 1080), test_clip(true, 1280, 720)];
        let (graph, has_audio, _) = build_merge_filter_complex(
            &clips,
            &test_targets(),
            true,
            &ExportVideoEncoder::software(),
        );
        assert!(has_audio);
        assert!(graph.ends_with("[0v][0a][1v][1a]concat=n=2:v=1:a=1[v][a]"));
        assert!(graph
            .contains("[0:a:0]atrim=start=0:end=10.000000,aresample=48000:async=1:first_pts=0"));
        assert!(graph.contains("channel_layouts=stereo"));
        assert!(graph.contains("setpts=PTS-STARTPTS"));
        assert!(graph.contains(
            "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2"
        ));
        assert!(graph.contains("fps=30.000000"));
        assert!(graph.contains("format=yuv420p"));
    }

    #[test]
    fn merge_graph_trims_each_input_to_its_duration_from_zero() {
        let mut clip = test_clip(true, 1920, 1080);
        clip.start_us = 3_500_000;
        clip.dur_us = 2_000_000;
        let (graph, has_audio, _) = build_merge_filter_complex(
            &[clip],
            &test_targets(),
            true,
            &ExportVideoEncoder::software(),
        );
        assert!(has_audio);
        // The input-side `-ss` resets each stream's PTS to 0, so trim keeps the first
        // `dur` seconds rather than trimming on absolute source PTS.
        assert!(graph.contains("[0:v:0]trim=start=0:end=2.000000"));
        assert!(graph.contains("[0:a:0]atrim=start=0:end=2.000000"));
        assert!(!graph.contains("trim=start=3.500000"));
    }

    #[test]
    fn merge_graph_uses_requested_sample_rate_and_channels() {
        let clips = vec![test_clip(true, 1920, 1080)];
        let targets = ExportTargets {
            audio_sample_rate: 44100,
            audio_channel_layout: "mono",
            ..test_targets()
        };
        let (graph, has_audio, _) =
            build_merge_filter_complex(&clips, &targets, true, &ExportVideoEncoder::software());
        assert!(has_audio);
        assert!(graph.contains("aresample=44100:async=1:first_pts=0"));
        assert!(graph.contains("channel_layouts=mono"));
    }

    #[test]
    fn audio_only_merge_graph_never_references_video_streams() {
        let clips = vec![test_clip(true, 1920, 1080), test_clip(true, 1280, 720)];
        let graph = build_audio_merge_filter_complex(&clips, 44100, "stereo");
        assert!(graph.contains("[0:a:0]atrim=start=0:end=10.000000"));
        assert!(graph.contains("aresample=44100:async=1:first_pts=0"));
        assert!(graph.ends_with("[0a][1a]concat=n=2:v=0:a=1[a]"));
        assert!(!graph.contains(":v:"));
        assert!(!graph.contains("scale="));
    }

    #[test]
    fn export_validation_requires_a_track_and_enforces_audio_containers() {
        let mut options = options_with(ExportContainer::Mp4H264);
        options.include_video = false;
        options.include_audio = false;
        assert!(validate_export_options(&options)
            .unwrap_err()
            .is(ErrorCode::ExportOptionsInvalid));

        let mut mp3 = options_with(ExportContainer::Mp3Audio);
        mp3.include_video = false;
        mp3.audio_codec = ExportAudioCodec::Mp3;
        assert!(validate_export_options(&mp3).is_ok());
        mp3.include_video = true;
        assert!(validate_export_options(&mp3)
            .unwrap_err()
            .is(ErrorCode::ExportOptionsInvalid));

        let mut aac = options_with(ExportContainer::AacAudio);
        aac.include_video = false;
        aac.audio_codec = ExportAudioCodec::Mp3;
        assert!(validate_export_options(&aac)
            .unwrap_err()
            .is(ErrorCode::ExportOptionsInvalid));
        aac.audio_codec = ExportAudioCodec::Aac;
        assert!(validate_export_options(&aac).is_ok());
    }

    #[test]
    fn audio_channel_layout_maps_surround() {
        assert_eq!(audio_channel_layout(ExportAudioChannels::Stereo), "stereo");
        assert_eq!(audio_channel_layout(ExportAudioChannels::Mono), "mono");
        assert_eq!(
            audio_channel_layout(ExportAudioChannels::FivePointOne),
            "5.1"
        );
    }

    #[test]
    fn merge_graph_uses_five_point_one_layout() {
        let clips = vec![test_clip(true, 1920, 1080)];
        let targets = ExportTargets {
            audio_channel_layout: "5.1",
            ..test_targets()
        };
        let (graph, has_audio, _) =
            build_merge_filter_complex(&clips, &targets, true, &ExportVideoEncoder::software());
        assert!(has_audio);
        assert!(graph.contains("channel_layouts=5.1"));
    }

    #[test]
    fn merge_targets_prefer_explicit_sample_rate() {
        let clips = vec![test_clip(true, 1920, 1080)];
        let mut options = options_with(ExportContainer::Mp4H264);
        options.audio_sample_rate_hz = Some(44100);
        let targets = plan_merge_targets(&clips, &options).expect("targets");
        assert_eq!(targets.audio_sample_rate, 44100);
        options.audio_sample_rate_hz = None;
        let targets = plan_merge_targets(&clips, &options).expect("targets");
        assert_eq!(targets.audio_sample_rate, 48000);
    }

    #[test]
    fn merge_graph_drops_audio_when_a_clip_lacks_audio() {
        let clips = vec![test_clip(true, 1920, 1080), test_clip(false, 1280, 720)];
        let (graph, has_audio, _) = build_merge_filter_complex(
            &clips,
            &test_targets(),
            true,
            &ExportVideoEncoder::software(),
        );
        assert!(!has_audio);
        assert!(graph.ends_with("[0v][1v]concat=n=2:v=1:a=0[v]"));
        assert!(!graph.contains("[0:a:0]"));
    }

    #[test]
    fn merge_graph_ignores_audio_when_disabled() {
        let clips = vec![test_clip(true, 1920, 1080)];
        let (graph, has_audio, _) = build_merge_filter_complex(
            &clips,
            &test_targets(),
            false,
            &ExportVideoEncoder::software(),
        );
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
        assert_eq!(export_extension(ExportContainer::Mp3Audio), "mp3");
        assert_eq!(export_extension(ExportContainer::AacAudio), "aac");
    }

    #[test]
    fn encoder_args_include_container_specific_flags() {
        let mut args = Vec::new();
        append_video_encode_args(
            &mut args,
            &options_with(ExportContainer::Mp4H264),
            &ExportVideoEncoder::software(),
        );
        assert!(args.iter().any(|arg| arg == "libx264"));
        assert!(args.iter().any(|arg| arg == "+faststart"));

        let mut webm_args = Vec::new();
        append_video_encode_args(
            &mut webm_args,
            &options_with(ExportContainer::WebmVp9),
            &ExportVideoEncoder::software(),
        );
        assert!(webm_args.iter().any(|arg| arg == "libvpx-vp9"));
        assert!(webm_args.iter().any(|arg| arg == "-row-mt"));
        assert!(webm_args.iter().any(|arg| arg == "0"));
        assert!(webm_args.iter().any(|arg| arg == "-deadline"));

        let mut prores_args = Vec::new();
        append_video_encode_args(
            &mut prores_args,
            &options_with(ExportContainer::MovProres),
            &ExportVideoEncoder::software(),
        );
        assert!(prores_args.iter().any(|arg| arg == "prores_ks"));
        assert!(prores_args.iter().any(|arg| arg == "yuv422p10le"));
    }

    #[test]
    fn hardware_encoder_args_match_the_selected_backend() {
        let qsv = ExportVideoEncoder {
            kind: ExportVideoEncoderKind::QuickSync,
            vaapi_device: None,
        };
        let mut args = Vec::new();
        append_video_encode_args(&mut args, &options_with(ExportContainer::Mp4H264), &qsv);
        assert!(args.iter().any(|arg| arg == "h264_qsv"));
        assert!(args.iter().any(|arg| arg == "-global_quality"));
        assert!(args.iter().any(|arg| arg == "nv12"));
        assert!(!args.iter().any(|arg| arg == "libx264"));

        let vaapi = ExportVideoEncoder {
            kind: ExportVideoEncoderKind::Vaapi,
            vaapi_device: Some("/dev/dri/renderD128".to_string()),
        };
        let mut vaapi_args = Vec::new();
        append_video_encode_args(
            &mut vaapi_args,
            &options_with(ExportContainer::Mp4Hevc),
            &vaapi,
        );
        assert!(vaapi_args.iter().any(|arg| arg == "hevc_vaapi"));
        assert!(vaapi_args.iter().any(|arg| arg == "vaapi"));
    }

    #[test]
    fn individual_export_uses_fast_accurate_input_seek() {
        let mut clip = test_clip(true, 1920, 1080);
        clip.start_us = 3_500_000;
        let mut args = Vec::new();
        append_individual_input_args(&mut args, &clip);
        let seek_index = args.iter().position(|arg| arg == "-ss").unwrap();
        let input_index = args.iter().position(|arg| arg == "-i").unwrap();
        assert!(seek_index < input_index);
        assert_eq!(args[seek_index + 1], "3.500000");
        assert!(args.iter().any(|arg| arg == "-accurate_seek"));
    }

    #[test]
    fn parallelism_scales_with_cpu_and_hardware_capacity() {
        assert_eq!(planned_individual_export_parallelism(2, false, true, 60), 1);
        assert_eq!(planned_individual_export_parallelism(8, false, true, 60), 2);
        assert_eq!(
            planned_individual_export_parallelism(16, false, true, 60),
            3
        );
        assert_eq!(
            planned_individual_export_parallelism(32, false, true, 60),
            4
        );
        assert_eq!(planned_individual_export_parallelism(2, true, true, 60), 1);
        assert_eq!(planned_individual_export_parallelism(8, true, true, 60), 2);
        assert_eq!(planned_individual_export_parallelism(16, true, true, 60), 3);
        assert_eq!(planned_individual_export_parallelism(16, true, true, 2), 2);
        assert_eq!(
            planned_individual_export_parallelism(8, false, false, 60),
            4
        );
    }

    #[test]
    fn vaapi_merge_graph_uploads_software_frames() {
        let encoder = ExportVideoEncoder {
            kind: ExportVideoEncoderKind::Vaapi,
            vaapi_device: Some("/dev/dri/renderD128".to_string()),
        };
        let (graph, _, video_label) = build_merge_filter_complex(
            &[test_clip(true, 1920, 1080)],
            &test_targets(),
            true,
            &encoder,
        );
        assert!(graph.contains("[v]format=nv12,hwupload[encoded_v]"));
        assert_eq!(video_label, "encoded_v");
    }

    #[test]
    fn encoder_listing_match_is_exact() {
        let encoders = " V....D h264_nvenc NVIDIA NVENC H.264 encoder\n V..... h264_qsv Intel QSV";
        assert!(encoder_is_listed(encoders, "h264_nvenc"));
        assert!(encoder_is_listed(encoders, "h264_qsv"));
        assert!(!encoder_is_listed(encoders, "h264"));
        assert!(hardware_encoder_candidates(ExportContainer::WebmVp9).is_empty());
    }

    #[test]
    fn audio_encode_args_use_selected_codec() {
        let mut mp4 = Vec::new();
        append_audio_encode_args(&mut mp4, &options_with(ExportContainer::Mp4H264), true);
        assert!(mp4.iter().any(|arg| arg == "aac"));
        assert!(mp4.iter().any(|arg| arg == "192k"));
        assert!(!mp4.iter().any(|arg| arg == "-ar"));

        let mut mp2_options = options_with(ExportContainer::Mp4H264);
        mp2_options.audio_codec = ExportAudioCodec::Mp2;
        let mut mp2 = Vec::new();
        append_audio_encode_args(&mut mp2, &mp2_options, true);
        assert!(mp2.iter().any(|arg| arg == "mp2"));

        let mut mp3_options = options_with(ExportContainer::MovProres);
        mp3_options.audio_codec = ExportAudioCodec::Mp3;
        mp3_options.audio_bitrate_kbps = 448;
        let mut mp3 = Vec::new();
        append_audio_encode_args(&mut mp3, &mp3_options, true);
        assert!(mp3.iter().any(|arg| arg == "libmp3lame"));
        assert!(mp3.iter().any(|arg| arg == "320k"));

        let mut opus_options = options_with(ExportContainer::WebmVp9);
        opus_options.audio_codec = ExportAudioCodec::Opus;
        let mut opus = Vec::new();
        append_audio_encode_args(&mut opus, &opus_options, true);
        assert!(opus.iter().any(|arg| arg == "libopus"));

        let mut rated_options = options_with(ExportContainer::Mp4H264);
        rated_options.audio_sample_rate_hz = Some(44100);
        let mut rated = Vec::new();
        append_audio_encode_args(&mut rated, &rated_options, true);
        assert!(rated.iter().any(|arg| arg == "-ar"));
        assert!(rated.iter().any(|arg| arg == "44100"));

        let mut none = Vec::new();
        append_audio_encode_args(&mut none, &options_with(ExportContainer::Mp4H264), false);
        assert!(none.iter().any(|arg| arg == "-an"));
    }

    #[test]
    fn validation_rejects_codec_container_mismatch() {
        let mut options = options_with(ExportContainer::WebmVp9);
        options.audio_codec = ExportAudioCodec::Aac;
        assert!(validate_export_options(&options).is_err());
        options.audio_codec = ExportAudioCodec::Opus;
        assert!(validate_export_options(&options).is_ok());

        let mut options = options_with(ExportContainer::Mp4H264);
        options.audio_codec = ExportAudioCodec::Opus;
        assert!(validate_export_options(&options).is_err());
        options.audio_codec = ExportAudioCodec::Mp3;
        assert!(validate_export_options(&options).is_ok());

        let mut options = options_with(ExportContainer::Mp4H264);
        options.audio_sample_rate_hz = Some(4000);
        assert!(validate_export_options(&options).is_err());
        options.audio_sample_rate_hz = Some(48000);
        assert!(validate_export_options(&options).is_ok());
    }
}
