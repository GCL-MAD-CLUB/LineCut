use crate::{app_error, AppResult, ErrorCode, ProjectWorkspace};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zeroize::Zeroizing;

mod auto_save;
mod handle_v1;
mod io;
mod keyring;
mod models;
mod protocol;

pub(crate) use io::write_atomic;

pub(crate) fn normalize_project_path(path: &str) -> AppResult<PathBuf> {
    io::normalize_path(path)
}

pub(crate) fn write_project_file(
    path: &Path,
    workspace: ProjectWorkspace,
    project_id: &str,
) -> AppResult<()> {
    let encrypted = encode_current_workspace(&workspace, project_id)?;
    io::write_atomic(path, &encrypted)
}

pub(crate) fn write_auto_save_snapshot(
    cache_root: &Path,
    project_name: &str,
    workspace: ProjectWorkspace,
    project_id: &str,
    max_snapshots: usize,
) -> AppResult<Option<PathBuf>> {
    auto_save::write_snapshot(
        cache_root,
        project_name,
        &workspace,
        project_id,
        max_snapshots,
    )
}

fn encode_current_workspace(workspace: &ProjectWorkspace, project_id: &str) -> AppResult<Vec<u8>> {
    let current = models::from_runtime(
        workspace,
        project_id,
        crate::now_millis() as u64,
        env!("CARGO_PKG_VERSION"),
    )?;
    let plaintext = Zeroizing::new(models::encode_current(&current)?);
    protocol::seal(models::current_version(), plaintext.as_slice())
}

/// Returns the runtime workspace, the persisted document id, and whether the
/// file on disk predates the current content version (so its id was generated
/// in memory and should be written back to keep it stable across opens).
pub(crate) fn read_project_file(path: &Path) -> AppResult<(ProjectWorkspace, String, bool)> {
    let bytes = io::read(path)?;
    let bytes = bytes.as_slice();
    let (current, migrated) = if protocol::recognizes(bytes) {
        let opened = protocol::open(bytes)?;
        let decoded = models::decode_current(opened.content_version, opened.plaintext.as_slice())?;
        (decoded, opened.content_version != models::current_version())
    } else if handle_v1::recognizes(bytes) {
        (models::upgrade_v1(handle_v1::decode(bytes)?)?, true)
    } else {
        return Err(app_error(
            ErrorCode::ProjectFormatInvalid,
            "Input is not a recognized LineCut project file",
        ));
    };
    let (workspace, project_id) = models::into_runtime(current)?;
    // A V4 file written by a pre-refactor build carries no id; mint one so the
    // write-back below fixes it into the file.
    let (project_id, migrated) = if project_id.is_empty() {
        (Uuid::new_v4().to_string(), true)
    } else {
        (project_id, migrated)
    };
    Ok((workspace, project_id, migrated))
}
