use crate::{app_error, AppResult, ErrorCode, ProjectWorkspace};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::handle_v1;

mod v2;
mod v3;

#[allow(dead_code)] // Required by the uniform model contract before V3 exists.
pub(super) struct UpgradeParts {
    pub(super) workspace: Value,
    pub(super) saved_at: u64,
    pub(super) app_version: String,
}

#[allow(dead_code)] // `into_upgrade_parts` becomes production code when the next model is added.
pub(super) trait ProjectModel: Sized {
    const VERSION: u16;

    fn decode(payload: &[u8]) -> AppResult<Self>;
    fn encode(&self) -> AppResult<Vec<u8>>;
    #[allow(dead_code)] // Silence warning until used by next model upgrade path
    fn into_upgrade_parts(self) -> AppResult<UpgradeParts>;
}

pub(super) trait UpgradeFrom<Previous>: ProjectModel {
    fn upgrade_from(previous: Previous) -> AppResult<Self>;
}

pub(super) trait CurrentProjectModel: ProjectModel {
    fn from_runtime(
        workspace: &ProjectWorkspace,
        saved_at: u64,
        app_version: &str,
    ) -> AppResult<Self>;

    fn into_runtime(self) -> AppResult<ProjectWorkspace>;
}

pub(super) type Current = v3::Model;

pub(super) fn current_version() -> u16 {
    Current::VERSION
}

pub(super) fn decode_current(version: u16, payload: &[u8]) -> AppResult<Current> {
    match version {
        v2::Model::VERSION => v3::Model::upgrade_from(v2::Model::decode(payload)?),
        v3::Model::VERSION => v3::Model::decode(payload),
        version if version > current_version() => Err(app_error(
            ErrorCode::ProjectVersionUnsupported,
            format!(
                "Project content version V{version} is newer than supported version V{}",
                current_version()
            ),
        )),
        version => Err(app_error(
            ErrorCode::ProjectMigrationFailed,
            format!("Project content version V{version} has no complete migration chain"),
        )),
    }
}

pub(super) fn upgrade_v1(previous: handle_v1::ProjectFile) -> AppResult<Current> {
    v3::Model::upgrade_from(v2::Model::upgrade_from(previous)?)
}

pub(super) fn from_runtime(
    workspace: &ProjectWorkspace,
    saved_at: u64,
    app_version: &str,
) -> AppResult<Current> {
    Current::from_runtime(workspace, saved_at, app_version)
}

pub(super) fn into_runtime(model: Current) -> AppResult<ProjectWorkspace> {
    model.into_runtime()
}

pub(super) fn encode_current(model: &Current) -> AppResult<Vec<u8>> {
    model.encode()
}

pub(super) fn content_hash(workspace: &ProjectWorkspace) -> AppResult<String> {
    let model = Current::from_runtime(workspace, 0, "")?;
    let encoded = Zeroizing::new(model.encode()?);
    let mut hasher = Sha256::new();
    hasher.update(Current::VERSION.to_le_bytes());
    hasher.update(encoded.as_slice());
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::{current_version, decode_current, from_runtime, into_runtime, ProjectModel};
    use crate::{
        ProjectEditorState, ProjectMediaBinState, ProjectPreviewState, ProjectStoryboardAnnotation,
        ProjectStoryboardColorLabel, ProjectStoryboardKeywordNode, ProjectStoryboardShot,
        ProjectStoryboardStack, ProjectStoryboardState, ProjectSubtitleAnnotation,
        ProjectSubtitleColorLabel, ProjectSubtitleState, ProjectWorkspace,
    };
    use std::collections::{BTreeSet, HashMap};

    fn empty_workspace() -> ProjectWorkspace {
        ProjectWorkspace {
            projects: Vec::new(),
            media_bin: ProjectMediaBinState {
                items: Vec::new(),
                folders: Vec::new(),
            },
            editor: ProjectEditorState {
                active_video_id: String::new(),
                active_track_id: String::new(),
                detached_video_ids: Vec::new(),
                preview: ProjectPreviewState { use_proxy: false },
            },
            subtitles: HashMap::new(),
            storyboards: HashMap::new(),
        }
    }

    #[test]
    fn migrates_v2_workspace_to_empty_v3_storyboards() {
        let payload = br#"{
            "workspace": {
                "projects": [],
                "media_bin": { "items": [], "folders": [] },
                "editor": {
                    "active_video_id": "",
                    "active_track_id": "",
                    "subtitle_selections": {},
                    "detached_video_ids": [],
                    "preview": { "use_proxy": false }
                }
            },
            "saved_at": 1,
            "app_version": "0.2.0"
        }"#;

        assert_eq!(current_version(), 3);
        let workspace = into_runtime(decode_current(2, payload).unwrap()).unwrap();
        assert!(workspace.subtitles.is_empty());
        assert!(workspace.storyboards.is_empty());
    }

    #[test]
    fn v3_round_trip_preserves_annotations_without_subtitle_selection() {
        let mut workspace = empty_workspace();
        workspace.subtitles.insert(
            "video:asset:fingerprint:track".to_string(),
            ProjectSubtitleState {
                cue_annotations: HashMap::from([(
                    "cue-1".to_string(),
                    ProjectSubtitleAnnotation {
                        rating: 5,
                        retained: true,
                        excluded: false,
                        color_label: Some(ProjectSubtitleColorLabel::Blue),
                        custom_label: None,
                    },
                )]),
            },
        );
        workspace.storyboards.insert(
            "video:asset:fingerprint".to_string(),
            ProjectStoryboardState {
                shots: vec![ProjectStoryboardShot {
                    id: "shot:0:24".to_string(),
                    sequence: 1,
                    start_frame: 0,
                    end_frame: 24,
                    start_us: 0,
                    end_us: 1_000_000,
                }],
                shot_stacks: vec![ProjectStoryboardStack {
                    id: "stack-1".to_string(),
                    shot_ids: vec!["shot:0:24".to_string(), "shot:25:48".to_string()],
                }],
                keyword_nodes: vec![
                    ProjectStoryboardKeywordNode {
                        id: "keyword:close-up".to_string(),
                        name: "close-up".to_string(),
                        parent_id: None,
                    },
                    ProjectStoryboardKeywordNode {
                        id: "keyword:hero".to_string(),
                        name: "hero".to_string(),
                        parent_id: Some("keyword:close-up".to_string()),
                    },
                ],
                shot_annotations: HashMap::from([(
                    "shot:0:24".to_string(),
                    ProjectStoryboardAnnotation {
                        rating: 4,
                        retained: true,
                        excluded: false,
                        title: Some("Opening".to_string()),
                        keyword_ids: BTreeSet::from([
                            "keyword:close-up".to_string(),
                            "keyword:hero".to_string(),
                        ]),
                        color_label: Some(ProjectStoryboardColorLabel::Red),
                        custom_label: Some("Hero shot".to_string()),
                    },
                )]),
            },
        );

        let model = from_runtime(&workspace, 10, "0.2.0").unwrap();
        let encoded = model.encode().unwrap();
        let encoded_json: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert!(encoded_json["workspace"]["editor"]
            .get("subtitle_selections")
            .is_none());
        let encoded_subtitle =
            &encoded_json["workspace"]["subtitles"]["video:asset:fingerprint:track"];
        assert!(encoded_subtitle.get("selectedCueIds").is_none());
        assert!(encoded_subtitle.get("query").is_none());
        let encoded_storyboard =
            &encoded_json["workspace"]["storyboards"]["video:asset:fingerprint"];
        assert!(encoded_storyboard.get("selectedShotIds").is_none());
        assert!(encoded_storyboard.get("query").is_none());
        assert!(encoded_storyboard.get("viewMode").is_none());
        assert!(encoded_storyboard["shotStacks"][0]
            .get("expanded")
            .is_none());
        assert_eq!(
            encoded_storyboard["shotAnnotations"]["shot:0:24"]["keywordIds"],
            serde_json::json!(["keyword:close-up", "keyword:hero"])
        );
        assert_eq!(
            encoded_storyboard["keywordNodes"],
            serde_json::json!([
                { "id": "keyword:close-up", "name": "close-up", "parentId": null },
                {
                    "id": "keyword:hero",
                    "name": "hero",
                    "parentId": "keyword:close-up"
                }
            ])
        );
        let restored = into_runtime(decode_current(3, &encoded).unwrap()).unwrap();
        let subtitle = restored
            .subtitles
            .get("video:asset:fingerprint:track")
            .unwrap();
        let subtitle_annotation = subtitle.cue_annotations.get("cue-1").unwrap();
        assert_eq!(subtitle_annotation.rating, 5);
        assert!(subtitle_annotation.retained);
        assert!(matches!(
            subtitle_annotation.color_label,
            Some(ProjectSubtitleColorLabel::Blue)
        ));
        let storyboard = restored.storyboards.get("video:asset:fingerprint").unwrap();

        assert_eq!(storyboard.shots.len(), 1);
        assert_eq!(storyboard.shot_stacks.len(), 1);
        let annotation = storyboard.shot_annotations.get("shot:0:24").unwrap();
        assert_eq!(annotation.rating, 4);
        assert!(annotation.retained);
        assert_eq!(annotation.title.as_deref(), Some("Opening"));
        assert_eq!(storyboard.keyword_nodes.len(), 2);
        assert_eq!(storyboard.keyword_nodes[0].name, "close-up");
        assert_eq!(
            storyboard.keyword_nodes[1].parent_id.as_deref(),
            Some("keyword:close-up")
        );
        assert_eq!(
            annotation
                .keyword_ids
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["keyword:close-up", "keyword:hero"]
        );
        assert_eq!(annotation.custom_label.as_deref(), Some("Hero shot"));
        assert!(matches!(
            annotation.color_label,
            Some(ProjectStoryboardColorLabel::Red)
        ));
    }

    #[test]
    fn v3_reader_discards_unreleased_subtitle_selection_state() {
        let model = from_runtime(&empty_workspace(), 10, "0.2.0").unwrap();
        let mut encoded: serde_json::Value =
            serde_json::from_slice(&model.encode().unwrap()).unwrap();
        let workspace = encoded["workspace"].as_object_mut().unwrap();
        workspace.remove("subtitles");
        workspace["editor"]["subtitle_selections"] = serde_json::json!({
            "video": { "track": ["cue-1"] }
        });

        let encoded = serde_json::to_vec(&encoded).unwrap();
        let restored = into_runtime(decode_current(3, &encoded).unwrap()).unwrap();
        assert!(restored.subtitles.is_empty());
    }
}
