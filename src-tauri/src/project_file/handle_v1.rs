use bincode::Options;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

const VERSION: u16 = 1;
const MAGIC: &[u8; 8] = b"LINECUT\0";
const FORMAT_FAMILY: u16 = 1;
const HEADER_LEN: usize = 8 + 2 + 2 + 8 + 32;
const MAX_PAYLOAD_LEN: usize = 512 * 1024 * 1024;
pub(super) const MAX_FILE_LEN: u64 = (HEADER_LEN + MAX_PAYLOAD_LEN) as u64;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ProjectFile {
    workspace: Workspace,
    saved_at: u64,
    app_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Workspace {
    projects: Vec<Project>,
    media_bin: MediaBinState,
    editor: EditorState,
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
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    sample_aspect_ratio: Option<String>,
    sample_rate: Option<String>,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum MediaBinItemKind {
    Video,
    Audio,
    Subtitle,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum MediaBinItemOrigin {
    Imported,
    Decomposed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MediaBinItem {
    id: String,
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
struct MediaBinState {
    items: Vec<MediaBinItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PreviewState {
    use_proxy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EditorState {
    active_video_id: String,
    active_track_id: String,
    subtitle_selections: HashMap<String, HashMap<String, Vec<String>>>,
    detached_video_ids: Vec<String>,
    preview: PreviewState,
}

pub(super) fn recognizes(bytes: &[u8]) -> bool {
    bytes.starts_with(MAGIC)
}

pub(super) fn decode(bytes: &[u8]) -> Result<ProjectFile, String> {
    if bytes.len() < HEADER_LEN || !recognizes(bytes) {
        return Err("不是有效的 LineCut V1 项目文件".to_string());
    }
    let version = u16::from_le_bytes([bytes[8], bytes[9]]);
    let family = u16::from_le_bytes([bytes[10], bytes[11]]);
    if version != VERSION || family != FORMAT_FAMILY {
        return Err("旧格式处理器只接受 LineCut V1 项目文件".to_string());
    }
    let payload_len = u64::from_le_bytes(
        bytes[12..20]
            .try_into()
            .map_err(|_| "V1 项目文件头损坏".to_string())?,
    );
    if payload_len > MAX_PAYLOAD_LEN as u64 || payload_len as usize != bytes.len() - HEADER_LEN {
        return Err("V1 项目文件长度校验失败".to_string());
    }
    let payload = &bytes[HEADER_LEN..];
    if Sha256::digest(payload).as_slice() != &bytes[20..HEADER_LEN] {
        return Err("V1 项目文件完整性校验失败".to_string());
    }

    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .reject_trailing_bytes()
        .deserialize(payload)
        .map_err(|error| format!("解析 V1 项目文件失败: {error}"))
}

impl ProjectFile {
    pub(super) fn into_upgrade_parts(self) -> Result<(Value, u64, String), String> {
        let workspace = serde_json::to_value(self.workspace)
            .map_err(|error| format!("读取 V1 项目内容失败: {error}"))?;
        Ok((workspace, self.saved_at, self.app_version))
    }
}
