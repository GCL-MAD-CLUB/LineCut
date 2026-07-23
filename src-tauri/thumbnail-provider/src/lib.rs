use std::{
    ffi::c_void,
    panic::{catch_unwind, AssertUnwindSafe},
    ptr,
};

use windows::Win32::{
    Foundation::{
        CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_FAIL, E_POINTER, S_FALSE, S_OK,
    },
    Graphics::{
        Gdi::{CreateDIBSection, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP},
        Imaging::{
            CLSID_WICImagingFactory, GUID_WICPixelFormat32bppPBGRA, IWICBitmapSource,
            IWICFormatConverter, IWICImagingFactory, IWICPalette, WICBitmapDitherTypeNone,
            WICBitmapInterpolationModeFant, WICBitmapPaletteTypeCustom,
            WICDecodeMetadataCacheOnDemand,
        },
    },
    System::Com::{CoCreateInstance, IClassFactory, IClassFactory_Impl, CLSCTX_INPROC_SERVER},
    UI::Shell::{
        IThumbnailProvider, IThumbnailProvider_Impl,
        PropertiesSystem::{IInitializeWithStream, IInitializeWithStream_Impl},
        WTSAT_ARGB, WTS_ALPHATYPE,
    },
};
use windows_core::{implement, ComObject, IUnknown, Interface, Result, GUID, HRESULT};

/// Must stay in sync with `src-tauri/windows/installer.nsi`.
const LCP_THUMBNAIL_PROVIDER_CLSID: GUID = GUID::from_u128(0x4f4c9cf5_6463_4df7_a2b4_7c3b0cc7e67d);
const EMBEDDED_THUMBNAIL: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/lcp-thumbnail.png"));
const MAX_THUMBNAIL_EDGE: u32 = 2_048;
const MAX_SOURCE_PIXELS: u64 = 16 * 1_024 * 1_024;

#[implement(IThumbnailProvider, IInitializeWithStream)]
struct LcpThumbnailProvider;

impl IInitializeWithStream_Impl for LcpThumbnailProvider_Impl {
    fn Initialize(
        &self,
        _stream: windows_core::Ref<'_, windows::Win32::System::Com::IStream>,
        _mode: u32,
    ) -> Result<()> {
        // The preview is an application-wide card. We deliberately do not read project files here:
        // `.lcp` payloads are authenticated and encrypted, and Explorer must never need their key.
        Ok(())
    }
}

impl IThumbnailProvider_Impl for LcpThumbnailProvider_Impl {
    fn GetThumbnail(
        &self,
        cx: u32,
        bitmap: *mut HBITMAP,
        alpha_type: *mut WTS_ALPHATYPE,
    ) -> Result<()> {
        if bitmap.is_null() || alpha_type.is_null() {
            return Err(E_POINTER.into());
        }

        unsafe {
            *bitmap = HBITMAP::default();
            *alpha_type = WTS_ALPHATYPE::default();
        }

        let edge = cx.clamp(1, MAX_THUMBNAIL_EDGE);
        let thumbnail =
            create_thumbnail_from_asset(edge).or_else(|_| create_fallback_thumbnail(edge))?;

        unsafe {
            *bitmap = thumbnail;
            *alpha_type = WTSAT_ARGB;
        }
        Ok(())
    }
}

#[implement(IClassFactory)]
struct ThumbnailProviderFactory;

impl IClassFactory_Impl for ThumbnailProviderFactory_Impl {
    fn CreateInstance(
        &self,
        outer: windows_core::Ref<'_, IUnknown>,
        interface_id: *const GUID,
        result: *mut *mut c_void,
    ) -> Result<()> {
        if result.is_null() || interface_id.is_null() {
            return Err(E_POINTER.into());
        }
        if !outer.is_null() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }

        unsafe {
            *result = ptr::null_mut();
        }
        let object: IUnknown = ComObject::new(LcpThumbnailProvider).into_interface();
        unsafe { object.query(interface_id, result).ok() }
    }

    fn LockServer(&self, _lock: windows_core::BOOL) -> Result<()> {
        // The DLL is intentionally kept loaded while Explorer is using it. It has no mutable
        // global state, so returning success is sufficient here.
        Ok(())
    }
}

#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    class_id: *const GUID,
    interface_id: *const GUID,
    result: *mut *mut c_void,
) -> HRESULT {
    com_boundary(|| {
        if class_id.is_null() || interface_id.is_null() || result.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe {
            *result = ptr::null_mut();
        }
        if unsafe { *class_id } != LCP_THUMBNAIL_PROVIDER_CLSID {
            return Err(CLASS_E_CLASSNOTAVAILABLE.into());
        }

        let factory: IClassFactory = ComObject::new(ThumbnailProviderFactory).into_interface();
        unsafe { factory.query(interface_id, result).ok() }
    })
}

#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    // Explorer may retain thumbnail bitmaps across view changes. Keeping this tiny DLL resident
    // avoids an unload race; Windows releases the hosting process normally.
    S_FALSE
}

fn com_boundary(operation: impl FnOnce() -> Result<()>) -> HRESULT {
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(Ok(())) => S_OK,
        Ok(Err(error)) => error.code(),
        Err(_) => E_FAIL,
    }
}

fn create_thumbnail_from_asset(max_edge: u32) -> Result<HBITMAP> {
    if EMBEDDED_THUMBNAIL.is_empty() {
        return Err(E_FAIL.into());
    }

    let factory: IWICImagingFactory = unsafe {
        CoCreateInstance(
            &CLSID_WICImagingFactory,
            None::<&IUnknown>,
            CLSCTX_INPROC_SERVER,
        )?
    };
    let stream = unsafe { factory.CreateStream()? };
    unsafe { stream.InitializeFromMemory(EMBEDDED_THUMBNAIL)? };
    let decoder = unsafe {
        factory.CreateDecoderFromStream(&stream, ptr::null(), WICDecodeMetadataCacheOnDemand)?
    };
    let frame = unsafe { decoder.GetFrame(0)? };
    let mut source_width = 0;
    let mut source_height = 0;
    unsafe { frame.GetSize(&mut source_width, &mut source_height)? };
    if source_width == 0
        || source_height == 0
        || u64::from(source_width) * u64::from(source_height) > MAX_SOURCE_PIXELS
    {
        return Err(E_FAIL.into());
    }

    let converter: IWICFormatConverter = unsafe { factory.CreateFormatConverter()? };
    unsafe {
        converter.Initialize(
            &frame,
            &GUID_WICPixelFormat32bppPBGRA,
            WICBitmapDitherTypeNone,
            None::<&IWICPalette>,
            0.0,
            WICBitmapPaletteTypeCustom,
        )?
    };
    let source: IWICBitmapSource = converter.cast()?;
    let (target_width, target_height) = fit_within(source_width, source_height, max_edge);
    let scaled_source = if (target_width, target_height) == (source_width, source_height) {
        source
    } else {
        let scaler = unsafe { factory.CreateBitmapScaler()? };
        unsafe {
            scaler.Initialize(
                &source,
                target_width,
                target_height,
                WICBitmapInterpolationModeFant,
            )?
        };
        scaler.cast()?
    };

    let bytes_per_row = target_width.checked_mul(4).ok_or(E_FAIL)?;
    let byte_len =
        usize::try_from(u64::from(bytes_per_row) * u64::from(target_height)).map_err(|_| E_FAIL)?;
    let mut pixels = vec![0_u8; byte_len];
    unsafe { scaled_source.CopyPixels(ptr::null(), bytes_per_row, &mut pixels)? };
    create_dib(target_width, target_height, &pixels)
}

fn create_fallback_thumbnail(max_edge: u32) -> Result<HBITMAP> {
    let width = max_edge;
    let height = (u64::from(width) * 9 / 16).max(1) as u32;
    let mut pixels = vec![0_u8; width as usize * height as usize * 4];

    for y in 0..height {
        for x in 0..width {
            let offset = ((y * width + x) * 4) as usize;
            let blue = 52_u8.saturating_add((x * 28 / width.max(1)) as u8);
            let green = 34_u8.saturating_add((y * 36 / height.max(1)) as u8);
            pixels[offset..offset + 4].copy_from_slice(&[blue, green, 28, 255]);
        }
    }

    // A compact accent block keeps the no-art fallback recognisable until the supplied PNG is
    // embedded. It is intentionally generic and is not used once the design asset exists.
    let accent_width = (width / 6).max(1);
    for y in 0..height {
        for x in 0..accent_width {
            let offset = ((y * width + x) * 4) as usize;
            pixels[offset..offset + 4].copy_from_slice(&[232, 112, 35, 255]);
        }
    }
    create_dib(width, height, &pixels)
}

fn create_dib(width: u32, height: u32, pixels: &[u8]) -> Result<HBITMAP> {
    let expected_len =
        usize::try_from(u64::from(width) * u64::from(height) * 4).map_err(|_| E_FAIL)?;
    if width == 0 || height == 0 || pixels.len() != expected_len {
        return Err(E_FAIL.into());
    }

    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            // A negative height declares a top-down DIB, matching WIC's pixel order.
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bitmap_bits = ptr::null_mut();
    let bitmap =
        unsafe { CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bitmap_bits, None, 0)? };
    if bitmap_bits.is_null() {
        return Err(E_FAIL.into());
    }
    unsafe {
        ptr::copy_nonoverlapping(pixels.as_ptr(), bitmap_bits.cast::<u8>(), pixels.len());
    }
    Ok(bitmap)
}

fn fit_within(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let edge = max_edge.max(1);
    if width >= height {
        (
            edge,
            (u64::from(height) * u64::from(edge) / u64::from(width)).max(1) as u32,
        )
    } else {
        (
            (u64::from(width) * u64::from(edge) / u64::from(height)).max(1) as u32,
            edge,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::fit_within;

    #[test]
    fn preserves_a_widescreen_thumbnail_ratio() {
        assert_eq!(fit_within(1_280, 720, 256), (256, 144));
    }

    #[test]
    fn preserves_a_portrait_thumbnail_ratio() {
        assert_eq!(fit_within(720, 1_280, 256), (144, 256));
    }
}
