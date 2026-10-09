import { useEffect, useRef, type RefObject } from "react";
import { captureOperationError } from "../../../../errors";
import { type PlaybackTraceSample } from "../../../../core/editor/frameTrace";
import { timeUsToFrame } from "../../../../core/editor/timeline";
import type {
  FrameTraceWorkerResponse,
  FrameTraceWorkerRequest,
} from "../../../../application/media/frameTraceWorker";
import {
  createTraceCanvas,
  readTracePixels,
} from "../../../../application/media/browserFrameTrace";
import { getFrameTraceCache } from "../../../../application/media/frameTraceCache";

export function useVideoFrameTrace(
  videoRef: RefObject<HTMLVideoElement | null>,
  sourceKey: number | null,
  frameRate: number,
  enabled: boolean,
  onSample: (sample: PlaybackTraceSample | null) => void,
  cacheKey?: string,
) {
  const callback = useRef(onSample);
  callback.current = onSample;
  useEffect(() => {
    callback.current(null);
    const video = videoRef.current;
    if (!enabled || !video || sourceKey === null) return;
    const { context } = createTraceCanvas();
    let disposed = false;
    let failed = false;
    let busy = false;
    let generation = 0;
    let lastFrame = -1;
    let handle: number | null = null;
    let animationHandle: number | null = null;
    let lastPresentationAt = -Infinity;
    let worker: Worker | undefined;
    let pending: FrameTraceWorkerRequest | null = null;
    let previousPresented: { frame: number; pixels: Uint8ClampedArray } | null = null;
    let workerFrame: number | null = null;
    let workerGeneration = -1;
    const cache = cacheKey ? getFrameTraceCache(cacheKey) : null;
    const releaseCache = cache?.retain();
    function send(input: FrameTraceWorkerRequest) {
      // The worker already owns its preceding frame in the uninterrupted case.
      if (workerGeneration === input.generation && workerFrame === input.frame - 1) {
        input.previousPixels = undefined;
        input.previousFrame = undefined;
      }
      const buffers = [input.pixels.buffer];
      if (input.previousPixels) buffers.push(input.previousPixels.buffer);
      worker!.postMessage(input, buffers);
      busy = true;
    }
    function fail(error: unknown) {
      if (disposed || failed) return;
      failed = true;
      worker?.terminate();
      callback.current(null);
      captureOperationError("storyboard.trace", error);
    }
    try {
      worker = new Worker(new URL("./frameTraceWorker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      fail(error);
      releaseCache?.();
      return;
    }
    worker.onmessage = ({ data }: MessageEvent<FrameTraceWorkerResponse>) => {
      if (disposed || failed) return;
      busy = false;
      if (data.kind === "error") return fail(data.message);
      workerFrame = data.sample.frame;
      workerGeneration = data.generation;
      if (data.generation === generation && !video.seeking) {
        cache?.put(data.sample);
        callback.current(data.sample);
      }
      if (pending && !video.seeking) {
        const next = pending;
        pending = null;
        send(next);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(event.message || "Frame trace worker failed");
    };
    worker.onmessageerror = () => fail("Frame trace worker response could not be decoded");
    function sample(mediaTime: number) {
      if (
        disposed ||
        failed ||
        !context ||
        video!.seeking ||
        video!.readyState < 2 ||
        !video!.videoWidth
      )
        return;
      const frame = timeUsToFrame(mediaTime * 1_000_000, frameRate);
      if (frame === lastFrame) return;
      try {
        if (cache?.has(frame, frame > 0)) {
          lastFrame = frame;
          pending = null;
          // Retain pixels at the cached/uncached boundary, so the next frame
          // still obtains its adjacent comparison without decoding cached runs.
          previousPresented = cache.has(frame + 1, true)
            ? null
            : { frame, pixels: readTracePixels(context, video!) };
          return;
        }
        const pixels = readTracePixels(context, video!);
        const previous = previousPresented?.frame === frame - 1 ? previousPresented : null;
        const input = {
          frame,
          generation,
          pixels,
          previousFrame: previous?.frame,
          previousPixels: previous?.pixels,
        };
        previousPresented = { frame, pixels: pixels.slice() };
        if (busy) {
          pending = input;
        } else {
          send(input);
        }
        lastFrame = frame;
      } catch (error) {
        fail(error);
      }
    }
    function watch() {
      if (disposed || failed || !video?.requestVideoFrameCallback) return;
      handle = video.requestVideoFrameCallback((_now, metadata) => {
        lastPresentationAt = performance.now();
        sample(metadata.mediaTime);
        watch();
      });
    }
    function fallback() {
      sample(video!.currentTime);
    }
    function timeUpdate() {
      // Some WebViews expose rVFC without delivering callbacks during playback.
      if (performance.now() - lastPresentationAt > 250) fallback();
    }
    function pollPlayback() {
      if (disposed || failed) return;
      if (!video!.paused) timeUpdate();
      animationHandle = requestAnimationFrame(pollPlayback);
    }
    function seeking() {
      generation++;
      lastFrame = -1;
      pending = null;
    }
    video.addEventListener("seeking", seeking);
    video.addEventListener("seeked", fallback);
    video.addEventListener("loadeddata", fallback);
    video.addEventListener("playing", fallback);
    video.addEventListener("timeupdate", timeUpdate);
    fallback();
    watch();
    if (typeof requestAnimationFrame === "function")
      animationHandle = requestAnimationFrame(pollPlayback);
    return () => {
      disposed = true;
      releaseCache?.();
      worker?.terminate();
      video.removeEventListener("seeking", seeking);
      video.removeEventListener("seeked", fallback);
      video.removeEventListener("loadeddata", fallback);
      video.removeEventListener("playing", fallback);
      video.removeEventListener("timeupdate", timeUpdate);
      if (handle !== null) video.cancelVideoFrameCallback(handle);
      if (animationHandle !== null) cancelAnimationFrame(animationHandle);
    };
  }, [videoRef, sourceKey, enabled, frameRate, cacheKey]);
}
