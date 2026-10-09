import { Channel } from "@tauri-apps/api/core";
import { clientError, invokeCommand, runOperation } from "../../errors";
import type { FrameTraceData } from "./browserFrameTrace";
import type { FrameTraceCache } from "./frameTraceCache";

interface FrameTraceBatch {
  start_frame: number;
  previous_motion: number | null;
  data: FrameTraceData;
}

function storeBatch(cache: FrameTraceCache, batch: FrameTraceBatch) {
  for (let index = 0; index < batch.data.colors.length; index++) {
    const frame = batch.start_frame + index;
    const motion = index === 0 ? batch.previous_motion : batch.data.motion[index - 1];
    cache.put({
      frame,
      colors: batch.data.colors[index],
      sharpness: batch.data.sharpness[index],
      motion,
      previousFrame: motion === null ? null : frame - 1,
    });
  }
}

interface DecodeJob {
  controller: AbortController;
  promise: Promise<void>;
  users: number;
}
const jobs = new WeakMap<FrameTraceCache, Map<string, DecodeJob>>();

async function streamTrace(
  assetId: string,
  startFrame: number,
  endFrame: number,
  cache: FrameTraceCache,
  signal: AbortSignal,
) {
  if (signal.aborted) throw clientError("BROWSER_ABORTED", "Frame trace was cancelled");
  const taskId = `frame-trace:${crypto.randomUUID()}`;
  const cancel = () => {
    // A false result simply means cancellation beat command registration.
    // The backend's initial channel message retries cancellation after registration.
    void runOperation("task.cancel", () => invokeCommand("cancel_task", { taskId }));
  };
  const onSamples = new Channel<FrameTraceBatch>((batch) => {
    if (signal.aborted) {
      if (batch.data.colors.length === 0) cancel();
      return;
    }
    storeBatch(cache, batch);
  });
  const release = cache.retain();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const data = await invokeCommand<FrameTraceData>("storyboard_frame_trace", {
      assetId,
      startFrame,
      endFrame,
      taskId,
      onSamples,
    });
    if (signal.aborted) throw clientError("BROWSER_ABORTED", "Frame trace was cancelled");
    // Covers cache hits and completion racing the final channel callback.
    storeBatch(cache, { start_frame: startFrame, previous_motion: null, data });
  } finally {
    signal.removeEventListener("abort", cancel);
    release();
  }
}

export function decodeNativeTraceChunk(
  assetId: string,
  start: number,
  end: number,
  cache: FrameTraceCache,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted)
    return Promise.reject(clientError("BROWSER_ABORTED", "Frame trace was cancelled"));
  let active = jobs.get(cache);
  if (!active) {
    active = new Map();
    jobs.set(cache, active);
  }
  const key = `${assetId}:${start}:${end}`;
  let job = active.get(key);
  if (!job) {
    const controller = new AbortController();
    job = {
      controller,
      users: 0,
      promise: streamTrace(assetId, start, end, cache, controller.signal),
    };
    active.set(key, job);
  }
  const current = job;
  current.users++;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return false;
      done = true;
      signal.removeEventListener("abort", cancel);
      if (--current.users === 0) {
        active.delete(key);
        current.controller.abort();
      }
      return true;
    };
    const cancel = () => {
      if (finish()) reject(clientError("BROWSER_ABORTED", "Frame trace was cancelled"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    current.promise.then(
      () => {
        if (finish()) resolve();
      },
      (error) => {
        if (finish()) reject(error);
      },
    );
  });
}

const CHUNK_FRAMES = 128;

/** Playback moves the desired window; it never restarts a decoder on each tick. */
export class NativeFrameTraceSession {
  private playing = false;
  private playhead: number;
  private cursor: number;
  private disposed = false;
  private failed = false;
  private completeDelivered = false;
  private updated = false;
  private active: { start: number; end: number; controller: AbortController } | null = null;

  constructor(
    private readonly assetId: string,
    private readonly start: number,
    private readonly end: number,
    private readonly frameRate: number,
    private readonly cache: FrameTraceCache,
    private readonly complete: (data: FrameTraceData) => void,
    private readonly failure: () => void,
    private readonly decode = decodeNativeTraceChunk,
  ) {
    this.playhead = start;
    this.cursor = start;
  }

  update(playhead: number | undefined, playing: boolean) {
    if (this.disposed) return;
    const next = Math.max(this.start, Math.min(this.end, playhead ?? this.start));
    if (
      playing &&
      (!this.updated || next < this.playhead || next - this.playhead > this.lookAhead)
    ) {
      this.cursor = Math.max(this.start, next - 2);
    }
    if (this.playing && !playing) this.cursor = this.start;
    this.playing = playing;
    this.playhead = next;
    this.updated = true;
    if (
      this.active &&
      playing &&
      (this.active.end < this.playhead - 32 || this.active.start > this.playhead + this.lookAhead)
    ) {
      // A distant seek discards work behind the new playhead, not cached samples.
      this.active.controller.abort();
      this.active = null;
      this.cursor = Math.max(this.start, this.playhead - 2);
    }
    this.pump();
  }

  private get lookAhead() {
    return Math.max(64, Math.ceil(this.frameRate * 2));
  }

  private pump() {
    if (this.disposed || this.failed || this.completeDelivered || this.active) return;
    const first = this.cursor;
    const last = this.playing ? Math.min(this.end, this.playhead + this.lookAhead) : this.end;
    let missing = first;
    while (missing <= last && this.cache.has(missing, missing > this.start)) missing++;
    this.cursor = missing;
    if (missing > last) {
      if (!this.playing) {
        const data = this.cache.complete(this.start, this.end);
        if (data) {
          this.completeDelivered = true;
          this.complete(data);
        }
      }
      return;
    }
    // Request only a contiguous hole, stopping before the next cached frame.
    // One predecessor is still needed as the SSIM reference at the gap boundary.
    let end = missing;
    const limit = Math.min(this.end, missing + CHUNK_FRAMES - 1);
    while (end < limit && !this.cache.has(end + 1, true)) end++;
    // Include one predecessor so batch/chunk boundaries never produce gaps.
    const work = {
      start: missing > this.start ? missing - 1 : missing,
      end,
      controller: new AbortController(),
    };
    this.active = work;
    void runOperation("storyboard.trace", () =>
      this.decode(this.assetId, work.start, work.end, this.cache, work.controller.signal),
    ).then((outcome) => {
      if (this.disposed || this.active !== work) return;
      this.active = null;
      if (outcome.status === "success") {
        if (work.start <= this.cursor) this.cursor = Math.max(this.cursor, work.end + 1);
        this.pump();
      } else if (outcome.status === "failed") {
        this.failed = true;
        this.failure();
      }
    });
  }

  dispose() {
    this.disposed = true;
    this.active?.controller.abort();
    this.active = null;
  }
}
