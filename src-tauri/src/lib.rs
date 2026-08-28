use encoding_rs::{BIG5, GBK, SHIFT_JIS, WINDOWS_1252};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::Command as StdCommand;
use std::{
    collections::{BTreeSet, HashMap, HashSet},
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
    /// Serializes read-modify-write cycles over WorkspaceConfig.xml so panel
    /// autosaves and per-project state updates never clobber each other.
    workspace_config_lock: Mutex<()>,
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
            workspace_config_lock: Mutex::new(()),
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

impl Default for Preferences {
    fn default() -> Self {
        Self {
            cache_dir: default_cache_root().to_string_lossy().into_owned(),
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
    detached_video_ids: Vec<String>,
    preview: ProjectPreviewState,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProjectSubtitleColorLabel {
    Red,
    Yellow,
    Green,
    Blue,
    Purple,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSubtitleAnnotation {
    rating: u8,
    retained: bool,
    #[serde(default)]
    excluded: bool,
    #[serde(default)]
    color_label: Option<ProjectSubtitleColorLabel>,
    #[serde(default)]
    custom_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSubtitleState {
    cue_annotations: HashMap<String, ProjectSubtitleAnnotation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectStoryboardShot {
    id: String,
    sequence: usize,
    start_frame: usize,
    end_frame: usize,
    start_us: i64,
    end_us: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProjectStoryboardColorLabel {
    Red,
    Yellow,
    Green,
    Blue,
    Purple,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectStoryboardAnnotation {
    rating: u8,
    retained: bool,
    #[serde(default)]
    excluded: bool,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    keyword_ids: BTreeSet<String>,
    #[serde(default)]
    color_label: Option<ProjectStoryboardColorLabel>,
    #[serde(default)]
    custom_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectStoryboardKeywordNode {
    id: String,
    name: String,
    parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    synonyms: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectStoryboardStack {
    id: String,
    shot_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectStoryboardKeywordUsageCounters {
    counts: HashMap<String, u64>,
    total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectStoryboardState {
    shots: Vec<ProjectStoryboardShot>,
    shot_stacks: Vec<ProjectStoryboardStack>,
    keyword_nodes: Vec<ProjectStoryboardKeywordNode>,
    recent_keyword_ids: Vec<String>,
    #[serde(default)]
    keyword_usage_counters: ProjectStoryboardKeywordUsageCounters,
    shot_annotations: HashMap<String, ProjectStoryboardAnnotation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectWorkspace {
    projects: Vec<Project>,
    media_bin: ProjectMediaBinState,
    editor: ProjectEditorState,
    #[serde(default)]
    subtitles: HashMap<String, ProjectSubtitleState>,
    #[serde(default)]
    storyboards: HashMap<String, ProjectStoryboardState>,
}

#[derive(Debug, Clone, Serialize)]
struct OpenProjectResult {
    path: String,
    /// Stable per-document identity (generated for files that predate it).
    project_id: String,
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
struct ExportAudioSource {
    source_path: String,
    /// Zero-based index among the input file's audio streams (`a:N`).
    #[serde(default)]
    audio_track_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportClip {
    id: String,
    source_path: String,
    /// `None` preserves compatibility with older callers by selecting the
    /// source file's first audio stream; `Some([])` explicitly means no audio.
    #[serde(default)]
    audio_sources: Option<Vec<ExportAudioSource>>,
    label: String,
    /// Full output filename (with extension) computed by the frontend rename
    /// rule; empty falls back to the legacy stem-based naming.
    #[serde(default)]
    output_name: String,
    #[serde(default)]
    start_us: i64,
    #[serde(default)]
    end_us: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportMode {
    Merge,
    Individual,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportContainer {
    Mp4H264,
    Mp4Hevc,
    MovProres,
    WebmVp9,
    Mp3Audio,
    AacAudio,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportResolution {
    MatchSource,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportQuality {
    Low,
    Medium,
    High,
    VeryHigh,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportEncoderSpeed {
    Fast,
    Balanced,
    Quality,
}

/// Hardware encoding policy for exports.  `Auto` probes the bundled (or
/// user-selected) FFmpeg once per export and falls back to software when a
/// driver, device, or codec is unavailable.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportHardwareAcceleration {
    Auto,
    Software,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportAudioCodec {
    Aac,
    /// MPEG-1 Layer II (ffmpeg native `mp2` encoder).
    Mp2,
    /// MPEG-1 Layer III (`libmp3lame`).
    Mp3,
    Opus,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportAudioChannels {
    Stereo,
    Mono,
    #[serde(rename = "5.1")]
    FivePointOne,
}

/// Destination category for the 导出到 dropdown. The well-known Windows folder
/// variants are resolved by the `resolve_known_folder` command on the frontend;
/// the backend only consumes the resolved `output_dir`, so this is persisted for
/// UI state round-tripping rather than used for path logic here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportDestination {
    Specified,
    Source,
    Desktop,
    Documents,
    User,
    Videos,
    Pictures,
}

/// Output filename rule for the 重命名规则 group. The frontend resolves the
/// rule into a concrete per-clip `output_name`; this enum only round-trips the
/// persisted UI state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportRenameRule {
    Label,
    LabelKeywords,
    Time,
    TimeLabel,
    Filename,
    FilenameLabel,
    FilenameTime,
    Custom,
    CustomLabel,
    CustomTime,
    CustomFilename,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportExtensionCase {
    Upper,
    Lower,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExportExistingFileMode {
    Ask,
    #[serde(rename = "uniqueName")]
    UniqueName,
    Overwrite,
    Skip,
}

const fn default_export_existing_file_mode() -> ExportExistingFileMode {
    ExportExistingFileMode::Ask
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportOptions {
    mode: ExportMode,
    container: ExportContainer,
    resolution: ExportResolution,
    #[serde(default)]
    custom_width: i64,
    #[serde(default)]
    custom_height: i64,
    frame_rate: Option<f64>,
    quality: ExportQuality,
    encoder_speed: ExportEncoderSpeed,
    #[serde(default = "default_export_hardware_acceleration")]
    hardware_acceleration: ExportHardwareAcceleration,
    #[serde(default = "default_export_track_enabled")]
    include_video: bool,
    #[serde(default = "default_export_track_enabled")]
    include_audio: bool,
    #[serde(default = "default_export_audio_codec")]
    audio_codec: ExportAudioCodec,
    /// None means "match the source sample rate".
    #[serde(default)]
    audio_sample_rate_hz: Option<i64>,
    #[serde(default = "default_export_audio_channels")]
    audio_channels: ExportAudioChannels,
    #[serde(default = "default_export_audio_bitrate_kbps")]
    audio_bitrate_kbps: u32,
    /// Persisted with the project; the import itself runs on the frontend.
    #[serde(default)]
    import_into_project: bool,
    /// Persisted with the project; the frontend swaps clip sources to proxies.
    #[serde(default)]
    use_proxy: bool,
    /// UI state persisted with the project; the frontend resolves the folder.
    #[serde(default = "default_export_destination")]
    destination: ExportDestination,
    #[serde(default)]
    use_subfolder: bool,
    #[serde(default)]
    subfolder_name: String,
    #[serde(default)]
    output_dir: String,
    #[serde(default)]
    output_stem: String,
    /// UI state persisted with the project; the frontend resolves filenames.
    #[serde(default = "default_export_rename_rule")]
    rename_rule: ExportRenameRule,
    #[serde(default)]
    custom_name: String,
    #[serde(default = "default_export_start_number")]
    start_number: i64,
    #[serde(default = "default_export_extension_case")]
    extension_case: ExportExtensionCase,
    /// Explicit merged-output filename (with extension) sent by the frontend for
    /// merge exports, so the backend names the merged file exactly like the
    /// preview instead of after `probed[0]`.
    #[serde(default)]
    output_name: String,
    /// How to handle an output file that already exists (UI state round-trip;
    /// the conflict resolution itself runs on the frontend).
    #[serde(default = "default_export_existing_file_mode")]
    existing_file_mode: ExportExistingFileMode,
}

const fn default_export_hardware_acceleration() -> ExportHardwareAcceleration {
    ExportHardwareAcceleration::Auto
}

const fn default_export_track_enabled() -> bool {
    true
}

const fn default_export_audio_codec() -> ExportAudioCodec {
    ExportAudioCodec::Aac
}

const fn default_export_destination() -> ExportDestination {
    ExportDestination::Specified
}

const fn default_export_rename_rule() -> ExportRenameRule {
    ExportRenameRule::Filename
}

const fn default_export_start_number() -> i64 {
    1
}

const fn default_export_extension_case() -> ExportExtensionCase {
    ExportExtensionCase::Lower
}

const fn default_export_audio_channels() -> ExportAudioChannels {
    ExportAudioChannels::Stereo
}

const fn default_export_audio_bitrate_kbps() -> u32 {
    192
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportOutput {
    clip_id: Option<String>,
    path: String,
    status: String,
    error: Option<String>,
    duration_us: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    outputs: Vec<ExportOutput>,
    warnings: Vec<UserNotice>,
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

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProxyFrameSize {
    Full,
    Half,
    Quarter,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProxyPreset {
    H264Mp4,
    H264Mp4AllIntra,
    H264Quicktime,
    Vp8Webm,
    Vp9Webm,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProxyWatermark {
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
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
    /// Identifies the exact clip/output guarded by this FFmpeg process in logs.
    watchdog_label: String,
    cancel: Arc<AtomicBool>,
    base_progress: f64,
    progress_span: f64,
    duration_us: i64,
    cleanup_paths: Vec<PathBuf>,
    /// A logical operation may run more than one FFmpeg process.  In that
    /// case the caller aggregates every child process' local progress before
    /// publishing it to the UI.
    progress_callback: Option<Arc<dyn Fn(f64) + Send + Sync>>,
}

#[derive(Debug, Deserialize, Default)]
struct ProbeOutput {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    format: Option<ProbeFormat>,
}

#[derive(Debug, Deserialize, Default)]
struct ProbeFormat {
    duration: Option<String>,
    start_time: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
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
            get_cached_storyboard_thumbnail,
            cache_storyboard_thumbnail,
            generate_storyboard_thumbnail,
            demux_media_streams,
            decode_audio_pcm_window,
            generate_proxy,
            export_clips,
            add_external_subtitles,
            save_project_file,
            auto_save_project_snapshot,
            open_project_file,
            sync_project_workspace,
            close_project,
            path_is_file,
            resolve_known_folder,
            load_workspace_config,
            save_workspace_config,
            load_project_states,
            save_project_state,
            prune_project_states,
            detect_storyboard_shots,
            set_media_import_drop_region,
            reveal_in_file_manager,
            open_user_guide,
            open_log_directory,
            cancel_task,
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
