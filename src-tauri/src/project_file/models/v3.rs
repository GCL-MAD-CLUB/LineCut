use crate::{app_error, AppResult, ErrorCode, ProjectWorkspace};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use super::{v2, CurrentProjectModel, ProjectModel, UpgradeFrom, UpgradeParts};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::project_file) struct Model {
    workspace: Workspace,
    saved_at: u64,
    app_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Workspace {
    projects: Vec<Project>,
    media_bin: MediaBinState,
    editor: EditorState,
    storyboards: BTreeMap<String, StoryboardState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Project {
    asset: MediaAsset,
    streams: Vec<MediaStream>,
    tracks: Vec<SubtitleTrack>,
    cues: BTreeMap<String, Vec<SubtitleCue>>,
    cache_dir: String,
    proxy_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
    disposition: BTreeMap<String, i32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SubtitleSourceType {
    Embedded,
    External,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SubtitleKind {
    Text,
    Bitmap,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
struct MediaBinItem {
    id: String,
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
#[serde(deny_unknown_fields)]
struct MediaBinFolder {
    id: String,
    name: String,
    parent_id: Option<String>,
    color: String,
    hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MediaBinState {
    items: Vec<MediaBinItem>,
    folders: Vec<MediaBinFolder>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewState {
    use_proxy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorState {
    active_video_id: String,
    active_track_id: String,
    subtitle_selections: BTreeMap<String, BTreeMap<String, Vec<String>>>,
    detached_video_ids: Vec<String>,
    preview: PreviewState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoryboardShot {
    id: String,
    sequence: usize,
    start_frame: usize,
    end_frame: usize,
    start_us: i64,
    end_us: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StoryboardColorLabel {
    Red,
    Yellow,
    Green,
    Blue,
    Purple,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoryboardAnnotation {
    rating: u8,
    retained: bool,
    excluded: bool,
    title: Option<String>,
    color_label: Option<StoryboardColorLabel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoryboardStack {
    id: String,
    shot_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoryboardState {
    shots: Vec<StoryboardShot>,
    shot_stacks: Vec<StoryboardStack>,
    shot_annotations: BTreeMap<String, StoryboardAnnotation>,
}

impl ProjectModel for Model {
    const VERSION: u16 = 3;

    fn decode(payload: &[u8]) -> AppResult<Self> {
        serde_json::from_slice(payload).map_err(|error| {
            app_error(
                ErrorCode::ProjectDecodeFailed,
                format!("Failed to decode the V3 project model: {error}"),
            )
        })
    }

    fn encode(&self) -> AppResult<Vec<u8>> {
        serde_json::to_vec(self).map_err(|error| {
            app_error(
                ErrorCode::ProjectEncodeFailed,
                format!("Failed to encode the V3 project model: {error}"),
            )
        })
    }

    fn into_upgrade_parts(self) -> AppResult<UpgradeParts> {
        let workspace = serde_json::to_value(self.workspace).map_err(|error| {
            app_error(
                ErrorCode::ProjectMigrationFailed,
                format!("Failed to convert the V3 workspace into migration data: {error}"),
            )
        })?;
        Ok(UpgradeParts {
            workspace,
            saved_at: self.saved_at,
            app_version: self.app_version,
        })
    }
}

impl UpgradeFrom<v2::Model> for Model {
    fn upgrade_from(previous: v2::Model) -> AppResult<Self> {
        let UpgradeParts {
            mut workspace,
            saved_at,
            app_version,
        } = previous.into_upgrade_parts()?;
        let workspace_object = workspace.as_object_mut().ok_or_else(|| {
            app_error(
                ErrorCode::ProjectMigrationFailed,
                "The V2 project workspace is not an object",
            )
        })?;
        workspace_object.insert(
            "storyboards".to_string(),
            Value::Object(serde_json::Map::new()),
        );

        Ok(Self {
            workspace: serde_json::from_value(workspace).map_err(|error| {
                app_error(
                    ErrorCode::ProjectMigrationFailed,
                    format!("Failed to migrate the V2 workspace to V3: {error}"),
                )
            })?,
            saved_at,
            app_version,
        })
    }
}

impl CurrentProjectModel for Model {
    fn from_runtime(
        workspace: &ProjectWorkspace,
        saved_at: u64,
        app_version: &str,
    ) -> AppResult<Self> {
        let value = serde_json::to_value(workspace).map_err(|error| {
            app_error(
                ErrorCode::ProjectEncodeFailed,
                format!("Failed to serialize the runtime project state: {error}"),
            )
        })?;
        Ok(Self {
            workspace: serde_json::from_value(value).map_err(|error| {
                app_error(
                    ErrorCode::ProjectEncodeFailed,
                    format!("Runtime project state is incompatible with the V3 model: {error}"),
                )
            })?,
            saved_at,
            app_version: app_version.to_string(),
        })
    }

    fn into_runtime(self) -> AppResult<ProjectWorkspace> {
        let value = serde_json::to_value(self.workspace).map_err(|error| {
            app_error(
                ErrorCode::ProjectDecodeFailed,
                format!("Failed to serialize the V3 project model for runtime conversion: {error}"),
            )
        })?;
        serde_json::from_value(value).map_err(|error| {
            app_error(
                ErrorCode::ProjectDecodeFailed,
                format!("The V3 project model is incompatible with runtime state: {error}"),
            )
        })
    }
}
