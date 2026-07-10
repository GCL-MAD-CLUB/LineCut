use super::*;

pub(crate) fn config_root() -> PathBuf {
    if let Some(value) = env::var_os("LINECUT_DATA_DIR") {
        return PathBuf::from(value);
    }
    if cfg!(windows) {
        if let Some(value) = env::var_os("LOCALAPPDATA") {
            return PathBuf::from(value).join("LineCut");
        }
    }
    if let Some(value) = env::var_os("HOME") {
        return PathBuf::from(value).join(".linecut");
    }
    env::temp_dir().join("linecut")
}

pub(crate) fn default_cache_root() -> PathBuf {
    config_root().join("cache")
}

pub(crate) fn default_export_root() -> PathBuf {
    config_root().join("exports")
}

pub(crate) fn configured_cache_root(preferences: &Preferences) -> PathBuf {
    path_or_default(&preferences.cache_dir, default_cache_root())
}

pub(crate) fn configured_export_root(preferences: &Preferences) -> PathBuf {
    path_or_default(&preferences.default_export_dir, default_export_root())
}

pub(crate) fn path_or_default(value: &str, default_path: PathBuf) -> PathBuf {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        default_path
    } else {
        PathBuf::from(trimmed)
    }
}

pub(crate) fn preferences_file() -> PathBuf {
    config_root().join("preferences.json")
}

pub(crate) fn load_preferences() -> Result<Preferences, String> {
    clear_cache_when_version_changes();
    let path = preferences_file();
    if !path.exists() {
        return Ok(installer_media_preferences(Preferences::default()));
    }
    let body = fs::read_to_string(&path).map_err(|e| format!("读取首选项失败: {e}"))?;
    let preferences =
        serde_json::from_str::<Preferences>(&body).map_err(|e| format!("解析首选项失败: {e}"))?;
    normalize_preferences(preferences)
}

/// Cache data is an implementation detail and must not survive an application version change.
/// The marker lives beside the cache, so preferences, projects, and exports remain untouched.
fn clear_cache_when_version_changes() {
    let root = config_root();
    let marker = root.join("cache-version");
    let current_version = env!("CARGO_PKG_VERSION");
    let previous_version = fs::read_to_string(&marker).ok();

    if previous_version.as_deref().map(str::trim) != Some(current_version) {
        let cache = root.join("cache");
        if cache.exists() {
            let _ = fs::remove_dir_all(&cache);
        }
        let _ = fs::create_dir_all(&root);
        let _ = fs::write(marker, current_version);
    }
}

/// Applies the media tool paths selected by the Windows NSIS installer.
///
/// The installer deliberately writes this small line-oriented file instead of JSON so a
/// Windows path does not require JSON escaping in the installer script. A normal user
/// preference file always takes precedence after it has been saved by the application.
fn installer_media_preferences(mut preferences: Preferences) -> Preferences {
    let path = config_root().join("installer-media-paths.ini");
    let Ok(contents) = fs::read_to_string(path) else {
        return preferences;
    };

    for line in contents.lines() {
        if let Some(value) = line.strip_prefix("ffmpeg_path=") {
            if !value.trim().is_empty() {
                preferences.ffmpeg_path = value.trim().to_string();
            }
        } else if let Some(value) = line.strip_prefix("ffprobe_path=") {
            if !value.trim().is_empty() {
                preferences.ffprobe_path = value.trim().to_string();
            }
        }
    }

    preferences
}

pub(crate) fn normalize_preferences(preferences: Preferences) -> Result<Preferences, String> {
    let default_preferences = Preferences::default();
    let normalized = Preferences {
        cache_dir: if preferences.cache_dir.trim().is_empty() {
            default_preferences.cache_dir
        } else {
            preferences.cache_dir.trim().to_string()
        },
        default_export_dir: if preferences.default_export_dir.trim().is_empty() {
            default_preferences.default_export_dir
        } else {
            preferences.default_export_dir.trim().to_string()
        },
        ffmpeg_path: if preferences.ffmpeg_path.trim().is_empty() {
            default_preferences.ffmpeg_path
        } else {
            preferences.ffmpeg_path.trim().to_string()
        },
        ffprobe_path: if preferences.ffprobe_path.trim().is_empty() {
            default_preferences.ffprobe_path
        } else {
            preferences.ffprobe_path.trim().to_string()
        },
    };

    fs::create_dir_all(configured_cache_root(&normalized))
        .map_err(|e| format!("创建缓存目录失败: {e}"))?;
    fs::create_dir_all(configured_export_root(&normalized))
        .map_err(|e| format!("创建默认导出目录失败: {e}"))?;

    Ok(normalized)
}

pub(crate) fn save_preferences(preferences: &Preferences) -> Result<(), String> {
    fs::create_dir_all(config_root()).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let body =
        serde_json::to_vec_pretty(preferences).map_err(|e| format!("序列化首选项失败: {e}"))?;
    fs::write(preferences_file(), body).map_err(|e| format!("保存首选项失败: {e}"))
}

pub(crate) fn ffmpeg_program(preferences: &Preferences) -> String {
    configured_media_program(&preferences.ffmpeg_path, DEFAULT_FFMPEG_PROGRAM)
}

pub(crate) fn ffprobe_program(preferences: &Preferences) -> String {
    configured_media_program(&preferences.ffprobe_path, DEFAULT_FFPROBE_PROGRAM)
}

pub(crate) fn configured_media_program(configured: &str, default_program: &str) -> String {
    let trimmed = configured.trim();
    if !is_default_media_program(trimmed, default_program) {
        return trimmed.to_string();
    }

    bundled_media_program(default_program)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| default_program.to_string())
}

pub(crate) fn is_default_media_program(value: &str, default_program: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let lower = value.to_ascii_lowercase();
    lower == default_program || lower == format!("{default_program}.exe")
}

pub(crate) fn bundled_media_program(program: &str) -> Option<PathBuf> {
    bundled_media_program_candidates(program)
        .into_iter()
        .find(|path| path.is_file())
}

pub(crate) fn bundled_media_program_candidates(program: &str) -> Vec<PathBuf> {
    let executable = platform_executable_name(program);
    let sidecar_executable = sidecar_executable_name(program);
    let mut candidates = Vec::new();

    if let Ok(current_exe) = env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            candidates.push(dir.join(&executable));
            candidates.push(dir.join(&sidecar_executable));
            candidates.push(dir.join("bin").join(&executable));
            candidates.push(dir.join("bin").join(&sidecar_executable));
        }
    }

    if let Ok(current_dir) = env::current_dir() {
        candidates.push(current_dir.join("bin").join(&sidecar_executable));
        candidates.push(current_dir.join("bin").join(&executable));
        candidates.push(
            current_dir
                .join("src-tauri")
                .join("bin")
                .join(&sidecar_executable),
        );
        candidates.push(current_dir.join("src-tauri").join("bin").join(&executable));
    }

    candidates
}

pub(crate) fn platform_executable_name(program: &str) -> String {
    #[cfg(windows)]
    {
        format!("{program}.exe")
    }
    #[cfg(not(windows))]
    {
        program.to_string()
    }
}

pub(crate) fn sidecar_executable_name(program: &str) -> String {
    let target = sidecar_target_triple();
    #[cfg(windows)]
    {
        format!("{program}-{target}.exe")
    }
    #[cfg(not(windows))]
    {
        format!("{program}-{target}")
    }
}

pub(crate) fn sidecar_target_triple() -> &'static str {
    if cfg!(all(windows, target_arch = "x86_64", target_env = "msvc")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(windows, target_arch = "aarch64", target_env = "msvc")) {
        "aarch64-pc-windows-msvc"
    } else if cfg!(all(windows, target_arch = "x86", target_env = "msvc")) {
        "i686-pc-windows-msvc"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else {
        ""
    }
}

pub(crate) fn save_project(project: &Project) -> Result<(), String> {
    let dir = config_root().join("projects");
    fs::create_dir_all(&dir).map_err(|e| format!("创建项目目录失败: {e}"))?;
    let path = dir.join(format!("{}.json", project.asset.id));
    let body = serde_json::to_vec_pretty(project).map_err(|e| format!("序列化项目失败: {e}"))?;
    fs::write(path, body).map_err(|e| format!("保存项目失败: {e}"))
}

pub(crate) async fn save_project_async(
    project: Project,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    spawn_blocking_cancellable(cancel, "保存项目", move |_| save_project(&project)).await
}
