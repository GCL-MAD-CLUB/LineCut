use crate::{app_error, AppResult, ErrorCode, ProjectWorkspace};
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

pub(super) type Current = v2::Model;

pub(super) fn current_version() -> u16 {
    Current::VERSION
}

pub(super) fn decode_current(version: u16, payload: &[u8]) -> AppResult<Current> {
    match version {
        v2::Model::VERSION => v2::Model::decode(payload),
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
    v2::Model::upgrade_from(previous)
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
