import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./tauriRuntime";

const thumbnailWidth = 160;
const thumbnailHeight = 90;
const maximumCachedThumbnails = 4096;
const extractionTimeoutMs = 5_000;

interface SubtitleThumbnailOptions {
  assetId: string;
  fingerprint: string;
  videoPath: string;
  timeUs: number;
}

interface ThumbnailJob {
  key: string;
  options: SubtitleThumbnailOptions;
  consumers: number;
  settled: boolean;
  promise: Promise<string>;
  resolve: (url: string) => void;
  reject: (error: unknown) => void;
}

export interface SubtitleThumbnailRequest {
  promise: Promise<string>;
  cancel: () => void;
}

const thumbnailCache = new Map<string, string>();
const pendingJobs = new Map<string, ThumbnailJob>();
const thumbnailQueue: ThumbnailJob[] = [];
const unsupportedWebViewSources = new Set<string>();

let workerRunning = false;
let extractorVideo: HTMLVideoElement | null = null;
let extractorCanvas: HTMLCanvasElement | null = null;
let loadedVideoSource = "";

function thumbnailKey({ fingerprint, timeUs }: SubtitleThumbnailOptions) {
  return `${fingerprint}:${Math.max(0, Math.round(timeUs))}`;
}

function cachedThumbnail(key: string) {
  const url = thumbnailCache.get(key);
  if (!url) {
    return null;
  }
  thumbnailCache.delete(key);
  thumbnailCache.set(key, url);
  return url;
}

function rememberThumbnail(key: string, url: string) {
  const previousUrl = thumbnailCache.get(key);
  if (previousUrl && previousUrl !== url) {
    URL.revokeObjectURL(previousUrl);
  }
  thumbnailCache.delete(key);
  thumbnailCache.set(key, url);

  while (thumbnailCache.size > maximumCachedThumbnails) {
    const oldestKey = thumbnailCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    const oldestUrl = thumbnailCache.get(oldestKey);
    thumbnailCache.delete(oldestKey);
    if (oldestUrl) {
      URL.revokeObjectURL(oldestUrl);
    }
  }
}

function cancelledError() {
  return new DOMException("字幕缩略图请求已取消", "AbortError");
}

export function requestSubtitleThumbnail(
  options: SubtitleThumbnailOptions,
): SubtitleThumbnailRequest {
  const key = thumbnailKey(options);
  const cached = cachedThumbnail(key);
  if (cached) {
    return { promise: Promise.resolve(cached), cancel: () => undefined };
  }

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
      consumers: 1,
      settled: false,
      promise,
      resolve,
      reject,
    };
    pendingJobs.set(key, job);
    thumbnailQueue.push(job);
    void drainThumbnailQueue();
  } else {
    job.consumers += 1;
  }
  let cancelled = false;
  return {
    promise: job.promise,
    cancel: () => {
      if (cancelled || job!.settled) {
        return;
      }
      cancelled = true;
      job!.consumers = Math.max(0, job!.consumers - 1);
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
      const job = thumbnailQueue.shift()!;
      if (job.consumers === 0) {
        pendingJobs.delete(job.key);
        job.settled = true;
        job.reject(cancelledError());
        continue;
      }

      try {
        const blob = await extractThumbnail(job.options);
        const url = URL.createObjectURL(blob);
        rememberThumbnail(job.key, url);
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
  }
}

async function extractThumbnail(options: SubtitleThumbnailOptions) {
  const videoSource = isTauriRuntime() ? convertFileSrc(options.videoPath) : options.videoPath;
  if (!unsupportedWebViewSources.has(videoSource)) {
    try {
      return await extractThumbnailInWebView(videoSource, options.timeUs);
    } catch {
      unsupportedWebViewSources.add(videoSource);
      resetExtractorVideo();
    }
  }

  if (!isTauriRuntime()) {
    throw new Error("浏览器无法生成字幕缩略图");
  }
  const serializedBytes = await invoke<number[]>("generate_subtitle_thumbnail", {
    assetId: options.assetId,
    timeUs: Math.max(0, Math.round(options.timeUs)),
  });
  return new Blob([new Uint8Array(serializedBytes)], { type: "image/jpeg" });
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
      "image/webp",
      0.58,
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
