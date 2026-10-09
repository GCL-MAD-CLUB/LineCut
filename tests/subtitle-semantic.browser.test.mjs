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
import { useProjectPort } from "../src/systems/ProjectSystem/index.ts";

const h = React.createElement;
const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
function check(value, message) {
  if (!value) throw new Error(message);
}

export async function runSubtitleSemanticTests() {
  const previous = window.__TAURI_INTERNALS__;
  const calls = [];
  const cancellations = [];
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    unregisterCallback: () => {},
    invoke: (command, args) => {
      if (command === "cancel_task") {
        cancellations.push(args.taskId);
        return Promise.resolve(true);
      }
      if (command === "search_subtitles_semantic") {
        return new Promise((resolve) => calls.push({ ...args, resolve }));
      }
      return Promise.resolve(null);
    },
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let snapshot;
  let threshold = 0.5;
  let input = { enabled: true, query: "travel", subtitles: [{ id: "a", text: "去旅行" }] };
  function Harness() {
    snapshot = useSubtitleSemanticSearch(input.enabled, input.query, input.subtitles);
    return h(PanelSearch, {
      label: "字幕",
      query: input.query,
      mode: "semantic",
      rule: "contains",
      disabled: false,
      canNavigate: false,
      summary: snapshot.status,
      onQueryChange: () => {},
      onModeChange: () => {},
      onRuleChange: () => {},
      onNavigate: () => {},
      semantic: {
        threshold,
        onThresholdChange: (value) => {
          threshold = value;
          render();
        },
      },
    });
  }
  const render = () => flushSync(() => root.render(h(Harness)));
  try {
    render();
    check(snapshot.status === "pending", "search must remain pending until all indexing completes");
    check(!host.querySelector(".panel-search-navigation"), "semantic replaces both arrows");
    check(!host.querySelector(".panel-search-rule"), "text rules do not apply to semantic search");
    const slider = host.querySelector('input[type="range"]');
    const thresholdInput = host.querySelector(".panel-search-threshold-input");
    check(slider.min === "0" && slider.max === "1", "slider bounds");
    check(thresholdInput.value === "0.50", "default threshold display");
    check(getComputedStyle(thresholdInput).textAlign === "center", "threshold alignment");
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
    check(threshold === 1 && thresholdInput.value === "1.00", "typed threshold clamps upper bound");
    await editThreshold("-1");
    check(threshold === 0, "typed threshold clamps lower bound");
    await editThreshold("0.556");
    check(
      threshold === 0.56 && slider.value === "0.56",
      "input and slider share displayed precision",
    );
    await editThreshold("invalid");
    check(threshold === 0.56, "invalid threshold restores previous value");
    await pause(400);
    check(calls.length === 1, "debounced search starts once");
    calls[0].onProgress.onmessage({ phase: "indexing", completed: 0, total: 1 });
    await pause();
    check(
      snapshot.status === "pending" && snapshot.scores.size === 0,
      "partial indexes cannot produce results",
    );
    input = { ...input, query: "family" };
    render();
    await pause(400);
    check(cancellations.includes(calls[0].taskId), "superseded query cancels native task");
    calls[0].onProgress.onmessage({ phase: "indexing", completed: 1, total: 1 });
    check(cancellations.length >= 2, "late registration acknowledgement retries cancellation");
    calls[0].resolve([{ id: "a", similarity: 0.99 }]);
    await pause();
    check(snapshot.scores.size === 0, "late results must not replace current query");
    calls[1].resolve([{ id: "a", similarity: 0.73 }]);
    await pause();
    check(
      snapshot.status === "ready" && snapshot.scores.get("a") === 0.73,
      "current results are published",
    );
    threshold = 0.8;
    render();
    await pause(400);
    check(calls.length === 2, "threshold changes reuse existing scores");
    input = { ...input, subtitles: [{ id: "a", text: "edited subtitle" }] };
    render();
    check(
      snapshot.status === "pending" && snapshot.scores.size === 0,
      "edited text invalidates results immediately",
    );
    await pause(400);
    check(
      calls.length === 3 && calls[2].subtitles[0].text === "edited subtitle",
      "edited text is reindexed",
    );
    input = { ...input, enabled: false };
    render();
    check(
      snapshot.status === "idle" && snapshot.scores.size === 0,
      "leaving semantic mode clears visible results",
    );
    check(cancellations.includes(calls[2].taskId), "leaving semantic mode cancels indexing");
    calls[2].resolve([]);
    await pause();
    return "Passed: controls, progress gating, debounce, cancellation races, threshold reuse, text invalidation, mode exit";
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    window.__TAURI_INTERNALS__ = previous;
  }
}

export async function runSubtitleSemanticTableTests() {
  const previous = window.__TAURI_INTERNALS__;
  const requests = [];
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    unregisterCallback: () => {},
    convertFileSrc: (path) => path,
    invoke: async (command, args) => {
      if (command === "load_project_states") return {};
      if (command === "plugin:event|listen") return 1;
      if (command === "search_subtitles_semantic") {
        requests.push(args);
        return args.subtitles.map((cue) => ({
          id: cue.id,
          similarity: cue.text.includes("later") ? 0.9 : 0.6,
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
  const similarityHeader = () => headers().find((element) => element.textContent === "相似度");
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
    await pause(500);
    check(
      similarityHeader()?.getAttribute("aria-sort") === "descending",
      "first semantic result selects descending similarity sort",
    );
    check(rowTexts()[0] === "a later", "higher score precedes chronological first cue");
    check(
      host.querySelector('[aria-label="调整相似度列宽"]'),
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
      labels.indexOf("来源") + 1 === labels.indexOf("相似度") &&
        labels.indexOf("相似度") + 1 === labels.indexOf("字幕"),
      "column order is source, similarity, subtitle",
    );
    check(
      rowTexts().join("|") === "a later|a earlier|b later|b earlier",
      "source grouping and descending similarity coexist",
    );
    await act(() =>
      headers()
        .find((element) => element.textContent === "来源")
        .querySelector("button")
        .click(),
    );
    check(
      rowTexts().join("|") === "b later|b earlier|a later|a earlier" &&
        similarityHeader().getAttribute("aria-sort") === "descending",
      "source sort remains independent",
    );
    await act(() => subtitle.setSearchMode("filter"));
    check(!similarityHeader(), "leaving semantic mode restores ordinary columns");
    return "Passed: column visibility/order/width, default relevance sort, ordinary sort, threshold filtering, independent source sort";
  } finally {
    if (port) await act(() => port.projectClosed());
    flushSync(() => root.unmount());
    host.remove();
    window.__TAURI_INTERNALS__ = previous;
  }
}
