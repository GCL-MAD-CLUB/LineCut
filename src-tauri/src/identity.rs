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
const MIGRATION_MARKER: &str = ".locution-pro-migration-v1";

pub(crate) fn data_roots() -> (PathBuf, PathBuf) {
    if let Some(current) = env::var_os("LOCUTION_PRO_DATA_DIR") {
        let legacy = env::var_os("LINECUT_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| default_data_roots().1);
        return (PathBuf::from(current), legacy);
    }
    // An explicitly configured directory is user-owned; retain it even for the old alias.
    if let Some(value) = env::var_os("LINECUT_DATA_DIR") {
        let path = PathBuf::from(value);
        return (path.clone(), path);
    }
    default_data_roots()
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
) -> io::Result<()> {
    if let Some(path) = progress_file {
        return progress::run(path, cancel_file);
    }
    migrate_all(&mut MigrationProgress {
        cancel_file,
        ..Default::default()
    })
}

fn migrate_all(progress: &mut MigrationProgress) -> io::Result<()> {
    let (current, legacy) = data_roots();
    progress.phase("正在迁移设置、自动保存和缓存")?;
    migrate_application_data(&legacy, &current, progress)?;
    // Tauri stores WebView2 profiles in LocalData/<identifier>; Roaming holds app logs/data.
    #[cfg(windows)]
    for variable in ["LOCALAPPDATA", "APPDATA"] {
        if let Some(parent) = env::var_os(variable) {
            progress.phase("正在迁移浏览器历史和工作区数据")?;
            let parent = PathBuf::from(parent);
            migrate_identity_directory(
                &parent.join(LEGACY_APPLICATION_ID),
                &parent.join(APPLICATION_ID),
                progress,
            )?;
        }
    }
    progress.phase("数据迁移完成")
}

fn migrate_application_data(
    legacy: &Path,
    current: &Path,
    progress: &mut MigrationProgress,
) -> io::Result<()> {
    if current == legacy || current.join(MIGRATION_MARKER).exists() {
        return Ok(());
    }
    fs::create_dir_all(current)?;
    // The old data root can also be the installation directory. Never copy executables/models.
    for name in [
        "cache",
        "cache-version",
        "WorkspaceConfig.xml",
        "StillExport.json",
        "installer-media-paths.ini",
        "LineCut Auto-Save",
        "Locution Pro Auto-Save",
    ] {
        let new_name = if name == "LineCut Auto-Save" {
            "Locution Pro Auto-Save"
        } else {
            name
        };
        copy_missing(&legacy.join(name), &current.join(new_name), progress)?;
    }
    let preferences = legacy.join("preferences.json");
    let destination = current.join("preferences.json");
    if !destination.exists() && preferences.is_file() {
        let mut document: serde_json::Value = serde_json::from_slice(&fs::read(&preferences)?)?;
        for field in ["cache_dir", "auto_save_dir"] {
            if let Some(value) = document.get_mut(field) {
                if let Some(path) = value.as_str() {
                    if let Ok(suffix) = Path::new(path).strip_prefix(legacy) {
                        // Only remap trees copied above. A custom directory under the old
                        // installation, or a symlink into external storage, stays user-owned.
                        let owned = suffix.components().next().is_some_and(|part| {
                            ["cache", "LineCut Auto-Save", "Locution Pro Auto-Save"]
                                .iter()
                                .any(|name| part.as_os_str() == *name)
                        });
                        let mut source = legacy.to_path_buf();
                        let linked = suffix.components().any(|part| {
                            source.push(part);
                            fs::symlink_metadata(&source)
                                .is_ok_and(|metadata| metadata.file_type().is_symlink())
                        });
                        if !owned || linked {
                            continue;
                        }
                        let mut remapped = current.to_path_buf();
                        for part in suffix.components() {
                            remapped.push(if part.as_os_str() == "LineCut Auto-Save" {
                                std::ffi::OsStr::new("Locution Pro Auto-Save")
                            } else {
                                part.as_os_str()
                            });
                        }
                        *value = serde_json::Value::String(remapped.to_string_lossy().into_owned());
                    }
                }
            }
        }
        publish_missing(&destination, &serde_json::to_vec_pretty(&document)?)?;
    }
    progress.check_cancelled()?;
    publish_missing(&current.join(MIGRATION_MARKER), b"1")
}

#[cfg(any(windows, test))]
fn migrate_identity_directory(
    legacy: &Path,
    current: &Path,
    progress: &mut MigrationProgress,
) -> io::Result<()> {
    // A WebView profile is a unit: merging individual Chromium database files is unsafe.
    if !legacy.is_dir() || current.exists() {
        return Ok(());
    }
    let staged = current.with_extension(format!("migration-{}", Uuid::new_v4()));
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
        assert_eq!(prefs["ffmpeg_path"], "custom.exe");
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
    fn existing_preferences_and_profiles_win_and_custom_paths_are_unchanged() {
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
        assert_eq!(prefs["cache_dir"], "external/cache");
        assert_eq!(
            Path::new(prefs["auto_save_dir"].as_str().unwrap()),
            old.join("custom-saves")
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
