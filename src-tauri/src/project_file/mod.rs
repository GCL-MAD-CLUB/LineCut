use crate::{app_error, AppResult, ErrorCode, ProjectWorkspace};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

mod auto_save;
mod handle_v1;
mod io;
mod keyring;
mod models;
mod protocol;

pub(crate) fn normalize_project_path(path: &str) -> AppResult<PathBuf> {
    io::normalize_path(path)
}

pub(crate) fn write_project_file(path: &Path, workspace: ProjectWorkspace) -> AppResult<()> {
    let encrypted = encode_current_workspace(&workspace)?;
    io::write_atomic(path, &encrypted)
}

pub(crate) fn write_auto_save_snapshot(
    cache_root: &Path,
    project_name: &str,
    workspace: ProjectWorkspace,
    max_snapshots: usize,
) -> AppResult<Option<PathBuf>> {
    auto_save::write_snapshot(cache_root, project_name, &workspace, max_snapshots)
}

fn encode_current_workspace(workspace: &ProjectWorkspace) -> AppResult<Vec<u8>> {
    let current = models::from_runtime(
        workspace,
        crate::now_millis() as u64,
        env!("CARGO_PKG_VERSION"),
    )?;
    let plaintext = Zeroizing::new(models::encode_current(&current)?);
    protocol::seal(models::current_version(), plaintext.as_slice())
}

pub(crate) fn read_project_file(path: &Path) -> AppResult<ProjectWorkspace> {
    let bytes = io::read(path)?;
    let bytes = bytes.as_slice();
    let current = if protocol::recognizes(bytes) {
        let opened = protocol::open(bytes)?;
        models::decode_current(opened.content_version, opened.plaintext.as_slice())?
    } else if handle_v1::recognizes(bytes) {
        models::upgrade_v1(handle_v1::decode(bytes)?)?
    } else {
        return Err(app_error(
            ErrorCode::ProjectFormatInvalid,
            "Input is not a recognized LineCut project file",
        ));
    };
    models::into_runtime(current)
}
