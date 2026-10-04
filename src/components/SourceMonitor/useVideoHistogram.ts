import { useEffect, useRef, type RefObject } from "react";
import { captureOperationError } from "../../errors";
import type { FrameHistogram } from "../../core/editor/frameHistogram";
import type { FrameHistogramWorkerResponse } from "./frameHistogramWorker";

export function useVideoHistogram(
  videoRef: RefObject<HTMLVideoElement | null>,
  sourceKey: string | number | null,
  enabled: boolean,
  onHistogram: (histogram: FrameHistogram | null) => void,
) {
  const callback = useRef(onHistogram);
  callback.current = onHistogram;
  useEffect(() => {
    const video = videoRef.current;
    if (!enabled) return;
    callback.current(null);
    if (!video || sourceKey === null) return;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    let failed = false;
    let disposed = false;
    let busy = false;
    let pending = false;
    let seekGeneration = 0;
    let sampledSeekGeneration = 0;
    let frameCallback: number | null = null;
    let lastTime = -1;
    let worker: Worker;

    function fail(error: unknown) {
      if (disposed || failed) return;
      failed = true;
      worker?.terminate();
      callback.current(null);
      captureOperationError("media.histogram", error);
    }

    try {
      worker = new Worker(new URL("./frameHistogramWorker.ts", import.meta.url), {
        type: "module",
      });
    } catch (error) {
      fail(error);
      return;
    }

    worker.onmessage = ({ data }: MessageEvent<FrameHistogramWorkerResponse>) => {
      if (disposed || failed) return;
      busy = false;
      if (data.kind === "error") {
        fail(data.message);
        return;
      }
      const supersededBySeek = sampledSeekGeneration !== seekGeneration;
      if (!supersededBySeek && !video.seeking) {
        callback.current(data.histogram);
      }
      // Publish completed playback samples, then sample the latest state without a backlog.
      if (pending || supersededBySeek) {
        pending = false;
        lastTime = -1;
        update();
      } else {
        if (video.seeking) lastTime = -1;
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(event.message || "Histogram worker failed");
    };
    worker.onmessageerror = () => fail("Histogram worker response could not be decoded");

    function update() {
      if (
        disposed ||
        failed ||
        !context ||
        !video ||
        video.readyState < 2 ||
        video.seeking ||
        !video.videoWidth
      )
        return;
      if (lastTime === video.currentTime) return;
      if (busy) {
        pending = true;
        return;
      }
      try {
        const scale = Math.min(1, 384 / video.videoWidth, 216 / video.videoHeight);
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        context.drawImage(video, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        worker.postMessage(pixels, [pixels.buffer]);
        busy = true;
        sampledSeekGeneration = seekGeneration;
        lastTime = video.currentTime;
      } catch (error) {
        fail(error);
      }
    }
    function invalidateSeek() {
      seekGeneration++;
      lastTime = -1;
      if (busy) pending = true;
    }
    function watch() {
      if (!video || failed || typeof video.requestVideoFrameCallback !== "function") return;
      frameCallback = video.requestVideoFrameCallback(() => {
        update();
        watch();
      });
    }
    const events = ["loadeddata", "seeked", "timeupdate", "pause"] as const;
    events.forEach((event) => video.addEventListener(event, update));
    video.addEventListener("seeking", invalidateSeek);
    update();
    watch();
    return () => {
      disposed = true;
      worker.terminate();
      events.forEach((event) => video.removeEventListener(event, update));
      video.removeEventListener("seeking", invalidateSeek);
      if (frameCallback !== null) video.cancelVideoFrameCallback(frameCallback);
    };
  }, [videoRef, sourceKey, enabled]);
}
