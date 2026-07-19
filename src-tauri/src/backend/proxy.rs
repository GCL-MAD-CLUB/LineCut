use super::*;

pub(crate) fn proxy_output_path(
    project: &Project,
    preferences: &Preferences,
    options: &ProxyOptions,
) -> AppResult<PathBuf> {
    let output_dir = match options.location {
        ProxyLocation::SourceProxyFolder => {
            let source_path = PathBuf::from(&project.asset.path);
            source_path
                .parent()
                .map(|parent| parent.join("Proxy"))
                .unwrap_or_else(|| PathBuf::from(&project.cache_dir).join("Proxy"))
        }
        ProxyLocation::Custom => {
            let trimmed = options.custom_location.trim();
            if trimmed.is_empty() {
                return Err(app_error(
                    ErrorCode::ProxyOutputRequired,
                    "Proxy output directory is empty",
                ));
            }
            PathBuf::from(trimmed)
        }
        ProxyLocation::PreferencesCache => {
            configured_cache_root(preferences).join(&project.asset.fingerprint)
        }
    };

    let source_stem = Path::new(&project.asset.file_name)
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "media".to_string());
    let stem = safe_component(&format!("{source_stem}_Proxy"));
    Ok(output_dir.join(format!("{stem}.{}", proxy_extension(options.preset))))
}

pub(crate) fn proxy_extension(preset: ProxyPreset) -> &'static str {
    match preset {
        ProxyPreset::H264Mp4 | ProxyPreset::H264Mp4AllIntra => "mp4",
        ProxyPreset::H264Quicktime => "mov",
        ProxyPreset::Vp8Webm | ProxyPreset::Vp9Webm => "webm",
    }
}

pub(crate) fn proxy_video_filter(options: &ProxyOptions) -> AppResult<Option<String>> {
    let filter = match options.frame_size {
        ProxyFrameSize::Full => Some("scale=trunc(iw/2)*2:trunc(ih/2)*2".to_string()),
        ProxyFrameSize::Half => Some("scale=trunc(iw/4)*2:-2".to_string()),
        ProxyFrameSize::Quarter => Some("scale=trunc(iw/8)*2:-2".to_string()),
        ProxyFrameSize::Custom => {
            let width = proxy_custom_width(options);
            let height = proxy_custom_height(options);
            if width < 2 || height < 2 {
                return Err(app_error(
                    ErrorCode::ProxyDimensionsInvalid,
                    "Custom proxy dimensions must be at least 2 pixels",
                ));
            }
            Some(format!(
                "scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
            ))
        }
    };

    match options.watermark {
        ProxyWatermark::None => Ok(filter),
    }
}

pub(crate) fn proxy_custom_width(options: &ProxyOptions) -> i64 {
    even_proxy_dimension(options.custom_width)
}

pub(crate) fn proxy_custom_height(options: &ProxyOptions) -> i64 {
    even_proxy_dimension(options.custom_height)
}

pub(crate) fn even_proxy_dimension(value: i64) -> i64 {
    let value = value.max(2);
    if value % 2 == 0 {
        value
    } else {
        (value - 1).max(2)
    }
}

pub(crate) fn append_proxy_preset_args(
    args: &mut Vec<String>,
    preset: ProxyPreset,
    watermark: ProxyWatermark,
) {
    match watermark {
        ProxyWatermark::None => {}
    }

    match preset {
        ProxyPreset::H264Mp4 => push_args(
            args,
            &[
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-tune",
                "fastdecode",
                "-crf",
                "23",
                "-g",
                "15",
                "-keyint_min",
                "15",
                "-sc_threshold",
                "0",
                "-bf",
                "0",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
            ],
        ),
        ProxyPreset::H264Mp4AllIntra => push_args(
            args,
            &[
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-tune",
                "fastdecode",
                "-crf",
                "23",
                "-g",
                "1",
                "-keyint_min",
                "1",
                "-sc_threshold",
                "0",
                "-bf",
                "0",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
            ],
        ),
        ProxyPreset::H264Quicktime => push_args(
            args,
            &[
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-tune",
                "fastdecode",
                "-crf",
                "23",
                "-g",
                "15",
                "-keyint_min",
                "15",
                "-sc_threshold",
                "0",
                "-bf",
                "0",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
            ],
        ),
        ProxyPreset::Vp8Webm => push_args(
            args,
            &[
                "-c:v",
                "libvpx",
                "-deadline",
                "realtime",
                "-cpu-used",
                "8",
                "-b:v",
                "1M",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "libopus",
                "-b:a",
                "96k",
            ],
        ),
        ProxyPreset::Vp9Webm => push_args(
            args,
            &[
                "-c:v",
                "libvpx-vp9",
                "-deadline",
                "realtime",
                "-cpu-used",
                "8",
                "-row-mt",
                "1",
                "-crf",
                "34",
                "-b:v",
                "0",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "libopus",
                "-b:a",
                "96k",
            ],
        ),
    }
}

pub(crate) fn push_args(args: &mut Vec<String>, values: &[&str]) {
    args.extend(values.iter().map(|value| value.to_string()));
}
