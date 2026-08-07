use super::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const WORKSPACE_CONFIG_FILE_NAME: &str = "WorkspaceConfig.xml";

/// Frontend-facing JSON representation, matching TypeScript `PanelManagerInitialState`
/// plus the per-project persistent state store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct WorkspaceConfig {
    #[serde(rename = "focusedPanelId")]
    pub(crate) focused_panel_id: Option<String>,
    pub(crate) instances: Vec<WorkspaceInstance>,
    pub(crate) layout: DockLayoutState,
    /// Per-project persistent state keyed by the project document id. The fixed
    /// `ProjectStateConfig` template keeps the store constrained while leaving
    /// room for additional state kinds later.
    #[serde(default)]
    pub(crate) project_states: HashMap<String, ProjectStateConfig>,
}

/// Fixed template for the state associated with one project id. Only
/// `export_state` is defined today; future state kinds are added as fields.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectStateConfig {
    #[serde(default)]
    pub(crate) export_state: Option<ExportOptions>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct WorkspaceInstance {
    pub(crate) id: String,
    #[serde(rename = "type")]
    pub(crate) panel_type: String,
    pub(crate) params: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct DockLayoutState {
    pub(crate) root: DockLayoutNode,
    pub(crate) areas: HashMap<String, DockAreaState>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum DockLayoutNode {
    #[serde(rename = "area")]
    Area {
        #[serde(rename = "areaId")]
        area_id: String,
    },
    #[serde(rename = "split")]
    Split {
        id: String,
        axis: String,
        ratio: f64,
        first: Box<DockLayoutNode>,
        second: Box<DockLayoutNode>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct DockAreaState {
    pub(crate) tabs: Vec<String>,
    #[serde(rename = "activePanelId")]
    pub(crate) active_panel_id: Option<String>,
}

/// XML on-disk representation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename = "WorkspaceConfig")]
struct WorkspaceConfigXml {
    #[serde(rename = "FocusedPanel", skip_serializing_if = "Option::is_none")]
    focused_panel_id: Option<String>,
    #[serde(rename = "Instances")]
    instances: WorkspaceInstancesXml,
    #[serde(rename = "Layout")]
    layout: LayoutNodeXml,
    #[serde(rename = "ProjectStates", default)]
    project_states: WorkspaceProjectStatesXml,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WorkspaceProjectStatesXml {
    #[serde(rename = "ProjectState", default)]
    project_state: Vec<WorkspaceProjectStateXml>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceProjectStateXml {
    #[serde(rename = "@projectId")]
    project_id: String,
    /// The fixed `ProjectStateConfig` template, JSON-encoded like panel params.
    #[serde(rename = "@state")]
    state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceInstancesXml {
    #[serde(rename = "Instance", default)]
    instance: Vec<WorkspaceInstanceXml>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceInstanceXml {
    #[serde(rename = "@id")]
    id: String,
    #[serde(rename = "@type")]
    panel_type: String,
    #[serde(rename = "@params")]
    params: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LayoutNodeXml {
    #[serde(rename = "@type")]
    node_type: String,
    #[serde(rename = "@id")]
    id: String,
    #[serde(rename = "@axis", skip_serializing_if = "Option::is_none")]
    axis: Option<String>,
    #[serde(rename = "@ratio", skip_serializing_if = "Option::is_none")]
    ratio: Option<f64>,
    #[serde(rename = "@activePanelId", skip_serializing_if = "Option::is_none")]
    active_panel_id: Option<String>,
    #[serde(rename = "Tab", default)]
    tabs: Vec<String>,
    #[serde(rename = "First", default, skip_serializing_if = "Option::is_none")]
    first: Option<Box<LayoutNodeXml>>,
    #[serde(rename = "Second", default, skip_serializing_if = "Option::is_none")]
    second: Option<Box<LayoutNodeXml>>,
}

impl WorkspaceConfig {
    fn into_xml(self) -> AppResult<WorkspaceConfigXml> {
        self.validate()?;
        let instances = WorkspaceInstancesXml {
            instance: self
                .instances
                .into_iter()
                .map(|instance| {
                    let params = serde_json::to_string(&instance.params).map_err(|error| {
                        app_error(
                            ErrorCode::WorkspaceConfigEncodeFailed,
                            format!("Failed to encode panel params for {}: {error}", instance.id),
                        )
                    })?;
                    Ok(WorkspaceInstanceXml {
                        id: instance.id,
                        panel_type: instance.panel_type,
                        params,
                    })
                })
                .collect::<AppResult<Vec<_>>>()?,
        };
        let layout = layout_node_to_xml(self.layout.root, &self.layout.areas)?;
        let mut project_states = self
            .project_states
            .into_iter()
            .map(|(project_id, config)| {
                let state = serde_json::to_string(&config).map_err(|error| {
                    app_error(
                        ErrorCode::WorkspaceConfigEncodeFailed,
                        format!("Failed to encode project state for {project_id}: {error}"),
                    )
                })?;
                Ok(WorkspaceProjectStateXml { project_id, state })
            })
            .collect::<AppResult<Vec<_>>>()?;
        // Deterministic file layout.
        project_states.sort_by(|left, right| left.project_id.cmp(&right.project_id));
        Ok(WorkspaceConfigXml {
            focused_panel_id: self.focused_panel_id,
            instances,
            layout,
            project_states: WorkspaceProjectStatesXml {
                project_state: project_states,
            },
        })
    }

    fn validate(&self) -> AppResult<()> {
        let instance_ids = self
            .instances
            .iter()
            .map(|instance| instance.id.as_str())
            .collect::<HashSet<_>>();
        if instance_ids.len() != self.instances.len()
            || self
                .instances
                .iter()
                .any(|instance| instance.id.is_empty() || instance.panel_type.is_empty())
        {
            return Err(app_error(
                ErrorCode::WorkspaceConfigDecodeFailed,
                "Workspace config contains duplicate or invalid panel instances",
            ));
        }

        let mut area_ids = HashSet::new();
        let mut split_ids = HashSet::new();
        validate_layout_node(&self.layout.root, &mut area_ids, &mut split_ids)?;
        if area_ids.len() != self.layout.areas.len()
            || self
                .layout
                .areas
                .keys()
                .any(|area_id| !area_ids.contains(area_id))
        {
            return Err(app_error(
                ErrorCode::WorkspaceConfigDecodeFailed,
                "Workspace config layout areas do not match its layout tree",
            ));
        }

        let mut docked_panel_ids = HashSet::new();
        for area_id in area_ids {
            let area = self.layout.areas.get(area_id).ok_or_else(|| {
                app_error(
                    ErrorCode::WorkspaceConfigDecodeFailed,
                    format!("Workspace config is missing area {area_id}"),
                )
            })?;
            if area
                .tabs
                .iter()
                .any(|panel_id| !instance_ids.contains(panel_id.as_str()))
                || area
                    .tabs
                    .iter()
                    .any(|panel_id| !docked_panel_ids.insert(panel_id.as_str()))
                || area
                    .active_panel_id
                    .as_ref()
                    .is_some_and(|panel_id| !area.tabs.contains(panel_id))
            {
                return Err(app_error(
                    ErrorCode::WorkspaceConfigDecodeFailed,
                    format!("Workspace config contains invalid tabs in area {area_id}"),
                ));
            }
        }
        if docked_panel_ids != instance_ids
            || self
                .focused_panel_id
                .as_ref()
                .is_some_and(|panel_id| !instance_ids.contains(panel_id.as_str()))
        {
            return Err(app_error(
                ErrorCode::WorkspaceConfigDecodeFailed,
                "Workspace config contains invalid panel references",
            ));
        }
        Ok(())
    }
}

impl WorkspaceConfigXml {
    fn into_json(self) -> AppResult<WorkspaceConfig> {
        let instances = self
            .instances
            .instance
            .into_iter()
            .map(|instance| {
                let params = if instance.params.trim().is_empty() {
                    serde_json::Value::Object(serde_json::Map::new())
                } else {
                    serde_json::from_str(&instance.params).map_err(|error| {
                        app_error(
                            ErrorCode::WorkspaceConfigDecodeFailed,
                            format!("Failed to decode panel params for {}: {error}", instance.id),
                        )
                    })?
                };
                Ok(WorkspaceInstance {
                    id: instance.id,
                    panel_type: instance.panel_type,
                    params,
                })
            })
            .collect::<AppResult<Vec<_>>>()?;
        let (root, areas) = layout_node_to_json(self.layout)?;
        let mut project_states = HashMap::new();
        for entry in self.project_states.project_state {
            if entry.project_id.is_empty() {
                continue;
            }
            let config = if entry.state.trim().is_empty() {
                ProjectStateConfig::default()
            } else {
                serde_json::from_str(&entry.state).map_err(|error| {
                    app_error(
                        ErrorCode::WorkspaceConfigDecodeFailed,
                        format!(
                            "Failed to decode project state for {}: {error}",
                            entry.project_id
                        ),
                    )
                })?
            };
            project_states.insert(entry.project_id, config);
        }
        let config = WorkspaceConfig {
            focused_panel_id: non_empty_string(self.focused_panel_id),
            instances,
            layout: DockLayoutState { root, areas },
            project_states,
        };
        config.validate()?;
        Ok(config)
    }
}

fn validate_layout_node<'a>(
    node: &'a DockLayoutNode,
    area_ids: &mut HashSet<&'a String>,
    split_ids: &mut HashSet<&'a String>,
) -> AppResult<()> {
    match node {
        DockLayoutNode::Area { area_id } => {
            if area_id.is_empty() || !area_ids.insert(area_id) {
                return Err(app_error(
                    ErrorCode::WorkspaceConfigDecodeFailed,
                    "Workspace config contains duplicate or invalid area identifiers",
                ));
            }
        }
        DockLayoutNode::Split {
            id,
            axis,
            ratio,
            first,
            second,
        } => {
            if id.is_empty()
                || !split_ids.insert(id)
                || !matches!(axis.as_str(), "x" | "y")
                || !ratio.is_finite()
                || !(0.05..=0.95).contains(ratio)
            {
                return Err(app_error(
                    ErrorCode::WorkspaceConfigDecodeFailed,
                    "Workspace config contains an invalid split",
                ));
            }
            validate_layout_node(first, area_ids, split_ids)?;
            validate_layout_node(second, area_ids, split_ids)?;
        }
    }
    Ok(())
}

fn layout_node_to_xml(
    node: DockLayoutNode,
    areas: &HashMap<String, DockAreaState>,
) -> AppResult<LayoutNodeXml> {
    match node {
        DockLayoutNode::Area { area_id } => {
            let area = areas.get(&area_id).ok_or_else(|| {
                app_error(
                    ErrorCode::WorkspaceConfigEncodeFailed,
                    format!("Area {area_id} referenced by layout but not defined in areas"),
                )
            })?;
            Ok(LayoutNodeXml {
                node_type: "area".to_string(),
                id: area_id,
                axis: None,
                ratio: None,
                active_panel_id: area.active_panel_id.clone(),
                tabs: area.tabs.clone(),
                first: None,
                second: None,
            })
        }
        DockLayoutNode::Split {
            id,
            axis,
            ratio,
            first,
            second,
        } => Ok(LayoutNodeXml {
            node_type: "split".to_string(),
            id,
            axis: Some(axis),
            ratio: Some(ratio),
            active_panel_id: None,
            tabs: Vec::new(),
            first: Some(Box::new(layout_node_to_xml(*first, areas)?)),
            second: Some(Box::new(layout_node_to_xml(*second, areas)?)),
        }),
    }
}

fn layout_node_to_json(
    node: LayoutNodeXml,
) -> AppResult<(DockLayoutNode, HashMap<String, DockAreaState>)> {
    let mut areas = HashMap::new();
    let root = convert_layout_node(node, &mut areas)?;
    Ok((root, areas))
}

fn convert_layout_node(
    node: LayoutNodeXml,
    areas: &mut HashMap<String, DockAreaState>,
) -> AppResult<DockLayoutNode> {
    let active_panel_id = non_empty_string(node.active_panel_id);
    match node.node_type.as_str() {
        "area" => {
            if node.axis.is_some()
                || node.ratio.is_some()
                || node.first.is_some()
                || node.second.is_some()
            {
                return Err(app_error(
                    ErrorCode::WorkspaceConfigDecodeFailed,
                    "Workspace config area contains split properties",
                ));
            }
            areas.insert(
                node.id.clone(),
                DockAreaState {
                    tabs: node.tabs,
                    active_panel_id,
                },
            );
            Ok(DockLayoutNode::Area { area_id: node.id })
        }
        "split" => {
            if active_panel_id.is_some() || !node.tabs.is_empty() {
                return Err(app_error(
                    ErrorCode::WorkspaceConfigDecodeFailed,
                    "Workspace config split contains area properties",
                ));
            }
            let axis = node.axis.ok_or_else(|| {
                app_error(
                    ErrorCode::WorkspaceConfigDecodeFailed,
                    "Workspace config split is missing its axis",
                )
            })?;
            let ratio = node.ratio.ok_or_else(|| {
                app_error(
                    ErrorCode::WorkspaceConfigDecodeFailed,
                    "Workspace config split is missing its ratio",
                )
            })?;
            let first = node.first.ok_or_else(|| {
                app_error(
                    ErrorCode::WorkspaceConfigDecodeFailed,
                    "Workspace config split is missing its first child",
                )
            })?;
            let second = node.second.ok_or_else(|| {
                app_error(
                    ErrorCode::WorkspaceConfigDecodeFailed,
                    "Workspace config split is missing its second child",
                )
            })?;
            Ok(DockLayoutNode::Split {
                id: node.id,
                axis,
                ratio,
                first: Box::new(convert_layout_node(*first, areas)?),
                second: Box::new(convert_layout_node(*second, areas)?),
            })
        }
        _ => Err(app_error(
            ErrorCode::WorkspaceConfigDecodeFailed,
            "Workspace config layout contains an unknown node type",
        )),
    }
}

fn non_empty_string(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

fn workspace_config_path() -> PathBuf {
    preferences_file().with_file_name(WORKSPACE_CONFIG_FILE_NAME)
}

/// A valid, empty workspace config so a project-state write can seed the file
/// on its very first save without depending on any panel layout.
fn default_workspace_config() -> WorkspaceConfig {
    WorkspaceConfig {
        focused_panel_id: None,
        instances: Vec::new(),
        layout: DockLayoutState {
            root: DockLayoutNode::Area {
                area_id: "default".to_string(),
            },
            areas: HashMap::from([(
                "default".to_string(),
                DockAreaState {
                    tabs: Vec::new(),
                    active_panel_id: None,
                },
            )]),
        },
        project_states: HashMap::new(),
    }
}

fn read_workspace_config() -> AppResult<WorkspaceConfig> {
    let path = workspace_config_path();
    if !path.exists() {
        return Ok(default_workspace_config());
    }
    let body = fs::read_to_string(&path).map_err(|error| {
        app_error(
            ErrorCode::WorkspaceConfigReadFailed,
            format!(
                "Failed to read workspace config {}: {error}",
                path.display()
            ),
        )
    })?;
    let xml: WorkspaceConfigXml = quick_xml::de::from_str(&body).map_err(|error| {
        app_error(
            ErrorCode::WorkspaceConfigDecodeFailed,
            format!(
                "Failed to parse workspace config {}: {error}",
                path.display()
            ),
        )
    })?;
    xml.into_json()
}

fn write_workspace_config(config: &WorkspaceConfig) -> AppResult<()> {
    let xml = config.clone().into_xml()?;
    let path = workspace_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            app_error(
                ErrorCode::WorkspaceConfigWriteFailed,
                format!(
                    "Failed to create workspace config directory {}: {error}",
                    parent.display()
                ),
            )
        })?;
    }
    let body = quick_xml::se::to_string(&xml).map_err(|error| {
        app_error(
            ErrorCode::WorkspaceConfigEncodeFailed,
            format!("Failed to serialize workspace config: {error}"),
        )
    })?;
    let body = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n{body}");
    // Atomic temp+rename so a crash mid-write cannot corrupt the whole config.
    crate::project_file::write_atomic(&path, body.as_bytes()).map_err(|error| {
        app_error(
            ErrorCode::WorkspaceConfigWriteFailed,
            format!(
                "Failed to write workspace config {}: {error}",
                path.display()
            ),
        )
    })
}

/// Serializes all read-modify-write cycles over WorkspaceConfig.xml so panel
/// autosaves and per-project state updates never clobber each other.
fn workspace_config_guard<'a>(
    state: &'a tauri::State<'_, AppState>,
) -> CommandResult<std::sync::MutexGuard<'a, ()>> {
    state.workspace_config_lock.lock().map_err(|_| {
        app_error(
            ErrorCode::WorkspaceConfigStateUnavailable,
            "Workspace config lock is poisoned",
        )
    })
}

#[tauri::command]
pub(crate) fn load_workspace_config() -> CommandResult<Option<WorkspaceConfig>> {
    let path = workspace_config_path();
    if !path.exists() {
        return Ok(None);
    }
    let config = read_workspace_config()?;
    Ok(Some(config))
}

#[tauri::command]
pub(crate) fn save_workspace_config(
    config: WorkspaceConfig,
    state: tauri::State<'_, AppState>,
) -> CommandResult<()> {
    let _guard = workspace_config_guard(&state)?;
    // The frontend only ever sends the panel layout; keep any per-project state
    // that is already on disk so panel autosaves cannot wipe it.
    let existing = read_workspace_config()?;
    let merged = WorkspaceConfig {
        focused_panel_id: config.focused_panel_id,
        instances: config.instances,
        layout: config.layout,
        project_states: existing.project_states,
    };
    write_workspace_config(&merged)
}

/// Loads every persisted per-project state, keyed by project document id.
#[tauri::command]
pub(crate) fn load_project_states(
    state: tauri::State<'_, AppState>,
) -> CommandResult<HashMap<String, ProjectStateConfig>> {
    let _guard = workspace_config_guard(&state)?;
    Ok(read_workspace_config()?.project_states)
}

/// Upserts the state stored under a project document id. Passing `None` removes
/// the entry so empty state never lingers.
#[tauri::command]
pub(crate) fn save_project_state(
    project_id: String,
    export_state: Option<ExportOptions>,
    state: tauri::State<'_, AppState>,
) -> CommandResult<()> {
    let _guard = workspace_config_guard(&state)?;
    let mut config = read_workspace_config()?;
    if let Some(export_state) = export_state {
        config.project_states.insert(
            project_id,
            ProjectStateConfig {
                export_state: Some(export_state),
            },
        );
    } else {
        config.project_states.remove(&project_id);
    }
    write_workspace_config(&config)
}

/// Removes every per-project state whose document id is not on the keep list.
/// The frontend derives the list from the recently-opened projects list.
#[tauri::command]
pub(crate) fn prune_project_states(
    keep_project_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> CommandResult<()> {
    let _guard = workspace_config_guard(&state)?;
    let keep = keep_project_ids.into_iter().collect::<HashSet<_>>();
    let mut config = read_workspace_config()?;
    config
        .project_states
        .retain(|project_id, _| keep.contains(project_id));
    write_workspace_config(&config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> WorkspaceConfig {
        WorkspaceConfig {
            project_states: HashMap::new(),
            focused_panel_id: Some("history".to_string()),
            instances: vec![
                WorkspaceInstance {
                    id: "source".to_string(),
                    panel_type: "source-monitor".to_string(),
                    params: serde_json::json!({}),
                },
                WorkspaceInstance {
                    id: "history".to_string(),
                    panel_type: "history".to_string(),
                    params: serde_json::json!({}),
                },
            ],
            layout: DockLayoutState {
                root: DockLayoutNode::Split {
                    id: "root".to_string(),
                    axis: "x".to_string(),
                    ratio: 0.5,
                    first: Box::new(DockLayoutNode::Area {
                        area_id: "left".to_string(),
                    }),
                    second: Box::new(DockLayoutNode::Area {
                        area_id: "right".to_string(),
                    }),
                },
                areas: HashMap::from([
                    (
                        "left".to_string(),
                        DockAreaState {
                            tabs: vec!["source".to_string()],
                            active_panel_id: Some("source".to_string()),
                        },
                    ),
                    (
                        "right".to_string(),
                        DockAreaState {
                            tabs: vec!["history".to_string()],
                            active_panel_id: Some("history".to_string()),
                        },
                    ),
                ]),
            },
        }
    }

    #[test]
    fn workspace_config_xml_round_trip_preserves_layout() {
        let config = sample_config();
        let xml = quick_xml::se::to_string(&config.clone().into_xml().unwrap()).unwrap();
        let restored = quick_xml::de::from_str::<WorkspaceConfigXml>(&xml)
            .unwrap()
            .into_json()
            .unwrap();

        assert_eq!(restored, config);
    }

    #[test]
    fn empty_workspace_config_xml_round_trips() {
        let config = WorkspaceConfig {
            project_states: HashMap::new(),
            focused_panel_id: None,
            instances: Vec::new(),
            layout: DockLayoutState {
                root: DockLayoutNode::Area {
                    area_id: "empty".to_string(),
                },
                areas: HashMap::from([(
                    "empty".to_string(),
                    DockAreaState {
                        tabs: Vec::new(),
                        active_panel_id: None,
                    },
                )]),
            },
        };
        let xml = quick_xml::se::to_string(&config.clone().into_xml().unwrap()).unwrap();
        let restored = quick_xml::de::from_str::<WorkspaceConfigXml>(&xml)
            .unwrap()
            .into_json()
            .unwrap();

        assert_eq!(restored, config);
    }

    #[test]
    fn layout_area_identifier_uses_frontend_camel_case() {
        let value = serde_json::to_value(sample_config()).unwrap();
        let first = &value["layout"]["root"]["first"];
        assert_eq!(first["areaId"], "left");
        assert!(first.get("area_id").is_none());
    }

    #[test]
    fn workspace_config_lives_beside_preferences() {
        assert_eq!(
            workspace_config_path().parent(),
            preferences_file().parent(),
        );
    }

    #[test]
    fn project_states_round_trip_through_xml() {
        use crate::{
            ExportAudioChannels, ExportAudioCodec, ExportContainer, ExportDestination,
            ExportEncoderSpeed, ExportExistingFileMode, ExportExtensionCase, ExportMode,
            ExportOptions, ExportQuality, ExportRenameRule, ExportResolution,
        };
        let mut config = sample_config();
        config.project_states.insert(
            "project-1".to_string(),
            ProjectStateConfig {
                export_state: Some(ExportOptions {
                    mode: ExportMode::Individual,
                    container: ExportContainer::Mp4Hevc,
                    resolution: ExportResolution::MatchSource,
                    custom_width: 0,
                    custom_height: 0,
                    frame_rate: None,
                    quality: ExportQuality::VeryHigh,
                    encoder_speed: ExportEncoderSpeed::Quality,
                    include_audio: true,
                    audio_codec: ExportAudioCodec::Opus,
                    audio_sample_rate_hz: Some(48000),
                    audio_channels: ExportAudioChannels::Stereo,
                    audio_bitrate_kbps: 256,
                    import_into_project: true,
                    use_proxy: false,
                    destination: ExportDestination::Desktop,
                    use_subfolder: false,
                    subfolder_name: String::new(),
                    output_dir: r"D:\out".to_string(),
                    output_stem: "clip".to_string(),
                    rename_rule: ExportRenameRule::Filename,
                    custom_name: String::new(),
                    start_number: 1,
                    extension_case: ExportExtensionCase::Lower,
                    output_name: String::new(),
                    existing_file_mode: ExportExistingFileMode::Ask,
                }),
            },
        );
        let xml = quick_xml::se::to_string(&config.clone().into_xml().unwrap()).unwrap();
        assert!(xml.contains("ProjectState"));
        let restored = quick_xml::de::from_str::<WorkspaceConfigXml>(&xml)
            .unwrap()
            .into_json()
            .unwrap();
        assert_eq!(restored, config);
    }

    #[test]
    fn legacy_config_without_project_states_loads_empty() {
        let config = sample_config();
        let xml = quick_xml::se::to_string(&config.clone().into_xml().unwrap()).unwrap();
        // A genuine old config has no ProjectStates element; the empty one
        // emitted by a default config is equivalent to it being absent.
        let xml = xml
            .replace("<ProjectStates></ProjectStates>", "")
            .replace("<ProjectStates/>", "");
        let restored = quick_xml::de::from_str::<WorkspaceConfigXml>(&xml)
            .unwrap()
            .into_json()
            .unwrap();
        assert!(restored.project_states.is_empty());
        assert_eq!(restored, config);
    }
}
