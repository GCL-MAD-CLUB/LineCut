use super::*;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaImportDropRegion {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl MediaImportDropRegion {
    fn contains(self, x: i32, y: i32) -> bool {
        x >= self.left && x <= self.right && y >= self.top && y <= self.bottom
    }
}

#[cfg(windows)]
static MEDIA_IMPORT_DROP_REGION: Mutex<Option<MediaImportDropRegion>> = Mutex::new(None);

#[tauri::command]
pub(crate) fn set_media_import_drop_region(
    region: Option<MediaImportDropRegion>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        *MEDIA_IMPORT_DROP_REGION
            .lock()
            .map_err(|_| "媒体导入投放区域锁定失败".to_string())? = region;
    }

    #[cfg(not(windows))]
    let _ = region;

    Ok(())
}

#[cfg(windows)]
mod windows_drop_target {
    use super::*;
    use std::{
        cell::{RefCell, UnsafeCell},
        ffi::OsString,
        os::{raw::c_void, windows::ffi::OsStringExt},
        ptr,
    };
    use tauri::Manager;
    use windows::{
        core::{implement, BOOL},
        Win32::{
            Foundation::{HWND, LPARAM, POINT, POINTL},
            Graphics::Gdi::ScreenToClient,
            System::{
                Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL},
                Ole::{
                    IDropTarget, IDropTarget_Impl, RegisterDragDrop, RevokeDragDrop, CF_HDROP,
                    DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
                },
                SystemServices::MODIFIERKEYS_FLAGS,
            },
            UI::{
                Shell::{DragFinish, DragQueryFileW, HDROP},
                WindowsAndMessaging::EnumChildWindows,
            },
        },
    };

    const DRAG_ENTER_EVENT: &str = "tauri://drag-enter";
    const DRAG_OVER_EVENT: &str = "tauri://drag-over";
    const DRAG_DROP_EVENT: &str = "tauri://drag-drop";
    const DRAG_LEAVE_EVENT: &str = "tauri://drag-leave";

    thread_local! {
        static DRAG_DROP_CONTROLLER: RefCell<Option<DragDropController>> = const { RefCell::new(None) };
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DragPosition {
        x: i32,
        y: i32,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DragPathsPayload {
        paths: Vec<PathBuf>,
        position: DragPosition,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DragPositionPayload {
        position: DragPosition,
    }

    struct DragDropController {
        drop_targets: Vec<(HWND, IDropTarget)>,
    }

    impl DragDropController {
        fn new(hwnd: HWND, app: tauri::AppHandle) -> Self {
            let mut controller = Self {
                drop_targets: Vec::new(),
            };
            let mut callback = |child_hwnd| controller.inject(child_hwnd, app.clone());
            let mut callback_ref: &mut dyn FnMut(HWND) -> bool = &mut callback;
            let callback_pointer: *mut c_void = unsafe { std::mem::transmute(&mut callback_ref) };
            let callback_param = LPARAM(callback_pointer as isize);

            unsafe extern "system" fn enumerate_child(hwnd: HWND, param: LPARAM) -> BOOL {
                let callback = &mut *(param.0 as *mut c_void as *mut &mut dyn FnMut(HWND) -> bool);
                callback(hwnd).into()
            }

            let _ = unsafe { EnumChildWindows(Some(hwnd), Some(enumerate_child), callback_param) };
            controller
        }

        fn inject(&mut self, hwnd: HWND, app: tauri::AppHandle) -> bool {
            let target: IDropTarget = SystemFileDropTarget::new(hwnd, app).into();
            let _ = unsafe { RevokeDragDrop(hwnd) };
            if unsafe { RegisterDragDrop(hwnd, &target) }.is_ok() {
                self.drop_targets.push((hwnd, target));
            }
            true
        }
    }

    impl Drop for DragDropController {
        fn drop(&mut self) {
            for (hwnd, _) in &self.drop_targets {
                let _ = unsafe { RevokeDragDrop(*hwnd) };
            }
        }
    }

    #[implement(IDropTarget)]
    struct SystemFileDropTarget {
        hwnd: HWND,
        app: tauri::AppHandle,
        enter_is_valid: UnsafeCell<bool>,
    }

    impl SystemFileDropTarget {
        fn new(hwnd: HWND, app: tauri::AppHandle) -> Self {
            Self {
                hwnd,
                app,
                enter_is_valid: false.into(),
            }
        }

        fn client_position(&self, point: &POINTL) -> POINT {
            let mut position = POINT {
                x: point.x,
                y: point.y,
            };
            let _ = unsafe { ScreenToClient(self.hwnd, &mut position) };
            position
        }

        fn point_is_allowed(position: &POINT) -> bool {
            MEDIA_IMPORT_DROP_REGION
                .lock()
                .ok()
                .and_then(|region| *region)
                .is_some_and(|region| region.contains(position.x, position.y))
        }

        fn effect_for(position: &POINT) -> DROPEFFECT {
            if Self::point_is_allowed(position) {
                DROPEFFECT_COPY
            } else {
                DROPEFFECT_NONE
            }
        }

        fn position_payload(position: &POINT) -> DragPosition {
            DragPosition {
                x: position.x,
                y: position.y,
            }
        }

        fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
            let _ = self.app.emit_to("main", event, payload);
        }

        fn allow_asset_paths(&self, paths: &[PathBuf]) {
            let scope = self.app.asset_protocol_scope();
            for path in paths {
                if path.is_file() {
                    let _ = scope.allow_file(path);
                } else if path.is_dir() {
                    let _ = scope.allow_directory(path, true);
                }
            }
        }

        unsafe fn file_paths(
            data_object: windows_core::Ref<'_, IDataObject>,
        ) -> Option<(HDROP, Vec<PathBuf>)> {
            let drop_format = FORMATETC {
                cfFormat: CF_HDROP.0,
                ptd: ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            };
            let medium = data_object.as_ref()?.GetData(&drop_format).ok()?;
            let drop_handle = HDROP(medium.u.hGlobal.0 as _);
            let item_count = DragQueryFileW(drop_handle, 0xFFFFFFFF, None);
            let mut paths = Vec::with_capacity(item_count as usize);

            for index in 0..item_count {
                let character_count = DragQueryFileW(drop_handle, index, None) as usize;
                let mut buffer = vec![0; character_count + 1];
                DragQueryFileW(drop_handle, index, Some(&mut buffer));
                paths.push(OsString::from_wide(&buffer[..character_count]).into());
            }

            Some((drop_handle, paths))
        }
    }

    #[allow(non_snake_case)]
    impl IDropTarget_Impl for SystemFileDropTarget_Impl {
        fn DragEnter(
            &self,
            data_object: windows_core::Ref<'_, IDataObject>,
            _key_state: MODIFIERKEYS_FLAGS,
            point: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            let position = self.client_position(point);
            let Some((_drop_handle, paths)) =
                (unsafe { SystemFileDropTarget::file_paths(data_object) })
            else {
                unsafe {
                    *effect = DROPEFFECT_NONE;
                    *self.enter_is_valid.get() = false;
                }
                return Ok(());
            };
            unsafe {
                *self.enter_is_valid.get() = true;
                *effect = SystemFileDropTarget::effect_for(&position);
            }
            self.emit(
                DRAG_ENTER_EVENT,
                DragPathsPayload {
                    paths,
                    position: SystemFileDropTarget::position_payload(&position),
                },
            );
            Ok(())
        }

        fn DragOver(
            &self,
            _key_state: MODIFIERKEYS_FLAGS,
            point: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            if unsafe { *self.enter_is_valid.get() } {
                let position = self.client_position(point);
                unsafe {
                    *effect = SystemFileDropTarget::effect_for(&position);
                }
                self.emit(
                    DRAG_OVER_EVENT,
                    DragPositionPayload {
                        position: SystemFileDropTarget::position_payload(&position),
                    },
                );
            } else {
                unsafe {
                    *effect = DROPEFFECT_NONE;
                }
            }
            Ok(())
        }

        fn DragLeave(&self) -> windows::core::Result<()> {
            if unsafe { *self.enter_is_valid.get() } {
                unsafe {
                    *self.enter_is_valid.get() = false;
                }
                self.emit(DRAG_LEAVE_EVENT, ());
            }
            Ok(())
        }

        fn Drop(
            &self,
            data_object: windows_core::Ref<'_, IDataObject>,
            _key_state: MODIFIERKEYS_FLAGS,
            point: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            if !unsafe { *self.enter_is_valid.get() } {
                unsafe {
                    *effect = DROPEFFECT_NONE;
                }
                return Ok(());
            }

            let position = self.client_position(point);
            let allowed = SystemFileDropTarget::point_is_allowed(&position);
            unsafe {
                *effect = SystemFileDropTarget::effect_for(&position);
                *self.enter_is_valid.get() = false;
            }

            if let Some((drop_handle, paths)) =
                unsafe { SystemFileDropTarget::file_paths(data_object) }
            {
                if allowed {
                    self.allow_asset_paths(&paths);
                }
                self.emit(
                    DRAG_DROP_EVENT,
                    DragPathsPayload {
                        paths,
                        position: SystemFileDropTarget::position_payload(&position),
                    },
                );
                unsafe { DragFinish(drop_handle) };
            } else {
                self.emit(DRAG_LEAVE_EVENT, ());
            }
            Ok(())
        }
    }

    pub(super) fn install(
        app: tauri::AppHandle,
        hwnd: HWND,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let controller = DragDropController::new(hwnd, app);
        if controller.drop_targets.is_empty() {
            return Err("无法注册系统文件拖放目标".into());
        }
        DRAG_DROP_CONTROLLER.with(|slot| {
            *slot.borrow_mut() = Some(controller);
        });
        Ok(())
    }
}

#[cfg(windows)]
pub(crate) fn install_system_file_drop(
    app: tauri::AppHandle,
    hwnd: windows::Win32::Foundation::HWND,
) -> Result<(), Box<dyn std::error::Error>> {
    windows_drop_target::install(app, hwnd)
}
