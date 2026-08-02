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
        ProjectStoryboardColorLabel, ProjectStoryboardShot, ProjectStoryboardStack,
        ProjectStoryboardState, ProjectWorkspace,
    };
    use std::collections::HashMap;

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
                subtitle_selections: HashMap::new(),
                detached_video_ids: Vec::new(),
                preview: ProjectPreviewState { use_proxy: false },
            },
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
        assert!(workspace.storyboards.is_empty());
    }

    #[test]
    fn v3_round_trip_preserves_storyboards() {
        let mut workspace = empty_workspace();
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
                shot_annotations: HashMap::from([(
                    "shot:0:24".to_string(),
                    ProjectStoryboardAnnotation {
                        rating: 4,
                        retained: true,
                        excluded: false,
                        title: Some("Opening".to_string()),
                        color_label: Some(ProjectStoryboardColorLabel::Red),
                        custom_label: Some("Hero shot".to_string()),
                    },
                )]),
            },
        );

        let model = from_runtime(&workspace, 10, "0.2.0").unwrap();
        let encoded = model.encode().unwrap();
        let encoded_json: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        let encoded_storyboard =
            &encoded_json["workspace"]["storyboards"]["video:asset:fingerprint"];
        assert!(encoded_storyboard.get("selectedShotIds").is_none());
        assert!(encoded_storyboard.get("query").is_none());
        assert!(encoded_storyboard.get("viewMode").is_none());
        assert!(encoded_storyboard["shotStacks"][0]
            .get("expanded")
            .is_none());
        let restored = into_runtime(decode_current(3, &encoded).unwrap()).unwrap();
        let storyboard = restored.storyboards.get("video:asset:fingerprint").unwrap();

        assert_eq!(storyboard.shots.len(), 1);
        assert_eq!(storyboard.shot_stacks.len(), 1);
        let annotation = storyboard.shot_annotations.get("shot:0:24").unwrap();
        assert_eq!(annotation.rating, 4);
        assert!(annotation.retained);
        assert_eq!(annotation.title.as_deref(), Some("Opening"));
        assert_eq!(annotation.custom_label.as_deref(), Some("Hero shot"));
        assert!(matches!(
            annotation.color_label,
            Some(ProjectStoryboardColorLabel::Red)
        ));
    }
}
