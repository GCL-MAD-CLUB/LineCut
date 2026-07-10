use super::*;

#[tauri::command]
pub(crate) fn get_preferences(state: tauri::State<'_, AppState>) -> Result<Preferences, String> {
    state
        .preferences
        .lock()
        .map_err(|_| "首选项状态锁定失败".to_string())
        .map(|preferences| preferences.clone())
}

#[tauri::command]
pub(crate) async fn update_preferences(
    preferences: Preferences,
    task_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Preferences, String> {
    let task = register_task(&task_id, state.inner())?;
    emit_ffmpeg_progress(&app, &task_id, 0.0);
    let cancel = task.cancel_token();
    let normalized = tokio::task::spawn_blocking(move || {
        ensure_not_cancelled(&cancel)?;
        let normalized = normalize_preferences(preferences)?;
        ensure_not_cancelled(&cancel)?;
        save_preferences(&normalized)?;
        ensure_not_cancelled(&cancel)?;
        Ok::<_, String>(normalized)
    })
    .await
    .map_err(|error| format!("保存首选项任务失败: {error}"))??;
    task.check_cancelled()?;
    *state
        .preferences
        .lock()
        .map_err(|_| "首选项状态锁定失败".to_string())? = normalized.clone();
    emit_ffmpeg_progress(&app, &task_id, 1.0);
    Ok(normalized)
}

#[tauri::command]
pub(crate) async fn cancel_task(
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let (found, processes, cleanup_paths) = take_task_for_cancellation(&task_id, state.inner())?;
    if !processes.is_empty() || !cleanup_paths.is_empty() {
        tokio::task::spawn_blocking(move || {
            stop_running_ffmpeg(processes);
            remove_cleanup_paths(&cleanup_paths);
        })
        .await
        .map_err(|error| format!("等待任务取消失败: {error}"))?;
    }
    Ok(found)
}

#[tauri::command]
pub(crate) async fn save_project_file(
    path: String,
    asset_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let project = match asset_id {
        Some(asset_id) => Some(project_clone(&asset_id, &state)?),
        None => None,
    };
    let normalized_path = normalize_project_path(&path)?;
    let output_path = normalized_path.clone();
    tokio::task::spawn_blocking(move || write_project_file(&output_path, project))
        .await
        .map_err(|error| format!("保存项目任务失败: {error}"))??;
    Ok(normalized_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) async fn open_project_file(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<OpenProjectResult, String> {
    let input_path = PathBuf::from(path);
    let read_path = input_path.clone();
    let document = tokio::task::spawn_blocking(move || read_project_file(&read_path))
        .await
        .map_err(|error| format!("打开项目任务失败: {error}"))??;
    let mut warnings = Vec::new();

    if let Some(project) = &document.project {
        let media_path = Path::new(&project.asset.path);
        if !media_path.is_file() {
            warnings.push(format!("项目引用的媒体文件不存在: {}", project.asset.path));
        } else if let Ok(metadata) = fs::metadata(media_path) {
            if metadata.len() as i64 != project.asset.file_size
                || modified_secs(&metadata) != project.asset.modified_at
            {
                warnings.push("源媒体自项目保存后已发生变化，导出前请确认内容正确".to_string());
            }
        }

        state
            .projects
            .lock()
            .map_err(|_| "项目状态锁定失败".to_string())?
            .insert(project.asset.id.clone(), project.clone());
    }

    Ok(OpenProjectResult {
        path: input_path.to_string_lossy().into_owned(),
        project: document.project,
        warnings,
    })
}

#[tauri::command]
pub(crate) fn close_project(
    asset_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let Some(asset_id) = asset_id else {
        return Ok(false);
    };
    Ok(state
        .projects
        .lock()
        .map_err(|_| "项目状态锁定失败".to_string())?
        .remove(&asset_id)
        .is_some())
}

#[tauri::command]
pub(crate) async fn import_media(
    path: String,
    external_subtitles: Vec<String>,
    task_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ImportResult, String> {
    let task = register_task(&task_id, state.inner())?;
    let preferences = preferences_clone(&state)?;
    let input_path = PathBuf::from(&path);
    if !input_path.exists() {
        return Err(format!("媒体文件不存在: {}", path));
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
        spawn_blocking_cancellable(task.cancel_token(), "读取媒体文件", move |cancel| {
            let meta =
                fs::metadata(&identity_path).map_err(|e| format!("读取媒体元数据失败: {e}"))?;
            let modified_at = modified_secs(&meta);
            let fingerprint = fingerprint_file(&identity_path, &meta, modified_at, cancel)?;
            Ok((meta, modified_at, fingerprint))
        })
        .await?;
    let cache_dir = configured_cache_root(&preferences).join(&fingerprint);
    let subtitle_cache_dir = cache_dir.join("subtitles");
    spawn_blocking_cancellable(task.cancel_token(), "创建缓存目录", move |_| {
        fs::create_dir_all(subtitle_cache_dir).map_err(|e| format!("创建缓存目录失败: {e}"))
    })
    .await?;
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
        id: Uuid::new_v4().to_string(),
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
            language: tag_value(&stream.tags, &["language", "LANGUAGE"]),
            title: tag_value(&stream.tags, &["title", "TITLE"]),
            width: stream.width,
            height: stream.height,
            channels: stream.channels,
            disposition: stream.disposition.clone(),
        })
        .collect::<Vec<_>>();

    let mut tracks = Vec::new();
    let mut cues: HashMap<String, Vec<SubtitleCue>> = HashMap::new();
    let mut warnings = Vec::new();
    let text_subtitle_total = probe
        .streams
        .iter()
        .filter(|stream| {
            stream.codec_type.as_deref() == Some("subtitle")
                && stream
                    .codec_name
                    .as_deref()
                    .is_some_and(is_text_subtitle_codec)
        })
        .count()
        .max(1);
    let mut text_subtitle_index = 0usize;

    for stream in probe
        .streams
        .iter()
        .filter(|s| s.codec_type.as_deref() == Some("subtitle"))
    {
        let codec = stream
            .codec_name
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        let track_id = Uuid::new_v4().to_string();
        let kind = if is_text_subtitle_codec(&codec) {
            SubtitleKind::Text
        } else {
            SubtitleKind::Bitmap
        };
        let mut track = SubtitleTrack {
            id: track_id.clone(),
            asset_id: asset.id.clone(),
            source_type: SubtitleSourceType::Embedded,
            stream_index: Some(stream.index),
            source_path: None,
            codec: codec.clone(),
            language: tag_value(&stream.tags, &["language", "LANGUAGE"]),
            title: tag_value(&stream.tags, &["title", "TITLE"]),
            kind,
            offset_us: 0,
            cue_count: 0,
            warning: None,
        };

        if is_text_subtitle_codec(&codec) {
            let current_subtitle = text_subtitle_index + 1;
            text_subtitle_index += 1;
            match extract_embedded_subtitle(
                &input_path,
                stream.index,
                &codec,
                &cache_dir,
                &preferences,
                Some(FfmpegProgressContext {
                    app: &app,
                    state: state.inner(),
                    task_id: &task_id,
                    cancel: task.cancel_token(),
                    base_progress: 0.08
                        + (current_subtitle - 1) as f64 * 0.72 / text_subtitle_total as f64,
                    progress_span: 0.72 / text_subtitle_total as f64,
                    duration_us,
                    cleanup_paths: Vec::new(),
                }),
            )
            .await
            {
                Ok(subtitle_path) => match parse_subtitle_file_async(
                    subtitle_path,
                    codec.clone(),
                    track_id.clone(),
                    task.cancel_token(),
                )
                .await
                {
                    Ok(parsed) => {
                        track.cue_count = parsed.len();
                        cues.insert(track_id.clone(), parsed);
                    }
                    Err(err) => {
                        let message = format!("字幕流 {} 解析失败: {err}", stream.index);
                        track.warning = Some(message.clone());
                        warnings.push(message);
                    }
                },
                Err(err) => {
                    if err == "任务已取消" {
                        return Err(err);
                    }
                    let message = format!("字幕流 {} 抽取失败: {err}", stream.index);
                    track.warning = Some(message.clone());
                    warnings.push(message);
                }
            }
        } else {
            let message = format!(
                "字幕流 {} 是图像字幕({codec})，当前版本暂不支持台词浏览",
                stream.index
            );
            track.warning = Some(message.clone());
            warnings.push(message);
        }

        tracks.push(track);
        task.check_cancelled()?;
    }

    let external_total = external_subtitles.len().max(1);
    for (index, external) in external_subtitles.into_iter().enumerate() {
        task.check_cancelled()?;
        let (track, parsed_cues, warning) =
            load_external_subtitle_async(external, asset.id.clone(), task.cancel_token()).await?;
        if let Some(message) = warning {
            warnings.push(message);
        }
        if !parsed_cues.is_empty() {
            cues.insert(track.id.clone(), parsed_cues);
        }
        tracks.push(track);
        emit_ffmpeg_progress(
            &app,
            &task_id,
            0.8 + (index + 1) as f64 * 0.15 / external_total as f64,
        );
    }

    if tracks.is_empty() {
        warnings.push("未检测到字幕流；可稍后通过“外挂字幕”按钮导入".to_string());
    }

    let project = Project {
        asset,
        streams,
        tracks,
        cues,
        cache_dir: cache_dir.to_string_lossy().into_owned(),
        proxy_path: proxy_path_str,
    };

    task.check_cancelled()?;
    state
        .projects
        .lock()
        .map_err(|_| "项目状态锁定失败".to_string())?
        .insert(project.asset.id.clone(), project.clone());

    emit_ffmpeg_progress(&app, &task_id, 1.0);
    Ok(ImportResult { project, warnings })
}

#[tauri::command]
pub(crate) async fn generate_proxy(
    asset_id: String,
    options: ProxyOptions,
    task_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ProxyResult, String> {
    let task = register_task(&task_id, state.inner())?;
    let preferences = preferences_clone(&state)?;
    let project = project_clone(&asset_id, &state)?;
    let proxy_path = proxy_output_path(&project, &preferences, &options)?;
    emit_ffmpeg_progress(&app, &task_id, 0.0);
    if let Some(parent) = proxy_path.parent() {
        let parent = parent.to_path_buf();
        spawn_blocking_cancellable(task.cancel_token(), "创建代理输出目录", move |_| {
            fs::create_dir_all(parent).map_err(|e| format!("创建代理输出目录失败: {e}"))
        })
        .await?;
    }
    task.check_cancelled()?;
    if !proxy_path.exists() {
        let mut args = vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-i".to_string(),
            project.asset.path.clone(),
            "-map".to_string(),
            "0:v:0".to_string(),
            "-map".to_string(),
            "0:a:0?".to_string(),
            "-sn".to_string(),
        ];
        if let Some(video_filter) = proxy_video_filter(&options)? {
            args.push("-vf".to_string());
            args.push(video_filter);
        }
        append_proxy_preset_args(&mut args, options.preset, options.watermark);
        args.push(proxy_path.to_string_lossy().into_owned());

        let program = ffmpeg_program(&preferences);
        run_status_with_ffmpeg_progress(
            &program,
            &args,
            FfmpegProgressContext {
                app: &app,
                state: state.inner(),
                task_id: &task_id,
                cancel: task.cancel_token(),
                base_progress: 0.0,
                progress_span: 1.0,
                duration_us: project.asset.duration_us,
                cleanup_paths: vec![proxy_path.clone()],
            },
        )
        .await?;
    }

    task.check_cancelled()?;
    let proxy_string = proxy_path.to_string_lossy().into_owned();
    let mut updated_project = project;
    updated_project.proxy_path = Some(proxy_string.clone());
    task.check_cancelled()?;
    state
        .projects
        .lock()
        .map_err(|_| "项目状态锁定失败".to_string())?
        .insert(asset_id, updated_project);
    emit_ffmpeg_progress(&app, &task_id, 1.0);
    Ok(ProxyResult {
        proxy_path: proxy_string,
    })
}

#[tauri::command]
pub(crate) async fn add_external_subtitles(
    asset_id: String,
    paths: Vec<String>,
    task_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<AddExternalSubtitlesResult, String> {
    let task = register_task(&task_id, state.inner())?;
    let mut project = project_clone(&asset_id, &state)?;
    let mut new_tracks = Vec::new();
    let mut new_cues: HashMap<String, Vec<SubtitleCue>> = HashMap::new();
    let mut warnings = Vec::new();

    emit_ffmpeg_progress(&app, &task_id, 0.0);
    let path_total = paths.len().max(1);
    for (index, path) in paths.into_iter().enumerate() {
        task.check_cancelled()?;
        let (track, cues, warning) =
            load_external_subtitle_async(path, asset_id.clone(), task.cancel_token()).await?;
        if let Some(message) = warning {
            warnings.push(message);
        }
        if !cues.is_empty() {
            new_cues.insert(track.id.clone(), cues);
        }
        project.tracks.push(track.clone());
        new_tracks.push(track);
        emit_ffmpeg_progress(&app, &task_id, (index + 1) as f64 * 0.9 / path_total as f64);
    }

    project.cues.extend(new_cues.clone());
    task.check_cancelled()?;
    state
        .projects
        .lock()
        .map_err(|_| "项目状态锁定失败".to_string())?
        .insert(asset_id, project);

    emit_ffmpeg_progress(&app, &task_id, 1.0);
    Ok(AddExternalSubtitlesResult {
        tracks: new_tracks,
        cues: new_cues,
        warnings,
    })
}

#[tauri::command]
pub(crate) async fn export_clips(
    asset_id: String,
    track_id: String,
    cue_ids: Vec<String>,
    options: ExportOptions,
    task_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ExportResult, String> {
    let task = register_task(&task_id, state.inner())?;
    let preferences = preferences_clone(&state)?;
    let project = project_clone(&asset_id, &state)?;
    let track_cues = project
        .cues
        .get(&track_id)
        .ok_or_else(|| "找不到当前字幕轨".to_string())?;
    let selected_ids = cue_ids.into_iter().collect::<HashSet<_>>();
    let selected_cues = track_cues
        .iter()
        .filter(|cue| selected_ids.contains(&cue.id))
        .cloned()
        .collect::<Vec<_>>();

    if selected_cues.is_empty() {
        return Err("请先勾选至少一条台词".to_string());
    }

    let ranges = build_clip_plan(
        &selected_cues,
        options.head_padding_ms * 1000,
        options.tail_padding_ms * 1000,
        options.merge_gap_ms * 1000,
        project.asset.duration_us,
    );

    let output_dir = if options.output_dir.trim().is_empty() {
        configured_export_root(&preferences)
            .join(&project.asset.id)
            .join(now_millis().to_string())
    } else if options.output_dir_explicit {
        PathBuf::from(options.output_dir.trim())
    } else {
        PathBuf::from(options.output_dir.trim())
            .join(&project.asset.id)
            .join(now_millis().to_string())
    };
    let output_dir_to_create = output_dir.clone();
    spawn_blocking_cancellable(task.cancel_token(), "创建导出目录", move |_| {
        fs::create_dir_all(output_dir_to_create).map_err(|e| format!("创建导出目录失败: {e}"))
    })
    .await?;

    let mut log = Vec::new();
    let stem = safe_component(
        &Path::new(&project.asset.path)
            .file_stem()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "clip".to_string()),
    );
    let ext = match options.mode {
        ExportMode::FastCopy => "mkv",
        ExportMode::PreciseEncode => "mp4",
    };
    let part_dir = match options.layout {
        ExportLayout::Individual => output_dir.clone(),
        ExportLayout::Merged => output_dir.join("_parts"),
    };
    let part_dir_to_create = part_dir.clone();
    spawn_blocking_cancellable(task.cancel_token(), "创建片段目录", move |_| {
        fs::create_dir_all(part_dir_to_create).map_err(|e| format!("创建片段目录失败: {e}"))
    })
    .await?;

    let cue_lookup = track_cues
        .iter()
        .map(|cue| (cue.id.as_str(), cue))
        .collect::<HashMap<_, _>>();
    let name_rule = effective_export_name_rule(options.export_name_rule, &options.layout);
    let mut used_names = HashSet::new();
    let mut part_files = Vec::new();
    let is_merged_layout = matches!(options.layout, ExportLayout::Merged);
    let part_progress_total = if is_merged_layout { 0.92 } else { 1.0 };
    let mut task_cleanup_paths = if is_merged_layout {
        vec![part_dir.clone()]
    } else {
        Vec::new()
    };
    emit_ffmpeg_progress(&app, &task_id, 0.0);
    for range in &ranges {
        task.check_cancelled()?;
        let file_stem = export_file_stem(
            name_rule,
            &stem,
            range,
            &cue_lookup,
            &options.dialogue_line_indexes,
        );
        let output_path = unique_output_path(&part_dir, &file_stem, ext, &mut used_names);
        task_cleanup_paths.push(output_path.clone());
        export_one_range(
            &project.asset.path,
            range,
            &options.mode,
            &output_path,
            &preferences,
            Some(FfmpegProgressContext {
                app: &app,
                state: state.inner(),
                task_id: &task_id,
                cancel: task.cancel_token(),
                base_progress: range.index as f64 * part_progress_total
                    / ranges.len().max(1) as f64,
                progress_span: part_progress_total / ranges.len().max(1) as f64,
                duration_us: range.end_us - range.start_us,
                cleanup_paths: task_cleanup_paths.clone(),
            }),
        )
        .await?;
        log.push(format!(
            "导出片段 {}: {} -> {}",
            range.index + 1,
            display_time(range.start_us),
            display_time(range.end_us)
        ));
        part_files.push(output_path);
    }

    let files = match options.layout {
        ExportLayout::Individual => part_files
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        ExportLayout::Merged => {
            emit_ffmpeg_progress(&app, &task_id, 0.92);
            let merged_stem = if ranges.len() == 1 {
                export_file_stem(
                    name_rule,
                    &stem,
                    &ranges[0],
                    &cue_lookup,
                    &options.dialogue_line_indexes,
                )
            } else {
                let start_us = ranges.first().map(|range| range.start_us).unwrap_or(0);
                let end_us = ranges.last().map(|range| range.end_us).unwrap_or(start_us);
                safe_component(&format!(
                    "{}_{}-{}_merged",
                    stem,
                    file_time_label(start_us),
                    file_time_label(end_us)
                ))
            };
            let mut used_merged_names = HashSet::new();
            let merged = unique_output_path(&output_dir, &merged_stem, ext, &mut used_merged_names);
            task_cleanup_paths.push(merged.clone());
            concat_segments(
                &part_files,
                &merged,
                &preferences,
                Some(FfmpegProgressContext {
                    app: &app,
                    state: state.inner(),
                    task_id: &task_id,
                    cancel: task.cancel_token(),
                    base_progress: 0.92,
                    progress_span: 0.08,
                    duration_us: ranges
                        .iter()
                        .map(|range| range.end_us - range.start_us)
                        .sum(),
                    cleanup_paths: task_cleanup_paths.clone(),
                }),
            )
            .await?;
            log.push(format!("合并输出: {}", merged.to_string_lossy()));
            vec![merged.to_string_lossy().into_owned()]
        }
    };
    task.check_cancelled()?;
    emit_ffmpeg_progress(&app, &task_id, 1.0);

    Ok(ExportResult {
        ranges,
        files,
        output_dir: output_dir.to_string_lossy().into_owned(),
        log,
    })
}

pub(crate) fn project_clone(
    asset_id: &str,
    state: &tauri::State<'_, AppState>,
) -> Result<Project, String> {
    state
        .projects
        .lock()
        .map_err(|_| "项目状态锁定失败".to_string())?
        .get(asset_id)
        .cloned()
        .ok_or_else(|| "项目未加载，请重新导入媒体".to_string())
}

pub(crate) fn preferences_clone(state: &tauri::State<'_, AppState>) -> Result<Preferences, String> {
    state
        .preferences
        .lock()
        .map_err(|_| "首选项状态锁定失败".to_string())
        .map(|preferences| preferences.clone())
}
