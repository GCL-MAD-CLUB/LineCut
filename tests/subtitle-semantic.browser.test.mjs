// Run from a blank Vite-served page after installing the React refresh preamble:
// await (await import('/tests/subtitle-semantic.browser.test.mjs')).runSubtitleSemanticTests()
// Real hooks and controls; native inference is held pending to exercise cancellation races.
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useSubtitleSemanticSearch } from "../src/application/media/subtitleSemanticSearch.ts";
import { PanelSearch } from "../src/components/common/PanelSearch/PanelSearch.tsx";
import { PanelInstanceProvider } from "../src/runtime/systems/PanelState.tsx";
import { PanelManagerProvider } from "../src/components/common/DockLayout/index.ts";
import { SubtitlePanel } from "../src/components/panels/SubtitlePanel/SubtitlePanel.tsx";
import { useSubtitlePanelState } from "../src/components/panels/SubtitlePanel/subtitlePanelState.ts";
import { usePanelMediaSourceSelection } from "../src/application/media/panelMediaSources.ts";
import {
  TaskProgress,
  createTaskProgress,
  useTaskProgressStatus,
} from "../src/systems/TaskSystem/index.ts";
import { useProjectPort } from "../src/systems/ProjectSystem/index.ts";

const h = React.createElement;
const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
function check(value, message) {
  if (!value) throw new Error(message);
}

async function waitFor(predicate, message) {
  for (let i = 0; i < 120; i++) {
    if (predicate()) return;
    await pause(25);
  }
  check(false, message);
}

export async function runSubtitleSemanticTests() {
  const previous = window.__TAURI_INTERNALS__;
  const indexes = [],
    searches = [],
    cancellations = [];
  let holdSearch = false;
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    unregisterCallback: () => {},
    invoke: (command, args) => {
      if (command === "cancel_task") {
        cancellations.push(args.taskId);
        return Promise.resolve(false);
      }
      if (command === "index_subtitles_semantic") {
        return new Promise((resolve, reject) => indexes.push({ ...args, resolve, reject }));
      }
      if (command === "search_subtitles_semantic") {
        return new Promise((resolve) => {
          searches.push({ ...args, resolve });
          if (!holdSearch) resolve(args.subtitles.map((cue) => ({ id: cue.id, similarity: 0.73 })));
        });
      }
      return Promise.resolve(null);
    },
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let snapshot, duplicateSnapshot, taskStatus;
  let threshold = 0.5,
    duplicate = false;
  let input = {
    enabled: true,
    query: "travel",
    scope: "a",
    subtitles: [
      { id: "a", text: "去旅行" },
      { id: "b", text: "回家" },
    ],
  };
  const clearQuery = () => {
    input = { ...input, query: "" };
    render();
  };
  function Duplicate() {
    duplicateSnapshot = useSubtitleSemanticSearch(
      input.enabled,
      input.query,
      input.subtitles.map((cue) => ({ ...cue, source: cue.source ?? input.scope })),
      input.scope,
      clearQuery,
    );
    return null;
  }
  function Harness() {
    snapshot = useSubtitleSemanticSearch(
      input.enabled,
      input.query,
      input.subtitles.map((cue) => ({ ...cue, source: cue.source ?? input.scope })),
      input.scope,
      clearQuery,
    );
    taskStatus = useTaskProgressStatus("subtitle.semanticIndex");
    return h(
      React.Fragment,
      null,
      h(TaskProgress, { children: null }),
      h(PanelSearch, {
        label: "字幕",
        query: input.query,
        mode: input.enabled ? "semantic" : "filter",
        rule: "contains",
        disabled: false,
        canNavigate: false,
        summary: snapshot.status,
        onQueryChange: (query) => {
          input = { ...input, query };
          render();
        },
        onModeChange: () => {},
        onRuleChange: () => {},
        onNavigate: () => {},
        semantic: {
          threshold,
          available: snapshot.status === "ready" && snapshot.scores.size > 0,
          onThresholdChange: (value) => {
            threshold = value;
            render();
          },
        },
      }),
      duplicate ? h(Duplicate) : null,
    );
  }
  const render = () => flushSync(() => root.render(h(Harness)));
  const change = (next) => {
    input = { ...input, ...next };
    render();
  };
  const cancelledError = {
    errorId: "cancel-test",
    code: "TASK_CANCELLED",
    category: "cancelled",
    detail: "cancelled",
    retryable: false,
  };
  const startScope = async (scope, query = "meaning") => {
    const count = indexes.length;
    change({ enabled: true, scope, query, subtitles: [{ id: scope, text: scope }] });
    await waitFor(() => indexes.length === count + 1, `index starts for ${scope}`);
    return indexes.at(-1);
  };
  try {
    render();
    const slider = host.querySelector('input[type="range"]');
    check(
      slider.disabled && host.querySelector(".panel-search-threshold-input").disabled,
      "threshold stays disabled until results exist",
    );
    check(!host.querySelector(".panel-search-navigation"), "semantic replaces arrows");
    await waitFor(() => indexes.length === 1, "first index starts");
    check(
      taskStatus.count === 1 && !taskStatus.tasks[0].blocking,
      "index is a registered non-blocking task",
    );
    indexes[0].onProgress.onmessage({ phase: "indexing", completed: 1, total: 2 });
    await pause();
    check(
      taskStatus.tasks[0].percent === 50 &&
        host.querySelector(".topbar-progress-fill").style.width === "50%",
      "native progress updates real task bar",
    );
    change({ query: "family" });
    await pause(400);
    check(
      indexes.length === 1 && cancellations.length === 0,
      "query edits preserve in-flight indexing",
    );
    indexes[0].resolve();
    await waitFor(() => snapshot.status === "ready", "newest query produces results");
    check(
      searches[0].query === "family" && taskStatus.count === 0 && !slider.disabled,
      "index completion uses current query and enables slider",
    );
    const thresholdInput = host.querySelector(".panel-search-threshold-input");
    const editThreshold = async (text) => {
      thresholdInput.focus();
      await pause();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
        thresholdInput,
        text,
      );
      thresholdInput.dispatchEvent(new Event("input", { bubbles: true }));
      await pause();
      thresholdInput.blur();
      await pause();
    };
    await editThreshold("2");
    check(threshold === 1, "upper bound clamps");
    await editThreshold("-1");
    check(threshold === 0, "lower bound clamps");
    await editThreshold("0.556");
    check(threshold === 0.56 && slider.value === "0.56", "controls share precision");
    await editThreshold("invalid");
    check(threshold === 0.56, "invalid value restores threshold");
    check(
      indexes.length === 1 && searches.length === 1,
      "threshold never repeats indexing or inference",
    );

    holdSearch = true;
    change({ query: "first" });
    await waitFor(() => searches.length === 2, "first retrieval starts");
    change({ query: "second" });
    searches[1].resolve([{ id: "a", similarity: 0.99 }]);
    await waitFor(() => searches.length === 3, "current retrieval follows stale result");
    check(snapshot.scores.size === 0, "obsolete retrieval cannot publish scores");
    searches[2].resolve([{ id: "a", similarity: 0.73 }]);
    await waitFor(() => snapshot.status === "ready", "current retrieval finishes");
    holdSearch = false;

    let job = await startScope("cancel-same");
    await taskStatus.tasks[0].cancel();
    await pause();
    check(input.query === "" && snapshot.status === "idle", "matching cancellation clears query");
    check(
      taskStatus.count === 1 && taskStatus.tasks[0].isCancelling,
      "slot remains owned until native work settles",
    );
    const previousCancelCount = cancellations.length;
    job.onProgress.onmessage({ phase: "indexing", completed: 0, total: 1 });
    check(
      cancellations.length > previousCancelCount,
      "late native registration retries cancellation",
    );
    job.reject(cancelledError);
    await waitFor(() => taskStatus.count === 0, "cancelled task leaves queue");
    change({ query: "meaning" });
    await waitFor(() => indexes.at(-1) !== job, "retyping cancelled query starts a fresh job");
    indexes.at(-1).resolve();
    await waitFor(() => snapshot.status === "ready", "fresh task completes");

    job = await startScope("cancel-new-query", "old");
    change({ query: "new" });
    await taskStatus.tasks[0].cancel();
    await pause();
    check(input.query === "new", "cancelling obsolete query preserves current query");
    job.reject(cancelledError);
    await waitFor(() => indexes.at(-1) !== job, "cancelled obsolete task is replaced once");
    indexes.at(-1).resolve();
    await waitFor(() => snapshot.status === "ready", "replacement retrieves new query");
    check(searches.at(-1).query === "new", "replacement uses new query");

    job = await startScope("switch-from");
    const indexCount = indexes.length,
      searchCount = searches.length;
    change({ scope: "switch-to", subtitles: [{ id: "next", text: "next" }], query: "current" });
    await pause(400);
    check(indexes.length === indexCount, "scope switch waits for current background index");
    job.resolve();
    await waitFor(() => indexes.length === indexCount + 1, "changed scope creates one new job");
    check(searches.length === searchCount, "old scope produces no retrieval");
    indexes.at(-1).resolve();
    await waitFor(() => snapshot.status === "ready", "new scope retrieves");

    job = await startScope("cancel-changed-scope");
    change({
      scope: "cancel-target",
      subtitles: [{ id: "target", text: "target" }],
      query: "target-query",
    });
    await taskStatus.tasks[0].cancel();
    await pause();
    check(input.query === "target-query", "obsolete scope cancellation preserves query");
    job.reject(cancelledError);
    await waitFor(() => indexes.at(-1) !== job, "cancelled scope starts current task");
    indexes.at(-1).resolve();
    await waitFor(() => snapshot.status === "ready", "current scope completes");

    for (const exit of [{ enabled: false }, { query: "" }]) {
      job = await startScope(`exit-${JSON.stringify(exit)}`);
      const beforeIndexes = indexes.length,
        beforeSearches = searches.length;
      change({ scope: "changed-but-inactive", ...exit });
      job.resolve();
      await pause(450);
      check(
        indexes.length === beforeIndexes &&
          searches.length === beforeSearches &&
          snapshot.status === "idle",
        "inactive state suppresses all follow-up even after scope change",
      );
    }
    job = await startScope("exit-and-return");
    change({ enabled: false });
    await pause();
    change({ enabled: true, query: "returned" });
    job.resolve();
    await waitFor(
      () => snapshot.status === "ready",
      "completion reads present mode instead of history",
    );
    check(
      searches.at(-1).query === "returned",
      "returning before completion searches current query",
    );

    duplicate = true;
    job = await startScope("deduplicated");
    await pause(400);
    check(
      taskStatus.count === 1 && indexes.at(-1) === job,
      "two panels share one scope index task",
    );
    job.resolve();
    await waitFor(
      () => snapshot.status === "ready" && duplicateSnapshot.status === "ready",
      "shared indexing serves both panels",
    );
    duplicate = false;
    render();

    const blocker = await createTaskProgress({
      operation: "export.run",
      label: "test blocker",
      current: 0,
      total: 1,
    });
    const beforeQueued = indexes.length;
    change({ scope: "queued-cancel", subtitles: [{ id: "q", text: "q" }], query: "queued" });
    await waitFor(() => taskStatus.count === 1, "index is queued");
    check(taskStatus.tasks[0].state === "queued", "queue exposes task before native work");
    await taskStatus.tasks[0].cancel();
    await pause();
    check(
      input.query === "" && indexes.length === beforeQueued,
      "queued cancellation clears matching query without native work",
    );
    blocker.remove();
    return "Passed: task progress, non-blocking indexing, latest-query retrieval, cancellation and scope transitions, deduplication, queued cancellation, threshold controls";
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    window.__TAURI_INTERNALS__ = previous;
  }
}

export async function runSubtitleSemanticTableTests() {
  const previous = window.__TAURI_INTERNALS__;
  const requests = [];
  const indexes = [];
  let holdIndex = true;
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    unregisterCallback: () => {},
    convertFileSrc: (path) => path,
    invoke: async (command, args) => {
      if (command === "load_project_states") return {};
      if (command === "plugin:event|listen") return 1;
      if (command === "index_subtitles_semantic") {
        indexes.push(args);
        if (holdIndex)
          return new Promise((resolve) => {
            args.resolve = resolve;
          });
        return null;
      }
      if (command === "search_subtitles_semantic") {
        requests.push(args);
        return args.subtitles.map((cue) => ({
          id: cue.id,
          similarity: cue.text.startsWith("b ")
            ? cue.text.includes("later")
              ? 0.95
              : 0.65
            : cue.text.includes("later")
              ? 0.9
              : 0.6,
        }));
      }
      return null;
    },
  };
  const projects = ["a", "b"].map((id) => ({
    asset: {
      id,
      path: `/${id}.mp4`,
      file_name: `${id}.mp4`,
      duration_us: 10_000_000,
      video_stream_index: 0,
      audio_stream_index: null,
      fingerprint: id,
    },
    streams: [{ index: 0, codec_type: "video", avg_frame_rate: "24/1" }],
    tracks: [{ id: `${id}-1`, kind: "text", cue_count: 2, codec: "srt" }],
    cues: {
      [`${id}-1`]: [1, 2].map((sequence) => ({
        id: `cue-${sequence}`,
        track_id: `${id}-1`,
        sequence,
        start_us: sequence * 1_000_000,
        end_us: (sequence + 1) * 1_000_000,
        plain_text: `${id} ${sequence === 1 ? "earlier" : "later"}`,
      })),
    },
    proxy_path: null,
  }));
  const workspace = {
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
      active_track_id: "a-1",
      detached_video_ids: [],
      preview: { use_proxy: false },
    },
    subtitles: {},
    storyboards: {},
  };
  const host = document.createElement("div");
  host.style.cssText = "width:1400px;height:700px";
  document.body.append(host);
  const root = createRoot(host);
  let port, source, subtitle;
  function Harness() {
    port = useProjectPort([], ["projectOpened", "projectClosed"]);
    source = usePanelMediaSourceSelection("subtitles");
    subtitle = useSubtitlePanelState((state) => state);
    return h(
      "div",
      { className: "dock-panel-surface active", style: { width: 1400, height: 700 } },
      h(SubtitlePanel),
    );
  }
  const act = async (action) => {
    flushSync(action);
    await pause(60);
  };
  const headers = () => [...host.querySelectorAll('[role="columnheader"]')];
  const similarityHeader = () => headers().find((element) => element.textContent === "匹配度");
  const rowTexts = () =>
    [...host.querySelectorAll(".cue-subtitle-copy")].map((element) => element.textContent);
  try {
    await act(() =>
      root.render(
        h(
          PanelManagerProvider,
          {
            initialState: {
              instances: [{ id: "semantic-sub", type: "subtitles", params: {} }],
              layout: {
                root: { type: "area", areaId: "main" },
                areas: { main: { tabs: ["semantic-sub"], activePanelId: "semantic-sub" } },
              },
              focusedPanelId: "semantic-sub",
            },
          },
          h(PanelInstanceProvider, { instanceId: "semantic-sub" }, h(Harness)),
        ),
      ),
    );
    await act(() => port.projectOpened(workspace, "/semantic-test.lcp", "semantic-test"));
    await act(() => source.selectVideo("a", "a-1"));
    check(!similarityHeader(), "similarity column is initially hidden");
    await act(() => {
      subtitle.setSearchMode("semantic");
      subtitle.setQuery("meaning");
    });
    check(similarityHeader(), "nonempty semantic query immediately shows match column");
    check(!similarityHeader().hasAttribute("aria-sort"), "pending index preserves ordinary sort");
    check(rowTexts()[0] === "a earlier", "pending index retains original row order");
    check(
      [...host.querySelectorAll(".cue-similarity-cell")].every((cell) => cell.textContent === "-"),
      "pending match cells display placeholders",
    );
    check(
      host.querySelector('[aria-label="调整语义匹配度阈值"]').disabled,
      "threshold disabled while indexing",
    );
    await waitFor(() => indexes.length === 1, "native index starts in background");
    check(
      indexes[0].subtitles.every((cue) => cue.source),
      "file identity is supplied to native indexing",
    );
    holdIndex = false;
    indexes[0].resolve();
    await waitFor(
      () => requests.length === 1 && similarityHeader()?.getAttribute("aria-sort") === "descending",
      "result changes sort after indexing",
    );
    check(
      similarityHeader()?.getAttribute("aria-sort") === "descending",
      "first semantic result selects descending similarity sort",
    );
    check(rowTexts()[0] === "a later", "higher score precedes chronological first cue");
    check(
      host.querySelector('[aria-label="调整匹配度列宽"]'),
      "similarity column has a resize handle",
    );
    check(
      host
        .querySelector(".subtitle-list-frame")
        .style.getPropertyValue("--subtitle-col-similarity") === "80px",
      "narrow default column width",
    );
    await act(() =>
      headers()
        .find((element) => element.textContent === "媒体开始")
        .querySelector("button")
        .click(),
    );
    check(
      !similarityHeader().hasAttribute("aria-sort") && rowTexts()[0] === "a earlier",
      "ordinary sort replaces similarity sort",
    );
    await act(() => subtitle.setSemanticThreshold(0.8));
    check(
      rowTexts().length === 1 && rowTexts()[0] === "a later",
      "threshold filters existing results",
    );
    check(requests.length === 1, "threshold filtering does not re-run inference");
    await act(() => source.toggleSource("b", "b-1"));
    await act(() => {
      subtitle.setSearchMode("semantic");
      subtitle.setQuery("meaning");
    });
    await pause(500);
    const labels = headers().map((element) => element.textContent);
    check(
      labels.indexOf("来源") + 1 === labels.indexOf("字幕") &&
        labels.indexOf("字幕") + 1 === labels.indexOf("匹配度"),
      "column order is source, subtitle, match",
    );
    const sourceHeader = () => headers().find((element) => element.textContent === "来源");
    const clickSource = () => act(() => sourceHeader().querySelector("button").click());
    const globalMatchOrder = "b later|a later|b earlier|a earlier";
    check(
      rowTexts().join("|") === globalMatchOrder &&
        sourceHeader().getAttribute("aria-sort") === "none",
      "semantic results disable source grouping and rank across all videos",
    );
    check(!sourceHeader().querySelector("svg"), "disabled source sorting has no arrow");
    await clickSource();
    check(
      rowTexts().join("|") === "a later|a earlier|b later|b earlier" &&
        sourceHeader().getAttribute("aria-sort") === "ascending",
      "none cycles to ascending source grouping",
    );
    await clickSource();
    check(
      rowTexts().join("|") === "b later|b earlier|a later|a earlier" &&
        sourceHeader().getAttribute("aria-sort") === "descending" &&
        similarityHeader().getAttribute("aria-sort") === "descending",
      "ascending cycles to descending independently of match sorting",
    );
    await clickSource();
    check(
      rowTexts().join("|") === globalMatchOrder &&
        sourceHeader().getAttribute("aria-sort") === "none",
      "descending cycles to none and restores global match order",
    );
    await clickSource();
    await act(() => subtitle.setQuery("new meaning"));
    check(
      sourceHeader().getAttribute("aria-sort") === "ascending",
      "pending query keeps existing source sort",
    );
    await waitFor(
      () => requests.length === 3 && sourceHeader().getAttribute("aria-sort") === "none",
      "new semantic result resets source sorting to none",
    );
    await act(() => subtitle.setSearchMode("filter"));
    check(!similarityHeader(), "leaving semantic mode restores ordinary columns");
    return "Passed: column visibility/order/width, global semantic ranking, three-state source sort, ordinary sort, threshold filtering";
  } finally {
    if (port) await act(() => port.projectClosed());
    flushSync(() => root.unmount());
    host.remove();
    window.__TAURI_INTERNALS__ = previous;
  }
}
