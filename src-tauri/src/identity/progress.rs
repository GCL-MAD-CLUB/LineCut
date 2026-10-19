//! A native dialog is available before WebView2 opens the profile being migrated.
use super::{migrate_all, MigrationProgress, MigrationUpdate};
use std::{
    io,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc,
    },
    thread::JoinHandle,
};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{HWND, LPARAM, S_FALSE, S_OK, WPARAM},
        UI::{
            Controls::{
                TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_NOTIFICATIONS,
                TDCBF_CANCEL_BUTTON, TDE_CONTENT, TDF_CALLBACK_TIMER,
                TDF_SHOW_MARQUEE_PROGRESS_BAR, TDM_CLICK_BUTTON, TDM_SET_ELEMENT_TEXT,
                TDM_SET_PROGRESS_BAR_MARQUEE, TDN_BUTTON_CLICKED, TDN_CREATED, TDN_TIMER,
            },
            WindowsAndMessaging::{SendMessageW, IDCANCEL},
        },
    },
};

enum Event {
    Update(MigrationUpdate),
    Finished(io::Result<()>),
}

struct DialogState {
    receiver: Receiver<Event>,
    sender: Option<Sender<Event>>,
    cancelled: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    result: Option<io::Result<()>>,
}

pub(super) fn run() -> io::Result<()> {
    let (sender, receiver) = mpsc::channel();
    let mut state = DialogState {
        receiver,
        sender: Some(sender),
        cancelled: Arc::default(),
        worker: None,
        result: None,
    };
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        pszWindowTitle: w!("Locution Pro — 数据迁移"),
        pszMainInstruction: w!("正在迁移 LineCut 数据"),
        pszContent: w!("正在准备迁移。原数据会保留，新位置的已有数据优先。"),
        pszFooter: w!("数据较多时需要一些时间。取消后可重新运行安装程序继续迁移。"),
        dwFlags: TDF_CALLBACK_TIMER | TDF_SHOW_MARQUEE_PROGRESS_BAR,
        dwCommonButtons: TDCBF_CANCEL_BUTTON,
        pfCallback: Some(callback),
        lpCallbackData: &mut state as *mut DialogState as isize,
        cxWidth: 360,
        ..Default::default()
    };
    // The dialog pumps its own messages while the filesystem work runs on a worker.
    let displayed = unsafe { TaskDialogIndirect(&config, None, None, None) };
    state.cancelled.store(true, Ordering::Relaxed);
    if let Some(worker) = state.worker.take() {
        let _ = worker.join();
    }
    displayed.map_err(io::Error::other)?;
    state.result.unwrap_or_else(|| {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "Migration cancelled",
        ))
    })
}

unsafe extern "system" fn callback(
    hwnd: HWND,
    notification: TASKDIALOG_NOTIFICATIONS,
    _wparam: WPARAM,
    _lparam: LPARAM,
    data: isize,
) -> windows::core::HRESULT {
    // lpCallbackData stays valid for the entire synchronous TaskDialogIndirect call.
    let mut content = None;
    let mut close = false;
    let mut defer_cancel = false;
    // Release the mutable state borrow before SendMessageW: dialog messages can
    // synchronously re-enter this callback (in particular TDM_CLICK_BUTTON).
    {
        let state = &mut *(data as *mut DialogState);
        match notification {
            TDN_CREATED => {
                if let Some(sender) = state.sender.take() {
                    let cancelled = state.cancelled.clone();
                    match std::thread::Builder::new()
                        .name("identity-migration".into())
                        .spawn(move || {
                            let updates = sender.clone();
                            let mut progress = MigrationProgress {
                                cancelled,
                                report: Box::new(move |update| {
                                    let _ = updates.send(Event::Update(update));
                                }),
                                ..Default::default()
                            };
                            let result = migrate_all(&mut progress);
                            let _ = sender.send(Event::Finished(result));
                        }) {
                        Ok(worker) => state.worker = Some(worker),
                        Err(error) => state.result = Some(Err(error)),
                    }
                }
            }
            TDN_TIMER => {
                loop {
                    match state.receiver.try_recv() {
                        Ok(Event::Update(update)) if !state.cancelled.load(Ordering::Relaxed) => {
                            content = Some(describe(&update));
                        }
                        Ok(Event::Update(_)) => {}
                        Ok(Event::Finished(result)) => {
                            state.result = Some(result);
                            break;
                        }
                        Err(mpsc::TryRecvError::Disconnected) if state.result.is_none() => {
                            state.result = Some(Err(io::Error::other(
                                "Migration worker stopped unexpectedly",
                            )));
                            break;
                        }
                        Err(_) => break,
                    }
                }
                close = state.result.is_some();
            }
            TDN_BUTTON_CLICKED if state.result.is_none() => {
                state.cancelled.store(true, Ordering::Relaxed);
                content =
                    Some("正在停止迁移，请稍候。原数据仍保留，重新运行安装程序可继续。".to_owned());
                defer_cancel = true;
            }
            _ => {}
        }
    }
    if notification == TDN_CREATED {
        SendMessageW(
            hwnd,
            TDM_SET_PROGRESS_BAR_MARQUEE.0 as u32,
            Some(WPARAM(1)),
            Some(LPARAM(30)),
        );
    }
    if let Some(content) = content {
        set_content(hwnd, &content);
    }
    if close {
        SendMessageW(
            hwnd,
            TDM_CLICK_BUTTON.0 as u32,
            Some(WPARAM(IDCANCEL.0 as usize)),
            None,
        );
    }
    if defer_cancel {
        return S_FALSE;
    }
    S_OK
}

unsafe fn set_content(hwnd: HWND, text: &str) {
    let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    SendMessageW(
        hwnd,
        TDM_SET_ELEMENT_TEXT.0 as u32,
        Some(WPARAM(TDE_CONTENT.0 as usize)),
        Some(LPARAM(PCWSTR(text.as_ptr()).0 as isize)),
    );
}

fn describe(update: &MigrationUpdate) -> String {
    format!(
        "{}\n已复制 {} 个文件，共 {:.1} MiB\n已校验 {} 个文件，共 {:.1} MiB\n{}",
        if update.verifying {
            "正在校验迁移文件"
        } else {
            update.phase
        },
        update.files,
        update.bytes as f64 / (1024.0 * 1024.0),
        update.verified_files,
        update.verified_bytes as f64 / (1024.0 * 1024.0),
        update
            .path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_displays_the_phase_files_bytes_and_current_file_without_fake_percentages() {
        let update = MigrationUpdate {
            phase: "复制缓存",
            files: 12,
            bytes: 3 * 1024 * 1024,
            path: "cache/current.bin".into(),
            ..Default::default()
        };
        let text = describe(&update);
        assert!(text.contains("复制缓存"));
        assert!(text.contains("12 个文件"));
        assert!(text.contains("3.0 MiB"));
        assert!(text.contains("current.bin"));
        let verifying = describe(&MigrationUpdate {
            verifying: true,
            verified_files: 7,
            verified_bytes: 2 * 1024 * 1024,
            ..update
        });
        assert!(verifying.contains("正在校验迁移文件"));
        assert!(verifying.contains("已校验 7 个文件，共 2.0 MiB"));
    }
}
