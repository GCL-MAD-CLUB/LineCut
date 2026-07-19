use encoding_rs::{BIG5, GBK, SHIFT_JIS, WINDOWS_1252};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::Command as StdCommand;
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

mod backend;
mod error;
mod project_file;

use backend::*;
use error::*;

const HEAD_TAIL_HASH_BYTES: u64 = 1024 * 1024;
const FFMPEG_PROGRESS_EVENT: &str = "ffmpeg-progress";
const PROXY_FILE_NAME: &str = "proxy_preview_i.mp4";
const DEFAULT_FFMPEG_PROGRAM: &str = "ffmpeg";
const DEFAULT_FFPROBE_PROGRAM: &str = "ffprobe";
const PROJECT_FILE_EXTENSION: &str = "lcp";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct AppState {
    projects: Mutex<HashMap<String, Project>>,
    preferences: Mutex<Preferences>,
    startup_preferences_error: Mutex<Option<AppError>>,
    launch_project_path: Mutex<Option<String>>,
    running_tasks: Mutex<HashMap<String, RunningTask>>,
    running_ffmpeg: Mutex<HashMap<String, RunningFfmpeg>>,
}

impl AppState {
    fn new() -> Self {
        Self::from_preferences_result(load_preferences())
    }

    fn from_preferences_result(result: AppResult<Preferences>) -> Self {
        let (preferences, startup_preferences_error) = match result {
            Ok(preferences) => (preferences, None),
            Err(error) => (Preferences::default(), Some(error)),
        };
        Self {
            projects: Mutex::new(HashMap::new()),
            preferences: Mutex::new(preferences),
            startup_preferences_error: Mutex::new(startup_preferences_error),
            launch_project_path: Mutex::new(project_path_from_launch_args()),
            running_tasks: Mutex::new(HashMap::new()),
            running_ffmpeg: Mutex::new(HashMap::new()),
        }
    }
}

fn project_path_from_launch_args() -> Option<String> {
    env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case(PROJECT_FILE_EXTENSION))
        })
        .map(|path| path.to_string_lossy().into_owned())
}

#[derive(Clone)]
struct RunningTask {
    cancel: Arc<AtomicBool>,
    cleanup_paths: Vec<PathBuf>,
}

struct TaskGuard<'a> {
    task_id: String,
    cancel: Arc<AtomicBool>,
    state: &'a AppState,
}

impl TaskGuard<'_> {
    fn cancel_token(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    fn check_cancelled(&self) -> AppResult<()> {
        ensure_not_cancelled(&self.cancel)
    }
}

impl Drop for TaskGuard<'_> {
    fn drop(&mut self) {
        let mut cancelled_cleanup_paths = Vec::new();
        if let Ok(mut tasks) = self.state.running_tasks.lock() {
            if tasks
                .get(&self.task_id)
                .is_some_and(|task| Arc::ptr_eq(&task.cancel, &self.cancel))
            {
                if let Some(task) = tasks.remove(&self.task_id) {
                    if task.cancel.load(Ordering::SeqCst) {
                        cancelled_cleanup_paths = task.cleanup_paths;
                    }
                }
            }
        } else {
            app_error(
                ErrorCode::TaskStateUnavailable,
                "Task state lock is poisoned while releasing a task guard",
            );
        }
        if !cancelled_cleanup_paths.is_empty() {
            tauri::async_runtime::spawn_blocking(move || {
                remove_cleanup_paths(&cancelled_cleanup_paths)
            });
        }
    }
}

struct RunningFfmpeg {
    task_id: String,
    cancel: Arc<AtomicBool>,
    pid: Option<u32>,
    cleanup_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Preferences {
    cache_dir: String,
    default_export_dir: String,
    ffmpeg_path: String,
    ffprobe_path: String,
    #[serde(default = "default_auto_save_interval_minutes")]
    auto_save_interval_minutes: u32,
    #[serde(default = "default_auto_save_max_snapshots")]
    auto_save_max_snapshots: u32,
}

const fn default_auto_save_interval_minutes() -> u32 {
    5
}

const fn default_auto_save_max_snapshots() -> u32 {
    20
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportNameRule {
    SourceTimeRange,
    SourceDialogue,
    TimeRange,
    Dialogue,
}

impl Default for ExportNameRule {
    fn default() -> Self {
        Self::SourceTimeRange
    }
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            cache_dir: default_cache_root().to_string_lossy().into_owned(),
            default_export_dir: default_export_root().to_string_lossy().into_owned(),
            ffmpeg_path: DEFAULT_FFMPEG_PROGRAM.to_string(),
            ffprobe_path: DEFAULT_FFPROBE_PROGRAM.to_string(),
            auto_save_interval_minutes: default_auto_save_interval_minutes(),
            auto_save_max_snapshots: default_auto_save_max_snapshots(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MediaAsset {
    id: String,
    path: String,
    file_name: String,
    file_size: i64,
    modified_at: i64,
    fingerprint: String,
    duration_us: i64,
    start_time_us: i64,
    video_stream_index: Option<i32>,
    audio_stream_index: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MediaStream {
    index: i32,
    codec_type: String,
    codec_name: String,
    #[serde(default)]
    avg_frame_rate: Option<String>,
    #[serde(default)]
    r_frame_rate: Option<String>,
    #[serde(default)]
    sample_aspect_ratio: Option<String>,
    #[serde(default)]
    sample_rate: Option<String>,
    #[serde(default)]
    channel_layout: Option<String>,
    language: Option<String>,
    title: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
    channels: Option<i64>,
    disposition: HashMap<String, i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SubtitleSourceType {
    Embedded,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SubtitleKind {
    Text,
    Bitmap,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SubtitleTrack {
    id: String,
    asset_id: String,
    source_type: SubtitleSourceType,
    stream_index: Option<i32>,
    source_path: Option<String>,
    codec: String,
    language: Option<String>,
    title: Option<String>,
    kind: SubtitleKind,
    offset_us: i64,
    cue_count: usize,
    warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SubtitleCue {
    id: String,
    track_id: String,
    sequence: i32,
    start_us: i64,
    end_us: i64,
    raw_text: String,
    plain_text: String,
    speaker: Option<String>,
    style: Option<String>,
    layer: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Project {
    asset: MediaAsset,
    streams: Vec<MediaStream>,
    tracks: Vec<SubtitleTrack>,
    cues: HashMap<String, Vec<SubtitleCue>>,
    cache_dir: String,
    proxy_path: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum MediaBinItemKind {
    Video,
    Audio,
    Subtitle,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum MediaBinItemOrigin {
    Imported,
    Decomposed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MediaBinItem {
    id: String,
    #[serde(default)]
    bin_id: Option<String>,
    kind: MediaBinItemKind,
    enabled: bool,
    hidden: bool,
    offline: bool,
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
struct MediaBinFolder {
    id: String,
    name: String,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    color: String,
    #[serde(default)]
    hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectMediaBinState {
    items: Vec<MediaBinItem>,
    #[serde(default)]
    folders: Vec<MediaBinFolder>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectPreviewState {
    use_proxy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectEditorState {
    active_video_id: String,
    active_track_id: String,
    subtitle_selections: HashMap<String, HashMap<String, Vec<String>>>,
    detached_video_ids: Vec<String>,
    preview: ProjectPreviewState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectWorkspace {
    projects: Vec<Project>,
    media_bin: ProjectMediaBinState,
    editor: ProjectEditorState,
}

#[derive(Debug, Clone, Serialize)]
struct OpenProjectResult {
    path: String,
    workspace: ProjectWorkspace,
    warnings: Vec<UserNotice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum NoticeSeverity {
    Info,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UserNotice {
    code: String,
    severity: NoticeSeverity,
    message: String,
}

impl UserNotice {
    fn warning(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            severity: NoticeSeverity::Warning,
            message: message.into(),
        }
    }

    fn warning_with_detail(
        code: &str,
        message: impl Into<String>,
        detail: impl AsRef<str>,
    ) -> Self {
        tracing::warn!(
            notice_code = code,
            detail = detail.as_ref(),
            "operation warning"
        );
        Self::warning(code, message)
    }

    fn info(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            severity: NoticeSeverity::Info,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ImportResult {
    project: Project,
    warnings: Vec<UserNotice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProxyResult {
    proxy_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyOptions {
    frame_size: ProxyFrameSize,
    custom_width: i64,
    custom_height: i64,
    preset: ProxyPreset,
    watermark: ProxyWatermark,
    location: ProxyLocation,
    custom_location: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProxyFrameSize {
    Full,
    Half,
    Quarter,
    Custom,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProxyPreset {
    H264Mp4,
    H264Mp4AllIntra,
    H264Quicktime,
    Vp8Webm,
    Vp9Webm,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProxyWatermark {
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProxyLocation {
    SourceProxyFolder,
    Custom,
    PreferencesCache,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AddExternalSubtitlesResult {
    tracks: Vec<SubtitleTrack>,
    cues: HashMap<String, Vec<SubtitleCue>>,
    warnings: Vec<UserNotice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DemuxedAudioTrack {
    file_name: String,
    duration_us: i64,
    stream_index: i32,
    codec: String,
    language: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DemuxMediaResult {
    audio_tracks: Vec<DemuxedAudioTrack>,
    subtitle_tracks: Vec<SubtitleTrack>,
}

#[derive(Debug, Clone, Serialize)]
struct FfmpegProgressPayload {
    task_id: String,
    progress: f64,
}

struct FfmpegProgressContext<'a> {
    app: &'a tauri::AppHandle,
    state: &'a AppState,
    task_id: &'a str,
    cancel: Arc<AtomicBool>,
    base_progress: f64,
    progress_span: f64,
    duration_us: i64,
    cleanup_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportMode {
    FastCopy,
    PreciseEncode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportLayout {
    Individual,
    Merged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportOptions {
    head_padding_ms: i64,
    tail_padding_ms: i64,
    merge_gap_ms: i64,
    mode: ExportMode,
    layout: ExportLayout,
    output_dir: String,
    #[serde(default)]
    output_dir_explicit: bool,
    #[serde(default)]
    export_name_rule: ExportNameRule,
    #[serde(default)]
    dialogue_line_indexes: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportBoundMediaKind {
    Audio,
    Subtitle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportBoundMediaSource {
    File,
    EmbeddedStream,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportBoundMedia {
    kind: ExportBoundMediaKind,
    source: ExportBoundMediaSource,
    path: String,
    stream_index: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClipRange {
    index: usize,
    start_us: i64,
    end_us: i64,
    cue_ids: Vec<String>,
    head_padding_us: i64,
    tail_padding_us: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportResult {
    ranges: Vec<ClipRange>,
    files: Vec<String>,
    output_dir: String,
    log: Vec<UserNotice>,
}

#[derive(Debug, Deserialize)]
struct ProbeOutput {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    format: Option<ProbeFormat>,
}

#[derive(Debug, Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
    start_time: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProbeStream {
    index: i32,
    codec_name: Option<String>,
    codec_type: Option<String>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    sample_aspect_ratio: Option<String>,
    sample_rate: Option<String>,
    channel_layout: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
    channels: Option<i64>,
    #[serde(default)]
    tags: HashMap<String, String>,
    #[serde(default)]
    disposition: HashMap<String, i32>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            init_logging(app.handle())?;
            app.manage(AppState::new());
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window
                    .set_theme(Some(tauri::Theme::Light))
                    .map_err(|error| {
                        app_error(
                            ErrorCode::WindowThemeFailed,
                            format!("Failed to apply the main window theme: {error}"),
                        )
                    })?;
                let hwnd = window.hwnd().map_err(|error| {
                    app_error(
                        ErrorCode::WindowHandleUnavailable,
                        format!("Failed to obtain the main window handle: {error}"),
                    )
                })?;
                install_system_file_drop(app.handle().clone(), hwnd)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_preferences,
            take_preferences_startup_error,
            take_launch_project_path,
            update_preferences,
            import_media,
            generate_video_cover_thumbnail,
            get_cached_subtitle_thumbnail,
            cache_subtitle_thumbnail,
            generate_subtitle_thumbnail,
            demux_media_streams,
            generate_proxy,
            add_external_subtitles,
            save_project_file,
            auto_save_project_snapshot,
            open_project_file,
            sync_project_workspace,
            close_project,
            path_is_file,
            set_media_import_drop_region,
            reveal_in_file_manager,
            cancel_task,
            export_clips,
            play_system_sound,
            record_frontend_incident
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let state = window.state::<AppState>();
                let _ = cancel_all_tasks(state.inner());
            }
        })
        .run(tauri::generate_context!());
    if let Err(error) = result {
        app_error(
            ErrorCode::ApplicationRunFailed,
            format!("Application event loop failed: {error}"),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_startup_failure_uses_defaults_and_preserves_the_diagnostic() {
        let state = AppState::from_preferences_result(Err(app_error(
            ErrorCode::PreferencesDecodeFailed,
            "Preferences fixture is invalid",
        )));

        assert_eq!(
            state
                .preferences
                .lock()
                .expect("preferences lock")
                .ffmpeg_path,
            DEFAULT_FFMPEG_PROGRAM
        );
        assert!(state
            .startup_preferences_error
            .lock()
            .expect("startup diagnostic lock")
            .as_ref()
            .is_some_and(|error| error.is(ErrorCode::PreferencesDecodeFailed)));
    }
}
