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
const PHASE_VOCODER_SIZE = 2048;
const PHASE_VOCODER_HOP = PHASE_VOCODER_SIZE / 4;
const PHASE_VOCODER_BINS = PHASE_VOCODER_SIZE / 2 + 1;
const PHASE_VOCODER_QUEUE_SIZE = PHASE_VOCODER_SIZE * 4;
const TWO_PI = Math.PI * 2;

class FourierTransform {
  constructor(size) {
    this.size = size;
    this.bitReversed = new Uint32Array(size);
    this.cosines = new Float64Array(size / 2);
    this.sines = new Float64Array(size / 2);
    const bits = Math.log2(size);
    for (let index = 0; index < size; index += 1) {
      let value = index;
      let reversed = 0;
      for (let bit = 0; bit < bits; bit += 1) {
        reversed = (reversed << 1) | (value & 1);
        value >>>= 1;
      }
      this.bitReversed[index] = reversed;
    }
    for (let index = 0; index < size / 2; index += 1) {
      const angle = (TWO_PI * index) / size;
      this.cosines[index] = Math.cos(angle);
      this.sines[index] = Math.sin(angle);
    }
  }

  transform(real, imaginary, inverse = false) {
    for (let index = 0; index < this.size; index += 1) {
      const reversed = this.bitReversed[index];
      if (reversed <= index) {
        continue;
      }
      const realValue = real[index];
      const imaginaryValue = imaginary[index];
      real[index] = real[reversed];
      imaginary[index] = imaginary[reversed];
      real[reversed] = realValue;
      imaginary[reversed] = imaginaryValue;
    }

    for (let transformSize = 2; transformSize <= this.size; transformSize *= 2) {
      const halfSize = transformSize / 2;
      const tableStep = this.size / transformSize;
      for (let start = 0; start < this.size; start += transformSize) {
        for (let offset = 0; offset < halfSize; offset += 1) {
          const tableIndex = offset * tableStep;
          const cosine = this.cosines[tableIndex];
          const sine = inverse ? this.sines[tableIndex] : -this.sines[tableIndex];
          const evenIndex = start + offset;
          const oddIndex = evenIndex + halfSize;
          const oddReal = real[oddIndex] * cosine - imaginary[oddIndex] * sine;
          const oddImaginary = real[oddIndex] * sine + imaginary[oddIndex] * cosine;
          const evenReal = real[evenIndex];
          const evenImaginary = imaginary[evenIndex];
          real[evenIndex] = evenReal + oddReal;
          imaginary[evenIndex] = evenImaginary + oddImaginary;
          real[oddIndex] = evenReal - oddReal;
          imaginary[oddIndex] = evenImaginary - oddImaginary;
        }
      }
    }

    if (inverse) {
      for (let index = 0; index < this.size; index += 1) {
        real[index] /= this.size;
        imaginary[index] /= this.size;
      }
    }
  }
}

class ShuttleAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.playing = false;
    this.session = 0;
    this.sourceStartFrame = 0;
    this.outputFrame = 0;
    this.playbackRate = 1;
    this.direction = 1;
    this.algorithm = "wsola";
    this.durationFrames = 0;
    this.windowFrames = sampleRate * 2;
    this.tracks = new Map();
    this.requestedWindows = new Set();
    this.grainAnchors = new Map();
    this.audibleFrames = 0;
    this.blocksUntilPrune = 0;
    this.phaseVocoderTransform = new FourierTransform(PHASE_VOCODER_SIZE);
    this.phaseVocoderWindow = new Float64Array(PHASE_VOCODER_SIZE);
    for (let frame = 0; frame < PHASE_VOCODER_SIZE; frame += 1) {
      this.phaseVocoderWindow[frame] = Math.sqrt(
        0.5 - 0.5 * Math.cos((TWO_PI * (frame + 0.5)) / PHASE_VOCODER_SIZE),
      );
    }
    this.phaseVocoderInputLeft = new Float64Array(PHASE_VOCODER_SIZE);
    this.phaseVocoderInputRight = new Float64Array(PHASE_VOCODER_SIZE);
    this.phaseVocoderReal = new Float64Array(PHASE_VOCODER_SIZE);
    this.phaseVocoderImaginary = new Float64Array(PHASE_VOCODER_SIZE);
    this.phaseVocoderMagnitude = new Float64Array(PHASE_VOCODER_BINS);
    this.phaseVocoderCurrentPhase = new Float64Array(PHASE_VOCODER_BINS);
    this.phaseVocoderPeaks = new Uint16Array(PHASE_VOCODER_BINS);
    this.phaseVocoderPreviousPhaseLeft = new Float64Array(PHASE_VOCODER_BINS);
    this.phaseVocoderPreviousPhaseRight = new Float64Array(PHASE_VOCODER_BINS);
    this.phaseVocoderOutputPhaseLeft = new Float64Array(PHASE_VOCODER_BINS);
    this.phaseVocoderOutputPhaseRight = new Float64Array(PHASE_VOCODER_BINS);
    this.phaseVocoderAccumulatedLeft = new Float64Array(PHASE_VOCODER_SIZE);
    this.phaseVocoderAccumulatedRight = new Float64Array(PHASE_VOCODER_SIZE);
    this.phaseVocoderAccumulatedWeight = new Float64Array(PHASE_VOCODER_SIZE);
    this.phaseVocoderQueueLeft = new Float32Array(PHASE_VOCODER_QUEUE_SIZE);
    this.phaseVocoderQueueRight = new Float32Array(PHASE_VOCODER_QUEUE_SIZE);
    this.resetPhaseVocoder();
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(message) {
    if (message.type === "start") {
      this.session = message.session;
      this.sourceStartFrame = message.sourceFrame;
      this.outputFrame = 0;
      this.playbackRate = Math.max(0.01, Math.abs(message.playbackRate));
      this.direction = message.direction < 0 ? -1 : 1;
      this.algorithm = message.algorithm === "phase-vocoder" ? "phase-vocoder" : "wsola";
      this.durationFrames = Math.max(0, message.durationFrames);
      this.windowFrames = Math.max(GRAIN_SIZE, message.windowFrames);
      this.tracks = new Map(message.sourceIds.map((id) => [id, { windows: new Map() }]));
      this.requestedWindows.clear();
      this.grainAnchors = new Map([[0, this.sourceStartFrame]]);
      this.audibleFrames = 0;
      this.resetPhaseVocoder();
      this.playing = this.tracks.size > 0 && this.durationFrames > 0;
      return;
    }
    if (message.type === "stop") {
      this.playing = false;
      this.tracks.clear();
      this.requestedWindows.clear();
      this.grainAnchors.clear();
      this.audibleFrames = 0;
      this.resetPhaseVocoder();
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

  resetPhaseVocoder(analysisFrame = 0) {
    this.phaseVocoderAnalysisFrame = analysisFrame;
    this.phaseVocoderInitialized = false;
    this.phaseVocoderPreviousPhaseLeft.fill(0);
    this.phaseVocoderPreviousPhaseRight.fill(0);
    this.phaseVocoderOutputPhaseLeft.fill(0);
    this.phaseVocoderOutputPhaseRight.fill(0);
    this.phaseVocoderAccumulatedLeft.fill(0);
    this.phaseVocoderAccumulatedRight.fill(0);
    this.phaseVocoderAccumulatedWeight.fill(0);
    this.phaseVocoderQueueRead = 0;
    this.phaseVocoderQueueWrite = 0;
    this.phaseVocoderQueueCount = 0;
  }

  fillPhaseVocoderInput() {
    const trackGain = 1 / Math.sqrt(this.tracks.size);
    for (let frame = 0; frame < PHASE_VOCODER_SIZE; frame += 1) {
      const relativeFrame = this.phaseVocoderAnalysisFrame + frame - PHASE_VOCODER_SIZE / 2;
      const sourceFrame = this.sourceStartFrame + this.direction * relativeFrame;
      let mixedLeft = 0;
      let mixedRight = 0;
      let available = true;
      for (const [sourceId, track] of this.tracks) {
        const leftSample = this.sampleAt(sourceId, track, sourceFrame, 0);
        const rightSample = this.sampleAt(sourceId, track, sourceFrame, 1);
        if (!leftSample.available || !rightSample.available) {
          available = false;
          continue;
        }
        mixedLeft += leftSample.value;
        mixedRight += rightSample.value;
      }
      if (!available) {
        return false;
      }
      this.phaseVocoderInputLeft[frame] = mixedLeft * trackGain;
      this.phaseVocoderInputRight[frame] = mixedRight * trackGain;
    }
    return true;
  }

  synthesizePhaseVocoderChannel(input, previousPhase, outputPhase, accumulated) {
    for (let frame = 0; frame < PHASE_VOCODER_SIZE; frame += 1) {
      this.phaseVocoderReal[frame] = input[frame] * this.phaseVocoderWindow[frame];
      this.phaseVocoderImaginary[frame] = 0;
    }
    this.phaseVocoderTransform.transform(this.phaseVocoderReal, this.phaseVocoderImaginary);

    const analysisHop = this.playbackRate * PHASE_VOCODER_HOP;
    let maximumMagnitude = 0;
    for (let bin = 0; bin < PHASE_VOCODER_BINS; bin += 1) {
      const real = this.phaseVocoderReal[bin];
      const imaginary = this.phaseVocoderImaginary[bin];
      const magnitude = Math.hypot(real, imaginary);
      const phase = Math.atan2(imaginary, real);
      this.phaseVocoderMagnitude[bin] = magnitude;
      this.phaseVocoderCurrentPhase[bin] = phase;
      maximumMagnitude = Math.max(maximumMagnitude, magnitude);
      if (!this.phaseVocoderInitialized) {
        outputPhase[bin] = phase;
      } else {
        const expectedAnalysisPhase = (TWO_PI * bin * analysisHop) / PHASE_VOCODER_SIZE;
        let phaseDeviation = phase - previousPhase[bin] - expectedAnalysisPhase;
        phaseDeviation -= TWO_PI * Math.round(phaseDeviation / TWO_PI);
        const expectedOutputPhase = (TWO_PI * bin * PHASE_VOCODER_HOP) / PHASE_VOCODER_SIZE;
        outputPhase[bin] +=
          expectedOutputPhase + phaseDeviation * (PHASE_VOCODER_HOP / analysisHop);
      }
      previousPhase[bin] = phase;
    }

    let peakCount = 0;
    const peakThreshold = maximumMagnitude * 0.001;
    for (let bin = 1; bin < PHASE_VOCODER_BINS - 1; bin += 1) {
      const magnitude = this.phaseVocoderMagnitude[bin];
      if (
        magnitude >= peakThreshold &&
        magnitude > this.phaseVocoderMagnitude[bin - 1] &&
        magnitude >= this.phaseVocoderMagnitude[bin + 1]
      ) {
        this.phaseVocoderPeaks[peakCount] = bin;
        peakCount += 1;
      }
    }
    if (peakCount > 0) {
      let peakIndex = 0;
      for (let bin = 0; bin < PHASE_VOCODER_BINS; bin += 1) {
        while (
          peakIndex + 1 < peakCount &&
          Math.abs(bin - this.phaseVocoderPeaks[peakIndex + 1]) <
            Math.abs(bin - this.phaseVocoderPeaks[peakIndex])
        ) {
          peakIndex += 1;
        }
        const peak = this.phaseVocoderPeaks[peakIndex];
        if (bin !== peak) {
          let relativePhase =
            this.phaseVocoderCurrentPhase[bin] - this.phaseVocoderCurrentPhase[peak];
          relativePhase -= TWO_PI * Math.round(relativePhase / TWO_PI);
          outputPhase[bin] = outputPhase[peak] + relativePhase;
        }
      }
    }

    for (let bin = 0; bin < PHASE_VOCODER_BINS; bin += 1) {
      const magnitude = this.phaseVocoderMagnitude[bin];
      this.phaseVocoderReal[bin] = magnitude * Math.cos(outputPhase[bin]);
      this.phaseVocoderImaginary[bin] = magnitude * Math.sin(outputPhase[bin]);
    }
    for (let bin = 1; bin < PHASE_VOCODER_BINS - 1; bin += 1) {
      const mirroredBin = PHASE_VOCODER_SIZE - bin;
      this.phaseVocoderReal[mirroredBin] = this.phaseVocoderReal[bin];
      this.phaseVocoderImaginary[mirroredBin] = -this.phaseVocoderImaginary[bin];
    }
    this.phaseVocoderTransform.transform(this.phaseVocoderReal, this.phaseVocoderImaginary, true);
    for (let frame = 0; frame < PHASE_VOCODER_SIZE; frame += 1) {
      accumulated[frame] += this.phaseVocoderReal[frame] * this.phaseVocoderWindow[frame];
    }
  }

  enqueuePhaseVocoderSample(left, right) {
    if (this.phaseVocoderQueueCount >= PHASE_VOCODER_QUEUE_SIZE) {
      return;
    }
    this.phaseVocoderQueueLeft[this.phaseVocoderQueueWrite] = left;
    this.phaseVocoderQueueRight[this.phaseVocoderQueueWrite] = right;
    this.phaseVocoderQueueWrite = (this.phaseVocoderQueueWrite + 1) % PHASE_VOCODER_QUEUE_SIZE;
    this.phaseVocoderQueueCount += 1;
  }

  generatePhaseVocoderFrame() {
    if (!this.fillPhaseVocoderInput()) {
      return false;
    }
    this.synthesizePhaseVocoderChannel(
      this.phaseVocoderInputLeft,
      this.phaseVocoderPreviousPhaseLeft,
      this.phaseVocoderOutputPhaseLeft,
      this.phaseVocoderAccumulatedLeft,
    );
    this.synthesizePhaseVocoderChannel(
      this.phaseVocoderInputRight,
      this.phaseVocoderPreviousPhaseRight,
      this.phaseVocoderOutputPhaseRight,
      this.phaseVocoderAccumulatedRight,
    );
    for (let frame = 0; frame < PHASE_VOCODER_SIZE; frame += 1) {
      const window = this.phaseVocoderWindow[frame];
      this.phaseVocoderAccumulatedWeight[frame] += window * window;
    }
    for (let frame = 0; frame < PHASE_VOCODER_HOP; frame += 1) {
      const weight = this.phaseVocoderAccumulatedWeight[frame];
      const left = weight > 1e-8 ? this.phaseVocoderAccumulatedLeft[frame] / weight : 0;
      const right = weight > 1e-8 ? this.phaseVocoderAccumulatedRight[frame] / weight : 0;
      this.enqueuePhaseVocoderSample(left, right);
    }
    this.phaseVocoderAccumulatedLeft.copyWithin(0, PHASE_VOCODER_HOP);
    this.phaseVocoderAccumulatedRight.copyWithin(0, PHASE_VOCODER_HOP);
    this.phaseVocoderAccumulatedWeight.copyWithin(0, PHASE_VOCODER_HOP);
    this.phaseVocoderAccumulatedLeft.fill(0, PHASE_VOCODER_SIZE - PHASE_VOCODER_HOP);
    this.phaseVocoderAccumulatedRight.fill(0, PHASE_VOCODER_SIZE - PHASE_VOCODER_HOP);
    this.phaseVocoderAccumulatedWeight.fill(0, PHASE_VOCODER_SIZE - PHASE_VOCODER_HOP);
    this.phaseVocoderAnalysisFrame += this.playbackRate * PHASE_VOCODER_HOP;
    this.phaseVocoderInitialized = true;
    return true;
  }

  processPhaseVocoder(left, right) {
    while (this.phaseVocoderQueueCount < left.length) {
      if (!this.generatePhaseVocoderFrame()) {
        break;
      }
    }

    let underrun = false;
    for (let outputOffset = 0; outputOffset < left.length; outputOffset += 1) {
      if (this.phaseVocoderQueueCount === 0) {
        underrun = true;
        this.audibleFrames = 0;
        continue;
      }
      const queueIndex = this.phaseVocoderQueueRead;
      this.phaseVocoderQueueRead = (this.phaseVocoderQueueRead + 1) % PHASE_VOCODER_QUEUE_SIZE;
      this.phaseVocoderQueueCount -= 1;
      this.audibleFrames += 1;
      const startGain = Math.min(1, this.audibleFrames / (sampleRate * START_FADE_SECONDS));
      left[outputOffset] = Math.max(
        -1,
        Math.min(1, this.phaseVocoderQueueLeft[queueIndex] * startGain),
      );
      right[outputOffset] = Math.max(
        -1,
        Math.min(1, this.phaseVocoderQueueRight[queueIndex] * startGain),
      );
    }
    if (underrun) {
      this.resetPhaseVocoder(this.playbackRate * (this.outputFrame + left.length));
    }
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

    if (this.algorithm === "phase-vocoder") {
      this.processPhaseVocoder(left, right);
    } else {
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
      if (this.algorithm === "wsola") {
        const currentGrainIndex = Math.floor(this.outputFrame / GRAIN_HOP);
        for (const grainIndex of this.grainAnchors.keys()) {
          if (grainIndex < currentGrainIndex - ACTIVE_GRAINS - 2) {
            this.grainAnchors.delete(grainIndex);
          }
        }
      }
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, ShuttleAudioProcessor);
