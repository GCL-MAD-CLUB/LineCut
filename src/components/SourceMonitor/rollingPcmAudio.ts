import { clientError, invokeCommand, runOperation } from "../../errors";

const PCM_MAGIC = "LPCM";
const PCM_HEADER_BYTES = 24;
const PCM_CHANNELS = 2;
const WINDOW_SECONDS = 2;
const MAX_CACHED_WINDOWS = 24;

export interface RollingPcmAudioSource {
  id: string;
  path: string;
  audioTrackIndex: number;
}

interface RollingPcmPlayback {
  sources: RollingPcmAudioSource[];
  sourceTimeSeconds: number;
  durationSeconds: number;
  playbackRate: number;
  direction: -1 | 1;
}

interface ActivePlayback extends RollingPcmPlayback {
  session: number;
  sampleRate: number;
  windowFrames: number;
  durationFrames: number;
  sourcesById: Map<string, RollingPcmAudioSource>;
}

interface PcmWindow {
  sampleRate: number;
  startTimeUs: number;
  frameCount: number;
  samples: Float32Array;
}

type BinaryResponse = ArrayBuffer | Uint8Array | number[];

function clampSourceTime(value: number, duration: number) {
  return Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), Math.max(0, duration));
}

function responseBytes(response: BinaryResponse) {
  if (response instanceof ArrayBuffer) {
    return new Uint8Array(response);
  }
  if (response instanceof Uint8Array) {
    return response;
  }
  return Uint8Array.from(response);
}

function parsePcmWindow(response: BinaryResponse): PcmWindow {
  const bytes = responseBytes(response);
  if (bytes.byteLength < PCM_HEADER_BYTES) {
    throw clientError("PCM_WINDOW_INVALID", "PCM window response is shorter than its header");
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, PCM_HEADER_BYTES);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const sampleRate = header.getUint32(4, true);
  const channels = header.getUint16(8, true);
  const startTimeUs = Number(header.getBigInt64(12, true));
  const frameCount = header.getUint32(20, true);
  const sampleBytes = frameCount * channels * Float32Array.BYTES_PER_ELEMENT;
  if (magic !== PCM_MAGIC || channels !== PCM_CHANNELS) {
    throw clientError(
      "PCM_WINDOW_INVALID",
      `PCM window header is invalid: magic=${magic}, channels=${channels}`,
    );
  }
  if (bytes.byteLength !== PCM_HEADER_BYTES + sampleBytes) {
    throw clientError(
      "PCM_WINDOW_INVALID",
      `PCM window payload length is invalid: expected ${PCM_HEADER_BYTES + sampleBytes}, got ${bytes.byteLength}`,
    );
  }
  const alignedSamples = bytes.slice(PCM_HEADER_BYTES);
  return {
    sampleRate,
    startTimeUs,
    frameCount,
    samples: new Float32Array(
      alignedSamples.buffer,
      alignedSamples.byteOffset,
      frameCount * channels,
    ),
  };
}

export class RollingPcmAudioController {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private active: ActivePlayback | null = null;
  private commandGeneration = 0;
  private nextSession = 1;
  private requests = new Map<string, Promise<void>>();
  private windowCache = new Map<string, PcmWindow>();

  async play(playback: RollingPcmPlayback) {
    const requestedAt = performance.now();
    const commandGeneration = ++this.commandGeneration;
    if (
      playback.sources.length === 0 ||
      playback.durationSeconds <= 0 ||
      playback.playbackRate <= 0 ||
      playback.playbackRate > 4
    ) {
      this.stop();
      return;
    }

    const output = await this.ensureOutput();
    if (!output || commandGeneration !== this.commandGeneration) {
      return;
    }
    const { context, node } = output;
    const sampleRate = context.sampleRate;
    const windowFrames = Math.round(sampleRate * WINDOW_SECONDS);
    const durationFrames = Math.max(1, Math.round(playback.durationSeconds * sampleRate));
    const startupSeconds = Math.max(0, (performance.now() - requestedAt) / 1000);
    const adjustedSourceTimeSeconds = clampSourceTime(
      playback.sourceTimeSeconds + playback.direction * playback.playbackRate * startupSeconds,
      playback.durationSeconds,
    );
    const session = this.nextSession++;
    const active: ActivePlayback = {
      ...playback,
      sourceTimeSeconds: adjustedSourceTimeSeconds,
      session,
      sampleRate,
      windowFrames,
      durationFrames,
      sourcesById: new Map(playback.sources.map((source) => [source.id, source])),
    };
    this.active = active;
    const sourceFrame = Math.max(
      0,
      Math.min(durationFrames, adjustedSourceTimeSeconds * sampleRate),
    );
    node.port.postMessage({
      type: "start",
      session,
      sourceIds: playback.sources.map((source) => source.id),
      sourceFrame,
      durationFrames,
      playbackRate: playback.playbackRate,
      direction: playback.direction,
      windowFrames,
    });

    const currentWindow = Math.floor(sourceFrame / windowFrames) * windowFrames;
    const nextWindow = currentWindow + playback.direction * windowFrames;
    for (const source of playback.sources) {
      void this.loadWindow(active, source, currentWindow);
      if (nextWindow >= 0 && nextWindow < durationFrames) {
        void this.loadWindow(active, source, nextWindow);
      }
    }
  }

  stop() {
    this.commandGeneration += 1;
    this.active = null;
    this.node?.port.postMessage({ type: "stop" });
  }

  dispose() {
    this.stop();
    this.node?.disconnect();
    this.node = null;
    this.windowCache.clear();
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") {
      void context.close();
    }
  }

  private async ensureOutput() {
    if (this.context && this.node) {
      if (this.context.state === "suspended") {
        await this.context.resume();
      }
      return { context: this.context, node: this.node };
    }
    const AudioContextClass =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) {
      return null;
    }
    const context = new AudioContextClass({ latencyHint: "interactive" });
    this.context = context;
    await context.resume();
    await context.audioWorklet.addModule(new URL("./shuttleAudio.worklet.js", import.meta.url));
    if (this.context !== context || context.state === "closed") {
      return null;
    }
    const node = new AudioWorkletNode(context, "linecut-shuttle-audio", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [PCM_CHANNELS],
    });
    node.connect(context.destination);
    node.port.onmessage = (event: MessageEvent) => this.handleWorkletMessage(event.data);
    this.node = node;
    return { context, node };
  }

  private handleWorkletMessage(message: {
    type: string;
    session: number;
    sourceId?: string;
    startFrame?: number;
  }) {
    const active = this.active;
    if (
      message.type !== "need-window" ||
      !active ||
      message.session !== active.session ||
      typeof message.sourceId !== "string" ||
      typeof message.startFrame !== "number"
    ) {
      return;
    }
    const source = active.sourcesById.get(message.sourceId);
    if (source) {
      void this.loadWindow(active, source, message.startFrame);
    }
  }

  private async loadWindow(
    active: ActivePlayback,
    source: RollingPcmAudioSource,
    requestedStartFrame: number,
  ) {
    const startFrame =
      Math.floor(Math.max(0, requestedStartFrame) / active.windowFrames) * active.windowFrames;
    if (startFrame >= active.durationFrames) {
      return;
    }
    const requestKey = `${active.session}:${source.id}:${startFrame}`;
    if (this.requests.has(requestKey)) {
      return this.requests.get(requestKey);
    }
    const request = runOperation("media.playback", () =>
      this.decodeAndAppendWindow(active, source, startFrame),
    )
      .then(() => undefined)
      .finally(() => {
        this.requests.delete(requestKey);
      });
    this.requests.set(requestKey, request);
    return request;
  }

  private async decodeAndAppendWindow(
    active: ActivePlayback,
    source: RollingPcmAudioSource,
    startFrame: number,
  ) {
    const cacheKey = `${source.id}:${active.sampleRate}:${startFrame}`;
    const cached = this.windowCache.get(cacheKey);
    if (cached) {
      this.windowCache.delete(cacheKey);
      this.windowCache.set(cacheKey, cached);
      this.appendDecodedWindow(active, source.id, cached);
      return;
    }
    const startTimeUs = Math.round((startFrame / active.sampleRate) * 1_000_000);
    const remainingUs = Math.max(
      0,
      Math.round(((active.durationFrames - startFrame) / active.sampleRate) * 1_000_000),
    );
    const durationUs = Math.min(Math.round(WINDOW_SECONDS * 1_000_000), remainingUs);
    if (durationUs < 20_000) {
      this.appendWindow(active, source.id, startFrame, new Float32Array(), new Float32Array());
      return;
    }
    const response = await invokeCommand<BinaryResponse>("decode_audio_pcm_window", {
      sourcePath: source.path,
      audioTrackIndex: source.audioTrackIndex,
      startTimeUs,
      durationUs,
      sampleRate: active.sampleRate,
    });
    if (this.active?.session !== active.session) {
      return;
    }
    const decoded = parsePcmWindow(response);
    if (decoded.sampleRate !== active.sampleRate) {
      throw clientError(
        "PCM_WINDOW_INVALID",
        `PCM window sample rate changed from ${active.sampleRate} to ${decoded.sampleRate}`,
      );
    }
    this.windowCache.set(cacheKey, decoded);
    while (this.windowCache.size > MAX_CACHED_WINDOWS) {
      const oldestKey = this.windowCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.windowCache.delete(oldestKey);
    }
    this.appendDecodedWindow(active, source.id, decoded);
  }

  private appendDecodedWindow(active: ActivePlayback, sourceId: string, decoded: PcmWindow) {
    const decodedStartFrame = Math.round((decoded.startTimeUs / 1_000_000) * active.sampleRate);
    const left = new Float32Array(decoded.frameCount);
    const right = new Float32Array(decoded.frameCount);
    for (let frame = 0; frame < decoded.frameCount; frame += 1) {
      left[frame] = decoded.samples[frame * PCM_CHANNELS];
      right[frame] = decoded.samples[frame * PCM_CHANNELS + 1];
    }
    this.appendWindow(active, sourceId, decodedStartFrame, left, right);
  }

  private appendWindow(
    active: ActivePlayback,
    sourceId: string,
    startFrame: number,
    left: Float32Array,
    right: Float32Array,
  ) {
    if (!this.node || this.active?.session !== active.session) {
      return;
    }
    this.node.port.postMessage(
      {
        type: "append-window",
        session: active.session,
        sourceId,
        startFrame,
        frameCount: left.length,
        left: left.buffer,
        right: right.buffer,
      },
      [left.buffer, right.buffer],
    );
  }
}
