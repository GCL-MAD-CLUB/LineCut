import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
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
  projectOpened: (workspace: ProjectWorkspace, path: string) => void;
  projectSaved: (path: string) => void;
  projectClosed: () => void;
  mediaProjectsAdded: (projects: Project[]) => void;
  mediaItemsAdded: (items: MediaBinItem[]) => void;
  mediaItemRenamed: (itemId: string, fileName: string) => void;
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
  selectedCueIds: Set<string>;
  proxyPath: string | null;
  useProxy: boolean;
  proxyDialogOpen: boolean;
  preferences: Preferences;
  message: string;
  warnings: string[];
  exportResult: ExportResult | null;
  mediaBinReadOnly: boolean;
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

function projectMediaItem(project: Project): MediaBinItem {
  const isVideo = project.asset.video_stream_index !== null;
  const hasAudio = project.asset.audio_stream_index !== null;
  const stream = project.streams.find((item) =>
    isVideo ? item.codec_type === "video" : item.codec_type === "audio",
  );
  return {
    id: project.asset.id,
    kind: isVideo ? "video" : "audio",
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
) {
  if (!project) {
    return [];
  }
  return project.tracks.filter((track) => {
    if (track.source_type === "embedded") {
      return true;
    }
    const item = mediaItems.find(
      (candidate) => candidate.kind === "subtitle" && candidate.subtitle_track_id === track.id,
    );
    if (item) {
      return item.bound_to_video_id === videoId;
    }
    const trackWasRebound = Boolean(
      track.source_path &&
      mediaItems.some(
        (candidate) => candidate.kind === "subtitle" && candidate.path === track.source_path,
      ),
    );
    return !trackWasRebound;
  });
}

function preferredTrackId(project: Project | null, mediaItems: MediaBinItem[], videoId: string) {
  const tracks = visibleSubtitleTracks(project, mediaItems, videoId);
  return (
    tracks.find((track) => track.kind === "text" && track.cue_count > 0)?.id ?? tracks[0]?.id ?? ""
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
    activeTrackId: preferredTrackId(project, mediaItems, project.asset.id),
    proxyPath: project.proxy_path,
  };
}

function openedProjectState(workspace: ProjectWorkspace) {
  const projects = Object.fromEntries(
    workspace.projects.map((project) => [project.asset.id, project]),
  );
  const mediaItems = workspace.media_bin.items;
  const videoIds = new Set(
    mediaItems.filter((item) => item.kind === "video" && projects[item.id]).map((item) => item.id),
  );
  const firstVideoId = videoIds.values().next().value ?? "";
  const activeVideoId = videoIds.has(workspace.editor.active_video_id)
    ? workspace.editor.active_video_id
    : firstVideoId;
  const project = activeVideoId ? (projects[activeVideoId] ?? null) : null;
  const visibleTrackIds = new Set(
    visibleSubtitleTracks(project, mediaItems, activeVideoId).map((track) => track.id),
  );
  const activeTrackId = visibleTrackIds.has(workspace.editor.active_track_id)
    ? workspace.editor.active_track_id
    : preferredTrackId(project, mediaItems, activeVideoId);
  const validCueIds = new Set(
    activeTrackId ? (project?.cues[activeTrackId] ?? []).map((cue) => cue.id) : [],
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
    selectedCueIds: new Set(
      workspace.editor.selected_cue_ids.filter((cueId) => validCueIds.has(cueId)),
    ),
    proxyPath: project?.proxy_path ?? null,
    useProxy: workspace.editor.preview.use_proxy && Boolean(project?.proxy_path),
    mediaBinReadOnly: workspace.media_bin.read_only,
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
  actions: {
    projectImported: (project) =>
      set({
        ...initialProjectState(project),
        projectDirty: true,
        selectedCueIds: new Set<string>(),
        useProxy: false,
        mediaBinReadOnly: false,
      }),
    projectOpened: (workspace, projectFilePath) =>
      set({
        ...openedProjectState(workspace),
        projectFilePath,
        projectDirty: false,
        proxyDialogOpen: false,
        warnings: [],
        exportResult: null,
      }),
    projectSaved: (projectFilePath) => set({ projectFilePath, projectDirty: false }),
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
      }),
    mediaProjectsAdded: (loadedProjects) =>
      set((state) => {
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
        return {
          projects,
          mediaItems: nextItems,
          project: firstVideo,
          activeVideoId: firstVideo.asset.id,
          activeTrackId: preferredTrackId(firstVideo, nextItems, firstVideo.asset.id),
          proxyPath: firstVideo.proxy_path,
          useProxy: false,
          selectedCueIds: new Set<string>(),
          projectDirty: true,
        };
      }),
    mediaItemsAdded: (items) =>
      set((state) => {
        const knownIds = new Set(state.mediaItems.map((item) => item.id));
        const additions = items.filter((item) => !knownIds.has(item.id));
        return additions.length === 0
          ? state
          : { mediaItems: [...state.mediaItems, ...additions], projectDirty: true };
      }),
    mediaItemRenamed: (itemId, fileName) =>
      set((state) => {
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
    mediaItemsBound: (itemIds, videoId) =>
      set((state) => {
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
        ).some((track) => track.id === state.activeTrackId);
        return {
          mediaItems,
          projectDirty: true,
          activeTrackId: currentTrackVisible
            ? state.activeTrackId
            : preferredTrackId(activeProject, mediaItems, state.activeVideoId),
          selectedCueIds: currentTrackVisible ? state.selectedCueIds : new Set<string>(),
        };
      }),
    mediaItemsUnbound: (itemIds) =>
      set((state) => {
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
        ).some((track) => track.id === state.activeTrackId);
        return {
          mediaItems,
          projectDirty: true,
          activeTrackId: currentTrackVisible
            ? state.activeTrackId
            : preferredTrackId(state.project, mediaItems, state.activeVideoId),
          selectedCueIds: currentTrackVisible ? state.selectedCueIds : new Set<string>(),
        };
      }),
    mediaItemsRemoved: (itemIds) =>
      set((state) => {
        const removed = new Set(itemIds);
        const removedVideoIds = new Set(
          state.mediaItems
            .filter((item) => removed.has(item.id) && item.kind === "video")
            .map((item) => item.id),
        );
        const removedProjectIds = new Set(
          state.mediaItems
            .filter((item) => removed.has(item.id) && state.projects[item.id])
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
        for (const projectId of removedProjectIds) {
          delete projects[projectId];
        }
        const nextVideoId = removedVideoIds.has(state.activeVideoId)
          ? (mediaItems.find((item) => item.kind === "video")?.id ?? "")
          : state.activeVideoId;
        const project = nextVideoId ? (projects[nextVideoId] ?? null) : null;
        const detachedVideoIds = new Set(state.detachedVideoIds);
        for (const videoId of removedVideoIds) {
          detachedVideoIds.delete(videoId);
        }
        const activeTrackVisible = visibleSubtitleTracks(project, mediaItems, nextVideoId).some(
          (track) => track.id === state.activeTrackId,
        );
        return {
          projects,
          mediaItems,
          detachedVideoIds,
          activeVideoId: nextVideoId,
          project,
          activeTrackId: activeTrackVisible
            ? state.activeTrackId
            : preferredTrackId(project, mediaItems, nextVideoId),
          selectedCueIds: new Set<string>(),
          proxyPath: project?.proxy_path ?? null,
          useProxy: false,
          projectDirty: true,
        };
      }),
    mediaDemuxed: (videoId, result) =>
      set((state) => {
        const project = state.projects[videoId];
        if (!project) {
          return state;
        }
        const additions: MediaBinItem[] = [
          ...result.audio_tracks.map((track, index) => ({
            id: `demux-audio:${videoId}:${track.stream_index}`,
            kind: "audio" as const,
            path: track.path,
            file_name: track.file_name,
            duration_us: track.duration_us,
            start_time_us: 0,
            bound_to_video_id: videoId,
            source_video_id: videoId,
            stream_index: track.stream_index,
            subtitle_track_id: null,
            codec: track.codec,
            language: track.language,
            extracted: true,
            origin: "decomposed" as const,
            color: mediaLabelColors.audio,
          })),
          ...result.subtitle_tracks
            .filter((track) => track.source_path)
            .map((track, index) => ({
              id: `demux-subtitle:${track.id}`,
              kind: "subtitle" as const,
              path: track.source_path ?? "",
              file_name:
                track.title ||
                fileName(track.source_path ?? "") ||
                `字幕流 ${track.stream_index ?? index + 1}`,
              duration_us: project.asset.duration_us,
              start_time_us: 0,
              bound_to_video_id: videoId,
              source_video_id: videoId,
              stream_index: track.stream_index,
              subtitle_track_id: track.id,
              codec: track.codec,
              language: track.language,
              extracted: true,
              origin: "decomposed" as const,
              color: mediaLabelColors.subtitle,
            })),
        ];
        const knownIds = new Set(state.mediaItems.map((item) => item.id));
        const detachedVideoIds = new Set(state.detachedVideoIds).add(videoId);
        return {
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
        const project = state.projects[videoId];
        if (!project || videoId === state.activeVideoId) {
          return state;
        }
        return {
          project,
          activeVideoId: videoId,
          activeTrackId: preferredTrackId(project, state.mediaItems, videoId),
          selectedCueIds: new Set<string>(),
          proxyPath: project.proxy_path,
          useProxy: false,
          proxyDialogOpen: false,
          exportResult: null,
        };
      }),
    subtitleTracksAdded: (tracks, cues) =>
      set((state) => {
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
        return {
          project: nextProject,
          projects: { ...state.projects, [videoId]: nextProject },
          mediaItems: [...state.mediaItems, ...additions],
          projectDirty: true,
          activeTrackId: firstUsableTrack?.id || state.activeTrackId || "",
          selectedCueIds: new Set<string>(),
        };
      }),
    subtitleTracksAddedToVideo: (videoId, tracks, cues, itemIds) =>
      set((state) => {
        const project = state.projects[videoId];
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
        const projects = { ...state.projects, [videoId]: nextProject };
        if (state.activeVideoId !== videoId) {
          return { projects, mediaItems, projectDirty: true };
        }
        const currentTrackVisible = visibleSubtitleTracks(nextProject, mediaItems, videoId).some(
          (track) => track.id === state.activeTrackId,
        );
        return {
          projects,
          mediaItems,
          project: nextProject,
          projectDirty: true,
          activeTrackId: currentTrackVisible
            ? state.activeTrackId
            : (tracks.find((track) => track.cue_count > 0)?.id ?? state.activeTrackId),
          selectedCueIds: new Set<string>(),
        };
      }),
    activeTrackChanged: (activeTrackId) =>
      set({
        activeTrackId,
        selectedCueIds: new Set<string>(),
      }),
    cueSelectionToggled: (cueId) =>
      set((state) => {
        const selectedCueIds = new Set(state.selectedCueIds);
        if (selectedCueIds.has(cueId)) {
          selectedCueIds.delete(cueId);
        } else {
          selectedCueIds.add(cueId);
        }
        return { selectedCueIds };
      }),
    cueSelectionCleared: () => set({ selectedCueIds: new Set<string>() }),
    cueSelectionReplaced: (cueIds) => set({ selectedCueIds: new Set(cueIds) }),
    proxyDialogOpened: () => set({ proxyDialogOpen: true }),
    proxyDialogClosed: () => set({ proxyDialogOpen: false }),
    sourcePreviewSelected: () => set({ proxyDialogOpen: false, useProxy: false }),
    proxyPreviewSelected: () => set((state) => (state.proxyPath ? { useProxy: true } : state)),
    proxyGenerated: (proxyPath) =>
      set((state) => {
        const project = state.project ? { ...state.project, proxy_path: proxyPath } : null;
        return {
          project,
          projects:
            project && state.activeVideoId
              ? { ...state.projects, [state.activeVideoId]: project }
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
    mediaBinReadOnlyChanged: (mediaBinReadOnly) =>
      set((state) =>
        state.mediaBinReadOnly === mediaBinReadOnly
          ? state
          : { mediaBinReadOnly, projectDirty: true },
      ),
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
      items: state.mediaItems,
      read_only: state.mediaBinReadOnly,
    },
    editor: {
      active_video_id: state.activeVideoId,
      active_track_id: state.activeTrackId,
      selected_cue_ids: [...state.selectedCueIds],
      detached_video_ids: [...state.detachedVideoIds],
      preview: {
        use_proxy: state.useProxy,
      },
    },
  };
}
