use super::*;
use crate::project_file::{
    normalize_project_path, read_project_file, write_auto_save_snapshot, write_project_file,
};

#[tauri::command]
pub(crate) fn get_preferences(state: tauri::State<'_, AppState>) -> CommandResult<Preferences> {
    state
        .preferences
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::PreferencesStateUnavailable,
                "Preferences state lock is poisoned",
            )
        })
        .map(|preferences| preferences.clone())
}

#[tauri::command]
pub(crate) fn take_preferences_startup_error(
    state: tauri::State<'_, AppState>,
) -> CommandResult<()> {
    let error = state
        .startup_preferences_error
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::PreferencesStateUnavailable,
                "Startup preferences diagnostic lock is poisoned",
            )
        })?
        .take();
    match error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[tauri::command]
pub(crate) fn take_launch_project_path(
    state: tauri::State<'_, AppState>,
) -> CommandResult<Option<String>> {
    state
        .launch_project_path
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::LaunchPathStateUnavailable,
                "Launch project path state lock is poisoned",
            )
        })
        .map(|mut path| path.take())
}

#[tauri::command]
pub(crate) async fn update_preferences(
    preferences: Preferences,
    task_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<Preferences> {
    let task = register_task(&task_id, state.inner())?;
    emit_ffmpeg_progress(&app, &task_id, 0.0);
    let cancel = task.cancel_token();
    let normalized = tokio::task::spawn_blocking(move || {
        ensure_not_cancelled(&cancel)?;
        let normalized = normalize_preferences(preferences)?;
        ensure_not_cancelled(&cancel)?;
        save_preferences(&normalized)?;
        ensure_not_cancelled(&cancel)?;
        Ok::<_, AppError>(normalized)
    })
    .await
    .map_err(|error| {
        app_error(
            ErrorCode::BlockingTaskFailed,
            format!("Preferences save task failed: {error}"),
        )
    })??;
    task.check_cancelled()?;
    *state.preferences.lock().map_err(|_| {
        app_error(
            ErrorCode::PreferencesStateUnavailable,
            "Preferences state lock is poisoned",
        )
    })? = normalized.clone();
    emit_ffmpeg_progress(&app, &task_id, 1.0);
    Ok(normalized)
}

#[tauri::command]
pub(crate) async fn cancel_task(
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<bool> {
    let (found, processes, cleanup_paths) = take_task_for_cancellation(&task_id, state.inner())?;
    if !processes.is_empty() || !cleanup_paths.is_empty() {
        tokio::task::spawn_blocking(move || {
            stop_running_ffmpeg(processes);
            remove_cleanup_paths(&cleanup_paths);
        })
        .await
        .map_err(|error| {
            app_error(
                ErrorCode::BlockingTaskFailed,
                format!("Task cancellation cleanup failed: {error}"),
            )
        })?;
    }
    Ok(found)
}

#[tauri::command]
pub(crate) async fn save_project_file(
    path: String,
    workspace: ProjectWorkspace,
    project_id: String,
) -> CommandResult<String> {
    let normalized_path = normalize_project_path(&path)?;
    let output_path = normalized_path.clone();
    tokio::task::spawn_blocking(move || write_project_file(&output_path, workspace, &project_id))
        .await
        .map_err(|error| {
            app_error(
                ErrorCode::BlockingTaskFailed,
                format!("Project save task failed: {error}"),
            )
        })??;
    Ok(normalized_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) async fn auto_save_project_snapshot(
    project_name: String,
    workspace: ProjectWorkspace,
    project_id: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<Option<String>> {
    let (cache_root, max_snapshots) = {
        let preferences = state.preferences.lock().map_err(|_| {
            app_error(
                ErrorCode::PreferencesStateUnavailable,
                "Preferences state lock is poisoned",
            )
        })?;
        (
            configured_cache_root(&preferences),
            preferences.auto_save_max_snapshots as usize,
        )
    };
    tokio::task::spawn_blocking(move || {
        write_auto_save_snapshot(
            &cache_root,
            &project_name,
            workspace,
            &project_id,
            max_snapshots,
        )
        .map(|path| path.map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| {
        app_error(
            ErrorCode::BlockingTaskFailed,
            format!("Project auto-save task failed: {error}"),
        )
    })?
}

#[tauri::command]
pub(crate) async fn open_project_file(
    path: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<OpenProjectResult> {
    let input_path = PathBuf::from(path);
    let read_path = input_path.clone();
    let (mut workspace, project_id, migrated) =
        tokio::task::spawn_blocking(move || read_project_file(&read_path))
            .await
            .map_err(|error| {
                app_error(
                    ErrorCode::BlockingTaskFailed,
                    format!("Project open task failed: {error}"),
                )
            })??;
    let mut warnings = Vec::new();

    for project in &mut workspace.projects {
        for track in &mut project.tracks {
            if matches!(&track.source_type, SubtitleSourceType::Embedded) {
                track.source_path = None;
            }
            if let Some(detail) = track.warning.take() {
                tracing::warn!(
                    notice_code = "LEGACY_TRACK_WARNING_SANITIZED",
                    track_id = %track.id,
                    detail = %detail,
                    "sanitized persisted subtitle warning"
                );
                let public_message = match &track.source_type {
                    SubtitleSourceType::Embedded => match track.stream_index {
                        Some(stream_index) => format!("字幕流 {stream_index} 当前不可用"),
                        None => "内嵌字幕当前不可用".to_string(),
                    },
                    SubtitleSourceType::External => {
                        let display_name = track
                            .source_path
                            .as_deref()
                            .and_then(|path| Path::new(path).file_name())
                            .and_then(|value| value.to_str())
                            .or_else(|| {
                                track
                                    .title
                                    .as_deref()
                                    .and_then(|title| Path::new(title).file_name())
                                    .and_then(|value| value.to_str())
                            })
                            .unwrap_or("字幕文件");
                        format!("外挂字幕当前不可用：{display_name}")
                    }
                };
                track.warning = Some(public_message);
            }
        }
    }
    for item in &mut workspace.media_bin.items {
        let is_virtual_reference = item.origin == MediaBinItemOrigin::Decomposed
            && item.source_video_id.is_some()
            && item.stream_index.is_some()
            && matches!(
                item.kind,
                MediaBinItemKind::Audio | MediaBinItemKind::Subtitle
            );
        if is_virtual_reference {
            item.path.clear();
            item.extracted = false;
            item.offline = false;
        }
    }

    for project in &workspace.projects {
        let media_path = Path::new(&project.asset.path);
        let was_set_offline = workspace.media_bin.items.iter().any(|item| {
            item.offline
                && (item.id == project.asset.id
                    || item.source_video_id.as_deref() == Some(project.asset.id.as_str()))
        });
        if was_set_offline {
            continue;
        }
        if !media_path.is_file() {
            warnings.push(UserNotice::warning_with_detail(
                "PROJECT_MEDIA_MISSING",
                format!("项目引用的媒体文件不存在：{}", project.asset.file_name),
                format!("missing media path: {}", project.asset.path),
            ));
        } else {
            match fs::metadata(media_path) {
                Ok(metadata) => {
                    if metadata.len() as i64 != project.asset.file_size
                        || modified_secs(&metadata) != project.asset.modified_at
                    {
                        warnings.push(UserNotice::warning(
                            "PROJECT_MEDIA_CHANGED",
                            format!("源媒体自项目保存后已发生变化：{}", project.asset.file_name),
                        ));
                    }
                }
                Err(error) => {
                    app_error(
                        ErrorCode::MediaReadFailed,
                        format!(
                            "Failed to read project media metadata for {}: {error}",
                            media_path.display()
                        ),
                    );
                }
            }
        }
    }

    let project_paths = workspace
        .projects
        .iter()
        .map(|project| project.asset.path.clone())
        .collect::<HashSet<_>>();
    for item in &mut workspace.media_bin.items {
        if item.offline || item.path.is_empty() {
            continue;
        }
        if !Path::new(&item.path).is_file() {
            item.offline = true;
            if !project_paths.contains(&item.path) {
                warnings.push(UserNotice::warning_with_detail(
                    "PROJECT_ITEM_MISSING",
                    format!("项目引用的文件不存在：{}", item.file_name),
                    format!("missing project item path: {}", item.path),
                ));
            }
        }
    }

    // A legacy file's id was generated in memory; write it back so the id stays
    // stable across opens (and the file's recorded per-project state keeps its
    // identity). Best-effort: a read-only file must still open.
    if migrated {
        let write_path = input_path.clone();
        let write_workspace = workspace.clone();
        let write_project_id = project_id.clone();
        if let Err(error) = tokio::task::spawn_blocking(move || {
            write_project_file(&write_path, write_workspace, &write_project_id)
        })
        .await
        .map_err(|error| {
            app_error(
                ErrorCode::BlockingTaskFailed,
                format!("Project id backfill task failed: {error}"),
            )
        })? {
            warnings.push(UserNotice::warning_with_detail(
                "PROJECT_ID_BACKFILL_FAILED",
                "无法将项目标识写回旧项目文件，打开后首次保存将固定该标识",
                error.detail(),
            ));
        }
    }

    let mut projects = state.projects.lock().map_err(|_| {
        app_error(
            ErrorCode::ProjectStateUnavailable,
            "Project state lock is poisoned",
        )
    })?;
    projects.clear();
    projects.extend(
        workspace
            .projects
            .iter()
            .map(|project| (project.asset.id.clone(), project.clone())),
    );
    drop(projects);

    Ok(OpenProjectResult {
        path: input_path.to_string_lossy().into_owned(),
        project_id,
        workspace,
        warnings,
    })
}

#[tauri::command]
pub(crate) fn sync_project_workspace(
    workspace: ProjectWorkspace,
    state: tauri::State<'_, AppState>,
) -> CommandResult<()> {
    let mut projects = state.projects.lock().map_err(|_| {
        app_error(
            ErrorCode::ProjectStateUnavailable,
            "Project state lock is poisoned",
        )
    })?;
    projects.clear();
    projects.extend(
        workspace
            .projects
            .into_iter()
            .map(|project| (project.asset.id.clone(), project)),
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn close_project(
    asset_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> CommandResult<bool> {
    let Some(asset_id) = asset_id else {
        return Ok(false);
    };
    Ok(state
        .projects
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::ProjectStateUnavailable,
                "Project state lock is poisoned",
            )
        })?
        .remove(&asset_id)
        .is_some())
}

#[tauri::command]
pub(crate) fn path_is_file(path: String) -> bool {
    Path::new(&path).is_file()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum KnownFolderKind {
    Desktop,
    Documents,
    User,
    Videos,
    Pictures,
}

/// Resolves a well-known Windows folder to an absolute path for the 导出到
/// dropdown. Non-Windows platforms (the codebase still compiles cross-platform)
/// fall back to HOME-relative paths.
#[tauri::command]
pub(crate) fn resolve_known_folder(kind: KnownFolderKind) -> CommandResult<String> {
    #[cfg(target_os = "windows")]
    {
        use windows::core::PWSTR;
        use windows::Win32::System::Com::CoTaskMemFree;
        use windows::Win32::UI::Shell::{
            FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Pictures, FOLDERID_Profile,
            FOLDERID_Videos, SHGetKnownFolderPath, KNOWN_FOLDER_FLAG,
        };

        let id = match kind {
            KnownFolderKind::Desktop => &FOLDERID_Desktop,
            KnownFolderKind::Documents => &FOLDERID_Documents,
            KnownFolderKind::User => &FOLDERID_Profile,
            KnownFolderKind::Videos => &FOLDERID_Videos,
            KnownFolderKind::Pictures => &FOLDERID_Pictures,
        };
        // The returned PWSTR is CoTaskMemAlloc'd and must be freed below.
        let path: PWSTR =
            unsafe { SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None) }.map_err(|error| {
                app_error(
                    ErrorCode::ExportDestinationResolveFailed,
                    format!("Failed to resolve known folder {kind:?}: {error}"),
                )
            })?;
        // The CoTaskMemAlloc'd buffer must be freed on every return path, including
        // when the path cannot be decoded to a UTF-8 string.
        let result = match unsafe { path.to_string() } {
            Ok(value) => value,
            Err(error) => {
                unsafe { CoTaskMemFree(Some(path.as_ptr().cast())) };
                return Err(app_error(
                    ErrorCode::ExportDestinationResolveFailed,
                    format!("Invalid known folder path: {error}"),
                ));
            }
        };
        unsafe { CoTaskMemFree(Some(path.as_ptr().cast())) }
        Ok(result)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let base = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        let dir = match kind {
            KnownFolderKind::Desktop => base.join("Desktop"),
            KnownFolderKind::Documents => base.join("Documents"),
            KnownFolderKind::User => base,
            KnownFolderKind::Videos => base.join("Videos"),
            KnownFolderKind::Pictures => base.join("Pictures"),
        };
        Ok(dir.to_string_lossy().into_owned())
    }
}

#[tauri::command]
pub(crate) fn reveal_in_file_manager(path: String) -> CommandResult<()> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err(app_error(
            ErrorCode::FileNotFound,
            format!("File to reveal does not exist: {}", target.display()),
        ));
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        command.arg("/select,").arg(&target);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg("-R").arg(&target);
        command
    };
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(target.parent().unwrap_or_else(|| Path::new(".")));
        command
    };

    command.spawn().map(|_| ()).map_err(|error| {
        app_error(
            ErrorCode::FileRevealFailed,
            format!("Failed to reveal file {}: {error}", target.display()),
        )
    })
}

#[tauri::command]
pub(crate) async fn import_media(
    path: String,
    task_id: String,
    asset_id: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<ImportResult> {
    const SUBTITLE_PROGRESS_START: f64 = 0.08;
    const SUBTITLE_PROGRESS_END: f64 = 0.54;
    const COVER_PROGRESS_START: f64 = 0.54;
    const COVER_PROGRESS_END: f64 = 0.99;

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
        asset,
        streams,
        tracks,
        cues,
        cache_dir: cache_dir.to_string_lossy().into_owned(),
        proxy_path: proxy_path_str,
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

    emit_ffmpeg_progress(&app, &task_id, 1.0);
    Ok(ImportResult { project, warnings })
}

#[tauri::command]
pub(crate) async fn demux_media_streams(
    asset_id: String,
    task_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<DemuxMediaResult> {
    let task = register_task(&task_id, state.inner())?;
    let mut project = project_clone(&asset_id, &state)?;
    emit_ffmpeg_progress(&app, &task_id, 0.0);
    task.check_cancelled()?;

    let source_stem = Path::new(&project.asset.file_name)
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "media".to_string());
    let audio_tracks = project
        .streams
        .iter()
        .filter(|stream| stream.codec_type == "audio")
        .map(|stream| DemuxedAudioTrack {
            file_name: format!("{source_stem}_音轨_{}", stream.index),
            duration_us: project.asset.duration_us,
            stream_index: stream.index,
            codec: stream.codec_name.clone(),
            language: stream.language.clone(),
            title: stream.title.clone(),
        })
        .collect::<Vec<_>>();

    let subtitle_tracks = project
        .tracks
        .iter_mut()
        .filter_map(|track| {
            if matches!(&track.source_type, SubtitleSourceType::Embedded) {
                track.source_path = None;
                Some(track.clone())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
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
        .insert(asset_id, project);
    emit_ffmpeg_progress(&app, &task_id, 1.0);

    Ok(DemuxMediaResult {
        audio_tracks,
        subtitle_tracks,
    })
}

#[tauri::command]
pub(crate) async fn generate_proxy(
    asset_id: String,
    options: ProxyOptions,
    task_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<ProxyResult> {
    let task = register_task(&task_id, state.inner())?;
    let preferences = preferences_clone(&state)?;
    let project = project_clone(&asset_id, &state)?;
    let proxy_path = proxy_output_path(&project, &preferences, &options)?;
    emit_ffmpeg_progress(&app, &task_id, 0.0);
    if let Some(parent) = proxy_path.parent() {
        let parent = parent.to_path_buf();
        spawn_blocking_cancellable(
            task.cancel_token(),
            "create proxy output directory",
            move |_| {
                fs::create_dir_all(&parent).map_err(|error| {
                    app_error(
                        ErrorCode::ProxyWriteFailed,
                        format!(
                            "Failed to create proxy output directory {}: {error}",
                            parent.display()
                        ),
                    )
                })
            },
        )
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
                progress_callback: None,
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
        .map_err(|_| {
            app_error(
                ErrorCode::ProjectStateUnavailable,
                "Project state lock is poisoned",
            )
        })?
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
) -> CommandResult<AddExternalSubtitlesResult> {
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
        .map_err(|_| {
            app_error(
                ErrorCode::ProjectStateUnavailable,
                "Project state lock is poisoned",
            )
        })?
        .insert(asset_id, project);

    emit_ffmpeg_progress(&app, &task_id, 1.0);
    Ok(AddExternalSubtitlesResult {
        tracks: new_tracks,
        cues: new_cues,
        warnings,
    })
}

pub(crate) fn project_clone(
    asset_id: &str,
    state: &tauri::State<'_, AppState>,
) -> AppResult<Project> {
    state
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
                ErrorCode::ProjectNotLoaded,
                format!("Project is not loaded for media asset: {asset_id}"),
            )
        })
}

pub(crate) fn preferences_clone(state: &tauri::State<'_, AppState>) -> AppResult<Preferences> {
    state
        .preferences
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::PreferencesStateUnavailable,
                "Preferences state lock is poisoned",
            )
        })
        .map(|preferences| preferences.clone())
}

#[tauri::command]
pub(crate) fn play_system_sound() -> CommandResult<bool> {
    #[cfg(windows)]
    {
        const MB_ICONEXCLAMATION: u32 = 0x00000030;

        extern "system" {
            fn MessageBeep(u_type: u32) -> i32;
        }

        unsafe {
            if MessageBeep(MB_ICONEXCLAMATION) == 0 {
                let error = std::io::Error::last_os_error();
                return Err(app_error(
                    ErrorCode::SystemSoundPlayFailed,
                    format!("Failed to play system warning sound: {error}"),
                ));
            }
        }
        Ok(true)
    }

    #[cfg(not(windows))]
    {
        Ok(false)
    }
}
