use crate::{app_error, AppResult, ErrorCode, ProjectWorkspace};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::{encode_current_workspace, io, models};

const AUTO_SAVE_DIRECTORY: &str = "LineCut Auto-Save";
const MAX_PROJECT_NAME_CHARS: usize = 80;

struct SnapshotEntry {
    path: PathBuf,
    modified: SystemTime,
}

pub(super) fn write_snapshot(
    cache_root: &Path,
    project_name: &str,
    workspace: &ProjectWorkspace,
    max_snapshots: usize,
) -> AppResult<Option<PathBuf>> {
    let max_snapshots = max_snapshots.max(1);
    let project_name = sanitized_project_name(project_name);
    let hash = models::content_hash(workspace)?;
    let directory = cache_root.join(AUTO_SAVE_DIRECTORY);
    fs::create_dir_all(&directory).map_err(|error| {
        app_error(
            ErrorCode::AutoSaveWriteFailed,
            format!("Failed to create the auto-save directory: {error}"),
        )
    })?;

    let prefix = format!("{project_name}--");
    let file_name = format!("{prefix}{hash}.lcp");
    let output_path = directory.join(&file_name);
    let mut snapshots = snapshots(&directory, Some(&prefix))?;
    sort_newest_first(&mut snapshots);

    if snapshots
        .first()
        .and_then(|snapshot| snapshot.path.file_name())
        .is_some_and(|name| name == file_name.as_str())
    {
        prune_to_global_limit(&directory, max_snapshots, None)?;
        return Ok(None);
    }

    let encrypted = encode_current_workspace(workspace)?;
    io::write_atomic(&output_path, &encrypted)?;
    prune_to_global_limit(&directory, max_snapshots, Some(&output_path))?;
    Ok(Some(output_path))
}

fn prune_to_global_limit(
    directory: &Path,
    max_snapshots: usize,
    current_path: Option<&Path>,
) -> AppResult<()> {
    let mut snapshots = snapshots(directory, None)?;
    let current_snapshot = current_path.and_then(|current_path| {
        snapshots
            .iter()
            .position(|snapshot| snapshot.path == current_path)
            .map(|index| snapshots.remove(index))
    });
    sort_newest_first(&mut snapshots);
    if let Some(current_snapshot) = current_snapshot {
        snapshots.insert(0, current_snapshot);
    }
    prune_snapshots(snapshots.into_iter().skip(max_snapshots))
}

fn sort_newest_first(snapshots: &mut [SnapshotEntry]) {
    snapshots.sort_by(|left, right| {
        right
            .modified
            .cmp(&left.modified)
            .then_with(|| right.path.cmp(&left.path))
    });
}

fn snapshots(directory: &Path, prefix: Option<&str>) -> AppResult<Vec<SnapshotEntry>> {
    let entries = fs::read_dir(directory).map_err(|error| {
        app_error(
            ErrorCode::AutoSaveReadFailed,
            format!("Failed to read the auto-save directory: {error}"),
        )
    })?;
    let mut snapshots = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            app_error(
                ErrorCode::AutoSaveReadFailed,
                format!("Failed to read an auto-save directory entry: {error}"),
            )
        })?;
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if prefix.is_some_and(|prefix| !file_name.starts_with(prefix))
            || !path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("lcp"))
        {
            continue;
        }
        let metadata = entry.metadata().map_err(|error| {
            app_error(
                ErrorCode::AutoSaveReadFailed,
                format!("Failed to read auto-save file metadata: {error}"),
            )
        })?;
        if metadata.is_file() {
            snapshots.push(SnapshotEntry {
                path,
                modified: metadata.modified().unwrap_or(UNIX_EPOCH),
            });
        }
    }
    Ok(snapshots)
}

fn prune_snapshots(entries: impl Iterator<Item = SnapshotEntry>) -> AppResult<()> {
    for entry in entries {
        fs::remove_file(&entry.path).map_err(|error| {
            app_error(
                ErrorCode::AutoSaveWriteFailed,
                format!(
                    "Failed to remove expired auto-save snapshot {}: {error}",
                    entry.path.to_string_lossy()
                ),
            )
        })?;
    }
    Ok(())
}

fn sanitized_project_name(project_name: &str) -> String {
    let trimmed = project_name.trim();
    let without_extension = trimmed
        .strip_suffix(".lcp")
        .or_else(|| trimmed.strip_suffix(".LCP"))
        .unwrap_or(trimmed);
    let sanitized = without_extension
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .take(MAX_PROJECT_NAME_CHARS)
        .collect::<String>();
    let sanitized = sanitized.trim_matches([' ', '.']);
    if sanitized.is_empty() {
        "未命名项目".to_string()
    } else {
        sanitized.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{sanitized_project_name, write_snapshot, AUTO_SAVE_DIRECTORY};
    use crate::project_file::read_project_file;
    use crate::{ProjectEditorState, ProjectMediaBinState, ProjectPreviewState, ProjectWorkspace};
    use std::collections::HashMap;
    use std::fs;
    use uuid::Uuid;

    fn workspace(marker: &str) -> ProjectWorkspace {
        ProjectWorkspace {
            projects: Vec::new(),
            media_bin: ProjectMediaBinState {
                items: Vec::new(),
                folders: Vec::new(),
            },
            editor: ProjectEditorState {
                active_video_id: marker.to_string(),
                active_track_id: String::new(),
                subtitle_selections: HashMap::new(),
                detached_video_ids: Vec::new(),
                preview: ProjectPreviewState { use_proxy: false },
            },
        }
    }

    #[test]
    fn sanitizes_snapshot_project_names() {
        assert_eq!(sanitized_project_name(" demo:lcp?.lcp "), "demo_lcp_");
        assert_eq!(sanitized_project_name("..."), "未命名项目");
    }

    #[test]
    fn snapshots_only_changed_content_and_prunes_globally() {
        let cache_root =
            std::env::temp_dir().join(format!("linecut-auto-save-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&cache_root).unwrap();

        let first = write_snapshot(&cache_root, "Demo.lcp", &workspace("one"), 2)
            .unwrap()
            .unwrap();
        assert!(first.is_file());
        assert_eq!(
            write_snapshot(&cache_root, "Demo.lcp", &workspace("one"), 2).unwrap(),
            None
        );
        let second = write_snapshot(&cache_root, "Demo.lcp", &workspace("two"), 2)
            .unwrap()
            .unwrap();
        let third = write_snapshot(&cache_root, "Demo.lcp", &workspace("three"), 2)
            .unwrap()
            .unwrap();
        let other = write_snapshot(&cache_root, "Other.lcp", &workspace("other"), 2)
            .unwrap()
            .unwrap();

        let files = fs::read_dir(cache_root.join(AUTO_SAVE_DIRECTORY))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|value| value == "lcp"))
            .collect::<Vec<_>>();
        assert_eq!(files.len(), 2);
        assert!(!first.exists());
        assert!(!second.exists());
        assert!(third.exists());
        assert!(other.exists());
        assert_eq!(
            read_project_file(&other).unwrap().editor.active_video_id,
            "other"
        );

        fs::remove_dir_all(cache_root).unwrap();
    }
}
