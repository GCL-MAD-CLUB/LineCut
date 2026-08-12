import { convertFileSrc } from "@tauri-apps/api/core";
import { captureOperationError, clientError, invokeCommand } from "./errors";
import { isTauriRuntime } from "./tauriRuntime";
import {
  createTimelineThumbnailManager,
  type ExtractedTimelineThumbnail,
  type TimelineThumbnailOptions,
  type TimelineThumbnailRequest,
} from "./timelineThumbnailManager";
import { frameDurationUs } from "./timeline";
import {
  baseTimelineThumbnailResolution,
  type TimelineThumbnailResolution,
} from "./timelineThumbnailResolution";

const extractionTimeoutMs = 5_000;
const videoFramePresentationTimeoutMs = 250;

interface StoryboardThumbnailOptions extends TimelineThumbnailOptions {
  assetId: string;
  videoPath: string;
  frameRate?: number;
}

interface StoryboardThumbnailCacheLookup {
  cache_time_us: number;
  bytes: number[] | null;
}

const unsupportedWebViewSources = new Set<string>();

let extractorVideo: HTMLVideoElement | null = null;
let extractorCanvas: HTMLCanvasElement | null = null;
let loadedVideoSource = "";

function normalizedTimeUs(timeUs: number) {
  return Math.max(0, Math.round(timeUs));
}

function thumbnailKey(
  { fingerprint, videoPath, timeUs }: StoryboardThumbnailOptions,
  resolution: TimelineThumbnailResolution,
) {
  return `${fingerprint}:${videoPath}:${normalizedTimeUs(timeUs)}:${resolution.width}`;
}

function candidateThumbnailKeys(
  options: StoryboardThumbnailOptions,
  resolution: TimelineThumbnailResolution,
) {
  return [thumbnailKey(options, resolution)];
}

function cachedThumbnailMatches(timeUs: number, options: StoryboardThumbnailOptions) {
  return timeUs === normalizedTimeUs(options.timeUs);
}

const thumbnailManager = createTimelineThumbnailManager<StoryboardThumbnailOptions>({
  operation: "thumbnail.storyboard.generate",
  cancelledError: () =>
    clientError(
      "STORYBOARD_THUMBNAIL_REQUEST_CANCELLED",
      "Storyboard thumbnail request was cancelled",
    ),
  cacheKey: thumbnailKey,
  candidateCacheKeys: candidateThumbnailKeys,
  cacheMatches: cachedThumbnailMatches,
  extract: extractThumbnail,
});

export type StoryboardThumbnailRequest = TimelineThumbnailRequest;

export function requestStoryboardThumbnail(
  options: StoryboardThumbnailOptions,
): StoryboardThumbnailRequest {
  return thumbnailManager.request(options);
}

async function extractThumbnail(
  options: StoryboardThumbnailOptions,
  resolution: TimelineThumbnailResolution,
) {
  const tauriRuntime = isTauriRuntime();
  const videoSource = tauriRuntime ? convertFileSrc(options.videoPath) : options.videoPath;
  let extractionTimeUs = normalizedTimeUs(options.timeUs);
  // Browsers seek to the frame *at or before* currentTime; an exact frame-boundary
  // timestamp can round to the previous frame. Nudge the seek into the frame's
  // display interval so the target frame is shown. The cache still keys on
  // extractionTimeUs (the frame start), which stores exactly this frame.
  const halfFrameUs = options.frameRate ? Math.round(frameDurationUs(options.frameRate) / 2) : 0;

  if (tauriRuntime) {
    try {
      const cached = await invokeCommand<StoryboardThumbnailCacheLookup>(
        "get_cached_storyboard_thumbnail",
        {
          assetId: options.assetId,
          timeUs: extractionTimeUs,
          width: resolution.width,
        },
      );
      extractionTimeUs = cached.cache_time_us;
      if (cached.bytes) {
        return {
          blob: new Blob([new Uint8Array(cached.bytes)], { type: "image/jpeg" }),
          timeUs: cached.cache_time_us,
        } satisfies ExtractedTimelineThumbnail;
      }
    } catch (error) {
      captureOperationError("thumbnail.storyboard.cache.read", error);
      // Cache failures must not prevent the thumbnail from being displayed.
    }
  }

  if (!unsupportedWebViewSources.has(videoSource)) {
    try {
      const blob = await extractThumbnailInWebView(
        videoSource,
        extractionTimeUs + halfFrameUs,
        resolution,
      );
      if (tauriRuntime) {
        void persistStoryboardThumbnail(options.assetId, extractionTimeUs, resolution, blob);
      }
      return { blob, timeUs: extractionTimeUs } satisfies ExtractedTimelineThumbnail;
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
    width: resolution.width,
  });
  return {
    blob: new Blob([new Uint8Array(serializedBytes)], { type: "image/jpeg" }),
    timeUs: extractionTimeUs,
  } satisfies ExtractedTimelineThumbnail;
}

async function persistStoryboardThumbnail(
  assetId: string,
  timeUs: number,
  resolution: TimelineThumbnailResolution,
  blob: Blob,
) {
  try {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    await invokeCommand("cache_storyboard_thumbnail", {
      assetId,
      timeUs: normalizedTimeUs(timeUs),
      width: resolution.width,
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

function canvasElement(resolution: TimelineThumbnailResolution) {
  if (!extractorCanvas) {
    extractorCanvas = document.createElement("canvas");
  }
  if (extractorCanvas.width !== resolution.width || extractorCanvas.height !== resolution.height) {
    extractorCanvas.width = resolution.width;
    extractorCanvas.height = resolution.height;
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

async function extractThumbnailInWebView(
  videoSource: string,
  timeUs: number,
  resolution: TimelineThumbnailResolution,
) {
  const video = videoElement();
  await prepareVideo(video, videoSource);
  await seekVideo(video, timeUs);

  if (video.videoWidth <= 0 || video.videoHeight <= 0) {
    throw clientError(
      "VIDEO_FRAME_DIMENSIONS_INVALID",
      `Decoded video frame dimensions are invalid: ${video.videoWidth}x${video.videoHeight}`,
    );
  }
  const canvas = canvasElement(resolution);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw clientError(
      "STORYBOARD_THUMBNAIL_CANVAS_UNAVAILABLE",
      "The browser did not provide a 2D canvas context for storyboard thumbnails",
    );
  }

  const scale = Math.max(
    resolution.width / video.videoWidth,
    resolution.height / video.videoHeight,
  );
  const sourceWidth = resolution.width / scale;
  const sourceHeight = resolution.height / scale;
  const sourceX = (video.videoWidth - sourceWidth) / 2;
  const sourceY = (video.videoHeight - sourceHeight) / 2;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality =
    resolution.width === baseTimelineThumbnailResolution.width ? "low" : "high";
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    resolution.width,
    resolution.height,
  );
  return thumbnailBlob(canvas);
}
