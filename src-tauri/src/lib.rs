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
    running_ffmpeg: Mutex<HashMap<String, RunningFfmpeg>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            projects: Mutex::new(HashMap::new()),
            preferences: Mutex::new(load_preferences().unwrap_or_default()),
            running_ffmpeg: Mutex::new(HashMap::new()),
        }
    }
}

struct RunningFfmpeg {
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
struct ImportResult {
    project: Project,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProxyResult {
    proxy_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AddExternalSubtitlesResult {
    tracks: Vec<SubtitleTrack>,
    cues: HashMap<String, Vec<SubtitleCue>>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct FfmpegProgressPayload {
    task_id: String,
    operation: String,
    label: String,
    current: usize,
    total: usize,
    progress: f64,
    done: bool,
}

struct FfmpegProgressContext<'a> {
    app: &'a tauri::AppHandle,
    state: &'a AppState,
    task_id: &'a str,
    operation: &'a str,
    label: &'a str,
    current: usize,
    total: usize,
    base_progress: f64,
    progress_span: f64,
    duration_us: i64,
    complete_on_success: bool,
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
        .invoke_handler(tauri::generate_handler![
            get_preferences,
            update_preferences,
            import_media,
            generate_proxy,
            add_external_subtitles,
            cancel_current_task,
            export_clips
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let state = window.state::<AppState>();
                let _ = cancel_running_ffmpeg(state.inner());
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run LineCut");
}

#[tauri::command]
fn get_preferences(state: tauri::State<'_, AppState>) -> Result<Preferences, String> {
    state
        .preferences
        .lock()
        .map_err(|_| "首选项状态锁定失败".to_string())
        .map(|preferences| preferences.clone())
}

#[tauri::command]
fn update_preferences(
    preferences: Preferences,
    state: tauri::State<'_, AppState>,
) -> Result<Preferences, String> {
    let normalized = normalize_preferences(preferences)?;
    save_preferences(&normalized)?;
    *state
        .preferences
        .lock()
        .map_err(|_| "首选项状态锁定失败".to_string())? = normalized.clone();
    Ok(normalized)
}

#[tauri::command]
fn cancel_current_task(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    cancel_running_ffmpeg(state.inner())
}

#[tauri::command]
async fn import_media(
    path: String,
    external_subtitles: Vec<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ImportResult, String> {
    let preferences = preferences_clone(&state)?;
    let input_path = PathBuf::from(&path);
    if !input_path.exists() {
        return Err(format!("媒体文件不存在: {}", path));
    }

    let probe = probe_media(&input_path, &preferences).await?;
    let meta = fs::metadata(&input_path).map_err(|e| format!("读取媒体元数据失败: {e}"))?;
    let modified_at = modified_secs(&meta);
    let fingerprint = fingerprint_file(&input_path, &meta, modified_at)?;
    let cache_dir = configured_cache_root(&preferences).join(&fingerprint);
    fs::create_dir_all(cache_dir.join("subtitles"))
        .map_err(|e| format!("创建缓存目录失败: {e}"))?;
    let proxy_path = cache_dir.join(PROXY_FILE_NAME);
    let proxy_path_str = if proxy_path.exists() {
        Some(proxy_path.to_string_lossy().into_owned())
    } else {
        None
    };

    let duration_us = probe
        .format
        .as_ref()
        .and_then(|f| f.duration.as_deref())
        .map(parse_decimal_seconds_to_us)
        .unwrap_or(0);
    let start_time_us = probe
        .format
        .as_ref()
        .and_then(|f| f.start_time.as_deref())
        .map(parse_decimal_seconds_to_us)
        .unwrap_or(0);

    let video_stream_index = probe
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"))
        .map(|s| s.index);
    let audio_stream_index = probe
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"))
        .map(|s| s.index);

    let asset = MediaAsset {
        id: Uuid::new_v4().to_string(),
        file_name: input_path
            .file_name()
            .map(|v| v.to_string_lossy().into_owned())
            .unwrap_or_else(|| "media".to_string()),
        path: path.clone(),
        file_size: meta.len() as i64,
        modified_at,
        fingerprint,
        duration_us,
        start_time_us,
        video_stream_index,
        audio_stream_index,
    };

    let streams = probe
        .streams
        .iter()
        .map(|stream| MediaStream {
            index: stream.index,
            codec_type: stream.codec_type.clone().unwrap_or_default(),
            codec_name: stream.codec_name.clone().unwrap_or_default(),
            avg_frame_rate: stream.avg_frame_rate.clone(),
            r_frame_rate: stream.r_frame_rate.clone(),
            language: tag_value(&stream.tags, &["language", "LANGUAGE"]),
            title: tag_value(&stream.tags, &["title", "TITLE"]),
            width: stream.width,
            height: stream.height,
            channels: stream.channels,
            disposition: stream.disposition.clone(),
        })
        .collect::<Vec<_>>();

    let mut tracks = Vec::new();
    let mut cues: HashMap<String, Vec<SubtitleCue>> = HashMap::new();
    let mut warnings = Vec::new();
    let import_task_id = format!("import:{path}");
    let text_subtitle_total = probe
        .streams
        .iter()
        .filter(|stream| {
            stream.codec_type.as_deref() == Some("subtitle")
                && stream
                    .codec_name
                    .as_deref()
                    .is_some_and(is_text_subtitle_codec)
        })
        .count()
        .max(1);
    let mut text_subtitle_index = 0usize;

    for stream in probe
        .streams
        .iter()
        .filter(|s| s.codec_type.as_deref() == Some("subtitle"))
    {
        let codec = stream
            .codec_name
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        let track_id = Uuid::new_v4().to_string();
        let kind = if is_text_subtitle_codec(&codec) {
            SubtitleKind::Text
        } else {
            SubtitleKind::Bitmap
        };
        let mut track = SubtitleTrack {
            id: track_id.clone(),
            asset_id: asset.id.clone(),
            source_type: SubtitleSourceType::Embedded,
            stream_index: Some(stream.index),
            source_path: None,
            codec: codec.clone(),
            language: tag_value(&stream.tags, &["language", "LANGUAGE"]),
            title: tag_value(&stream.tags, &["title", "TITLE"]),
            kind,
            offset_us: 0,
            cue_count: 0,
            warning: None,
        };

        if is_text_subtitle_codec(&codec) {
            let current_subtitle = text_subtitle_index + 1;
            text_subtitle_index += 1;
            match extract_embedded_subtitle(
                &input_path,
                stream.index,
                &codec,
                &cache_dir,
                &preferences,
                Some(FfmpegProgressContext {
                    app: &app,
                    state: state.inner(),
                    task_id: &import_task_id,
                    operation: "import",
                    label: "抽取字幕",
                    current: current_subtitle,
                    total: text_subtitle_total,
                    base_progress: (current_subtitle - 1) as f64 / text_subtitle_total as f64,
                    progress_span: 1.0 / text_subtitle_total as f64,
                    duration_us,
                    complete_on_success: current_subtitle == text_subtitle_total,
                    cleanup_paths: Vec::new(),
                }),
            )
            .await
            {
                Ok(subtitle_path) => match parse_subtitle_file(&subtitle_path, &codec, &track_id) {
                    Ok(parsed) => {
                        track.cue_count = parsed.len();
                        cues.insert(track_id.clone(), parsed);
                    }
                    Err(err) => {
                        let message = format!("字幕流 {} 解析失败: {err}", stream.index);
                        track.warning = Some(message.clone());
                        warnings.push(message);
                    }
                },
                Err(err) => {
                    if err == "任务已取消" {
                        return Err(err);
                    }
                    let message = format!("字幕流 {} 抽取失败: {err}", stream.index);
                    track.warning = Some(message.clone());
                    warnings.push(message);
                }
            }
        } else {
            let message = format!(
                "字幕流 {} 是图像字幕({codec})，当前版本暂不支持台词浏览",
                stream.index
            );
            track.warning = Some(message.clone());
            warnings.push(message);
        }

        tracks.push(track);
    }

    for external in external_subtitles {
        let (track, parsed_cues, warning) = load_external_subtitle(&external, &asset.id);
        if let Some(message) = warning {
            warnings.push(message);
        }
        if !parsed_cues.is_empty() {
            cues.insert(track.id.clone(), parsed_cues);
        }
        tracks.push(track);
    }

    if tracks.is_empty() {
        warnings.push("未检测到字幕流；可稍后通过“外挂字幕”按钮导入".to_string());
    }

    let project = Project {
        asset,
        streams,
        tracks,
        cues,
        cache_dir: cache_dir.to_string_lossy().into_owned(),
        proxy_path: proxy_path_str,
    };

    save_project(&project)?;
    state
        .projects
        .lock()
        .map_err(|_| "项目状态锁定失败".to_string())?
        .insert(project.asset.id.clone(), project.clone());

    Ok(ImportResult { project, warnings })
}

#[tauri::command]
async fn generate_proxy(
    asset_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ProxyResult, String> {
    let preferences = preferences_clone(&state)?;
    let project = project_clone(&asset_id, &state)?;
    let cache_dir = PathBuf::from(&project.cache_dir);
    fs::create_dir_all(&cache_dir).map_err(|e| format!("创建代理缓存目录失败: {e}"))?;
    let proxy_path = cache_dir.join(PROXY_FILE_NAME);
    let proxy_task_id = format!("proxy:{asset_id}");

    if !proxy_path.exists() {
        let args = vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-i".to_string(),
            project.asset.path.clone(),
            "-map".to_string(),
            "0:v:0".to_string(),
            "-map".to_string(),
            "0:a:0?".to_string(),
            "-sn".to_string(),
            "-vf".to_string(),
            "scale=-2:720".to_string(),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "veryfast".to_string(),
            "-tune".to_string(),
            "fastdecode".to_string(),
            "-crf".to_string(),
            "23".to_string(),
            "-g".to_string(),
            "1".to_string(),
            "-keyint_min".to_string(),
            "1".to_string(),
            "-sc_threshold".to_string(),
            "0".to_string(),
            "-bf".to_string(),
            "0".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "128k".to_string(),
            "-movflags".to_string(),
            "+faststart".to_string(),
            proxy_path.to_string_lossy().into_owned(),
        ];
        let program = ffmpeg_program(&preferences);
        run_status_with_ffmpeg_progress(
            &program,
            &args,
            FfmpegProgressContext {
                app: &app,
                state: state.inner(),
                task_id: &proxy_task_id,
                operation: "proxy",
                label: "生成代理",
                current: 1,
                total: 1,
                base_progress: 0.0,
                progress_span: 1.0,
                duration_us: project.asset.duration_us,
                complete_on_success: true,
                cleanup_paths: vec![proxy_path.clone()],
            },
        )
        .await?;
    }

    let proxy_string = proxy_path.to_string_lossy().into_owned();
    let mut projects = state
        .projects
        .lock()
        .map_err(|_| "项目状态锁定失败".to_string())?;
    if let Some(project) = projects.get_mut(&asset_id) {
        project.proxy_path = Some(proxy_string.clone());
        save_project(project)?;
    }

    Ok(ProxyResult {
        proxy_path: proxy_string,
    })
}

#[tauri::command]
async fn add_external_subtitles(
    asset_id: String,
    paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<AddExternalSubtitlesResult, String> {
    let mut project = project_clone(&asset_id, &state)?;
    let mut new_tracks = Vec::new();
    let mut new_cues: HashMap<String, Vec<SubtitleCue>> = HashMap::new();
    let mut warnings = Vec::new();

    for path in paths {
        let (track, cues, warning) = load_external_subtitle(&path, &asset_id);
        if let Some(message) = warning {
            warnings.push(message);
        }
        if !cues.is_empty() {
            new_cues.insert(track.id.clone(), cues);
        }
        project.tracks.push(track.clone());
        new_tracks.push(track);
    }

    project.cues.extend(new_cues.clone());
    save_project(&project)?;
    state
        .projects
        .lock()
        .map_err(|_| "项目状态锁定失败".to_string())?
        .insert(asset_id, project);

    Ok(AddExternalSubtitlesResult {
        tracks: new_tracks,
        cues: new_cues,
        warnings,
    })
}

#[tauri::command]
async fn export_clips(
    asset_id: String,
    track_id: String,
    cue_ids: Vec<String>,
    options: ExportOptions,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ExportResult, String> {
    let preferences = preferences_clone(&state)?;
    let project = project_clone(&asset_id, &state)?;
    let track_cues = project
        .cues
        .get(&track_id)
        .ok_or_else(|| "找不到当前字幕轨".to_string())?;
    let selected_ids = cue_ids.into_iter().collect::<HashSet<_>>();
    let selected_cues = track_cues
        .iter()
        .filter(|cue| selected_ids.contains(&cue.id))
        .cloned()
        .collect::<Vec<_>>();

    if selected_cues.is_empty() {
        return Err("请先勾选至少一条台词".to_string());
    }

    let ranges = build_clip_plan(
        &selected_cues,
        options.head_padding_ms * 1000,
        options.tail_padding_ms * 1000,
        options.merge_gap_ms * 1000,
        project.asset.duration_us,
    );

    let output_dir = if options.output_dir.trim().is_empty() {
        configured_export_root(&preferences)
            .join(&project.asset.id)
            .join(now_millis().to_string())
    } else if options.output_dir_explicit {
        PathBuf::from(options.output_dir.trim())
    } else {
        PathBuf::from(options.output_dir.trim())
            .join(&project.asset.id)
            .join(now_millis().to_string())
    };
    fs::create_dir_all(&output_dir).map_err(|e| format!("创建导出目录失败: {e}"))?;

    let mut log = Vec::new();
    let stem = safe_component(
        &Path::new(&project.asset.path)
            .file_stem()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "clip".to_string()),
    );
    let ext = match options.mode {
        ExportMode::FastCopy => "mkv",
        ExportMode::PreciseEncode => "mp4",
    };
    let part_dir = match options.layout {
        ExportLayout::Individual => output_dir.clone(),
        ExportLayout::Merged => output_dir.join("_parts"),
    };
    fs::create_dir_all(&part_dir).map_err(|e| format!("创建片段目录失败: {e}"))?;

    let cue_lookup = track_cues
        .iter()
        .map(|cue| (cue.id.as_str(), cue))
        .collect::<HashMap<_, _>>();
    let name_rule = effective_export_name_rule(options.export_name_rule, &options.layout);
    let mut used_names = HashSet::new();
    let mut part_files = Vec::new();
    let export_task_id = format!("export:{asset_id}");
    let export_label = match options.layout {
        ExportLayout::Individual => format!("导出 {} 个文件", ranges.len()),
        ExportLayout::Merged => "导出合并视频".to_string(),
    };
    let is_merged_layout = matches!(options.layout, ExportLayout::Merged);
    let part_progress_total = if is_merged_layout { 0.92 } else { 1.0 };
    let mut task_cleanup_paths = if is_merged_layout {
        vec![part_dir.clone()]
    } else {
        Vec::new()
    };
    emit_ffmpeg_progress(
        &app,
        &export_task_id,
        "export",
        &export_label,
        0,
        ranges.len(),
        0.0,
        false,
    );
    for range in &ranges {
        let file_stem = export_file_stem(
            name_rule,
            &stem,
            range,
            &cue_lookup,
            &options.dialogue_line_indexes,
        );
        let output_path = unique_output_path(&part_dir, &file_stem, ext, &mut used_names);
        task_cleanup_paths.push(output_path.clone());
        export_one_range(
            &project.asset.path,
            range,
            &options.mode,
            &output_path,
            &preferences,
            Some(FfmpegProgressContext {
                app: &app,
                state: state.inner(),
                task_id: &export_task_id,
                operation: "export",
                label: &export_label,
                current: range.index + 1,
                total: ranges.len(),
                base_progress: range.index as f64 * part_progress_total
                    / ranges.len().max(1) as f64,
                progress_span: part_progress_total / ranges.len().max(1) as f64,
                duration_us: range.end_us - range.start_us,
                complete_on_success: false,
                cleanup_paths: task_cleanup_paths.clone(),
            }),
        )
        .await?;
        log.push(format!(
            "导出片段 {}: {} -> {}",
            range.index + 1,
            display_time(range.start_us),
            display_time(range.end_us)
        ));
        part_files.push(output_path);
    }

    let files = match options.layout {
        ExportLayout::Individual => part_files
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        ExportLayout::Merged => {
            emit_ffmpeg_progress(
                &app,
                &export_task_id,
                "export",
                &export_label,
                ranges.len(),
                ranges.len(),
                0.92,
                false,
            );
            let merged_stem = if ranges.len() == 1 {
                export_file_stem(
                    name_rule,
                    &stem,
                    &ranges[0],
                    &cue_lookup,
                    &options.dialogue_line_indexes,
                )
            } else {
                let start_us = ranges.first().map(|range| range.start_us).unwrap_or(0);
                let end_us = ranges.last().map(|range| range.end_us).unwrap_or(start_us);
                safe_component(&format!(
                    "{}_{}-{}_merged",
                    stem,
                    file_time_label(start_us),
                    file_time_label(end_us)
                ))
            };
            let mut used_merged_names = HashSet::new();
            let merged = unique_output_path(&output_dir, &merged_stem, ext, &mut used_merged_names);
            task_cleanup_paths.push(merged.clone());
            concat_segments(
                &part_files,
                &merged,
                &preferences,
                Some(FfmpegProgressContext {
                    app: &app,
                    state: state.inner(),
                    task_id: &export_task_id,
                    operation: "export",
                    label: &export_label,
                    current: ranges.len(),
                    total: ranges.len(),
                    base_progress: 0.92,
                    progress_span: 0.08,
                    duration_us: ranges
                        .iter()
                        .map(|range| range.end_us - range.start_us)
                        .sum(),
                    complete_on_success: false,
                    cleanup_paths: task_cleanup_paths.clone(),
                }),
            )
            .await?;
            log.push(format!("合并输出: {}", merged.to_string_lossy()));
            vec![merged.to_string_lossy().into_owned()]
        }
    };
    emit_ffmpeg_progress(
        &app,
        &export_task_id,
        "export",
        &export_label,
        ranges.len(),
        ranges.len(),
        1.0,
        true,
    );

    Ok(ExportResult {
        ranges,
        files,
        output_dir: output_dir.to_string_lossy().into_owned(),
        log,
    })
}

fn project_clone(asset_id: &str, state: &tauri::State<'_, AppState>) -> Result<Project, String> {
    state
        .projects
        .lock()
        .map_err(|_| "项目状态锁定失败".to_string())?
        .get(asset_id)
        .cloned()
        .ok_or_else(|| "项目未加载，请重新导入媒体".to_string())
}

fn preferences_clone(state: &tauri::State<'_, AppState>) -> Result<Preferences, String> {
    state
        .preferences
        .lock()
        .map_err(|_| "首选项状态锁定失败".to_string())
        .map(|preferences| preferences.clone())
}

async fn probe_media(path: &Path, preferences: &Preferences) -> Result<ProbeOutput, String> {
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-show_format".to_string(),
        "-show_streams".to_string(),
        "-show_chapters".to_string(),
        "-of".to_string(),
        "json".to_string(),
        path.to_string_lossy().into_owned(),
    ];
    let program = ffprobe_program(preferences);
    let stdout = run_output(&program, &args).await?;
    serde_json::from_str(&stdout).map_err(|e| format!("ffprobe JSON 解析失败: {e}"))
}

async fn extract_embedded_subtitle(
    video_path: &Path,
    stream_index: i32,
    codec: &str,
    cache_dir: &Path,
    preferences: &Preferences,
    progress: Option<FfmpegProgressContext<'_>>,
) -> Result<PathBuf, String> {
    let ext = subtitle_extension_for_codec(codec);
    let subtitle_dir = cache_dir.join("subtitles");
    fs::create_dir_all(&subtitle_dir).map_err(|e| format!("创建字幕缓存目录失败: {e}"))?;
    let output = subtitle_dir.join(format!("stream_{stream_index}.{ext}"));
    if output.exists() {
        return Ok(output);
    }
    let args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-i".to_string(),
        video_path.to_string_lossy().into_owned(),
        "-map".to_string(),
        format!("0:{stream_index}"),
        output.to_string_lossy().into_owned(),
    ];
    let program = ffmpeg_program(preferences);
    if let Some(mut progress) = progress {
        progress.cleanup_paths.push(output.clone());
        run_status_with_ffmpeg_progress(&program, &args, progress).await?;
    } else {
        run_status(&program, &args).await?;
    }
    Ok(output)
}

fn load_external_subtitle(
    path: &str,
    asset_id: &str,
) -> (SubtitleTrack, Vec<SubtitleCue>, Option<String>) {
    let subtitle_path = PathBuf::from(path);
    let track_id = Uuid::new_v4().to_string();
    let mut track = SubtitleTrack {
        id: track_id.clone(),
        asset_id: asset_id.to_string(),
        source_type: SubtitleSourceType::External,
        stream_index: None,
        source_path: Some(path.to_string()),
        codec: "unknown".to_string(),
        language: None,
        title: Some(path.to_string()),
        kind: SubtitleKind::Text,
        offset_us: 0,
        cue_count: 0,
        warning: None,
    };

    if !subtitle_path.exists() {
        let message = format!("外挂字幕不存在: {path}");
        track.warning = Some(message.clone());
        return (track, Vec::new(), Some(message));
    }

    let codec = codec_from_path(&subtitle_path);
    track.codec = codec.clone();
    track.title = subtitle_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned());

    match parse_subtitle_file(&subtitle_path, &codec, &track_id) {
        Ok(cues) => {
            track.cue_count = cues.len();
            (track, cues, None)
        }
        Err(err) => {
            let message = format!("外挂字幕解析失败 {}: {err}", path);
            track.warning = Some(message.clone());
            (track, Vec::new(), Some(message))
        }
    }
}

async fn export_one_range(
    input_path: &str,
    range: &ClipRange,
    mode: &ExportMode,
    output_path: &Path,
    preferences: &Preferences,
    progress: Option<FfmpegProgressContext<'_>>,
) -> Result<(), String> {
    let duration_us = range.end_us.saturating_sub(range.start_us).max(1);
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-ss".to_string(),
        seconds_arg(range.start_us),
        "-i".to_string(),
        input_path.to_string(),
        "-t".to_string(),
        seconds_arg(duration_us),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "0:a:0?".to_string(),
        "-sn".to_string(),
    ];

    match mode {
        ExportMode::FastCopy => {
            args.extend([
                "-c".to_string(),
                "copy".to_string(),
                "-avoid_negative_ts".to_string(),
                "make_zero".to_string(),
            ]);
        }
        ExportMode::PreciseEncode => {
            args.extend([
                "-c:v".to_string(),
                "libx264".to_string(),
                "-preset".to_string(),
                "veryfast".to_string(),
                "-crf".to_string(),
                "18".to_string(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
                "-c:a".to_string(),
                "aac".to_string(),
                "-b:a".to_string(),
                "192k".to_string(),
                "-movflags".to_string(),
                "+faststart".to_string(),
            ]);
        }
    }

    args.push(output_path.to_string_lossy().into_owned());
    let program = ffmpeg_program(preferences);
    if let Some(progress) = progress {
        run_status_with_ffmpeg_progress(&program, &args, progress).await
    } else {
        run_status(&program, &args).await
    }
}

async fn concat_segments(
    parts: &[PathBuf],
    output_path: &Path,
    preferences: &Preferences,
    progress: Option<FfmpegProgressContext<'_>>,
) -> Result<(), String> {
    let list_path = output_path.with_extension("concat.txt");
    let mut body = String::new();
    for part in parts {
        let normalized = part
            .to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "'\\''");
        body.push_str(&format!("file '{normalized}'\n"));
    }
    fs::write(&list_path, body).map_err(|e| format!("写入合并列表失败: {e}"))?;
    let args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-i".to_string(),
        list_path.to_string_lossy().into_owned(),
        "-c".to_string(),
        "copy".to_string(),
        output_path.to_string_lossy().into_owned(),
    ];
    let program = ffmpeg_program(preferences);
    if let Some(progress) = progress {
        run_status_with_ffmpeg_progress(&program, &args, progress).await
    } else {
        run_status(&program, &args).await
    }
}

fn build_clip_plan(
    cues: &[SubtitleCue],
    head_padding_us: i64,
    tail_padding_us: i64,
    merge_gap_us: i64,
    duration_us: i64,
) -> Vec<ClipRange> {
    let mut ranges = cues
        .iter()
        .map(|cue| ClipRange {
            index: 0,
            start_us: (cue.start_us - head_padding_us).max(0),
            end_us: if duration_us > 0 {
                (cue.end_us + tail_padding_us).min(duration_us)
            } else {
                cue.end_us + tail_padding_us
            },
            cue_ids: vec![cue.id.clone()],
            head_padding_us,
            tail_padding_us,
        })
        .filter(|range| range.end_us > range.start_us)
        .collect::<Vec<_>>();

    ranges.sort_by_key(|range| range.start_us);

    let mut merged: Vec<ClipRange> = Vec::new();
    for range in ranges {
        if let Some(last) = merged.last_mut() {
            if range.start_us <= last.end_us + merge_gap_us {
                last.end_us = last.end_us.max(range.end_us);
                last.cue_ids.extend(range.cue_ids);
                continue;
            }
        }
        merged.push(range);
    }

    for (index, range) in merged.iter_mut().enumerate() {
        range.index = index;
    }

    merged
}

fn parse_subtitle_file(
    path: &Path,
    codec: &str,
    track_id: &str,
) -> Result<Vec<SubtitleCue>, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取字幕文件失败: {e}"))?;
    let text = decode_text(&bytes);
    let lower_codec = codec.to_ascii_lowercase();
    let ext = path
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    if lower_codec.contains("ass") || lower_codec.contains("ssa") || ext == "ass" || ext == "ssa" {
        Ok(normalize_cues(parse_ass(&text, track_id), track_id))
    } else {
        Ok(normalize_cues(parse_srt_or_vtt(&text, track_id), track_id))
    }
}

fn normalize_cues(mut cues: Vec<SubtitleCue>, track_id: &str) -> Vec<SubtitleCue> {
    cues.sort_by_key(|cue| (cue.start_us, cue.end_us, cue.sequence));

    let mut merged: Vec<SubtitleCue> = Vec::new();
    for cue in cues {
        if let Some(last) = merged.last_mut() {
            if last.start_us == cue.start_us && last.end_us == cue.end_us {
                append_unique_line(&mut last.raw_text, &cue.raw_text);
                append_unique_line(&mut last.plain_text, &cue.plain_text);
                merge_optional_field(&mut last.speaker, cue.speaker);
                merge_optional_field(&mut last.style, cue.style);
                if last.layer.is_none() {
                    last.layer = cue.layer;
                }
                continue;
            }
        }
        merged.push(cue);
    }

    for (index, cue) in merged.iter_mut().enumerate() {
        cue.sequence = index as i32;
        cue.id = format!("{track_id}:{index}");
        cue.track_id = track_id.to_string();
    }

    merged
}

fn append_unique_line(target: &mut String, next: &str) {
    let trimmed = next.trim();
    if trimmed.is_empty() || target.lines().any(|line| line.trim() == trimmed) {
        return;
    }
    if !target.trim().is_empty() {
        target.push('\n');
    }
    target.push_str(trimmed);
}

fn merge_optional_field(target: &mut Option<String>, next: Option<String>) {
    let Some(next_value) = next.map(|value| value.trim().to_string()) else {
        return;
    };
    if next_value.is_empty() {
        return;
    }

    match target {
        Some(current) if current.split(" / ").any(|value| value == next_value) => {}
        Some(current) if !current.is_empty() => {
            current.push_str(" / ");
            current.push_str(&next_value);
        }
        _ => *target = Some(next_value),
    }
}

fn parse_srt_or_vtt(text: &str, track_id: &str) -> Vec<SubtitleCue> {
    let normalized = normalize_newlines(text);
    let lines = normalized.lines().collect::<Vec<_>>();
    let timing_re = Regex::new(
        r"(?P<start>(?:\d{1,2}:)?\d{2}:\d{2}[\.,]\d{1,6})\s*-->\s*(?P<end>(?:\d{1,2}:)?\d{2}:\d{2}[\.,]\d{1,6})",
    )
    .expect("valid timing regex");
    let mut cues = Vec::new();
    let mut i = 0usize;

    while i < lines.len() {
        let mut line = lines[i].trim();
        if line.is_empty() || line.eq_ignore_ascii_case("WEBVTT") {
            i += 1;
            continue;
        }
        if line.starts_with("NOTE") || line.starts_with("STYLE") || line.starts_with("REGION") {
            i += 1;
            while i < lines.len() && !lines[i].trim().is_empty() {
                i += 1;
            }
            continue;
        }
        if !line.contains("-->") {
            if i + 1 < lines.len() && lines[i + 1].contains("-->") {
                i += 1;
                line = lines[i].trim();
            } else {
                i += 1;
                continue;
            }
        }

        let Some(captures) = timing_re.captures(line) else {
            i += 1;
            continue;
        };
        let start_us = parse_subtitle_time(&captures["start"]);
        let end_us = parse_subtitle_time(&captures["end"]);
        i += 1;

        let mut text_lines = Vec::new();
        while i < lines.len() && !lines[i].trim().is_empty() {
            text_lines.push(lines[i]);
            i += 1;
        }

        let raw_text = text_lines.join("\n");
        let plain_text = clean_plain_text(&raw_text);
        if end_us > start_us && !plain_text.is_empty() {
            let sequence = cues.len() as i32;
            cues.push(SubtitleCue {
                id: format!("{track_id}:{sequence}"),
                track_id: track_id.to_string(),
                sequence,
                start_us,
                end_us,
                raw_text,
                plain_text,
                speaker: None,
                style: None,
                layer: None,
            });
        }
    }

    cues
}

fn parse_ass(text: &str, track_id: &str) -> Vec<SubtitleCue> {
    let normalized = normalize_newlines(text);
    let mut in_events = false;
    let mut fields = vec![
        "layer".to_string(),
        "start".to_string(),
        "end".to_string(),
        "style".to_string(),
        "name".to_string(),
        "marginl".to_string(),
        "marginr".to_string(),
        "marginv".to_string(),
        "effect".to_string(),
        "text".to_string(),
    ];
    let mut cues = Vec::new();

    for line in normalized.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_events = trimmed.eq_ignore_ascii_case("[Events]");
            continue;
        }
        if !in_events {
            continue;
        }
        if let Some(format_line) = trimmed.strip_prefix("Format:") {
            fields = format_line
                .split(',')
                .map(|value| value.trim().to_ascii_lowercase())
                .collect();
            continue;
        }
        let Some(dialogue) = trimmed.strip_prefix("Dialogue:") else {
            continue;
        };
        let parts = dialogue
            .trim()
            .splitn(fields.len(), ',')
            .map(str::trim)
            .collect::<Vec<_>>();
        if parts.len() < fields.len() {
            continue;
        }

        let start = ass_value(&fields, &parts, "start").unwrap_or_default();
        let end = ass_value(&fields, &parts, "end").unwrap_or_default();
        let raw_text = ass_value(&fields, &parts, "text")
            .unwrap_or_default()
            .to_string();
        let start_us = parse_ass_time(start);
        let end_us = parse_ass_time(end);
        let plain_text = clean_plain_text(&raw_text);

        if end_us <= start_us || plain_text.is_empty() {
            continue;
        }

        let sequence = cues.len() as i32;
        cues.push(SubtitleCue {
            id: format!("{track_id}:{sequence}"),
            track_id: track_id.to_string(),
            sequence,
            start_us,
            end_us,
            raw_text,
            plain_text,
            speaker: optional_string(ass_value(&fields, &parts, "name")),
            style: optional_string(ass_value(&fields, &parts, "style")),
            layer: ass_value(&fields, &parts, "layer").and_then(|value| value.parse().ok()),
        });
    }

    cues
}

fn ass_value<'a>(fields: &[String], parts: &[&'a str], name: &str) -> Option<&'a str> {
    fields
        .iter()
        .position(|field| field == name)
        .and_then(|index| parts.get(index).copied())
}

fn optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn clean_plain_text(raw: &str) -> String {
    let mut text = raw
        .replace("\\N", "\n")
        .replace("\\n", "\n")
        .replace("\\h", " ")
        .replace("&nbsp;", " ");
    let ass_tag_re = Regex::new(r"\{[^}]*\}").expect("valid ass tag regex");
    text = ass_tag_re.replace_all(&text, "").into_owned();
    let html_tag_re = Regex::new(r"<[^>]+>").expect("valid html tag regex");
    text = html_tag_re.replace_all(&text, "").into_owned();
    let whitespace_re = Regex::new(r"[ \t\r\n]+").expect("valid whitespace regex");
    whitespace_re.replace_all(text.trim(), " ").into_owned()
}

fn parse_subtitle_time(value: &str) -> i64 {
    let normalized = value.trim().replace(',', ".");
    let parts = normalized.split(':').collect::<Vec<_>>();
    let (hours, minutes, seconds) = match parts.as_slice() {
        [minutes, seconds] => (0, parse_i64(minutes), *seconds),
        [hours, minutes, seconds] => (parse_i64(hours), parse_i64(minutes), *seconds),
        _ => return 0,
    };
    let (seconds_whole, fraction_us) = parse_seconds_fraction(seconds, 3);
    ((hours * 3600 + minutes * 60 + seconds_whole) * 1_000_000) + fraction_us
}

fn parse_ass_time(value: &str) -> i64 {
    let parts = value.trim().split(':').collect::<Vec<_>>();
    let [hours, minutes, seconds] = parts.as_slice() else {
        return 0;
    };
    let (seconds_whole, fraction_us) = parse_seconds_fraction(seconds, 2);
    ((parse_i64(hours) * 3600 + parse_i64(minutes) * 60 + seconds_whole) * 1_000_000) + fraction_us
}

fn parse_seconds_fraction(value: &str, default_fraction_digits: usize) -> (i64, i64) {
    let mut split = value.split('.');
    let seconds_whole = parse_i64(split.next().unwrap_or_default());
    let fraction = split.next().unwrap_or_default();
    let mut digits = fraction.chars().take(6).collect::<String>();
    if digits.is_empty() && default_fraction_digits == 2 {
        digits.push_str("00");
    }
    while digits.len() < 6 {
        digits.push('0');
    }
    (seconds_whole, parse_i64(&digits))
}

fn parse_decimal_seconds_to_us(value: &str) -> i64 {
    let trimmed = value.trim();
    let negative = trimmed.starts_with('-');
    let number = trimmed.trim_start_matches('-');
    let mut split = number.split('.');
    let seconds = parse_i64(split.next().unwrap_or_default());
    let mut fraction = split
        .next()
        .unwrap_or_default()
        .chars()
        .take(6)
        .collect::<String>();
    while fraction.len() < 6 {
        fraction.push('0');
    }
    let result = seconds * 1_000_000 + parse_i64(&fraction);
    if negative {
        -result
    } else {
        result
    }
}

fn parse_i64(value: &str) -> i64 {
    value.trim().parse::<i64>().unwrap_or(0)
}

fn normalize_newlines(text: &str) -> String {
    text.trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

fn decode_text(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }

    for encoding in [GBK, BIG5, SHIFT_JIS, WINDOWS_1252] {
        let (decoded, _, had_errors) = encoding.decode(bytes);
        if !had_errors {
            return decoded.into_owned();
        }
    }

    let (decoded, _, _) = GBK.decode(bytes);
    decoded.into_owned()
}

fn is_text_subtitle_codec(codec: &str) -> bool {
    matches!(
        codec.to_ascii_lowercase().as_str(),
        "subrip" | "srt" | "ass" | "ssa" | "webvtt" | "mov_text" | "text"
    )
}

fn subtitle_extension_for_codec(codec: &str) -> &'static str {
    match codec.to_ascii_lowercase().as_str() {
        "ass" | "ssa" => "ass",
        "webvtt" => "vtt",
        _ => "srt",
    }
}

fn codec_from_path(path: &Path) -> String {
    match path
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
        .as_str()
    {
        "ass" => "ass".to_string(),
        "ssa" => "ssa".to_string(),
        "vtt" | "webvtt" => "webvtt".to_string(),
        _ => "subrip".to_string(),
    }
}

fn tag_value(tags: &HashMap<String, String>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = tags.get(*key) {
            if !value.trim().is_empty() {
                return Some(value.clone());
            }
        }
    }
    None
}

fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn register_running_ffmpeg(
    state: &AppState,
    id: String,
    cancel: Arc<AtomicBool>,
    pid: Option<u32>,
    cleanup_paths: Vec<PathBuf>,
) -> Result<(), String> {
    let mut running = state
        .running_ffmpeg
        .lock()
        .map_err(|_| "任务状态锁定失败".to_string())?;
    running.insert(
        id,
        RunningFfmpeg {
            cancel,
            pid,
            cleanup_paths,
        },
    );
    Ok(())
}

fn clear_running_ffmpeg(state: &AppState, id: &str) {
    if let Ok(mut running) = state.running_ffmpeg.lock() {
        running.remove(id);
    }
}

fn cancel_running_ffmpeg(state: &AppState) -> Result<bool, String> {
    let tasks = {
        let mut running = state
            .running_ffmpeg
            .lock()
            .map_err(|_| "任务状态锁定失败".to_string())?;
        if running.is_empty() {
            return Ok(false);
        }
        let tasks = running
            .values()
            .map(|task| {
                task.cancel.store(true, Ordering::SeqCst);
                (task.pid, task.cleanup_paths.clone())
            })
            .collect::<Vec<_>>();
        running.clear();
        tasks
    };

    for (pid, cleanup_paths) in tasks {
        if let Some(pid) = pid {
            kill_process_tree(pid);
        }
        remove_cleanup_paths(&cleanup_paths);
    }
    Ok(true)
}

fn remove_cleanup_paths(paths: &[PathBuf]) {
    for path in paths.iter().rev() {
        if path.is_dir() {
            let _ = fs::remove_dir_all(path);
        } else {
            let _ = fs::remove_file(path);
        }
    }
}

fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = StdCommand::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(not(windows))]
    {
        let _ = StdCommand::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn ffmpeg_args_with_progress(args: &[String]) -> Vec<String> {
    let mut next = Vec::with_capacity(args.len() + 3);
    let mut inserted = false;

    for arg in args {
        next.push(arg.clone());
        if !inserted && arg == "-hide_banner" {
            next.push("-nostats".to_string());
            next.push("-progress".to_string());
            next.push("pipe:1".to_string());
            inserted = true;
        }
    }

    if !inserted {
        next.splice(
            0..0,
            [
                "-nostats".to_string(),
                "-progress".to_string(),
                "pipe:1".to_string(),
            ],
        );
    }

    next
}

fn emit_ffmpeg_progress(
    app: &tauri::AppHandle,
    task_id: &str,
    operation: &str,
    label: &str,
    current: usize,
    total: usize,
    progress: f64,
    done: bool,
) {
    let _ = app.emit(
        FFMPEG_PROGRESS_EVENT,
        FfmpegProgressPayload {
            task_id: task_id.to_string(),
            operation: operation.to_string(),
            label: label.to_string(),
            current,
            total,
            progress: progress.clamp(0.0, 1.0),
            done,
        },
    );
}

async fn run_output(program: &str, args: &[String]) -> Result<String, String> {
    let output = hidden_command(program)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("启动 {program} 失败，请确认它在 PATH 中: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("{program} 执行失败: {stderr}"))
    }
}

async fn run_status(program: &str, args: &[String]) -> Result<(), String> {
    let output = hidden_command(program)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("启动 {program} 失败，请确认它在 PATH 中: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("{program} 执行失败: {stderr}"))
    }
}

async fn run_status_with_ffmpeg_progress(
    program: &str,
    args: &[String],
    progress: FfmpegProgressContext<'_>,
) -> Result<(), String> {
    let progress_args = ffmpeg_args_with_progress(args);
    let task_id = Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    let mut child = hidden_command(program)
        .args(&progress_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 {program} 失败，请确认它在 PATH 中: {e}"))?;
    let pid = child.id();
    if let Err(err) = register_running_ffmpeg(
        progress.state,
        task_id.clone(),
        cancel.clone(),
        pid,
        progress.cleanup_paths.clone(),
    ) {
        let _ = child.start_kill();
        return Err(err);
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("读取 {program} 进度失败"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("读取 {program} 错误输出失败"))?;

    let stderr_task = tokio::spawn(async move {
        let mut body = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut body).await;
        body
    });

    emit_ffmpeg_progress(
        progress.app,
        progress.task_id,
        progress.operation,
        progress.label,
        progress.current,
        progress.total,
        progress.base_progress,
        false,
    );

    let mut lines = BufReader::new(stdout).lines();
    let mut last_emitted = progress.base_progress;
    let duration_us = progress.duration_us.max(1) as f64;
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = stderr_task.await;
            remove_cleanup_paths(&progress.cleanup_paths);
            clear_running_ffmpeg(progress.state, &task_id);
            emit_ffmpeg_progress(
                progress.app,
                progress.task_id,
                progress.operation,
                progress.label,
                progress.current,
                progress.total,
                last_emitted,
                true,
            );
            return Err("任务已取消".to_string());
        }

        let line = match tokio::time::timeout(Duration::from_millis(120), lines.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => break,
            Ok(Err(err)) => {
                clear_running_ffmpeg(progress.state, &task_id);
                return Err(format!("读取 {program} 进度失败: {err}"));
            }
            Err(_) => continue,
        };

        if let Some(value) = line.strip_prefix("out_time_us=") {
            if let Ok(out_time_us) = value.trim().parse::<i64>() {
                let local_progress = (out_time_us.max(0) as f64 / duration_us).clamp(0.0, 1.0);
                let overall_progress =
                    progress.base_progress + local_progress * progress.progress_span;
                if overall_progress - last_emitted >= 0.005 || overall_progress >= 1.0 {
                    emit_ffmpeg_progress(
                        progress.app,
                        progress.task_id,
                        progress.operation,
                        progress.label,
                        progress.current,
                        progress.total,
                        overall_progress,
                        false,
                    );
                    last_emitted = overall_progress;
                }
            }
        } else if line.trim() == "progress=end" {
            emit_ffmpeg_progress(
                progress.app,
                progress.task_id,
                progress.operation,
                progress.label,
                progress.current,
                progress.total,
                progress.base_progress + progress.progress_span,
                progress.complete_on_success,
            );
        }
    }

    let status = match child.wait().await {
        Ok(status) => status,
        Err(err) => {
            clear_running_ffmpeg(progress.state, &task_id);
            return Err(format!("等待 {program} 结束失败: {err}"));
        }
    };
    let stderr = stderr_task.await.unwrap_or_default();
    let was_cancelled = cancel.load(Ordering::SeqCst);
    clear_running_ffmpeg(progress.state, &task_id);

    if status.success() && !was_cancelled {
        if progress.complete_on_success {
            emit_ffmpeg_progress(
                progress.app,
                progress.task_id,
                progress.operation,
                progress.label,
                progress.current,
                progress.total,
                1.0,
                true,
            );
        }
        Ok(())
    } else {
        remove_cleanup_paths(&progress.cleanup_paths);
        emit_ffmpeg_progress(
            progress.app,
            progress.task_id,
            progress.operation,
            progress.label,
            progress.current,
            progress.total,
            last_emitted,
            true,
        );
        if was_cancelled {
            Err("任务已取消".to_string())
        } else {
            Err(format!("{program} 执行失败: {stderr}"))
        }
    }
}

fn fingerprint_file(path: &Path, meta: &fs::Metadata, modified_at: i64) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("打开媒体文件失败: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(meta.len().to_le_bytes());
    hasher.update(modified_at.to_le_bytes());

    let head_len = meta.len().min(HEAD_TAIL_HASH_BYTES) as usize;
    let mut head = vec![0u8; head_len];
    file.read_exact(&mut head)
        .map_err(|e| format!("读取媒体文件头失败: {e}"))?;
    hasher.update(&head);

    if meta.len() > HEAD_TAIL_HASH_BYTES {
        let tail_len = meta.len().min(HEAD_TAIL_HASH_BYTES) as usize;
        file.seek(SeekFrom::End(-(tail_len as i64)))
            .map_err(|e| format!("定位媒体文件尾失败: {e}"))?;
        let mut tail = vec![0u8; tail_len];
        file.read_exact(&mut tail)
            .map_err(|e| format!("读取媒体文件尾失败: {e}"))?;
        hasher.update(&tail);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn modified_secs(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

fn config_root() -> PathBuf {
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

fn default_cache_root() -> PathBuf {
    config_root().join("cache")
}

fn default_export_root() -> PathBuf {
    config_root().join("exports")
}

fn configured_cache_root(preferences: &Preferences) -> PathBuf {
    path_or_default(&preferences.cache_dir, default_cache_root())
}

fn configured_export_root(preferences: &Preferences) -> PathBuf {
    path_or_default(&preferences.default_export_dir, default_export_root())
}

fn path_or_default(value: &str, default_path: PathBuf) -> PathBuf {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        default_path
    } else {
        PathBuf::from(trimmed)
    }
}

fn preferences_file() -> PathBuf {
    config_root().join("preferences.json")
}

fn load_preferences() -> Result<Preferences, String> {
    let path = preferences_file();
    if !path.exists() {
        return Ok(Preferences::default());
    }
    let body = fs::read_to_string(&path).map_err(|e| format!("读取首选项失败: {e}"))?;
    let preferences =
        serde_json::from_str::<Preferences>(&body).map_err(|e| format!("解析首选项失败: {e}"))?;
    normalize_preferences(preferences)
}

fn normalize_preferences(preferences: Preferences) -> Result<Preferences, String> {
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

fn save_preferences(preferences: &Preferences) -> Result<(), String> {
    fs::create_dir_all(config_root()).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let body =
        serde_json::to_vec_pretty(preferences).map_err(|e| format!("序列化首选项失败: {e}"))?;
    fs::write(preferences_file(), body).map_err(|e| format!("保存首选项失败: {e}"))
}

fn ffmpeg_program(preferences: &Preferences) -> String {
    configured_media_program(&preferences.ffmpeg_path, DEFAULT_FFMPEG_PROGRAM)
}

fn ffprobe_program(preferences: &Preferences) -> String {
    configured_media_program(&preferences.ffprobe_path, DEFAULT_FFPROBE_PROGRAM)
}

fn configured_media_program(configured: &str, default_program: &str) -> String {
    let trimmed = configured.trim();
    if !is_default_media_program(trimmed, default_program) {
        return trimmed.to_string();
    }

    bundled_media_program(default_program)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| default_program.to_string())
}

fn is_default_media_program(value: &str, default_program: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let lower = value.to_ascii_lowercase();
    lower == default_program || lower == format!("{default_program}.exe")
}

fn bundled_media_program(program: &str) -> Option<PathBuf> {
    bundled_media_program_candidates(program)
        .into_iter()
        .find(|path| path.is_file())
}

fn bundled_media_program_candidates(program: &str) -> Vec<PathBuf> {
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

fn platform_executable_name(program: &str) -> String {
    #[cfg(windows)]
    {
        format!("{program}.exe")
    }
    #[cfg(not(windows))]
    {
        program.to_string()
    }
}

fn sidecar_executable_name(program: &str) -> String {
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

fn sidecar_target_triple() -> &'static str {
    #[cfg(all(windows, target_arch = "x86_64", target_env = "msvc"))]
    {
        "x86_64-pc-windows-msvc"
    }
    #[cfg(all(windows, target_arch = "aarch64", target_env = "msvc"))]
    {
        "aarch64-pc-windows-msvc"
    }
    #[cfg(all(windows, target_arch = "x86", target_env = "msvc"))]
    {
        "i686-pc-windows-msvc"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "x86_64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "x86_64-unknown-linux-gnu"
    }
    #[cfg(not(any(
        all(windows, target_arch = "x86_64", target_env = "msvc"),
        all(windows, target_arch = "aarch64", target_env = "msvc"),
        all(windows, target_arch = "x86", target_env = "msvc"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64")
    )))]
    {
        ""
    }
}

fn save_project(project: &Project) -> Result<(), String> {
    let dir = config_root().join("projects");
    fs::create_dir_all(&dir).map_err(|e| format!("创建项目目录失败: {e}"))?;
    let path = dir.join(format!("{}.json", project.asset.id));
    let body = serde_json::to_vec_pretty(project).map_err(|e| format!("序列化项目失败: {e}"))?;
    fs::write(path, body).map_err(|e| format!("保存项目失败: {e}"))
}

fn seconds_arg(us: i64) -> String {
    let value = us.max(0);
    format!("{}.{:06}", value / 1_000_000, value % 1_000_000)
}

fn display_time(us: i64) -> String {
    let total_ms = us.max(0) / 1000;
    let ms = total_ms % 1000;
    let total_seconds = total_ms / 1000;
    let seconds = total_seconds % 60;
    let minutes = (total_seconds / 60) % 60;
    let hours = total_seconds / 3600;
    format!("{hours:02}:{minutes:02}:{seconds:02}.{ms:03}")
}

fn file_time_label(us: i64) -> String {
    display_time(us).replace(':', "-").replace('.', "-")
}

fn export_file_stem(
    rule: ExportNameRule,
    source_stem: &str,
    range: &ClipRange,
    cue_lookup: &HashMap<&str, &SubtitleCue>,
    dialogue_line_indexes: &[usize],
) -> String {
    let time_range = format!(
        "{}-{}",
        file_time_label(range.start_us),
        file_time_label(range.end_us)
    );
    let dialogue = quoted_dialogue_for_range(range, cue_lookup, dialogue_line_indexes);
    let raw = match rule {
        ExportNameRule::SourceTimeRange => format!("{source_stem}_{time_range}"),
        ExportNameRule::SourceDialogue => format!("{source_stem}_{dialogue}"),
        ExportNameRule::TimeRange => time_range,
        ExportNameRule::Dialogue => dialogue,
    };
    safe_component(&raw)
}

fn effective_export_name_rule(rule: ExportNameRule, layout: &ExportLayout) -> ExportNameRule {
    match (layout, rule) {
        (ExportLayout::Merged, ExportNameRule::SourceDialogue) => ExportNameRule::SourceTimeRange,
        (ExportLayout::Merged, ExportNameRule::Dialogue) => ExportNameRule::TimeRange,
        _ => rule,
    }
}

fn quoted_dialogue_for_range(
    range: &ClipRange,
    cue_lookup: &HashMap<&str, &SubtitleCue>,
    dialogue_line_indexes: &[usize],
) -> String {
    let selected_lines = dialogue_line_indexes
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    let use_all_lines = selected_lines.is_empty();
    let text = range
        .cue_ids
        .iter()
        .filter_map(|id| cue_lookup.get(id.as_str()))
        .flat_map(|cue| {
            cue.plain_text
                .lines()
                .enumerate()
                .filter_map(|(index, line)| {
                    let line = line.trim();
                    if line.is_empty() || (!use_all_lines && !selected_lines.contains(&index)) {
                        None
                    } else {
                        Some(line)
                    }
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>()
        .join(" ");
    let text = collapse_filename_text(&text);
    if text.is_empty() {
        format!("“{}”", file_time_label(range.start_us))
    } else {
        format!("“{text}”")
    }
}

fn collapse_filename_text(value: &str) -> String {
    let whitespace_re = Regex::new(r"\s+").expect("valid whitespace regex");
    let mut text = whitespace_re.replace_all(value.trim(), " ").into_owned();
    text = text
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>();
    truncate_chars(text.trim(), 80)
}

fn unique_output_path(
    dir: &Path,
    file_stem: &str,
    ext: &str,
    used_names: &mut HashSet<String>,
) -> PathBuf {
    let base = if file_stem.trim().is_empty() {
        "clip".to_string()
    } else {
        file_stem.to_string()
    };
    for suffix in 0..10_000 {
        let name = if suffix == 0 {
            format!("{base}.{ext}")
        } else {
            format!("{base}_{suffix:02}.{ext}")
        };
        let lowered = name.to_ascii_lowercase();
        let candidate = dir.join(&name);
        if !used_names.contains(&lowered) && !candidate.exists() {
            used_names.insert(lowered);
            return candidate;
        }
    }
    dir.join(format!("{base}_{}.{}", now_millis(), ext))
}

fn safe_component(value: &str) -> String {
    let mut output = value
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>();
    output = truncate_chars(&output, 120);
    output = output.trim().trim_matches('.').to_string();
    if output.trim().is_empty() {
        "clip".to_string()
    } else {
        output
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_srt_and_merges_close_cues() {
        let cues = parse_srt_or_vtt(
            "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:02,300 --> 00:00:03,000\nWorld\n",
            "track",
        );

        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].plain_text, "Hello");

        let ranges = build_clip_plan(&cues, 300_000, 500_000, 800_000, 10_000_000);
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].start_us, 700_000);
        assert_eq!(ranges[0].end_us, 3_500_000);
        assert_eq!(ranges[0].cue_ids.len(), 2);
    }

    #[test]
    fn parses_ass_dialogue_text() {
        let cues = parse_ass(
            "[Script Info]\nTitle: sample\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.20,0:00:02.70,Default,Alice,0,0,0,,{\\i1}Hello\\Nworld\n",
            "track",
        );

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].start_us, 1_200_000);
        assert_eq!(cues[0].end_us, 2_700_000);
        assert_eq!(cues[0].plain_text, "Hello world");
        assert_eq!(cues[0].speaker.as_deref(), Some("Alice"));
    }

    #[test]
    fn merges_bilingual_cues_with_identical_timestamps() {
        let cues = parse_srt_or_vtt(
            "1\n00:00:01,000 --> 00:00:03,000\n你好\n\n2\n00:00:01,000 --> 00:00:03,000\nHello\n\n3\n00:00:04,000 --> 00:00:05,000\n下一句\n",
            "track",
        );
        let cues = normalize_cues(cues, "track");

        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].plain_text, "你好\nHello");
        assert_eq!(cues[0].start_us, 1_000_000);
        assert_eq!(cues[1].plain_text, "下一句");
    }

    #[test]
    fn filename_dialogue_rule_uses_selected_language_lines() {
        let cue = SubtitleCue {
            id: "track:0".to_string(),
            track_id: "track".to_string(),
            sequence: 0,
            start_us: 1_000_000,
            end_us: 2_000_000,
            raw_text: "你好\nHello".to_string(),
            plain_text: "你好\nHello".to_string(),
            speaker: None,
            style: None,
            layer: None,
        };
        let mut lookup = HashMap::new();
        lookup.insert(cue.id.as_str(), &cue);
        let range = ClipRange {
            index: 0,
            start_us: cue.start_us,
            end_us: cue.end_us,
            cue_ids: vec![cue.id.clone()],
            head_padding_us: 0,
            tail_padding_us: 0,
        };

        let stem = export_file_stem(ExportNameRule::Dialogue, "source", &range, &lookup, &[1]);
        assert_eq!(stem, "“Hello”");
    }

    #[test]
    fn merged_layout_never_uses_dialogue_name_rule() {
        assert!(matches!(
            effective_export_name_rule(ExportNameRule::SourceDialogue, &ExportLayout::Merged),
            ExportNameRule::SourceTimeRange
        ));
        assert!(matches!(
            effective_export_name_rule(ExportNameRule::Dialogue, &ExportLayout::Merged),
            ExportNameRule::TimeRange
        ));
    }

    #[test]
    fn extracts_embedded_srt_from_generated_mkv_when_ffmpeg_is_available() {
        if std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .is_err()
            || std::process::Command::new("ffprobe")
                .arg("-version")
                .output()
                .is_err()
        {
            return;
        }

        let temp_dir = env::temp_dir().join(format!("linecut-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");
        let subtitle_path = temp_dir.join("sample.srt");
        fs::write(
            &subtitle_path,
            "1\n00:00:00,400 --> 00:00:01,200\nFirst line\n\n2\n00:00:01,500 --> 00:00:02,200\nSecond line\n",
        )
        .expect("write subtitle");

        let mkv_path = temp_dir.join("sample.mkv");
        let args = vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-f".to_string(),
            "lavfi".to_string(),
            "-i".to_string(),
            "testsrc=size=320x180:rate=25:duration=3".to_string(),
            "-i".to_string(),
            subtitle_path.to_string_lossy().into_owned(),
            "-map".to_string(),
            "0:v:0".to_string(),
            "-map".to_string(),
            "1:0".to_string(),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
            "-c:s".to_string(),
            "srt".to_string(),
            mkv_path.to_string_lossy().into_owned(),
        ];
        let preferences = Preferences::default();
        let program = ffmpeg_program(&preferences);
        tauri::async_runtime::block_on(run_status(&program, &args)).expect("create mkv");

        let probe = tauri::async_runtime::block_on(probe_media(&mkv_path, &preferences))
            .expect("probe mkv");
        let stream = probe
            .streams
            .iter()
            .find(|stream| stream.codec_type.as_deref() == Some("subtitle"))
            .expect("subtitle stream");
        let extracted = tauri::async_runtime::block_on(extract_embedded_subtitle(
            &mkv_path,
            stream.index,
            "subrip",
            &temp_dir,
            &preferences,
            None,
        ))
        .expect("extract subtitle");
        let cues = parse_subtitle_file(&extracted, "subrip", "track").expect("parse extracted");

        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].plain_text, "First line");
        assert_eq!(cues[1].plain_text, "Second line");

        let _ = fs::remove_dir_all(temp_dir);
    }
}
