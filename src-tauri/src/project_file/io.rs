use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use super::{handle_v1, protocol};

const PROJECT_EXTENSION: &str = "lcp";

pub(super) fn normalize_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("项目路径不能为空".to_string());
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

pub(super) fn read(path: &Path) -> Result<Vec<u8>, String> {
    if !path.is_file() {
        return Err(format!("项目文件不存在: {}", path.to_string_lossy()));
    }
    let file_len = fs::metadata(path)
        .map_err(|error| format!("读取项目文件信息失败: {error}"))?
        .len();
    let max_file_len = handle_v1::MAX_FILE_LEN.max(protocol::MAX_FILE_LEN);
    if file_len > max_file_len {
        return Err("项目文件过大，拒绝读取".to_string());
    }
    fs::read(path).map_err(|error| format!("读取项目文件失败: {error}"))
}

pub(super) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| format!("创建项目目录失败: {error}"))?;

    let write_id = Uuid::new_v4();
    let temporary_path = path.with_extension(format!("{PROJECT_EXTENSION}.{write_id}.tmp"));
    let mut temporary_file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)
        .map_err(|error| format!("创建项目临时文件失败: {error}"))?;
    temporary_file
        .write_all(bytes)
        .and_then(|_| temporary_file.sync_all())
        .map_err(|error| {
            let _ = fs::remove_file(&temporary_path);
            format!("写入项目文件失败: {error}")
        })?;
    drop(temporary_file);

    let legacy_backup_path = path.with_extension(format!("{PROJECT_EXTENSION}.bak"));
    if legacy_backup_path.exists() {
        fs::remove_file(&legacy_backup_path).map_err(|error| {
            let _ = fs::remove_file(&temporary_path);
            format!("清理旧项目备份失败: {error}")
        })?;
    }
    if path.exists() {
        fs::remove_file(path).map_err(|error| {
            let _ = fs::remove_file(&temporary_path);
            format!("替换旧项目文件失败: {error}")
        })?;
    }
    fs::rename(&temporary_path, path).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        format!("完成项目文件保存失败: {error}")
    })
}
