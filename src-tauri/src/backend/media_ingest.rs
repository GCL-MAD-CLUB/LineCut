use super::*;

#[tauri::command]
pub(crate) async fn register_import_media(
    path: String,
    task_id: String,
    asset_id: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<ImportResult> {
    let task = register_task(&task_id, state.inner())?;
    let preferences = preferences_clone(&state)?;
    let input_path = PathBuf::from(&path);
    if !input_path.exists() {
        return Err(app_error(
            ErrorCode::MediaNotFound,
            format!("Media file does not exist: {path}"),
        ));
    }

    emit_ffmpeg_progress(&app, &task_id, 0.0);
    let probe = probe_media(
        &input_path,
        &preferences,
        state.inner(),
        &task_id,
        task.cancel_token(),
    )
    .await?;
    task.check_cancelled()?;
    emit_ffmpeg_progress(&app, &task_id, 0.04);

    let identity_path = input_path.clone();
    let (meta, modified_at, fingerprint) =
        spawn_blocking_cancellable(task.cancel_token(), "read media file", move |cancel| {
            let meta = fs::metadata(&identity_path).map_err(|error| {
                app_error(
                    ErrorCode::MediaReadFailed,
                    format!(
                        "Failed to read media metadata for {}: {error}",
                        identity_path.display()
                    ),
                )
            })?;
            let modified_at = modified_secs(&meta);
            let fingerprint = fingerprint_file(&identity_path, &meta, modified_at, cancel)?;
            Ok((meta, modified_at, fingerprint))
        })
        .await?;
    let cache_dir = configured_cache_root(&preferences).join(&fingerprint);
    emit_ffmpeg_progress(&app, &task_id, 0.08);
    let proxy_path = cache_dir.join(PROXY_FILE_NAME);
    let proxy_path_str = if proxy_path.exists() {
        Some(proxy_path.to_string_lossy().into_owned())
    } else {
        None
    };

    let duration_us = probe
        .format
        .as_ref()
        .and_then(|f| f.duration.as_deref())
        .map(parse_decimal_seconds_to_us)
        .unwrap_or(0);
    let start_time_us = probe
        .format
        .as_ref()
        .and_then(|f| f.start_time.as_deref())
        .map(parse_decimal_seconds_to_us)
        .unwrap_or(0);
    let tape_name = probe_tape_name(&probe);

    let video_stream_index = probe
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"))
        .map(|s| s.index);
    let audio_stream_index = probe
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"))
        .map(|s| s.index);

    let asset = MediaAsset {
        id: asset_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        file_name: input_path
            .file_name()
            .map(|v| v.to_string_lossy().into_owned())
            .unwrap_or_else(|| "media".to_string()),
        path: path.clone(),
        file_size: meta.len() as i64,
        modified_at,
        fingerprint,
        duration_us,
        start_time_us,
        tape_name,
        video_stream_index,
        audio_stream_index,
    };

    let streams = probe
        .streams
        .iter()
        .map(|stream| MediaStream {
            index: stream.index,
            codec_type: stream.codec_type.clone().unwrap_or_default(),
            codec_name: stream.codec_name.clone().unwrap_or_default(),
            avg_frame_rate: stream.avg_frame_rate.clone(),
            r_frame_rate: stream.r_frame_rate.clone(),
            sample_aspect_ratio: stream.sample_aspect_ratio.clone(),
            sample_rate: stream.sample_rate.clone(),
            channel_layout: stream.channel_layout.clone(),
            language: tag_value(&stream.tags, &["language", "LANGUAGE"]),
            title: tag_value(&stream.tags, &["title", "TITLE"]),
            width: stream.width,
            height: stream.height,
            channels: stream.channels,
            disposition: stream.disposition.clone(),
        })
        .collect::<Vec<_>>();

    let project = Project {
        asset,
        streams,
        tracks: Vec::new(),
        cues: HashMap::new(),
        cache_dir: cache_dir.to_string_lossy().into_owned(),
        proxy_path: proxy_path_str,
    };
    task.check_cancelled()?;
    state
        .projects
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::ProjectStateUnavailable,
                "Project state lock is poisoned",
            )
        })?
        .insert(project.asset.id.clone(), project.clone());
    Ok(ImportResult {
        project,
        warnings: Vec::new(),
    })
}

#[tauri::command]
pub(crate) async fn analyze_imported_media(
    asset_id: String,
    task_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<ImportResult> {
    const SUBTITLE_PROGRESS_START: f64 = 0.0;
    const SUBTITLE_PROGRESS_END: f64 = 0.54;
    const COVER_PROGRESS_START: f64 = 0.54;
    const COVER_PROGRESS_END: f64 = 0.99;
    let task = register_task(&task_id, state.inner())?;
    let preferences = preferences_clone(&state)?;
    let source = project_clone(&asset_id, &state)?;
    let path = source.asset.path.clone();
    let input_path = PathBuf::from(&path);
    let mut tracks = Vec::new();
    let mut cues: HashMap<String, Vec<SubtitleCue>> = HashMap::new();
    let mut warnings = Vec::new();
    let text_subtitle_total = source
        .streams
        .iter()
        .filter(|stream| {
            stream.codec_type == "subtitle" && is_text_subtitle_codec(&stream.codec_name)
        })
        .count()
        .max(1);
    let mut text_subtitle_index = 0usize;

    for stream in source.streams.iter().filter(|s| s.codec_type == "subtitle") {
        let codec = stream.codec_name.clone();
        let track_id = Uuid::new_v4().to_string();
        let kind = if is_text_subtitle_codec(&codec) {
            SubtitleKind::Text
        } else {
            SubtitleKind::Bitmap
        };
        let mut track = SubtitleTrack {
            id: track_id.clone(),
            asset_id: source.asset.id.clone(),
            source_type: SubtitleSourceType::Embedded,
            stream_index: Some(stream.index),
            source_path: None,
            codec: codec.clone(),
            language: stream.language.clone(),
            title: stream.title.clone(),
            kind,
            offset_us: 0,
            cue_count: 0,
            warning: None,
        };

        if is_text_subtitle_codec(&codec) {
            let current_subtitle = text_subtitle_index + 1;
            text_subtitle_index += 1;
            let subtitle_progress_start = SUBTITLE_PROGRESS_START
                + (current_subtitle - 1) as f64 * (SUBTITLE_PROGRESS_END - SUBTITLE_PROGRESS_START)
                    / text_subtitle_total as f64;
            let subtitle_progress_end = SUBTITLE_PROGRESS_START
                + current_subtitle as f64 * (SUBTITLE_PROGRESS_END - SUBTITLE_PROGRESS_START)
                    / text_subtitle_total as f64;
            emit_ffmpeg_progress(&app, &task_id, subtitle_progress_start);
            match parse_embedded_subtitle_async(
                &input_path,
                stream.index,
                &codec,
                &track_id,
                &preferences,
                state.inner(),
                &task_id,
                task.cancel_token(),
            )
            .await
            {
                Ok(parsed) => {
                    track.cue_count = parsed.len();
                    cues.insert(track_id.clone(), parsed);
                }
                Err(error) => {
                    if error.is(ErrorCode::TaskCancelled) {
                        return Err(error);
                    }
                    let message = format!("字幕流 {} 解析失败", stream.index);
                    track.warning = Some(message.clone());
                    warnings.push(UserNotice::warning_with_detail(
                        "EMBEDDED_SUBTITLE_PARSE_FAILED",
                        message,
                        error.detail(),
                    ));
                }
            }
            emit_ffmpeg_progress(&app, &task_id, subtitle_progress_end);
        } else {
            let message = format!(
                "字幕流 {} 是图像字幕({codec})，当前版本暂不支持台词浏览",
                stream.index
            );
            track.warning = Some(message.clone());
            warnings.push(UserNotice::warning("BITMAP_SUBTITLE_UNSUPPORTED", message));
        }

        tracks.push(track);
        task.check_cancelled()?;
    }

    if tracks.is_empty() {
        warnings.push(UserNotice::warning(
            "SUBTITLE_STREAM_NOT_FOUND",
            format!(
                "未检测到字幕流：{}",
                Path::new(&path)
                    .file_name()
                    .and_then(|v| v.to_str())
                    .unwrap_or_default()
            ),
        ));
    }

    let project = Project {
        tracks,
        cues,
        ..source.clone()
    };
    task.check_cancelled()?;
    emit_ffmpeg_progress(&app, &task_id, SUBTITLE_PROGRESS_END);
    if let Some(stream_index) = project.asset.video_stream_index {
        let progress_app = app.clone();
        let cover_task_id = task_id.clone();
        let cover_progress = move |progress: f64| {
            emit_ffmpeg_progress(
                &progress_app,
                &cover_task_id,
                COVER_PROGRESS_START + progress * (COVER_PROGRESS_END - COVER_PROGRESS_START),
            );
        };
        if let Err(error) = ensure_video_cover_thumbnail(
            &project,
            &preferences,
            Some(task.cancel_token()),
            Some(&cover_progress),
            stream_index,
        )
        .await
        {
            if error.is(ErrorCode::TaskCancelled) {
                return Err(error);
            }
            warnings.push(UserNotice::warning_with_detail(
                "VIDEO_COVER_ANALYSIS_FAILED",
                format!("视频封面分析失败：{}", project.asset.file_name),
                error.detail(),
            ));
        }
    }
    task.check_cancelled()?;
    emit_ffmpeg_progress(&app, &task_id, COVER_PROGRESS_END);
    {
        let mut projects = state.projects.lock().map_err(|_| {
            app_error(
                ErrorCode::ProjectStateUnavailable,
                "Project state lock is poisoned",
            )
        })?;
        if let Some(current) = projects.get_mut(&asset_id) {
            if current.asset.path == source.asset.path
                && current.asset.fingerprint == source.asset.fingerprint
            {
                for track in &project.tracks {
                    if !current.tracks.iter().any(|existing| {
                        matches!(existing.source_type, SubtitleSourceType::Embedded)
                            && existing.stream_index == track.stream_index
                    }) {
                        current.tracks.push(track.clone());
                        if let Some(cues) = project.cues.get(&track.id) {
                            current.cues.insert(track.id.clone(), cues.clone());
                        }
                    }
                }
            }
        }
    }
    emit_ffmpeg_progress(&app, &task_id, 1.0);
    Ok(ImportResult { project, warnings })
}

/// Existing replacement/relink callers retain their synchronous analysis contract.
#[tauri::command]
pub(crate) async fn import_media(
    path: String,
    task_id: String,
    asset_id: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<ImportResult> {
    let registered =
        register_import_media(path, task_id.clone(), asset_id, app.clone(), state.clone()).await?;
    analyze_imported_media(registered.project.asset.id, task_id, app, state).await
}
