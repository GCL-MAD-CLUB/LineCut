use super::*;

const PROJECT_EXTENSION: &str = "lcp";
const PROJECT_MAGIC: &[u8; 8] = b"LINECUT\0";
const LEGACY_PROJECT_FORMAT_VERSION: u16 = 1;
const WORKSPACE_PROJECT_FORMAT_VERSION: u16 = 2;
const PROJECT_FORMAT_VERSION: u16 = 3;
const PROJECT_HEADER_LEN: usize = 8 + 2 + 2 + 8 + 32;
const MAX_PROJECT_PAYLOAD_LEN: usize = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MediaBinItemV2 {
    id: String,
    kind: MediaBinItemKind,
    path: String,
    file_name: String,
    duration_us: i64,
    start_time_us: i64,
    bound_to_video_id: Option<String>,
    source_video_id: Option<String>,
    stream_index: Option<i32>,
    subtitle_track_id: Option<String>,
    codec: Option<String>,
    language: Option<String>,
    extracted: bool,
    origin: MediaBinItemOrigin,
    color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectMediaBinStateV2 {
    items: Vec<MediaBinItemV2>,
    read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectWorkspaceV2 {
    projects: Vec<Project>,
    media_bin: ProjectMediaBinStateV2,
    editor: ProjectEditorState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectDocumentV2 {
    workspace: ProjectWorkspaceV2,
    saved_at: u64,
    app_version: String,
}

impl From<MediaBinItemV2> for MediaBinItem {
    fn from(item: MediaBinItemV2) -> Self {
        Self {
            id: item.id,
            kind: item.kind,
            enabled: true,
            hidden: false,
            path: item.path,
            file_name: item.file_name,
            duration_us: item.duration_us,
            start_time_us: item.start_time_us,
            bound_to_video_id: item.bound_to_video_id,
            source_video_id: item.source_video_id,
            stream_index: item.stream_index,
            subtitle_track_id: item.subtitle_track_id,
            codec: item.codec,
            language: item.language,
            extracted: item.extracted,
            origin: item.origin,
            color: item.color,
        }
    }
}

impl From<ProjectDocumentV2> for ProjectDocument {
    fn from(document: ProjectDocumentV2) -> Self {
        Self {
            workspace: ProjectWorkspace {
                projects: document.workspace.projects,
                media_bin: ProjectMediaBinState {
                    items: document
                        .workspace
                        .media_bin
                        .items
                        .into_iter()
                        .map(MediaBinItem::from)
                        .collect(),
                    read_only: document.workspace.media_bin.read_only,
                },
                editor: document.workspace.editor,
            },
            saved_at: document.saved_at,
            app_version: document.app_version,
        }
    }
}

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

fn wrap_project_payload(payload: &[u8], version: u16) -> Result<Vec<u8>, String> {
    if payload.len() > MAX_PROJECT_PAYLOAD_LEN {
        return Err("项目数据过大，无法保存".to_string());
    }
    let checksum = Sha256::digest(payload);
    let mut bytes = Vec::with_capacity(PROJECT_HEADER_LEN + payload.len());
    bytes.extend_from_slice(PROJECT_MAGIC);
    bytes.extend_from_slice(&version.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&checksum);
    bytes.extend_from_slice(payload);
    Ok(bytes)
}

fn encode_project_document(document: &ProjectDocument) -> Result<Vec<u8>, String> {
    let payload = bincode::serialize(document).map_err(|e| format!("序列化项目失败: {e}"))?;
    wrap_project_payload(&payload, PROJECT_FORMAT_VERSION)
}

fn imported_project_item(project: &Project) -> MediaBinItem {
    let is_video = project.asset.video_stream_index.is_some();
    let has_audio = project.asset.audio_stream_index.is_some();
    let codec_type = if is_video { "video" } else { "audio" };
    let stream = project
        .streams
        .iter()
        .find(|stream| stream.codec_type == codec_type);
    MediaBinItem {
        id: project.asset.id.clone(),
        kind: if is_video {
            MediaBinItemKind::Video
        } else {
            MediaBinItemKind::Audio
        },
        enabled: true,
        hidden: false,
        path: project.asset.path.clone(),
        file_name: project.asset.file_name.clone(),
        duration_us: project.asset.duration_us,
        start_time_us: project.asset.start_time_us,
        bound_to_video_id: None,
        source_video_id: None,
        stream_index: if is_video {
            project.asset.video_stream_index
        } else {
            project.asset.audio_stream_index
        },
        subtitle_track_id: None,
        codec: stream.map(|stream| stream.codec_name.clone()),
        language: stream.and_then(|stream| stream.language.clone()),
        extracted: false,
        origin: MediaBinItemOrigin::Imported,
        color: if is_video && has_audio {
            "#004b67"
        } else if is_video {
            "#3e0aae"
        } else {
            "#2a5507"
        }
        .to_string(),
    }
}

fn imported_external_subtitle_items(project: &Project) -> Vec<MediaBinItem> {
    project
        .tracks
        .iter()
        .filter(|track| {
            matches!(&track.source_type, SubtitleSourceType::External)
                && track.source_path.is_some()
        })
        .map(|track| {
            let path = track.source_path.clone().unwrap_or_default();
            let file_name = Path::new(&path)
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_owned)
                .or_else(|| track.title.clone())
                .unwrap_or_else(|| "字幕".to_string());
            MediaBinItem {
                id: format!("subtitle:{}", track.id),
                kind: MediaBinItemKind::Subtitle,
                enabled: true,
                hidden: false,
                path,
                file_name,
                duration_us: project.asset.duration_us,
                start_time_us: 0,
                bound_to_video_id: Some(project.asset.id.clone()),
                source_video_id: None,
                stream_index: track.stream_index,
                subtitle_track_id: Some(track.id.clone()),
                codec: Some(track.codec.clone()),
                language: track.language.clone(),
                extracted: false,
                origin: MediaBinItemOrigin::Imported,
                color: "#893a04".to_string(),
            }
        })
        .collect()
}

fn workspace_from_legacy_project(project: Option<Project>) -> ProjectWorkspace {
    let Some(project) = project else {
        return ProjectWorkspace {
            projects: Vec::new(),
            media_bin: ProjectMediaBinState {
                items: Vec::new(),
                read_only: false,
            },
            editor: ProjectEditorState {
                active_video_id: String::new(),
                active_track_id: String::new(),
                selected_cue_ids: Vec::new(),
                detached_video_ids: Vec::new(),
                preview: ProjectPreviewState { use_proxy: false },
            },
        };
    };

    let active_video_id = project.asset.id.clone();
    let active_track_id = project
        .tracks
        .iter()
        .find(|track| track.cue_count > 0)
        .or_else(|| project.tracks.first())
        .map(|track| track.id.clone())
        .unwrap_or_default();
    let mut items = vec![imported_project_item(&project)];
    items.extend(imported_external_subtitle_items(&project));
    ProjectWorkspace {
        projects: vec![project],
        media_bin: ProjectMediaBinState {
            items,
            read_only: false,
        },
        editor: ProjectEditorState {
            active_video_id,
            active_track_id,
            selected_cue_ids: Vec::new(),
            detached_video_ids: Vec::new(),
            preview: ProjectPreviewState { use_proxy: false },
        },
    }
}

fn decode_project_document(bytes: &[u8]) -> Result<ProjectDocument, String> {
    if bytes.len() < PROJECT_HEADER_LEN || &bytes[..8] != PROJECT_MAGIC {
        return Err("不是有效的 LineCut 项目文件".to_string());
    }
    let version = u16::from_le_bytes([bytes[8], bytes[9]]);
    if version != PROJECT_FORMAT_VERSION
        && version != WORKSPACE_PROJECT_FORMAT_VERSION
        && version != LEGACY_PROJECT_FORMAT_VERSION
    {
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
    if version == LEGACY_PROJECT_FORMAT_VERSION {
        let legacy: LegacyProjectDocument =
            bincode::deserialize(payload).map_err(|e| format!("解析旧版项目文件失败: {e}"))?;
        return Ok(ProjectDocument {
            workspace: workspace_from_legacy_project(legacy.project),
            saved_at: legacy.saved_at,
            app_version: legacy.app_version,
        });
    }
    if version == WORKSPACE_PROJECT_FORMAT_VERSION {
        let workspace_document: ProjectDocumentV2 = bincode::deserialize(payload)
            .map_err(|e| format!("解析旧版工作区项目文件失败: {e}"))?;
        return Ok(workspace_document.into());
    }
    bincode::deserialize(payload).map_err(|e| format!("解析项目文件失败: {e}"))
}

pub(crate) fn write_project_file(path: &Path, workspace: ProjectWorkspace) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|e| format!("创建项目目录失败: {e}"))?;
    let document = ProjectDocument {
        workspace,
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
        let mut workspace = workspace_from_legacy_project(None);
        workspace.media_bin.read_only = true;
        workspace.media_bin.items.push(MediaBinItem {
            id: "audio-1".to_string(),
            kind: MediaBinItemKind::Audio,
            enabled: false,
            hidden: true,
            path: "audio.wav".to_string(),
            file_name: "旁白".to_string(),
            duration_us: 2_000_000,
            start_time_us: 0,
            bound_to_video_id: Some("video-1".to_string()),
            source_video_id: None,
            stream_index: Some(0),
            subtitle_track_id: None,
            codec: Some("pcm_s16le".to_string()),
            language: Some("zh".to_string()),
            extracted: false,
            origin: MediaBinItemOrigin::Imported,
            color: "#2a5507".to_string(),
        });
        let document = ProjectDocument {
            workspace,
            saved_at: 42,
            app_version: "test".to_string(),
        };
        let bytes = encode_project_document(&document).expect("encode project");
        assert_eq!(&bytes[..8], PROJECT_MAGIC);
        assert_ne!(bytes.first(), Some(&b'{'));
        let decoded = decode_project_document(&bytes).expect("decode project");
        assert_eq!(decoded.saved_at, 42);
        assert_eq!(decoded.app_version, "test");
        assert!(decoded.workspace.projects.is_empty());
        assert!(decoded.workspace.media_bin.read_only);
        assert_eq!(decoded.workspace.media_bin.items.len(), 1);
        assert!(!decoded.workspace.media_bin.items[0].enabled);
        assert!(decoded.workspace.media_bin.items[0].hidden);
        assert_eq!(
            decoded.workspace.media_bin.items[0].origin,
            MediaBinItemOrigin::Imported
        );
        assert_eq!(
            decoded.workspace.media_bin.items[0]
                .bound_to_video_id
                .as_deref(),
            Some("video-1")
        );
    }

    #[test]
    fn project_document_rejects_corrupted_payload() {
        let document = ProjectDocument {
            workspace: workspace_from_legacy_project(None),
            saved_at: 42,
            app_version: "test".to_string(),
        };
        let mut bytes = encode_project_document(&document).expect("encode project");
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        assert!(decode_project_document(&bytes).is_err());
    }

    #[test]
    fn legacy_project_document_migrates_to_workspace() {
        let legacy = LegacyProjectDocument {
            project: None,
            saved_at: 41,
            app_version: "legacy".to_string(),
        };
        let payload = bincode::serialize(&legacy).expect("serialize legacy project");
        let bytes = wrap_project_payload(&payload, LEGACY_PROJECT_FORMAT_VERSION)
            .expect("wrap legacy project");
        let decoded = decode_project_document(&bytes).expect("decode legacy project");

        assert_eq!(decoded.saved_at, 41);
        assert_eq!(decoded.app_version, "legacy");
        assert!(decoded.workspace.projects.is_empty());
        assert!(!decoded.workspace.media_bin.read_only);
    }

    #[test]
    fn workspace_v2_project_document_defaults_media_visibility_and_enabled_state() {
        let workspace = workspace_from_legacy_project(None);
        let document = ProjectDocumentV2 {
            workspace: ProjectWorkspaceV2 {
                projects: Vec::new(),
                media_bin: ProjectMediaBinStateV2 {
                    items: vec![MediaBinItemV2 {
                        id: "audio-v2".to_string(),
                        kind: MediaBinItemKind::Audio,
                        path: "audio-v2.wav".to_string(),
                        file_name: "旧版音频".to_string(),
                        duration_us: 1_000_000,
                        start_time_us: 0,
                        bound_to_video_id: None,
                        source_video_id: None,
                        stream_index: Some(0),
                        subtitle_track_id: None,
                        codec: Some("pcm_s16le".to_string()),
                        language: None,
                        extracted: false,
                        origin: MediaBinItemOrigin::Imported,
                        color: "#2a5507".to_string(),
                    }],
                    read_only: false,
                },
                editor: workspace.editor,
            },
            saved_at: 43,
            app_version: "v2".to_string(),
        };
        let payload = bincode::serialize(&document).expect("serialize v2 project");
        let bytes = wrap_project_payload(&payload, WORKSPACE_PROJECT_FORMAT_VERSION)
            .expect("wrap v2 project");
        let decoded = decode_project_document(&bytes).expect("decode v2 project");

        assert_eq!(decoded.saved_at, 43);
        assert_eq!(decoded.workspace.media_bin.items.len(), 1);
        assert!(decoded.workspace.media_bin.items[0].enabled);
        assert!(!decoded.workspace.media_bin.items[0].hidden);
    }
}
