use crate::ProjectWorkspace;
use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::handle_v1;

mod v2;

#[allow(dead_code)] // Required by the uniform model contract before V3 exists.
pub(super) struct UpgradeParts {
    pub(super) workspace: Value,
    pub(super) saved_at: u64,
    pub(super) app_version: String,
}

#[allow(dead_code)] // `into_upgrade_parts` becomes production code when the next model is added.
pub(super) trait ProjectModel: Sized {
    const VERSION: u16;

    fn decode(payload: &[u8]) -> Result<Self, String>;
    fn encode(&self) -> Result<Vec<u8>, String>;
    #[allow(dead_code)] // Silence warning until used by next model upgrade path
    fn into_upgrade_parts(self) -> Result<UpgradeParts, String>;
}

pub(super) trait UpgradeFrom<Previous>: ProjectModel {
    fn upgrade_from(previous: Previous) -> Result<Self, String>;
}

pub(super) trait CurrentProjectModel: ProjectModel {
    fn from_runtime(
        workspace: &ProjectWorkspace,
        saved_at: u64,
        app_version: &str,
    ) -> Result<Self, String>;

    fn into_runtime(self) -> Result<ProjectWorkspace, String>;
}

pub(super) type Current = v2::Model;

pub(super) fn current_version() -> u16 {
    Current::VERSION
}

pub(super) fn decode_current(version: u16, payload: &[u8]) -> Result<Current, String> {
    match version {
        v2::Model::VERSION => v2::Model::decode(payload),
        version if version > current_version() => Err(format!(
            "项目文件版本 V{version} 高于当前支持的 V{}，请升级 LineCut",
            current_version()
        )),
        version => Err(format!("项目文件 V{version} 没有完整的相邻升级链")),
    }
}

pub(super) fn upgrade_v1(previous: handle_v1::ProjectFile) -> Result<Current, String> {
    v2::Model::upgrade_from(previous)
}

pub(super) fn from_runtime(
    workspace: &ProjectWorkspace,
    saved_at: u64,
    app_version: &str,
) -> Result<Current, String> {
    Current::from_runtime(workspace, saved_at, app_version)
}

pub(super) fn into_runtime(model: Current) -> Result<ProjectWorkspace, String> {
    model.into_runtime()
}

pub(super) fn encode_current(model: &Current) -> Result<Vec<u8>, String> {
    model.encode()
}

pub(super) fn content_hash(workspace: &ProjectWorkspace) -> Result<String, String> {
    let model = Current::from_runtime(workspace, 0, "")?;
    let encoded = Zeroizing::new(model.encode()?);
    let mut hasher = Sha256::new();
    hasher.update(Current::VERSION.to_le_bytes());
    hasher.update(encoded.as_slice());
    Ok(format!("{:x}", hasher.finalize()))
}
