import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ExportResult, Preferences, Project, SubtitleCue, SubtitleTrack } from "./types";

interface AppActions {
  projectImported: (project: Project) => void;
  subtitleTracksAdded: (tracks: SubtitleTrack[], cues: Record<string, SubtitleCue[]>) => void;
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
}

interface AppStore {
  project: Project | null;
  activeTrackId: string;
  selectedCueIds: Set<string>;
  proxyPath: string | null;
  useProxy: boolean;
  proxyDialogOpen: boolean;
  preferences: Preferences;
  message: string;
  warnings: string[];
  exportResult: ExportResult | null;
  actions: AppActions;
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
  project: null,
  activeTrackId: "",
  selectedCueIds: new Set<string>(),
  proxyPath: null,
  useProxy: false,
  proxyDialogOpen: false,
  preferences: defaultPreferences(),
  message: "就绪",
  warnings: [],
  exportResult: null,
  actions: {
    projectImported: (project) => {
      const firstTextTrack =
        project.tracks.find((track) => track.kind === "text" && track.cue_count > 0) ??
        project.tracks[0];
      set({
        project,
        activeTrackId: firstTextTrack?.id ?? "",
        selectedCueIds: new Set<string>(),
        proxyPath: project.proxy_path,
        useProxy: false,
      });
    },
    subtitleTracksAdded: (tracks, cues) =>
      set((state) => {
        if (!state.project) {
          return state;
        }
        const nextTracks = [...state.project.tracks, ...tracks];
        const nextCues = { ...state.project.cues, ...cues };
        const firstUsableTrack = tracks.find((track) => track.cue_count > 0);
        const currentTrack = state.project.tracks.find((track) => track.id === state.activeTrackId);
        const nextActiveTrackId = currentTrack?.cue_count
          ? state.activeTrackId
          : firstUsableTrack?.id || state.activeTrackId || "";
        return {
          project: { ...state.project, tracks: nextTracks, cues: nextCues },
          activeTrackId: nextActiveTrackId,
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
      set({
        proxyPath,
        useProxy: true,
        proxyDialogOpen: false,
      }),
    preferencesLoaded: (preferences) => set({ preferences }),
    messagePublished: (message) => set({ message }),
    warningsReplaced: (warnings) => set({ warnings }),
    warningsAppended: (warnings) =>
      set((state) => ({ warnings: [...state.warnings, ...warnings] })),
    exportResultChanged: (exportResult) => set({ exportResult }),
  },
}));

export function useAppStore<Selection>(selector: (state: AppStore) => Selection) {
  return useStore(appStore, selector);
}
