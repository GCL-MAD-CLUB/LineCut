import { convertFileSrc } from "@tauri-apps/api/core";
import { captureOperationError, clientError, invokeCommand } from "../errors";
import { isTauriRuntime } from "../tauriRuntime";
import { frameDurationUs } from "../timeline";
import {
  createTimelineThumbnailManager,
  type ExtractedTimelineThumbnail,
  type TimelineThumbnailOptions,
  type TimelineThumbnailRequest,
  type TimelineThumbnailWarmRequest,
} from "./manager";
import { baseTimelineThumbnailResolution, type TimelineThumbnailResolution } from "./resolution";

const extractionTimeoutMs = 5_000;
const backendHedgeDelayMs = 250;
const thumbnailCacheWriteDelayMs = 1_000;
const videoFramePresentationTimeoutMs = 250;

export type TimelineThumbnailKind = "subtitle" | "storyboard";

export interface TimelineThumbnailRequestOptions extends TimelineThumbnailOptions {
  kind: TimelineThumbnailKind;
  assetId: string;
  videoPath: string;
  frameRate?: number;
}

export interface TimelineThumbnailPlaceholder {
  url: string;
  width: number;
  height: number;
}

interface TimelineThumbnailProviderConfiguration {
  kind: TimelineThumbnailKind;
  cacheKey: (
    options: TimelineThumbnailRequestOptions,
    resolution: TimelineThumbnailResolution,
  ) => string;
  cacheGroupKey: (options: TimelineThumbnailRequestOptions, timeUs: number) => string;
  candidateCacheKeys: (
    options: TimelineThumbnailRequestOptions,
    resolution: TimelineThumbnailResolution,
  ) => string[];
  cacheMatches: (timeUs: number, options: TimelineThumbnailRequestOptions) => boolean;
  initialTimeUs: (options: TimelineThumbnailRequestOptions) => number;
  browserSeekTimeUs?: (
    options: TimelineThumbnailRequestOptions,
    extractionTimeUs: number,
  ) => number;
}

interface TimelineThumbnailProvider {
  request: (options: TimelineThumbnailRequestOptions) => TimelineThumbnailRequest;
  warm: (options: TimelineThumbnailRequestOptions) => TimelineThumbnailWarmRequest;
  peek: (
    options: TimelineThumbnailRequestOptions,
    resolution: TimelineThumbnailResolution,
  ) => TimelineThumbnailPlaceholder | null;
}

type ThumbnailBinaryResponse = ArrayBuffer | Uint8Array | number[];

interface TimelineThumbnailBatch {
  cache_time_us: number;
  jpegs: Array<Uint8Array<ArrayBuffer> | null>;
}

interface ThumbnailExtractorSlot {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  source: string;
}

const thumbnailProviderDefinitions = {
  subtitle: {
    operations: {
      cacheRead: "thumbnail.subtitle.cache.read",
      cacheWrite: "thumbnail.subtitle.cache.write",
      generate: "thumbnail.subtitle.generate",
    },
    commands: {
      cacheRead: "get_cached_subtitle_thumbnails",
      cacheWrite: "cache_subtitle_thumbnail",
      generate: "generate_subtitle_thumbnails",
    },
    cancelledError: () =>
      clientError(
        "SUBTITLE_THUMBNAIL_REQUEST_CANCELLED",
        "Subtitle thumbnail request was cancelled",
      ),
    browserUnavailableError: () =>
      clientError(
        "SUBTITLE_THUMBNAIL_BROWSER_UNAVAILABLE",
        "The browser runtime cannot generate subtitle thumbnails",
      ),
    encodeError: () =>
      clientError(
        "SUBTITLE_THUMBNAIL_ENCODE_FAILED",
        "The browser canvas returned an empty subtitle thumbnail blob",
      ),
    canvasError: () =>
      clientError(
        "SUBTITLE_THUMBNAIL_CANVAS_UNAVAILABLE",
        "The browser did not provide a 2D canvas context for subtitle thumbnail rendering",
      ),
  },
  storyboard: {
    operations: {
      cacheRead: "thumbnail.storyboard.cache.read",
      cacheWrite: "thumbnail.storyboard.cache.write",
      generate: "thumbnail.storyboard.generate",
    },
    commands: {
      cacheRead: "get_cached_storyboard_thumbnails",
      cacheWrite: "cache_storyboard_thumbnail",
      generate: "generate_storyboard_thumbnails",
    },
    cancelledError: () =>
      clientError(
        "STORYBOARD_THUMBNAIL_REQUEST_CANCELLED",
        "Storyboard thumbnail request was cancelled",
      ),
    browserUnavailableError: () =>
      clientError(
        "STORYBOARD_THUMBNAIL_BROWSER_UNAVAILABLE",
        "The browser runtime cannot generate storyboard thumbnails",
      ),
    encodeError: () =>
      clientError(
        "STORYBOARD_THUMBNAIL_ENCODE_FAILED",
        "The browser canvas returned an empty storyboard thumbnail blob",
      ),
    canvasError: () =>
      clientError(
        "STORYBOARD_THUMBNAIL_CANVAS_UNAVAILABLE",
        "The browser did not provide a 2D canvas context for storyboard thumbnails",
      ),
  },
} as const;

type TimelineThumbnailProviderDefinition =
  (typeof thumbnailProviderDefinitions)[TimelineThumbnailKind];

const thumbnailExtractorSlots: ThumbnailExtractorSlot[] = [];
const occupiedExtractorSlots = new Set<ThumbnailExtractorSlot>();

function normalizeTimelineThumbnailTimeUs(timeUs: number) {
  return Math.max(0, Math.round(timeUs));
}

function createTimelineThumbnailProvider({
  kind,
  cacheKey,
  cacheGroupKey,
  candidateCacheKeys,
  cacheMatches,
  initialTimeUs,
  browserSeekTimeUs,
}: TimelineThumbnailProviderConfiguration): TimelineThumbnailProvider {
  const definition = thumbnailProviderDefinitions[kind];
  const backendPreferredSources = new Set<string>();
  const thumbnailManager = createTimelineThumbnailManager<TimelineThumbnailRequestOptions>({
    operation: definition.operations.generate,
    cancelledError: definition.cancelledError,
    cacheKey,
    cacheGroupKey,
    candidateCacheKeys,
    cacheMatches,
    extract: extractThumbnail,
  });

  return {
    request: (options) => thumbnailManager.request(options),
    warm: (options) => thumbnailManager.warm(options),
    peek: (options, resolution) => {
      const result = thumbnailManager.peek(options, resolution);
      return result
        ? { url: result.url, width: result.resolution.width, height: result.resolution.height }
        : null;
    },
  };

  async function extractThumbnail(
    options: TimelineThumbnailRequestOptions,
    resolutions: TimelineThumbnailResolution[],
    workerCount: number,
  ): Promise<ExtractedTimelineThumbnail[]> {
    const tauriRuntime = isTauriRuntime();
    const videoSource = tauriRuntime ? convertFileSrc(options.videoPath) : options.videoPath;
    let extractionTimeUs = initialTimeUs(options);
    const results: ExtractedTimelineThumbnail[] = [];
    const missing: TimelineThumbnailResolution[] = [];

    if (tauriRuntime) {
      try {
        const batch = await invokeCommand<ThumbnailBinaryResponse>(definition.commands.cacheRead, {
          assetId: options.assetId,
          timeUs: normalizeTimelineThumbnailTimeUs(extractionTimeUs),
          widths: resolutions.map((resolution) => resolution.width),
        });
        const parsed = parseThumbnailBatch(batch);
        extractionTimeUs = parsed.cache_time_us;
        resolutions.forEach((resolution, index) => {
          const jpeg = parsed.jpegs[index];
          if (jpeg) {
            results.push({
              blob: new Blob([jpeg], { type: "image/jpeg" }),
              timeUs: parsed.cache_time_us,
              resolution,
            } satisfies ExtractedTimelineThumbnail);
          } else {
            missing.push(resolution);
          }
        });
      } catch (error) {
        captureOperationError(definition.operations.cacheRead, error);
        // Cache failures must not prevent the thumbnail from being displayed.
        missing.push(...resolutions);
      }
    } else {
      missing.push(...resolutions);
    }

    if (missing.length > 0 && !backendPreferredSources.has(videoSource)) {
      let extractionSettled = false;
      let startBackend!: () => void;
      let backendTimer: number | undefined;
      const backendGate = new Promise<void>((resolve) => {
        startBackend = resolve;
        if (tauriRuntime) {
          backendTimer = window.setTimeout(resolve, backendHedgeDelayMs);
        }
      });
      const seekTimeUs = browserSeekTimeUs?.(options, extractionTimeUs) ?? extractionTimeUs;
      const webViewAttempt = extractThumbnailsInWebView(
        videoSource,
        seekTimeUs,
        missing,
        definition,
      ).then((produced) => {
        if (!extractionSettled && tauriRuntime) {
          for (const item of produced) {
            void persistThumbnail(
              definition,
              options.assetId,
              extractionTimeUs,
              item.resolution,
              item.blob,
            );
          }
        }
        return produced;
      });

      if (!tauriRuntime) {
        try {
          const produced = await webViewAttempt;
          results.push(...produced.map((item) => ({ ...item, timeUs: extractionTimeUs })));
          return results;
        } catch (error) {
          captureOperationError(definition.operations.generate, error);
          backendPreferredSources.add(videoSource);
        }
      } else {
        const guardedWebViewAttempt = webViewAttempt.catch((error) => {
          if (!extractionSettled) {
            captureOperationError(definition.operations.generate, error);
          }
          backendPreferredSources.add(videoSource);
          if (backendTimer !== undefined) {
            window.clearTimeout(backendTimer);
          }
          startBackend();
          return Promise.reject(error);
        });
        const backendAttempt = backendGate.then(() =>
          generateThumbnails(definition, options.assetId, extractionTimeUs, missing, workerCount),
        );
        try {
          const winner = await Promise.any([
            guardedWebViewAttempt.then((produced) => ({ producer: "webview" as const, produced })),
            backendAttempt.then((produced) => ({ producer: "backend" as const, produced })),
          ]);
          extractionSettled = true;
          if (winner.producer === "backend") {
            backendPreferredSources.add(videoSource);
          }
          results.push(...winner.produced.map((item) => ({ ...item, timeUs: extractionTimeUs })));
          return results;
        } finally {
          if (backendTimer !== undefined) {
            window.clearTimeout(backendTimer);
          }
        }
      }
    }

    if (missing.length > 0) {
      if (!tauriRuntime) {
        return Promise.reject(definition.browserUnavailableError());
      }
      const produced = await generateThumbnails(
        definition,
        options.assetId,
        extractionTimeUs,
        missing,
        workerCount,
      );
      results.push(...produced.map((item) => ({ ...item, timeUs: extractionTimeUs })));
    }

    return results;
  }
}

function responseBytes(response: ThumbnailBinaryResponse): Uint8Array<ArrayBuffer> {
  if (response instanceof ArrayBuffer) {
    return new Uint8Array(response);
  }
  if (response instanceof Uint8Array) {
    return new Uint8Array(response);
  }
  return Uint8Array.from(response);
}

function parseThumbnailBatch(response: ThumbnailBinaryResponse): TimelineThumbnailBatch {
  const bytes = responseBytes(response);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jpegs: Array<Uint8Array<ArrayBuffer> | null> = [];
  let offset = 8;
  while (offset < bytes.byteLength) {
    const present = bytes[offset];
    offset += 1;
    if (present) {
      const length = view.getUint32(offset, true);
      offset += 4;
      jpegs.push(bytes.slice(offset, offset + length));
      offset += length;
    } else {
      jpegs.push(null);
    }
  }
  return { cache_time_us: Number(view.getBigInt64(0, true)), jpegs };
}

function parseGeneratedThumbnails(response: ThumbnailBinaryResponse): Uint8Array<ArrayBuffer>[] {
  const bytes = responseBytes(response);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jpegs: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset, true);
    offset += 4;
    jpegs.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  return jpegs;
}

async function generateThumbnails(
  definition: TimelineThumbnailProviderDefinition,
  assetId: string,
  timeUs: number,
  resolutions: TimelineThumbnailResolution[],
  workerCount: number,
) {
  const generated = await invokeCommand<ThumbnailBinaryResponse>(definition.commands.generate, {
    assetId,
    timeUs: normalizeTimelineThumbnailTimeUs(timeUs),
    widths: resolutions.map((resolution) => resolution.width),
    workerCount,
  });
  const jpegs = parseGeneratedThumbnails(generated);
  return resolutions.map((resolution, index) => ({
    blob: new Blob([jpegs[index]], { type: "image/jpeg" }),
    resolution,
  }));
}

async function persistThumbnail(
  definition: TimelineThumbnailProviderDefinition,
  assetId: string,
  timeUs: number,
  resolution: TimelineThumbnailResolution,
  blob: Blob,
) {
  try {
    await new Promise((resolve) => window.setTimeout(resolve, thumbnailCacheWriteDelayMs));
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    await invokeCommand(definition.commands.cacheWrite, {
      assetId,
      timeUs: normalizeTimelineThumbnailTimeUs(timeUs),
      width: resolution.width,
      bytes,
    });
  } catch (error) {
    captureOperationError(definition.operations.cacheWrite, error);
    // Persistence is best effort; the in-memory thumbnail remains usable.
  }
}

function createExtractorSlot(): ThumbnailExtractorSlot {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  return { video, canvas: document.createElement("canvas"), source: "" };
}

function acquireExtractorSlot(): ThumbnailExtractorSlot {
  let slot = thumbnailExtractorSlots.find((candidate) => !occupiedExtractorSlots.has(candidate));
  if (!slot) {
    slot = createExtractorSlot();
    thumbnailExtractorSlots.push(slot);
  }
  occupiedExtractorSlots.add(slot);
  return slot;
}

function releaseExtractorSlot(slot: ThumbnailExtractorSlot) {
  occupiedExtractorSlots.delete(slot);
}

function resetVideo(slot: ThumbnailExtractorSlot) {
  slot.video.pause();
  slot.video.removeAttribute("src");
  slot.video.load();
  slot.source = "";
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

async function prepareVideo(slot: ThumbnailExtractorSlot, source: string) {
  if (slot.source === source && slot.video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return;
  }

  resetVideo(slot);
  const ready = waitForVideoEvent(slot.video, ["loadedmetadata"]);
  slot.video.src = source;
  slot.video.load();
  await ready;
  slot.source = source;
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

async function extractThumbnailsInWebView(
  videoSource: string,
  seekTimeUs: number,
  resolutions: TimelineThumbnailResolution[],
  definition: TimelineThumbnailProviderDefinition,
): Promise<Array<{ blob: Blob; resolution: TimelineThumbnailResolution }>> {
  const slot = acquireExtractorSlot();
  try {
    await prepareVideo(slot, videoSource);
    await seekVideo(slot.video, seekTimeUs);

    if (slot.video.videoWidth <= 0 || slot.video.videoHeight <= 0) {
      throw clientError(
        "VIDEO_FRAME_DIMENSIONS_INVALID",
        `Decoded video frame dimensions are invalid: ${slot.video.videoWidth}x${slot.video.videoHeight}`,
      );
    }

    const results: Array<{ blob: Blob; resolution: TimelineThumbnailResolution }> = [];
    for (const resolution of resolutions) {
      results.push({
        blob: await drawThumbnailBlob(slot, resolution, definition),
        resolution,
      });
    }
    return results;
  } catch (error) {
    resetVideo(slot);
    return Promise.reject(error);
  } finally {
    releaseExtractorSlot(slot);
  }
}

async function drawThumbnailBlob(
  slot: ThumbnailExtractorSlot,
  resolution: TimelineThumbnailResolution,
  definition: TimelineThumbnailProviderDefinition,
) {
  const video = slot.video;
  const canvas = slot.canvas;
  if (canvas.width !== resolution.width || canvas.height !== resolution.height) {
    canvas.width = resolution.width;
    canvas.height = resolution.height;
  }
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    return Promise.reject(definition.canvasError());
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
  return thumbnailBlob(canvas, definition);
}

function thumbnailBlob(canvas: HTMLCanvasElement, definition: TimelineThumbnailProviderDefinition) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(definition.encodeError());
        }
      },
      "image/jpeg",
      0.68,
    );
  });
}

const subtitleThumbnailTimeBucketUs = 100_000;
const subtitleThumbnailMatchToleranceUs = 100_000;

function subtitleThumbnailBucket(timeUs: number) {
  return Math.round(Math.max(0, timeUs) / subtitleThumbnailTimeBucketUs);
}

function subtitleThumbnailKeyForBucket(
  fingerprint: string,
  bucket: number,
  resolution: TimelineThumbnailResolution,
) {
  return `${fingerprint}:${bucket}:${resolution.width}`;
}

const subtitleThumbnailProvider = createTimelineThumbnailProvider({
  kind: "subtitle",
  cacheKey: ({ fingerprint, timeUs }, resolution) =>
    subtitleThumbnailKeyForBucket(fingerprint, subtitleThumbnailBucket(timeUs), resolution),
  cacheGroupKey: ({ fingerprint }, timeUs) => `${fingerprint}:${subtitleThumbnailBucket(timeUs)}`,
  candidateCacheKeys: ({ fingerprint, timeUs }, resolution) => {
    const bucket = subtitleThumbnailBucket(timeUs);
    return [bucket, bucket - 1, bucket + 1]
      .filter((candidate) => candidate >= 0)
      .sort(
        (left, right) =>
          Math.abs(left * subtitleThumbnailTimeBucketUs - timeUs) -
          Math.abs(right * subtitleThumbnailTimeBucketUs - timeUs),
      )
      .map((candidate) => subtitleThumbnailKeyForBucket(fingerprint, candidate, resolution));
  },
  cacheMatches: (timeUs, options) =>
    Math.abs(timeUs - Math.max(0, options.timeUs)) <= subtitleThumbnailMatchToleranceUs,
  initialTimeUs: (options) => options.timeUs,
});

function storyboardThumbnailKey(
  { fingerprint, videoPath, timeUs }: TimelineThumbnailRequestOptions,
  resolution: TimelineThumbnailResolution,
) {
  return `${fingerprint}:${videoPath}:${normalizeTimelineThumbnailTimeUs(timeUs)}:${resolution.width}`;
}

const storyboardThumbnailProvider = createTimelineThumbnailProvider({
  kind: "storyboard",
  cacheKey: storyboardThumbnailKey,
  cacheGroupKey: ({ fingerprint, videoPath }, timeUs) =>
    `${fingerprint}:${videoPath}:${normalizeTimelineThumbnailTimeUs(timeUs)}`,
  candidateCacheKeys: (options, resolution) => [storyboardThumbnailKey(options, resolution)],
  cacheMatches: (timeUs, options) => timeUs === normalizeTimelineThumbnailTimeUs(options.timeUs),
  initialTimeUs: (options) => normalizeTimelineThumbnailTimeUs(options.timeUs),
  // Exact frame-boundary seeks can round to the previous frame. Seek into the
  // target frame's display interval while retaining the frame-start cache key.
  browserSeekTimeUs: (options, extractionTimeUs) =>
    extractionTimeUs + (options.frameRate ? Math.round(frameDurationUs(options.frameRate) / 2) : 0),
});

function providerFor(kind: TimelineThumbnailKind) {
  return kind === "subtitle" ? subtitleThumbnailProvider : storyboardThumbnailProvider;
}

export const timelineThumbnails = {
  request(options: TimelineThumbnailRequestOptions): TimelineThumbnailRequest {
    return providerFor(options.kind).request(options);
  },
  warm(options: TimelineThumbnailRequestOptions): TimelineThumbnailWarmRequest {
    return providerFor(options.kind).warm(options);
  },
  peek(options: TimelineThumbnailRequestOptions): TimelineThumbnailPlaceholder | null {
    return providerFor(options.kind).peek(
      options,
      options.resolution ?? baseTimelineThumbnailResolution,
    );
  },
};
