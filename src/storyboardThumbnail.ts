import { convertFileSrc } from "@tauri-apps/api/core";
import {
  captureOperationError,
  clientError,
  invokeCommand,
  runBackgroundOperation,
  runOperation,
} from "./errors";
import { isTauriRuntime } from "./tauriRuntime";

const thumbnailWidth = 160;
const thumbnailHeight = 90;
const maximumCachedThumbnails = 4096;
const extractionTimeoutMs = 5_000;
const videoFramePresentationTimeoutMs = 250;
const defaultThumbnailPriority = Number.MAX_SAFE_INTEGER;

interface StoryboardThumbnailOptions {
  assetId: string;
  fingerprint: string;
  videoPath: string;
  timeUs: number;
  priority?: number;
}

interface ThumbnailJob {
  key: string;
  options: StoryboardThumbnailOptions;
  consumers: Map<number, number>;
  sequence: number;
  settled: boolean;
  promise: Promise<string>;
  resolve: (url: string) => void;
  reject: (error: unknown) => void;
}

interface StoryboardThumbnailCacheLookup {
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

export interface StoryboardThumbnailRequest {
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

function normalizedTimeUs(timeUs: number) {
  return Math.max(0, Math.round(timeUs));
}

function thumbnailKey({ fingerprint, videoPath, timeUs }: StoryboardThumbnailOptions) {
  return `${fingerprint}:${videoPath}:${normalizedTimeUs(timeUs)}`;
}

function cachedThumbnail(options: StoryboardThumbnailOptions) {
  const key = thumbnailKey(options);
  const cached = thumbnailCache.get(key);
  if (!cached || cached.timeUs !== normalizedTimeUs(options.timeUs)) {
    return null;
  }
  thumbnailCache.delete(key);
  thumbnailCache.set(key, cached);
  return cached.url;
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
  return clientError(
    "STORYBOARD_THUMBNAIL_REQUEST_CANCELLED",
    "Storyboard thumbnail request was cancelled",
  );
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
    runBackgroundOperation("thumbnail.storyboard.generate", drainThumbnailQueue);
  });
}

export function requestStoryboardThumbnail(
  options: StoryboardThumbnailOptions,
): StoryboardThumbnailRequest {
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

      const outcome = await runOperation("thumbnail.storyboard.generate", () =>
        extractThumbnail(job.options),
      );
      try {
        if (outcome.status !== "success") {
          job.reject(outcome.status === "failed" ? outcome.error : cancelledError());
          continue;
        }
        const extracted = outcome.value;
        const url = URL.createObjectURL(extracted.blob);
        rememberThumbnail(job.key, url, extracted.timeUs);
        job.resolve(url);
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

async function extractThumbnail(options: StoryboardThumbnailOptions) {
  const tauriRuntime = isTauriRuntime();
  const videoSource = tauriRuntime ? convertFileSrc(options.videoPath) : options.videoPath;
  let extractionTimeUs = normalizedTimeUs(options.timeUs);

  if (tauriRuntime) {
    try {
      const cached = await invokeCommand<StoryboardThumbnailCacheLookup>(
        "get_cached_storyboard_thumbnail",
        {
          assetId: options.assetId,
          timeUs: extractionTimeUs,
        },
      );
      extractionTimeUs = cached.cache_time_us;
      if (cached.bytes) {
        return {
          blob: new Blob([new Uint8Array(cached.bytes)], { type: "image/jpeg" }),
          timeUs: cached.cache_time_us,
        } satisfies ExtractedThumbnail;
      }
    } catch (error) {
      captureOperationError("thumbnail.storyboard.cache.read", error);
      // Cache failures must not prevent the thumbnail from being displayed.
    }
  }

  if (!unsupportedWebViewSources.has(videoSource)) {
    try {
      const blob = await extractThumbnailInWebView(videoSource, extractionTimeUs);
      if (tauriRuntime) {
        void persistStoryboardThumbnail(options.assetId, extractionTimeUs, blob);
      }
      return { blob, timeUs: extractionTimeUs } satisfies ExtractedThumbnail;
    } catch (error) {
      captureOperationError("thumbnail.storyboard.generate", error);
      unsupportedWebViewSources.add(videoSource);
      resetExtractorVideo();
    }
  }

  if (!tauriRuntime) {
    throw clientError(
      "STORYBOARD_THUMBNAIL_BROWSER_UNAVAILABLE",
      "The browser runtime cannot generate storyboard thumbnails",
    );
  }
  const serializedBytes = await invokeCommand<number[]>("generate_storyboard_thumbnail", {
    assetId: options.assetId,
    timeUs: extractionTimeUs,
  });
  return {
    blob: new Blob([new Uint8Array(serializedBytes)], { type: "image/jpeg" }),
    timeUs: extractionTimeUs,
  } satisfies ExtractedThumbnail;
}

async function persistStoryboardThumbnail(assetId: string, timeUs: number, blob: Blob) {
  try {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    await invokeCommand("cache_storyboard_thumbnail", {
      assetId,
      timeUs: normalizedTimeUs(timeUs),
      bytes,
    });
  } catch (error) {
    captureOperationError("thumbnail.storyboard.cache.write", error);
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
      reject(
        clientError(
          "VIDEO_FRAME_DECODE_FAILED",
          `The browser failed to decode the video frame; mediaErrorCode=${video.error?.code ?? 0}`,
        ),
      );
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(
        clientError(
          "VIDEO_FRAME_DECODE_TIMEOUT",
          `Video frame decoding exceeded ${extractionTimeoutMs} milliseconds`,
        ),
      );
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
  await waitForPresentedVideoFrame(video);
}

function waitForPresentedVideoFrame(video: HTMLVideoElement) {
  const frameVideo = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: () => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  if (!frameVideo.requestVideoFrameCallback) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let callbackId: number | undefined;
    const timeoutId = window.setTimeout(() => {
      if (callbackId !== undefined) {
        frameVideo.cancelVideoFrameCallback?.(callbackId);
      }
      resolve();
    }, videoFramePresentationTimeoutMs);
    callbackId = frameVideo.requestVideoFrameCallback(() => {
      window.clearTimeout(timeoutId);
      resolve();
    });
  });
}

function thumbnailBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(
            clientError(
              "STORYBOARD_THUMBNAIL_ENCODE_FAILED",
              "The browser canvas returned an empty storyboard thumbnail blob",
            ),
          );
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
    throw clientError(
      "VIDEO_FRAME_DIMENSIONS_INVALID",
      `Decoded video frame dimensions are invalid: ${video.videoWidth}x${video.videoHeight}`,
    );
  }
  const canvas = canvasElement();
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw clientError(
      "STORYBOARD_THUMBNAIL_CANVAS_UNAVAILABLE",
      "The browser did not provide a 2D canvas context for storyboard thumbnails",
    );
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
