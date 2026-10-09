import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const previousLoader = Module._extensions[".ts"];
const previousTsxLoader = Module._extensions[".tsx"];
Module._extensions[".ts"] = (loaded, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filename,
  });
  loaded._compile(
    outputText.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(filename).href)),
    filename,
  );
};
Module._extensions[".tsx"] = Module._extensions[".ts"];
const {
  FrameTraceAnalyzer,
  TRACE_WIDTH,
  TRACE_HEIGHT,
} = require("../src/core/editor/frameTrace.ts");
const {
  playbackTracePaths,
  completeTraceSamples,
} = require("../src/components/panels/StoryboardPanel/analysis/playbackTraceCurve.ts");
const { decodeBrowserFrameTrace } = require("../src/application/media/browserFrameTrace.ts");
const {
  frameTraceCacheKey,
  getFrameTraceCache,
} = require("../src/application/media/frameTraceCache.ts");
let disposeTrace;
let chartState;
let playbackProjections = [];
let traceDemand;
const originalLoad = Module._load;
Module._load = function (request, parent, ...args) {
  if (parent?.filename.endsWith("nativeFrameTrace.ts")) {
    if (request.endsWith("/errors"))
      return {
        clientError: require("../src/errors/model.ts").clientError,
        runOperation: async (_operation, action) => {
          try {
            return { status: "success", value: await action() };
          } catch (error) {
            return { status: error.code === "BROWSER_ABORTED" ? "cancelled" : "failed", error };
          }
        },
      };
  }
  if (parent?.filename.endsWith("StoryboardMotionPanel.tsx")) {
    if (request === "react")
      return {
        useState: (initial) => [
          chartState.stateIndex++ === 4 ? chartState.result : initial,
          () => {},
        ],
        useRef: (current) => ({
          current: chartState.refIndex++ === 0 ? chartState.cache : current,
        }),
        useMemo: (compute) => compute(),
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
        useEffect() {},
        useLayoutEffect() {},
      };
    if (request.endsWith("/errors")) return {};
    if (request.endsWith("/events/EventHub")) return { eventSource: () => ({}) };
    if (request.endsWith("/events/react")) return { publishEvent() {} };
    if (request.endsWith("/state/react"))
      return {
        useStableIdentity: () => ({}),
        usePublishProjection: (_key, _owner, demand) => {
          traceDemand = demand;
        },
      };
    if (request.endsWith("/systems/PanelState")) return { usePanelInstanceId: () => "test" };
    if (request.endsWith("/PopupMenu")) return { useCloseOnOutsidePointer() {} };
  }
  if (parent?.filename.endsWith("PlaybackCapability.ts")) {
    if (request.endsWith("/state/StateHub")) return { useProjections: () => playbackProjections };
    if (request.endsWith("/state/react")) return {};
    if (request.endsWith("/events/react")) return {};
  }
  if (parent?.filename.endsWith("useVideoFrameTrace.ts")) {
    if (request === "react")
      return {
        useRef: (current) => ({ current }),
        useEffect: (effect) => {
          disposeTrace = effect();
        },
      };
    if (request === "../../../../errors")
      return {
        captureOperationError: (operation, error) => {
          throw error;
        },
      };
  }
  return originalLoad.call(this, request, parent, ...args);
};
const {
  useVideoFrameTrace,
} = require("../src/components/panels/SourceMonitor/histogram/useVideoFrameTrace.ts");
const {
  StoryboardMotionPanel,
} = require("../src/components/panels/StoryboardPanel/analysis/StoryboardMotionPanel.tsx");
const {
  usePlaybackStatus,
  usePlaybackTraceStatus,
} = require("../src/runtime/capabilities/PlaybackCapability.ts");
const { NativeFrameTraceSession } = require("../src/application/media/nativeFrameTrace.ts");
Module._load = originalLoad;
if (previousLoader) Module._extensions[".ts"] = previousLoader;
else delete Module._extensions[".ts"];
if (previousTsxLoader) Module._extensions[".tsx"] = previousTsxLoader;
else delete Module._extensions[".tsx"];

function pixels(red, green = red, blue = red) {
  const data = new Uint8ClampedArray(TRACE_WIDTH * TRACE_HEIGHT * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([red, green, blue, 255], offset);
  return data;
}

test("continuous decoding keeps one job across playback ticks and joins chunks without losing pairs", async () => {
  const cache = getFrameTraceCache("native-session-test");
  const pending = [];
  let completed;
  const session = new NativeFrameTraceSession(
    "asset",
    0,
    270,
    25,
    cache,
    (value) => {
      completed = value;
    },
    () => assert.fail("decode failed"),
    (_asset, start, end, _cache, signal) =>
      new Promise((resolve) => pending.push({ start, end, signal, resolve })),
  );
  const finish = async (job) => {
    for (let frame = job.start; frame <= job.end; frame++)
      cache.put({ ...sample(frame, frame ? 0.5 : null), previousFrame: frame ? frame - 1 : null });
    job.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  };
  session.update(0, true);
  for (let frame = 1; frame <= 20; frame++) session.update(frame, true);
  assert.equal(pending.length, 1, "playhead ticks must not restart the decoder");
  assert.deepEqual([pending[0].start, pending[0].end], [0, 127]);
  await finish(pending[0]);
  assert.equal(pending.length, 1, "decoding stops when it is sufficiently ahead");
  session.update(100, true);
  assert.deepEqual([pending[1].start, pending[1].end], [127, 255]);
  session.update(100, false);
  assert.equal(pending[1].signal.aborted, false, "pausing reuses the ongoing decode");
  await finish(pending[1]);
  await finish(pending[2]);
  assert.equal(completed.colors.length, 271);
  assert.equal(completed.motion.length, 270);
  assert.equal(cache.get(128).previousFrame, 127);
  assert.equal(cache.get(256).previousFrame, 255);
  session.dispose();

  const middleCache = getFrameTraceCache("native-middle-session-test");
  const middleJobs = [];
  const middle = new NativeFrameTraceSession(
    "asset",
    0,
    270,
    25,
    middleCache,
    () => {},
    () => assert.fail("decode failed"),
    (_asset, start, end, _cache, signal) =>
      new Promise((resolve) => middleJobs.push({ start, end, signal, resolve })),
  );
  middle.update(180, true);
  middle.update(180, false);
  const job = middleJobs[0];
  for (let frame = job.start; frame <= job.end; frame++) middleCache.put(sample(frame));
  job.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(middleJobs[1].start, 0, "pausing after a seek must fill the missing prefix");
  middle.update(269, true);
  assert.equal(middleJobs[1].signal.aborted, true, "distant seeks cancel obsolete work");
  middle.dispose();
  assert.equal(middleJobs.at(-1).signal.aborted, true);
});

test("browser samples retain RGB means, weighted gray, and uniform-frame sharpness", () => {
  const sample = new FrameTraceAnalyzer().sample(10, pixels(255, 0, 0));
  assert.deepEqual(sample.colors, [1, 0, 0, 0.3]);
  assert.ok(sample.sharpness < 1e-12);
  assert.equal(sample.motion, null);
});

test("browser and native producers share asset slots and native only requests missing runs", async () => {
  const key = frameTraceCacheKey("browser-proxy-url", 25, "fingerprint", "shared-asset");
  assert.equal(key, frameTraceCacheKey("different-native-url", 25, "fingerprint", "shared-asset"));
  const cache = getFrameTraceCache(key);
  for (let frame = 0; frame <= 30; frame++) {
    if (frame < 10 || frame > 14) cache.put(sample(frame));
  }
  const revision = cache.getSnapshot();
  cache.put({ ...sample(9), sharpness: 999 });
  assert.equal(cache.get(9).sharpness, 1, "a second decoder must not replace existing results");
  assert.equal(cache.getSnapshot(), revision, "duplicate samples must not redraw the chart");
  const ranges = [];
  let complete;
  const session = new NativeFrameTraceSession(
    "shared-asset",
    0,
    30,
    25,
    cache,
    (data) => {
      complete = data;
    },
    () => assert.fail("decode failed"),
    async (_asset, start, end) => {
      ranges.push([start, end]);
      for (let frame = start; frame <= end; frame++) cache.put(sample(frame));
    },
  );
  session.update(0, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ranges, [[9, 14]], "only frames 10-14 plus their predecessor are requested");
  assert.equal(complete.colors.length, 31);
  assert.equal(complete.motion.length, 30);
  session.dispose();
});

test("SSIM uses adjacent decoded frames and detects changed pixels", () => {
  const analyzer = new FrameTraceAnalyzer();
  analyzer.sample(0, pixels(0));
  assert.ok(analyzer.sample(1, pixels(0)).motion < 1e-12);
  const changed = analyzer.sample(2, pixels(255));
  assert.ok(changed.motion > 0.9 && changed.motion <= 2);
  assert.equal(changed.previousFrame, 1);
});

test("missing adjacent frames and seeks never introduce cross-frame SSIM", () => {
  const analyzer = new FrameTraceAnalyzer();
  analyzer.sample(0, pixels(0));
  const skipped = analyzer.sample(5, pixels(255));
  assert.equal(skipped.previousFrame, null);
  assert.equal(skipped.motion, null);
  analyzer.reset();
  for (const frame of [3, 3, 2]) {
    const sample = analyzer.sample(frame, pixels(255));
    assert.equal(sample.motion, null);
    assert.equal(sample.previousFrame, null);
  }
  assert.equal(analyzer.sample(3, pixels(255)).previousFrame, 2);
});

test("sharpness keeps the existing brightness-normalized Laplacian metric", () => {
  const analyzer = new FrameTraceAnalyzer();
  const data = pixels(0);
  const center = (Math.floor(TRACE_HEIGHT / 2) * TRACE_WIDTH + Math.floor(TRACE_WIDTH / 2)) * 4;
  data.fill(60, center, center + 3);
  const score = analyzer.sample(0, data).sharpness;
  const expected =
    (20 * (TRACE_WIDTH * TRACE_HEIGHT) ** 2) / ((TRACE_WIDTH - 2) * (TRACE_HEIGHT - 2));
  assert.ok(Math.abs(score - expected) < 1e-8);
  data.fill(120, center, center + 3);
  assert.ok(Math.abs(analyzer.sample(1, data).sharpness - score) < 1e-8);
});

test("pixel dimensions are validated", () => {
  assert.throws(() => new FrameTraceAnalyzer().sample(0, new Uint8ClampedArray(4)), {
    code: "VIDEO_FRAME_DIMENSIONS_INVALID",
  });
});

test("optimized SSIM matches the previous library algorithm on textured RGB frames", () => {
  const { ssim } = require("ssim.js");
  const analyzer = new FrameTraceAnalyzer();
  let seed = 73;
  let previous;
  for (let frame = 0; frame < 6; frame++) {
    const image = pixels(0);
    for (let offset = 0; offset < image.length; offset += 4) {
      for (let channel = 0; channel < 3; channel++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        image[offset + channel] = seed >>> 24;
      }
    }
    const result = analyzer.sample(frame, image);
    if (previous) {
      let similarity = 0;
      for (let channel = 0; channel < 3; channel++) {
        const gray = (input) => {
          const data = pixels(0);
          for (let offset = 0; offset < data.length; offset += 4)
            data.fill(input[offset + channel], offset, offset + 3);
          return { data, width: TRACE_WIDTH, height: TRACE_HEIGHT };
        };
        similarity += ssim(gray(previous), gray(image), { downsample: false }).mssim / 3;
      }
      assert.ok(Math.abs(result.motion - (1 - similarity)) < 1e-12);
    }
    previous = image;
  }
});

test("shared cache reuses overlapping ranges, preserves known motion and isolates fingerprints", () => {
  const cache = getFrameTraceCache(frameTraceCacheKey("cache-test", 25, "first"));
  cache.put(sample(255));
  cache.put(sample(256));
  cache.put({ ...sample(256), motion: null, previousFrame: null });
  assert.equal(cache.get(256).motion, 0.5);
  assert.equal(cache.complete(255, 256).motion.length, 1);
  assert.equal(cache.complete(254, 256), null);
  assert.deepEqual(
    cache.samples(254, 257).map((entry) => entry.frame),
    [255, 256],
  );
  assert.equal(
    getFrameTraceCache(frameTraceCacheKey("cache-test", 25, "second")).get(255),
    undefined,
  );
});

function sample(frame, motion = 0.5) {
  return { frame, colors: [0.5, 0.5, 0.5, 0.5], sharpness: 1, motion, previousFrame: frame - 1 };
}

test("live paths use the complete shot's frame range and end at the playhead", () => {
  const paths = playbackTracePaths([sample(12), sample(13), sample(18)], 10, 20, 13, 200);
  assert.equal(paths.colors[0].line, "M0.2,1 L0.3,1");
  assert.ok(!paths.colors[0].area.includes("L1,"));
  assert.equal(playbackTracePaths([sample(18)], 10, 20, 13, 200).motion.line, "");
});

test("unplayed gaps remain separate subpaths with normalized motion differences", () => {
  const paths = playbackTracePaths(
    [sample(10), sample(11), sample(16), sample(17)],
    10,
    20,
    20,
    200,
  );
  assert.equal(paths.colors[0].line, "M0,1 L0.1,1 M0.6,1 L0.7,1");
  const lastY = Number(paths.motion.line.split(",").at(-1));
  assert.equal(lastY, 0.5625);
});

test("single-frame shots produce finite coordinates", () => {
  const paths = playbackTracePaths([sample(10)], 10, 10, 10, 200);
  assert.equal(paths.colors[0].line, "M0,1");
  assert.ok(!JSON.stringify(paths).includes("NaN"));
});

test("sampled-frame gaps during uninterrupted playback still draw visible curves", () => {
  const first = { ...sample(12), motion: null, previousFrame: null };
  const second = { ...sample(16), previousFrame: 12 };
  const paths = playbackTracePaths([first, second], 10, 20, 16, 200);
  assert.equal(paths.colors[0].line, "M0.2,1 L0.6,1");
  assert.equal(paths.motion.line, "M0.2,1 L0.6,0.5625");
  const isolated = playbackTracePaths([first], 10, 20, 12, 200);
  assert.ok(isolated.colors[0].line.includes(" L"));
});

test("starting playback retains the existing rendered curve, including cached shots", () => {
  const shot = { id: "test", start_frame: 10, end_frame: 12 };
  const key = JSON.stringify(["asset", "fingerprint", 10, 12, undefined, 25]);
  const data = {
    motion: [0.3, 0.4],
    colors: [
      [0, 0, 0, 0],
      [0.5, 0.5, 0.5, 0.5],
      [1, 1, 1, 1],
    ],
    sharpness: [0, 1, 2],
  };
  function motionPath(element) {
    if (!element || typeof element !== "object") return null;
    if (element.props?.className === "motion-line") return element.props.d;
    for (const child of [element.props?.children].flat(Infinity)) {
      const found = motionPath(child);
      if (found) return found;
    }
    return null;
  }
  let expected;
  for (const cached of [false, true]) {
    for (const isPlaying of [false, true]) {
      chartState = {
        stateIndex: 0,
        refIndex: 0,
        result: cached ? null : { key, data, failed: false },
        cache: new Map(cached ? [[key, data]] : []),
      };
      const path = motionPath(
        StoryboardMotionPanel({
          visible: true,
          shot,
          assetId: "asset",
          fingerprint: "fingerprint",
          playbackFrame: 11,
          isPlaying,
          onSeekFrame() {},
        }),
      );
      assert.ok(path, "existing curve must remain visible without live samples");
      expected ??= path;
      assert.equal(path, expected);
    }
  }
});

test("trace follows the playing monitor even when another idle monitor owns shortcuts", () => {
  const idle = { active: true, lastFocusedAt: 20, isPlaying: false, videoId: "idle" };
  const playing = { active: false, lastFocusedAt: 10, isPlaying: true, videoId: "playing" };
  playbackProjections = [
    { owner: { system: "source", instanceId: "idle" }, value: idle },
    { owner: { system: "source", instanceId: "playing" }, value: playing },
  ];
  try {
    assert.equal(usePlaybackStatus(), idle);
    assert.equal(usePlaybackTraceStatus(), playing);
    playing.isPlaying = false;
    assert.equal(usePlaybackTraceStatus(), idle);
  } finally {
    playbackProjections = [];
  }
});

test("expanded trace requests sampling before a matching shot or playback frame exists", () => {
  chartState = { stateIndex: 0, refIndex: 0, result: null, cache: new Map() };
  StoryboardMotionPanel({ visible: true, isPlaying: false, onSeekFrame() {} });
  assert.equal(traceDemand.enabled, true);
});

test("browser sampler keeps the newest presented frame while busy and rejects results from before a seek", () => {
  const originalDocument = globalThis.document;
  const originalWorker = globalThis.Worker;
  const originalAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const sent = [];
  const received = [];
  const events = new Map();
  let callback;
  let worker;
  let animationCallback;
  globalThis.requestAnimationFrame = (next) => {
    animationCallback = next;
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {
    animationCallback = null;
  };
  const video = {
    currentTime: 0,
    readyState: 2,
    seeking: false,
    videoWidth: 1920,
    addEventListener: (name, listener) => events.set(name, listener),
    removeEventListener: (name) => events.delete(name),
    requestVideoFrameCallback: (next) => {
      callback = next;
      return 1;
    },
    cancelVideoFrameCallback: () => {
      callback = null;
    },
  };
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels(64) }) }),
    }),
  };
  globalThis.Worker = class {
    constructor() {
      worker = this;
    }
    postMessage(message) {
      sent.push(message);
    }
    terminate() {
      this.terminated = true;
    }
  };
  try {
    useVideoFrameTrace({ current: video }, 0, 25, true, (value) => {
      if (value) received.push(value);
    });
    callback(0, { mediaTime: 1 / 25 });
    callback(0, { mediaTime: 2 / 25 });
    assert.deepEqual(
      sent.map((value) => value.frame),
      [0],
    );
    worker.onmessage({ data: { kind: "result", generation: 0, sample: sample(0) } });
    assert.deepEqual(
      sent.map((value) => value.frame),
      [0, 2],
    );
    video.seeking = true;
    events.get("seeking")();
    worker.onmessage({ data: { kind: "result", generation: 0, sample: sample(2) } });
    assert.deepEqual(
      received.map((value) => value.frame),
      [0],
    );
    video.seeking = false;
    video.currentTime = 10 / 25;
    events.get("seeked")();
    assert.equal(sent.at(-1).frame, 10);
    assert.equal(sent.at(-1).generation, 1);
    worker.onmessage({ data: { kind: "result", generation: 1, sample: sample(10) } });
    video.seeking = true;
    events.get("seeking")();
    video.currentTime = 11 / 25;
    video.seeking = false;
    events.get("seeked")();
    assert.equal(sent.at(-1).previousFrame, 10, "manual playback retains adjacent decoded pixels");
    worker.onmessage({ data: { kind: "result", generation: 2, sample: sample(11) } });
    disposeTrace();
    video.readyState = 0;
    useVideoFrameTrace({ current: video }, 0, 25, true, () => {});
    const beforeLoad = sent.length;
    video.readyState = 2;
    video.currentTime = 12 / 25;
    events.get("loadeddata")();
    assert.equal(sent.length, beforeLoad + 1, "sampling starts when delayed video data arrives");
    worker.onmessage({ data: { kind: "result", generation: 0, sample: sample(12) } });
    video.currentTime = 13 / 25;
    animationCallback();
    assert.equal(sent.at(-1).frame, 13, "RAF keeps frame-rate sampling when rVFC never fires");
    worker.onmessage({ data: { kind: "result", generation: 0, sample: sample(13) } });
    video.currentTime = 14 / 25;
    events.get("timeupdate")();
    assert.equal(sent.at(-1).frame, 14, "timeupdate samples when rVFC exists but never fires");
    disposeTrace();
    assert.ok(worker.terminated);
    assert.equal(callback, null);
    assert.equal(animationCallback, null);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
    if (originalAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalAnimationFrame;
    if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test("motion normalizes each difference with x - x squared / 4 without accumulation", () => {
  const below = playbackTracePaths([sample(0, 0), sample(1, 0.5), sample(2, 1)], 0, 2, 2, 200);
  assert.equal(below.motion.line, "M0,1 L0.5,0.5625 L1,0.25");
  const above = playbackTracePaths([sample(0, 0), sample(1, 2), sample(2, 0.25)], 0, 2, 2, 200);
  assert.equal(above.motion.line, "M0,1 L0.5,0 L1,0.765625");
});

test("motion smoothing adapts to display width and does not cross unplayed gaps", () => {
  const samples = [sample(0, 0), sample(1, 2), sample(2, 0), sample(3, 2), sample(4, 0)];
  const wide = playbackTracePaths(samples, 0, 4, 4, 200, "motion");
  const narrow = playbackTracePaths(samples, 0, 4, 4, 2, "motion");
  assert.equal(wide.motion.line, "M0,1 L0.25,0 L0.5,1 L0.75,0 L1,1");
  assert.equal(narrow.motion.line, "M0,0.5 L0.25,0.6 L0.5,0.6 L0.75,0.6 L1,0.5");
  const gaps = playbackTracePaths(
    [sample(0, 0), sample(1, 0), sample(3, 2), sample(4, 2)],
    0,
    4,
    4,
    1,
    "motion",
  );
  assert.equal(gaps.motion.line, "M0,1 L0.25,1 M0.75,0 L1,0");
});

test("browser complete analysis and playback frame pairs return identical metrics and paths", async () => {
  const originalDocument = globalThis.document;
  const originalWorker = globalThis.Worker;
  const frames = [pixels(0), pixels(64, 128, 255), pixels(255)];
  let drawn;
  let video;
  let worker;
  let workerCount = 0;
  const analyzed = [];
  class TestVideo {
    duration = frames.length / 25;
    time = 0;
    listeners = new Map();
    get currentTime() {
      return this.time;
    }
    set currentTime(value) {
      this.time = value;
      queueMicrotask(() => this.emit("seeked"));
    }
    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }
    removeEventListener(name) {
      this.listeners.delete(name);
    }
    emit(name) {
      this.listeners.get(name)?.();
    }
    load() {
      if (this.src) queueMicrotask(() => this.emit("loadeddata"));
    }
    pause() {}
    removeAttribute(name) {
      delete this[name];
    }
  }
  globalThis.document = {
    createElement: (name) =>
      name === "video"
        ? (video = new TestVideo())
        : {
            getContext: () => ({
              drawImage(source) {
                drawn = Math.floor(source.currentTime * 25);
              },
              getImageData: () => ({ data: frames[drawn].slice() }),
            }),
          },
  };
  globalThis.Worker = class {
    analyzer = new FrameTraceAnalyzer();
    constructor() {
      worker = this;
      workerCount++;
    }
    postMessage(input) {
      analyzed.push(input.frame);
      const result = this.analyzer.sample(input.frame, input.pixels);
      queueMicrotask(() =>
        this.onmessage({ data: { kind: "result", generation: 0, sample: result } }),
      );
    }
    terminate() {
      this.terminated = true;
    }
  };
  try {
    const complete = await decodeBrowserFrameTrace(
      "test-source",
      25,
      0,
      2,
      new AbortController().signal,
    );
    const live = frames.map((frame, index) => {
      const analyzer = new FrameTraceAnalyzer();
      if (index > 0) analyzer.sample(index - 1, frames[index - 1]);
      return analyzer.sample(index, frame);
    });
    assert.deepEqual(
      complete.colors,
      live.map((value) => value.colors),
    );
    assert.deepEqual(
      complete.sharpness,
      live.map((value) => value.sharpness),
    );
    assert.deepEqual(
      complete.motion,
      live.slice(1).map((value) => value.motion),
    );
    assert.deepEqual(
      playbackTracePaths(completeTraceSamples(complete, 0), 0, 2, 2, 200),
      playbackTracePaths(live, 0, 2, 2, 200),
    );
    assert.ok(worker.terminated);
    assert.equal(video.src, undefined);

    const cache = getFrameTraceCache(frameTraceCacheKey("partial-test", 25));
    cache.put(live[0]);
    cache.put(live[1]);
    analyzed.length = 0;
    const filled = await decodeBrowserFrameTrace(
      "test-source",
      25,
      0,
      2,
      new AbortController().signal,
      cache,
    );
    assert.deepEqual(filled, complete);
    assert.deepEqual(analyzed, [1, 2], "only the missing frame and its predecessor are decoded");
    const beforeHit = workerCount;
    await decodeBrowserFrameTrace("test-source", 25, 0, 2, new AbortController().signal, cache);
    assert.equal(workerCount, beforeHit, "complete hits do not create decoders or workers");

    const shared = getFrameTraceCache(frameTraceCacheKey("shared-job-test", 25));
    const first = new AbortController();
    const cancelled = decodeBrowserFrameTrace("test-source", 25, 0, 2, first.signal, shared);
    const survivor = decodeBrowserFrameTrace(
      "test-source",
      25,
      0,
      2,
      new AbortController().signal,
      shared,
    );
    first.abort();
    await assert.rejects(cancelled, { code: "BROWSER_ABORTED" });
    assert.deepEqual(await survivor, complete);
    assert.equal(
      workerCount,
      beforeHit + 1,
      "concurrent consumers share one decoder despite one cancellation",
    );
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  }
});
