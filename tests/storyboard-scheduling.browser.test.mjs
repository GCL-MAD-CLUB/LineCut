// Run against the Vite development server from a blank page (for example /package.json):
// const refresh = (await import('/@react-refresh')).default; refresh.injectIntoGlobalHook(window);
// window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
// window.__vite_plugin_react_preamble_installed__ = true;
// await (await import('/tests/storyboard-scheduling.browser.test.mjs')).runStoryboardSchedulingTests()
// This harness mounts the real storyboard detection hook and the real task progress bar with mocked
// native commands, so it observes the three-slot scheduler through the UI instead of through stubbed
// listeners. Reload the page before re-running after a failure: the task store and the in-flight
// detection registry are module-level and cannot be reset.
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  TaskProgress,
  cancelAllTaskProgress,
  createTaskProgress,
  useTaskProgressStatus,
} from "../src/systems/TaskSystem/index.ts";
import { useProjectPort, getProjectWorkspaceSnapshot } from "../src/systems/ProjectSystem/index.ts";
import { useStoryboardDetection } from "../src/components/panels/StoryboardPanel/hooks/useStoryboardDetection.tsx";
import { emptyStoryboard } from "../src/core/editor/multiSource.ts";

const h = React.createElement;
const VIDEO_IDS = ["a", "b", "c", "d", "e"];
const DETECTION_RESULT = { shots: [], frame_rate: 24 };

const pause = () => new Promise((resolve) => setTimeout(resolve, 50));

function equal(actual, expected, message) {
  const serialize = (value) =>
    JSON.stringify(value, (_, entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map((key) => [key, entry[key]]),
          )
        : entry,
    );
  if (serialize(actual) !== serialize(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

function workspace() {
  const projects = VIDEO_IDS.map((id) => ({
    asset: {
      id,
      path: `/${id}.mp4`,
      file_name: `${id}.mp4`,
      duration_us: 10_000_000,
      video_stream_index: 0,
      audio_stream_index: null,
      fingerprint: "fp",
    },
    streams: [{ index: 0, codec_type: "video", avg_frame_rate: "24/1" }],
    tracks: [],
    cues: {},
    proxy_path: null,
  }));
  return {
    projects,
    media_bin: {
      folders: [],
      items: projects.map(({ asset }) => ({
        id: asset.id,
        kind: "video",
        enabled: true,
        offline: false,
        path: asset.path,
        file_name: asset.file_name,
        origin: "imported",
      })),
    },
    editor: {
      active_video_id: "a",
      active_track_id: "",
      detached_video_ids: [],
      preview: { use_proxy: false },
    },
    subtitles: {},
    storyboards: {},
  };
}

function manualStoryboard() {
  return {
    ...emptyStoryboard(),
    shots: [
      {
        id: "shot-1",
        sequence: 1,
        start_frame: 0,
        end_frame: 120,
        start_us: 0,
        end_us: 5_000_000,
      },
    ],
    shotAnnotations: { "shot-1": { title: "manual", rating: 5, retained: true } },
  };
}

export async function runStoryboardSchedulingTests() {
  const previousNative = window.__TAURI_INTERNALS__;
  const snapshots = {};
  const results = [];
  let detections = [];
  let cancelledTasks = [];
  let directHandles = [];
  let analyzeStarted = false;

  window.__TAURI_INTERNALS__ = {
    convertFileSrc: (path) => path,
    transformCallback: () => 1,
    invoke: async (command, args) => {
      if (command === "plugin:event|listen") return 1;
      if (command === "load_project_states") return {};
      if (command === "cancel_task") {
        cancelledTasks.push(args.taskId);
        return true;
      }
      if (command === "detect_storyboard_shots") {
        return new Promise((resolve) => {
          detections.push({
            assetId: args.assetId,
            taskId: args.taskId,
            settle: resolve,
            settled: false,
          });
        });
      }
      return null;
    },
  };

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  function Bridge() {
    snapshots.port = useProjectPort(
      ["projectId", "storyboards"],
      ["projectOpened", "projectClosed", "storyboardUpdated"],
    );
    return null;
  }

  function Probe() {
    const detection = useStoryboardDetection();
    const status = useTaskProgressStatus();
    snapshots.detection = detection;
    snapshots.tasks = status.tasks;
    return h(React.Fragment, null, h(TaskProgress, null), detection.detectionDialog);
  }

  const act = async (callback) => {
    flushSync(callback);
    await pause();
  };

  const waitFor = async (predicate, message) => {
    for (let index = 0; index < 100 && !predicate(); index += 1) await pause();
    if (!predicate()) throw new Error(message);
  };

  const detectCalls = (assetId) => detections.filter((entry) => entry.assetId === assetId).length;
  const taskLabel = (assetId) => `分镜识别 ${assetId}.mp4`;
  const taskState = (assetId) => {
    const view = snapshots.tasks.find((task) => task.label === taskLabel(assetId));
    return view ? view.state : null;
  };
  const runningCount = () => snapshots.tasks.filter((task) => task.state === "running").length;
  const progressText = () =>
    document.querySelector(".topbar-progress-multi > span")?.textContent ?? null;
  const trackTitles = () =>
    [...document.querySelectorAll(".topbar-progress-track")].map((track) => track.title);
  const conflictDialog = () =>
    document.querySelector(".storyboard-detection-conflict-dialog") ?? null;

  function resolveDetection(assetId, result = DETECTION_RESULT) {
    const entry = detections.find(
      (candidate) => candidate.assetId === assetId && !candidate.settled,
    );
    if (!entry) throw new Error(`No pending detection for ${assetId}`);
    entry.settled = true;
    entry.settle(result);
  }

  async function dismissConflict() {
    const dialog = conflictDialog();
    if (!dialog) return false;
    const cancel = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent === "取消",
    );
    if (cancel) await act(() => cancel.click());
    return true;
  }

  // Settle every in-flight detection and let the queue run down, so each scenario starts clean.
  async function drain() {
    for (let round = 0; round < 40; round += 1) {
      await dismissConflict();
      for (const entry of detections.filter((candidate) => !candidate.settled)) {
        entry.settled = true;
        entry.settle(DETECTION_RESULT);
      }
      for (const handle of directHandles.splice(0)) handle.remove();
      await pause();
      // A conflict dialog can outlive its task (it is removed before the prompt is answered),
      // so an idle task list alone does not mean the scheduler is settled.
      if (snapshots.tasks.length === 0 && !conflictDialog()) {
        detections = [];
        cancelledTasks = [];
        analyzeStarted = false;
        return;
      }
    }
    throw new Error(`Scheduler did not drain: ${snapshots.tasks.length} task(s) left`);
  }

  async function openScenario(index) {
    await act(() => snapshots.port.projectClosed());
    await act(() =>
      snapshots.port.projectOpened(workspace(), `/sched-${index}.lcut`, `sched-${index}`),
    );
    equal(snapshots.tasks.length, 0, "scenario starts with an idle scheduler");
  }

  try {
    await act(() => root.render(h(React.Fragment, null, h(Bridge), h(Probe))));

    await drain();
    await openScenario(1);
    await act(() => snapshots.detection.requestDetection(VIDEO_IDS, true));
    await waitFor(() => detections.length === 3, "three detections should start at once");
    equal(detections.length, 3, "exactly three detections hold the slots");
    equal(
      [...new Set(detections.map((entry) => entry.assetId))].sort().join(","),
      "a,b,c",
      "the first three sources hold the slots",
    );
    equal(detectCalls("d") + detectCalls("e"), 0, "waiting sources start no native work");
    resolveDetection("b");
    await waitFor(() => detectCalls("d") === 1, "a settling detection refills its slot");
    resolveDetection("a");
    resolveDetection("c");
    await waitFor(() => detectCalls("e") === 1, "the second freed slot refills");
    for (const id of VIDEO_IDS) equal(detectCalls(id), 1, `${id} ran exactly once`);
    results.push("three storyboard detections run at once and queued sources refill freed slots");

    await drain();
    await openScenario(2);
    await act(() => snapshots.detection.requestDetection(VIDEO_IDS, true));
    await waitFor(() => runningCount() === 3 && detections.length === 3, "three detections run");
    await waitFor(
      () => progressText() === "正在执行 3 项操作，2 项排队中...",
      "progress should report three running and two queued",
    );
    const stacked = trackTitles();
    equal(stacked.length, 3, "the stack renders one track per slot");
    equal(
      stacked.some((title) => title.includes("排队中")),
      false,
      "running tasks occupy every visible slot",
    );
    results.push("progress bar reports running and queued counts and shows the running slots");

    await drain();
    await openScenario(3);
    await act(() => snapshots.detection.requestDetection(VIDEO_IDS, true));
    await waitFor(() => detections.length === 3, "three detections should start");
    resolveDetection("b");
    await waitFor(() => taskState("d") === "running", "the freed slot runs the next queued source");
    equal(taskState("e"), "queued", "the remaining source stays queued");
    equal(
      ["a", "c"].every((id) => detections.some((entry) => entry.assetId === id && !entry.settled)),
      true,
      "no other running detection settled",
    );
    results.push("an out-of-order completion refills exactly one slot");

    await drain();
    await openScenario(4);
    await act(() => snapshots.detection.requestDetection(["a", "b", "c", "d"], true));
    await waitFor(() => detections.length === 3, "three detections should start");
    await act(() =>
      snapshots.port.storyboardUpdated("a:a:fp", "manual edit", () => manualStoryboard()),
    );
    resolveDetection("a", { shots: manualStoryboard().shots, frame_rate: 24 });
    await waitFor(() => Boolean(conflictDialog()), "the completion conflict should prompt");
    equal(detectCalls("d"), 1, "the freed slot starts the queued source before any answer");
    equal(taskState("d"), "running", "the queued source runs while the dialog awaits an answer");
    const pending = conflictDialog();
    const cancelButton = [...pending.querySelectorAll("button")].find(
      (button) => button.textContent === "取消",
    );
    await act(() => cancelButton.click());
    equal(Boolean(conflictDialog()), false, "cancelling closes the dialog");
    const storyboard = getProjectWorkspaceSnapshot().storyboards["a:a:fp"];
    equal(
      storyboard.shotAnnotations["shot-1"].rating,
      5,
      "manual annotations survive cancellation",
    );
    equal(storyboard.shots.length, 1, "cancelling does not overwrite the existing cut");
    results.push("a completion conflict releases its slot before the answer and preserves edits");

    await drain();
    await openScenario(5);
    await act(() => snapshots.detection.requestDetection(["a", "b", "c"], true));
    await waitFor(() => detections.length === 3, "three detections should start");
    let cancelling;
    await act(() => {
      cancelling = cancelAllTaskProgress();
    });
    await act(() => snapshots.detection.requestDetection(["d"], true));
    equal(detectCalls("d"), 0, "work submitted during cancellation starts no native work");
    equal(taskState("d"), "queued", "new work waits for cancellation to settle");
    for (const id of ["a", "b", "c"]) resolveDetection(id);
    await cancelling;
    await waitFor(() => detectCalls("d") === 1, "queued work starts once cancellation settles");
    equal(taskState("d"), "running", "the newly submitted detection owns a slot");
    equal(cancelledTasks.length, 3, "only the running detections reached the backend canceller");
    results.push("cancelling all tasks pauses refilling but resumes newly submitted work");

    await drain();
    await openScenario(6);
    await act(() => snapshots.detection.requestDetection(["a", "b", "c", "d"], true));
    await waitFor(() => detections.length === 3, "three detections should start");
    await act(() => snapshots.detection.requestDetection(["a"], true));
    await act(() => snapshots.detection.requestDetection(["d"], true));
    equal(detectCalls("a"), 1, "a running source is not submitted twice");
    equal(detectCalls("d"), 0, "a queued source is not duplicated");
    await act(() => {
      snapshots.detection.requestDetection(["e"], true);
      snapshots.detection.requestDetection(["e"], true);
    });
    await pause();
    equal(
      snapshots.tasks.filter((task) => task.label === taskLabel("e")).length,
      1,
      "a double request creates a single task",
    );
    equal(detectCalls("e"), 0, "the deduplicated request stays queued");
    resolveDetection("a");
    await waitFor(() => detectCalls("d") === 1, "the earlier queued source takes the freed slot");
    resolveDetection("b");
    await waitFor(() => detectCalls("e") === 1, "the deduplicated source runs once a slot frees");
    equal(detections.filter((entry) => entry.assetId === "e").length, 1, "it runs only once");
    results.push("duplicate detection requests are deduplicated while pending, queued or running");

    await drain();
    await openScenario(7);
    await act(() => snapshots.detection.requestDetection(["a", "b", "c"], true));
    await waitFor(() => detections.length === 3, "three detections should start");
    analyzeStarted = false;
    const analyze = createTaskProgress({
      operation: "media.analyze",
      resourceKey: "analyze",
      label: "分析媒体",
      current: 0,
      total: 3,
      listener: async () => {
        analyzeStarted = true;
        return () => {};
      },
    });
    analyze.then((handle) => directHandles.push(handle));
    await act(() => snapshots.detection.requestDetection(["d"], true));
    await pause();
    equal(analyzeStarted, false, "another operation waits for the running detections");
    equal(detectCalls("d"), 0, "a detection queued behind the exclusive operation waits");
    resolveDetection("a");
    await pause();
    equal(analyzeStarted, false, "the exclusive operation still waits with two detections running");
    resolveDetection("b");
    await pause();
    equal(analyzeStarted, false, "the exclusive operation still waits with one detection running");
    resolveDetection("c");
    await waitFor(() => analyzeStarted, "the exclusive operation starts once detections drain");
    equal(detectCalls("d"), 0, "the exclusive operation runs alone");
    await waitFor(
      () => progressText() === "正在执行 1 项操作，1 项排队中...",
      "progress should report one running and one queued task",
    );
    const mixed = trackTitles();
    equal(mixed.length, 2, "two tracks render for one running and one queued task");
    equal(mixed[0].startsWith("分析媒体"), true, "the running task renders first");
    equal(mixed[1], "分镜识别 d.mp4 排队中", "the queued detection renders after it");
    for (const handle of directHandles.splice(0)) handle.remove();
    await waitFor(
      () => detectCalls("d") === 1,
      "the detection starts after the exclusive operation",
    );
    results.push("a non-storyboard operation keeps an exclusive slot and blocks later detections");

    return results;
  } finally {
    try {
      await drain();
    } catch {
      // Best effort: draining must never mask the failure that brought us here.
    }
    flushSync(() => root.unmount());
    host.remove();
    window.__TAURI_INTERNALS__ = previousNative;
  }
}
