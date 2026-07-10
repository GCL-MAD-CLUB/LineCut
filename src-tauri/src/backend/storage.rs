use super::*;

const PROJECT_EXTENSION: &str = "lcp";
const PROJECT_MAGIC: &[u8; 8] = b"LINECUT\0";
const PROJECT_FORMAT_VERSION: u16 = 1;
const PROJECT_HEADER_LEN: usize = 8 + 2 + 2 + 8 + 32;
const MAX_PROJECT_PAYLOAD_LEN: usize = 512 * 1024 * 1024;

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

pub(crate) fn normalize_project_path(path: &str) -> Result<PathBuf, String> {
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

fn encode_project_document(document: &ProjectDocument) -> Result<Vec<u8>, String> {
    let payload = bincode::serialize(document).map_err(|e| format!("序列化项目失败: {e}"))?;
    if payload.len() > MAX_PROJECT_PAYLOAD_LEN {
        return Err("项目数据过大，无法保存".to_string());
    }
    let checksum = Sha256::digest(&payload);
    let mut bytes = Vec::with_capacity(PROJECT_HEADER_LEN + payload.len());
    bytes.extend_from_slice(PROJECT_MAGIC);
    bytes.extend_from_slice(&PROJECT_FORMAT_VERSION.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&checksum);
    bytes.extend_from_slice(&payload);
    Ok(bytes)
}

fn decode_project_document(bytes: &[u8]) -> Result<ProjectDocument, String> {
    if bytes.len() < PROJECT_HEADER_LEN || &bytes[..8] != PROJECT_MAGIC {
        return Err("不是有效的 LineCut 项目文件".to_string());
    }
    let version = u16::from_le_bytes([bytes[8], bytes[9]]);
    if version != PROJECT_FORMAT_VERSION {
        return Err(format!(
            "不支持的项目文件版本 {version}，当前支持版本为 {PROJECT_FORMAT_VERSION}"
        ));
    }
    let payload_len = u64::from_le_bytes(
        bytes[12..20]
            .try_into()
            .map_err(|_| "项目文件头损坏".to_string())?,
    );
    if payload_len > MAX_PROJECT_PAYLOAD_LEN as u64
        || payload_len as usize != bytes.len() - PROJECT_HEADER_LEN
    {
        return Err("项目文件长度校验失败".to_string());
    }
    let payload = &bytes[PROJECT_HEADER_LEN..];
    if Sha256::digest(payload).as_slice() != &bytes[20..52] {
        return Err("项目文件完整性校验失败".to_string());
    }
    bincode::deserialize(payload).map_err(|e| format!("解析项目文件失败: {e}"))
}

pub(crate) fn write_project_file(path: &Path, project: Option<Project>) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|e| format!("创建项目目录失败: {e}"))?;
    let document = ProjectDocument {
        project,
        saved_at: now_millis() as u64,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    let bytes = encode_project_document(&document)?;
    let write_id = Uuid::new_v4();
    let temporary_path = path.with_extension(format!("{PROJECT_EXTENSION}.{write_id}.tmp"));
    fs::write(&temporary_path, bytes).map_err(|e| format!("写入项目文件失败: {e}"))?;

    if path.exists() {
        let backup_path = path.with_extension(format!("{PROJECT_EXTENSION}.{write_id}.bak"));
        fs::rename(path, &backup_path).map_err(|e| {
            let _ = fs::remove_file(&temporary_path);
            format!("备份旧项目文件失败: {e}")
        })?;
        if let Err(error) = fs::rename(&temporary_path, path) {
            let _ = fs::rename(&backup_path, path);
            let _ = fs::remove_file(&temporary_path);
            return Err(format!("完成项目文件保存失败: {error}"));
        }
        let _ = fs::remove_file(backup_path);
        return Ok(());
    }
    fs::rename(&temporary_path, path).map_err(|e| {
        let _ = fs::remove_file(&temporary_path);
        format!("完成项目文件保存失败: {e}")
    })
}

pub(crate) fn read_project_file(path: &Path) -> Result<ProjectDocument, String> {
    if !path.is_file() {
        return Err(format!("项目文件不存在: {}", path.to_string_lossy()));
    }
    let bytes = fs::read(path).map_err(|e| format!("读取项目文件失败: {e}"))?;
    decode_project_document(&bytes)
}

#[cfg(test)]
mod project_file_tests {
    use super::*;

    #[test]
    fn project_document_is_binary_and_round_trips() {
        let document = ProjectDocument {
            project: None,
            saved_at: 42,
            app_version: "test".to_string(),
        };
        let bytes = encode_project_document(&document).expect("encode project");
        assert_eq!(&bytes[..8], PROJECT_MAGIC);
        assert_ne!(bytes.first(), Some(&b'{'));
        let decoded = decode_project_document(&bytes).expect("decode project");
        assert_eq!(decoded.saved_at, 42);
        assert_eq!(decoded.app_version, "test");
        assert!(decoded.project.is_none());
    }

    #[test]
    fn project_document_rejects_corrupted_payload() {
        let document = ProjectDocument {
            project: None,
            saved_at: 42,
            app_version: "test".to_string(),
        };
        let mut bytes = encode_project_document(&document).expect("encode project");
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        assert!(decode_project_document(&bytes).is_err());
    }
}
