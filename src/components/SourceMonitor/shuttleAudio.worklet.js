const PROCESSOR_NAME = "linecut-shuttle-audio";
const GRAIN_SIZE = 4096;
const GRAIN_HOP = 3072;
const CROSSFADE_FRAMES = GRAIN_SIZE - GRAIN_HOP;
const ACTIVE_GRAINS = Math.ceil(GRAIN_SIZE / GRAIN_HOP);
const LOOK_AHEAD_SECONDS = 1;
const SEARCH_RADIUS = 512;
const SEARCH_STEP = 16;
const CORRELATION_STEP = 8;
const START_FADE_SECONDS = 0.012;

class ShuttleAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.playing = false;
    this.session = 0;
    this.sourceStartFrame = 0;
    this.outputFrame = 0;
    this.playbackRate = 1;
    this.direction = 1;
    this.durationFrames = 0;
    this.windowFrames = sampleRate * 2;
    this.tracks = new Map();
    this.requestedWindows = new Set();
    this.grainAnchors = new Map();
    this.audibleFrames = 0;
    this.blocksUntilPrune = 0;
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(message) {
    if (message.type === "start") {
      this.session = message.session;
      this.sourceStartFrame = message.sourceFrame;
      this.outputFrame = 0;
      this.playbackRate = Math.max(0.01, Math.abs(message.playbackRate));
      this.direction = message.direction < 0 ? -1 : 1;
      this.durationFrames = Math.max(0, message.durationFrames);
      this.windowFrames = Math.max(GRAIN_SIZE, message.windowFrames);
      this.tracks = new Map(message.sourceIds.map((id) => [id, { windows: new Map() }]));
      this.requestedWindows.clear();
      this.grainAnchors = new Map([[0, this.sourceStartFrame]]);
      this.audibleFrames = 0;
      this.playing = this.tracks.size > 0 && this.durationFrames > 0;
      return;
    }
    if (message.type === "stop") {
      this.playing = false;
      this.tracks.clear();
      this.requestedWindows.clear();
      this.grainAnchors.clear();
      this.audibleFrames = 0;
      return;
    }
    if (message.type !== "append-window" || message.session !== this.session) {
      return;
    }
    const track = this.tracks.get(message.sourceId);
    if (!track) {
      return;
    }
    track.windows.set(message.startFrame, {
      frameCount: message.frameCount,
      left: new Float32Array(message.left),
      right: new Float32Array(message.right),
    });
    this.requestedWindows.delete(`${message.sourceId}:${message.startFrame}`);
  }

  requestWindow(sourceId, startFrame) {
    const key = `${sourceId}:${startFrame}`;
    if (this.requestedWindows.has(key)) {
      return;
    }
    this.requestedWindows.add(key);
    this.port.postMessage({
      type: "need-window",
      session: this.session,
      sourceId,
      startFrame,
    });
  }

  sampleAt(sourceId, track, sourceFrame, channel) {
    if (sourceFrame < 0 || sourceFrame >= this.durationFrames) {
      return { available: true, value: 0 };
    }
    const frame = Math.floor(sourceFrame);
    const fraction = sourceFrame - frame;
    const startFrame = Math.floor(frame / this.windowFrames) * this.windowFrames;
    const window = track.windows.get(startFrame);
    if (!window) {
      this.requestWindow(sourceId, startFrame);
      return { available: false, value: 0 };
    }
    const offset = frame - startFrame;
    if (offset < 0 || offset >= window.frameCount) {
      return { available: true, value: 0 };
    }
    const samples = channel === 0 ? window.left : window.right;
    const first = samples[offset] ?? 0;
    if (fraction === 0 || offset + 1 >= window.frameCount) {
      return { available: true, value: first };
    }
    const second = samples[offset + 1] ?? first;
    return { available: true, value: first + (second - first) * fraction };
  }

  grainWindow(localFrame) {
    if (localFrame < CROSSFADE_FRAMES) {
      const phase = ((localFrame + 0.5) / CROSSFADE_FRAMES) * (Math.PI / 2);
      const gain = Math.sin(phase);
      return gain * gain;
    }
    if (localFrame >= GRAIN_HOP) {
      const phase = ((localFrame - GRAIN_HOP + 0.5) / CROSSFADE_FRAMES) * (Math.PI / 2);
      const gain = Math.cos(phase);
      return gain * gain;
    }
    return 1;
  }

  grainAnchor(grainIndex) {
    const cached = this.grainAnchors.get(grainIndex);
    if (cached !== undefined) {
      return cached;
    }
    const nominal =
      this.sourceStartFrame + this.direction * this.playbackRate * grainIndex * GRAIN_HOP;
    const previousAnchor = this.grainAnchors.get(grainIndex - 1);
    const firstTrackEntry = this.tracks.entries().next().value;
    if (
      previousAnchor === undefined ||
      !firstTrackEntry ||
      Math.abs(this.playbackRate - 1) < 1e-6
    ) {
      this.grainAnchors.set(grainIndex, nominal);
      return nominal;
    }

    const [sourceId, track] = firstTrackEntry;
    let bestAnchor = nominal;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let offset = -SEARCH_RADIUS; offset <= SEARCH_RADIUS; offset += SEARCH_STEP) {
      const candidateAnchor = nominal + offset;
      if (
        (this.direction > 0 && candidateAnchor <= previousAnchor) ||
        (this.direction < 0 && candidateAnchor >= previousAnchor)
      ) {
        continue;
      }
      let dot = 0;
      let previousEnergy = 0;
      let candidateEnergy = 0;
      let available = true;
      for (
        let overlapFrame = 0;
        overlapFrame < CROSSFADE_FRAMES;
        overlapFrame += CORRELATION_STEP
      ) {
        const previous = this.sampleAt(
          sourceId,
          track,
          previousAnchor + this.direction * (GRAIN_HOP + overlapFrame),
          0,
        );
        const candidate = this.sampleAt(
          sourceId,
          track,
          candidateAnchor + this.direction * overlapFrame,
          0,
        );
        if (!previous.available || !candidate.available) {
          available = false;
          break;
        }
        dot += previous.value * candidate.value;
        previousEnergy += previous.value * previous.value;
        candidateEnergy += candidate.value * candidate.value;
      }
      if (!available) {
        break;
      }
      const energy = Math.sqrt(previousEnergy * candidateEnergy);
      if (energy <= 1e-9) {
        continue;
      }
      const score = dot / energy;
      if (score > bestScore) {
        bestScore = score;
        bestAnchor = candidateAnchor;
      }
    }
    this.grainAnchors.set(grainIndex, bestAnchor);
    return bestAnchor;
  }

  pruneWindows(sourceFrame) {
    const keepDistance = this.windowFrames * 4;
    for (const track of this.tracks.values()) {
      for (const startFrame of track.windows.keys()) {
        const endFrame = startFrame + this.windowFrames;
        if (endFrame < sourceFrame - keepDistance || startFrame > sourceFrame + keepDistance) {
          track.windows.delete(startFrame);
        }
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? output[0];
    left.fill(0);
    right.fill(0);
    if (!this.playing || this.tracks.size === 0) {
      return true;
    }

    const trackGain = 1 / Math.sqrt(this.tracks.size);
    for (let outputOffset = 0; outputOffset < left.length; outputOffset += 1) {
      const outputFrame = this.outputFrame + outputOffset;
      const latestGrainStart = Math.floor(outputFrame / GRAIN_HOP) * GRAIN_HOP;
      let mixedLeft = 0;
      let mixedRight = 0;
      let mixedWeight = 0;

      for (let overlap = 0; overlap < ACTIVE_GRAINS; overlap += 1) {
        const grainStart = latestGrainStart - overlap * GRAIN_HOP;
        if (grainStart < 0) {
          continue;
        }
        const localFrame = outputFrame - grainStart;
        if (localFrame < 0 || localFrame >= GRAIN_SIZE) {
          continue;
        }
        const weight = this.grainWindow(localFrame);
        const grainIndex = grainStart / GRAIN_HOP;
        const sourceFrame = this.grainAnchor(grainIndex) + this.direction * localFrame;
        let grainLeft = 0;
        let grainRight = 0;
        let availableTracks = 0;
        for (const [sourceId, track] of this.tracks) {
          const leftSample = this.sampleAt(sourceId, track, sourceFrame, 0);
          const rightSample = this.sampleAt(sourceId, track, sourceFrame, 1);
          if (!leftSample.available || !rightSample.available) {
            continue;
          }
          grainLeft += leftSample.value;
          grainRight += rightSample.value;
          availableTracks += 1;
        }
        if (availableTracks === 0) {
          continue;
        }
        mixedLeft += grainLeft * weight;
        mixedRight += grainRight * weight;
        mixedWeight += weight;
      }

      if (mixedWeight > 1e-6) {
        this.audibleFrames += 1;
        const startGain = Math.min(1, this.audibleFrames / (sampleRate * START_FADE_SECONDS));
        left[outputOffset] = Math.max(
          -1,
          Math.min(1, (mixedLeft / mixedWeight) * trackGain * startGain),
        );
        right[outputOffset] = Math.max(
          -1,
          Math.min(1, (mixedRight / mixedWeight) * trackGain * startGain),
        );
      } else {
        this.audibleFrames = 0;
      }
    }

    this.outputFrame += left.length;
    const sourceFrame =
      this.sourceStartFrame + this.direction * this.playbackRate * this.outputFrame;
    const lookAheadFrame =
      sourceFrame + this.direction * this.playbackRate * sampleRate * LOOK_AHEAD_SECONDS;
    if (lookAheadFrame >= 0 && lookAheadFrame < this.durationFrames) {
      const lookAheadWindow = Math.floor(lookAheadFrame / this.windowFrames) * this.windowFrames;
      for (const sourceId of this.tracks.keys()) {
        this.requestWindow(sourceId, lookAheadWindow);
      }
    }
    if (sourceFrame <= 0 || sourceFrame >= this.durationFrames) {
      this.playing = false;
      this.port.postMessage({ type: "ended", session: this.session });
    }
    this.blocksUntilPrune -= 1;
    if (this.blocksUntilPrune <= 0) {
      this.blocksUntilPrune = 128;
      this.pruneWindows(sourceFrame);
      const currentGrainIndex = Math.floor(this.outputFrame / GRAIN_HOP);
      for (const grainIndex of this.grainAnchors.keys()) {
        if (grainIndex < currentGrainIndex - ACTIVE_GRAINS - 2) {
          this.grainAnchors.delete(grainIndex);
        }
      }
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, ShuttleAudioProcessor);
