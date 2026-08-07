use crate::{app_error, AppResult, ErrorCode, ProjectWorkspace};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::handle_v1;

mod v2;
mod v3;
mod v4;

pub(super) struct UpgradeParts {
    pub(super) workspace: Value,
    pub(super) saved_at: u64,
    pub(super) app_version: String,
}

pub(super) trait ProjectModel: Sized {
    const VERSION: u16;

    fn decode(payload: &[u8]) -> AppResult<Self>;
    fn encode(&self) -> AppResult<Vec<u8>>;
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

pub(super) type Current = v4::Model;

pub(super) fn current_version() -> u16 {
    Current::VERSION
}

pub(super) fn decode_current(version: u16, payload: &[u8]) -> AppResult<Current> {
    match version {
        v2::Model::VERSION => {
            v4::Model::upgrade_from(v3::Model::upgrade_from(v2::Model::decode(payload)?)?)
        }
        v3::Model::VERSION => v4::Model::upgrade_from(v3::Model::decode(payload)?),
        v4::Model::VERSION => v4::Model::decode(payload),
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
    v4::Model::upgrade_from(v3::Model::upgrade_from(v2::Model::upgrade_from(previous)?)?)
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
        ExportAudioChannels, ExportAudioCodec, ExportContainer, ExportDestination,
        ExportEncoderSpeed, ExportExistingFileMode, ExportExtensionCase, ExportMode, ExportOptions,
        ExportQuality, ExportRenameRule, ExportResolution, ProjectEditorState,
        ProjectMediaBinState, ProjectPreviewState, ProjectStoryboardAnnotation,
        ProjectStoryboardColorLabel, ProjectStoryboardKeywordNode,
        ProjectStoryboardKeywordUsageCounters, ProjectStoryboardShot, ProjectStoryboardStack,
        ProjectStoryboardState, ProjectSubtitleAnnotation, ProjectSubtitleColorLabel,
        ProjectSubtitleState, ProjectWorkspace,
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
            export_state: None,
        }
    }

    #[test]
    fn migrates_v2_workspace_to_empty_storyboards_and_export_state() {
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

        assert_eq!(current_version(), 4);
        let workspace = into_runtime(decode_current(2, payload).unwrap()).unwrap();
        assert!(workspace.subtitles.is_empty());
        assert!(workspace.storyboards.is_empty());
        assert!(workspace.export_state.is_none());
    }

    #[test]
    fn v4_round_trip_preserves_annotations_without_subtitle_selection() {
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
                        synonyms: vec!["特写".to_string()],
                    },
                    ProjectStoryboardKeywordNode {
                        id: "keyword:hero".to_string(),
                        name: "hero".to_string(),
                        parent_id: Some("keyword:close-up".to_string()),
                        synonyms: Vec::new(),
                    },
                ],
                recent_keyword_ids: vec![
                    "keyword:hero".to_string(),
                    "keyword:close-up".to_string(),
                ],
                keyword_usage_counters: ProjectStoryboardKeywordUsageCounters {
                    counts: HashMap::from([
                        ("keyword:hero".to_string(), 3),
                        ("keyword:close-up".to_string(), 7),
                    ]),
                    total: 10,
                },
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
                {
                    "id": "keyword:close-up",
                    "name": "close-up",
                    "parentId": null,
                    "synonyms": ["特写"]
                },
                {
                    "id": "keyword:hero",
                    "name": "hero",
                    "parentId": "keyword:close-up"
                }
            ])
        );
        assert_eq!(
            encoded_storyboard["recentKeywordIds"],
            serde_json::json!(["keyword:hero", "keyword:close-up"])
        );
        assert_eq!(
            encoded_storyboard["keywordUsageCounters"],
            serde_json::json!({
                "counts": {
                    "keyword:close-up": 7,
                    "keyword:hero": 3
                },
                "total": 10
            })
        );
        let restored = into_runtime(decode_current(4, &encoded).unwrap()).unwrap();
        assert!(restored.export_state.is_none());
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
        assert_eq!(
            storyboard.recent_keyword_ids,
            vec!["keyword:hero", "keyword:close-up"]
        );
        assert_eq!(storyboard.keyword_usage_counters.total, 10);
        assert_eq!(
            storyboard.keyword_usage_counters.counts.get("keyword:hero"),
            Some(&3)
        );
        assert_eq!(
            storyboard
                .keyword_usage_counters
                .counts
                .get("keyword:close-up"),
            Some(&7)
        );
        assert_eq!(storyboard.keyword_nodes[0].name, "close-up");
        assert_eq!(
            storyboard.keyword_nodes[0].synonyms,
            vec!["特写".to_string()]
        );
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
        // A genuine V3 file has no `export_state`; strip it before decoding as V3.
        workspace.remove("export_state");
        workspace.remove("subtitles");
        workspace["editor"]["subtitle_selections"] = serde_json::json!({
            "video": { "track": ["cue-1"] }
        });

        let encoded = serde_json::to_vec(&encoded).unwrap();
        let restored = into_runtime(decode_current(3, &encoded).unwrap()).unwrap();
        assert!(restored.subtitles.is_empty());
        assert!(restored.export_state.is_none());
    }

    #[test]
    fn export_state_round_trips_all_options_fields() {
        let mut workspace = empty_workspace();
        workspace.export_state = Some(ExportOptions {
            mode: ExportMode::Individual,
            container: ExportContainer::Mp4Hevc,
            resolution: ExportResolution::Custom,
            custom_width: 1920,
            custom_height: 1080,
            frame_rate: Some(30.0),
            quality: ExportQuality::VeryHigh,
            encoder_speed: ExportEncoderSpeed::Quality,
            include_audio: true,
            audio_codec: ExportAudioCodec::Opus,
            audio_sample_rate_hz: Some(48000),
            audio_channels: ExportAudioChannels::Stereo,
            audio_bitrate_kbps: 256,
            import_into_project: true,
            use_proxy: true,
            destination: ExportDestination::Desktop,
            use_subfolder: true,
            subfolder_name: "renders".to_string(),
            output_dir: r"D:\out".to_string(),
            output_stem: "clip".to_string(),
            rename_rule: ExportRenameRule::LabelKeywords,
            custom_name: "shot".to_string(),
            start_number: 5,
            extension_case: ExportExtensionCase::Upper,
            output_name: "final.mp4".to_string(),
            existing_file_mode: ExportExistingFileMode::UniqueName,
        });

        let model = from_runtime(&workspace, 10, "0.2.0").unwrap();
        let encoded = model.encode().unwrap();
        let encoded_json: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        let encoded_export_state = &encoded_json["workspace"]["export_state"];
        // The persisted export_state carries the fields the frontend records, so the
        // key set round-trips (outputName mirrors the frontend ExportSettings field).
        assert_eq!(encoded_export_state["destination"], "desktop");
        assert_eq!(encoded_export_state["subfolderName"], "renders");
        assert_eq!(encoded_export_state["existingFileMode"], "uniqueName");
        assert_eq!(encoded_export_state["outputName"], "final.mp4");

        let restored = into_runtime(decode_current(4, &encoded).unwrap()).unwrap();
        let before = serde_json::to_value(&workspace.export_state).unwrap();
        let after = serde_json::to_value(&restored.export_state).unwrap();
        assert_eq!(before, after);
    }
}
