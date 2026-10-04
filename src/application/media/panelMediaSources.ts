import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { normalizeFrameRate } from "../../core/editor/timeline";
import {
  mediaPanelTitle,
  panelMediaWorkspaces,
  panelSourceTitle,
  panelSourceSnapshot,
  recordPanelSourceHistory,
  resolvePanelSourceChoices,
  togglePanelSourceChoice,
  type PanelMediaWorkspace,
  type PanelSourceSnapshot,
  type PersistedPanelMediaWorkspaces,
} from "../../core/editor/panelSourceSelection";
import { usePlaybackStatus } from "../../runtime/capabilities/PlaybackCapability";
import {
  usePanelManagerState,
  type PanelManagerState,
  type PanelMenuEntryDefinition,
} from "../../components/DockLayout";
import { useBroadcastEvent } from "../../runtime/events/react";
import { stateHub, useProjections } from "../../runtime/state/StateHub";
import {
  PLAYBACK_SOURCE_MODE_PROJECTION,
  type PlaybackSourceModeProjection,
} from "../../runtime/state/contracts";
import { useStableIdentity } from "../../runtime/state/react";
import {
  createPanelState,
  usePanelActive,
  usePanelInstanceId,
  usePublishPanelTitle,
} from "../../runtime/systems/PanelState";
import {
  getProjectWorkspaceSnapshot,
  isMediaItemEnabled,
  isMediaItemOffline,
  mediaItemProject,
  visibleSubtitleTracks,
  useProjectPort,
} from "../../systems/ProjectSystem";
import type { MediaBinItem, Project } from "../../types";
import {
  replayedPanelSourceSelection,
  type PanelSourceSelection,
} from "../../systems/ProjectSystem/ProjectHistory";

export interface PanelMediaSource {
  item: MediaBinItem;
  project: Project;
  tracks: ReturnType<typeof visibleSubtitleTracks>;
}

interface PanelMediaSelection {
  sourceHistory: PanelSourceSnapshot[];
  sourceHistoryIndex: number;
  navigateSources: (direction: -1 | 1) => void;
  hydrateWorkspaces: (projectId: string, saved: PersistedPanelMediaWorkspaces) => void;
  workspaceId: number | null;
  nextWorkspaceId: number;
  workspaces: PanelMediaWorkspace[];
  openWorkspace: (projectId: string | null, source: PanelSourceSelection) => void;
  restoreWorkspace: (id: number) => void;
  closeWorkspace: (all?: boolean) => void;
  sources: { videoId: string; trackId: string }[];
  setSources: (sources: { videoId: string; trackId: string }[]) => void;
  projectId: string | null | undefined;
  videoId: string | null;
  trackId: string;
  openVersion: number;
  frame: number;
  rememberFrame: (videoId: string, frame: number) => void;
  savedFrame: () => number;
  openVideo: (projectId: string | null, videoId: string, trackId: string) => void;
  previewVideo: (
    projectId: string | null,
    videoId: string,
    trackId: string,
    sources: { videoId: string; trackId: string }[],
    frame: number,
    recordHistory?: boolean,
  ) => void;
}

const usePanelMediaSelection = createPanelState<PanelMediaSelection>(() => (set, get) => ({
  sourceHistory: [],
  sourceHistoryIndex: 0,
  navigateSources: (direction) =>
    set((current) => {
      const index = current.sourceHistoryIndex + direction;
      const next = current.sourceHistory[index];
      if (!next) return current;
      const sourceHistory = [...current.sourceHistory];
      sourceHistory[current.sourceHistoryIndex] = panelSourceSnapshot(current);
      return {
        ...next,
        sourceHistory,
        sourceHistoryIndex: index,
        openVersion: current.openVersion + 1,
      };
    }),
  hydrateWorkspaces: (projectId, saved) =>
    set((current) => {
      const active = saved.workspaces.find((workspace) => workspace.id === saved.workspaceId);
      return {
        projectId,
        workspaceId: active?.id ?? null,
        nextWorkspaceId: Math.max(
          current.nextWorkspaceId,
          ...saved.workspaces.map((workspace) => workspace.id + 1),
        ),
        workspaces: saved.workspaces.filter((workspace) => workspace.id !== active?.id),
        sources: active?.sources ?? [],
        videoId: active?.videoId ?? "",
        trackId: active?.trackId ?? "",
        frame: active?.frame ?? 0,
        sourceHistory: active?.sourceHistory ?? [],
        sourceHistoryIndex: active?.sourceHistoryIndex ?? 0,
        openVersion: current.openVersion + 1,
      };
    }),
  workspaceId: null,
  nextWorkspaceId: 1,
  workspaces: [],
  openWorkspace: (projectId, source) =>
    set((current) => ({
      ...source,
      sourceHistory: [panelSourceSnapshot(source)],
      sourceHistoryIndex: 0,
      projectId,
      workspaces: current.projectId === projectId ? panelMediaWorkspaces(current) : [],
      workspaceId: current.nextWorkspaceId,
      nextWorkspaceId: current.nextWorkspaceId + 1,
      openVersion: current.openVersion + 1,
    })),
  restoreWorkspace: (id) =>
    set((current) => {
      if (id === current.workspaceId) return current;
      const workspaces = panelMediaWorkspaces(current);
      const workspace = workspaces.find((candidate) => candidate.id === id);
      if (!workspace) return current;
      return {
        sources: workspace.sources,
        videoId: workspace.videoId,
        trackId: workspace.trackId,
        frame: workspace.frame,
        sourceHistory: workspace.sourceHistory,
        sourceHistoryIndex: workspace.sourceHistoryIndex,
        workspaceId: id,
        workspaces: workspaces.filter((candidate) => candidate.id !== id),
        openVersion: current.openVersion + 1,
      };
    }),
  closeWorkspace: (all = false) =>
    set((current) => {
      const workspaces = all
        ? []
        : panelMediaWorkspaces(current).filter((workspace) => workspace.id !== current.workspaceId);
      const previous = workspaces.at(-1);
      return {
        workspaces: workspaces.filter((workspace) => workspace.id !== previous?.id),
        workspaceId: previous?.id ?? null,
        sources: previous?.sources ?? [],
        videoId: previous?.videoId ?? "",
        trackId: previous?.trackId ?? "",
        frame: previous?.frame ?? 0,
        sourceHistory: previous?.sourceHistory ?? [],
        sourceHistoryIndex: previous?.sourceHistoryIndex ?? 0,
        openVersion: current.openVersion + 1,
      };
    }),
  sources: [],
  setSources: (sources) =>
    set((current) => {
      const workspace =
        current.workspaceId === null && sources.length
          ? { workspaceId: current.nextWorkspaceId, nextWorkspaceId: current.nextWorkspaceId + 1 }
          : {};
      if (!sources.length) {
        const next = { sources, videoId: "", trackId: "", frame: 0 };
        return {
          ...next,
          ...recordPanelSourceHistory(current, next),
          openVersion: current.openVersion + 1,
        };
      }
      if (
        sources.some(
          (source) => source.videoId === current.videoId && source.trackId === current.trackId,
        )
      )
        return {
          sources,
          ...workspace,
          ...recordPanelSourceHistory(current, panelSourceSnapshot({ ...current, sources })),
        };
      const next = {
        sources,
        videoId: sources[0].videoId,
        trackId: sources[0].trackId,
        frame: 0,
      };
      return {
        ...workspace,
        ...next,
        ...recordPanelSourceHistory(current, next),
        openVersion: current.openVersion + 1,
      };
    }),
  projectId: undefined,
  videoId: null,
  trackId: "",
  openVersion: 0,
  frame: 0,
  rememberFrame: (videoId, frame) =>
    set((current) =>
      current.videoId === videoId && current.frame !== frame ? { frame } : current,
    ),
  savedFrame: () => get().frame,
  openVideo: (projectId, videoId, trackId) =>
    set((current) => ({
      workspaces: [],
      workspaceId: videoId ? current.nextWorkspaceId : null,
      nextWorkspaceId: current.nextWorkspaceId + 1,
      projectId,
      videoId: videoId || "",
      trackId,
      sources: videoId ? [{ videoId, trackId }] : [],
      sourceHistory: videoId
        ? [{ videoId, trackId, sources: [{ videoId, trackId }], frame: 0 }]
        : [],
      sourceHistoryIndex: 0,
      openVersion: current.openVersion + 1,
      frame: current.projectId === projectId && current.videoId === videoId ? current.frame : 0,
    })),
  previewVideo: (projectId, videoId, trackId, sources, frame, recordHistory = false) =>
    set((current) => ({
      ...(recordHistory
        ? recordPanelSourceHistory(current, { videoId, trackId, sources, frame })
        : {}),
      ...(current.workspaceId === null && sources.length
        ? { workspaceId: current.nextWorkspaceId, nextWorkspaceId: current.nextWorkspaceId + 1 }
        : {}),
      projectId,
      videoId,
      trackId,
      sources,
      openVersion: current.openVersion + 1,
      frame: Math.max(0, Math.round(frame)),
    })),
}));

/** A single visible media panel acts as focused; with multiple panels, actual focus wins. */
function sourceMediaPanelId(
  state: Pick<PanelManagerState, "layout" | "instances" | "focusedPanelId">,
) {
  const visible = Object.values(state.layout.areas).flatMap((area) => {
    const id = area.activePanelId;
    const type = id && state.instances[id]?.type;
    return id && (type === "subtitles" || type === "storyboard") ? [id] : [];
  });
  if (visible.length === 1) return visible[0];
  if (state.focusedPanelId && visible.includes(state.focusedPanelId)) return state.focusedPanelId;
  return null;
}

/** Read the last mode sent by a media panel, including commands sent before the player mounted. */
export function useSourcePreviewRequest() {
  const modes = useProjections<PlaybackSourceModeProjection>(PLAYBACK_SOURCE_MODE_PROJECTION);
  return [...modes].sort((left, right) => right.revision - left.revision)[0];
}

/** Read the panel's source without giving a title or an inactive tab control of playback. */
export function usePanelMediaSourceSelection(kind?: "subtitles" | "storyboard") {
  const selection = usePanelMediaSelection((state) => state);
  const panelId = usePanelInstanceId();
  const {
    projectId,
    projects,
    mediaItems,
    activeVideoId: previewVideoId,
    activeTrackId: previewTrackId,
    projectHistory,
    activeTrackChanged,
  } = useProjectPort(
    ["projectId", "projects", "mediaItems", "activeVideoId", "activeTrackId", "projectHistory"],
    ["activeTrackChanged"],
  );
  const initialized = selection.projectId === projectId && selection.videoId !== null;
  const selectedSources = useMemo(() => {
    const available = panelMediaSources(projects, mediaItems);
    const requestedSources = initialized
      ? selection.sources
      : [{ videoId: previewVideoId, trackId: previewTrackId }];
    const availableById = new Map(available.map((source) => [source.item.id, source]));
    const choices = resolvePanelSourceChoices(
      requestedSources,
      available.map((source) => ({
        videoId: source.item.id,
        tracks: source.tracks,
      })),
    );
    return choices.map(({ videoId, trackId }) => {
      const { item, project, tracks } = availableById.get(videoId)!;
      const stream =
        project.streams.find((stream) => stream.index === project.asset.video_stream_index) ??
        project.streams.find((stream) => stream.codec_type === "video");
      return {
        videoId,
        trackId,
        item,
        project,
        tracks,
        name: item.file_name,
        context: `${item.id}:${project.asset.id}:${project.asset.fingerprint ?? ""}`,
        assetId: project.asset.id,
        fingerprint: project.asset.fingerprint ?? "",
        videoPath: project.proxy_path || project.asset.path,
        previewVideoPath: project.proxy_path || project.asset.path,
        frameRate: normalizeFrameRate(stream?.avg_frame_rate, stream?.r_frame_rate),
      };
    });
  }, [initialized, selection.sources, previewVideoId, previewTrackId, mediaItems, projects]);
  const activeSource =
    selectedSources.find((source) => source.videoId === selection.videoId) ?? selectedSources[0];
  const activeVideoId = activeSource?.videoId ?? "";
  const activeTrackId = activeSource?.trackId ?? "";
  const project = activeSource?.project ?? null;
  const previousHistoryRef = useRef({ projectId, projectHistory });
  useLayoutEffect(() => {
    const previous = previousHistoryRef.current;
    previousHistoryRef.current = { projectId, projectHistory };
    if (!kind || previous.projectId !== projectId) return;
    const restored = replayedPanelSourceSelection(previous.projectHistory, projectHistory, panelId);
    if (restored) {
      selection.previewVideo(
        projectId,
        restored.videoId,
        restored.trackId,
        restored.sources,
        restored.frame,
      );
    }
  }, [kind, panelId, projectHistory, projectId, selection.previewVideo]);
  const changeSources = useCallback(
    (next: PanelSourceSelection) => {
      if (kind === "subtitles" && selection.projectId === projectId) {
        const before = {
          videoId: selection.videoId ?? activeVideoId,
          trackId: selection.trackId,
          sources: selection.sources,
          frame: selection.savedFrame(),
        };
        if (before.videoId === next.videoId && before.trackId !== next.trackId) {
          activeTrackChanged(next.trackId, { panelId, before, after: next });
        }
      }
      selection.previewVideo(projectId, next.videoId, next.trackId, next.sources, next.frame, true);
    },
    [activeTrackChanged, activeVideoId, kind, panelId, projectId, selection],
  );
  const selectVideo = useCallback(
    (videoId: string, trackId?: string, newWorkspace = false) => {
      const nextVideo = mediaItems.find(
        (item) => item.id === videoId && item.kind === "video" && isMediaItemEnabled(item),
      );
      const nextProject = nextVideo && mediaItemProject(nextVideo, projects, mediaItems);
      if (!nextProject) return false;
      const nextTracks = visibleSubtitleTracks(nextProject, mediaItems, videoId, projects);
      const requestedTrack = trackId ?? (videoId === activeVideoId ? activeTrackId : "");
      const nextTrackId =
        nextTracks.find((track) => track.id === requestedTrack)?.id ?? nextTracks[0]?.id ?? "";
      const next = {
        videoId,
        trackId: nextTrackId,
        sources: [{ videoId, trackId: nextTrackId }],
        frame: videoId === selection.videoId ? selection.savedFrame() : 0,
      };
      if (newWorkspace) selection.openWorkspace(projectId, next);
      else changeSources(next);
      return true;
    },
    [activeTrackId, activeVideoId, mediaItems, projects, changeSources, selection, projectId],
  );
  const toggleSource = (videoId: string, trackId?: string) => {
    const item = mediaItems.find(
      (item) => item.id === videoId && item.kind === "video" && isMediaItemEnabled(item),
    );
    const project = item && mediaItemProject(item, projects, mediaItems);
    if (!project) return;
    const tracks = visibleSubtitleTracks(project, mediaItems, videoId, projects);
    const sources = selectedSources.map(({ videoId, trackId }) => ({ videoId, trackId }));
    const nextSources = togglePanelSourceChoice(
      sources,
      { videoId, trackId: trackId ?? tracks[0]?.id ?? "" },
      trackId !== undefined,
    );
    if (trackId !== undefined && videoId === activeVideoId && trackId !== activeTrackId) {
      changeSources({ videoId, trackId, sources: nextSources, frame: selection.savedFrame() });
    } else selection.setSources(nextSources);
  };
  const previewSource = (videoId: string, trackId: string, frame = 0) => {
    if (selection.videoId === videoId && selection.trackId === trackId) return;
    const sources = selectedSources.map((source) => ({
      videoId: source.videoId,
      trackId: source.videoId === videoId ? trackId : source.trackId,
    }));
    selection.previewVideo(projectId, videoId, trackId, sources, frame);
  };
  return {
    selectedSources,
    toggleSource,
    previewSource,
    project,
    activeSource,
    activeVideoId,
    activeTrackId,
    previewVideoId,
    selectVideo,
    selection,
    projectId,
  };
}

/** Issue source commands when the panel is activated, focused, or changes its own selection. */
export function usePanelMediaSource(kind: "subtitles" | "storyboard") {
  const source = usePanelMediaSourceSelection(kind);
  usePublishPanelTitle(mediaPanelTitle(kind, source.selectedSources));
  const { selection, projectId, activeVideoId, activeTrackId, previewVideoId, project } = source;
  const panelId = usePanelInstanceId();
  const panelActive = usePanelActive();
  const identity = useStableIdentity("media-panel", panelId);
  const playback = usePlaybackStatus();
  useLayoutEffect(() => {
    if (playback?.sourcePanelId === panelId && playback.videoId === activeVideoId) {
      selection.rememberFrame(activeVideoId, playback.currentFrame);
    }
  }, [
    activeVideoId,
    panelId,
    playback?.currentFrame,
    playback?.sourcePanelId,
    playback?.videoId,
    selection.rememberFrame,
  ]);
  const canOpenSource = usePanelManagerState((state) => sourceMediaPanelId(state) === panelId);
  const panelFocused = usePanelManagerState((state) => state.focusedPanelId === panelId);
  const { activeVideoChanged, previewTrackChanged, sourcePreviewCleared } = useProjectPort(
    [],
    ["activeVideoChanged", "previewTrackChanged", "sourcePreviewCleared"],
  );
  useLayoutEffect(() => {
    if (
      selection.projectId !== projectId ||
      (selection.videoId === null && Boolean(activeVideoId))
    ) {
      selection.openVideo(projectId, activeVideoId, activeTrackId);
    }
  }, [activeTrackId, activeVideoId, previewVideoId, projectId, selection]);
  useBroadcastEvent(identity, "media.video.opened", ({ payload }) =>
    source.selectVideo(payload.videoId, undefined, true) ? "handled" : "ignored",
  );
  const hasProject = Boolean(project);
  const selectionInitialized = selection.projectId === projectId && selection.videoId !== null;
  const openSource = useCallback(() => {
    if (!selectionInitialized) return;
    stateHub.publish<PlaybackSourceModeProjection>(PLAYBACK_SOURCE_MODE_PROJECTION, identity, {
      mode: kind,
      videoId: activeVideoId,
      frame: selection.videoId === activeVideoId ? selection.savedFrame() : 0,
    });
    if (!hasProject) {
      sourcePreviewCleared();
      return;
    }
    activeVideoChanged(activeVideoId);
    if (
      kind === "subtitles" &&
      getProjectWorkspaceSnapshot().editor.active_track_id !== activeTrackId
    ) {
      previewTrackChanged(activeTrackId);
    }
  }, [
    previewTrackChanged,
    activeTrackId,
    activeVideoChanged,
    activeVideoId,
    hasProject,
    identity,
    kind,
    selection.openVersion,
    selection.savedFrame,
    selection.videoId,
    selectionInitialized,
    sourcePreviewCleared,
  ]);
  const previousControlRef = useRef<{
    openSource: typeof openSource;
    canOpenSource: boolean;
    panelActive: boolean;
    panelFocused: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    const previous = previousControlRef.current;
    previousControlRef.current = { openSource, canOpenSource, panelActive, panelFocused };
    if (
      panelActive &&
      ((canOpenSource &&
        (!previous?.canOpenSource ||
          !previous.panelActive ||
          previous.openSource !== openSource)) ||
        (panelFocused && !previous?.panelFocused))
    )
      openSource();
  }, [canOpenSource, openSource, panelActive, panelFocused]);
  return source;
}

/** Workspace history belongs to the panel instance, rather than individual media IDs. */
export function usePanelMediaWorkspaceMenu(
  kind: "subtitles" | "storyboard",
): PanelMenuEntryDefinition[] {
  const { selection, projectId } = usePanelMediaSourceSelection();
  const { projects, mediaItems } = useProjectPort(["projects", "mediaItems"], []);
  const available = panelMediaSources(projects, mediaItems);
  const workspaces = selection.projectId === projectId ? panelMediaWorkspaces(selection) : [];
  const hasWorkspaces = workspaces.length > 0;
  return [
    {
      id: `${kind}-close-workspace`,
      label: "关闭",
      disabled: selection.workspaceId === null || !hasWorkspaces,
      onSelect: () => selection.closeWorkspace(),
    },
    {
      id: `${kind}-close-all-workspaces`,
      label: "关闭全部",
      disabled: !hasWorkspaces,
      onSelect: () => selection.closeWorkspace(true),
    },
    { type: "separator", id: `${kind}-workspace-history-separator` },
    {
      type: "selection",
      id: `${kind}-workspace-history`,
      defaultValue: selection.workspaceId?.toString() ?? `${kind}-empty`,
      items: hasWorkspaces
        ? workspaces.map((workspace) => {
            const choices = resolvePanelSourceChoices(
              workspace.sources,
              available.map((source) => ({ videoId: source.item.id, tracks: source.tracks })),
            );
            const sources = choices.map((choice) => ({
              name: available.find((source) => source.item.id === choice.videoId)!.item.file_name,
              trackId: choice.trackId,
            }));
            const label = mediaPanelTitle(kind, sources);
            return {
              id: workspace.id.toString(),
              label,
              title: panelSourceTitle(label, sources),
              onSelect: () => selection.restoreWorkspace(workspace.id),
            };
          })
        : [
            {
              id: `${kind}-empty`,
              label: mediaPanelTitle(kind, []),
              title: mediaPanelTitle(kind, []),
              onSelect: () => undefined,
            },
          ],
    },
  ];
}

/**
 * Videos a panel may offer as a source, paired with the subtitle tracks visible for each.
 *
 * Offline videos stay listed when a proxy exists, because panels can still scrub and display them.
 * Callers that need the original file — storyboard detection, for instance — must narrow this
 * further with their own eligibility predicate.
 */
export function panelMediaSources(
  projects: Record<string, Project>,
  mediaItems: MediaBinItem[],
): PanelMediaSource[] {
  return mediaItems.flatMap((item) => {
    if (item.kind !== "video" || !isMediaItemEnabled(item)) return [];
    const project = mediaItemProject(item, projects, mediaItems);
    if (!project || project.asset.video_stream_index == null) return [];
    if (isMediaItemOffline(item) && !project.proxy_path) return [];
    return [
      { item, project, tracks: visibleSubtitleTracks(project, mediaItems, item.id, projects) },
    ];
  });
}

export function subtitleTrackLabel(
  mediaItems: MediaBinItem[],
  videoId: string,
  track: Project["tracks"][number],
) {
  const item = mediaItems.find(
    (candidate) =>
      candidate.kind === "subtitle" &&
      candidate.bound_to_video_id === videoId &&
      candidate.subtitle_track_id === track.id &&
      isMediaItemEnabled(candidate),
  );
  return `${item?.file_name || track.title || track.language || track.codec} ${track.cue_count} 条`;
}
