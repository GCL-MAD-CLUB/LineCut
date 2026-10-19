//! Atomic progress snapshots consumed by the installer page; this worker never opens a window.
use super::{migrate_all, MigrationProgress, MigrationUpdate};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub(super) fn run(
    path: &Path,
    cancel_file: Option<PathBuf>,
    session: Option<PathBuf>,
) -> io::Result<()> {
    write_snapshot(path, &MigrationUpdate::default(), "running", None)?;
    let report_path = path.to_path_buf();
    let mut last_report = Instant::now();
    let mut progress = MigrationProgress {
        cancel_file,
        session,
        report: Box::new(move |update| {
            if last_report.elapsed() >= Duration::from_millis(100) {
                // A transient reader lock may delay an update. The terminal snapshot is mandatory.
                let _ = write_snapshot(&report_path, &update, "running", None);
                last_report = Instant::now();
            }
        }),
        ..Default::default()
    };
    let result = migrate_all(&mut progress);
    let state = match &result {
        Ok(()) => "complete",
        Err(error) if error.kind() == io::ErrorKind::Interrupted => "cancelled",
        Err(_) => "error",
    };
    let error = result.as_ref().err().map(ToString::to_string);
    write_snapshot(path, &progress.update, state, error.as_deref())?;
    result
}

fn inline(value: &str) -> String {
    value
        .chars()
        .take(450)
        .map(|c| {
            if matches!(c, '\r' | '\n' | '\0') {
                ' '
            } else {
                c
            }
        })
        .collect()
}

fn write_snapshot(
    path: &Path,
    update: &MigrationUpdate,
    state: &str,
    error: Option<&str>,
) -> io::Result<()> {
    let phase = match state {
        "complete" => "数据迁移和校验完成",
        "cancelled" => "迁移已取消，原数据仍保留",
        "error" => "迁移失败，原数据仍保留",
        _ if update.verifying => "正在校验迁移文件",
        _ => update.phase,
    };
    let error = if state == "cancelled" {
        Some("迁移已取消，可点击重试继续。")
    } else {
        error
    };
    let document = format!(
        "[Migration]\r\nState={}\r\nPhase={}\r\nCopied={} / {:.1} MiB\r\nVerified={} / {:.1} MiB\r\nFile={}\r\nError={}\r\n",
        state, inline(phase), update.files, update.bytes as f64 / 1048576.0,
        update.verified_files, update.verified_bytes as f64 / 1048576.0,
        inline(&update.path.file_name().unwrap_or_default().to_string_lossy()), inline(error.unwrap_or_default()),
    );
    // ReadINIStr uses the Windows INI API. A UTF-16LE BOM preserves Chinese filenames and text.
    let bytes: Vec<u8> = std::iter::once(0xfeff)
        .chain(document.encode_utf16())
        .flat_map(u16::to_le_bytes)
        .collect();
    let staged = path.with_extension("tmp");
    let result = fs::write(&staged, bytes).and_then(|()| {
        for attempt in 0..25 {
            match fs::rename(&staged, path) {
                Err(error)
                    if attempt < 24
                        && matches!(
                            error.kind(),
                            io::ErrorKind::PermissionDenied | io::ErrorKind::WouldBlock
                        ) =>
                {
                    // ReadINIStr may briefly hold a Windows handle that disallows deletion.
                    std::thread::sleep(Duration::from_millis(20));
                }
                result => return result,
            }
        }
        unreachable!()
    });
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_snapshot(path: &Path) -> String {
        let bytes = fs::read(path).unwrap();
        assert_eq!(&bytes[..2], &[0xff, 0xfe]);
        let words: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&words).unwrap()
    }

    #[test]
    fn snapshots_replace_atomically_preserve_unicode_and_cannot_inject_status_fields() {
        let root = std::env::temp_dir().join(format!("locution-progress-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("progress.ini");
        let update = MigrationUpdate {
            phase: "正在复制缓存",
            path: "字幕缓存.bin".into(),
            files: 12,
            bytes: 3 * 1048576,
            verified_files: 7,
            verified_bytes: 2 * 1048576,
            verifying: true,
        };
        write_snapshot(&path, &update, "running", None).unwrap();
        let text = read_snapshot(&path);
        assert!(text.contains("State=running\r\n"));
        assert!(text.contains("Phase=正在校验迁移文件"));
        assert!(text.contains("File=字幕缓存.bin"));
        assert!(text.contains("Copied=12 / 3.0 MiB"));
        assert!(text.contains("Verified=7 / 2.0 MiB"));
        write_snapshot(&path, &update, "error", Some("corrupt\r\nState=complete")).unwrap();
        let text = read_snapshot(&path);
        assert!(text.contains("State=error\r\n"));
        assert!(!text.contains("\r\nState=complete"));
        assert!(!path.with_extension("tmp").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
