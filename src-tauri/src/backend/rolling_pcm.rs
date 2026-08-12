use super::*;

const PCM_MAGIC: &[u8; 4] = b"LPCM";
const PCM_CHANNELS: u16 = 2;
const PCM_HEADER_LEN: usize = 24;
const MIN_WINDOW_US: i64 = 20_000;
const MAX_WINDOW_US: i64 = 4_000_000;
const MIN_SAMPLE_RATE: u32 = 8_000;
const MAX_SAMPLE_RATE: u32 = 192_000;

fn pcm_payload(samples: Vec<u8>, sample_rate: u32, start_time_us: i64) -> AppResult<Vec<u8>> {
    let bytes_per_frame = usize::from(PCM_CHANNELS) * size_of::<f32>();
    if samples.len() % bytes_per_frame != 0 {
        return Err(app_error(
            ErrorCode::PcmWindowInvalid,
            format!(
                "Decoded PCM byte count {} is not aligned to {bytes_per_frame}",
                samples.len()
            ),
        ));
    }
    let frame_count = u32::try_from(samples.len() / bytes_per_frame).map_err(|_| {
        app_error(
            ErrorCode::PcmWindowInvalid,
            "Decoded PCM window contains too many frames",
        )
    })?;
    let mut payload = Vec::with_capacity(PCM_HEADER_LEN + samples.len());
    payload.extend_from_slice(PCM_MAGIC);
    payload.extend_from_slice(&sample_rate.to_le_bytes());
    payload.extend_from_slice(&PCM_CHANNELS.to_le_bytes());
    payload.extend_from_slice(&0_u16.to_le_bytes());
    payload.extend_from_slice(&start_time_us.to_le_bytes());
    payload.extend_from_slice(&frame_count.to_le_bytes());
    payload.extend(samples);
    Ok(payload)
}

#[tauri::command]
pub(crate) async fn decode_audio_pcm_window(
    source_path: String,
    audio_track_index: usize,
    start_time_us: i64,
    duration_us: i64,
    sample_rate: u32,
    state: tauri::State<'_, AppState>,
) -> CommandResult<tauri::ipc::Response> {
    if !(MIN_WINDOW_US..=MAX_WINDOW_US).contains(&duration_us) {
        return Err(app_error(
            ErrorCode::PcmWindowInvalid,
            format!("PCM window duration is outside the supported range: {duration_us} us"),
        ));
    }
    if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&sample_rate) {
        return Err(app_error(
            ErrorCode::PcmWindowInvalid,
            format!("PCM sample rate is outside the supported range: {sample_rate} Hz"),
        ));
    }

    let input_path = PathBuf::from(&source_path);
    let metadata = fs::metadata(&input_path).map_err(|error| {
        app_error(
            ErrorCode::MediaReadFailed,
            format!("Failed to read PCM source {source_path}: {error}"),
        )
    })?;
    if !metadata.is_file() {
        return Err(app_error(
            ErrorCode::MediaNotFound,
            format!("PCM source is not a file: {source_path}"),
        ));
    }

    let preferences = preferences_clone(&state)?;
    let task_id = format!("shuttle-pcm:{}", Uuid::new_v4());
    let task = register_task(&task_id, state.inner())?;
    let args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-ss".to_string(),
        format!("{:.6}", start_time_us.max(0) as f64 / 1_000_000.0),
        "-i".to_string(),
        source_path,
        "-t".to_string(),
        format!("{:.6}", duration_us as f64 / 1_000_000.0),
        "-map".to_string(),
        format!("0:a:{audio_track_index}"),
        "-vn".to_string(),
        "-sn".to_string(),
        "-dn".to_string(),
        "-ac".to_string(),
        PCM_CHANNELS.to_string(),
        "-ar".to_string(),
        sample_rate.to_string(),
        "-c:a".to_string(),
        "pcm_f32le".to_string(),
        "-f".to_string(),
        "f32le".to_string(),
        "pipe:1".to_string(),
    ];
    let samples = run_output_bytes(
        &ffmpeg_program(&preferences),
        &args,
        state.inner(),
        &task_id,
        task.cancel_token(),
    )
    .await?;
    task.check_cancelled()?;
    Ok(tauri::ipc::Response::new(pcm_payload(
        samples,
        sample_rate,
        start_time_us.max(0),
    )?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_response_has_a_fixed_binary_header() {
        let bytes = pcm_payload(vec![0; 16], 48_000, 250_000).expect("valid PCM");
        assert_eq!(&bytes[0..4], PCM_MAGIC);
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 48_000);
        assert_eq!(u16::from_le_bytes(bytes[8..10].try_into().unwrap()), 2);
        assert_eq!(
            i64::from_le_bytes(bytes[12..20].try_into().unwrap()),
            250_000
        );
        assert_eq!(u32::from_le_bytes(bytes[20..24].try_into().unwrap()), 2);
    }
}
