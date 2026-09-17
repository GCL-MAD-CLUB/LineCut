use super::*;
use md5::{Digest, Md5};
use std::io::{Read, Write};

fn copy_error(error: impl std::fmt::Display) -> AppError {
    app_error(
        ErrorCode::MediaReadFailed,
        format!("Media copy failed: {error}"),
    )
}

/// Reserve the destination atomically; never overwrite an existing file, including
/// another selected file with the same basename.
fn reserve_destination(directory: &Path, source: &Path) -> AppResult<(PathBuf, fs::File)> {
    let name = source
        .file_name()
        .ok_or_else(|| copy_error("Source has no file name"))?;
    let stem = source.file_stem().unwrap_or(name).to_string_lossy();
    let extension = source
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    for index in 0..10_000 {
        let target = directory.join(if index == 0 {
            name.to_os_string()
        } else {
            format!("{stem} ({index}){extension}").into()
        });
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(file) => return Ok((target, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(copy_error(error)),
        }
    }
    Err(copy_error("Cannot reserve a unique destination filename"))
}

fn copy_file(
    source: &Path,
    directory: &Path,
    verify: bool,
    cancel: &AtomicBool,
    progress: impl Fn(f64),
) -> AppResult<String> {
    let mut input = fs::File::open(source).map_err(copy_error)?;
    if !input.metadata().map_err(copy_error)?.is_file() || !directory.is_dir() {
        return Err(copy_error(
            "Source must be a file and destination must be a directory",
        ));
    }
    let total = input.metadata().map_err(copy_error)?.len().max(1);
    let (target, mut output) = reserve_destination(directory, source)?;
    let result = (|| {
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut source_hash = Md5::new();
        let mut copied = 0u64;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(app_error(ErrorCode::TaskCancelled, "Media copy cancelled"));
            }
            let size = input.read(&mut buffer).map_err(copy_error)?;
            if size == 0 {
                break;
            }
            output.write_all(&buffer[..size]).map_err(copy_error)?;
            if verify {
                source_hash.update(&buffer[..size]);
            }
            copied += size as u64;
            progress(copied as f64 / total as f64 * if verify { 0.5 } else { 1.0 });
        }
        output.sync_all().map_err(copy_error)?;
        drop(output);
        if verify {
            let mut copied_file = fs::File::open(&target).map_err(copy_error)?;
            let mut target_hash = Md5::new();
            let mut checked = 0u64;
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return Err(app_error(
                        ErrorCode::TaskCancelled,
                        "Media verification cancelled",
                    ));
                }
                let size = copied_file.read(&mut buffer).map_err(copy_error)?;
                if size == 0 {
                    break;
                }
                target_hash.update(&buffer[..size]);
                checked += size as u64;
                progress(0.5 + checked as f64 / total as f64 * 0.5);
            }
            if source_hash.finalize() != target_hash.finalize() {
                return Err(copy_error("MD5 verification mismatch"));
            }
        }
        Ok(target.to_string_lossy().into_owned())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&target);
    }
    result
}

#[tauri::command]
pub(crate) async fn copy_import_media(
    path: String,
    directory: String,
    verify: bool,
    task_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<String> {
    let task = register_task(&task_id, state.inner())?;
    spawn_blocking_cancellable(task.cancel_token(), "copy import media", move |cancel| {
        copy_file(
            Path::new(&path),
            Path::new(&directory),
            verify,
            cancel,
            |progress| emit_ffmpeg_progress(&app, &task_id, progress),
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copy_verifies_bytes_and_preserves_existing_names() {
        let root = std::env::temp_dir().join(format!("linecut-copy-test-{}", Uuid::new_v4()));
        let destination = root.join("destination");
        fs::create_dir_all(&destination).unwrap();
        let source = root.join("媒体.mp4");
        fs::write(&source, b"original media bytes").unwrap();
        fs::write(destination.join("媒体.mp4"), b"existing").unwrap();
        let path = copy_file(&source, &destination, true, &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!(fs::read(path).unwrap(), b"original media bytes");
        assert_eq!(fs::read(destination.join("媒体.mp4")).unwrap(), b"existing");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancelled_copy_removes_partial_destination() {
        let root = std::env::temp_dir().join(format!("linecut-copy-test-{}", Uuid::new_v4()));
        let destination = root.join("destination");
        fs::create_dir_all(&destination).unwrap();
        let source = root.join("clip.mp4");
        fs::write(&source, b"media").unwrap();
        assert!(copy_file(&source, &destination, true, &AtomicBool::new(true), |_| {}).is_err());
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
        assert!(source.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
