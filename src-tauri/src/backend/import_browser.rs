use super::*;
use std::time::UNIX_EPOCH;
use tauri::Manager;

#[derive(Serialize)]
pub(crate) struct ImportLocation {
    path: String,
    name: String,
    kind: String,
}

#[tauri::command]
pub(crate) fn list_import_locations(app: tauri::AppHandle) -> CommandResult<Vec<ImportLocation>> {
    let resolver = app.path();
    let candidates = [
        (resolver.home_dir(), "主页", "home"),
        (resolver.desktop_dir(), "桌面", "desktop"),
        (resolver.document_dir(), "文档", "documents"),
        (resolver.download_dir(), "下载", "downloads"),
        (resolver.video_dir(), "影片", "videos"),
        (resolver.audio_dir(), "音乐", "music"),
        (resolver.picture_dir(), "图片", "pictures"),
    ];
    let mut locations = Vec::new();
    for (path, name, kind) in candidates {
        if let Ok(path) = path {
            if path.is_dir() {
                locations.push(ImportLocation {
                    path: path.to_string_lossy().into_owned(),
                    name: name.into(),
                    kind: kind.into(),
                });
            }
        }
    }
    #[cfg(windows)]
    for letter in b'A'..=b'Z' {
        let path = format!("{}:\\", letter as char);
        if Path::new(&path).is_dir() {
            locations.push(ImportLocation {
                name: format!("{}:（本地磁盘）", letter as char),
                path,
                kind: "device".into(),
            });
        }
    }
    #[cfg(not(windows))]
    locations.push(ImportLocation {
        name: "文件系统".into(),
        path: "/".into(),
        kind: "device".into(),
    });
    Ok(locations)
}

#[derive(Serialize)]
pub(crate) struct ImportEntry {
    path: String,
    name: String,
    is_directory: bool,
    is_hidden: bool,
    size: u64,
    created_at: Option<u64>,
}
#[derive(Serialize)]
pub(crate) struct ImportDirectory {
    directory: String,
    canonical_path: String,
    parent: Option<String>,
    entries: Vec<ImportEntry>,
}
#[tauri::command]
pub(crate) async fn list_import_directory(directory: String) -> CommandResult<ImportDirectory> {
    tokio::task::spawn_blocking(move || {
        let path = PathBuf::from(&directory);
        let canonical_path = fs::canonicalize(&path)
            .map_err(|error| {
                app_error(
                    ErrorCode::MediaReadFailed,
                    format!("Cannot resolve import directory {directory}: {error}"),
                )
            })?
            .to_string_lossy()
            .into_owned();
        let children = fs::read_dir(&path).map_err(|error| {
            app_error(
                ErrorCode::MediaReadFailed,
                format!("Cannot list import directory {directory}: {error}"),
            )
        })?;
        let entries = children
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                if !metadata.is_dir() && !metadata.is_file() {
                    return None;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let mut hidden = name.starts_with('.');
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    hidden |= metadata.file_attributes() & 2 != 0;
                }
                Some(ImportEntry {
                    path: entry.path().to_string_lossy().into_owned(),
                    name,
                    is_directory: metadata.is_dir(),
                    is_hidden: hidden,
                    size: metadata.len(),
                    created_at: metadata
                        .created()
                        .ok()
                        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                        .map(|value| value.as_secs()),
                })
            })
            .collect();
        Ok(ImportDirectory {
            canonical_path,
            parent: path
                .parent()
                .map(|value| value.to_string_lossy().into_owned()),
            directory,
            entries,
        })
    })
    .await
    .map_err(|error| {
        app_error(
            ErrorCode::BlockingTaskFailed,
            format!("Import directory task failed: {error}"),
        )
    })?
}

#[derive(Serialize)]
pub(crate) struct ImportPreviewMetadata {
    duration_us: i64,
    width: Option<i64>,
    height: Option<i64>,
    frame_rate: Option<String>,
    codec: Option<String>,
}
#[tauri::command]
pub(crate) async fn probe_import_preview(
    path: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<ImportPreviewMetadata> {
    let preferences = preferences_clone(&state)?;
    let task_id = format!("import-preview:{}", Uuid::new_v4());
    let task = register_task(&task_id, state.inner())?;
    let probe = probe_media_with_timeout(
        Path::new(&path),
        &preferences,
        state.inner(),
        &task_id,
        task.cancel_token(),
        Duration::from_secs(10),
    )
    .await?;
    let stream = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"));
    Ok(ImportPreviewMetadata {
        duration_us: probe
            .format
            .as_ref()
            .and_then(|format| format.duration.as_deref())
            .map(parse_decimal_seconds_to_us)
            .unwrap_or(0),
        width: stream.and_then(|stream| stream.width),
        height: stream.and_then(|stream| stream.height),
        frame_rate: stream.and_then(|stream| stream.avg_frame_rate.clone()),
        codec: stream.and_then(|stream| stream.codec_name.clone()),
    })
}
