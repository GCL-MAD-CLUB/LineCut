//! Explicit installer migration; normal application startup never invokes this module's copy flow.
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

mod progress;

#[derive(Clone, Default)]
struct MigrationUpdate {
    phase: &'static str,
    path: PathBuf,
    files: u64,
    bytes: u64,
    verifying: bool,
    verified_files: u64,
    verified_bytes: u64,
}

struct MigrationProgress {
    cancelled: Arc<AtomicBool>,
    report: Box<dyn FnMut(MigrationUpdate) + Send>,
    update: MigrationUpdate,
    last_report: Instant,
    buffer: Vec<u8>,
    cancel_file: Option<PathBuf>,
    session: Option<PathBuf>,
    data_root: Option<PathBuf>,
}

impl Default for MigrationProgress {
    fn default() -> Self {
        Self {
            cancelled: Arc::default(),
            report: Box::new(|_| {}),
            update: MigrationUpdate::default(),
            last_report: Instant::now(),
            buffer: vec![0; 1024 * 1024],
            cancel_file: None,
            session: None,
            data_root: None,
        }
    }
}

impl MigrationProgress {
    fn check_cancelled(&self) -> io::Result<()> {
        if self.cancelled.load(Ordering::Relaxed)
            || self.cancel_file.as_ref().is_some_and(|path| path.is_file())
        {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Migration cancelled",
            ));
        }
        Ok(())
    }

    fn phase(&mut self, phase: &'static str) -> io::Result<()> {
        self.check_cancelled()?;
        self.update.phase = phase;
        self.update.path.clear();
        self.update.verifying = false;
        self.publish();
        Ok(())
    }

    fn publish(&mut self) {
        (self.report)(self.update.clone());
        self.last_report = Instant::now();
    }

    fn copied(&mut self, bytes: usize) -> io::Result<()> {
        self.check_cancelled()?;
        self.update.bytes += bytes as u64;
        if self.last_report.elapsed() >= Duration::from_millis(100) {
            self.publish();
        }
        Ok(())
    }
}

#[cfg(windows)]
pub(crate) const APPLICATION_ID: &str = "com.locutionpro.desktop";
#[cfg(windows)]
const LEGACY_APPLICATION_ID: &str = "com.linecut.desktop";
const MIGRATION_MARKER: &str = ".locution-pro-migration-v2";
const INSTALL_SESSION: &str = ".locution-pro-install-session";
const IMPORT_COMPLETE: &str = ".locution-pro-import-complete";
const IMPORT_OWNED: &str = ".locution-pro-import-owned";
const OWNED_HEADER: &str = "locution-pro-import-v1";
const PROFILE_RECEIPT: &str = ".locution-pro-profile-import.ini";

pub(crate) fn data_roots() -> (PathBuf, PathBuf) {
    let (current, legacy) = default_data_roots();
    (
        env::var_os("LOCUTION_PRO_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or(current),
        env::var_os("LINECUT_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or(legacy),
    )
}

fn default_data_roots() -> (PathBuf, PathBuf) {
    if cfg!(windows) {
        if let Some(parent) = env::var_os("LOCALAPPDATA") {
            return (
                PathBuf::from(&parent).join("Locution Pro"),
                PathBuf::from(parent).join("LineCut"),
            );
        }
    }
    if let Some(parent) = env::var_os("HOME") {
        return (
            PathBuf::from(&parent).join(".locution-pro"),
            PathBuf::from(parent).join(".linecut"),
        );
    }
    (
        env::temp_dir().join("locution-pro"),
        env::temp_dir().join("linecut"),
    )
}

pub(crate) fn migrate_for_installer(
    progress_file: Option<&Path>,
    cancel_file: Option<PathBuf>,
    session: Option<PathBuf>,
) -> io::Result<()> {
    if let Some(path) = progress_file {
        return progress::run(path, cancel_file, session);
    }
    migrate_all(&mut MigrationProgress {
        cancel_file,
        session,
        ..Default::default()
    })
}

fn migrate_all(progress: &mut MigrationProgress) -> io::Result<()> {
    let (current, legacy) = data_roots();
    #[allow(unused_mut)]
    let mut profiles = Vec::new();
    #[cfg(windows)]
    for variable in ["LOCALAPPDATA", "APPDATA"] {
        if let Some(parent) = env::var_os(variable) {
            let parent = PathBuf::from(parent);
            profiles.push((
                parent.join(LEGACY_APPLICATION_ID),
                parent.join(APPLICATION_ID),
            ));
        }
    }
    migrate_fresh_install(&legacy, &current, &profiles, progress)
}

fn migrate_fresh_install(
    legacy: &Path,
    current: &Path,
    profiles: &[(PathBuf, PathBuf)],
    progress: &mut MigrationProgress,
) -> io::Result<()> {
    if current.join(IMPORT_COMPLETE).exists() || progress.session.is_none() {
        return Ok(());
    }
    // A requested installer session must be valid. A lost admission is an error, not a skip.
    let admitted = progress.session.as_ref().is_some_and(|session| {
        session.is_dir()
            && fs::read(current.join(INSTALL_SESSION)).is_ok_and(|bytes| {
                let expected: Vec<u8> = std::iter::once(0xfeff)
                    .chain(session.to_string_lossy().encode_utf16())
                    .flat_map(u16::to_le_bytes)
                    .collect();
                bytes == expected
            })
    });
    if !admitted {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "迁移会话不存在或校验失败，请从安装器重试。",
        ));
    }
    ensure_disjoint_roots(legacy, current)?;
    for (source, target) in profiles {
        ensure_disjoint_roots(source, current)?;
        ensure_disjoint_roots(legacy, target)?;
        ensure_disjoint_roots(source, target)?;
    }
    if current.join("cache-version").exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "Locution Pro 已运行，不能继续导入旧数据。",
        ));
    }
    progress.data_root = Some(current.to_path_buf());
    for (_, target) in profiles {
        cleanup_profile_stages(target, progress)?;
        if target.exists() && !profile_is_owned(target, current)? {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "浏览器配置不属于未完成迁移，不能合并。",
            ));
        }
    }
    progress.phase("正在迁移设置、自动保存和缓存")?;
    migrate_application_data(legacy, current, progress)?;
    for (source, target) in profiles {
        progress.phase("正在迁移浏览器历史和工作区数据")?;
        migrate_identity_directory(source, target, progress)?;
    }
    progress.check_cancelled()?;
    publish_missing(&current.join(IMPORT_COMPLETE), b"1")?;
    progress.phase("数据迁移完成")
}

fn migrate_application_data(
    legacy: &Path,
    current: &Path,
    progress: &mut MigrationProgress,
) -> io::Result<()> {
    ensure_disjoint_roots(legacy, current)?;
    if current.join(MIGRATION_MARKER).exists() {
        let owned = record_owned_roots(legacy, current)?;
        cleanup_application_stages(current, &owned, progress)?;
        return Ok(());
    }
    let source_preferences = legacy.join("preferences.json");
    let mut imported: Option<serde_json::Value> = if source_preferences.is_file() {
        Some(serde_json::from_slice(&fs::read(&source_preferences)?)?)
    } else {
        None
    };
    let old_cache = preference_path(imported.as_ref(), "cache_dir", legacy.join("cache"));
    let old_saves = preference_path(
        imported.as_ref(),
        "auto_save_dir",
        old_cache.join("LineCut Auto-Save"),
    );
    let new_cache = current.join("cache");
    let new_saves = new_cache.join("Locution Pro Auto-Save");
    // Source custom caches and recovery snapshots are copied too. Never keep writable source aliases.
    ensure_disjoint_roots(&old_cache, &new_cache)?;
    ensure_disjoint_roots(&old_saves, &new_saves)?;
    ensure_disjoint_roots(&old_cache, current)?;
    ensure_disjoint_roots(&old_saves, current)?;
    fs::create_dir_all(current)?;
    let owned = record_owned_roots(legacy, current)?;
    cleanup_application_stages(current, &owned, progress)?;
    // Follow only the explicitly configured root; descendants remain link-free copies.
    copy_missing(&canonical_location(&old_cache)?, &new_cache, progress)?;
    copy_missing(&canonical_location(&old_saves)?, &new_saves, progress)?;
    if legacy.is_dir() {
        for entry in fs::read_dir(legacy)? {
            let entry = entry?;
            let name = entry.file_name();
            if distribution_entry(&name)
                || (name == "cache"
                    && canonical_location(&old_cache)?
                        == canonical_location(&legacy.join("cache"))?)
            {
                continue;
            }
            let name = if name == "LineCut Auto-Save" {
                "Locution Pro Auto-Save".into()
            } else {
                name
            };
            copy_missing(&entry.path(), &current.join(name), progress)?;
        }
    }
    let destination = current.join("preferences.json");
    if !destination.exists() {
        if let Some(document) = imported.as_mut() {
            if let Some(object) = document.as_object_mut() {
                object.insert(
                    "cache_dir".into(),
                    new_cache.to_string_lossy().into_owned().into(),
                );
                object.insert(
                    "auto_save_dir".into(),
                    new_saves.to_string_lossy().into_owned().into(),
                );
                // The current installer's choice overrides inherited tool paths.
                let paths = installer_tool_paths(current)?;
                for (field, path) in [("ffmpeg_path", paths.0), ("ffprobe_path", paths.1)] {
                    object.insert(field.into(), path.into());
                }
            }
            publish_missing(&destination, &serde_json::to_vec_pretty(document)?)?;
        }
    }
    progress.check_cancelled()?;
    publish_missing(&current.join(MIGRATION_MARKER), b"2")
}

pub(crate) fn installer_tool_paths(current: &Path) -> io::Result<(String, String)> {
    let mut paths = ("ffmpeg".to_owned(), "ffprobe".to_owned());
    let bytes = match fs::read(current.join("installer-media-paths.ini")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(paths),
        Err(error) => return Err(error),
    };
    // New installers use UTF-16LE with BOM. Older installer files were UTF-8/ASCII.
    let contents = if bytes.starts_with(&[0xff, 0xfe]) {
        let body = &bytes[2..];
        if !body.chunks_exact(2).remainder().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid installer tool paths",
            ));
        }
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        String::from_utf16(&units)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?
    } else {
        String::from_utf8(bytes)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?
    };
    for line in contents.trim_start_matches('\u{feff}').lines() {
        if let Some(path) = line
            .strip_prefix("ffmpeg_path=")
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            paths.0 = path.to_owned();
        } else if let Some(path) = line
            .strip_prefix("ffprobe_path=")
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            paths.1 = path.to_owned();
        }
    }
    Ok(paths)
}

fn utf16_document(text: &str) -> Vec<u8> {
    std::iter::once(0xfeff)
        .chain(text.encode_utf16())
        .flat_map(u16::to_le_bytes)
        .collect()
}

fn record_owned_roots(legacy: &Path, current: &Path) -> io::Result<Vec<std::ffi::OsString>> {
    let mut names: Vec<std::ffi::OsString> = [
        "cache",
        "preferences.json",
        MIGRATION_MARKER,
        IMPORT_OWNED,
        IMPORT_COMPLETE,
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    if legacy.is_dir() {
        for entry in fs::read_dir(legacy)? {
            let name = entry?.file_name();
            if !distribution_entry(&name) {
                names.push(if name == "LineCut Auto-Save" {
                    "Locution Pro Auto-Save".into()
                } else {
                    name
                });
            }
        }
    }
    // Preserve the original ownership list if the source changed between installations.
    match fs::read(current.join(IMPORT_OWNED)) {
        Ok(bytes) => {
            if bytes.len() < 2 || bytes[..2] != [0xff, 0xfe] || bytes.len() % 2 != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "迁移所有权记录损坏。",
                ));
            }
            let units: Vec<u16> = bytes[2..]
                .chunks_exact(2)
                .map(|v| u16::from_le_bytes([v[0], v[1]]))
                .collect();
            let text = String::from_utf16(&units)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            let mut lines = text.lines();
            if lines.next() != Some(OWNED_HEADER) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "迁移所有权记录版本无效。",
                ));
            }
            for name in lines {
                if name.is_empty()
                    || name.chars().any(|c| matches!(c, '/' | '\\' | '\r' | '\n'))
                    || name == "."
                    || name == ".."
                    || name == "cache-version"
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "迁移所有权记录包含无效路径。",
                    ));
                }
                names.push(name.into());
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    names.sort();
    names.dedup();
    let text = format!(
        "{}\r\n{}\r\n",
        OWNED_HEADER,
        names
            .iter()
            .map(|v| v.to_string_lossy())
            .collect::<Vec<_>>()
            .join("\r\n")
    );
    let staged = current.join(format!(
        ".locution-pro-import-owned.migration-{}",
        Uuid::new_v4()
    ));
    fs::write(&staged, utf16_document(&text))?;
    fs::OpenOptions::new()
        .write(true)
        .open(&staged)?
        .sync_all()?;
    // A replacement is needed to retain entries copied during earlier attempts.
    let result = fs::rename(&staged, current.join(IMPORT_OWNED));
    let _ = fs::remove_file(staged);
    result?;
    Ok(names)
}

fn is_stage_name(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .and_then(|name| name.rsplit_once(".migration-"))
        .is_some_and(|(_, id)| id.len() == 36 && Uuid::parse_str(id).is_ok())
}

fn cleanup_application_stages(
    root: &Path,
    owned: &[std::ffi::OsString],
    progress: &MigrationProgress,
) -> io::Result<()> {
    let stems: Vec<_> = owned
        .iter()
        .map(|name| {
            Path::new(name)
                .file_stem()
                .unwrap_or(name.as_os_str())
                .to_owned()
        })
        .collect();
    cleanup_stage_tree(root, Some((owned, &stems)), progress)
}

fn cleanup_stage_tree(
    root: &Path,
    owned: Option<(&[std::ffi::OsString], &[std::ffi::OsString])>,
    progress: &MigrationProgress,
) -> io::Result<()> {
    if !root.is_dir() || fs::symlink_metadata(root)?.file_type().is_symlink() {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        progress.check_cancelled()?;
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let included = owned.is_none_or(|(names, _)| names.contains(&name));
        if metadata.is_dir() && included {
            cleanup_stage_tree(&entry.path(), None, progress)?;
        } else if metadata.is_file()
            && is_stage_name(&name)
            && !owned.is_some_and(|(names, _)| names.contains(&name))
        {
            let stem = Path::new(&name).file_stem().unwrap_or_default();
            if owned.is_none_or(|(_, stems)| stems.iter().any(|v| v == stem)) {
                fs::remove_file(entry.path())?;
            }
        }
    }
    Ok(())
}

fn cleanup_profile_stages(target: &Path, progress: &MigrationProgress) -> io::Result<()> {
    let Some(parent) = target.parent().filter(|p| p.is_dir()) else {
        return Ok(());
    };
    let prefix = format!(
        "{}.migration-",
        target.file_stem().unwrap_or_default().to_string_lossy()
    );
    for entry in fs::read_dir(parent)? {
        progress.check_cancelled()?;
        let entry = entry?;
        let name = entry.file_name();
        let metadata = fs::symlink_metadata(entry.path())?;
        if name.to_string_lossy().starts_with(&prefix)
            && is_stage_name(&name)
            && metadata.is_dir()
            && !metadata.file_type().is_symlink()
        {
            let resolved = canonical_location(&entry.path())?;
            let resolved_parent = canonical_location(parent)?;
            if resolved.parent() != Some(resolved_parent.as_path()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "迁移暂存目录越出预期父目录。",
                ));
            }
            ensure_disjoint_roots(&entry.path(), target)?;
            fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}

fn profile_is_owned(profile: &Path, data_root: &Path) -> io::Result<bool> {
    match fs::read(profile.join(PROFILE_RECEIPT)) {
        Ok(bytes) => Ok(bytes
            == utf16_document(&format!(
                "[Migration]\r\nDataRoot={}\r\n",
                data_root.display()
            ))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

fn preference_path(
    document: Option<&serde_json::Value>,
    field: &str,
    fallback: PathBuf,
) -> PathBuf {
    document
        .and_then(|v| v.get(field))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or(fallback)
}

fn distribution_entry(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_lowercase();
    matches!(
        name.as_str(),
        "preferences.json"
            | "cache-version"
            | "installer-media-paths.ini"
            | "transnetv2"
            | "semantic-search"
            | "storyboard-semantic"
            | "licenses"
            | "license"
            | "third_party_notices.md"
    ) || name.ends_with(".exe")
        || name.ends_with(".dll")
        || name.starts_with(".locution-pro-")
}

fn canonical_location(path: &Path) -> io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for part in absolute.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            part => normalized.push(part),
        }
    }
    let mut existing = normalized;
    let mut suffix = Vec::new();
    loop {
        match fs::canonicalize(&existing) {
            Ok(mut result) => {
                for name in suffix.iter().rev() {
                    result.push(name);
                }
                #[cfg(windows)]
                {
                    result = PathBuf::from(result.to_string_lossy().to_lowercase());
                }
                return Ok(result);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let name = existing
                    .file_name()
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::InvalidInput, "Invalid migration path")
                    })?
                    .to_owned();
                suffix.push(name);
                existing.pop();
            }
            Err(error) => return Err(error),
        }
    }
}

fn ensure_disjoint_roots(source: &Path, destination: &Path) -> io::Result<()> {
    let source = canonical_location(source)?;
    let destination = canonical_location(destination)?;
    if source.starts_with(&destination) || destination.starts_with(&source) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Migration source and destination must be separate directories",
        ));
    }
    Ok(())
}

fn migrate_identity_directory(
    legacy: &Path,
    current: &Path,
    progress: &mut MigrationProgress,
) -> io::Result<()> {
    ensure_disjoint_roots(legacy, current)?;
    // A WebView profile is a unit: merging individual Chromium database files is unsafe.
    if !legacy.is_dir() || current.exists() {
        return Ok(());
    }
    let staged = current.with_extension(format!("migration-{}", Uuid::new_v4()));
    if let Some(root) = &progress.data_root {
        fs::create_dir_all(&staged)?;
        publish_missing(
            &staged.join(PROFILE_RECEIPT),
            &utf16_document(&format!("[Migration]\r\nDataRoot={}\r\n", root.display())),
        )?;
    }
    let result = copy_missing(legacy, &staged, progress).and_then(|()| {
        progress.check_cancelled()?;
        fs::rename(&staged, current)
    });
    if result.is_err() {
        let _ = fs::remove_dir_all(&staged);
    }
    result
}

fn copy_missing(
    source: &Path,
    destination: &Path,
    progress: &mut MigrationProgress,
) -> io::Result<()> {
    progress.check_cancelled()?;
    let metadata = match fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    // Do not follow links outside the application-owned tree.
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = if name == "LineCut Auto-Save" {
                "Locution Pro Auto-Save".into()
            } else {
                name
            };
            copy_missing(&entry.path(), &destination.join(name), progress)?;
        }
    } else if !destination.exists() {
        let staged = destination.with_extension(format!("migration-{}", Uuid::new_v4()));
        let result = (|| {
            let mut input = fs::File::open(source)?;
            let mut output = fs::File::create(&staged)?;
            let mut source_hash = Sha256::new();
            progress.update.path = source.to_path_buf();
            progress.update.verifying = false;
            if progress.update.files == 0
                || progress.last_report.elapsed() >= Duration::from_millis(100)
            {
                progress.publish();
            }
            loop {
                progress.check_cancelled()?;
                let count = input.read(&mut progress.buffer)?;
                if count == 0 {
                    break;
                }
                output.write_all(&progress.buffer[..count])?;
                source_hash.update(&progress.buffer[..count]);
                progress.copied(count)?;
            }
            if let Ok(modified) = metadata.modified() {
                output.set_times(fs::FileTimes::new().set_modified(modified))?;
            }
            output.sync_all()?;
            drop(output);
            let expected: [u8; 32] = source_hash.finalize().into();
            verify_migrated_copy(&staged, &expected, progress)?;
            let current_metadata = fs::metadata(source)?;
            if metadata.len() != current_metadata.len()
                || metadata.modified().ok() != current_metadata.modified().ok()
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "旧文件在迁移期间发生变化，请关闭旧软件后重试：{}",
                        source.display()
                    ),
                ));
            }
            progress.check_cancelled()?;
            publish_staged(&staged, destination)?;
            progress.update.files += 1;
            progress.update.verified_files += 1;
            progress.update.verifying = false;
            Ok::<_, io::Error>(())
        })();
        let _ = fs::remove_file(&staged);
        result?;
    }
    Ok(())
}

/// Hash the staged file by reading it back after sync, independently of the copy buffer.
fn verify_migrated_copy(
    staged: &Path,
    expected: &[u8; 32],
    progress: &mut MigrationProgress,
) -> io::Result<()> {
    progress.update.verifying = true;
    progress.publish();
    let mut input = fs::File::open(staged)?;
    let mut digest = Sha256::new();
    loop {
        progress.check_cancelled()?;
        let count = input.read(&mut progress.buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&progress.buffer[..count]);
        progress.update.verified_bytes += count as u64;
        if progress.last_report.elapsed() >= Duration::from_millis(100) {
            progress.publish();
        }
    }
    let actual: [u8; 32] = digest.finalize().into();
    if actual != *expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "迁移文件 SHA-256 校验失败，原文件已保留，请重试：{}",
                progress.update.path.display()
            ),
        ));
    }
    progress.check_cancelled()
}

fn publish_missing(destination: &Path, bytes: &[u8]) -> io::Result<()> {
    let staged = destination.with_extension(format!("migration-{}", Uuid::new_v4()));
    let result = fs::write(&staged, bytes).and_then(|()| publish_staged(&staged, destination));
    let _ = fs::remove_file(&staged);
    result
}

fn publish_staged(staged: &Path, destination: &Path) -> io::Result<()> {
    fs::OpenOptions::new()
        .write(true)
        .open(staged)?
        .sync_all()?;
    // A hard link publishes a complete file atomically and never overwrites a concurrent writer.
    match fs::hard_link(staged, destination) {
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn admit_install(current: &Path, session: &Path) -> MigrationProgress {
        fs::create_dir_all(current).unwrap();
        fs::create_dir_all(session).unwrap();
        let bytes: Vec<u8> = std::iter::once(0xfeff)
            .chain(session.to_string_lossy().encode_utf16())
            .flat_map(u16::to_le_bytes)
            .collect();
        fs::write(current.join(INSTALL_SESSION), bytes).unwrap();
        MigrationProgress {
            session: Some(session.to_path_buf()),
            ..Default::default()
        }
    }

    #[test]
    fn a_later_install_resumes_after_app_data_and_removes_owned_killed_worker_stages() {
        let root = env::temp_dir().join(format!("locution-resume-profiles-{}", Uuid::new_v4()));
        let old = root.join("LineCut");
        let new = root.join("Locution Pro");
        let old_profile = root.join("com.linecut.desktop");
        let new_profile = root.join("com.locutionpro.desktop");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&old_profile).unwrap();
        fs::write(old.join("preferences.json"), b"{}").unwrap();
        fs::write(old.join("WorkspaceConfig.xml"), b"workspace").unwrap();
        fs::write(old_profile.join("Local Storage"), b"history").unwrap();
        let profiles = [(old_profile.clone(), new_profile.clone())];
        let mut first = admit_install(&new, &root.join("installer-one"));
        let cancelled = first.cancelled.clone();
        first.report = Box::new(move |update| {
            if update.phase == "正在迁移浏览器历史和工作区数据" {
                cancelled.store(true, Ordering::Relaxed);
            }
        });
        assert_eq!(
            migrate_fresh_install(&old, &new, &profiles, &mut first)
                .unwrap_err()
                .kind(),
            io::ErrorKind::Interrupted
        );
        assert!(new.join(MIGRATION_MARKER).exists());
        assert!(!new.join(IMPORT_COMPLETE).exists());
        let preferences = fs::read(new.join("preferences.json")).unwrap();
        let root_stage = new.join(format!("WorkspaceConfig.migration-{}", Uuid::new_v4()));
        let profile_stage = new_profile.with_extension(format!("migration-{}", Uuid::new_v4()));
        let foreign_stage = old_profile.with_extension(format!("migration-{}", Uuid::new_v4()));
        fs::write(&root_stage, b"unfinished write").unwrap();
        fs::create_dir_all(&profile_stage).unwrap();
        fs::write(profile_stage.join("partial-db"), b"unfinished profile").unwrap();
        fs::create_dir_all(&foreign_stage).unwrap();
        let mut second = admit_install(&new, &root.join("installer-two"));
        migrate_fresh_install(&old, &new, &profiles, &mut second).unwrap();
        assert!(!root_stage.exists());
        assert!(!profile_stage.exists());
        assert!(
            foreign_stage.exists(),
            "LineCut's staging directories are never cleaned"
        );
        assert_eq!(fs::read(new.join("preferences.json")).unwrap(), preferences);
        assert_eq!(
            fs::read(new.join("WorkspaceConfig.xml")).unwrap(),
            b"workspace"
        );
        assert_eq!(
            fs::read(new_profile.join("Local Storage")).unwrap(),
            b"history"
        );
        assert_eq!(
            fs::read(old_profile.join("Local Storage")).unwrap(),
            b"history"
        );
        assert!(new.join(IMPORT_COMPLETE).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn requested_sessions_fail_closed_but_manual_calls_and_completed_imports_skip() {
        let root = env::temp_dir().join(format!("locution-admission-{}", Uuid::new_v4()));
        let old = root.join("old");
        let new = root.join("new");
        let session = root.join("session");
        let mut progress = admit_install(&new, &session);
        fs::write(new.join(INSTALL_SESSION), b"damaged token").unwrap();
        assert_eq!(
            migrate_fresh_install(&old, &new, &[], &mut progress)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        migrate_fresh_install(&old, &new, &[], &mut MigrationProgress::default()).unwrap();
        fs::write(new.join(IMPORT_COMPLETE), b"1").unwrap();
        migrate_fresh_install(&old, &new, &[], &mut progress).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installer_tool_choice_overrides_inherited_preferences_including_unicode_paths() {
        let root = env::temp_dir().join(format!("locution-tools-{}", Uuid::new_v4()));
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(
            old.join("preferences.json"),
            br#"{"ffmpeg_path":"old.exe","ffprobe_path":"old-probe.exe"}"#,
        )
        .unwrap();
        let body = "ffmpeg_path=D:\\工具\\ffmpeg.exe\r\nffprobe_path=D:\\工具\\ffprobe.exe\r\n";
        let bytes: Vec<u8> = std::iter::once(0xfeff)
            .chain(body.encode_utf16())
            .flat_map(u16::to_le_bytes)
            .collect();
        fs::write(new.join("installer-media-paths.ini"), bytes).unwrap();
        migrate_application_data(&old, &new, &mut MigrationProgress::default()).unwrap();
        let prefs: serde_json::Value =
            serde_json::from_slice(&fs::read(new.join("preferences.json")).unwrap()).unwrap();
        assert_eq!(prefs["ffmpeg_path"], "D:\\工具\\ffmpeg.exe");
        assert_eq!(prefs["ffprobe_path"], "D:\\工具\\ffprobe.exe");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_data_or_profiles_skip_the_entire_import_before_reading_linecut() {
        let root = env::temp_dir().join(format!("locution-skip-{}", Uuid::new_v4()));
        let old = root.join("old");
        let new = root.join("new");
        let old_profile = root.join("old-profile");
        let new_profile = root.join("new-profile");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&old_profile).unwrap();
        fs::write(old.join("preferences.json"), b"invalid old preferences").unwrap();
        fs::write(old_profile.join("Local Storage"), b"old history").unwrap();
        let profiles = [(old_profile.clone(), new_profile.clone())];
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join("unknown-user-data"), b"keep").unwrap();
        migrate_fresh_install(&old, &new, &profiles, &mut MigrationProgress::default()).unwrap();
        assert!(!new_profile.exists());
        assert_eq!(fs::read(new.join("unknown-user-data")).unwrap(), b"keep");
        assert!(!new.join(MIGRATION_MARKER).exists());
        fs::remove_dir_all(&new).unwrap();
        fs::create_dir_all(&new_profile).unwrap();
        fs::write(new_profile.join("own-history"), b"keep history").unwrap();
        migrate_fresh_install(&old, &new, &profiles, &mut MigrationProgress::default()).unwrap();
        assert!(!new.exists());
        assert!(!new_profile.join("Local Storage").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_the_admitted_install_session_can_retry_and_cleanup_allows_a_new_import() {
        let root = env::temp_dir().join(format!("locution-session-{}", Uuid::new_v4()));
        let old = root.join("old");
        let new = root.join("new");
        let external = root.join("external-cache");
        let saves = root.join("external-saves");
        let old_profile = root.join("old-profile");
        let new_profile = root.join("new-profile");
        let profiles = [(old_profile.clone(), new_profile.clone())];
        for path in [&old, &external, &saves, &old_profile] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(old.join("preferences.json"), b"invalid preferences").unwrap();
        fs::write(external.join("cache.bin"), b"cache content").unwrap();
        fs::write(saves.join("recovery.lcp"), b"project content").unwrap();
        fs::write(old_profile.join("Local Storage"), b"history").unwrap();
        let mut first = admit_install(&new, &root.join("installer-one"));
        assert!(migrate_fresh_install(&old, &new, &profiles, &mut first).is_err());
        let other_session = root.join("installer-two");
        fs::create_dir_all(&other_session).unwrap();
        let mut later = MigrationProgress {
            session: Some(other_session.clone()),
            ..Default::default()
        };
        assert_eq!(
            migrate_fresh_install(&old, &new, &profiles, &mut later)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert!(!new_profile.exists());
        assert!(!new.join(IMPORT_COMPLETE).exists());
        fs::write(
            old.join("preferences.json"),
            serde_json::to_vec(&serde_json::json!({"cache_dir": external, "auto_save_dir": saves}))
                .unwrap(),
        )
        .unwrap();
        migrate_fresh_install(&old, &new, &profiles, &mut first).unwrap();
        assert_eq!(
            fs::read(new.join("cache/cache.bin")).unwrap(),
            b"cache content"
        );
        assert_eq!(
            fs::read(new.join("cache/Locution Pro Auto-Save/recovery.lcp")).unwrap(),
            b"project content"
        );
        assert_eq!(
            fs::read(new_profile.join("Local Storage")).unwrap(),
            b"history"
        );
        fs::write(new.join("cache/cache.bin"), b"independent changes").unwrap();
        assert_eq!(
            fs::read(external.join("cache.bin")).unwrap(),
            b"cache content"
        );
        fs::write(old.join("late-data"), b"do not sync").unwrap();
        migrate_fresh_install(&old, &new, &profiles, &mut first).unwrap();
        assert!(!new.join("late-data").exists());
        // Complete removal of our data and profiles permits a newly admitted installation.
        fs::remove_dir_all(&new).unwrap();
        fs::remove_dir_all(&new_profile).unwrap();
        later = admit_install(&new, &other_session);
        migrate_fresh_install(&old, &new, &profiles, &mut later).unwrap();
        assert!(new.join("late-data").exists());
        assert!(new.join(IMPORT_COMPLETE).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_roots_cannot_overlap_destination_even_through_parent_components() {
        let root = env::temp_dir().join(format!("locution-paths-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("old")).unwrap();
        for destination in [
            root.join("old"),
            root.join("old/child"),
            root.clone(),
            root.join("other/../old"),
        ] {
            assert!(ensure_disjoint_roots(&root.join("old"), &destination).is_err());
        }
        ensure_disjoint_roots(&root.join("old"), &root.join("new")).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupted_staged_cache_is_rejected_and_retry_verifies_every_chunk() {
        let root = env::temp_dir().join(format!("locution-hash-{}", Uuid::new_v4()));
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(old.join("cache")).unwrap();
        let bytes = vec![0xa5; 1024 * 1024 + 37];
        fs::write(old.join("cache/data.bin"), &bytes).unwrap();
        let cache = new.join("cache");
        let mut progress = MigrationProgress {
            report: Box::new(move |update| {
                if update.verifying {
                    use std::io::{Seek, SeekFrom};
                    let staged = fs::read_dir(&cache)
                        .unwrap()
                        .next()
                        .unwrap()
                        .unwrap()
                        .path();
                    let mut file = fs::OpenOptions::new().write(true).open(staged).unwrap();
                    file.seek(SeekFrom::End(-1)).unwrap();
                    file.write_all(&[0]).unwrap();
                    file.sync_all().unwrap();
                }
            }),
            ..Default::default()
        };
        let error = migrate_application_data(&old, &new, &mut progress).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("SHA-256"));
        assert!(!new.join("cache/data.bin").exists());
        assert!(!new.join(MIGRATION_MARKER).exists());
        assert_eq!(fs::read_dir(new.join("cache")).unwrap().count(), 0);
        assert_eq!(fs::read(old.join("cache/data.bin")).unwrap(), bytes);
        let mut progress = MigrationProgress::default();
        migrate_application_data(&old, &new, &mut progress).unwrap();
        assert_eq!(progress.update.verified_files, 1);
        assert_eq!(progress.update.verified_bytes, bytes.len() as u64);
        assert_eq!(progress.update.bytes, bytes.len() as u64);
        assert_eq!(fs::read(new.join("cache/data.bin")).unwrap(), bytes);
        assert!(new.join(MIGRATION_MARKER).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancellation_during_hashing_never_publishes_a_cache_or_completion_marker() {
        let root = env::temp_dir().join(format!("locution-hash-cancel-{}", Uuid::new_v4()));
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(old.join("cache")).unwrap();
        fs::write(old.join("cache/data"), b"legacy cache").unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation = cancelled.clone();
        let mut progress = MigrationProgress {
            cancelled,
            report: Box::new(move |update| {
                if update.verifying {
                    cancellation.store(true, Ordering::Relaxed);
                }
            }),
            ..Default::default()
        };
        assert_eq!(
            migrate_application_data(&old, &new, &mut progress)
                .unwrap_err()
                .kind(),
            io::ErrorKind::Interrupted
        );
        assert!(!new.join(MIGRATION_MARKER).exists());
        assert_eq!(fs::read_dir(new.join("cache")).unwrap().count(), 0);
        assert_eq!(fs::read(old.join("cache/data")).unwrap(), b"legacy cache");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_changed_source_is_rejected_even_when_the_staged_hash_matches() {
        let root = env::temp_dir().join(format!("locution-hash-source-{}", Uuid::new_v4()));
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(old.join("cache")).unwrap();
        let source = old.join("cache/data");
        fs::write(&source, b"cache A").unwrap();
        let modified = fs::metadata(&source).unwrap().modified().unwrap();
        let mut progress = MigrationProgress {
            report: Box::new(move |update| {
                if update.verifying {
                    fs::write(&source, b"cache B").unwrap();
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&source)
                        .unwrap()
                        .set_times(
                            fs::FileTimes::new().set_modified(modified + Duration::from_secs(1)),
                        )
                        .unwrap();
                }
            }),
            ..Default::default()
        };
        assert_eq!(
            migrate_application_data(&old, &new, &mut progress)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(fs::read(old.join("cache/data")).unwrap(), b"cache B");
        assert!(!new.join(MIGRATION_MARKER).exists());
        assert_eq!(fs::read_dir(new.join("cache")).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancellation_removes_the_unfinished_file_and_retry_preserves_the_source() {
        let root = env::temp_dir().join(format!("locution-cancel-{}", Uuid::new_v4()));
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(old.join("cache")).unwrap();
        fs::write(old.join("cache/data"), b"legacy cache").unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation = cancelled.clone();
        let mut progress = MigrationProgress {
            cancelled,
            report: Box::new(move |update| {
                if !update.path.as_os_str().is_empty() {
                    cancellation.store(true, Ordering::Relaxed);
                }
            }),
            ..Default::default()
        };
        assert_eq!(
            migrate_application_data(&old, &new, &mut progress)
                .unwrap_err()
                .kind(),
            io::ErrorKind::Interrupted
        );
        assert!(!new.join(MIGRATION_MARKER).exists());
        assert_eq!(fs::read_dir(new.join("cache")).unwrap().count(), 0);
        assert_eq!(fs::read(old.join("cache/data")).unwrap(), b"legacy cache");
        let mut progress = MigrationProgress::default();
        migrate_application_data(&old, &new, &mut progress).unwrap();
        assert_eq!(progress.update.files, 1);
        assert_eq!(progress.update.bytes, b"legacy cache".len() as u64);
        assert_eq!(fs::read(new.join("cache/data")).unwrap(), b"legacy cache");
        assert!(new.join(MIGRATION_MARKER).exists());
        let old_profile = root.join("old-profile");
        let new_profile = root.join("new-profile");
        fs::create_dir_all(&old_profile).unwrap();
        fs::write(old_profile.join("Local Storage"), b"browser history").unwrap();
        progress.cancelled.store(false, Ordering::Relaxed);
        let cancellation = progress.cancelled.clone();
        progress.report = Box::new(move |_| cancellation.store(true, Ordering::Relaxed));
        progress.update.files = 0;
        assert_eq!(
            migrate_identity_directory(&old_profile, &new_profile, &mut progress)
                .unwrap_err()
                .kind(),
            io::ErrorKind::Interrupted
        );
        assert!(
            !new_profile.exists(),
            "A cancelled browser profile is never published"
        );
        assert!(!fs::read_dir(&root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("migration-")));
        migrate_identity_directory(
            &old_profile,
            &new_profile,
            &mut MigrationProgress::default(),
        )
        .unwrap();
        assert_eq!(
            fs::read(new_profile.join("Local Storage")).unwrap(),
            b"browser history"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_preserves_legacy_data_remaps_owned_paths_and_keeps_new_data() {
        let root = env::temp_dir().join(format!("locution-identity-{}", Uuid::new_v4()));
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(old.join("cache/LineCut Auto-Save")).unwrap();
        fs::create_dir_all(new.join("cache")).unwrap();
        fs::write(old.join("cache/existing"), b"old").unwrap();
        fs::write(new.join("cache/existing"), b"new").unwrap();
        fs::write(old.join("cache/LineCut Auto-Save/recovery.lcp"), b"project").unwrap();
        fs::write(old.join("linecut.exe"), b"do not migrate").unwrap();
        fs::write(old.join("WorkspaceConfig.xml"), b"workspace").unwrap();
        fs::write(
            old.join("installer-media-paths.ini"),
            b"ffmpeg_path=old.exe",
        )
        .unwrap();
        fs::write(new.join("installer-media-paths.ini"), b"").unwrap();
        fs::write(old.join("preferences.json"), serde_json::to_vec(&serde_json::json!({"cache_dir": old.join("cache"), "auto_save_dir": old.join("cache/LineCut Auto-Save"), "ffmpeg_path": "custom.exe"})).unwrap()).unwrap();
        migrate_application_data(&old, &new, &mut MigrationProgress::default()).unwrap();
        migrate_application_data(&old, &new, &mut MigrationProgress::default()).unwrap();
        assert_eq!(fs::read(new.join("cache/existing")).unwrap(), b"new");
        assert!(new
            .join("cache/Locution Pro Auto-Save/recovery.lcp")
            .exists());
        assert!(old.join("cache/LineCut Auto-Save/recovery.lcp").exists());
        assert!(!new.join("linecut.exe").exists());
        assert_eq!(
            fs::read(new.join("installer-media-paths.ini")).unwrap(),
            b""
        );
        assert_eq!(
            fs::metadata(old.join("WorkspaceConfig.xml"))
                .unwrap()
                .modified()
                .unwrap(),
            fs::metadata(new.join("WorkspaceConfig.xml"))
                .unwrap()
                .modified()
                .unwrap()
        );
        let prefs: serde_json::Value =
            serde_json::from_slice(&fs::read(new.join("preferences.json")).unwrap()).unwrap();
        assert_eq!(
            prefs["cache_dir"],
            new.join("cache").to_string_lossy().as_ref()
        );
        assert_eq!(
            Path::new(prefs["auto_save_dir"].as_str().unwrap()),
            new.join("cache").join("Locution Pro Auto-Save")
        );
        assert_eq!(prefs["ffmpeg_path"], "ffmpeg");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_migration_is_retryable_and_never_overwrites_current_preferences() {
        let root = env::temp_dir().join(format!("locution-identity-retry-{}", Uuid::new_v4()));
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(old.join("cache")).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(old.join("cache/data"), b"old cache").unwrap();
        fs::write(old.join("preferences.json"), b"{}").unwrap();
        fs::write(new.join("preferences.json"), b"current preferences").unwrap();
        fs::write(new.join("cache"), b"blocking file").unwrap();
        assert!(migrate_application_data(&old, &new, &mut MigrationProgress::default()).is_err());
        assert!(!new.join(MIGRATION_MARKER).exists());
        assert_eq!(fs::read(old.join("cache/data")).unwrap(), b"old cache");
        fs::remove_file(new.join("cache")).unwrap();
        migrate_application_data(&old, &new, &mut MigrationProgress::default()).unwrap();
        assert_eq!(fs::read(new.join("cache/data")).unwrap(), b"old cache");
        assert_eq!(
            fs::read(new.join("preferences.json")).unwrap(),
            b"current preferences"
        );
        assert!(new.join(MIGRATION_MARKER).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn custom_writable_paths_are_copied_and_profiles_are_not_merged() {
        let root = env::temp_dir().join(format!("locution-identity-{}", Uuid::new_v4()));
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(
            old.join("preferences.json"),
            serde_json::to_vec(&serde_json::json!({
                "cache_dir": "external/cache",
                "auto_save_dir": old.join("custom-saves")
            }))
            .unwrap(),
        )
        .unwrap();
        migrate_application_data(&old, &new, &mut MigrationProgress::default()).unwrap();
        let prefs: serde_json::Value =
            serde_json::from_slice(&fs::read(new.join("preferences.json")).unwrap()).unwrap();
        assert_eq!(
            Path::new(prefs["cache_dir"].as_str().unwrap()),
            new.join("cache")
        );
        assert_eq!(
            Path::new(prefs["auto_save_dir"].as_str().unwrap()),
            new.join("cache/Locution Pro Auto-Save")
        );
        fs::write(new.join("preferences.json"), b"current preferences").unwrap();
        migrate_application_data(&old, &new, &mut MigrationProgress::default()).unwrap();
        assert_eq!(
            fs::read(new.join("preferences.json")).unwrap(),
            b"current preferences"
        );
        let old_profile = root.join("old-profile");
        let new_profile = root.join("new-profile");
        fs::create_dir_all(&old_profile).unwrap();
        fs::write(old_profile.join("Local Storage"), b"history").unwrap();
        migrate_identity_directory(
            &old_profile,
            &new_profile,
            &mut MigrationProgress::default(),
        )
        .unwrap();
        fs::write(new_profile.join("Local Storage"), b"current history").unwrap();
        fs::write(old_profile.join("other db"), b"do not merge").unwrap();
        migrate_identity_directory(
            &old_profile,
            &new_profile,
            &mut MigrationProgress::default(),
        )
        .unwrap();
        assert!(!new_profile.join("other db").exists());
        assert_eq!(
            fs::read(new_profile.join("Local Storage")).unwrap(),
            b"current history"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
