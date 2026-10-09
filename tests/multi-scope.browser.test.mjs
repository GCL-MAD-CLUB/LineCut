// Run against the Vite development server from a blank page (for example /package.json):
// const refresh = (await import('/@react-refresh')).default; refresh.injectIntoGlobalHook(window);
// window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
// window.__vite_plugin_react_preamble_installed__ = true;
// await (await import('/scripts/multi-scope.browser.test.mjs')).runMultiScopeTests(true)
// runSourcePlayerTests(url) additionally tests a real Vite-served 10-second, 24fps MP4.
// This harness mounts real React hooks and the source player with mocked native commands.
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { PanelInstanceProvider } from "../src/runtime/systems/PanelState.tsx";
import {
  PanelManagerProvider,
  usePanelManagerState,
} from "../src/components/common/DockLayout/index.ts";
import {
  usePanelMediaSource,
  usePanelMediaSourceSelection,
} from "../src/application/media/panelMediaSources.ts";
import { StoryboardPanel } from "../src/components/panels/StoryboardPanel/StoryboardPanel.tsx";
import { SubtitlePanel } from "../src/components/panels/SubtitlePanel/SubtitlePanel.tsx";
import { useProjectPort, getProjectWorkspaceSnapshot } from "../src/systems/ProjectSystem/index.ts";
import { useStoryboardPanelState } from "../src/components/panels/StoryboardPanel/storyboardPanelState.ts";
import { useSubtitlePanelState } from "../src/components/panels/SubtitlePanel/subtitlePanelState.ts";
import { useStoryboardDetection } from "../src/components/panels/StoryboardPanel/hooks/useStoryboardDetection.tsx";
import { SourceMonitor } from "../src/components/panels/SourceMonitor/SourceMonitor.tsx";
import { useSourceMonitorState } from "../src/components/panels/SourceMonitor/sourceMonitorState.ts";
import { publishEvent } from "../src/runtime/events/react.ts";
import { eventSource } from "../src/runtime/events/EventHub.ts";
import { emptyStoryboard, sourceScope, sourceRowId } from "../src/core/editor/multiSource.ts";

const h = React.createElement;
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
  const projects = ["a", "b"].map((id) => ({
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
    tracks: [1, 2].map((number) => ({
      id: `${id}-${number}`,
      kind: "text",
      cue_count: 2,
      codec: "srt",
    })),
    cues: Object.fromEntries(
      [1, 2].map((number) => [
        `${id}-${number}`,
        [1, 2].map((sequence) => ({
          id: `${id}-${number}-cue-${sequence}`,
          track_id: `${id}-${number}`,
          sequence,
          start_us: sequence * 1_000_000,
          end_us: (sequence + 1) * 1_000_000,
          plain_text: id,
        })),
      ]),
    ),
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
      active_track_id: "a-1",
      detached_video_ids: [],
      preview: { use_proxy: false },
    },
    subtitles: {},
    storyboards: Object.fromEntries(
      projects.map(({ asset }) => [
        `${asset.id}:${asset.id}:fp`,
        {
          ...emptyStoryboard(),
          shots: [1, 2].map((sequence) => ({
            id: `shot-${sequence}`,
            sequence,
            start_frame: (sequence - 1) * 120,
            end_frame: sequence * 120 - 1,
            start_us: (sequence - 1) * 5_000_000,
            end_us: sequence * 5_000_000 - 1,
          })),
        },
      ]),
    ),
  };
}

export async function runMultiScopeTests(fullUi = false) {
  const previousNative = window.__TAURI_INTERNALS__;
  let finishDetection;
  let detectionCalls = 0;
  window.__TAURI_INTERNALS__ = {
    convertFileSrc: (path) => path,
    transformCallback: () => 1,
    invoke: async (command) => {
      if (command === "plugin:event|listen") return 1;
      if (command === "load_project_states") return {};
      if (command === "detect_storyboard_shots") {
        detectionCalls += 1;
        return new Promise((resolve) => {
          finishDetection = resolve;
        });
      }
      return null;
    },
  };
  const snapshots = {};
  const results = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Bridge() {
    snapshots.port = useProjectPort(
      ["projectHistory", "activeVideoId", "activeTrackId"],
      [
        "projectOpened",
        "projectClosed",
        "mediaItemsRemoved",
        "mediaItemsEnabledChanged",
        "projectHistoryJumped",
        "storyboardUpdated",
        "subtitleCuesDeleted",
        "mediaBinEntriesRemoved",
        "mediaProjectsAdded",
      ],
    );
    snapshots.manager = usePanelManagerState((state) => state);
    return null;
  }
  function Panel({ id, kind }) {
    const source = fullUi ? usePanelMediaSourceSelection(kind) : usePanelMediaSource(kind);
    const board = useStoryboardPanelState((state) => state);
    const subtitle = useSubtitlePanelState((state) => state);
    const detection = useStoryboardDetection();
    const context = sourceScope(source.selectedSources.map((entry) => entry.context));
    React.useEffect(() => board.syncVideoContext(context), [context]);
    const trackContext = sourceScope(
      source.selectedSources
        .filter((entry) => entry.trackId)
        .map((entry) => `${entry.context}:${entry.trackId}`),
    );
    React.useEffect(() => subtitle.syncTrackContext(trackContext), [trackContext]);
    snapshots[id] = { source, board, subtitle, detection };
    return h(
      "div",
      { className: "dock-panel-surface active", style: { width: 550, height: 600 } },
      fullUi && h(kind === "storyboard" ? StoryboardPanel : SubtitlePanel),
      detection.detectionDialog,
    );
  }
  const initial = {
    instances: ["board", "sub"].map((id) => ({
      id,
      type: id === "board" ? "storyboard" : "subtitles",
      params: {},
    })),
    layout: {
      root: {
        type: "split",
        axis: "x",
        ratio: 0.5,
        first: { type: "area", areaId: "left" },
        second: { type: "area", areaId: "right" },
      },
      areas: {
        left: { tabs: ["board"], activePanelId: "board" },
        right: { tabs: ["sub"], activePanelId: "sub" },
      },
    },
    focusedPanelId: "board",
  };
  const act = async (callback) => {
    flushSync(callback);
    await pause();
  };
  const reset = async () => {
    await act(() => snapshots.port.projectClosed());
    await act(() => snapshots.port.projectOpened(workspace(), "/audit.lcut", "audit"));
    await act(() => snapshots.board.source.selectVideo("a", "a-1"));
    await act(() => snapshots.sub.source.selectVideo("a", "a-1"));
    await act(() => snapshots.manager.focusPanel("board"));
  };
  const sourceIds = (id) => snapshots[id].source.selectedSources.map((source) => source.videoId);
  const historySize = () => snapshots.port.projectHistory.entries.length;
  try {
    await act(() =>
      root.render(
        h(
          PanelManagerProvider,
          { initialState: initial },
          h(Bridge),
          ...["board", "sub"].map((id) =>
            h(
              PanelInstanceProvider,
              { instanceId: id, key: id },
              h(Panel, { id, kind: id === "board" ? "storyboard" : "subtitles" }),
            ),
          ),
        ),
      ),
    );
    const emptyWorkspace = workspace();
    emptyWorkspace.projects = [];
    emptyWorkspace.media_bin.items = [];
    emptyWorkspace.editor.active_video_id = "";
    emptyWorkspace.editor.active_track_id = "";
    emptyWorkspace.storyboards = {};
    await act(() => snapshots.port.projectOpened(emptyWorkspace, "/empty.lcut", "empty-audit"));
    await act(() => snapshots.port.mediaProjectsAdded(workspace().projects));
    equal(
      snapshots.board.source.selection.videoId,
      "a",
      "first import initializes panel selection",
    );
    equal(historySize(), 1, "initial preview creates no extra history");
    results.push("first media import initializes panel sources without extra history");
    await reset();
    await act(() => snapshots.board.source.selection.rememberFrame("a", 48));
    await act(() => snapshots.board.board.shotSelectionReplaced(["shot-2"], "shot-2"));
    await act(() => snapshots.port.mediaItemsRemoved(["a"]));
    equal(sourceIds("board"), ["b"], "deleting sole selected source falls back");
    equal(snapshots.port.activeVideoId, "b", "fallback is previewed");
    equal(
      snapshots.board.source.selection.sources.map((source) => source.videoId),
      ["a"],
      "original source is retained",
    );
    equal(historySize(), 1, "fallback adds no history");
    await act(() => snapshots.port.projectHistoryJumped(0));
    equal(sourceIds("board"), ["a"], "undo restores source");
    equal(snapshots.board.source.selection.savedFrame(), 48, "undo restores frame");
    equal(
      [...snapshots.board.board.selectedShotIds],
      ["shot-2"],
      "undo restores selection session",
    );
    equal(snapshots.port.activeVideoId, "a", "undo restores preview");
    await act(() => snapshots.port.projectHistoryJumped(1));
    equal(sourceIds("board"), ["b"], "redo restores fallback");
    equal(historySize(), 1, "redo adds no history");
    results.push("delete / undo / redo sole source, selection, frame, preview and history");

    await reset();
    await act(() => snapshots.board.source.toggleSource("b"));
    const scope = snapshots.board.board.videoContext;
    const selected = sourceRowId("a:a:fp", "shot-2");
    await act(() => snapshots.board.board.shotSelectionReplaced([selected], selected));
    await act(() => snapshots.port.mediaItemsRemoved(["a"]));
    equal(sourceIds("board"), ["b"], "multi-source deletion removes only effective source");
    await act(() => snapshots.port.projectHistoryJumped(0));
    equal(sourceIds("board"), ["a", "b"], "undo restores multi-source scope");
    equal(snapshots.board.board.videoContext, scope, "scope identity survives undo");
    equal(
      [...snapshots.board.board.selectedShotIds],
      [selected],
      "multi-source selection survives undo",
    );
    results.push("delete / undo within multiple sources retains scope and namespaced selection");

    await reset();
    await act(() => snapshots.port.mediaItemsRemoved(["a", "b"]));
    equal(sourceIds("board"), [], "delete all empties effective sources");
    equal(snapshots.port.activeVideoId, "", "delete all clears preview");
    await act(() => snapshots.port.projectHistoryJumped(0));
    equal(sourceIds("board"), ["a"], "undo all restores original source");
    equal(historySize(), 1, "empty preview adds no history");
    results.push("delete all / undo restores panels and preview");

    await reset();
    await act(() => snapshots.port.mediaItemsRemoved(["a"]));
    await act(() => snapshots.board.source.previewSource("b", "b-1", 72));
    await act(() => snapshots.port.projectHistoryJumped(0));
    equal(sourceIds("board"), ["b"], "explicit choice during deletion survives undo");
    equal(
      snapshots.board.source.selection.savedFrame(),
      72,
      "explicit preview retains requested frame",
    );
    results.push("explicit panel choice during deletion takes precedence on undo");

    await reset();
    await act(() => snapshots.sub.subtitle.cueSelectionReplaced(["a-1-cue-2"]));
    await act(() => snapshots.sub.subtitle.setQuery("a"));
    await act(() => snapshots.port.mediaItemsRemoved(["a"]));
    await act(() => snapshots.port.projectHistoryJumped(0));
    equal(
      [...snapshots.sub.subtitle.selectedCueIds],
      ["a-1-cue-2"],
      "subtitle session selection restored",
    );
    equal(snapshots.sub.subtitle.query, "a", "subtitle session filter restored");
    results.push("subtitle panel session survives source deletion / undo");

    await reset();
    const folderWorkspace = workspace();
    folderWorkspace.media_bin.folders = [
      { id: "parent", name: "parent", parent_id: null },
      { id: "child", name: "child", parent_id: "parent" },
    ];
    folderWorkspace.media_bin.items[0].bin_id = "child";
    await act(() => snapshots.port.projectOpened(folderWorkspace, "/folder.lcut", "folder-audit"));
    const foldersBefore = getProjectWorkspaceSnapshot().media_bin.folders;
    await act(() => snapshots.port.mediaBinEntriesRemoved(["parent"], []));
    equal(sourceIds("board"), ["b"], "recursive folder deletion falls back");
    equal(getProjectWorkspaceSnapshot().media_bin.folders, [], "folder descendants deleted");
    await act(() => snapshots.port.projectHistoryJumped(0));
    equal(sourceIds("board"), ["a"], "undo recursive folder restores panel source");
    equal(
      getProjectWorkspaceSnapshot().media_bin.folders,
      foldersBefore,
      "undo restores folder hierarchy",
    );
    results.push("recursive folder deletion / undo restores hierarchy and panel source");

    for (const ripple of [false, true]) {
      await reset();
      await act(() => snapshots.board.source.toggleSource("b"));
      const before = getProjectWorkspaceSnapshot().storyboards;
      await act(() =>
        snapshots.board.board.deleteShots(
          [sourceRowId("a:a:fp", "shot-1"), sourceRowId("b:b:fp", "shot-1")],
          ripple,
        ),
      );
      equal(
        snapshots.board.board.shots.length,
        2,
        "multi-source shot deletion affects both sources",
      );
      equal(
        getProjectWorkspaceSnapshot().storyboards["b:b:fp"].shots[0].start_frame,
        ripple ? 0 : 120,
        "ripple is confined to each source",
      );
      equal(historySize(), 1, "multi-source shot deletion is one history entry");
      await act(() => snapshots.port.projectHistoryJumped(0));
      equal(
        getProjectWorkspaceSnapshot().storyboards,
        before,
        "undo shot deletion restores complete metadata",
      );
      await act(() => snapshots.port.projectHistoryJumped(1));
      equal(snapshots.board.board.shots.length, 2, "redo shot deletion restores both sources");
    }
    results.push("multi-source normal / ripple shot deletion, undo and redo");

    for (const ripple of [false, true]) {
      await reset();
      await act(() => snapshots.sub.source.toggleSource("b"));
      await act(() =>
        snapshots.sub.subtitle.setCueRatings(
          [sourceRowId("a:a:fp:a-1", "a-1-cue-1"), sourceRowId("b:b:fp:b-1", "b-1-cue-1")],
          5,
        ),
      );
      const before = getProjectWorkspaceSnapshot();
      const cursor = snapshots.port.projectHistory.cursor;
      await act(() => {
        for (const videoId of ["a", "b"])
          snapshots.port.subtitleCuesDeleted(
            videoId,
            `${videoId}:${videoId}:fp:${videoId}-1`,
            `${videoId}-1`,
            [`${videoId}-1-cue-1`],
            ripple,
            "multi-cue-delete",
          );
      });
      equal(
        getProjectWorkspaceSnapshot().projects.map((project) => project.tracks[0].cue_count),
        [1, 1],
        "cue deletion updates both track counts",
      );
      equal(
        snapshots.port.projectHistory.cursor,
        cursor + 1,
        "multi-source cue deletion grouped into one undo",
      );
      await act(() => snapshots.port.projectHistoryJumped(cursor));
      const after = getProjectWorkspaceSnapshot();
      equal(after.projects, before.projects, "undo cue deletion restores timings and counts");
      equal(after.subtitles, before.subtitles, "undo cue deletion restores annotations");
      await act(() => snapshots.port.projectHistoryJumped(cursor + 1));
      equal(
        getProjectWorkspaceSnapshot().projects.map((project) => project.tracks[0].cue_count),
        [1, 1],
        "redo cue deletion restores counts",
      );
    }
    results.push(
      "multi-source normal / ripple cue deletion restores timings, counts and annotations",
    );

    await reset();
    await act(() => snapshots.port.mediaItemsEnabledChanged(["a"], false));
    equal(sourceIds("board"), ["b"], "disabled selection falls back");
    await act(() => snapshots.port.projectHistoryJumped(0));
    equal(sourceIds("board"), ["a"], "undo disable restores original source");
    results.push("disable / undo follows deletion recovery");

    await reset();
    await act(() => snapshots.manager.focusPanel("sub"));
    await act(() => snapshots.sub.source.toggleSource("a", "a-2"));
    equal(snapshots.sub.source.activeTrackId, "a-2", "panel chooses track");
    equal(snapshots.port.activeTrackId, "a-2", "preview chooses track");
    equal(historySize(), 1, "explicit track switch records history");
    await act(() => snapshots.port.projectHistoryJumped(0));
    equal(snapshots.sub.source.activeTrackId, "a-1", "undo restores panel track");
    equal(snapshots.port.activeTrackId, "a-1", "undo restores preview track");
    equal(snapshots.board.source.activeTrackId, "a-1", "undo leaves other panel independent");
    await act(() => snapshots.port.projectHistoryJumped(1));
    equal(snapshots.sub.source.activeTrackId, "a-2", "redo restores panel track");
    await act(() => snapshots.manager.focusPanel("board"));
    await act(() => snapshots.manager.focusPanel("sub"));
    equal(historySize(), 1, "focus adds no history");
    results.push("track switch / undo / redo and focus preserve panel independence");

    await reset();
    await act(() => snapshots.manager.focusPanel("sub"));
    await act(() => snapshots.sub.source.toggleSource("a", "a-2"));
    await act(() => snapshots.port.mediaItemsRemoved(["a"]));
    await act(() => snapshots.port.projectHistoryJumped(0));
    equal(sourceIds("sub"), ["a"], "jump across switch and deletion restores source");
    equal(snapshots.sub.source.activeTrackId, "a-1", "jump restores original track");
    await act(() => snapshots.port.projectHistoryJumped(2));
    equal(sourceIds("sub"), ["b"], "redo jump restores deleted source fallback");
    await act(() => snapshots.port.projectHistoryJumped(1));
    equal(snapshots.sub.source.activeTrackId, "a-2", "undo deletion retains earlier track switch");
    equal(historySize(), 2, "history jumps never append synthetic edits");
    results.push("history jumps across track switches and source deletion");

    await reset();
    await act(() => snapshots.port.storyboardUpdated("a:a:fp", "empty", () => emptyStoryboard()));
    await act(() => snapshots.board.detection.requestDetection(["a"], true));
    for (let index = 0; !finishDetection && index < 100; index += 1) await pause();
    equal(detectionCalls, 1, "detection started");
    const manual = workspace().storyboards["a:a:fp"];
    manual.shotAnnotations = { "shot-1": { title: "manual", rating: 5, retained: true } };
    await act(() => snapshots.port.storyboardUpdated("a:a:fp", "manual edit", () => manual));
    await act(() => finishDetection({ shots: manual.shots, frame_rate: 24 }));
    equal(
      Boolean(document.querySelector(".storyboard-detection-conflict-dialog")),
      true,
      "completion conflict prompts again",
    );
    equal(
      getProjectWorkspaceSnapshot().storyboards["a:a:fp"].shotAnnotations["shot-1"].rating,
      5,
      "awaiting confirmation preserves edits",
    );
    await act(() =>
      document.querySelector(".storyboard-detection-conflict-dialog .modal-dialog-confirm").click(),
    );
    equal(detectionCalls, 1, "confirmation uses existing result");
    equal(
      getProjectWorkspaceSnapshot().storyboards["a:a:fp"].shotAnnotations["shot-1"].rating,
      5,
      "merge preserves manual annotations",
    );
    results.push("detection completion conflict reuses dialog and preserves edits on merge");

    for (const mode of ["overwrite", "cancel"]) {
      await reset();
      finishDetection = undefined;
      await act(() => snapshots.port.storyboardUpdated("a:a:fp", "empty", () => emptyStoryboard()));
      await act(() => snapshots.board.detection.requestDetection(["a"], true));
      for (let index = 0; !finishDetection && index < 100; index += 1) await pause();
      await act(() => snapshots.port.storyboardUpdated("a:a:fp", "manual edit", () => manual));
      await act(() => finishDetection({ shots: manual.shots, frame_rate: 24 }));
      equal(snapshots.board.detection.detectionTasks.length, 0, "confirmation releases task queue");
      const buttons = document.querySelectorAll(".storyboard-detection-conflict-dialog button");
      const button = [...buttons].find(
        (entry) => entry.textContent === (mode === "overwrite" ? "覆盖" : "取消"),
      );
      await act(() => button.click());
      equal(
        getProjectWorkspaceSnapshot().storyboards["a:a:fp"].shotAnnotations["shot-1"].rating,
        mode === "overwrite" ? 0 : 5,
        "completion applies confirmed overwrite or cancellation",
      );
      equal(
        Boolean(document.querySelector(".storyboard-detection-conflict-dialog")),
        false,
        "completion dialog closes",
      );
    }
    results.push("completion overwrite / cancel and task queue release");

    await reset();
    finishDetection = undefined;
    await act(() => snapshots.board.detection.requestDetection(["a", "b"]));
    await act(() =>
      [...document.querySelectorAll(".storyboard-detection-conflict-dialog button")]
        .find((button) => button.textContent === "覆盖")
        .click(),
    );
    for (let index = 0; !finishDetection && index < 100; index += 1) await pause();
    const finishA = finishDetection;
    finishDetection = undefined;
    await act(() => snapshots.port.storyboardUpdated("b:b:fp", "queued manual edit", () => manual));
    await act(() => finishA({ shots: manual.shots, frame_rate: 24 }));
    for (let index = 0; !finishDetection && index < 100; index += 1) await pause();
    await act(() => finishDetection({ shots: manual.shots, frame_rate: 24 }));
    equal(
      Boolean(document.querySelector(".storyboard-detection-conflict-dialog")),
      true,
      "queued edits also prompt again",
    );
    await act(() =>
      [...document.querySelectorAll(".storyboard-detection-conflict-dialog button")]
        .find((button) => button.textContent === "取消")
        .click(),
    );
    equal(
      getProjectWorkspaceSnapshot().storyboards["b:b:fp"].shotAnnotations["shot-1"].rating,
      5,
      "queued edits preserved on cancel",
    );
    equal(
      Boolean(document.querySelector(".storyboard-detection-conflict-dialog")),
      false,
      "unrelated source edits do not create extra conflicts",
    );
    results.push("edits made while detection is queued require renewed confirmation");

    await reset();
    finishDetection = undefined;
    await act(() => snapshots.port.storyboardUpdated("a:a:fp", "empty", () => emptyStoryboard()));
    await act(() => snapshots.board.detection.requestDetection(["a"], true));
    for (let index = 0; !finishDetection && index < 100; index += 1) await pause();
    await act(() => snapshots.port.mediaItemsRemoved(["a"]));
    const deletionCursor = snapshots.port.projectHistory.cursor;
    await act(() => finishDetection({ shots: manual.shots, frame_rate: 24 }));
    equal(
      Boolean(getProjectWorkspaceSnapshot().storyboards["a:a:fp"]),
      false,
      "deleted source ignores detection result",
    );
    equal(
      snapshots.port.projectHistory.cursor,
      deletionCursor,
      "late detection does not append history",
    );
    equal(
      Boolean(document.querySelector(".storyboard-detection-conflict-dialog")),
      false,
      "deleted source has no completion dialog",
    );
    await act(() => snapshots.port.projectHistoryJumped(deletionCursor - 1));
    equal(
      getProjectWorkspaceSnapshot().storyboards["a:a:fp"].shots,
      [],
      "undo deletion does not apply discarded late result",
    );
    results.push("deletion during detection discards late result and preserves undo");

    await reset();
    finishDetection = undefined;
    await act(() => snapshots.port.storyboardUpdated("a:a:fp", "empty", () => emptyStoryboard()));
    await act(() => snapshots.board.detection.requestDetection(["a"], true));
    for (let index = 0; !finishDetection && index < 100; index += 1) await pause();
    await act(() => snapshots.port.storyboardUpdated("a:a:fp", "manual edit", () => manual));
    await act(() => finishDetection({ shots: manual.shots, frame_rate: 24 }));
    equal(
      Boolean(document.querySelector(".storyboard-detection-conflict-dialog")),
      true,
      "awaiting completion confirmation",
    );
    await act(() => snapshots.port.mediaItemsRemoved(["a"]));
    equal(
      Boolean(document.querySelector(".storyboard-detection-conflict-dialog")),
      false,
      "deleting confirmation target dismisses expired dialog",
    );
    await act(() => snapshots.port.projectHistoryJumped(snapshots.port.projectHistory.cursor - 1));
    equal(
      getProjectWorkspaceSnapshot().storyboards["a:a:fp"].shotAnnotations["shot-1"].rating,
      5,
      "undo restores manual edits without committing cancelled detection",
    );
    results.push("deleting a pending confirmation target cancels result and preserves undo");
    return results;
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    window.__TAURI_INTERNALS__ = previousNative;
  }
}

// Supply a Vite-served URL of a 10-second 24fps MP4 for real HTMLVideoElement tests.
export async function runSourcePlayerTests(videoUrl) {
  const previousNative = window.__TAURI_INTERNALS__;
  window.__TAURI_INTERNALS__ = {
    convertFileSrc: () => videoUrl,
    transformCallback: () => 1,
    invoke: async (command) =>
      command === "plugin:event|listen" ? 1 : command === "load_project_states" ? {} : null,
  };
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:1000px;height:550px";
  document.body.append(host);
  const root = createRoot(host);
  const state = {};
  function Bridge() {
    state.port = useProjectPort(["activeVideoId"], ["projectOpened", "projectClosed"]);
    state.manager = usePanelManagerState((value) => value);
    return null;
  }
  function Board() {
    state.source = usePanelMediaSource("storyboard");
    return h("div", { id: "keyboard-target", tabIndex: 0 }, "focused panel");
  }
  function MonitorBridge() {
    state.monitor = useSourceMonitorState((value) => value);
    return h(SourceMonitor);
  }
  const initialState = {
    instances: [
      { id: "keyboard-board", type: "storyboard", params: {} },
      { id: "source", type: "source", params: {} },
    ],
    layout: {
      root: {
        type: "split",
        axis: "x",
        ratio: 0.5,
        first: { type: "area", areaId: "board-area" },
        second: { type: "area", areaId: "source-area" },
      },
      areas: {
        "board-area": { tabs: ["keyboard-board"], activePanelId: "keyboard-board" },
        "source-area": { tabs: ["source"], activePanelId: "source" },
      },
    },
    focusedPanelId: "keyboard-board",
  };
  const act = async (callback) => {
    flushSync(callback);
    await pause();
  };
  const waitFor = async (predicate, message) => {
    for (let index = 0; index < 100 && !predicate(); index += 1) await pause();
    if (!predicate()) throw new Error(message);
  };
  const eventOwner = eventSource("multi-scope-test");
  const seek = async (videoId, play = false) => {
    await publishEvent(
      "playback.seek.requested",
      { videoId, timeUs: 2_000_000, focusEndUs: 4_000_000, play },
      eventOwner,
    );
    await pause();
  };
  try {
    await act(() =>
      root.render(
        h(
          PanelManagerProvider,
          { initialState },
          h(Bridge),
          h(
            PanelInstanceProvider,
            { instanceId: "keyboard-board" },
            h("div", { className: "dock-panel-surface active", style: { width: 250 } }, h(Board)),
          ),
          h(
            PanelInstanceProvider,
            { instanceId: "source" },
            h(
              "div",
              { className: "dock-panel-surface active", style: { width: 750, height: 550 } },
              h(MonitorBridge),
            ),
          ),
        ),
      ),
    );
    const nextWorkspace = workspace();
    nextWorkspace.media_bin.items[1].source_video_id = "a";
    nextWorkspace.media_bin.items[1].path = "/a.mp4";
    nextWorkspace.projects = nextWorkspace.projects.slice(0, 1);
    await act(() => state.port.projectOpened(nextWorkspace, "/player.lcut", "player-test"));
    await waitFor(() => host.querySelector("video")?.readyState >= 2, "video never loaded");
    const firstVideo = host.querySelector("video");
    await seek("a");
    equal(state.monitor.cueRange, { startFrame: 48, endFrame: 96 }, "initial seek sets range");
    await act(() => state.source.selectVideo("b"));
    await seek("b", true);
    equal(host.querySelector("video") === firstVideo, true, "copy reuses loaded video element");
    equal(
      state.monitor.cueRange,
      { startFrame: 48, endFrame: 96 },
      "same-file copy applies pending range",
    );
    equal(state.monitor.playbackMode, 1, "same-file copy starts requested playback");
    await act(() => host.querySelector("video").pause());
    const target = host.querySelector("#keyboard-target");
    target.focus();
    const dispatch = async (key, code) =>
      act(() =>
        target.dispatchEvent(
          new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }),
        ),
      );
    await dispatch(" ", "Space");
    equal(state.monitor.playbackMode, 1, "unconsumed space reaches source player");
    const consume = (event) => event.preventDefault();
    target.addEventListener("keydown", consume);
    await dispatch(" ", "Space");
    equal(state.monitor.playbackMode, 1, "focused consumer owns space");
    target.removeEventListener("keydown", consume);
    await dispatch("k", "KeyK");
    equal(state.monitor.playbackMode, 0, "unconsumed K pauses source player");
    await dispatch("l", "KeyL");
    equal(state.monitor.playbackMode, "slow-forward", "held K plus L starts slow playback");
    target.addEventListener("keyup", (event) => event.stopPropagation(), { once: true });
    await act(() =>
      target.dispatchEvent(
        new KeyboardEvent("keyup", { key: "k", code: "KeyK", bubbles: true, cancelable: true }),
      ),
    );
    equal(state.monitor.playbackMode, 0, "consumed key release still clears held shuttle key");
    await act(() =>
      target.dispatchEvent(
        new KeyboardEvent("keyup", { key: "l", code: "KeyL", bubbles: true, cancelable: true }),
      ),
    );
    await seek("b");
    const beforeFrame = state.monitor.currentFrame;
    target.addEventListener("keydown", consume);
    await dispatch("ArrowRight", "ArrowRight");
    equal(state.monitor.currentFrame, beforeFrame, "consumed arrow stays in focused panel");
    target.removeEventListener("keydown", consume);
    await dispatch("ArrowRight", "ArrowRight");
    equal(state.monitor.currentFrame, beforeFrame + 1, "unconsumed arrow steps source frame");
    const editor = document.createElement("input");
    target.append(editor);
    editor.focus();
    await act(() =>
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true }),
      ),
    );
    equal(state.monitor.playbackMode, 0, "text editor keeps playback keys");
    return [
      "same-file copy range seeking and playback",
      "focused consumers / unconsumed Space, JKL and arrows",
      "consumed shuttle release and editable target handling",
    ];
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    window.__TAURI_INTERNALS__ = previousNative;
  }
}
