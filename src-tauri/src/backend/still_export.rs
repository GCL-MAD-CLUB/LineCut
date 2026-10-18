//! Original-resolution still export; proxy paths never enter this pipeline.
use super::*;
use serde::{Deserialize, Serialize};

static STILL_EXPORT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Default, Serialize, Deserialize)]
struct StillExportHistory {
    #[serde(default)]
    counters: HashMap<String, u64>,
    directory: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StillExportDefaults {
    name: String,
    directory: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StillExportOptions {
    media_name: String,
    timecode: String,
    name: String,
    automatic_name: bool,
    directory: String,
    format: StillFormat,
    frame: u64,
    frame_rate: f64,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StillFormat {
    Bmp,
    Dpx,
    Gif,
    Jpeg,
    Openexr,
    Png,
    Targa,
    Tiff,
}

impl StillFormat {
    fn encoding(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Bmp => ("bmp", "bmp", "bgr24"),
            Self::Dpx => ("dpx", "dpx", "gbrp10le"),
            Self::Gif => ("gif", "gif", "rgb8"),
            Self::Jpeg => ("jpg", "mjpeg", "yuvj444p"),
            Self::Openexr => ("exr", "exr", "gbrpf32le"),
            Self::Png => ("png", "png", "rgb24"),
            Self::Targa => ("tga", "targa", "bgr24"),
            Self::Tiff => ("tif", "tiff", "rgb24"),
        }
    }
}

fn history_path() -> PathBuf {
    config_root().join("StillExport.json")
}

fn read_history() -> AppResult<StillExportHistory> {
    match fs::read(history_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            app_error(
                ErrorCode::ExportOptionsInvalid,
                format!("Invalid still export history: {error}"),
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(StillExportHistory::default())
        }
        Err(error) => Err(app_error(
            ErrorCode::ExportWriteFailed,
            format!("Cannot read still export history: {error}"),
        )),
    }
}

fn write_history(history: &StillExportHistory) -> AppResult<()> {
    let path = history_path();
    let bytes = serde_json::to_vec(history).map_err(|error| {
        app_error(
            ErrorCode::ExportWriteFailed,
            format!("Cannot serialize still export history: {error}"),
        )
    })?;
    fs::create_dir_all(config_root()).map_err(|error| {
        app_error(
            ErrorCode::ExportWriteFailed,
            format!("Cannot create still export config directory: {error}"),
        )
    })?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes)
        .and_then(|()| fs::rename(&temporary, &path))
        .map_err(|error| {
            app_error(
                ErrorCode::ExportWriteFailed,
                format!("Cannot save still export history: {error}"),
            )
        })
}

fn media_name_component(name: &str) -> String {
    name.chars()
        .map(|ch| {
            if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim_end_matches(['.', ' '])
        .to_owned()
}

fn valid_timecode(timecode: &str) -> bool {
    let parts: Vec<_> = timecode.split('_').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|part| part.len() >= 2 && part.bytes().all(|ch| ch.is_ascii_digit()))
}

fn validate_timecode(timecode: &str) -> AppResult<()> {
    if !valid_timecode(timecode) {
        return Err(app_error(
            ErrorCode::ExportOptionsInvalid,
            "Invalid still timecode",
        ));
    }
    Ok(())
}

fn still_name(media_name: &str, timecode: &str, sequence: u64) -> String {
    format!(
        "{}.{}.Still{sequence:03}",
        media_name_component(media_name),
        timecode
    )
}

fn existing_sequence(directory: &Path, media_name: &str) -> AppResult<u64> {
    let prefix = format!("{}.", media_name_component(media_name).to_lowercase());
    let entries = fs::read_dir(directory).map_err(|error| {
        app_error(
            ErrorCode::ExportWriteFailed,
            format!("Cannot inspect still export directory: {error}"),
        )
    })?;
    let mut highest = 0;
    for entry in entries {
        let entry = entry.map_err(|error| {
            app_error(
                ErrorCode::ExportWriteFailed,
                format!("Cannot read still export directory entry: {error}"),
            )
        })?;
        let name = entry.file_name().to_string_lossy().to_lowercase();
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        let Some((timecode, sequence)) = rest.split_once(".still") else {
            continue;
        };
        if !valid_timecode(timecode) {
            continue;
        }
        let Some((digits, _extension)) = sequence.split_once('.') else {
            continue;
        };
        if let Ok(sequence) = digits.parse::<u64>() {
            highest = highest.max(sequence);
        }
    }
    Ok(highest)
}

fn next_sequence(
    history: &StillExportHistory,
    directory: &Path,
    media_name: &str,
) -> AppResult<u64> {
    history
        .counters
        .get(&media_name_component(media_name).to_lowercase())
        .copied()
        .unwrap_or(0)
        .max(existing_sequence(directory, media_name)?)
        .checked_add(1)
        .ok_or_else(|| {
            app_error(
                ErrorCode::ExportOptionsInvalid,
                "Still export sequence exhausted",
            )
        })
}

#[tauri::command]
pub(crate) async fn still_export_defaults(
    media_name: String,
    timecode: String,
    directory: Option<String>,
    app: tauri::AppHandle,
) -> CommandResult<StillExportDefaults> {
    validate_timecode(&timecode)?;
    let _guard = STILL_EXPORT_LOCK.lock().await;
    let history = read_history()?;
    let selected_directory = directory
        .or(history.directory.clone())
        .filter(|path| Path::new(path).is_dir())
        .map(PathBuf::from);
    let directory = match selected_directory {
        Some(directory) => directory,
        None => app.path().desktop_dir().map_err(|error| {
            app_error(
                ErrorCode::ExportDestinationResolveFailed,
                format!("Cannot resolve Desktop: {error}"),
            )
        })?,
    };
    Ok(StillExportDefaults {
        name: still_name(
            &media_name,
            &timecode,
            next_sequence(&history, &directory, &media_name)?,
        ),
        directory: directory.to_string_lossy().into_owned(),
    })
}

fn validate_output_name(name: &str) -> AppResult<()> {
    let reserved = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.is_empty()
        || name != name.trim()
        || name.ends_with('.')
        || name
            .chars()
            .any(|ch| ch.is_control() || "<>:\"/\\|?*".contains(ch))
        || ["CON", "PRN", "AUX", "NUL"].contains(&reserved.as_str())
        || (reserved.len() == 4
            && (reserved.starts_with("COM") || reserved.starts_with("LPT"))
            && matches!(reserved.as_bytes()[3], b'1'..=b'9'))
    {
        return Err(app_error(
            ErrorCode::ExportOptionsInvalid,
            "Invalid still output filename",
        ));
    }
    Ok(())
}

fn still_ffmpeg_args(
    asset: &MediaAsset,
    options: &StillExportOptions,
    output: &Path,
) -> Vec<String> {
    let (_, codec, pixel_format) = options.format.encoding();
    // Seek just before the requested frame boundary. Accurate input seeking
    // discards the previous frame while avoiding rational-rate rounding ahead.
    let seek_seconds = (options.frame as f64 - 0.25).max(0.0) / options.frame_rate;
    let mut args = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
        "-n".into(),
    ];
    append_ffmpeg_processing_thread_args(&mut args, ffmpeg_worker_thread_budget(1));
    args.extend([
        "-ss".into(),
        format!("{seek_seconds:.9}"),
        "-i".into(),
        asset.path.clone(),
        "-map".into(),
        format!("0:{}", asset.video_stream_index.unwrap_or(0)),
        "-frames:v".into(),
        "1".into(),
        "-an".into(),
        "-sn".into(),
        "-dn".into(),
        "-c:v".into(),
        codec.into(),
        "-pix_fmt".into(),
        pixel_format.into(),
    ]);
    if matches!(options.format, StillFormat::Jpeg) {
        args.extend(["-q:v".into(), "2".into()]);
    }
    append_ffmpeg_video_output_thread_args(&mut args, ffmpeg_worker_thread_budget(1));
    // Explicit image2 avoids interpreting percent signs in editable filenames
    // as a sequence and writes exactly one image (including a single-frame GIF).
    args.extend([
        "-f".into(),
        "image2".into(),
        "-update".into(),
        "1".into(),
        output.to_string_lossy().into_owned(),
    ]);
    args
}

#[tauri::command]
pub(crate) async fn export_still_frame(
    asset_id: String,
    options: StillExportOptions,
    task_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<String> {
    let task = register_task(&task_id, state.inner())?;
    let asset = project_clone(&asset_id, &state)?.asset;
    let preferences = preferences_clone(&state)?;
    validate_timecode(&options.timecode)?;
    if !options.frame_rate.is_finite()
        || options.frame_rate <= 0.0
        || options.frame_rate > 1000.0
        || asset.video_stream_index.is_none()
        || (options.frame as f64 / options.frame_rate) * 1_000_000.0 >= asset.duration_us as f64
    {
        return Err(app_error(
            ErrorCode::ExportOptionsInvalid,
            "Invalid still export frame",
        ));
    }
    if !Path::new(&asset.path).is_file() {
        return Err(app_error(
            ErrorCode::MediaNotFound,
            "Original media is offline; cannot export a proxy still",
        ));
    }
    let directory = fs::canonicalize(&options.directory).map_err(|error| {
        app_error(
            ErrorCode::ExportWriteFailed,
            format!("Cannot resolve still export directory: {error}"),
        )
    })?;
    if !directory.is_dir() {
        return Err(app_error(
            ErrorCode::ExportOptionsInvalid,
            "Still export destination must be a directory",
        ));
    }
    // Serialize allocation and completion, including dialogs on other monitors.
    let _guard = STILL_EXPORT_LOCK.lock().await;
    task.check_cancelled()?;
    let mut history = read_history()?;
    let sequence = next_sequence(&history, &directory, &options.media_name)?;
    let name = if options.automatic_name {
        still_name(&options.media_name, &options.timecode, sequence)
    } else {
        options.name.clone()
    };
    validate_output_name(&name)?;
    let (extension, _, _) = options.format.encoding();
    let output = directory.join(format!("{name}.{extension}"));
    if output.exists() {
        return Err(app_error(
            ErrorCode::ExportWriteFailed,
            "Still output already exists",
        ));
    }
    let temporary = directory.join(format!(
        ".locution-pro-still-{}.{}",
        Uuid::new_v4(),
        extension
    ));
    register_task_cleanup_paths(&task_id, std::slice::from_ref(&temporary), state.inner())?;
    emit_ffmpeg_progress(&app, &task_id, 0.0);
    let result = run_output_with_timeout(
        &ffmpeg_program(&preferences),
        &still_ffmpeg_args(&asset, &options, &temporary),
        state.inner(),
        &task_id,
        task.cancel_token(),
        Duration::from_secs(120),
    )
    .await;
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    let publish = (|| {
        task.check_cancelled()?;
        if fs::metadata(&temporary).map(|meta| meta.len()).unwrap_or(0) == 0 {
            return Err(app_error(
                ErrorCode::ExportWriteFailed,
                "Still encoder produced no image",
            ));
        }
        // create_new gives exclusive ownership even if another program writes
        // this name between the collision check and completion. Copy supports
        // destinations on file systems that do not support hard links.
        let mut destination = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|error| {
                app_error(
                    ErrorCode::ExportWriteFailed,
                    format!("Cannot create still output: {error}"),
                )
            })?;
        let copy = fs::File::open(&temporary)
            .and_then(|mut source| std::io::copy(&mut source, &mut destination))
            .and_then(|_| destination.sync_all());
        if let Err(error) = copy {
            drop(destination);
            let _ = fs::remove_file(&output);
            return Err(app_error(
                ErrorCode::ExportWriteFailed,
                format!("Cannot write still output: {error}"),
            ));
        }
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    publish?;
    history.counters.insert(
        media_name_component(&options.media_name).to_lowercase(),
        sequence,
    );
    history.directory = Some(directory.to_string_lossy().into_owned());
    if let Err(error) = write_history(&history) {
        let _ = fs::remove_file(&output);
        return Err(error);
    }
    emit_ffmpeg_progress(&app, &task_id, 1.0);
    Ok(output.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_asset(path: String) -> MediaAsset {
        MediaAsset {
            id: "original".into(),
            path,
            file_name: "original.mov".into(),
            file_size: 0,
            modified_at: 0,
            fingerprint: "test".into(),
            duration_us: 10_000_000,
            start_time_us: 0,
            tape_name: None,
            video_stream_index: Some(0),
            audio_stream_index: None,
        }
    }

    fn test_options(format: StillFormat) -> StillExportOptions {
        StillExportOptions {
            media_name: "renamed.mov".into(),
            timecode: "00_00_00_00".into(),
            name: "renamed.mov.00_00_00_00.Still001".into(),
            automatic_name: true,
            directory: String::new(),
            format,
            frame: 0,
            frame_rate: 24.0,
        }
    }

    #[test]
    fn frame_arguments_use_original_stream_and_preserve_resolution_at_rational_rates() {
        let mut asset = test_asset("C:/original.mov".into());
        asset.video_stream_index = Some(3);
        let mut options = test_options(StillFormat::Png);
        options.frame = 12345;
        options.frame_rate = 24000.0 / 1001.0;
        let args = still_ffmpeg_args(&asset, &options, Path::new("C:/still.png"));
        let option = |flag| args[args.iter().position(|arg| arg == flag).unwrap() + 1].clone();
        assert_eq!(option("-i"), "C:/original.mov");
        assert_eq!(option("-map"), "0:3");
        assert_eq!(option("-frames:v"), "1");
        let seek = option("-ss").parse::<f64>().unwrap();
        assert!(seek > (options.frame - 1) as f64 / options.frame_rate);
        assert!(seek < options.frame as f64 / options.frame_rate);
        assert!(!args
            .iter()
            .any(|arg| ["-vf", "-s", "-r"].contains(&arg.as_str())));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires real bundled FFmpeg; run manually to validate still image encoders"]
    fn bundled_encoders_write_all_eight_image_formats() {
        // A tiny bitmap fixture verifies encoder/muxer compatibility without
        // creating videos or exercising a video-rendering test pipeline.
        let ffmpeg =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("bin/ffmpeg-x86_64-pc-windows-msvc.exe");
        // CI only provides empty sidecars for compilation. An explicit manual
        // run must use the real binary and must never silently pass without it.
        assert!(
            fs::metadata(&ffmpeg).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0),
            "Manual still encoder validation requires the real bundled FFmpeg executable"
        );
        let directory =
            env::temp_dir().join(format!("locution-pro-still-encoders-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let input = directory.join("original.ppm");
        fs::write(
            &input,
            b"P6\n2 2\n255\n\xff\x00\x00\x00\xff\x00\x00\x00\xff\xff\xff\xff",
        )
        .unwrap();
        let asset = test_asset(input.to_string_lossy().into_owned());
        let formats = [
            StillFormat::Bmp,
            StillFormat::Dpx,
            StillFormat::Gif,
            StillFormat::Jpeg,
            StillFormat::Openexr,
            StillFormat::Png,
            StillFormat::Targa,
            StillFormat::Tiff,
        ];
        for format in formats {
            let (extension, _, _) = format.encoding();
            let output = directory.join(format!("still.{extension}"));
            // Use the production encoder arguments on the bitmap fixture.
            let mut command = StdCommand::new(&ffmpeg);
            #[cfg(windows)]
            command.creation_flags(CREATE_NO_WINDOW);
            let result = command
                .args(still_ffmpeg_args(&asset, &test_options(format), &output))
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{extension}: {}",
                String::from_utf8_lossy(&result.stderr)
            );
            assert!(fs::metadata(output).unwrap().len() > 16, "{extension}");
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn names_preserve_media_extension_and_share_a_counter_across_timecodes() {
        assert_eq!(
            still_name("片段.mov", "00_10_28_14", 3),
            "片段.mov.00_10_28_14.Still003"
        );
        assert_eq!(
            still_name("片段.mov", "00_00_00_00", 1),
            "片段.mov.00_00_00_00.Still001"
        );
        assert_eq!(
            still_name("片段.mov", "00_00_00_00", 1000),
            "片段.mov.00_00_00_00.Still1000"
        );
        assert_eq!(media_name_component("a/b:c.mov"), "a_b_c.mov");
    }

    #[test]
    fn output_names_cannot_escape_the_destination_or_use_device_names() {
        for name in [
            "../frame", "a\\frame", "frame.", "CON", "nul.png", "COM1", "",
        ] {
            assert!(validate_output_name(name).is_err(), "{name}");
        }
        assert!(validate_output_name("片段.mov.00_00_00_00.Still001").is_ok());
    }

    #[test]
    fn sequence_recovers_existing_stills_without_counting_other_media() {
        let directory = env::temp_dir().join(format!("locution-pro-still-test-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        for name in [
            "a.mov.00_00_00_00.Still001.png",
            "a.mov.00_10_00_00.Still009.exr",
            "b.mov.00_00_00_00.Still099.png",
        ] {
            fs::write(directory.join(name), b"image").unwrap();
        }
        let mut history = StillExportHistory::default();
        assert_eq!(next_sequence(&history, &directory, "a.mov").unwrap(), 10);
        assert_eq!(next_sequence(&history, &directory, "new.mov").unwrap(), 1);
        history.counters.insert("a.mov".into(), 14);
        assert_eq!(next_sequence(&history, &directory, "A.mov").unwrap(), 15);
        fs::remove_dir_all(directory).unwrap();
    }
}
