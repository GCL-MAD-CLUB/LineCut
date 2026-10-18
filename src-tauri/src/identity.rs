//! Product identity migration runs before Tauri creates the WebView or opens application state.
use std::{
    env, fs, io,
    path::{Path, PathBuf},
};
use uuid::Uuid;

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

pub(crate) fn prepare() -> io::Result<()> {
    let (current, legacy) = data_roots();
    migrate_application_data(&legacy, &current)?;
    // Tauri stores WebView2 profiles in LocalData/<identifier>; Roaming holds app logs/data.
    #[cfg(windows)]
    for variable in ["LOCALAPPDATA", "APPDATA"] {
        if let Some(parent) = env::var_os(variable) {
            let parent = PathBuf::from(parent);
            migrate_identity_directory(
                &parent.join(LEGACY_APPLICATION_ID),
                &parent.join(APPLICATION_ID),
            )?;
        }
    }
    Ok(())
}

fn migrate_application_data(legacy: &Path, current: &Path) -> io::Result<()> {
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
        copy_missing(&legacy.join(name), &current.join(new_name))?;
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
    publish_missing(&current.join(MIGRATION_MARKER), b"1")
}

#[cfg(any(windows, test))]
fn migrate_identity_directory(legacy: &Path, current: &Path) -> io::Result<()> {
    // A WebView profile is a unit: merging individual Chromium database files is unsafe.
    if !legacy.is_dir() || current.exists() {
        return Ok(());
    }
    let staged = current.with_extension(format!("migration-{}", Uuid::new_v4()));
    let result = copy_missing(legacy, &staged).and_then(|()| fs::rename(&staged, current));
    if result.is_err() {
        let _ = fs::remove_dir_all(&staged);
    }
    result
}

fn copy_missing(source: &Path, destination: &Path) -> io::Result<()> {
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
            copy_missing(&entry.path(), &destination.join(name))?;
        }
    } else if !destination.exists() {
        let staged = destination.with_extension(format!("migration-{}", Uuid::new_v4()));
        let result = (|| {
            let mut input = fs::File::open(source)?;
            let mut output = fs::File::create(&staged)?;
            io::copy(&mut input, &mut output)?;
            if let Ok(modified) = metadata.modified() {
                output.set_times(fs::FileTimes::new().set_modified(modified))?;
            }
            drop(output);
            publish_staged(&staged, destination)
        })();
        let _ = fs::remove_file(&staged);
        result?;
    }
    Ok(())
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
        migrate_application_data(&old, &new).unwrap();
        migrate_application_data(&old, &new).unwrap();
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
        assert!(migrate_application_data(&old, &new).is_err());
        assert!(!new.join(MIGRATION_MARKER).exists());
        assert_eq!(fs::read(old.join("cache/data")).unwrap(), b"old cache");
        fs::remove_file(new.join("cache")).unwrap();
        migrate_application_data(&old, &new).unwrap();
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
        migrate_application_data(&old, &new).unwrap();
        let prefs: serde_json::Value =
            serde_json::from_slice(&fs::read(new.join("preferences.json")).unwrap()).unwrap();
        assert_eq!(prefs["cache_dir"], "external/cache");
        assert_eq!(
            Path::new(prefs["auto_save_dir"].as_str().unwrap()),
            old.join("custom-saves")
        );
        fs::write(new.join("preferences.json"), b"current preferences").unwrap();
        migrate_application_data(&old, &new).unwrap();
        assert_eq!(
            fs::read(new.join("preferences.json")).unwrap(),
            b"current preferences"
        );
        let old_profile = root.join("old-profile");
        let new_profile = root.join("new-profile");
        fs::create_dir_all(&old_profile).unwrap();
        fs::write(old_profile.join("Local Storage"), b"history").unwrap();
        migrate_identity_directory(&old_profile, &new_profile).unwrap();
        fs::write(new_profile.join("Local Storage"), b"current history").unwrap();
        fs::write(old_profile.join("other db"), b"do not merge").unwrap();
        migrate_identity_directory(&old_profile, &new_profile).unwrap();
        assert!(!new_profile.join("other db").exists());
        assert_eq!(
            fs::read(new_profile.join("Local Storage")).unwrap(),
            b"current history"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
