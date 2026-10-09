use super::{Project, UserNotice};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaBinItemKind {
    Video,
    Audio,
    Subtitle,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaBinItemOrigin {
    Imported,
    Decomposed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct MediaBinItem {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) bin_id: Option<String>,
    pub(crate) kind: MediaBinItemKind,
    pub(crate) enabled: bool,
    pub(crate) hidden: bool,
    pub(crate) offline: bool,
    pub(crate) path: String,
    pub(crate) file_name: String,
    pub(crate) duration_us: i64,
    pub(crate) start_time_us: i64,
    pub(crate) bound_to_video_id: Option<String>,
    pub(crate) source_video_id: Option<String>,
    pub(crate) stream_index: Option<i32>,
    pub(crate) subtitle_track_id: Option<String>,
    pub(crate) codec: Option<String>,
    pub(crate) language: Option<String>,
    pub(crate) extracted: bool,
    pub(crate) origin: MediaBinItemOrigin,
    pub(crate) color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct MediaBinFolder {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) parent_id: Option<String>,
    #[serde(default)]
    pub(crate) color: String,
    #[serde(default)]
    pub(crate) hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProjectMediaBinState {
    pub(crate) items: Vec<MediaBinItem>,
    #[serde(default)]
    pub(crate) folders: Vec<MediaBinFolder>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProjectPreviewState {
    pub(crate) use_proxy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProjectEditorState {
    pub(crate) active_video_id: String,
    pub(crate) active_track_id: String,
    pub(crate) detached_video_ids: Vec<String>,
    pub(crate) preview: ProjectPreviewState,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectSubtitleColorLabel {
    Red,
    Yellow,
    Green,
    Blue,
    Purple,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSubtitleAnnotation {
    pub(crate) rating: u8,
    pub(crate) retained: bool,
    #[serde(default)]
    pub(crate) excluded: bool,
    #[serde(default)]
    pub(crate) color_label: Option<ProjectSubtitleColorLabel>,
    #[serde(default)]
    pub(crate) custom_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSubtitleState {
    pub(crate) cue_annotations: HashMap<String, ProjectSubtitleAnnotation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProjectStoryboardShot {
    pub(crate) id: String,
    pub(crate) sequence: usize,
    pub(crate) start_frame: usize,
    pub(crate) end_frame: usize,
    pub(crate) start_us: i64,
    pub(crate) end_us: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectStoryboardColorLabel {
    Red,
    Yellow,
    Green,
    Blue,
    Purple,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectStoryboardAnnotation {
    pub(crate) rating: u8,
    pub(crate) retained: bool,
    #[serde(default)]
    pub(crate) excluded: bool,
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) keyword_ids: BTreeSet<String>,
    #[serde(default)]
    pub(crate) color_label: Option<ProjectStoryboardColorLabel>,
    #[serde(default)]
    pub(crate) custom_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectStoryboardKeywordNode {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) synonyms: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectStoryboardStack {
    pub(crate) id: String,
    pub(crate) shot_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectStoryboardKeywordUsageCounters {
    pub(crate) counts: HashMap<String, u64>,
    pub(crate) total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectStoryboardState {
    pub(crate) shots: Vec<ProjectStoryboardShot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) deleted_shots: Vec<ProjectStoryboardShot>,
    pub(crate) shot_stacks: Vec<ProjectStoryboardStack>,
    pub(crate) keyword_nodes: Vec<ProjectStoryboardKeywordNode>,
    pub(crate) recent_keyword_ids: Vec<String>,
    #[serde(default)]
    pub(crate) keyword_usage_counters: ProjectStoryboardKeywordUsageCounters,
    pub(crate) shot_annotations: HashMap<String, ProjectStoryboardAnnotation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProjectWorkspace {
    pub(crate) projects: Vec<Project>,
    pub(crate) media_bin: ProjectMediaBinState,
    pub(crate) editor: ProjectEditorState,
    #[serde(default)]
    pub(crate) subtitles: HashMap<String, ProjectSubtitleState>,
    #[serde(default)]
    pub(crate) storyboards: HashMap<String, ProjectStoryboardState>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct OpenProjectResult {
    pub(crate) path: String,
    /// Stable per-document identity (generated for files that predate it).
    pub(crate) project_id: String,
    pub(crate) workspace: ProjectWorkspace,
    pub(crate) warnings: Vec<UserNotice>,
}
