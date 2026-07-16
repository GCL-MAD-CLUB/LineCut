import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./tauriRuntime";

const thumbnailWidth = 160;
const thumbnailHeight = 90;
const maximumCachedThumbnails = 4096;
const extractionTimeoutMs = 5_000;
const thumbnailTimeBucketUs = 100_000;
const thumbnailMatchToleranceUs = 100_000;
const defaultThumbnailPriority = Number.MAX_SAFE_INTEGER;

interface SubtitleThumbnailOptions {
  assetId: string;
  fingerprint: string;
  videoPath: string;
  timeUs: number;
  priority?: number;
}

interface ThumbnailJob {
  key: string;
  options: SubtitleThumbnailOptions;
  consumers: Map<number, number>;
  sequence: number;
  settled: boolean;
  promise: Promise<string>;
  resolve: (url: string) => void;
  reject: (error: unknown) => void;
}

interface SubtitleThumbnailCacheLookup {
  cache_time_us: number;
  bytes: number[] | null;
}

interface CachedThumbnail {
  url: string;
  timeUs: number;
}

interface ExtractedThumbnail {
  blob: Blob;
  timeUs: number;
}

export interface SubtitleThumbnailRequest {
  promise: Promise<string>;
  cancel: () => void;
}

const thumbnailCache = new Map<string, CachedThumbnail>();
const pendingJobs = new Map<string, ThumbnailJob>();
const thumbnailQueue: ThumbnailJob[] = [];
const unsupportedWebViewSources = new Set<string>();

let workerRunning = false;
let workerScheduled = false;
let queueOrderDirty = false;
let nextConsumerId = 0;
let nextJobSequence = 0;
let extractorVideo: HTMLVideoElement | null = null;
let extractorCanvas: HTMLCanvasElement | null = null;
let loadedVideoSource = "";

function thumbnailBucket(timeUs: number) {
  return Math.round(Math.max(0, timeUs) / thumbnailTimeBucketUs);
}

function thumbnailKeyForBucket(fingerprint: string, bucket: number) {
  return `${fingerprint}:${bucket}`;
}

function thumbnailKey({ fingerprint, timeUs }: SubtitleThumbnailOptions) {
  return thumbnailKeyForBucket(fingerprint, thumbnailBucket(timeUs));
}

function cachedThumbnail(options: SubtitleThumbnailOptions) {
  const requestedTimeUs = Math.max(0, options.timeUs);
  const bucket = thumbnailBucket(requestedTimeUs);
  const match = [bucket, bucket - 1, bucket + 1]
    .filter((candidate) => candidate >= 0)
    .map((candidate) => {
      const key = thumbnailKeyForBucket(options.fingerprint, candidate);
      return { key, cached: thumbnailCache.get(key) };
    })
    .filter(
      (candidate): candidate is { key: string; cached: CachedThumbnail } =>
        Boolean(candidate.cached) &&
        Math.abs(candidate.cached!.timeUs - requestedTimeUs) <= thumbnailMatchToleranceUs,
    )
    .sort(
      (left, right) =>
        Math.abs(left.cached.timeUs - requestedTimeUs) -
        Math.abs(right.cached.timeUs - requestedTimeUs),
    )[0];
  if (!match) {
    return null;
  }
  thumbnailCache.delete(match.key);
  thumbnailCache.set(match.key, match.cached);
  return match.cached.url;
}

function rememberThumbnail(key: string, url: string, timeUs: number) {
  const previous = thumbnailCache.get(key);
  if (previous && previous.url !== url) {
    URL.revokeObjectURL(previous.url);
  }
  thumbnailCache.delete(key);
  thumbnailCache.set(key, { url, timeUs });

  while (thumbnailCache.size > maximumCachedThumbnails) {
    const oldestKey = thumbnailCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    const oldest = thumbnailCache.get(oldestKey);
    thumbnailCache.delete(oldestKey);
    if (oldest) {
      URL.revokeObjectURL(oldest.url);
    }
  }
}

function cancelledError() {
  return new DOMException("字幕缩略图请求已取消", "AbortError");
}

function normalizedPriority(priority: number | undefined) {
  return priority !== undefined && Number.isFinite(priority)
    ? Math.max(0, priority)
    : defaultThumbnailPriority;
}

function activeJobPriority(job: ThumbnailJob) {
  let priority = defaultThumbnailPriority;
  for (const consumerPriority of job.consumers.values()) {
    priority = Math.min(priority, consumerPriority);
  }
  return priority;
}

function sortThumbnailQueue() {
  if (!queueOrderDirty) {
    return;
  }
  thumbnailQueue.sort(
    (left, right) =>
      activeJobPriority(left) - activeJobPriority(right) || left.sequence - right.sequence,
  );
  queueOrderDirty = false;
}

function scheduleThumbnailWorker() {
  if (workerRunning || workerScheduled) {
    return;
  }
  workerScheduled = true;
  queueMicrotask(() => {
    workerScheduled = false;
    void drainThumbnailQueue();
  });
}

export function requestSubtitleThumbnail(
  options: SubtitleThumbnailOptions,
): SubtitleThumbnailRequest {
  const key = thumbnailKey(options);
  const cached = cachedThumbnail(options);
  if (cached) {
    return { promise: Promise.resolve(cached), cancel: () => undefined };
  }

  const consumerId = nextConsumerId++;
  const priority = normalizedPriority(options.priority);
  let job = pendingJobs.get(key);
  if (!job) {
    let resolve!: (url: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    job = {
      key,
      options,
      consumers: new Map([[consumerId, priority]]),
      sequence: nextJobSequence++,
      settled: false,
      promise,
      resolve,
      reject,
    };
    pendingJobs.set(key, job);
    thumbnailQueue.push(job);
    queueOrderDirty = true;
    scheduleThumbnailWorker();
  } else {
    job.consumers.set(consumerId, priority);
    queueOrderDirty = true;
  }
  let cancelled = false;
  return {
    promise: job.promise,
    cancel: () => {
      if (cancelled || job!.settled) {
        return;
      }
      cancelled = true;
      job!.consumers.delete(consumerId);
      queueOrderDirty = true;
    },
  };
}

async function drainThumbnailQueue() {
  if (workerRunning) {
    return;
  }
  workerRunning = true;
  try {
    while (thumbnailQueue.length > 0) {
      sortThumbnailQueue();
      const job = thumbnailQueue.shift()!;
      if (job.consumers.size === 0) {
        pendingJobs.delete(job.key);
        job.settled = true;
        job.reject(cancelledError());
        continue;
      }
      const cached = cachedThumbnail(job.options);
      if (cached) {
        pendingJobs.delete(job.key);
        job.settled = true;
        job.resolve(cached);
        continue;
      }

      try {
        const extracted = await extractThumbnail(job.options);
        const url = URL.createObjectURL(extracted.blob);
        rememberThumbnail(job.key, url, extracted.timeUs);
        job.resolve(url);
      } catch (error) {
        job.reject(error);
      } finally {
        pendingJobs.delete(job.key);
        job.settled = true;
      }
    }
  } finally {
    workerRunning = false;
    if (thumbnailQueue.length > 0) {
      scheduleThumbnailWorker();
    }
  }
}

async function extractThumbnail(options: SubtitleThumbnailOptions) {
  const tauriRuntime = isTauriRuntime();
  const videoSource = tauriRuntime ? convertFileSrc(options.videoPath) : options.videoPath;
  let extractionTimeUs = options.timeUs;

  if (tauriRuntime) {
    try {
      const cached = await invoke<SubtitleThumbnailCacheLookup>("get_cached_subtitle_thumbnail", {
        assetId: options.assetId,
        timeUs: Math.max(0, Math.round(options.timeUs)),
      });
      extractionTimeUs = cached.cache_time_us;
      if (cached.bytes) {
        return {
          blob: new Blob([new Uint8Array(cached.bytes)], { type: "image/jpeg" }),
          timeUs: cached.cache_time_us,
        } satisfies ExtractedThumbnail;
      }
    } catch {
      // Cache failures must not prevent the thumbnail from being displayed.
    }
  }

  if (!unsupportedWebViewSources.has(videoSource)) {
    try {
      const blob = await extractThumbnailInWebView(videoSource, extractionTimeUs);
      if (tauriRuntime) {
        void persistSubtitleThumbnail(options.assetId, extractionTimeUs, blob);
      }
      return { blob, timeUs: extractionTimeUs } satisfies ExtractedThumbnail;
    } catch {
      unsupportedWebViewSources.add(videoSource);
      resetExtractorVideo();
    }
  }

  if (!tauriRuntime) {
    throw new Error("浏览器无法生成字幕缩略图");
  }
  const serializedBytes = await invoke<number[]>("generate_subtitle_thumbnail", {
    assetId: options.assetId,
    timeUs: Math.max(0, Math.round(extractionTimeUs)),
  });
  return {
    blob: new Blob([new Uint8Array(serializedBytes)], { type: "image/jpeg" }),
    timeUs: extractionTimeUs,
  } satisfies ExtractedThumbnail;
}

async function persistSubtitleThumbnail(assetId: string, timeUs: number, blob: Blob) {
  try {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    await invoke("cache_subtitle_thumbnail", {
      assetId,
      timeUs: Math.max(0, Math.round(timeUs)),
      bytes,
    });
  } catch {
    // Persistence is best effort; the in-memory thumbnail remains usable.
  }
}

function videoElement() {
  if (!extractorVideo) {
    extractorVideo = document.createElement("video");
    extractorVideo.crossOrigin = "anonymous";
    extractorVideo.muted = true;
    extractorVideo.preload = "auto";
    extractorVideo.playsInline = true;
  }
  return extractorVideo;
}

function canvasElement() {
  if (!extractorCanvas) {
    extractorCanvas = document.createElement("canvas");
    extractorCanvas.width = thumbnailWidth;
    extractorCanvas.height = thumbnailHeight;
  }
  return extractorCanvas;
}

function resetExtractorVideo() {
  if (extractorVideo) {
    extractorVideo.pause();
    extractorVideo.removeAttribute("src");
    extractorVideo.load();
  }
  loadedVideoSource = "";
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  successEvents: Array<keyof HTMLMediaElementEventMap>,
) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      for (const eventName of successEvents) {
        video.removeEventListener(eventName, handleSuccess);
      }
      video.removeEventListener("error", handleError);
    };
    const handleSuccess = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(video.error ?? new Error("视频帧解码失败"));
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("视频帧解码超时"));
    }, extractionTimeoutMs);

    for (const eventName of successEvents) {
      video.addEventListener(eventName, handleSuccess, { once: true });
    }
    video.addEventListener("error", handleError, { once: true });
  });
}

async function prepareVideo(video: HTMLVideoElement, source: string) {
  if (loadedVideoSource === source && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return;
  }

  resetExtractorVideo();
  const ready = waitForVideoEvent(video, ["loadedmetadata"]);
  video.src = source;
  video.load();
  await ready;
  loadedVideoSource = source;
}

async function seekVideo(video: HTMLVideoElement, timeUs: number) {
  const requestedSeconds = Math.max(0, timeUs / 1_000_000);
  const latestTime = Number.isFinite(video.duration)
    ? Math.max(0, video.duration - 0.001)
    : requestedSeconds;
  const targetSeconds = Math.min(requestedSeconds, latestTime);

  if (Math.abs(video.currentTime - targetSeconds) > 0.001) {
    const seeked = waitForVideoEvent(video, ["seeked"]);
    video.currentTime = targetSeconds;
    await seeked;
  }
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForVideoEvent(video, ["loadeddata", "canplay"]);
  }
}

function thumbnailBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("无法编码字幕缩略图"));
        }
      },
      "image/jpeg",
      0.68,
    );
  });
}

async function extractThumbnailInWebView(videoSource: string, timeUs: number) {
  const video = videoElement();
  await prepareVideo(video, videoSource);
  await seekVideo(video, timeUs);

  if (video.videoWidth <= 0 || video.videoHeight <= 0) {
    throw new Error("视频帧尺寸无效");
  }
  const canvas = canvasElement();
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("无法创建字幕缩略图画布");
  }

  const scale = Math.max(thumbnailWidth / video.videoWidth, thumbnailHeight / video.videoHeight);
  const sourceWidth = thumbnailWidth / scale;
  const sourceHeight = thumbnailHeight / scale;
  const sourceX = (video.videoWidth - sourceWidth) / 2;
  const sourceY = (video.videoHeight - sourceHeight) / 2;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "low";
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    thumbnailWidth,
    thumbnailHeight,
  );
  return thumbnailBlob(canvas);
}
