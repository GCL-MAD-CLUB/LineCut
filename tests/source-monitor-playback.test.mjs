import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/components/panels/SourceMonitor/SourceMonitor.tsx", import.meta.url),
  "utf8",
);
const syntax = ts.createSourceFile("SourceMonitor.tsx", source, ts.ScriptTarget.Latest, true);
const functions = new Map();
function collect(node) {
  if (ts.isFunctionDeclaration(node) && node.name) {
    functions.set(node.name.text, node.getText(syntax));
  }
  ts.forEachChild(node, collect);
}
collect(syntax);
const compiled = ts.transpileModule(
  ["applyPlaybackMode", "startManualPlaybackTicker"].map((name) => functions.get(name)).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

// Exercise the player's actual control functions without media files or a native backend.
function player(pointerFrame, range = { startFrame: 10, endFrame: 20 }, isExportMonitor = true) {
  const ref = (current) => ({ current });
  let tick;
  const stopped = [];
  const video = { paused: true, ended: false, play: async () => {}, pause() {} };
  const state = {
    isExportMonitor,
    hasMedia: true,
    videoRef: ref(video),
    currentFrameRef: ref(pointerFrame),
    playbackModeRef: ref(0),
    cuePlaybackPauseFrameRef: ref(null),
    cuePlaybackEndFrameRef: ref(null),
    manualPlaybackFrameRef: ref(pointerFrame),
    manualPlaybackTickAtRef: ref(null),
    seekTargetFrameRef: ref(pointerFrame),
    playbackTickRef: ref(null),
    cueRange: range,
    frameRate: 25,
    durationFrames: 100,
    performance: { now: () => 0 },
    requestAnimationFrame: (callback) => {
      tick = callback;
      return 1;
    },
    effectivePlaybackRate: (mode) => (mode === "slow-forward" ? 0.25 : mode),
    usesManualPlaybackClock: (mode) => mode === "slow-forward" || mode < 0,
    playbackFrame: () => state.currentFrameRef.current,
    commitPlaybackMode: (mode) => (state.playbackModeRef.current = mode),
    clamp: (value, min, max) => Math.min(Math.max(value, min), max),
    clampMonitorFrame: (value) => value,
    skipCrossedStoryboardGap: () => false,
    seekToFrame: (frame, preserveEnd) => {
      state.seekTargetFrameRef.current = frame;
      if (!preserveEnd) state.cuePlaybackEndFrameRef.current = null;
    },
    finishCuePlaybackAtFrame: (_, frame) => stopped.push(frame),
    pcmPlaybackConfig: () => null,
    shouldMuteVideo: () => false,
    runOperation: async (_, action) => {
      await action();
      return { status: "success" };
    },
  };
  for (const name of [
    "stopCuePlaybackFrameMonitor",
    "stopRollingPcmAudio",
    "stopPlaybackTicker",
    "pauseBoundAudio",
    "centerTimelineIfFrameHidden",
    "playRollingPcmAudio",
    "syncBoundAudio",
    "playBoundAudio",
    "startCuePlaybackFrameMonitor",
  ]) {
    state[name] = () => {};
  }
  runInNewContext(compiled, state);
  return { state, stopped, tick: (now) => tick(now) };
}

test("export preview arms the right bracket when forward playback starts within the range", () => {
  for (const frame of [10, 15, 20]) {
    const { state } = player(frame);
    state.applyPlaybackMode(1);
    assert.equal(state.cuePlaybackEndFrameRef.current, 20);
    state.applyPlaybackMode(0);
    assert.equal(state.cuePlaybackEndFrameRef.current, null);
    state.applyPlaybackMode(1);
    assert.equal(state.cuePlaybackEndFrameRef.current, 20);
  }
});

test("playback outside the range, reverse playback and playback without brackets stay unbounded", () => {
  for (const [frame, mode, range] of [
    [9, 1, { startFrame: 10, endFrame: 20 }],
    [21, 1, { startFrame: 10, endFrame: 20 }],
    [15, -1, { startFrame: 10, endFrame: 20 }],
    [15, 1, null],
  ]) {
    const { state } = player(frame, range);
    state.applyPlaybackMode(mode);
    assert.equal(state.cuePlaybackEndFrameRef.current, null);
  }
});

test("slow forward playback preserves the stop point across ticks and stops at the bracket", () => {
  const { state, stopped, tick } = player(15);
  state.applyPlaybackMode("slow-forward");
  tick(160);
  assert.equal(state.seekTargetFrameRef.current, 16);
  assert.equal(state.cuePlaybackEndFrameRef.current, 20);
  tick(960);
  assert.deepEqual(stopped, [20]);
  assert.equal(state.manualPlaybackFrameRef.current, 20);
});

test("editor source monitor keeps its ordinary playback behavior inside brackets", () => {
  for (const mode of [1, "slow-forward"]) {
    const { state, stopped, tick } = player(15, { startFrame: 10, endFrame: 20 }, false);
    state.cuePlaybackEndFrameRef.current = 20;
    state.applyPlaybackMode(mode);
    assert.equal(state.cuePlaybackEndFrameRef.current, null);
    if (mode === "slow-forward") {
      tick(960);
      assert.equal(state.seekTargetFrameRef.current, 21);
      assert.deepEqual(stopped, []);
    }
  }
});
