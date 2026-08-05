import { convertFileSrc } from "@tauri-apps/api/core";
import { captureOperationError, clientError, invokeCommand } from "./errors";
import { isTauriRuntime } from "./tauriRuntime";
import {
  createTimelineThumbnailManager,
  type ExtractedTimelineThumbnail,
  type TimelineThumbnailOptions,
  type TimelineThumbnailRequest,
} from "./timelineThumbnailManager";
import {
  baseTimelineThumbnailResolution,
  type TimelineThumbnailResolution,
} from "./timelineThumbnailResolution";

const extractionTimeoutMs = 5_000;
const thumbnailTimeBucketUs = 100_000;
const thumbnailMatchToleranceUs = 100_000;

interface SubtitleThumbnailOptions extends TimelineThumbnailOptions {
  assetId: string;
  videoPath: string;
}

interface SubtitleThumbnailCacheLookup {
  cache_time_us: number;
  bytes: number[] | null;
}

const unsupportedWebViewSources = new Set<string>();

let extractorVideo: HTMLVideoElement | null = null;
let extractorCanvas: HTMLCanvasElement | null = null;
let loadedVideoSource = "";

function thumbnailBucket(timeUs: number) {
  return Math.round(Math.max(0, timeUs) / thumbnailTimeBucketUs);
}

function thumbnailKeyForBucket(
  fingerprint: string,
  bucket: number,
  resolution: TimelineThumbnailResolution,
) {
  return `${fingerprint}:${bucket}:${resolution.width}`;
}

function thumbnailKey(
  { fingerprint, timeUs }: SubtitleThumbnailOptions,
  resolution: TimelineThumbnailResolution,
) {
  return thumbnailKeyForBucket(fingerprint, thumbnailBucket(timeUs), resolution);
}

function candidateThumbnailKeys(
  options: SubtitleThumbnailOptions,
  resolution: TimelineThumbnailResolution,
) {
  const bucket = thumbnailBucket(options.timeUs);
  return [bucket, bucket - 1, bucket + 1]
    .filter((candidate) => candidate >= 0)
    .sort(
      (left, right) =>
        Math.abs(left * thumbnailTimeBucketUs - options.timeUs) -
        Math.abs(right * thumbnailTimeBucketUs - options.timeUs),
    )
    .map((candidate) => thumbnailKeyForBucket(options.fingerprint, candidate, resolution));
}

function cachedThumbnailMatches(timeUs: number, options: SubtitleThumbnailOptions) {
  return Math.abs(timeUs - Math.max(0, options.timeUs)) <= thumbnailMatchToleranceUs;
}

const thumbnailManager = createTimelineThumbnailManager<SubtitleThumbnailOptions>({
  operation: "thumbnail.subtitle.generate",
  cancelledError: () =>
    clientError("SUBTITLE_THUMBNAIL_REQUEST_CANCELLED", "Subtitle thumbnail request was cancelled"),
  cacheKey: thumbnailKey,
  candidateCacheKeys: candidateThumbnailKeys,
  cacheMatches: cachedThumbnailMatches,
  extract: extractThumbnail,
});

export type SubtitleThumbnailRequest = TimelineThumbnailRequest;

export function requestSubtitleThumbnail(
  options: SubtitleThumbnailOptions,
): SubtitleThumbnailRequest {
  return thumbnailManager.request(options);
}

async function extractThumbnail(
  options: SubtitleThumbnailOptions,
  resolution: TimelineThumbnailResolution,
) {
  const tauriRuntime = isTauriRuntime();
  const videoSource = tauriRuntime ? convertFileSrc(options.videoPath) : options.videoPath;
  let extractionTimeUs = options.timeUs;

  if (tauriRuntime) {
    try {
      const cached = await invokeCommand<SubtitleThumbnailCacheLookup>(
        "get_cached_subtitle_thumbnail",
        {
          assetId: options.assetId,
          timeUs: Math.max(0, Math.round(options.timeUs)),
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
      captureOperationError("thumbnail.subtitle.cache.read", error);
      // Cache failures must not prevent the thumbnail from being displayed.
    }
  }

  if (!unsupportedWebViewSources.has(videoSource)) {
    try {
      const blob = await extractThumbnailInWebView(videoSource, extractionTimeUs, resolution);
      if (tauriRuntime) {
        void persistSubtitleThumbnail(options.assetId, extractionTimeUs, resolution, blob);
      }
      return { blob, timeUs: extractionTimeUs } satisfies ExtractedTimelineThumbnail;
    } catch (error) {
      captureOperationError("thumbnail.subtitle.generate", error);
      unsupportedWebViewSources.add(videoSource);
      resetExtractorVideo();
    }
  }

  if (!tauriRuntime) {
    throw clientError(
      "SUBTITLE_THUMBNAIL_BROWSER_UNAVAILABLE",
      "The browser runtime cannot generate subtitle thumbnails",
    );
  }
  const serializedBytes = await invokeCommand<number[]>("generate_subtitle_thumbnail", {
    assetId: options.assetId,
    timeUs: Math.max(0, Math.round(extractionTimeUs)),
    width: resolution.width,
  });
  return {
    blob: new Blob([new Uint8Array(serializedBytes)], { type: "image/jpeg" }),
    timeUs: extractionTimeUs,
  } satisfies ExtractedTimelineThumbnail;
}

async function persistSubtitleThumbnail(
  assetId: string,
  timeUs: number,
  resolution: TimelineThumbnailResolution,
  blob: Blob,
) {
  try {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    await invokeCommand("cache_subtitle_thumbnail", {
      assetId,
      timeUs: Math.max(0, Math.round(timeUs)),
      width: resolution.width,
      bytes,
    });
  } catch (error) {
    captureOperationError("thumbnail.subtitle.cache.write", error);
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
              "SUBTITLE_THUMBNAIL_ENCODE_FAILED",
              "The browser canvas returned an empty subtitle thumbnail blob",
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
      "SUBTITLE_THUMBNAIL_CANVAS_UNAVAILABLE",
      "The browser did not provide a 2D canvas context for subtitle thumbnail rendering",
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
