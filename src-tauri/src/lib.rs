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

use backend::*;

const HEAD_TAIL_HASH_BYTES: u64 = 1024 * 1024;
const FFMPEG_PROGRESS_EVENT: &str = "ffmpeg-progress";
const PROXY_FILE_NAME: &str = "proxy_preview_i.mp4";
const DEFAULT_FFMPEG_PROGRAM: &str = "ffmpeg";
const DEFAULT_FFPROBE_PROGRAM: &str = "ffprobe";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct AppState {
    projects: Mutex<HashMap<String, Project>>,
    preferences: Mutex<Preferences>,
    running_tasks: Mutex<HashMap<String, RunningTask>>,
    running_ffmpeg: Mutex<HashMap<String, RunningFfmpeg>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            projects: Mutex::new(HashMap::new()),
            preferences: Mutex::new(load_preferences().unwrap_or_default()),
            running_tasks: Mutex::new(HashMap::new()),
            running_ffmpeg: Mutex::new(HashMap::new()),
        }
    }
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

    fn check_cancelled(&self) -> Result<(), String> {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectDocument {
    project: Option<Project>,
    saved_at: u64,
    app_version: String,
}

#[derive(Debug, Clone, Serialize)]
struct OpenProjectResult {
    path: String,
    project: Option<Project>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ImportResult {
    project: Project,
    warnings: Vec<String>,
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
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DemuxedAudioTrack {
    path: String,
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
struct ExportBoundMedia {
    kind: ExportBoundMediaKind,
    path: String,
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
    log: Vec<String>,
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .setup(|app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window.set_theme(Some(tauri::Theme::Light))?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_preferences,
            update_preferences,
            import_media,
            demux_media_streams,
            generate_proxy,
            add_external_subtitles,
            save_project_file,
            open_project_file,
            close_project,
            cancel_task,
            export_clips
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let state = window.state::<AppState>();
                let _ = cancel_all_tasks(state.inner());
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run LineCut");
}
