import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import {
  appendProjectHistoryEntry,
  applyProjectFileEvent,
  createProjectHistory,
  createProjectHistoryEntry,
  discardFutureProjectHistory,
  isProjectHistoryDirty,
  markProjectHistorySaved,
  type ProjectFileState,
  type ProjectHistoryCategory,
  type ProjectHistoryState,
  type SubtitleSelections,
} from "./projectHistory";
import type {
  DemuxMediaResult,
  ExportResult,
  MediaBinItem,
  Preferences,
  Project,
  ProjectWorkspace,
  SubtitleCue,
  SubtitleTrack,
} from "./types";

interface AppActions {
  projectImported: (project: Project) => void;
  projectCreated: () => void;
  projectOpened: (workspace: ProjectWorkspace, path: string) => void;
  projectSaved: (path: string) => void;
  projectClosed: () => void;
  mediaProjectsAdded: (projects: Project[]) => void;
  mediaItemsAdded: (items: MediaBinItem[], historyLabel?: string) => void;
  mediaItemRenamed: (itemId: string, fileName: string) => void;
  mediaItemsEnabledChanged: (itemIds: string[], enabled: boolean) => void;
  allMediaItemsEnabledChanged: (enabled: boolean) => void;
  mediaItemsHiddenChanged: (itemIds: string[], hidden: boolean) => void;
  mediaItemsOfflineChanged: (itemIds: string[], offline: boolean) => void;
  mediaItemRelinked: (
    itemId: string,
    path: string,
    linkedProject: Project | null,
    historyLabel?: string,
  ) => void;
  mediaProxyPathChanged: (itemId: string, path: string | null) => void;
  mediaItemsBound: (itemIds: string[], videoId: string) => void;
  mediaItemsUnbound: (itemIds: string[]) => void;
  mediaItemsRemoved: (itemIds: string[]) => void;
  mediaDemuxed: (videoId: string, result: DemuxMediaResult) => void;
  activeVideoChanged: (videoId: string) => void;
  subtitleTracksAdded: (tracks: SubtitleTrack[], cues: Record<string, SubtitleCue[]>) => void;
  subtitleTracksAddedToVideo: (
    videoId: string,
    tracks: SubtitleTrack[],
    cues: Record<string, SubtitleCue[]>,
    itemIds: string[],
  ) => void;
  activeTrackChanged: (trackId: string) => void;
  cueSelectionToggled: (cueId: string) => void;
  cueSelectionCleared: () => void;
  cueSelectionReplaced: (cueIds: string[]) => void;
  proxyDialogOpened: () => void;
  proxyDialogClosed: () => void;
  sourcePreviewSelected: () => void;
  proxyPreviewSelected: () => void;
  proxyGenerated: (path: string) => void;
  preferencesLoaded: (preferences: Preferences) => void;
  messagePublished: (message: string) => void;
  warningsReplaced: (warnings: string[]) => void;
  warningsAppended: (warnings: string[]) => void;
  exportResultChanged: (result: ExportResult | null) => void;
  mediaBinReadOnlyChanged: (readOnly: boolean) => void;
  projectHistoryJumped: (cursor: number) => boolean;
  projectHistoryFutureDiscarded: () => void;
}

interface AppStore {
  project: Project | null;
  projects: Record<string, Project>;
  mediaItems: MediaBinItem[];
  activeVideoId: string;
  detachedVideoIds: Set<string>;
  projectFilePath: string | null;
  projectDirty: boolean;
  activeTrackId: string;
  subtitleSelections: SubtitleSelections;
  selectedCueIds: Set<string>;
  proxyPath: string | null;
  useProxy: boolean;
  proxyDialogOpen: boolean;
  preferences: Preferences;
  message: string;
  warnings: string[];
  exportResult: ExportResult | null;
  mediaBinReadOnly: boolean;
  projectHistory: ProjectHistoryState;
  actions: AppActions;
}

const mediaLabelColors = {
  videoOnly: "#3e0aae",
  videoWithAudio: "#004b67",
  audio: "#2a5507",
  subtitle: "#893a04",
} as const;

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

export function isMediaItemEnabled(item: MediaBinItem) {
  return item.enabled !== false;
}

export function isMediaItemHidden(item: MediaBinItem) {
  return item.hidden === true;
}

export function isMediaItemOffline(item: MediaBinItem) {
  return item.offline === true;
}

export function isVirtualMediaItem(
  item: MediaBinItem,
): item is MediaBinItem & { source_video_id: string; stream_index: number } {
  return (
    item.origin === "decomposed" &&
    typeof item.source_video_id === "string" &&
    typeof item.stream_index === "number" &&
    (item.kind === "audio" || item.kind === "subtitle")
  );
}

export function mediaItemProject(
  item: MediaBinItem,
  projects: Record<string, Project>,
  mediaItems: MediaBinItem[] = [],
) {
  const directProject =
    projects[item.id] ?? (item.source_video_id ? projects[item.source_video_id] : undefined);
  if (directProject) {
    return directProject;
  }
  const boundVideo = item.bound_to_video_id
    ? mediaItems.find((candidate) => candidate.id === item.bound_to_video_id)
    : undefined;
  return boundVideo
    ? (projects[boundVideo.id] ??
        (boundVideo.source_video_id ? projects[boundVideo.source_video_id] : undefined))
    : undefined;
}

export function isMediaVideoDetached(item: MediaBinItem, detachedVideoIds: Set<string>) {
  return (
    item.kind === "video" &&
    (detachedVideoIds.has(item.id) ||
      Boolean(item.source_video_id && detachedVideoIds.has(item.source_video_id)))
  );
}

function projectMediaItem(project: Project): MediaBinItem {
  const isVideo = project.asset.video_stream_index !== null;
  const hasAudio = project.asset.audio_stream_index !== null;
  const stream = project.streams.find((item) =>
    isVideo ? item.codec_type === "video" : item.codec_type === "audio",
  );
  return {
    id: project.asset.id,
    kind: isVideo ? "video" : "audio",
    enabled: true,
    hidden: false,
    offline: false,
    path: project.asset.path,
    file_name: project.asset.file_name,
    duration_us: project.asset.duration_us,
    start_time_us: project.asset.start_time_us,
    bound_to_video_id: null,
    source_video_id: null,
    stream_index: isVideo ? project.asset.video_stream_index : project.asset.audio_stream_index,
    subtitle_track_id: null,
    codec: stream?.codec_name ?? null,
    language: stream?.language ?? null,
    extracted: false,
    origin: "imported",
    color: isVideo
      ? hasAudio
        ? mediaLabelColors.videoWithAudio
        : mediaLabelColors.videoOnly
      : mediaLabelColors.audio,
  };
}

function externalSubtitleItems(project: Project): MediaBinItem[] {
  return project.tracks
    .filter((track) => track.source_type === "external" && track.source_path)
    .map((track, index) => ({
      id: `subtitle:${track.id}`,
      kind: "subtitle" as const,
      enabled: true,
      hidden: false,
      offline: false,
      path: track.source_path ?? "",
      file_name: fileName(track.source_path ?? track.title ?? `字幕 ${index + 1}`),
      duration_us: project.asset.duration_us,
      start_time_us: 0,
      bound_to_video_id: project.asset.id,
      source_video_id: null,
      stream_index: track.stream_index,
      subtitle_track_id: track.id,
      codec: track.codec,
      language: track.language,
      extracted: false,
      origin: "imported" as const,
      color: mediaLabelColors.subtitle,
    }));
}

export function visibleSubtitleTracks(
  project: Project | null,
  mediaItems: MediaBinItem[],
  videoId: string,
  projects: Record<string, Project> = project ? { [project.asset.id]: project } : {},
) {
  if (!project) {
    return [];
  }
  const tracks = project.tracks.filter((track) => {
    const items = mediaItems.filter(
      (candidate) => candidate.kind === "subtitle" && candidate.subtitle_track_id === track.id,
    );
    if (items.length > 0) {
      return items.some((item) => isMediaItemEnabled(item) && item.bound_to_video_id === videoId);
    }
    if (track.source_type === "embedded") {
      return true;
    }
    const trackWasRebound = Boolean(
      track.source_path &&
      mediaItems.some(
        (candidate) => candidate.kind === "subtitle" && candidate.path === track.source_path,
      ),
    );
    return !trackWasRebound;
  });

  const visibleTrackIds = new Set(tracks.map((track) => track.id));
  for (const item of mediaItems) {
    if (
      item.kind !== "subtitle" ||
      !isMediaItemEnabled(item) ||
      item.bound_to_video_id !== videoId ||
      !item.subtitle_track_id ||
      visibleTrackIds.has(item.subtitle_track_id)
    ) {
      continue;
    }
    const sourceProject = mediaItemProject(item, projects, mediaItems);
    const sourceTrack = sourceProject?.tracks.find((track) => track.id === item.subtitle_track_id);
    if (sourceTrack) {
      tracks.push(sourceTrack);
      visibleTrackIds.add(sourceTrack.id);
    }
  }
  return tracks;
}

export function subtitleTrackContext(
  project: Project | null,
  projects: Record<string, Project>,
  mediaItems: MediaBinItem[],
  videoId: string,
  trackId: string,
) {
  for (const item of mediaItems) {
    if (
      item.kind !== "subtitle" ||
      !isMediaItemEnabled(item) ||
      item.bound_to_video_id !== videoId ||
      item.subtitle_track_id !== trackId
    ) {
      continue;
    }
    const sourceProject = mediaItemProject(item, projects, mediaItems);
    const track = sourceProject?.tracks.find((candidate) => candidate.id === trackId);
    if (sourceProject && track) {
      return { project: sourceProject, track };
    }
  }

  const track = project?.tracks.find((candidate) => candidate.id === trackId);
  return project && track ? { project, track } : null;
}

export function subtitleTrackCues(
  project: Project | null,
  projects: Record<string, Project>,
  mediaItems: MediaBinItem[],
  videoId: string,
  trackId: string,
) {
  const context = subtitleTrackContext(project, projects, mediaItems, videoId, trackId);
  return context?.project.cues[trackId] ?? [];
}

function preferredTrackId(
  project: Project | null,
  projects: Record<string, Project>,
  mediaItems: MediaBinItem[],
  videoId: string,
) {
  const tracks = visibleSubtitleTracks(project, mediaItems, videoId, projects);
  return (
    tracks.find((track) => track.kind === "text" && track.cue_count > 0)?.id ?? tracks[0]?.id ?? ""
  );
}

function selectedCueIdsForContext(
  subtitleSelections: SubtitleSelections,
  videoId: string,
  trackId: string,
) {
  return new Set(subtitleSelections[videoId]?.[trackId] ?? []);
}

function subtitleContextState(
  subtitleSelections: SubtitleSelections,
  activeVideoId: string,
  activeTrackId: string,
) {
  return {
    activeVideoId,
    activeTrackId,
    selectedCueIds: selectedCueIdsForContext(subtitleSelections, activeVideoId, activeTrackId),
  };
}

function replaceCurrentSubtitleSelection(state: AppStore, selectedCueIds: Set<string>) {
  const subtitleSelections = { ...state.subtitleSelections };
  const videoSelections = { ...(subtitleSelections[state.activeVideoId] ?? {}) };
  if (selectedCueIds.size > 0) {
    videoSelections[state.activeTrackId] = selectedCueIds;
  } else {
    delete videoSelections[state.activeTrackId];
  }
  if (Object.keys(videoSelections).length > 0) {
    subtitleSelections[state.activeVideoId] = videoSelections;
  } else {
    delete subtitleSelections[state.activeVideoId];
  }
  return { subtitleSelections, selectedCueIds };
}

function restoreSubtitleSelections(
  serialized: ProjectWorkspace["editor"]["subtitle_selections"],
  projects: Record<string, Project>,
  mediaItems: MediaBinItem[],
) {
  const restored: SubtitleSelections = {};
  for (const [videoId, trackSelections] of Object.entries(serialized)) {
    const video = mediaItems.find((item) => item.id === videoId && item.kind === "video");
    const project = video ? mediaItemProject(video, projects, mediaItems) : null;
    if (!project) {
      continue;
    }
    for (const [trackId, cueIds] of Object.entries(trackSelections)) {
      const validCueIds = new Set(
        subtitleTrackCues(project, projects, mediaItems, videoId, trackId).map((cue) => cue.id),
      );
      const selection = new Set(cueIds.filter((cueId) => validCueIds.has(cueId)));
      if (selection.size > 0) {
        (restored[videoId] ??= {})[trackId] = selection;
      }
    }
  }
  return restored;
}

function serializeSubtitleSelections(subtitleSelections: SubtitleSelections) {
  return Object.fromEntries(
    Object.entries(subtitleSelections).map(([videoId, trackSelections]) => [
      videoId,
      Object.fromEntries(
        Object.entries(trackSelections).map(([trackId, cueIds]) => [trackId, [...cueIds]]),
      ),
    ]),
  );
}

function initialProjectState(project: Project | null) {
  if (!project) {
    return {
      project: null,
      projects: {},
      mediaItems: [],
      activeVideoId: "",
      detachedVideoIds: new Set<string>(),
      activeTrackId: "",
      subtitleSelections: {},
      selectedCueIds: new Set<string>(),
      proxyPath: null,
    };
  }
  const mediaItems = [projectMediaItem(project), ...externalSubtitleItems(project)];
  return {
    project,
    projects: { [project.asset.id]: project },
    mediaItems,
    activeVideoId: project.asset.id,
    detachedVideoIds: new Set<string>(),
    activeTrackId: preferredTrackId(
      project,
      { [project.asset.id]: project },
      mediaItems,
      project.asset.id,
    ),
    subtitleSelections: {},
    selectedCueIds: new Set<string>(),
    proxyPath: project.proxy_path,
  };
}

function openedProjectState(workspace: ProjectWorkspace) {
  const projects = Object.fromEntries(
    workspace.projects.map((project) => [project.asset.id, project]),
  );
  const mediaItems = workspace.media_bin.items.map((item) => ({
    ...item,
    enabled: item.enabled !== false,
    hidden: item.hidden === true,
    offline: isVirtualMediaItem(item) ? false : item.offline === true,
    path: isVirtualMediaItem(item) ? "" : item.path,
    extracted: isVirtualMediaItem(item) ? false : item.extracted,
  }));
  const videoIds = new Set(
    mediaItems
      .filter(
        (item) =>
          item.kind === "video" &&
          isMediaItemEnabled(item) &&
          Boolean(mediaItemProject(item, projects, mediaItems)),
      )
      .map((item) => item.id),
  );
  const firstVideoId = videoIds.values().next().value ?? "";
  const activeVideoId = videoIds.has(workspace.editor.active_video_id)
    ? workspace.editor.active_video_id
    : firstVideoId;
  const activeVideo = mediaItems.find((item) => item.id === activeVideoId);
  const project = activeVideo
    ? (mediaItemProject(activeVideo, projects, mediaItems) ?? null)
    : null;
  const visibleTrackIds = new Set(
    visibleSubtitleTracks(project, mediaItems, activeVideoId, projects).map((track) => track.id),
  );
  const activeTrackId = visibleTrackIds.has(workspace.editor.active_track_id)
    ? workspace.editor.active_track_id
    : preferredTrackId(project, projects, mediaItems, activeVideoId);
  const subtitleSelections = restoreSubtitleSelections(
    workspace.editor.subtitle_selections,
    projects,
    mediaItems,
  );

  return {
    project,
    projects,
    mediaItems,
    activeVideoId,
    detachedVideoIds: new Set(
      workspace.editor.detached_video_ids.filter((videoId) => videoIds.has(videoId)),
    ),
    activeTrackId,
    subtitleSelections,
    selectedCueIds: selectedCueIdsForContext(subtitleSelections, activeVideoId, activeTrackId),
    proxyPath: project?.proxy_path ?? null,
    useProxy:
      Boolean(project?.proxy_path) &&
      (workspace.editor.preview.use_proxy ||
        Boolean(activeVideo && isMediaItemOffline(activeVideo))),
    mediaBinReadOnly: false,
  };
}

export function defaultPreferences(): Preferences {
  return {
    cache_dir: "",
    default_export_dir: "",
    ffmpeg_path: "ffmpeg",
    ffprobe_path: "ffprobe",
  };
}

function projectFileStateFromStore(state: AppStore): ProjectFileState {
  return {
    projects: state.projects,
    mediaItems: state.mediaItems,
    activeVideoId: state.activeVideoId,
    activeTrackId: state.activeTrackId,
    subtitleSelections: state.subtitleSelections,
    detachedVideoIds: state.detachedVideoIds,
    useProxy: state.useProxy,
  };
}

function reconciledProjectFileState(projectFileState: ProjectFileState): Partial<AppStore> {
  const activeVideo = projectFileState.mediaItems.find(
    (item) => item.id === projectFileState.activeVideoId,
  );
  const project = activeVideo
    ? (mediaItemProject(activeVideo, projectFileState.projects, projectFileState.mediaItems) ??
      null)
    : null;

  return {
    ...projectFileState,
    selectedCueIds: selectedCueIdsForContext(
      projectFileState.subtitleSelections,
      projectFileState.activeVideoId,
      projectFileState.activeTrackId,
    ),
    project,
    proxyPath: project?.proxy_path ?? null,
    proxyDialogOpen: false,
    exportResult: null,
  };
}

function commitProjectEvent(
  set: (updater: (state: AppStore) => AppStore) => void,
  label: string,
  category: ProjectHistoryCategory,
  recipe: (state: AppStore) => Partial<AppStore> | AppStore,
) {
  set((state) => {
    const update = recipe(state);
    if (update === state) {
      return state;
    }
    const candidate = { ...state, ...update, projectDirty: state.projectDirty };
    const entry = createProjectHistoryEntry(
      label,
      category,
      projectFileStateFromStore(state),
      projectFileStateFromStore(candidate),
    );
    if (!entry) {
      return candidate;
    }
    const projectHistory = appendProjectHistoryEntry(state.projectHistory, entry);
    return {
      ...candidate,
      projectHistory,
      projectDirty: isProjectHistoryDirty(projectHistory),
    };
  });
}

const appStore = createStore<AppStore>()((set) => ({
  ...initialProjectState(null),
  projectFilePath: null,
  projectDirty: false,
  selectedCueIds: new Set<string>(),
  useProxy: false,
  proxyDialogOpen: false,
  preferences: defaultPreferences(),
  message: "就绪",
  warnings: [],
  exportResult: null,
  mediaBinReadOnly: false,
  projectHistory: createProjectHistory(),
  actions: {
    projectImported: (project) =>
      set({
        ...initialProjectState(project),
        projectDirty: true,
        selectedCueIds: new Set<string>(),
        useProxy: false,
        mediaBinReadOnly: false,
        projectHistory: createProjectHistory(true, false),
      }),
    projectCreated: () =>
      set({
        ...initialProjectState(null),
        projectFilePath: null,
        projectDirty: false,
        selectedCueIds: new Set<string>(),
        useProxy: false,
        proxyDialogOpen: false,
        warnings: [],
        exportResult: null,
        mediaBinReadOnly: false,
        projectHistory: createProjectHistory(true),
      }),
    projectOpened: (workspace, projectFilePath) =>
      set({
        ...openedProjectState(workspace),
        projectFilePath,
        projectDirty: false,
        proxyDialogOpen: false,
        warnings: [],
        exportResult: null,
        projectHistory: createProjectHistory(true),
      }),
    projectSaved: (projectFilePath) =>
      set((state) => ({
        projectFilePath,
        projectDirty: false,
        projectHistory: markProjectHistorySaved(state.projectHistory),
      })),
    projectClosed: () =>
      set({
        ...initialProjectState(null),
        projectFilePath: null,
        projectDirty: false,
        selectedCueIds: new Set<string>(),
        useProxy: false,
        proxyDialogOpen: false,
        warnings: [],
        exportResult: null,
        mediaBinReadOnly: false,
        projectHistory: createProjectHistory(),
      }),
    mediaProjectsAdded: (loadedProjects) =>
      commitProjectEvent(
        set,
        loadedProjects.length === 1
          ? `导入媒体：${loadedProjects[0].asset.file_name}`
          : `导入 ${loadedProjects.length} 个媒体`,
        "import",
        (state) => {
          if (loadedProjects.length === 0) {
            return state;
          }
          const projects = { ...state.projects };
          const nextItems = [...state.mediaItems];
          let firstVideo: Project | null = null;
          for (const loadedProject of loadedProjects) {
            const item = projectMediaItem(loadedProject);
            projects[loadedProject.asset.id] = loadedProject;
            if (!nextItems.some((current) => current.id === item.id)) {
              nextItems.push(item);
            }
            if (item.kind === "video") {
              firstVideo ??= loadedProject;
            }
          }

          if (state.project || !firstVideo) {
            return { projects, mediaItems: nextItems, projectDirty: true };
          }
          const activeVideoId = firstVideo.asset.id;
          const activeTrackId = preferredTrackId(firstVideo, projects, nextItems, activeVideoId);
          return {
            projects,
            mediaItems: nextItems,
            project: firstVideo,
            ...subtitleContextState(state.subtitleSelections, activeVideoId, activeTrackId),
            proxyPath: firstVideo.proxy_path,
            useProxy: false,
            projectDirty: true,
          };
        },
      ),
    mediaItemsAdded: (items, historyLabel) =>
      commitProjectEvent(
        set,
        historyLabel ??
          (items.every((item) => item.id.startsWith("media-copy:"))
            ? `粘贴 ${items.length} 个媒体`
            : `导入 ${items.length} 个媒体`),
        items.every((item) => item.id.startsWith("media-copy:")) ? "paste" : "import",
        (state) => {
          const knownIds = new Set(state.mediaItems.map((item) => item.id));
          const additions = items.filter((item) => !knownIds.has(item.id));
          return additions.length === 0
            ? state
            : { mediaItems: [...state.mediaItems, ...additions], projectDirty: true };
        },
      ),
    mediaItemRenamed: (itemId, fileName) =>
      commitProjectEvent(set, `重命名媒体：${fileName}`, "rename", (state) => {
        const item = state.mediaItems.find((candidate) => candidate.id === itemId);
        if (!item || item.file_name === fileName) {
          return state;
        }
        return {
          mediaItems: state.mediaItems.map((candidate) =>
            candidate.id === itemId ? { ...candidate, file_name: fileName } : candidate,
          ),
          projectDirty: true,
        };
      }),
    mediaItemsEnabledChanged: (itemIds, enabled) =>
      commitProjectEvent(
        set,
        `${enabled ? "启用" : "禁用"} ${itemIds.length} 个媒体`,
        enabled ? "enable" : "disable",
        (state) => {
          const changedIds = new Set(itemIds);
          if (!enabled) {
            for (const video of state.mediaItems) {
              if (video.kind !== "video" || !changedIds.has(video.id)) {
                continue;
              }
              for (const child of state.mediaItems) {
                if (child.bound_to_video_id === video.id) {
                  changedIds.add(child.id);
                }
              }
            }
          }
          const mediaItems = state.mediaItems.map((item) =>
            changedIds.has(item.id) && isMediaItemEnabled(item) !== enabled
              ? { ...item, enabled }
              : item,
          );
          if (mediaItems.every((item, index) => item === state.mediaItems[index])) {
            return state;
          }
          const currentVideo = mediaItems.find(
            (item) =>
              item.id === state.activeVideoId &&
              item.kind === "video" &&
              isMediaItemEnabled(item) &&
              mediaItemProject(item, state.projects, mediaItems),
          );
          const activeVideo =
            currentVideo ??
            mediaItems.find(
              (item) =>
                item.kind === "video" &&
                isMediaItemEnabled(item) &&
                mediaItemProject(item, state.projects, mediaItems),
            );
          const activeVideoId = activeVideo?.id ?? "";
          const project = activeVideo
            ? (mediaItemProject(activeVideo, state.projects, mediaItems) ?? null)
            : null;
          const currentTrackVisible = visibleSubtitleTracks(
            project,
            mediaItems,
            activeVideoId,
            state.projects,
          ).some((track) => track.id === state.activeTrackId);
          const activeVideoChanged = activeVideoId !== state.activeVideoId;
          const activeTrackId =
            !activeVideoChanged && currentTrackVisible
              ? state.activeTrackId
              : preferredTrackId(project, state.projects, mediaItems, activeVideoId);
          return {
            mediaItems,
            project,
            ...subtitleContextState(state.subtitleSelections, activeVideoId, activeTrackId),
            proxyPath: activeVideoChanged ? (project?.proxy_path ?? null) : state.proxyPath,
            useProxy: activeVideoChanged ? false : state.useProxy,
            proxyDialogOpen: activeVideoChanged ? false : state.proxyDialogOpen,
            exportResult: activeVideoChanged ? null : state.exportResult,
            projectDirty: true,
          };
        },
      ),
    allMediaItemsEnabledChanged: (enabled) =>
      commitProjectEvent(
        set,
        enabled ? "启用全部媒体" : "禁用全部媒体",
        enabled ? "enable" : "disable",
        (state) => {
          if (state.mediaItems.every((item) => isMediaItemEnabled(item) === enabled)) {
            return state;
          }
          const mediaItems = state.mediaItems.map((item) => ({ ...item, enabled }));
          const currentVideo = mediaItems.find(
            (item) =>
              item.id === state.activeVideoId &&
              item.kind === "video" &&
              isMediaItemEnabled(item) &&
              mediaItemProject(item, state.projects, mediaItems),
          );
          const activeVideo =
            currentVideo ??
            mediaItems.find(
              (item) =>
                item.kind === "video" &&
                isMediaItemEnabled(item) &&
                mediaItemProject(item, state.projects, mediaItems),
            );
          const activeVideoId = activeVideo?.id ?? "";
          const project = activeVideo
            ? (mediaItemProject(activeVideo, state.projects, mediaItems) ?? null)
            : null;
          const activeVideoChanged = activeVideoId !== state.activeVideoId;
          const currentTrackVisible = visibleSubtitleTracks(
            project,
            mediaItems,
            activeVideoId,
            state.projects,
          ).some((track) => track.id === state.activeTrackId);
          const activeTrackId =
            !activeVideoChanged && currentTrackVisible
              ? state.activeTrackId
              : preferredTrackId(project, state.projects, mediaItems, activeVideoId);
          return {
            mediaItems,
            project,
            ...subtitleContextState(state.subtitleSelections, activeVideoId, activeTrackId),
            proxyPath: activeVideoChanged ? (project?.proxy_path ?? null) : state.proxyPath,
            useProxy: activeVideoChanged ? false : state.useProxy,
            proxyDialogOpen: activeVideoChanged ? false : state.proxyDialogOpen,
            exportResult: activeVideoChanged ? null : state.exportResult,
            projectDirty: true,
          };
        },
      ),
    mediaItemsHiddenChanged: (itemIds, hidden) =>
      commitProjectEvent(
        set,
        `${hidden ? "隐藏" : "显示"} ${itemIds.length} 个媒体`,
        hidden ? "hide" : "show",
        (state) => {
          const changedIds = new Set(itemIds);
          const mediaItems = state.mediaItems.map((item) =>
            changedIds.has(item.id) && isMediaItemHidden(item) !== hidden
              ? { ...item, hidden }
              : item,
          );
          return mediaItems.every((item, index) => item === state.mediaItems[index])
            ? state
            : { mediaItems, projectDirty: true };
        },
      ),
    mediaItemsOfflineChanged: (itemIds, offline) =>
      commitProjectEvent(
        set,
        `${offline ? "设为脱机" : "恢复联机"} ${itemIds.length} 个媒体`,
        offline ? "offline" : "online",
        (state) => {
          const changedIds = new Set(itemIds);
          const mediaItems = state.mediaItems.map((item) =>
            changedIds.has(item.id) && isMediaItemOffline(item) !== offline
              ? { ...item, offline }
              : item,
          );
          if (mediaItems.every((item, index) => item === state.mediaItems[index])) {
            return state;
          }
          const activeVideo = mediaItems.find((item) => item.id === state.activeVideoId);
          const activeProject = activeVideo
            ? (mediaItemProject(activeVideo, state.projects, mediaItems) ?? null)
            : null;
          return {
            mediaItems,
            useProxy:
              activeVideo && isMediaItemOffline(activeVideo)
                ? Boolean(activeProject?.proxy_path)
                : state.useProxy,
            proxyDialogOpen:
              activeVideo && isMediaItemOffline(activeVideo) ? false : state.proxyDialogOpen,
            projectDirty: true,
          };
        },
      ),
    mediaItemRelinked: (itemId, path, linkedProject, historyLabel = "重新链接媒体") =>
      commitProjectEvent(set, historyLabel, "relink", (state) => {
        const item = state.mediaItems.find((candidate) => candidate.id === itemId);
        if (!item) {
          return state;
        }
        const currentProject = mediaItemProject(item, state.projects, state.mediaItems);
        if (!linkedProject || !currentProject) {
          const mediaItems = state.mediaItems.map((candidate) =>
            candidate.id === itemId ? { ...candidate, path, offline: false } : candidate,
          );
          return { mediaItems, projectDirty: true };
        }

        const projectId = currentProject.asset.id;
        const project: Project = {
          ...linkedProject,
          asset: { ...linkedProject.asset, id: projectId },
          tracks: linkedProject.tracks.map((track) => ({ ...track, asset_id: projectId })),
        };
        const descriptor = projectMediaItem(project);
        const mediaItems = state.mediaItems.map((candidate) =>
          candidate.id === itemId
            ? {
                ...candidate,
                kind: descriptor.kind,
                offline: false,
                path,
                duration_us: descriptor.duration_us,
                start_time_us: descriptor.start_time_us,
                stream_index: descriptor.stream_index,
                codec: descriptor.codec,
                language: descriptor.language,
                color: descriptor.color,
              }
            : candidate,
        );
        const projects = { ...state.projects, [projectId]: project };
        const activeProject = state.project?.asset.id === projectId ? project : state.project;
        const currentTrackVisible = visibleSubtitleTracks(
          activeProject,
          mediaItems,
          state.activeVideoId,
          projects,
        ).some((track) => track.id === state.activeTrackId);
        const activeTrackId = currentTrackVisible
          ? state.activeTrackId
          : preferredTrackId(activeProject, projects, mediaItems, state.activeVideoId);
        return {
          projects,
          mediaItems,
          project: activeProject,
          ...subtitleContextState(state.subtitleSelections, state.activeVideoId, activeTrackId),
          proxyPath: activeProject === project ? project.proxy_path : state.proxyPath,
          useProxy:
            activeProject === project
              ? state.useProxy && Boolean(project.proxy_path)
              : state.useProxy,
          proxyDialogOpen: activeProject === project ? false : state.proxyDialogOpen,
          exportResult: activeProject === project ? null : state.exportResult,
          projectDirty: true,
        };
      }),
    mediaProxyPathChanged: (itemId, path) =>
      commitProjectEvent(set, path ? "连接代理" : "分离代理", "proxy", (state) => {
        const item = state.mediaItems.find((candidate) => candidate.id === itemId);
        const currentProject = item
          ? mediaItemProject(item, state.projects, state.mediaItems)
          : undefined;
        if (!currentProject || currentProject.proxy_path === path) {
          return state;
        }
        const project = { ...currentProject, proxy_path: path };
        const projects = { ...state.projects, [project.asset.id]: project };
        const isActiveProject = state.project?.asset.id === project.asset.id;
        return {
          projects,
          project: isActiveProject ? project : state.project,
          proxyPath: isActiveProject ? path : state.proxyPath,
          useProxy: isActiveProject ? Boolean(path) : state.useProxy,
          proxyDialogOpen: isActiveProject ? false : state.proxyDialogOpen,
          projectDirty: true,
        };
      }),
    mediaItemsBound: (itemIds, videoId) =>
      commitProjectEvent(set, `绑定 ${itemIds.length} 个媒体`, "bind", (state) => {
        const selected = new Set(itemIds);
        const mediaItems = state.mediaItems.map((item) =>
          selected.has(item.id) && item.kind !== "video"
            ? { ...item, bound_to_video_id: videoId }
            : item,
        );
        const activeProject = state.project;
        const currentTrackVisible = visibleSubtitleTracks(
          activeProject,
          mediaItems,
          state.activeVideoId,
          state.projects,
        ).some((track) => track.id === state.activeTrackId);
        const activeTrackId = currentTrackVisible
          ? state.activeTrackId
          : preferredTrackId(activeProject, state.projects, mediaItems, state.activeVideoId);
        return {
          mediaItems,
          projectDirty: true,
          ...subtitleContextState(state.subtitleSelections, state.activeVideoId, activeTrackId),
        };
      }),
    mediaItemsUnbound: (itemIds) =>
      commitProjectEvent(set, `解除 ${itemIds.length} 个媒体的绑定`, "unbind", (state) => {
        const selected = new Set(itemIds);
        const mediaItems = state.mediaItems.map((item) =>
          selected.has(item.id) && item.kind !== "video"
            ? { ...item, bound_to_video_id: null }
            : item,
        );
        const currentTrackVisible = visibleSubtitleTracks(
          state.project,
          mediaItems,
          state.activeVideoId,
          state.projects,
        ).some((track) => track.id === state.activeTrackId);
        const activeTrackId = currentTrackVisible
          ? state.activeTrackId
          : preferredTrackId(state.project, state.projects, mediaItems, state.activeVideoId);
        return {
          mediaItems,
          projectDirty: true,
          ...subtitleContextState(state.subtitleSelections, state.activeVideoId, activeTrackId),
        };
      }),
    mediaItemsRemoved: (itemIds) =>
      commitProjectEvent(set, `移除 ${itemIds.length} 个媒体`, "delete", (state) => {
        const removed = new Set(itemIds);
        const removedVideoIds = new Set(
          state.mediaItems
            .filter((item) => removed.has(item.id) && item.kind === "video")
            .map((item) => item.id),
        );
        const mediaItems = state.mediaItems
          .filter((item) => !removed.has(item.id))
          .map((item) =>
            item.bound_to_video_id && removedVideoIds.has(item.bound_to_video_id)
              ? { ...item, bound_to_video_id: null }
              : item,
          );
        const projects = { ...state.projects };
        for (const projectId of Object.keys(projects)) {
          const isStillReferenced = mediaItems.some(
            (item) => item.id === projectId || item.source_video_id === projectId,
          );
          if (!isStillReferenced) {
            delete projects[projectId];
          }
        }
        const nextVideo = removedVideoIds.has(state.activeVideoId)
          ? mediaItems.find(
              (item) =>
                item.kind === "video" &&
                isMediaItemEnabled(item) &&
                mediaItemProject(item, projects, mediaItems),
            )
          : mediaItems.find((item) => item.id === state.activeVideoId);
        const nextVideoId = nextVideo?.id ?? "";
        const project = nextVideo
          ? (mediaItemProject(nextVideo, projects, mediaItems) ?? null)
          : null;
        const detachedVideoIds = new Set(state.detachedVideoIds);
        for (const videoId of removedVideoIds) {
          detachedVideoIds.delete(videoId);
        }
        const activeTrackVisible = visibleSubtitleTracks(
          project,
          mediaItems,
          nextVideoId,
          projects,
        ).some((track) => track.id === state.activeTrackId);
        const activeTrackId = activeTrackVisible
          ? state.activeTrackId
          : preferredTrackId(project, projects, mediaItems, nextVideoId);
        const subtitleSelections = { ...state.subtitleSelections };
        for (const videoId of removedVideoIds) {
          delete subtitleSelections[videoId];
        }
        return {
          projects,
          mediaItems,
          detachedVideoIds,
          project,
          subtitleSelections,
          ...subtitleContextState(subtitleSelections, nextVideoId, activeTrackId),
          proxyPath: project?.proxy_path ?? null,
          useProxy: Boolean(nextVideo && isMediaItemOffline(nextVideo) && project?.proxy_path),
          projectDirty: true,
        };
      }),
    mediaDemuxed: (videoId, result) =>
      commitProjectEvent(set, "分解媒体轨道", "demux", (state) => {
        const video = state.mediaItems.find((item) => item.id === videoId);
        const project = video
          ? mediaItemProject(video, state.projects, state.mediaItems)
          : undefined;
        if (!project) {
          return state;
        }
        const additions: MediaBinItem[] = [
          ...result.audio_tracks.map((track, index) => ({
            id: `demux-audio:${videoId}:${track.stream_index}`,
            kind: "audio" as const,
            enabled: true,
            hidden: false,
            offline: false,
            path: "",
            file_name: track.file_name,
            duration_us: track.duration_us,
            start_time_us: 0,
            bound_to_video_id: videoId,
            source_video_id: project.asset.id,
            stream_index: track.stream_index,
            subtitle_track_id: null,
            codec: track.codec,
            language: track.language,
            extracted: false,
            origin: "decomposed" as const,
            color: mediaLabelColors.audio,
          })),
          ...result.subtitle_tracks.map((track, index) => ({
            id: `demux-subtitle:${videoId}:${track.id}`,
            kind: "subtitle" as const,
            enabled: true,
            hidden: false,
            offline: false,
            path: "",
            file_name:
              track.title ||
              fileName(track.source_path ?? "") ||
              `字幕流 ${track.stream_index ?? index + 1}`,
            duration_us: project.asset.duration_us,
            start_time_us: 0,
            bound_to_video_id: videoId,
            source_video_id: project.asset.id,
            stream_index: track.stream_index,
            subtitle_track_id: track.id,
            codec: track.codec,
            language: track.language,
            extracted: false,
            origin: "decomposed" as const,
            color: mediaLabelColors.subtitle,
          })),
        ];
        const knownIds = new Set(state.mediaItems.map((item) => item.id));
        const detachedVideoIds = new Set(state.detachedVideoIds).add(videoId);
        const demuxedTracks = new Map(result.subtitle_tracks.map((track) => [track.id, track]));
        const nextProject = {
          ...project,
          tracks: project.tracks.map((track) => demuxedTracks.get(track.id) ?? track),
        };
        return {
          projects: { ...state.projects, [nextProject.asset.id]: nextProject },
          project: state.project?.asset.id === nextProject.asset.id ? nextProject : state.project,
          mediaItems: [
            ...state.mediaItems.map((item) =>
              item.id === videoId ? { ...item, color: mediaLabelColors.videoOnly } : item,
            ),
            ...additions.filter((item) => !knownIds.has(item.id)),
          ],
          detachedVideoIds,
          projectDirty: true,
        };
      }),
    activeVideoChanged: (videoId) =>
      set((state) => {
        const video = state.mediaItems.find(
          (item) => item.id === videoId && item.kind === "video" && isMediaItemEnabled(item),
        );
        const project = video
          ? mediaItemProject(video, state.projects, state.mediaItems)
          : undefined;
        if (!video || !project || videoId === state.activeVideoId) {
          return state;
        }
        const activeTrackId = preferredTrackId(project, state.projects, state.mediaItems, videoId);
        return {
          project,
          ...subtitleContextState(state.subtitleSelections, videoId, activeTrackId),
          proxyPath: project.proxy_path,
          useProxy: isMediaItemOffline(video) && Boolean(project.proxy_path),
          proxyDialogOpen: false,
          exportResult: null,
        };
      }),
    subtitleTracksAdded: (tracks, cues) =>
      commitProjectEvent(set, `添加 ${tracks.length} 条字幕轨`, "subtitle", (state) => {
        if (!state.project) {
          return state;
        }
        const videoId = state.activeVideoId || state.project.asset.id;
        const nextProject = {
          ...state.project,
          tracks: [...state.project.tracks, ...tracks],
          cues: { ...state.project.cues, ...cues },
        };
        const additions = tracks
          .filter((track) => track.source_path)
          .map((track, index): MediaBinItem => ({
            id: `subtitle:${track.id}`,
            kind: "subtitle",
            enabled: true,
            hidden: false,
            offline: false,
            path: track.source_path ?? "",
            file_name: fileName(track.source_path ?? track.title ?? `字幕 ${index + 1}`),
            duration_us: nextProject.asset.duration_us,
            start_time_us: 0,
            bound_to_video_id: videoId,
            source_video_id: null,
            stream_index: track.stream_index,
            subtitle_track_id: track.id,
            codec: track.codec,
            language: track.language,
            extracted: false,
            origin: "imported" as const,
            color: mediaLabelColors.subtitle,
          }));
        const firstUsableTrack = tracks.find((track) => track.cue_count > 0);
        const activeTrackId = firstUsableTrack?.id || state.activeTrackId || "";
        return {
          project: nextProject,
          projects: { ...state.projects, [nextProject.asset.id]: nextProject },
          mediaItems: [...state.mediaItems, ...additions],
          projectDirty: true,
          ...subtitleContextState(state.subtitleSelections, videoId, activeTrackId),
        };
      }),
    subtitleTracksAddedToVideo: (videoId, tracks, cues, itemIds) =>
      commitProjectEvent(set, `绑定 ${tracks.length} 条字幕轨`, "bind", (state) => {
        const video = state.mediaItems.find((item) => item.id === videoId);
        const project = video
          ? mediaItemProject(video, state.projects, state.mediaItems)
          : undefined;
        if (!project) {
          return state;
        }
        const nextProject = {
          ...project,
          tracks: [...project.tracks, ...tracks],
          cues: { ...project.cues, ...cues },
        };
        const trackByItemId = new Map(
          itemIds.map((itemId, index) => [itemId, tracks[index]] as const),
        );
        const mediaItems = state.mediaItems.map((item) => {
          const track = trackByItemId.get(item.id);
          return track
            ? {
                ...item,
                bound_to_video_id: videoId,
                subtitle_track_id: track.id,
                codec: track.codec,
                language: track.language,
              }
            : item;
        });
        const projects = { ...state.projects, [project.asset.id]: nextProject };
        if (state.activeVideoId !== videoId) {
          return { projects, mediaItems, projectDirty: true };
        }
        const currentTrackVisible = visibleSubtitleTracks(
          nextProject,
          mediaItems,
          videoId,
          projects,
        ).some((track) => track.id === state.activeTrackId);
        const activeTrackId = currentTrackVisible
          ? state.activeTrackId
          : (tracks.find((track) => track.cue_count > 0)?.id ?? state.activeTrackId);
        return {
          projects,
          mediaItems,
          project: nextProject,
          projectDirty: true,
          ...subtitleContextState(state.subtitleSelections, videoId, activeTrackId),
        };
      }),
    activeTrackChanged: (activeTrackId) =>
      commitProjectEvent(set, "切换字幕轨", "subtitle", (state) => ({
        ...subtitleContextState(state.subtitleSelections, state.activeVideoId, activeTrackId),
        projectDirty: true,
      })),
    cueSelectionToggled: (cueId) =>
      commitProjectEvent(set, "更改台词选择", "selection", (state) => {
        const selectedCueIds = new Set(state.selectedCueIds);
        if (selectedCueIds.has(cueId)) {
          selectedCueIds.delete(cueId);
        } else {
          selectedCueIds.add(cueId);
        }
        return {
          ...replaceCurrentSubtitleSelection(state, selectedCueIds),
          projectDirty: true,
        };
      }),
    cueSelectionCleared: () =>
      commitProjectEvent(set, "清除台词选择", "delete", (state) =>
        state.selectedCueIds.size === 0
          ? state
          : {
              ...replaceCurrentSubtitleSelection(state, new Set<string>()),
              projectDirty: true,
            },
      ),
    cueSelectionReplaced: (cueIds) =>
      commitProjectEvent(set, `选择 ${cueIds.length} 条台词`, "selection", (state) => {
        const selectedCueIds = new Set(cueIds);
        if (
          selectedCueIds.size === state.selectedCueIds.size &&
          [...selectedCueIds].every((cueId) => state.selectedCueIds.has(cueId))
        ) {
          return state;
        }
        return {
          ...replaceCurrentSubtitleSelection(state, selectedCueIds),
          projectDirty: true,
        };
      }),
    proxyDialogOpened: () => set({ proxyDialogOpen: true }),
    proxyDialogClosed: () => set({ proxyDialogOpen: false }),
    sourcePreviewSelected: () =>
      set((state) => {
        const activeVideo = state.mediaItems.find((item) => item.id === state.activeVideoId);
        return activeVideo && isMediaItemOffline(activeVideo)
          ? state
          : { ...state, proxyDialogOpen: false, useProxy: false };
      }),
    proxyPreviewSelected: () => set((state) => (state.proxyPath ? { useProxy: true } : state)),
    proxyGenerated: (proxyPath) =>
      commitProjectEvent(set, "生成代理文件", "proxy", (state) => {
        const project = state.project ? { ...state.project, proxy_path: proxyPath } : null;
        return {
          project,
          projects:
            project && state.activeVideoId
              ? { ...state.projects, [project.asset.id]: project }
              : state.projects,
          projectDirty: Boolean(project),
          proxyPath,
          useProxy: true,
          proxyDialogOpen: false,
        };
      }),
    preferencesLoaded: (preferences) => set({ preferences }),
    messagePublished: (message) => set({ message }),
    warningsReplaced: (warnings) => set({ warnings }),
    warningsAppended: (warnings) =>
      set((state) => ({ warnings: [...state.warnings, ...warnings] })),
    exportResultChanged: (exportResult) => set({ exportResult }),
    mediaBinReadOnlyChanged: (mediaBinReadOnly) => set({ mediaBinReadOnly }),
    projectHistoryJumped: (targetCursor) => {
      let changed = false;
      set((state) => {
        const target = Math.max(0, Math.min(targetCursor, state.projectHistory.entries.length));
        if (!state.projectHistory.active || target === state.projectHistory.cursor) {
          return state;
        }

        let projectFileState = projectFileStateFromStore(state);
        if (target < state.projectHistory.cursor) {
          for (let index = state.projectHistory.cursor - 1; index >= target; index -= 1) {
            projectFileState = applyProjectFileEvent(
              projectFileState,
              state.projectHistory.entries[index].inverseEvent,
            );
          }
        } else {
          for (let index = state.projectHistory.cursor; index < target; index += 1) {
            projectFileState = applyProjectFileEvent(
              projectFileState,
              state.projectHistory.entries[index].event,
            );
          }
        }

        const projectHistory = { ...state.projectHistory, cursor: target };
        changed = true;
        return {
          ...reconciledProjectFileState(projectFileState),
          projectHistory,
          projectDirty: isProjectHistoryDirty(projectHistory),
        };
      });
      return changed;
    },
    projectHistoryFutureDiscarded: () =>
      set((state) => {
        const projectHistory = discardFutureProjectHistory(state.projectHistory);
        return projectHistory === state.projectHistory
          ? state
          : { projectHistory, projectDirty: isProjectHistoryDirty(projectHistory) };
      }),
  },
}));

export function useAppStore<Selection>(selector: (state: AppStore) => Selection) {
  return useStore(appStore, selector);
}

export function getProjectWorkspaceSnapshot(): ProjectWorkspace {
  const state = appStore.getState();
  return {
    projects: Object.values(state.projects),
    media_bin: {
      items: state.mediaItems.map((item) => ({
        ...item,
        enabled: item.enabled !== false,
        hidden: item.hidden === true,
        offline: item.offline === true,
      })),
    },
    editor: {
      active_video_id: state.activeVideoId,
      active_track_id: state.activeTrackId,
      subtitle_selections: serializeSubtitleSelections(state.subtitleSelections),
      detached_video_ids: [...state.detachedVideoIds],
      preview: {
        use_proxy: state.useProxy,
      },
    },
  };
}
