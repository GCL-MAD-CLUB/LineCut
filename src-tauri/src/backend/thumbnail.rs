use super::*;

const ANALYSIS_WIDTH: usize = 96;
const ANALYSIS_HEIGHT: usize = 54;
const ANALYSIS_FRAME_BYTES: usize = ANALYSIS_WIDTH * ANALYSIS_HEIGHT * 3;
const MAX_ANALYSIS_SAMPLES: usize = 120;
const IMPORT_COVER_WORKERS: usize = 3;
const DEFAULT_TIMELINE_THUMBNAIL_WORKERS: usize = 4;
const MAX_TIMELINE_THUMBNAIL_WORKERS: usize = 8;
const COVER_POSITION_DECAY: f64 = 0.9966;
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
// v2: invalidates thumbnails cached at frame-boundary seek times (which could
// land on the previous frame) so corrected frames are regenerated on upgrade.
const STORYBOARD_THUMBNAIL_CACHE_VERSION: u16 = 2;
const STORYBOARD_THUMBNAIL_CACHE_FOLDER: &str = "Storyboard Thumbnail Cache Files";
const STORYBOARD_THUMBNAIL_CACHE_KEY_CONTEXT: &[u8] = b"linecut-storyboard-thumbnail-cache-v2";
const MAX_TIMELINE_THUMBNAIL_BYTES: usize = 8 * 1024 * 1024;
const MAX_TIMELINE_THUMBNAIL_RESOLUTIONS: usize = 3;
const TIMELINE_THUMBNAIL_TEMP_FOLDER: &str = "Timeline Thumbnail Temporary";
const STALE_TIMELINE_THUMBNAIL_TEMP_DIRECTORY_AGE: Duration = Duration::from_secs(60 * 60);

static COVER_GENERATION_LOCK: futures::lock::Mutex<()> = futures::lock::Mutex::new(());

static THUMBNAIL_CACHE_LOCK: Mutex<()> = Mutex::new(());
static SUBTITLE_THUMBNAIL_CACHE_LOCK: Mutex<()> = Mutex::new(());
static STORYBOARD_THUMBNAIL_CACHE_LOCK: Mutex<()> = Mutex::new(());

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

#[derive(Serialize, Deserialize)]
struct CachedStoryboardThumbnail {
    version: u16,
    time_us: i64,
    jpeg: Vec<u8>,
}

#[derive(Serialize)]
pub(crate) struct SubtitleThumbnailCacheLookup {
    cache_time_us: i64,
    bytes: Option<Vec<u8>>,
}

#[derive(Serialize)]
pub(crate) struct StoryboardThumbnailCacheLookup {
    cache_time_us: i64,
    bytes: Option<Vec<u8>>,
}

trait TimelineThumbnailCacheLookup {
    fn cache_time_us(&self) -> i64;
    fn bytes(&self) -> &Option<Vec<u8>>;
}

impl TimelineThumbnailCacheLookup for SubtitleThumbnailCacheLookup {
    fn cache_time_us(&self) -> i64 {
        self.cache_time_us
    }

    fn bytes(&self) -> &Option<Vec<u8>> {
        &self.bytes
    }
}

impl TimelineThumbnailCacheLookup for StoryboardThumbnailCacheLookup {
    fn cache_time_us(&self) -> i64 {
        self.cache_time_us
    }

    fn bytes(&self) -> &Option<Vec<u8>> {
        &self.bytes
    }
}

type CoverProgressCallback = dyn Fn(f64) + Send + Sync;

fn thumbnail_processing_thread_budget() -> usize {
    ffmpeg_worker_thread_budget(IMPORT_COVER_WORKERS)
}

fn append_thumbnail_processing_thread_args(args: &mut Vec<String>) {
    append_ffmpeg_processing_thread_args(args, thumbnail_processing_thread_budget());
}

fn timeline_thumbnail_processing_thread_budget(worker_count: Option<usize>) -> usize {
    ffmpeg_worker_thread_budget(
        worker_count
            .unwrap_or(DEFAULT_TIMELINE_THUMBNAIL_WORKERS)
            .clamp(1, MAX_TIMELINE_THUMBNAIL_WORKERS),
    )
}

fn timeline_thumbnail_output_thread_budget(
    worker_count: Option<usize>,
    output_count: usize,
) -> usize {
    (timeline_thumbnail_processing_thread_budget(worker_count) / output_count.max(1)).max(1)
}

fn append_timeline_thumbnail_processing_thread_args(
    args: &mut Vec<String>,
    worker_count: Option<usize>,
) {
    append_ffmpeg_processing_thread_args(
        args,
        timeline_thumbnail_processing_thread_budget(worker_count),
    );
}

#[derive(Clone, Copy)]
struct TimelineThumbnailResolution {
    width: usize,
    height: usize,
}

fn timeline_thumbnail_resolution(width: Option<usize>) -> AppResult<TimelineThumbnailResolution> {
    match width.unwrap_or(SUBTITLE_THUMBNAIL_WIDTH) {
        160 => Ok(TimelineThumbnailResolution {
            width: SUBTITLE_THUMBNAIL_WIDTH,
            height: SUBTITLE_THUMBNAIL_HEIGHT,
        }),
        640 => Ok(TimelineThumbnailResolution {
            width: 640,
            height: 360,
        }),
        1_280 => Ok(TimelineThumbnailResolution {
            width: 1_280,
            height: 720,
        }),
        width => Err(app_error(
            ErrorCode::ThumbnailDataInvalid,
            format!("Unsupported timeline thumbnail width: {width}"),
        )),
    }
}

fn validate_timeline_thumbnail_widths(widths: &[usize]) -> AppResult<()> {
    if widths.is_empty() {
        return Err(app_error(
            ErrorCode::ThumbnailDataInvalid,
            "At least one timeline thumbnail width is required",
        ));
    }
    if widths.len() > MAX_TIMELINE_THUMBNAIL_RESOLUTIONS {
        return Err(app_error(
            ErrorCode::ThumbnailDataInvalid,
            format!(
                "Too many timeline thumbnail widths were requested: {} (maximum is {})",
                widths.len(),
                MAX_TIMELINE_THUMBNAIL_RESOLUTIONS
            ),
        ));
    }
    let mut seen = HashSet::new();
    for width in widths {
        if !seen.insert(width) {
            return Err(app_error(
                ErrorCode::ThumbnailDataInvalid,
                format!("Duplicate timeline thumbnail width: {width}"),
            ));
        }
    }
    Ok(())
}

fn timeline_thumbnail_scale_filter(resolution: TimelineThumbnailResolution) -> String {
    let scale_flags = if resolution.width == SUBTITLE_THUMBNAIL_WIDTH {
        ":flags=fast_bilinear"
    } else {
        ""
    };
    format!(
        "scale={}:{}:force_original_aspect_ratio=increase{scale_flags},crop={}:{}",
        resolution.width, resolution.height, resolution.width, resolution.height
    )
}

#[tauri::command]
pub(crate) async fn get_cached_video_cover_thumbnail(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult<Option<Vec<u8>>> {
    let fingerprint = state
        .projects
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::ProjectStateUnavailable,
                "Project state lock is poisoned",
            )
        })?
        .get(&asset_id)
        .map(|project| project.asset.fingerprint.clone())
        .ok_or_else(|| {
            app_error(
                ErrorCode::MediaNotFound,
                format!("Media asset was not found: {asset_id}"),
            )
        })?;
    let preferences = preferences_clone(&state)?;
    // Generation belongs to the media-analysis queue, including cache repair.
    tokio::task::spawn_blocking(move || {
        let layout = thumbnail_cache_layout(&preferences, &fingerprint);
        Ok(read_media_thumbnail_cache(&layout, &fingerprint)
            .filter(|cached| cached.version == CACHE_VERSION)
            .and_then(|cached| cached.cover)
            .filter(|cover| !cover.is_empty()))
    })
    .await
    .map_err(|error| {
        app_error(
            ErrorCode::BlockingTaskFailed,
            format!("Video cover cache read failed: {error}"),
        )
    })?
}

#[tauri::command]
pub(crate) async fn get_cached_subtitle_thumbnails(
    asset_id: String,
    time_us: i64,
    widths: Vec<usize>,
    state: tauri::State<'_, AppState>,
) -> CommandResult<tauri::ipc::Response> {
    validate_timeline_thumbnail_widths(&widths)?;
    let project = state
        .projects
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::ProjectStateUnavailable,
                "Project state lock is poisoned",
            )
        })?
        .get(&asset_id)
        .cloned()
        .ok_or_else(|| {
            app_error(
                ErrorCode::MediaNotFound,
                format!("Media asset was not found: {asset_id}"),
            )
        })?;
    let preferences = preferences_clone(&state)?;
    let fingerprint = project.asset.fingerprint.clone();
    let duration_us = project.asset.duration_us;
    let lookups = tokio::task::spawn_blocking(move || {
        let mut lookups = Vec::with_capacity(widths.len());
        let mut cache_time_us = None;
        for width in widths {
            let resolution = timeline_thumbnail_resolution(Some(width))?;
            let lookup = if let Some(canonical_time_us) = cache_time_us {
                read_subtitle_thumbnail_cache_exact(
                    &preferences,
                    &fingerprint,
                    canonical_time_us,
                    duration_us,
                    resolution.width,
                )
            } else {
                read_subtitle_thumbnail_cache(
                    &preferences,
                    &fingerprint,
                    time_us,
                    duration_us,
                    resolution.width,
                )
            };
            cache_time_us.get_or_insert(lookup.cache_time_us);
            lookups.push(lookup);
        }
        Ok::<Vec<_>, AppError>(lookups)
    })
    .await
    .map_err(|error| {
        app_error(
            ErrorCode::BlockingTaskFailed,
            format!("Subtitle thumbnail cache read task failed: {error}"),
        )
    })??;
    Ok(tauri::ipc::Response::new(timeline_thumbnail_batch_payload(
        &lookups,
    )))
}

#[tauri::command]
pub(crate) async fn generate_subtitle_thumbnails(
    asset_id: String,
    time_us: i64,
    widths: Vec<usize>,
    worker_count: Option<usize>,
    state: tauri::State<'_, AppState>,
) -> CommandResult<tauri::ipc::Response> {
    validate_timeline_thumbnail_widths(&widths)?;
    let resolutions = widths
        .iter()
        .map(|width| timeline_thumbnail_resolution(Some(*width)))
        .collect::<AppResult<Vec<_>>>()?;
    let project = state
        .projects
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::ProjectStateUnavailable,
                "Project state lock is poisoned",
            )
        })?
        .get(&asset_id)
        .cloned()
        .ok_or_else(|| {
            app_error(
                ErrorCode::MediaNotFound,
                format!("Media asset was not found: {asset_id}"),
            )
        })?;
    let stream_index = project.asset.video_stream_index.ok_or_else(|| {
        app_error(
            ErrorCode::VideoStreamMissing,
            format!("Media asset has no video stream: {asset_id}"),
        )
    })?;
    let preferences = preferences_clone(&state)?;
    let cache_preferences = preferences.clone();
    let fingerprint = project.asset.fingerprint.clone();
    let duration_us = project.asset.duration_us;
    let temp_root = timeline_thumbnail_temp_root(&preferences);
    let jpegs = extract_timeline_thumbnails(
        &temp_root,
        &ffmpeg_program(&preferences),
        &project.asset.path,
        stream_index,
        time_us,
        &resolutions,
        worker_count,
    )
    .await?;
    let payload = generated_thumbnails_payload(&jpegs);
    let _cache_write = tokio::task::spawn_blocking(move || {
        for (resolution, jpeg) in resolutions.iter().zip(&jpegs) {
            if let Err(error) = write_subtitle_thumbnail_cache(
                &cache_preferences,
                &fingerprint,
                time_us,
                duration_us,
                resolution.width,
                jpeg,
            ) {
                tracing::warn!(detail = %error, "subtitle thumbnail cache write failed");
            }
        }
    });
    Ok(tauri::ipc::Response::new(payload))
}

#[tauri::command]
pub(crate) async fn cache_subtitle_thumbnail(
    asset_id: String,
    time_us: i64,
    width: Option<usize>,
    bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
) -> CommandResult<()> {
    let resolution = timeline_thumbnail_resolution(width)?;
    validate_timeline_thumbnail_jpeg(&bytes)?;
    let project = state
        .projects
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::ProjectStateUnavailable,
                "Project state lock is poisoned",
            )
        })?
        .get(&asset_id)
        .cloned()
        .ok_or_else(|| {
            app_error(
                ErrorCode::MediaNotFound,
                format!("Media asset was not found: {asset_id}"),
            )
        })?;
    let preferences = preferences_clone(&state)?;
    tokio::task::spawn_blocking(move || {
        write_subtitle_thumbnail_cache(
            &preferences,
            &project.asset.fingerprint,
            time_us,
            project.asset.duration_us,
            resolution.width,
            &bytes,
        )
    })
    .await
    .map_err(|error| {
        app_error(
            ErrorCode::BlockingTaskFailed,
            format!("Subtitle thumbnail cache write task failed: {error}"),
        )
    })?
}

#[tauri::command]
pub(crate) async fn get_cached_storyboard_thumbnails(
    asset_id: String,
    time_us: i64,
    widths: Vec<usize>,
    state: tauri::State<'_, AppState>,
) -> CommandResult<tauri::ipc::Response> {
    validate_timeline_thumbnail_widths(&widths)?;
    let project = state
        .projects
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::ProjectStateUnavailable,
                "Project state lock is poisoned",
            )
        })?
        .get(&asset_id)
        .cloned()
        .ok_or_else(|| {
            app_error(
                ErrorCode::MediaNotFound,
                format!("Media asset was not found: {asset_id}"),
            )
        })?;
    let preferences = preferences_clone(&state)?;
    let fingerprint = project.asset.fingerprint.clone();
    let duration_us = project.asset.duration_us;
    let lookups = tokio::task::spawn_blocking(move || {
        widths
            .iter()
            .map(|width| {
                let resolution = timeline_thumbnail_resolution(Some(*width))?;
                Ok::<StoryboardThumbnailCacheLookup, AppError>(read_storyboard_thumbnail_cache(
                    &preferences,
                    &fingerprint,
                    time_us,
                    duration_us,
                    resolution.width,
                ))
            })
            .collect::<AppResult<Vec<_>>>()
    })
    .await
    .map_err(|error| {
        app_error(
            ErrorCode::BlockingTaskFailed,
            format!("Storyboard thumbnail cache read task failed: {error}"),
        )
    })??;
    Ok(tauri::ipc::Response::new(timeline_thumbnail_batch_payload(
        &lookups,
    )))
}

#[tauri::command]
pub(crate) async fn generate_storyboard_thumbnails(
    asset_id: String,
    time_us: i64,
    widths: Vec<usize>,
    worker_count: Option<usize>,
    state: tauri::State<'_, AppState>,
) -> CommandResult<tauri::ipc::Response> {
    validate_timeline_thumbnail_widths(&widths)?;
    let resolutions = widths
        .iter()
        .map(|width| timeline_thumbnail_resolution(Some(*width)))
        .collect::<AppResult<Vec<_>>>()?;
    let project = state
        .projects
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::ProjectStateUnavailable,
                "Project state lock is poisoned",
            )
        })?
        .get(&asset_id)
        .cloned()
        .ok_or_else(|| {
            app_error(
                ErrorCode::MediaNotFound,
                format!("Media asset was not found: {asset_id}"),
            )
        })?;
    let stream_index = project.asset.video_stream_index.ok_or_else(|| {
        app_error(
            ErrorCode::VideoStreamMissing,
            format!("Media asset has no video stream: {asset_id}"),
        )
    })?;
    let preferences = preferences_clone(&state)?;
    let cache_preferences = preferences.clone();
    let fingerprint = project.asset.fingerprint.clone();
    let duration_us = project.asset.duration_us;
    let temp_root = timeline_thumbnail_temp_root(&preferences);
    let jpegs = extract_timeline_thumbnails(
        &temp_root,
        &ffmpeg_program(&preferences),
        &project.asset.path,
        stream_index,
        time_us,
        &resolutions,
        worker_count,
    )
    .await?;
    let payload = generated_thumbnails_payload(&jpegs);
    let _cache_write = tokio::task::spawn_blocking(move || {
        for (resolution, jpeg) in resolutions.iter().zip(&jpegs) {
            if let Err(error) = write_storyboard_thumbnail_cache(
                &cache_preferences,
                &fingerprint,
                time_us,
                duration_us,
                resolution.width,
                jpeg,
            ) {
                tracing::warn!(detail = %error, "storyboard thumbnail cache write failed");
            }
        }
    });
    Ok(tauri::ipc::Response::new(payload))
}

#[tauri::command]
pub(crate) async fn cache_storyboard_thumbnail(
    asset_id: String,
    time_us: i64,
    width: Option<usize>,
    bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
) -> CommandResult<()> {
    let resolution = timeline_thumbnail_resolution(width)?;
    validate_timeline_thumbnail_jpeg(&bytes)?;
    let project = state
        .projects
        .lock()
        .map_err(|_| {
            app_error(
                ErrorCode::ProjectStateUnavailable,
                "Project state lock is poisoned",
            )
        })?
        .get(&asset_id)
        .cloned()
        .ok_or_else(|| {
            app_error(
                ErrorCode::MediaNotFound,
                format!("Media asset was not found: {asset_id}"),
            )
        })?;
    let preferences = preferences_clone(&state)?;
    tokio::task::spawn_blocking(move || {
        write_storyboard_thumbnail_cache(
            &preferences,
            &project.asset.fingerprint,
            time_us,
            project.asset.duration_us,
            resolution.width,
            &bytes,
        )
    })
    .await
    .map_err(|error| {
        app_error(
            ErrorCode::BlockingTaskFailed,
            format!("Storyboard thumbnail cache write task failed: {error}"),
        )
    })?
}

pub(crate) fn has_video_cover_cache(fingerprint: &str, preferences: &Preferences) -> bool {
    let layout = thumbnail_cache_layout(preferences, fingerprint);
    read_media_thumbnail_cache(&layout, fingerprint).is_some_and(|cached| {
        cached.version == CACHE_VERSION && cached.cover.is_some_and(|cover| !cover.is_empty())
    })
}

pub(crate) async fn ensure_video_cover_thumbnail(
    project: &Project,
    preferences: &Preferences,
    cancel: Option<Arc<AtomicBool>>,
    progress: Option<&CoverProgressCallback>,
    stream_index: i32,
) -> AppResult<Vec<u8>> {
    report_cover_progress(progress, 0.0);
    let layout = thumbnail_cache_layout(preferences, &project.asset.fingerprint);
    // Coalesce thumbnail requests and background repair before checking the cache again.
    let lock = COVER_GENERATION_LOCK.lock();
    tokio::pin!(lock);
    let _guard = loop {
        ensure_thumbnail_not_cancelled(cancel.as_ref())?;
        if let Ok(guard) = tokio::time::timeout(Duration::from_millis(100), &mut lock).await {
            break guard;
        }
    };
    // Read completed v2 covers before considering the new sampling schedule.
    if let Some(cover) = read_media_thumbnail_cache(&layout, &project.asset.fingerprint)
        .filter(|cached| cached.version == CACHE_VERSION)
        .and_then(|cached| cached.cover)
        .filter(|cover| !cover.is_empty())
    {
        report_cover_progress(progress, 1.0);
        return Ok(cover);
    }
    register_thumbnail_cache(&layout)?;
    let sample_times = analysis_sample_times(project.asset.duration_us);
    let mut cached = CachedMediaThumbnail {
        version: CACHE_VERSION,
        scores: vec![],
        sample_times,
        cover: None,
    };
    ensure_thumbnail_not_cancelled(cancel.as_ref())?;
    let program = ffmpeg_program(preferences);
    let temp_root = configured_cache_root(preferences).join(TIMELINE_THUMBNAIL_TEMP_FOLDER);
    let temp_dir = create_timeline_thumbnail_temp_directory(&temp_root)?;
    let result = analyze_video_samples(
        &program,
        &project.asset.path,
        stream_index,
        project.asset.duration_us,
        &temp_dir,
        &mut cached,
        cancel.as_ref(),
        progress,
    )
    .await;
    let _ = fs::remove_dir_all(&temp_dir);
    let cover = result?;
    ensure_thumbnail_not_cancelled(cancel.as_ref())?;
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
    width: usize,
) -> (PathBuf, String) {
    let cache_key = if width == SUBTITLE_THUMBNAIL_WIDTH {
        format!("{fingerprint}:{bucket}")
    } else {
        format!("{fingerprint}:{bucket}:{width}")
    };
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
    width: usize,
) -> SubtitleThumbnailCacheLookup {
    let _guard = match SUBTITLE_THUMBNAIL_CACHE_LOCK.lock() {
        Ok(guard) => guard,
        Err(_) => {
            app_error(
                ErrorCode::ThumbnailCacheStateUnavailable,
                "Subtitle thumbnail cache lock is poisoned during a cache read",
            );
            return subtitle_thumbnail_cache_miss(time_us, duration_us);
        }
    };
    read_subtitle_thumbnail_cache_unlocked(preferences, fingerprint, time_us, duration_us, width)
}

fn read_subtitle_thumbnail_cache_unlocked(
    preferences: &Preferences,
    fingerprint: &str,
    time_us: i64,
    duration_us: i64,
    width: usize,
) -> SubtitleThumbnailCacheLookup {
    let requested_time_us = clamped_subtitle_thumbnail_time(time_us, duration_us);
    for bucket in subtitle_thumbnail_candidate_buckets(requested_time_us, duration_us) {
        let cache_time_us = subtitle_thumbnail_bucket_time(bucket, duration_us);
        if subtitle_thumbnail_time_distance(cache_time_us, requested_time_us)
            > SUBTITLE_THUMBNAIL_MATCH_TOLERANCE_US
        {
            continue;
        }
        if let Some(lookup) = read_subtitle_thumbnail_bucket_unlocked(
            preferences,
            fingerprint,
            bucket,
            duration_us,
            width,
        ) {
            return lookup;
        }
    }
    subtitle_thumbnail_cache_miss(requested_time_us, duration_us)
}

fn read_subtitle_thumbnail_cache_exact(
    preferences: &Preferences,
    fingerprint: &str,
    time_us: i64,
    duration_us: i64,
    width: usize,
) -> SubtitleThumbnailCacheLookup {
    let cache_time_us = clamped_subtitle_thumbnail_time(time_us, duration_us);
    let bucket = subtitle_thumbnail_bucket(cache_time_us, duration_us);
    let _guard = match SUBTITLE_THUMBNAIL_CACHE_LOCK.lock() {
        Ok(guard) => guard,
        Err(_) => return subtitle_thumbnail_cache_miss(cache_time_us, duration_us),
    };
    read_subtitle_thumbnail_bucket_unlocked(preferences, fingerprint, bucket, duration_us, width)
        .unwrap_or(SubtitleThumbnailCacheLookup {
            cache_time_us,
            bytes: None,
        })
}

fn read_subtitle_thumbnail_bucket_unlocked(
    preferences: &Preferences,
    fingerprint: &str,
    bucket: i64,
    duration_us: i64,
    width: usize,
) -> Option<SubtitleThumbnailCacheLookup> {
    let cache_time_us = subtitle_thumbnail_bucket_time(bucket, duration_us);
    let (path, cache_key) =
        subtitle_thumbnail_cache_layout(preferences, fingerprint, bucket, width);
    let cached = read_private_cache::<CachedSubtitleThumbnail>(
        &path,
        &cache_key,
        SUBTITLE_THUMBNAIL_CACHE_KEY_CONTEXT,
    )?;
    if cached.version != SUBTITLE_THUMBNAIL_CACHE_VERSION
        || cached.time_us != cache_time_us
        || validate_timeline_thumbnail_jpeg(&cached.jpeg).is_err()
    {
        return None;
    }
    Some(SubtitleThumbnailCacheLookup {
        cache_time_us,
        bytes: Some(cached.jpeg),
    })
}

fn write_subtitle_thumbnail_cache(
    preferences: &Preferences,
    fingerprint: &str,
    time_us: i64,
    duration_us: i64,
    width: usize,
    jpeg: &[u8],
) -> AppResult<()> {
    validate_timeline_thumbnail_jpeg(jpeg)?;
    let _guard = SUBTITLE_THUMBNAIL_CACHE_LOCK.lock().map_err(|_| {
        app_error(
            ErrorCode::ThumbnailCacheStateUnavailable,
            "Subtitle thumbnail cache lock is poisoned",
        )
    })?;
    if read_subtitle_thumbnail_cache_unlocked(preferences, fingerprint, time_us, duration_us, width)
        .bytes
        .is_some()
    {
        return Ok(());
    }
    let bucket = subtitle_thumbnail_bucket(time_us, duration_us);
    let cache_time_us = subtitle_thumbnail_bucket_time(bucket, duration_us);
    let (path, cache_key) =
        subtitle_thumbnail_cache_layout(preferences, fingerprint, bucket, width);
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

fn clamped_storyboard_thumbnail_time(time_us: i64, duration_us: i64) -> i64 {
    time_us.clamp(0, duration_us.saturating_sub(1_000).max(0))
}

fn storyboard_thumbnail_cache_layout(
    preferences: &Preferences,
    fingerprint: &str,
    time_us: i64,
    width: usize,
) -> (PathBuf, String) {
    let cache_key = if width == SUBTITLE_THUMBNAIL_WIDTH {
        format!("{fingerprint}:{time_us}")
    } else {
        format!("{fingerprint}:{time_us}:{width}")
    };
    let cache_hash = hash_name(STORYBOARD_THUMBNAIL_CACHE_KEY_CONTEXT, cache_key.as_bytes());
    let path = configured_cache_root(preferences)
        .join(CACHE_PARENT_FOLDER)
        .join(STORYBOARD_THUMBNAIL_CACHE_FOLDER)
        .join(&cache_hash[..2])
        .join(format!("{cache_hash}.lcsb"));
    (path, cache_key)
}

fn storyboard_thumbnail_cache_miss(
    time_us: i64,
    duration_us: i64,
) -> StoryboardThumbnailCacheLookup {
    StoryboardThumbnailCacheLookup {
        cache_time_us: clamped_storyboard_thumbnail_time(time_us, duration_us),
        bytes: None,
    }
}

fn read_storyboard_thumbnail_cache(
    preferences: &Preferences,
    fingerprint: &str,
    time_us: i64,
    duration_us: i64,
    width: usize,
) -> StoryboardThumbnailCacheLookup {
    let _guard = match STORYBOARD_THUMBNAIL_CACHE_LOCK.lock() {
        Ok(guard) => guard,
        Err(_) => {
            app_error(
                ErrorCode::ThumbnailCacheStateUnavailable,
                "Storyboard thumbnail cache lock is poisoned during a cache read",
            );
            return storyboard_thumbnail_cache_miss(time_us, duration_us);
        }
    };
    let cache_time_us = clamped_storyboard_thumbnail_time(time_us, duration_us);
    let (path, cache_key) =
        storyboard_thumbnail_cache_layout(preferences, fingerprint, cache_time_us, width);
    let Some(cached) = read_private_cache::<CachedStoryboardThumbnail>(
        &path,
        &cache_key,
        STORYBOARD_THUMBNAIL_CACHE_KEY_CONTEXT,
    ) else {
        return storyboard_thumbnail_cache_miss(time_us, duration_us);
    };
    if cached.version != STORYBOARD_THUMBNAIL_CACHE_VERSION
        || cached.time_us != cache_time_us
        || validate_timeline_thumbnail_jpeg(&cached.jpeg).is_err()
    {
        return storyboard_thumbnail_cache_miss(time_us, duration_us);
    }
    StoryboardThumbnailCacheLookup {
        cache_time_us,
        bytes: Some(cached.jpeg),
    }
}

fn write_storyboard_thumbnail_cache(
    preferences: &Preferences,
    fingerprint: &str,
    time_us: i64,
    duration_us: i64,
    width: usize,
    jpeg: &[u8],
) -> AppResult<()> {
    validate_timeline_thumbnail_jpeg(jpeg)?;
    let _guard = STORYBOARD_THUMBNAIL_CACHE_LOCK.lock().map_err(|_| {
        app_error(
            ErrorCode::ThumbnailCacheStateUnavailable,
            "Storyboard thumbnail cache lock is poisoned",
        )
    })?;
    let cache_time_us = clamped_storyboard_thumbnail_time(time_us, duration_us);
    let (path, cache_key) =
        storyboard_thumbnail_cache_layout(preferences, fingerprint, cache_time_us, width);
    if let Some(cached) = read_private_cache::<CachedStoryboardThumbnail>(
        &path,
        &cache_key,
        STORYBOARD_THUMBNAIL_CACHE_KEY_CONTEXT,
    ) {
        if cached.version == STORYBOARD_THUMBNAIL_CACHE_VERSION
            && cached.time_us == cache_time_us
            && validate_timeline_thumbnail_jpeg(&cached.jpeg).is_ok()
        {
            return Ok(());
        }
    }
    write_private_cache(
        &path,
        &cache_key,
        STORYBOARD_THUMBNAIL_CACHE_KEY_CONTEXT,
        &CachedStoryboardThumbnail {
            version: STORYBOARD_THUMBNAIL_CACHE_VERSION,
            time_us: cache_time_us,
            jpeg: jpeg.to_vec(),
        },
    )
}

fn validate_timeline_thumbnail_jpeg(bytes: &[u8]) -> AppResult<()> {
    if bytes.len() < 4 || bytes.len() > MAX_TIMELINE_THUMBNAIL_BYTES {
        return Err(app_error(
            ErrorCode::ThumbnailDataInvalid,
            format!(
                "Timeline thumbnail JPEG size is invalid: {} bytes",
                bytes.len()
            ),
        ));
    }
    if !bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Err(app_error(
            ErrorCode::ThumbnailDataInvalid,
            "Timeline thumbnail data does not have a JPEG signature",
        ));
    }
    Ok(())
}

fn register_thumbnail_cache(layout: &ThumbnailCacheLayout) -> AppResult<()> {
    let _guard = THUMBNAIL_CACHE_LOCK.lock().map_err(|_| {
        app_error(
            ErrorCode::ThumbnailCacheStateUnavailable,
            "Video cover cache lock is poisoned",
        )
    })?;
    let index_parent = layout.index_path.parent().ok_or_else(|| {
        app_error(
            ErrorCode::ThumbnailCacheInvalid,
            "Video cover cache index path has no parent directory",
        )
    })?;
    let cache_parent = layout.cache_path.parent().ok_or_else(|| {
        app_error(
            ErrorCode::ThumbnailCacheInvalid,
            "Video cover cache path has no parent directory",
        )
    })?;
    fs::create_dir_all(index_parent).map_err(|error| {
        app_error(
            ErrorCode::ThumbnailCacheWriteFailed,
            format!("Failed to create the video cover cache index directory: {error}"),
        )
    })?;
    fs::create_dir_all(cache_parent).map_err(|error| {
        app_error(
            ErrorCode::ThumbnailCacheWriteFailed,
            format!("Failed to create the video cover cache directory: {error}"),
        )
    })?;
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
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis().min(u64::MAX as u128) as u64,
        Err(error) => {
            app_error(
                ErrorCode::SystemClockInvalid,
                format!("System clock is earlier than the Unix epoch: {error}"),
            );
            0
        }
    }
}

fn analysis_sample_times(duration_us: i64) -> Vec<i64> {
    let sampling_duration = duration_us.clamp(3_000_000, 15_000_000);
    (0..MAX_ANALYSIS_SAMPLES)
        .map(|index| index as i64 * sampling_duration / 30)
        .take_while(|time| *time == 0 || *time < duration_us)
        .collect()
}

fn cover_batch_filter(stream_index: i32, duration_us: i64) -> String {
    let sampling_duration = duration_us.clamp(3_000_000, 15_000_000);
    // Anchor the output grid at decoded frame zero. Round up input timestamps so
    // sample zero retains frame zero; fps also fills gaps in low-rate/VFR sources.
    // Sample before scaling and stop decoding after the bounded prefix.
    format!(
        "[0:{stream_index}]setpts=PTS-STARTPTS,fps=fps=30000000/{sampling_duration}:start_time=0:round=up:eof_action=pass,trim=end_frame={MAX_ANALYSIS_SAMPLES},split=2[score][cover];\
         [score]scale={ANALYSIS_WIDTH}:{ANALYSIS_HEIGHT}:flags=fast_bilinear,format=rgb24[s];\
         [cover]scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2[c]"
    )
}

#[allow(clippy::too_many_arguments)]
async fn analyze_video_samples(
    program: &str,
    input_path: &str,
    stream_index: i32,
    duration_us: i64,
    temp_dir: &Path,
    cached: &mut CachedMediaThumbnail,
    cancel: Option<&Arc<AtomicBool>>,
    progress: Option<&CoverProgressCallback>,
) -> AppResult<Vec<u8>> {
    let mut args = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
    ];
    append_thumbnail_processing_thread_args(&mut args);
    args.extend([
        "-i".into(),
        input_path.into(),
        "-filter_complex".into(),
        cover_batch_filter(stream_index, duration_us),
        "-map".into(),
        "[s]".into(),
        "-frames:v".into(),
        MAX_ANALYSIS_SAMPLES.to_string(),
        "-fps_mode".into(),
        "passthrough".into(),
        "-c:v".into(),
        "rawvideo".into(),
        "-threads:v".into(),
        "1".into(),
        "-f".into(),
        "rawvideo".into(),
        "pipe:1".into(),
        "-map".into(),
        "[c]".into(),
        "-frames:v".into(),
        MAX_ANALYSIS_SAMPLES.to_string(),
        "-fps_mode".into(),
        "passthrough".into(),
        "-q:v".into(),
        "3".into(),
        "-threads:v".into(),
        "1".into(),
        temp_dir.join("%03d.jpg").to_string_lossy().into_owned(),
    ]);
    let mut command = hidden_command(program);
    command
        .args(args)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = command.output();
    tokio::pin!(output);
    let output = loop {
        ensure_thumbnail_not_cancelled(cancel)?;
        if let Ok(result) = tokio::time::timeout(Duration::from_millis(100), &mut output).await {
            break result.map_err(|error| {
                app_error(
                    ErrorCode::ExternalToolStartFailed,
                    format!("Failed to run video cover batch: {error}"),
                )
            })?;
        }
    };
    if !output.status.success() {
        return Err(app_error(
            ErrorCode::ExternalToolExecutionFailed,
            format!(
                "Video cover batch failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
        ));
    }
    if output.stdout.is_empty() || output.stdout.len() % ANALYSIS_FRAME_BYTES != 0 {
        return Err(app_error(
            ErrorCode::ThumbnailNoFrame,
            "Video cover batch produced no complete frames",
        ));
    }
    let frames = output.stdout.chunks_exact(ANALYSIS_FRAME_BYTES);
    let total = frames.len();
    let mut best_index = 0;
    let mut best_score = f64::NEG_INFINITY;
    for (index, frame) in frames.enumerate() {
        ensure_thumbnail_not_cancelled(cancel)?;
        let score = frame_information_score(frame) * COVER_POSITION_DECAY.powi(index as i32);
        cached.scores.push(Some(score));
        if score > best_score {
            best_index = index;
            best_score = score;
        }
        report_cover_progress(progress, 0.8 + 0.18 * (index + 1) as f64 / total as f64);
    }
    fs::read(temp_dir.join(format!("{:03}.jpg", best_index + 1))).map_err(|error| {
        app_error(
            ErrorCode::ThumbnailExtractionFailed,
            format!("Failed to read selected cover: {error}"),
        )
    })
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

async fn extract_timeline_thumbnail(
    program: &str,
    input_path: &str,
    stream_index: i32,
    time_us: i64,
    resolution: TimelineThumbnailResolution,
    worker_count: Option<usize>,
) -> AppResult<Vec<u8>> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-ss".to_string(),
        // Subtract 1µs so the at-or-after seek lands exactly on the target frame
        // (a boundary-exact timestamp could round up into the next frame).
        format!("{:.6}", time_us.saturating_sub(1) as f64 / 1_000_000.0),
    ];
    append_timeline_thumbnail_processing_thread_args(&mut args, worker_count);
    args.extend([
        "-i".to_string(),
        input_path.to_string(),
        "-map".to_string(),
        format!("0:{stream_index}"),
        "-frames:v".to_string(),
        "1".to_string(),
        "-vf".to_string(),
        timeline_thumbnail_scale_filter(resolution),
        "-q:v".to_string(),
        "8".to_string(),
        "-f".to_string(),
        "image2pipe".to_string(),
        "-vcodec".to_string(),
        "mjpeg".to_string(),
    ]);
    append_ffmpeg_video_output_thread_args(
        &mut args,
        timeline_thumbnail_processing_thread_budget(worker_count),
    );
    args.push("pipe:1".to_string());
    let output = hidden_command(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| {
            app_error(
                ErrorCode::ExternalToolStartFailed,
                format!("Failed to start {program} for timeline thumbnail extraction: {error}"),
            )
        })?;
    if !output.status.success() {
        return Err(app_error(
            ErrorCode::ThumbnailExtractionFailed,
            format!(
                "Timeline thumbnail extraction failed; stderr={}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    if output.stdout.is_empty() {
        return Err(app_error(
            ErrorCode::ExternalToolOutputInvalid,
            "Timeline thumbnail extraction returned an empty image",
        ));
    }
    Ok(output.stdout)
}

fn timeline_thumbnail_temp_root(preferences: &Preferences) -> PathBuf {
    configured_cache_root(preferences).join(TIMELINE_THUMBNAIL_TEMP_FOLDER)
}

fn create_timeline_thumbnail_temp_directory(temp_root: &Path) -> AppResult<PathBuf> {
    fs::create_dir_all(temp_root).map_err(|error| {
        app_error(
            ErrorCode::ThumbnailExtractionFailed,
            format!("Failed to create the temporary thumbnail root directory: {error}"),
        )
    })?;
    remove_stale_timeline_thumbnail_temp_directories(temp_root);
    let directory = temp_root.join(format!("linecut-thumb-{}", Uuid::new_v4()));
    fs::create_dir(&directory).map_err(|error| {
        app_error(
            ErrorCode::ThumbnailExtractionFailed,
            format!("Failed to create the temporary thumbnail directory: {error}"),
        )
    })?;
    Ok(directory)
}

fn remove_stale_timeline_thumbnail_temp_directories(temp_root: &Path) {
    let now = SystemTime::now();
    let Ok(entries) = fs::read_dir(temp_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_dir() {
            continue;
        }
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= STALE_TIMELINE_THUMBNAIL_TEMP_DIRECTORY_AGE);
        if stale {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

async fn extract_timeline_thumbnails(
    temp_root: &Path,
    program: &str,
    input_path: &str,
    stream_index: i32,
    time_us: i64,
    resolutions: &[TimelineThumbnailResolution],
    worker_count: Option<usize>,
) -> AppResult<Vec<Vec<u8>>> {
    if resolutions.is_empty() {
        return Ok(Vec::new());
    }
    if let [resolution] = resolutions {
        return extract_timeline_thumbnail(
            program,
            input_path,
            stream_index,
            time_us,
            *resolution,
            worker_count,
        )
        .await
        .map(|jpeg| vec![jpeg]);
    }
    let temp_root = temp_root.to_path_buf();
    let temp_dir =
        tokio::task::spawn_blocking(move || create_timeline_thumbnail_temp_directory(&temp_root))
            .await
            .map_err(|error| {
                app_error(
                    ErrorCode::BlockingTaskFailed,
                    format!("Timeline thumbnail temp directory task failed: {error}"),
                )
            })??;
    let result = extract_timeline_thumbnails_into(
        &temp_dir,
        program,
        input_path,
        stream_index,
        time_us,
        resolutions,
        worker_count,
    )
    .await;
    let _ = tokio::task::spawn_blocking(move || fs::remove_dir_all(&temp_dir)).await;
    result
}

async fn extract_timeline_thumbnails_into(
    temp_dir: &Path,
    program: &str,
    input_path: &str,
    stream_index: i32,
    time_us: i64,
    resolutions: &[TimelineThumbnailResolution],
    worker_count: Option<usize>,
) -> AppResult<Vec<Vec<u8>>> {
    let filter = timeline_thumbnail_multi_resolution_filter(stream_index, resolutions);
    let output_paths = (0..resolutions.len())
        .map(|index| temp_dir.join(format!("{index}.jpg")))
        .collect::<Vec<_>>();

    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-ss".to_string(),
        // Subtract 1µs so the at-or-after seek lands exactly on the target frame
        // (a boundary-exact timestamp could round up into the next frame).
        format!("{:.6}", time_us.saturating_sub(1) as f64 / 1_000_000.0),
    ];
    append_timeline_thumbnail_processing_thread_args(&mut args, worker_count);
    args.extend([
        "-i".to_string(),
        input_path.to_string(),
        "-filter_complex".to_string(),
        filter,
    ]);
    let output_thread_budget =
        timeline_thumbnail_output_thread_budget(worker_count, output_paths.len());
    for (index, path) in output_paths.iter().enumerate() {
        args.extend([
            "-map".to_string(),
            format!("[t{index}]"),
            "-frames:v".to_string(),
            "1".to_string(),
            "-q:v".to_string(),
            "8".to_string(),
            "-vcodec".to_string(),
            "mjpeg".to_string(),
        ]);
        append_ffmpeg_video_output_thread_args(&mut args, output_thread_budget);
        args.push(path.to_string_lossy().into_owned());
    }

    let output = hidden_command(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| {
            app_error(
                ErrorCode::ExternalToolStartFailed,
                format!("Failed to start {program} for timeline thumbnail extraction: {error}"),
            )
        })?;
    if !output.status.success() {
        return Err(app_error(
            ErrorCode::ThumbnailExtractionFailed,
            format!(
                "Timeline thumbnail extraction failed; stderr={}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }

    let mut jpegs = Vec::with_capacity(resolutions.len());
    for path in &output_paths {
        let bytes = fs::read(path).map_err(|error| {
            app_error(
                ErrorCode::ThumbnailExtractionFailed,
                format!(
                    "Failed to read the extracted thumbnail {}: {error}",
                    path.display()
                ),
            )
        })?;
        validate_timeline_thumbnail_jpeg(&bytes)?;
        jpegs.push(bytes);
    }
    Ok(jpegs)
}

fn timeline_thumbnail_multi_resolution_filter(
    stream_index: i32,
    resolutions: &[TimelineThumbnailResolution],
) -> String {
    let mut filter = format!("[0:{stream_index}]split={}[s0]", resolutions.len());
    for index in 1..resolutions.len() {
        filter.push_str(&format!("[s{index}]"));
    }
    for (index, resolution) in resolutions.iter().enumerate() {
        filter.push_str(&format!(
            ";[s{index}]{}[t{index}]",
            timeline_thumbnail_scale_filter(*resolution)
        ));
    }
    filter
}

fn ensure_thumbnail_not_cancelled(cancel: Option<&Arc<AtomicBool>>) -> AppResult<()> {
    if cancel.is_some_and(|cancel| cancel.load(Ordering::Relaxed)) {
        Err(app_error(
            ErrorCode::TaskCancelled,
            "Thumbnail generation was cancelled",
        ))
    } else {
        Ok(())
    }
}

fn read_media_thumbnail_cache(
    layout: &ThumbnailCacheLayout,
    fingerprint: &str,
) -> Option<CachedMediaThumbnail> {
    let _guard = match THUMBNAIL_CACHE_LOCK.lock() {
        Ok(guard) => guard,
        Err(_) => {
            app_error(
                ErrorCode::ThumbnailCacheStateUnavailable,
                "Video cover cache lock is poisoned during a cache read",
            );
            return None;
        }
    };
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
) -> AppResult<()> {
    let _guard = THUMBNAIL_CACHE_LOCK.lock().map_err(|_| {
        app_error(
            ErrorCode::ThumbnailCacheStateUnavailable,
            "Video cover cache lock is poisoned",
        )
    })?;
    write_private_cache(&layout.cache_path, fingerprint, CACHE_KEY_CONTEXT, cached)
}

pub(super) fn read_private_cache<Value>(path: &Path, key: &str, context: &[u8]) -> Option<Value>
where
    Value: for<'de> Deserialize<'de>,
{
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            app_error(
                ErrorCode::ThumbnailCacheReadFailed,
                format!(
                    "Failed to read thumbnail cache file {}: {error}",
                    path.display()
                ),
            );
            return None;
        }
    };
    let envelope = match bincode::deserialize::<PrivateCacheEnvelope>(&bytes) {
        Ok(envelope) => envelope,
        Err(error) => {
            app_error(
                ErrorCode::ThumbnailCacheInvalid,
                format!(
                    "Failed to decode thumbnail cache envelope {}: {error}",
                    path.display()
                ),
            );
            return None;
        }
    };
    if envelope.version != 1 {
        return None;
    }
    let serialized = transform_private_payload(&envelope.payload, key, context);
    if private_cache_digest(&serialized, key, context) != envelope.digest {
        app_error(
            ErrorCode::ThumbnailCacheInvalid,
            format!(
                "Thumbnail cache digest does not match for {}",
                path.display()
            ),
        );
        return None;
    }
    match bincode::deserialize(&serialized) {
        Ok(value) => Some(value),
        Err(error) => {
            app_error(
                ErrorCode::ThumbnailCacheInvalid,
                format!(
                    "Failed to decode thumbnail cache payload {}: {error}",
                    path.display()
                ),
            );
            None
        }
    }
}

pub(super) fn write_private_cache<Value>(
    path: &Path,
    key: &str,
    context: &[u8],
    value: &Value,
) -> AppResult<()>
where
    Value: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            app_error(
                ErrorCode::ThumbnailCacheWriteFailed,
                format!("Failed to create the thumbnail cache directory: {error}"),
            )
        })?;
    }
    let serialized = bincode::serialize(value).map_err(|error| {
        app_error(
            ErrorCode::ThumbnailCacheWriteFailed,
            format!("Failed to encode thumbnail cache data: {error}"),
        )
    })?;
    let envelope = PrivateCacheEnvelope {
        version: 1,
        digest: private_cache_digest(&serialized, key, context),
        payload: transform_private_payload(&serialized, key, context),
    };
    let output = bincode::serialize(&envelope).map_err(|error| {
        app_error(
            ErrorCode::ThumbnailCacheWriteFailed,
            format!("Failed to encode the thumbnail cache envelope: {error}"),
        )
    })?;
    fs::write(path, output).map_err(|error| {
        app_error(
            ErrorCode::ThumbnailCacheWriteFailed,
            format!(
                "Failed to write thumbnail cache file {}: {error}",
                path.display()
            ),
        )
    })
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

pub(super) fn hash_name(context: &[u8], value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(context);
    hasher.update(value);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn timeline_thumbnail_batch_payload(lookups: &[impl TimelineThumbnailCacheLookup]) -> Vec<u8> {
    let cache_time_us = lookups.first().map_or(0, |lookup| lookup.cache_time_us());
    let mut payload = Vec::new();
    payload.extend_from_slice(&cache_time_us.to_le_bytes());
    for lookup in lookups {
        match lookup.bytes() {
            Some(jpeg) => {
                payload.push(1);
                payload.extend_from_slice(&(jpeg.len() as u32).to_le_bytes());
                payload.extend_from_slice(jpeg);
            }
            None => payload.push(0),
        }
    }
    payload
}

fn generated_thumbnails_payload(jpegs: &[Vec<u8>]) -> Vec<u8> {
    let mut payload = Vec::new();
    for jpeg in jpegs {
        payload.extend_from_slice(&(jpeg.len() as u32).to_le_bytes());
        payload.extend_from_slice(jpeg);
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completed_legacy_cover_survives_a_different_sampling_schedule() {
        let root = std::env::temp_dir().join(format!("linecut-legacy-test-{}", Uuid::new_v4()));
        let preferences = Preferences {
            cache_dir: root.to_string_lossy().into_owned(),
            ..Preferences::default()
        };
        let project: Project = serde_json::from_value(serde_json::json!({
            "asset": { "id": "legacy", "path": "missing-video", "file_name": "legacy.mp4",
                "file_size": 0, "modified_at": 0, "fingerprint": "legacy-cover-test",
                "duration_us": 120000000, "start_time_us": 0,
                "video_stream_index": 0, "audio_stream_index": null },
            "streams": [], "tracks": [], "cues": {}, "cache_dir": "", "proxy_path": null
        }))
        .unwrap();
        let layout = thumbnail_cache_layout(&preferences, &project.asset.fingerprint);
        register_thumbnail_cache(&layout).unwrap();
        let legacy = CachedMediaThumbnail {
            version: CACHE_VERSION,
            sample_times: vec![0, 119999000],
            scores: vec![Some(0.1), Some(0.2)],
            cover: Some(vec![1, 2, 3]),
        };
        write_media_thumbnail_cache(&layout, &project.asset.fingerprint, &legacy).unwrap();
        let before = fs::read(&layout.cache_path).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert_eq!(
            runtime
                .block_on(ensure_video_cover_thumbnail(
                    &project,
                    &preferences,
                    None,
                    None,
                    0
                ))
                .unwrap(),
            vec![1, 2, 3]
        );
        assert_eq!(before, fs::read(&layout.cache_path).unwrap());
        assert!(has_video_cover_cache(
            &project.asset.fingerprint,
            &preferences
        ));
        fs::remove_file(&layout.cache_path).unwrap();
        assert!(!has_video_cover_cache(
            &project.asset.fingerprint,
            &preferences
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cover_schedule_starts_at_zero_and_caps_the_prefix() {
        assert_eq!(analysis_sample_times(0), vec![0]);
        assert_eq!(analysis_sample_times(50_000), vec![0]);
        assert_eq!(
            analysis_sample_times(1_000_000),
            (0..10).map(|i| i * 100_000).collect::<Vec<_>>()
        );
        assert_eq!(analysis_sample_times(9_000_000)[1], 300_000);
        let long = analysis_sample_times(3_600_000_000);
        assert_eq!(long.len(), 120);
        assert_eq!(long[119], 59_500_000);
        assert_eq!(long, analysis_sample_times(3_600_000_000));
    }

    #[test]
    fn cover_decay_is_weak_and_prefers_earlier_equal_scores() {
        assert_eq!(COVER_POSITION_DECAY.powi(0), 1.0);
        assert!(COVER_POSITION_DECAY.powi(119) > 0.66);
        assert!(COVER_POSITION_DECAY.powi(1) < 1.0);
        assert!(0.9 * COVER_POSITION_DECAY.powi(119) > 0.5);
    }

    // Opt in with LINECUT_TEST_FFMPEG; uses the production graph and cache path.
    #[test]
    fn cover_batch_ffmpeg_regression() {
        let Ok(program) = std::env::var("LINECUT_TEST_FFMPEG") else {
            return;
        };
        let root = std::env::temp_dir().join(format!("linecut-cover-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("input.mkv");
        let status = std::process::Command::new(&program)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x90:rate=10:duration=70",
                "-c:v",
                "ffv1",
                input.to_str().unwrap(),
            ])
            .status()
            .unwrap();
        assert!(status.success());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut cached = CachedMediaThumbnail {
            version: CACHE_VERSION,
            sample_times: analysis_sample_times(70_000_000),
            scores: vec![],
            cover: None,
        };
        let first = runtime
            .block_on(analyze_video_samples(
                &program,
                input.to_str().unwrap(),
                0,
                70_000_000,
                &root,
                &mut cached,
                None,
                None,
            ))
            .unwrap();
        assert_eq!(cached.scores.len(), 120);
        assert!(first.starts_with(&[0xff, 0xd8]));
        let scores = cached.scores.clone();
        for index in 1..=120 {
            fs::remove_file(root.join(format!("{index:03}.jpg"))).unwrap();
        }
        cached.scores.clear();
        let second = runtime
            .block_on(analyze_video_samples(
                &program,
                input.to_str().unwrap(),
                0,
                70_000_000,
                &root,
                &mut cached,
                None,
                None,
            ))
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(scores, cached.scores);
        for (name, source, duration_us, expected) in [
            (
                "low-rate",
                "testsrc2=size=160x90:rate=1:duration=70",
                70_000_000,
                120,
            ),
            (
                "single-frame",
                "testsrc2=size=160x90:rate=25:duration=0.04",
                40_000,
                1,
            ),
        ] {
            let directory = root.join(name);
            fs::create_dir(&directory).unwrap();
            let input = directory.join("input.mkv");
            assert!(std::process::Command::new(&program)
                .args([
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    source,
                    "-vf",
                    "setpts=PTS+5/TB",
                    "-c:v",
                    "ffv1",
                    input.to_str().unwrap(),
                ])
                .status()
                .unwrap()
                .success());
            cached.scores.clear();
            runtime
                .block_on(analyze_video_samples(
                    &program,
                    input.to_str().unwrap(),
                    0,
                    duration_us,
                    &directory,
                    &mut cached,
                    None,
                    None,
                ))
                .unwrap();
            assert_eq!(cached.scores.len(), expected, "{name}");
        }
        let cancel = Arc::new(AtomicBool::new(true));
        assert!(runtime
            .block_on(analyze_video_samples(
                &program,
                input.to_str().unwrap(),
                0,
                70_000_000,
                &root,
                &mut cached,
                Some(&cancel),
                None
            ))
            .unwrap_err()
            .is(ErrorCode::TaskCancelled));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn base_timeline_thumbnail_uses_fast_scaling() {
        let filter = timeline_thumbnail_scale_filter(
            timeline_thumbnail_resolution(Some(SUBTITLE_THUMBNAIL_WIDTH)).unwrap(),
        );
        assert_eq!(
            filter,
            "scale=160:90:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=160:90"
        );
    }

    #[test]
    fn larger_timeline_thumbnail_preserves_quality_scaling() {
        let filter =
            timeline_thumbnail_scale_filter(timeline_thumbnail_resolution(Some(640)).unwrap());
        assert_eq!(
            filter,
            "scale=640:360:force_original_aspect_ratio=increase,crop=640:360"
        );
    }

    #[test]
    fn single_cover_batch_receives_at_least_the_timeline_worker_budget() {
        assert!(
            thumbnail_processing_thread_budget()
                >= timeline_thumbnail_processing_thread_budget(Some(4))
        );
    }

    #[test]
    fn timeline_thumbnail_worker_count_adapts_ffmpeg_thread_budget() {
        assert!(
            timeline_thumbnail_processing_thread_budget(Some(2))
                >= timeline_thumbnail_processing_thread_budget(Some(8))
        );
        assert_eq!(
            timeline_thumbnail_processing_thread_budget(Some(usize::MAX)),
            timeline_thumbnail_processing_thread_budget(Some(MAX_TIMELINE_THUMBNAIL_WORKERS))
        );
    }

    #[test]
    fn timeline_thumbnail_width_validation_rejects_invalid_batches() {
        assert!(validate_timeline_thumbnail_widths(&[160, 640, 1280]).is_ok());
        assert!(validate_timeline_thumbnail_widths(&[]).is_err());
        assert!(validate_timeline_thumbnail_widths(&[160, 160]).is_err());
        assert!(validate_timeline_thumbnail_widths(&[160, 640, 1280, 160]).is_err());
    }

    #[test]
    fn multi_resolution_filter_splits_one_frame_into_each_size() {
        let resolutions = [
            timeline_thumbnail_resolution(Some(160)).unwrap(),
            timeline_thumbnail_resolution(Some(640)).unwrap(),
            timeline_thumbnail_resolution(Some(1280)).unwrap(),
        ];
        assert_eq!(
            timeline_thumbnail_multi_resolution_filter(2, &resolutions),
            "[0:2]split=3[s0][s1][s2];[s0]scale=160:90:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=160:90[t0];[s1]scale=640:360:force_original_aspect_ratio=increase,crop=640:360[t1];[s2]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720[t2]"
        );
    }

    #[test]
    fn multi_resolution_outputs_share_the_process_thread_budget() {
        let process_budget = timeline_thumbnail_processing_thread_budget(Some(1));
        assert_eq!(
            timeline_thumbnail_output_thread_budget(Some(1), 1),
            process_budget
        );
        assert_eq!(
            timeline_thumbnail_output_thread_budget(Some(1), 3),
            (process_budget / 3).max(1)
        );
    }

    #[test]
    fn timeline_thumbnail_payloads_preserve_resolution_order() {
        let lookups = [
            SubtitleThumbnailCacheLookup {
                cache_time_us: 42,
                bytes: Some(vec![1, 2]),
            },
            SubtitleThumbnailCacheLookup {
                cache_time_us: 42,
                bytes: None,
            },
            SubtitleThumbnailCacheLookup {
                cache_time_us: 42,
                bytes: Some(vec![3]),
            },
        ];
        let mut expected_cache_payload = 42_i64.to_le_bytes().to_vec();
        expected_cache_payload.extend([1, 2, 0, 0, 0, 1, 2, 0, 1, 1, 0, 0, 0, 3]);
        assert_eq!(
            timeline_thumbnail_batch_payload(&lookups),
            expected_cache_payload
        );

        assert_eq!(
            generated_thumbnails_payload(&[vec![1, 2], vec![3]]),
            vec![2, 0, 0, 0, 1, 2, 1, 0, 0, 0, 3]
        );
    }
}
