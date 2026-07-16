use super::*;

const ANALYSIS_WIDTH: usize = 96;
const ANALYSIS_HEIGHT: usize = 54;
const ANALYSIS_FRAME_BYTES: usize = ANALYSIS_WIDTH * ANALYSIS_HEIGHT * 3;
const MAX_ANALYSIS_SAMPLES: usize = 240;
const MAX_PARALLEL_SEEKS: usize = 4;
const SHORT_VIDEO_SAMPLES_PER_SECOND: f64 = 2.0;
const PREFIX_PERCENT: usize = 37;
const DETAIL_WEIGHT: f64 = 0.6;
const COLOR_WEIGHT: f64 = 0.4;
const DETAIL_NORMALIZATION: f64 = 1_000.0;
const MAX_COLOR_ENTROPY: f64 = 12.0;
const CACHE_VERSION: u16 = 2;
const INDEX_VERSION: u16 = 1;
const CACHE_PARENT_FOLDER: &str = "Thumbnail Cache";
const CACHE_INDEX_FOLDER: &str = "Thumbnail Cache Analyses";
const CACHE_FILES_FOLDER: &str = "Thumbnail Cache Files";
const CACHE_KEY_CONTEXT: &[u8] = b"linecut-thumbnail-cache-v2";
const INDEX_KEY_CONTEXT: &[u8] = b"linecut-thumbnail-index-v1";
const SUBTITLE_THUMBNAIL_WIDTH: usize = 160;
const SUBTITLE_THUMBNAIL_HEIGHT: usize = 90;
const SUBTITLE_THUMBNAIL_CACHE_VERSION: u16 = 1;
const SUBTITLE_THUMBNAIL_CACHE_FOLDER: &str = "Subtitle Thumbnail Cache Files";
const SUBTITLE_THUMBNAIL_CACHE_KEY_CONTEXT: &[u8] = b"linecut-subtitle-thumbnail-cache-v1";
const SUBTITLE_THUMBNAIL_BUCKET_US: i64 = 100_000;
const SUBTITLE_THUMBNAIL_MATCH_TOLERANCE_US: i64 = 100_000;
const MAX_SUBTITLE_THUMBNAIL_BYTES: usize = 2 * 1024 * 1024;

static THUMBNAIL_CACHE_LOCK: Mutex<()> = Mutex::new(());
static SUBTITLE_THUMBNAIL_CACHE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
struct CachedMediaThumbnail {
    version: u16,
    sample_times: Vec<i64>,
    scores: Vec<Option<f64>>,
    cover: Option<Vec<u8>>,
}

#[derive(Default, Serialize, Deserialize)]
struct ThumbnailCacheIndex {
    version: u16,
    entries: HashMap<String, ThumbnailCacheIndexEntry>,
}

#[derive(Serialize, Deserialize)]
struct ThumbnailCacheIndexEntry {
    cache_hash: String,
    last_accessed_ms: u64,
}

#[derive(Serialize, Deserialize)]
struct PrivateCacheEnvelope {
    version: u16,
    digest: [u8; 32],
    payload: Vec<u8>,
}

struct ThumbnailCacheLayout {
    index_path: PathBuf,
    cache_path: PathBuf,
    index_key: String,
    cache_hash: String,
}

#[derive(Serialize, Deserialize)]
struct CachedSubtitleThumbnail {
    version: u16,
    time_us: i64,
    jpeg: Vec<u8>,
}

#[derive(Serialize)]
pub(crate) struct SubtitleThumbnailCacheLookup {
    cache_time_us: i64,
    bytes: Option<Vec<u8>>,
}

type CoverProgressCallback = dyn Fn(f64) + Send + Sync;

#[derive(Clone, Copy, Debug)]
struct CoverCandidate {
    time_us: i64,
    score: f64,
}

#[tauri::command]
pub(crate) async fn generate_video_cover_thumbnail(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let project = state
        .projects
        .lock()
        .map_err(|_| "项目状态锁定失败".to_string())?
        .get(&asset_id)
        .cloned()
        .ok_or_else(|| format!("未找到媒体: {asset_id}"))?;
    let stream_index = project
        .asset
        .video_stream_index
        .ok_or_else(|| "媒体不包含视频流".to_string())?;
    let preferences = preferences_clone(&state)?;
    ensure_video_cover_thumbnail(&project, &preferences, None, None, stream_index).await
}

#[tauri::command]
pub(crate) async fn generate_subtitle_thumbnail(
    asset_id: String,
    time_us: i64,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let project = state
        .projects
        .lock()
        .map_err(|_| "项目状态锁定失败".to_string())?
        .get(&asset_id)
        .cloned()
        .ok_or_else(|| format!("未找到媒体: {asset_id}"))?;
    let stream_index = project
        .asset
        .video_stream_index
        .ok_or_else(|| "媒体不包含视频流".to_string())?;
    let preferences = preferences_clone(&state)?;
    let cache_preferences = preferences.clone();
    let fingerprint = project.asset.fingerprint.clone();
    let duration_us = project.asset.duration_us;
    let lookup = tokio::task::spawn_blocking(move || {
        read_subtitle_thumbnail_cache(&cache_preferences, &fingerprint, time_us, duration_us)
    })
    .await
    .map_err(|error| format!("读取字幕缩略图缓存失败: {error}"))?;
    if let Some(bytes) = lookup.bytes {
        return Ok(bytes);
    }
    let jpeg = extract_subtitle_thumbnail(
        &ffmpeg_program(&preferences),
        &project.asset.path,
        stream_index,
        lookup.cache_time_us,
    )
    .await?;
    let fingerprint = project.asset.fingerprint;
    tokio::task::spawn_blocking(move || {
        write_subtitle_thumbnail_cache(
            &preferences,
            &fingerprint,
            lookup.cache_time_us,
            duration_us,
            &jpeg,
        )?;
        Ok::<Vec<u8>, String>(jpeg)
    })
    .await
    .map_err(|error| format!("写入字幕缩略图缓存失败: {error}"))?
}

#[tauri::command]
pub(crate) async fn get_cached_subtitle_thumbnail(
    asset_id: String,
    time_us: i64,
    state: tauri::State<'_, AppState>,
) -> Result<SubtitleThumbnailCacheLookup, String> {
    let project = state
        .projects
        .lock()
        .map_err(|_| "项目状态锁定失败".to_string())?
        .get(&asset_id)
        .cloned()
        .ok_or_else(|| format!("未找到媒体: {asset_id}"))?;
    let preferences = preferences_clone(&state)?;
    tokio::task::spawn_blocking(move || {
        Ok(read_subtitle_thumbnail_cache(
            &preferences,
            &project.asset.fingerprint,
            time_us,
            project.asset.duration_us,
        ))
    })
    .await
    .map_err(|error| format!("读取字幕缩略图缓存失败: {error}"))?
}

#[tauri::command]
pub(crate) async fn cache_subtitle_thumbnail(
    asset_id: String,
    time_us: i64,
    bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    validate_subtitle_thumbnail_jpeg(&bytes)?;
    let project = state
        .projects
        .lock()
        .map_err(|_| "项目状态锁定失败".to_string())?
        .get(&asset_id)
        .cloned()
        .ok_or_else(|| format!("未找到媒体: {asset_id}"))?;
    let preferences = preferences_clone(&state)?;
    tokio::task::spawn_blocking(move || {
        write_subtitle_thumbnail_cache(
            &preferences,
            &project.asset.fingerprint,
            time_us,
            project.asset.duration_us,
            &bytes,
        )
    })
    .await
    .map_err(|error| format!("写入字幕缩略图缓存失败: {error}"))?
}

pub(crate) async fn ensure_video_cover_thumbnail(
    project: &Project,
    preferences: &Preferences,
    cancel: Option<Arc<AtomicBool>>,
    progress: Option<&CoverProgressCallback>,
    stream_index: i32,
) -> Result<Vec<u8>, String> {
    report_cover_progress(progress, 0.0);
    let layout = thumbnail_cache_layout(preferences, &project.asset.fingerprint);
    register_thumbnail_cache(&layout)?;
    let sample_times = analysis_sample_times(project.asset.duration_us);
    let mut cached = read_media_thumbnail_cache(&layout, &project.asset.fingerprint)
        .filter(|cached| cached.version == CACHE_VERSION && cached.sample_times == sample_times)
        .unwrap_or_else(|| CachedMediaThumbnail {
            version: CACHE_VERSION,
            scores: vec![None; sample_times.len()],
            sample_times: sample_times.clone(),
            cover: None,
        });
    if let Some(cover) = cached.cover {
        report_cover_progress(progress, 1.0);
        return Ok(cover);
    }

    ensure_thumbnail_not_cancelled(cancel.as_ref())?;
    let program = ffmpeg_program(preferences);
    analyze_video_samples(
        &program,
        &project.asset.path,
        stream_index,
        &mut cached,
        &layout,
        &project.asset.fingerprint,
        cancel.as_ref(),
        progress,
    )
    .await?;
    report_cover_progress(progress, 0.9);
    let candidates = cached_candidates(&cached);
    if candidates.is_empty() {
        return Err("视频封面分析没有产生可用帧".to_string());
    }
    let selected = select_cover_candidate(&candidates);
    ensure_thumbnail_not_cancelled(cancel.as_ref())?;
    report_cover_progress(progress, 0.94);
    let cover = match extract_cover_frame(
        &program,
        &project.asset.path,
        stream_index,
        selected.time_us,
        true,
    )
    .await
    {
        Ok(cover) => cover,
        Err(_) => {
            extract_cover_frame(
                &program,
                &project.asset.path,
                stream_index,
                selected.time_us,
                false,
            )
            .await?
        }
    };
    ensure_thumbnail_not_cancelled(cancel.as_ref())?;
    report_cover_progress(progress, 0.98);
    cached.cover = Some(cover.clone());
    write_media_thumbnail_cache(&layout, &project.asset.fingerprint, &cached)?;
    report_cover_progress(progress, 1.0);
    Ok(cover)
}

fn report_cover_progress(progress: Option<&CoverProgressCallback>, value: f64) {
    if let Some(report) = progress {
        report(value.clamp(0.0, 1.0));
    }
}

fn thumbnail_cache_layout(preferences: &Preferences, fingerprint: &str) -> ThumbnailCacheLayout {
    let root = configured_cache_root(preferences).join(CACHE_PARENT_FOLDER);
    let cache_hash = hash_name(CACHE_KEY_CONTEXT, fingerprint.as_bytes());
    let shard = &cache_hash[..2];
    let index_key = hash_name(INDEX_KEY_CONTEXT, shard.as_bytes());
    ThumbnailCacheLayout {
        index_path: root
            .join(CACHE_INDEX_FOLDER)
            .join(format!("{index_key}.mcdb")),
        cache_path: root
            .join(CACHE_FILES_FOLDER)
            .join(format!("{cache_hash}.lctc")),
        index_key,
        cache_hash,
    }
}

fn clamped_subtitle_thumbnail_time(time_us: i64, duration_us: i64) -> i64 {
    time_us.clamp(0, duration_us.saturating_sub(1_000).max(0))
}

fn subtitle_thumbnail_bucket(time_us: i64, duration_us: i64) -> i64 {
    clamped_subtitle_thumbnail_time(time_us, duration_us)
        .saturating_add(SUBTITLE_THUMBNAIL_BUCKET_US / 2)
        / SUBTITLE_THUMBNAIL_BUCKET_US
}

fn subtitle_thumbnail_bucket_time(bucket: i64, duration_us: i64) -> i64 {
    bucket
        .max(0)
        .saturating_mul(SUBTITLE_THUMBNAIL_BUCKET_US)
        .min(duration_us.saturating_sub(1_000).max(0))
}

fn subtitle_thumbnail_time_distance(left: i64, right: i64) -> i64 {
    left.max(right) - left.min(right)
}

fn subtitle_thumbnail_candidate_buckets(time_us: i64, duration_us: i64) -> Vec<i64> {
    let requested_time_us = clamped_subtitle_thumbnail_time(time_us, duration_us);
    let primary_bucket = subtitle_thumbnail_bucket(requested_time_us, duration_us);
    let mut buckets = vec![
        primary_bucket,
        primary_bucket.saturating_sub(1),
        primary_bucket.saturating_add(1),
    ];
    buckets.retain(|bucket| *bucket >= 0);
    buckets.sort_by_key(|bucket| {
        subtitle_thumbnail_time_distance(
            subtitle_thumbnail_bucket_time(*bucket, duration_us),
            requested_time_us,
        )
    });
    buckets.dedup_by_key(|bucket| subtitle_thumbnail_bucket_time(*bucket, duration_us));
    buckets
}

fn subtitle_thumbnail_cache_layout(
    preferences: &Preferences,
    fingerprint: &str,
    bucket: i64,
) -> (PathBuf, String) {
    let cache_key = format!("{fingerprint}:{bucket}");
    let cache_hash = hash_name(SUBTITLE_THUMBNAIL_CACHE_KEY_CONTEXT, cache_key.as_bytes());
    let path = configured_cache_root(preferences)
        .join(CACHE_PARENT_FOLDER)
        .join(SUBTITLE_THUMBNAIL_CACHE_FOLDER)
        .join(&cache_hash[..2])
        .join(format!("{cache_hash}.lcst"));
    (path, cache_key)
}

fn subtitle_thumbnail_cache_miss(time_us: i64, duration_us: i64) -> SubtitleThumbnailCacheLookup {
    let bucket = subtitle_thumbnail_bucket(time_us, duration_us);
    SubtitleThumbnailCacheLookup {
        cache_time_us: subtitle_thumbnail_bucket_time(bucket, duration_us),
        bytes: None,
    }
}

fn read_subtitle_thumbnail_cache(
    preferences: &Preferences,
    fingerprint: &str,
    time_us: i64,
    duration_us: i64,
) -> SubtitleThumbnailCacheLookup {
    let Ok(_guard) = SUBTITLE_THUMBNAIL_CACHE_LOCK.lock() else {
        return subtitle_thumbnail_cache_miss(time_us, duration_us);
    };
    read_subtitle_thumbnail_cache_unlocked(preferences, fingerprint, time_us, duration_us)
}

fn read_subtitle_thumbnail_cache_unlocked(
    preferences: &Preferences,
    fingerprint: &str,
    time_us: i64,
    duration_us: i64,
) -> SubtitleThumbnailCacheLookup {
    let requested_time_us = clamped_subtitle_thumbnail_time(time_us, duration_us);
    for bucket in subtitle_thumbnail_candidate_buckets(requested_time_us, duration_us) {
        let cache_time_us = subtitle_thumbnail_bucket_time(bucket, duration_us);
        if subtitle_thumbnail_time_distance(cache_time_us, requested_time_us)
            > SUBTITLE_THUMBNAIL_MATCH_TOLERANCE_US
        {
            continue;
        }
        let (path, cache_key) = subtitle_thumbnail_cache_layout(preferences, fingerprint, bucket);
        let Some(cached) = read_private_cache::<CachedSubtitleThumbnail>(
            &path,
            &cache_key,
            SUBTITLE_THUMBNAIL_CACHE_KEY_CONTEXT,
        ) else {
            continue;
        };
        if cached.version != SUBTITLE_THUMBNAIL_CACHE_VERSION
            || cached.time_us != cache_time_us
            || validate_subtitle_thumbnail_jpeg(&cached.jpeg).is_err()
        {
            continue;
        }
        return SubtitleThumbnailCacheLookup {
            cache_time_us,
            bytes: Some(cached.jpeg),
        };
    }
    subtitle_thumbnail_cache_miss(requested_time_us, duration_us)
}

fn write_subtitle_thumbnail_cache(
    preferences: &Preferences,
    fingerprint: &str,
    time_us: i64,
    duration_us: i64,
    jpeg: &[u8],
) -> Result<(), String> {
    validate_subtitle_thumbnail_jpeg(jpeg)?;
    let _guard = SUBTITLE_THUMBNAIL_CACHE_LOCK
        .lock()
        .map_err(|_| "字幕缩略图缓存锁定失败".to_string())?;
    if read_subtitle_thumbnail_cache_unlocked(preferences, fingerprint, time_us, duration_us)
        .bytes
        .is_some()
    {
        return Ok(());
    }
    let bucket = subtitle_thumbnail_bucket(time_us, duration_us);
    let cache_time_us = subtitle_thumbnail_bucket_time(bucket, duration_us);
    let (path, cache_key) = subtitle_thumbnail_cache_layout(preferences, fingerprint, bucket);
    write_private_cache(
        &path,
        &cache_key,
        SUBTITLE_THUMBNAIL_CACHE_KEY_CONTEXT,
        &CachedSubtitleThumbnail {
            version: SUBTITLE_THUMBNAIL_CACHE_VERSION,
            time_us: cache_time_us,
            jpeg: jpeg.to_vec(),
        },
    )
}

fn validate_subtitle_thumbnail_jpeg(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 4 || bytes.len() > MAX_SUBTITLE_THUMBNAIL_BYTES {
        return Err("字幕缩略图缓存数据大小无效".to_string());
    }
    if !bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Err("字幕缩略图缓存不是有效的 JPEG 数据".to_string());
    }
    Ok(())
}

fn register_thumbnail_cache(layout: &ThumbnailCacheLayout) -> Result<(), String> {
    let _guard = THUMBNAIL_CACHE_LOCK
        .lock()
        .map_err(|_| "视频封面缓存锁定失败".to_string())?;
    let index_parent = layout
        .index_path
        .parent()
        .ok_or_else(|| "视频封面索引路径无效".to_string())?;
    let cache_parent = layout
        .cache_path
        .parent()
        .ok_or_else(|| "视频封面缓存路径无效".to_string())?;
    fs::create_dir_all(index_parent)
        .map_err(|error| format!("创建视频封面索引目录失败: {error}"))?;
    fs::create_dir_all(cache_parent)
        .map_err(|error| format!("创建视频封面缓存目录失败: {error}"))?;
    let mut index = read_private_cache::<ThumbnailCacheIndex>(
        &layout.index_path,
        &layout.index_key,
        INDEX_KEY_CONTEXT,
    )
    .filter(|index| index.version == INDEX_VERSION)
    .unwrap_or_else(|| ThumbnailCacheIndex {
        version: INDEX_VERSION,
        entries: HashMap::new(),
    });
    index.entries.insert(
        layout.cache_hash.clone(),
        ThumbnailCacheIndexEntry {
            cache_hash: layout.cache_hash.clone(),
            last_accessed_ms: current_time_millis(),
        },
    );
    write_private_cache(
        &layout.index_path,
        &layout.index_key,
        INDEX_KEY_CONTEXT,
        &index,
    )?;
    Ok(())
}

fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn analysis_sample_times(duration_us: i64) -> Vec<i64> {
    let latest_time_us = duration_us.saturating_sub(1_000).max(0);
    if latest_time_us == 0 {
        return vec![0];
    }
    let duration_seconds = duration_us.max(0) as f64 / 1_000_000.0;
    let sample_count = (duration_seconds * SHORT_VIDEO_SAMPLES_PER_SECOND)
        .ceil()
        .max(2.0) as usize;
    let sample_count = sample_count.min(MAX_ANALYSIS_SAMPLES);
    (0..sample_count)
        .map(|index| {
            latest_time_us.saturating_mul(index as i64) / (sample_count.saturating_sub(1) as i64)
        })
        .collect()
}

async fn analyze_video_samples(
    program: &str,
    input_path: &str,
    stream_index: i32,
    cached: &mut CachedMediaThumbnail,
    layout: &ThumbnailCacheLayout,
    fingerprint: &str,
    cancel: Option<&Arc<AtomicBool>>,
    progress: Option<&CoverProgressCallback>,
) -> Result<(), String> {
    let mut first_error = None;
    let total = cached.sample_times.len().max(1);
    let mut completed = cached.scores.iter().filter(|score| score.is_some()).count();
    report_cover_progress(progress, completed as f64 / total as f64 * 0.9);
    for batch_start in (0..cached.sample_times.len()).step_by(MAX_PARALLEL_SEEKS) {
        ensure_thumbnail_not_cancelled(cancel)?;
        let batch_end = (batch_start + MAX_PARALLEL_SEEKS).min(cached.sample_times.len());
        let missing = (batch_start..batch_end)
            .filter(|index| cached.scores[*index].is_none())
            .collect::<Vec<_>>();
        if missing.is_empty() {
            continue;
        }
        let batch_size = missing.len();
        let mut tasks = tokio::task::JoinSet::new();
        for index in missing {
            let program = program.to_string();
            let input_path = input_path.to_string();
            let time_us = cached.sample_times[index];
            tasks.spawn(async move {
                analyze_video_sample(&program, &input_path, stream_index, time_us)
                    .await
                    .map(|score| (index, score))
            });
        }
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Ok((index, score))) => cached.scores[index] = Some(score),
                Ok(Err(error)) => {
                    first_error.get_or_insert(error);
                }
                Err(error) => {
                    first_error.get_or_insert_with(|| format!("等待视频封面候选帧失败: {error}"));
                }
            }
        }
        write_media_thumbnail_cache(layout, fingerprint, cached)?;
        completed = (completed + batch_size).min(total);
        report_cover_progress(progress, completed as f64 / total as f64 * 0.9);
        ensure_thumbnail_not_cancelled(cancel)?;
    }
    if cached.scores.iter().all(Option::is_none) {
        return Err(first_error.unwrap_or_else(|| "视频封面分析没有产生可用帧".to_string()));
    }
    Ok(())
}

async fn analyze_video_sample(
    program: &str,
    input_path: &str,
    stream_index: i32,
    time_us: i64,
) -> Result<f64, String> {
    let mut args = fast_seek_input_args(input_path, time_us, true);
    args.extend([
        "-map".to_string(),
        format!("0:{stream_index}"),
        "-frames:v".to_string(),
        "1".to_string(),
        "-vf".to_string(),
        format!("scale={ANALYSIS_WIDTH}:{ANALYSIS_HEIGHT}:flags=fast_bilinear"),
        "-pix_fmt".to_string(),
        "rgb24".to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "pipe:1".to_string(),
    ]);
    let output = hidden_command(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| format!("启动 {program} 分析视频封面候选帧失败: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "分析视频封面候选帧失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if output.stdout.len() < ANALYSIS_FRAME_BYTES {
        return Err("视频封面候选帧数据不完整".to_string());
    }
    Ok(frame_information_score(
        &output.stdout[..ANALYSIS_FRAME_BYTES],
    ))
}

fn fast_seek_input_args(input_path: &str, time_us: i64, keyframes_only: bool) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-ss".to_string(),
        format!("{:.6}", time_us.max(0) as f64 / 1_000_000.0),
        "-noaccurate_seek".to_string(),
    ];
    if keyframes_only {
        args.extend(["-skip_frame".to_string(), "nokey".to_string()]);
    }
    args.extend([
        "-threads".to_string(),
        "1".to_string(),
        "-i".to_string(),
        input_path.to_string(),
    ]);
    args
}

fn frame_information_score(rgb: &[u8]) -> f64 {
    let pixel_count = ANALYSIS_WIDTH * ANALYSIS_HEIGHT;
    let mut grayscale = Vec::with_capacity(pixel_count);
    let mut color_histogram = [0_u32; 4096];
    for pixel in rgb.chunks_exact(3) {
        let red = pixel[0];
        let green = pixel[1];
        let blue = pixel[2];
        grayscale.push(
            ((77_u32 * red as u32 + 150_u32 * green as u32 + 29_u32 * blue as u32) >> 8) as i32,
        );
        let color_bin =
            ((red as usize >> 4) << 8) | ((green as usize >> 4) << 4) | (blue as usize >> 4);
        color_histogram[color_bin] += 1;
    }

    let mut laplacian_sum = 0_i64;
    let mut laplacian_square_sum = 0_u64;
    let mut laplacian_count = 0_u64;
    for y in 1..ANALYSIS_HEIGHT - 1 {
        for x in 1..ANALYSIS_WIDTH - 1 {
            let index = y * ANALYSIS_WIDTH + x;
            let laplacian = grayscale[index - ANALYSIS_WIDTH]
                + grayscale[index - 1]
                + grayscale[index + 1]
                + grayscale[index + ANALYSIS_WIDTH]
                - 4 * grayscale[index];
            laplacian_sum += laplacian as i64;
            laplacian_square_sum += (laplacian * laplacian) as u64;
            laplacian_count += 1;
        }
    }
    let laplacian_mean = laplacian_sum as f64 / laplacian_count as f64;
    let laplacian_variance = (laplacian_square_sum as f64 / laplacian_count as f64
        - laplacian_mean * laplacian_mean)
        .max(0.0);
    let detail_score = laplacian_variance / (laplacian_variance + DETAIL_NORMALIZATION);

    let mut color_entropy = 0.0;
    for count in color_histogram {
        if count == 0 {
            continue;
        }
        let probability = count as f64 / pixel_count as f64;
        color_entropy -= probability * probability.log2();
    }
    let color_score = (color_entropy / MAX_COLOR_ENTROPY).clamp(0.0, 1.0);
    DETAIL_WEIGHT * detail_score + COLOR_WEIGHT * color_score
}

fn cached_candidates(cached: &CachedMediaThumbnail) -> Vec<CoverCandidate> {
    cached
        .sample_times
        .iter()
        .copied()
        .zip(cached.scores.iter().copied())
        .filter_map(|(time_us, score)| score.map(|score| CoverCandidate { time_us, score }))
        .collect()
}

fn select_cover_candidate(candidates: &[CoverCandidate]) -> CoverCandidate {
    let prefix_len = candidates
        .len()
        .saturating_mul(PREFIX_PERCENT)
        .div_ceil(100)
        .clamp(1, candidates.len());
    let mut prefix_best_index = 0;
    for index in 1..prefix_len {
        if candidates[index].score > candidates[prefix_best_index].score {
            prefix_best_index = index;
        }
    }
    let prefix_best = candidates[prefix_best_index];
    candidates[prefix_len..]
        .iter()
        .find(|candidate| candidate.score > prefix_best.score)
        .copied()
        .unwrap_or(prefix_best)
}

async fn extract_cover_frame(
    program: &str,
    input_path: &str,
    stream_index: i32,
    time_us: i64,
    keyframes_only: bool,
) -> Result<Vec<u8>, String> {
    let mut args = fast_seek_input_args(input_path, time_us, keyframes_only);
    args.extend([
        "-map".to_string(),
        format!("0:{stream_index}"),
        "-frames:v".to_string(),
        "1".to_string(),
        "-vf".to_string(),
        "scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2".to_string(),
        "-q:v".to_string(),
        "3".to_string(),
        "-f".to_string(),
        "image2pipe".to_string(),
        "-vcodec".to_string(),
        "mjpeg".to_string(),
        "pipe:1".to_string(),
    ]);
    let output = hidden_command(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| format!("启动 {program} 提取视频封面失败: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "提取视频封面失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if output.stdout.is_empty() {
        return Err("提取的视频封面为空".to_string());
    }
    Ok(output.stdout)
}

async fn extract_subtitle_thumbnail(
    program: &str,
    input_path: &str,
    stream_index: i32,
    time_us: i64,
) -> Result<Vec<u8>, String> {
    let args = [
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-ss".to_string(),
        format!("{:.6}", time_us.max(0) as f64 / 1_000_000.0),
        "-threads".to_string(),
        "1".to_string(),
        "-i".to_string(),
        input_path.to_string(),
        "-map".to_string(),
        format!("0:{stream_index}"),
        "-frames:v".to_string(),
        "1".to_string(),
        "-vf".to_string(),
        format!(
            "scale={SUBTITLE_THUMBNAIL_WIDTH}:{SUBTITLE_THUMBNAIL_HEIGHT}:force_original_aspect_ratio=increase,crop={SUBTITLE_THUMBNAIL_WIDTH}:{SUBTITLE_THUMBNAIL_HEIGHT}"
        ),
        "-q:v".to_string(),
        "8".to_string(),
        "-f".to_string(),
        "image2pipe".to_string(),
        "-vcodec".to_string(),
        "mjpeg".to_string(),
        "pipe:1".to_string(),
    ];
    let output = hidden_command(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| format!("启动 {program} 提取字幕缩略图失败: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "提取字幕缩略图失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if output.stdout.is_empty() {
        return Err("提取的字幕缩略图为空".to_string());
    }
    Ok(output.stdout)
}

fn ensure_thumbnail_not_cancelled(cancel: Option<&Arc<AtomicBool>>) -> Result<(), String> {
    if cancel.is_some_and(|cancel| cancel.load(Ordering::Relaxed)) {
        Err("任务已取消".to_string())
    } else {
        Ok(())
    }
}

fn read_media_thumbnail_cache(
    layout: &ThumbnailCacheLayout,
    fingerprint: &str,
) -> Option<CachedMediaThumbnail> {
    let _guard = THUMBNAIL_CACHE_LOCK.lock().ok()?;
    let index = read_private_cache::<ThumbnailCacheIndex>(
        &layout.index_path,
        &layout.index_key,
        INDEX_KEY_CONTEXT,
    )?;
    let entry = index.entries.get(&layout.cache_hash)?;
    if entry.cache_hash != layout.cache_hash {
        return None;
    }
    read_private_cache(&layout.cache_path, fingerprint, CACHE_KEY_CONTEXT)
}

fn write_media_thumbnail_cache(
    layout: &ThumbnailCacheLayout,
    fingerprint: &str,
    cached: &CachedMediaThumbnail,
) -> Result<(), String> {
    let _guard = THUMBNAIL_CACHE_LOCK
        .lock()
        .map_err(|_| "视频封面缓存锁定失败".to_string())?;
    write_private_cache(&layout.cache_path, fingerprint, CACHE_KEY_CONTEXT, cached)
}

fn read_private_cache<Value>(path: &Path, key: &str, context: &[u8]) -> Option<Value>
where
    Value: for<'de> Deserialize<'de>,
{
    let envelope = bincode::deserialize::<PrivateCacheEnvelope>(&fs::read(path).ok()?).ok()?;
    if envelope.version != 1 {
        return None;
    }
    let serialized = transform_private_payload(&envelope.payload, key, context);
    if private_cache_digest(&serialized, key, context) != envelope.digest {
        return None;
    }
    bincode::deserialize(&serialized).ok()
}

fn write_private_cache<Value>(
    path: &Path,
    key: &str,
    context: &[u8],
    value: &Value,
) -> Result<(), String>
where
    Value: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建缩略图缓存目录失败: {error}"))?;
    }
    let serialized =
        bincode::serialize(value).map_err(|error| format!("编码缩略图缓存失败: {error}"))?;
    let envelope = PrivateCacheEnvelope {
        version: 1,
        digest: private_cache_digest(&serialized, key, context),
        payload: transform_private_payload(&serialized, key, context),
    };
    let output =
        bincode::serialize(&envelope).map_err(|error| format!("封装缩略图缓存失败: {error}"))?;
    fs::write(path, output).map_err(|error| format!("写入缩略图缓存失败: {error}"))
}

fn private_cache_digest(bytes: &[u8], key: &str, context: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(context);
    hasher.update(key.as_bytes());
    hasher.update(bytes);
    hasher.finalize().into()
}

fn transform_private_payload(bytes: &[u8], key: &str, context: &[u8]) -> Vec<u8> {
    let mut transformed = Vec::with_capacity(bytes.len());
    for (block_index, chunk) in bytes.chunks(32).enumerate() {
        let mut hasher = Sha256::new();
        hasher.update(context);
        hasher.update(key.as_bytes());
        hasher.update((block_index as u64).to_le_bytes());
        let key_stream = hasher.finalize();
        transformed.extend(
            chunk
                .iter()
                .zip(key_stream.iter())
                .map(|(byte, key_byte)| byte ^ key_byte),
        );
    }
    transformed
}

fn hash_name(context: &[u8], value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(context);
    hasher.update(value);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
