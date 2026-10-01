import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { normalizeFrameRate } from "../../core/editor/timeline";
import { usePlaybackStatus } from "../../runtime/capabilities/PlaybackCapability";
import { usePanelManagerState, type PanelManagerState } from "../../components/DockLayout";
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

export interface PanelMediaSource {
  item: MediaBinItem;
  project: Project;
  tracks: ReturnType<typeof visibleSubtitleTracks>;
}

interface PanelMediaSelection {
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
  ) => void;
}

const usePanelMediaSelection = createPanelState<PanelMediaSelection>(() => (set, get) => ({
  sources: [],
  setSources: (sources) =>
    set((current) => {
      if (
        sources.some(
          (source) => source.videoId === current.videoId && source.trackId === current.trackId,
        ) ||
        !sources.length
      )
        return { sources };
      return {
        sources,
        videoId: sources[0].videoId,
        trackId: sources[0].trackId,
        frame: 0,
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
      projectId,
      videoId,
      trackId,
      sources: [{ videoId, trackId }],
      openVersion: current.openVersion + 1,
      frame: current.projectId === projectId && current.videoId === videoId ? current.frame : 0,
    })),
  previewVideo: (projectId, videoId, trackId, sources, frame) =>
    set((current) => ({
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
export function usePanelMediaSourceSelection() {
  const selection = usePanelMediaSelection((state) => state);
  const {
    projectId,
    projects,
    mediaItems,
    activeVideoId: previewVideoId,
    activeTrackId: previewTrackId,
  } = useProjectPort(["projectId", "projects", "mediaItems", "activeVideoId", "activeTrackId"], []);
  const initialized =
    selection.projectId === projectId &&
    selection.videoId !== null &&
    (Boolean(selection.videoId) || !previewVideoId);
  const activeVideoId = initialized ? selection.videoId! : previewVideoId;
  const video = mediaItems.find(
    (item) => item.id === activeVideoId && item.kind === "video" && isMediaItemEnabled(item),
  );
  const project = video ? (mediaItemProject(video, projects, mediaItems) ?? null) : null;
  const tracks = visibleSubtitleTracks(project, mediaItems, activeVideoId, projects);
  const requestedTrackId = initialized ? selection.trackId : previewTrackId;
  const activeTrackId =
    tracks.find((track) => track.id === requestedTrackId)?.id ??
    tracks.find((track) => track.kind === "text" && track.cue_count > 0)?.id ??
    tracks[0]?.id ??
    "";
  const selectVideo = useCallback(
    (videoId: string, trackId?: string) => {
      const nextVideo = mediaItems.find(
        (item) => item.id === videoId && item.kind === "video" && isMediaItemEnabled(item),
      );
      const nextProject = nextVideo && mediaItemProject(nextVideo, projects, mediaItems);
      if (!nextProject) return false;
      const nextTracks = visibleSubtitleTracks(nextProject, mediaItems, videoId, projects);
      const requestedTrack = trackId ?? (videoId === activeVideoId ? activeTrackId : "");
      const nextTrackId =
        nextTracks.find((track) => track.id === requestedTrack)?.id ??
        nextTracks.find((track) => track.kind === "text" && track.cue_count > 0)?.id ??
        nextTracks[0]?.id ??
        "";
      selection.openVideo(projectId, videoId, nextTrackId);
      return true;
    },
    [activeTrackId, activeVideoId, mediaItems, projectId, projects, selection.openVideo],
  );
  const selectedSources = useMemo(() => {
    const requested = initialized
      ? selection.sources
      : [{ videoId: activeVideoId, trackId: activeTrackId }];
    return requested.flatMap((entry) => {
      const item = mediaItems.find(
        (item) => item.id === entry.videoId && item.kind === "video" && isMediaItemEnabled(item),
      );
      const project = item && mediaItemProject(item, projects, mediaItems);
      if (!item || !project) return [];
      const tracks = visibleSubtitleTracks(project, mediaItems, item.id, projects);
      const trackId =
        tracks.find((track) => track.id === entry.trackId)?.id ??
        tracks.find((track) => track.kind === "text" && track.cue_count > 0)?.id ??
        tracks[0]?.id ??
        "";
      const stream =
        project.streams.find((stream) => stream.index === project.asset.video_stream_index) ??
        project.streams.find((stream) => stream.codec_type === "video");
      return [
        {
          videoId: item.id,
          trackId,
          item,
          project,
          name: item.file_name,
          context: `${item.id}:${project.asset.id}:${project.asset.fingerprint ?? ""}`,
          assetId: project.asset.id,
          fingerprint: project.asset.fingerprint ?? "",
          videoPath: project.proxy_path || project.asset.path,
          previewVideoPath: project.proxy_path || project.asset.path,
          frameRate: normalizeFrameRate(stream?.avg_frame_rate, stream?.r_frame_rate),
        },
      ];
    });
  }, [initialized, selection.sources, activeVideoId, activeTrackId, mediaItems, projects]);
  const toggleSource = (videoId: string, trackId?: string) => {
    const existing = selectedSources.find((source) => source.videoId === videoId);
    const sources = selectedSources.map(({ videoId, trackId }) => ({ videoId, trackId }));
    if (existing && trackId !== undefined && existing.trackId !== trackId) {
      selection.setSources(
        sources.map((source) => (source.videoId === videoId ? { videoId, trackId } : source)),
      );
      return;
    }
    if (existing && selectedSources.length === 1) return;
    if (existing)
      selection.setSources(
        sources.filter(
          (source) => source.videoId !== videoId || source.trackId !== existing.trackId,
        ),
      );
    else {
      const item = mediaItems.find((item) => item.id === videoId);
      const project = item && mediaItemProject(item, projects, mediaItems);
      if (!project) return;
      const tracks = visibleSubtitleTracks(project, mediaItems, videoId, projects);
      selection.setSources([
        ...sources,
        {
          videoId,
          trackId:
            trackId ??
            tracks.find((track) => track.kind === "text" && track.cue_count > 0)?.id ??
            tracks[0]?.id ??
            "",
        },
      ]);
    }
  };
  const previewSource = (videoId: string, trackId: string, frame = 0) => {
    if (selection.videoId === videoId && selection.trackId === trackId) return;
    const sources = (
      selection.sources.length
        ? selection.sources
        : selectedSources.map(({ videoId, trackId }) => ({ videoId, trackId }))
    ).map((source) => (source.videoId === videoId ? { videoId, trackId } : { ...source }));
    selection.previewVideo(projectId, videoId, trackId, sources, frame);
  };
  return {
    selectedSources,
    toggleSource,
    previewSource,
    project,
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
  const source = usePanelMediaSourceSelection();
  const { selection, projectId, activeVideoId, activeTrackId, previewVideoId, project } = source;
  useLayoutEffect(() => {
    const valid = source.selectedSources;
    if (
      valid.length &&
      !valid.some((entry) => entry.videoId === activeVideoId && entry.trackId === activeTrackId)
    ) {
      selection.setSources(valid.map(({ videoId, trackId }) => ({ videoId, trackId })));
    }
  }, [source.selectedSources, activeVideoId, activeTrackId, selection.setSources]);
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
  const { activeVideoChanged, activeTrackChanged, sourcePreviewCleared } = useProjectPort(
    [],
    ["activeVideoChanged", "activeTrackChanged", "sourcePreviewCleared"],
  );
  useLayoutEffect(() => {
    if (
      selection.projectId !== projectId ||
      selection.videoId === null ||
      (!selection.videoId && previewVideoId)
    ) {
      selection.openVideo(projectId, activeVideoId || previewVideoId, activeTrackId);
    }
  }, [activeTrackId, activeVideoId, previewVideoId, projectId, selection]);
  useBroadcastEvent(identity, "media.video.opened", ({ payload }) =>
    source.selectVideo(payload.videoId) ? "handled" : "ignored",
  );
  const hasProject = Boolean(project);
  const selectionInitialized =
    selection.projectId === projectId && selection.videoId === activeVideoId;
  const openSource = useCallback(() => {
    if (!selectionInitialized) return;
    stateHub.publish<PlaybackSourceModeProjection>(PLAYBACK_SOURCE_MODE_PROJECTION, identity, {
      mode: kind,
      videoId: activeVideoId,
      frame: selection.savedFrame(),
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
      activeTrackChanged(activeTrackId);
    }
  }, [
    activeTrackChanged,
    activeTrackId,
    activeVideoChanged,
    activeVideoId,
    hasProject,
    identity,
    kind,
    selection.openVersion,
    selection.savedFrame,
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
