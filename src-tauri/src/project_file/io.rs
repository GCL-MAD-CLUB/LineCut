use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use super::{handle_v1, protocol};
use crate::{app_error, AppResult, ErrorCode};

const PROJECT_EXTENSION: &str = "lcp";

pub(super) fn normalize_path(path: &str) -> AppResult<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(app_error(
            ErrorCode::ProjectPathInvalid,
            "Project path is empty",
        ));
    }
    let mut path = PathBuf::from(trimmed);
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case(PROJECT_EXTENSION))
    {
        path.set_extension(PROJECT_EXTENSION);
    }
    Ok(path)
}

pub(super) fn read(path: &Path) -> AppResult<Vec<u8>> {
    if !path.is_file() {
        return Err(app_error(
            ErrorCode::FileNotFound,
            format!("Project file does not exist: {}", path.to_string_lossy()),
        ));
    }
    let file_len = fs::metadata(path)
        .map_err(|error| {
            app_error(
                ErrorCode::ProjectReadFailed,
                format!("Failed to read project file metadata: {error}"),
            )
        })?
        .len();
    let max_file_len = handle_v1::MAX_FILE_LEN.max(protocol::MAX_FILE_LEN);
    if file_len > max_file_len {
        return Err(app_error(
            ErrorCode::ProjectFormatInvalid,
            "Project file exceeds the size limit",
        ));
    }
    fs::read(path).map_err(|error| {
        app_error(
            ErrorCode::ProjectReadFailed,
            format!("Failed to read project file: {error}"),
        )
    })
}

pub(super) fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| {
        app_error(
            ErrorCode::ProjectWriteFailed,
            format!("Failed to create project directory: {error}"),
        )
    })?;

    let write_id = Uuid::new_v4();
    let temporary_path = path.with_extension(format!("{PROJECT_EXTENSION}.{write_id}.tmp"));
    let mut temporary_file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)
        .map_err(|error| {
            app_error(
                ErrorCode::ProjectWriteFailed,
                format!("Failed to create temporary project file: {error}"),
            )
        })?;
    temporary_file
        .write_all(bytes)
        .and_then(|_| temporary_file.sync_all())
        .map_err(|error| {
            let _ = fs::remove_file(&temporary_path);
            app_error(
                ErrorCode::ProjectWriteFailed,
                format!("Failed to write project file: {error}"),
            )
        })?;
    drop(temporary_file);

    let legacy_backup_path = path.with_extension(format!("{PROJECT_EXTENSION}.bak"));
    if legacy_backup_path.exists() {
        fs::remove_file(&legacy_backup_path).map_err(|error| {
            let _ = fs::remove_file(&temporary_path);
            app_error(
                ErrorCode::ProjectWriteFailed,
                format!("Failed to remove legacy project backup: {error}"),
            )
        })?;
    }
    if path.exists() {
        fs::remove_file(path).map_err(|error| {
            let _ = fs::remove_file(&temporary_path);
            app_error(
                ErrorCode::ProjectWriteFailed,
                format!("Failed to replace existing project file: {error}"),
            )
        })?;
    }
    fs::rename(&temporary_path, path).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        app_error(
            ErrorCode::ProjectWriteFailed,
            format!("Failed to commit project file: {error}"),
        )
    })
}
