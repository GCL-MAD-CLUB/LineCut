import { clientError } from "../../errors/model";
import { TRACE_WIDTH, TRACE_HEIGHT, type PlaybackTraceSample } from "../../core/editor/frameTrace";
import type { FrameTraceCache } from "./frameTraceCache";

export interface FrameTraceData {
  motion: number[];
  colors: number[][];
  sharpness: number[];
}

export function createTraceCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = TRACE_WIDTH;
  canvas.height = TRACE_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context)
    throw clientError(
      "STORYBOARD_THUMBNAIL_CANVAS_UNAVAILABLE",
      "Frame trace canvas is unavailable",
    );
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return { canvas, context };
}

export function readTracePixels(context: CanvasRenderingContext2D, video: HTMLVideoElement) {
  context.drawImage(video, 0, 0, TRACE_WIDTH, TRACE_HEIGHT);
  return context.getImageData(0, 0, TRACE_WIDTH, TRACE_HEIGHT).data;
}

function aborted() {
  return clientError("BROWSER_ABORTED", "Browser frame trace analysis was cancelled");
}

function waitForVideo(
  video: HTMLVideoElement,
  event: string,
  signal: AbortSignal,
  start: () => void,
) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(aborted());
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener(event, ready);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", cancelled);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(
        clientError(
          "VIDEO_FRAME_DECODE_FAILED",
          "The browser could not decode the frame trace source",
        ),
      );
    };
    const cancelled = () => {
      cleanup();
      reject(aborted());
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(clientError("VIDEO_FRAME_DECODE_TIMEOUT", "Browser frame trace decoding timed out"));
    }, 15_000);
    video.addEventListener(event, ready, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", cancelled, { once: true });
    try {
      start();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

interface TraceJob {
  controller: AbortController;
  result: Promise<FrameTraceData>;
  consumers: number;
}
const jobs = new WeakMap<FrameTraceCache, Map<string, TraceJob>>();

export function decodeBrowserFrameTrace(
  source: string,
  frameRate: number,
  startFrame: number,
  endFrame: number,
  signal: AbortSignal,
  cache?: FrameTraceCache,
): Promise<FrameTraceData> {
  if (signal.aborted) return Promise.reject(aborted());
  if (!cache) return decodeTrace(source, frameRate, startFrame, endFrame, signal);
  let active = jobs.get(cache);
  if (!active) {
    active = new Map();
    jobs.set(cache, active);
  }
  const key = JSON.stringify([source, frameRate, startFrame, endFrame]);
  let job = active.get(key);
  if (!job) {
    const controller = new AbortController();
    job = {
      controller,
      consumers: 0,
      result: decodeTrace(source, frameRate, startFrame, endFrame, controller.signal, cache),
    };
    active.set(key, job);
  }
  const current = job;
  current.consumers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener("abort", cancel);
      if (--current.consumers === 0) {
        if (active.get(key) === current) active.delete(key);
        current.controller.abort();
      }
      return true;
    };
    const cancel = () => {
      if (finish()) reject(aborted());
    };
    signal.addEventListener("abort", cancel, { once: true });
    current.result.then(
      (data) => {
        if (finish()) resolve(data);
      },
      (error) => {
        if (finish()) reject(error);
      },
    );
  });
}

async function decodeTrace(
  source: string,
  frameRate: number,
  startFrame: number,
  endFrame: number,
  signal: AbortSignal,
  cache?: FrameTraceCache,
): Promise<FrameTraceData> {
  if (signal.aborted)
    throw clientError("BROWSER_ABORTED", "Browser frame trace analysis was cancelled");
  const cached = cache?.complete(startFrame, endFrame);
  if (cached) return cached;
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  const { context } = createTraceCanvas();
  const worker = new Worker(new URL("./frameTraceWorker.ts", import.meta.url), { type: "module" });
  let pending: {
    resolve: (sample: PlaybackTraceSample) => void;
    reject: (error: unknown) => void;
  } | null = null;
  let workerError: ReturnType<typeof clientError> | undefined;
  const lifetime = new AbortController();
  const cancel = () => {
    lifetime.abort();
    pending?.reject(aborted());
  };
  const fail = (error: ReturnType<typeof clientError>) => {
    workerError = error;
    pending?.reject(error);
  };
  worker.onmessage = ({ data }) => {
    if (data.kind === "result") pending?.resolve(data.sample);
    else fail(clientError("VIDEO_FRAME_DECODE_FAILED", data.message));
    pending = null;
  };
  worker.onerror = (event) => {
    event.preventDefault();
    fail(
      clientError(
        "VIDEO_FRAME_DECODE_FAILED",
        event.message || "Browser frame trace worker failed",
      ),
    );
  };
  worker.onmessageerror = () =>
    fail(
      clientError("VIDEO_FRAME_DECODE_FAILED", "Browser frame trace worker response was invalid"),
    );
  signal.addEventListener("abort", cancel);
  const data: FrameTraceData = { motion: [], colors: [], sharpness: [] };
  let previousFrame: number | null = null;
  const releaseCache = cache?.retain();
  async function seek(frame: number) {
    const target = Math.max(0, Math.min((frame + 0.125) / frameRate, video.duration - 0.001));
    if (Math.abs(video.currentTime - target) > 0.000001) {
      await waitForVideo(video, "seeked", lifetime.signal, () => {
        video.currentTime = target;
      });
    }
  }
  async function analyze(frame: number, nextFrame?: number) {
    if (signal.aborted)
      throw clientError("BROWSER_ABORTED", "Browser frame trace analysis was cancelled");
    if (workerError) throw clientError("VIDEO_FRAME_DECODE_FAILED", workerError.message);
    await seek(frame);
    const pixels = readTracePixels(context, video);
    const analysis = new Promise<PlaybackTraceSample>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(clientError("VIDEO_FRAME_DECODE_TIMEOUT", "Frame trace worker timed out")),
        15_000,
      );
      pending = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      try {
        worker.postMessage({ frame, generation: 0, pixels }, [pixels.buffer]);
      } catch (error) {
        pending.reject(error);
      }
    });
    // Decode the next frame while this frame's pixels are analyzed off-thread.
    // Both promises are observed immediately, including cancellation failures.
    const [sample] = await Promise.all([
      analysis.then((sample) => {
        cache?.put(sample);
        return sample;
      }),
      nextFrame === undefined ? undefined : seek(nextFrame),
    ]);
    previousFrame = frame;
    return sample;
  }
  try {
    await waitForVideo(video, "loadeddata", lifetime.signal, () => {
      video.src = source;
      video.load();
    });
    for (let frame = startFrame; frame <= endFrame; frame++) {
      if (signal.aborted)
        throw clientError("BROWSER_ABORTED", "Browser frame trace analysis was cancelled");
      let sample = cache?.get(frame);
      if (!sample || (frame > startFrame && sample.motion === null)) {
        // Seek only missing samples, decoding the predecessor once at each gap.
        // Successfully computed frames survive cancellation and shot changes.
        if (frame > startFrame && previousFrame !== frame - 1) await analyze(frame - 1, frame);
        const next = frame < endFrame && !cache?.has(frame + 1, true) ? frame + 1 : undefined;
        sample = await analyze(frame, next);
      }
      data.colors.push([...sample.colors]);
      data.sharpness.push(sample.sharpness);
      if (frame > startFrame) {
        if (sample.motion === null)
          throw clientError(
            "VIDEO_FRAME_DECODE_FAILED",
            "Browser frame trace is missing an adjacent frame comparison",
          );
        data.motion.push(sample.motion);
      }
    }
    return data;
  } finally {
    cancel();
    pending = null;
    releaseCache?.();
    signal.removeEventListener("abort", cancel);
    worker.terminate();
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}
