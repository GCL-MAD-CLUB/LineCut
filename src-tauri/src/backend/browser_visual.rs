use super::*;

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn explorer_icon_has_rgba_pixels() {
        let path = std::env::current_exe().expect("test executable");
        let icon = super::shell_icon(&path.to_string_lossy()).expect("Windows executable icon");
        assert_eq!(icon.pixels.len(), (icon.width * icon.height * 4) as usize);
        assert!(icon.pixels.chunks_exact(4).any(|pixel| pixel[3] > 0));
    }
}

#[derive(Serialize)]
pub(crate) struct BrowserIcon {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

#[tauri::command]
pub(crate) async fn media_browser_icon(path: String) -> CommandResult<Option<BrowserIcon>> {
    Ok(
        tauri::async_runtime::spawn_blocking(move || shell_icon(&path))
            .await
            .ok()
            .flatten(),
    )
}

#[cfg(not(windows))]
fn shell_icon(_path: &str) -> Option<BrowserIcon> {
    None
}

#[cfg(windows)]
fn shell_icon(path: &str) -> Option<BrowserIcon> {
    use windows::core::PCWSTR;
    use windows::Win32::{Foundation::SIZE, Graphics::Gdi::*, System::Com::*, UI::Shell::*};
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().ok()?;
        let result = (|| {
            let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
            let factory: IShellItemImageFactory =
                SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None::<&IBindCtx>).ok()?;
            let bitmap = factory
                .GetImage(
                    SIZE { cx: 64, cy: 64 },
                    SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK,
                )
                .ok()?;
            let result = (|| {
                let mut object = BITMAP::default();
                if GetObjectW(
                    HGDIOBJ(bitmap.0),
                    std::mem::size_of::<BITMAP>() as i32,
                    Some(&mut object as *mut _ as _),
                ) == 0
                {
                    return None;
                }
                let width = object.bmWidth;
                let height = object.bmHeight.abs();
                if width <= 0 || width > 512 || height == 0 || height > 512 {
                    return None;
                }
                let mut info = BITMAPINFO::default();
                info.bmiHeader = BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                };
                let mut pixels = vec![0u8; (width * height * 4) as usize];
                let dc = GetDC(None);
                let rows = GetDIBits(
                    dc,
                    bitmap,
                    0,
                    height as u32,
                    Some(pixels.as_mut_ptr() as _),
                    &mut info,
                    DIB_RGB_COLORS,
                );
                ReleaseDC(None, dc);
                if rows == 0 {
                    return None;
                }
                for pixel in pixels.chunks_exact_mut(4) {
                    pixel.swap(0, 2);
                }
                Some(BrowserIcon {
                    width: width as u32,
                    height: height as u32,
                    pixels,
                })
            })();
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            result
        })();
        CoUninitialize();
        result
    }
}

#[tauri::command]
pub(crate) async fn media_browser_frame(
    path: String,
    time_us: i64,
    state: tauri::State<'_, AppState>,
) -> CommandResult<Vec<u8>> {
    let preferences = preferences_clone(&state)?;
    let mut command = hidden_command(&ffmpeg_program(&preferences));
    command.kill_on_drop(true);
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        command
            .args([
                "-v",
                "error",
                "-ss",
                &format!("{:.6}", time_us.max(0) as f64 / 1_000_000.0),
                "-i",
                &path,
                "-map",
                "0:v:0",
                "-frames:v",
                "1",
                "-vf",
                "scale=480:-2",
                "-threads",
                "1",
                "-f",
                "image2pipe",
                "-vcodec",
                "mjpeg",
                "pipe:1",
            ])
            .output(),
    )
    .await
    .map_err(|_| {
        app_error(
            ErrorCode::ThumbnailNoFrame,
            "Browser frame extraction timed out",
        )
    })?
    .map_err(|error| app_error(ErrorCode::ExternalToolStartFailed, error.to_string()))?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err(app_error(
            ErrorCode::ThumbnailNoFrame,
            "Browser frame extraction produced no frame",
        ));
    }
    Ok(output.stdout)
}
