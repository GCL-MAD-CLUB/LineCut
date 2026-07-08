import { create } from "zustand";
import type { ExportOptions, ExportResult, Preferences, Project, SubtitleCue, SubtitleTrack } from "./types";

interface AppStore {
  project: Project | null;
  activeTrackId: string;
  query: string;
  selectedCueIds: Set<string>;
  showOnlySelected: boolean;
  proxyPath: string | null;
  useProxy: boolean;
  isGeneratingProxy: boolean;
  proxyDialogOpen: boolean;
  exportOptions: ExportOptions;
  preferences: Preferences;
  busyLabel: string;
  message: string;
  warnings: string[];
  exportResult: ExportResult | null;
  setProject: (project: Project) => void;
  setActiveTrackId: (trackId: string) => void;
  setQuery: (query: string) => void;
  setShowOnlySelected: (value: boolean) => void;
  toggleCue: (cueId: string) => void;
  clearSelection: () => void;
  selectCueIds: (cueIds: string[]) => void;
  setProxyPath: (path: string | null) => void;
  setUseProxy: (value: boolean) => void;
  setIsGeneratingProxy: (value: boolean) => void;
  setProxyDialogOpen: (value: boolean) => void;
  setExportOptions: (options: Partial<ExportOptions>) => void;
  setPreferences: (preferences: Preferences) => void;
  setBusyLabel: (label: string) => void;
  setMessage: (message: string) => void;
  setWarnings: (warnings: string[] | ((current: string[]) => string[])) => void;
  setExportResult: (result: ExportResult | null) => void;
  addExternalSubtitles: (tracks: SubtitleTrack[], cues: Record<string, SubtitleCue[]>) => void;
}

export function defaultPreferences(): Preferences {
  return {
    cache_dir: "",
    default_export_dir: "",
    ffmpeg_path: "ffmpeg",
    ffprobe_path: "ffprobe",
  };
}

export const useAppStore = create<AppStore>((set) => ({
  project: null,
  activeTrackId: "",
  query: "",
  selectedCueIds: new Set<string>(),
  showOnlySelected: false,
  proxyPath: null,
  useProxy: false,
  isGeneratingProxy: false,
  proxyDialogOpen: false,
  exportOptions: {
    head_padding_ms: 300,
    tail_padding_ms: 500,
    merge_gap_ms: 800,
    mode: "precise_encode",
    layout: "individual",
    output_dir: "",
    output_dir_explicit: false,
    export_name_rule: "source_time_range",
    dialogue_line_indexes: [],
  },
  preferences: defaultPreferences(),
  busyLabel: "",
  message: "就绪",
  warnings: [],
  exportResult: null,
  setProject: (project) => {
    const firstTextTrack =
      project.tracks.find((track) => track.kind === "text" && track.cue_count > 0) ??
      project.tracks[0];
    set({
      project,
      activeTrackId: firstTextTrack?.id ?? "",
      selectedCueIds: new Set<string>(),
      proxyPath: project.proxy_path,
      useProxy: false,
      query: "",
    });
  },
  setActiveTrackId: (trackId) =>
    set({
      activeTrackId: trackId,
      selectedCueIds: new Set<string>(),
      query: "",
    }),
  setQuery: (query) => set({ query }),
  setShowOnlySelected: (showOnlySelected) => set({ showOnlySelected }),
  toggleCue: (cueId) =>
    set((state) => {
      const next = new Set(state.selectedCueIds);
      if (next.has(cueId)) {
        next.delete(cueId);
      } else {
        next.add(cueId);
      }
      return { selectedCueIds: next };
    }),
  clearSelection: () => set({ selectedCueIds: new Set<string>() }),
  selectCueIds: (cueIds) => set({ selectedCueIds: new Set(cueIds) }),
  setProxyPath: (path) => set({ proxyPath: path }),
  setUseProxy: (useProxy) => set({ useProxy }),
  setIsGeneratingProxy: (isGeneratingProxy) => set({ isGeneratingProxy }),
  setProxyDialogOpen: (proxyDialogOpen) => set({ proxyDialogOpen }),
  addExternalSubtitles: (tracks, cues) =>
    set((state) => {
      if (!state.project) {
        return state;
      }
      const nextTracks = [...state.project.tracks, ...tracks];
      const nextCues = { ...state.project.cues, ...cues };
      const firstUsableTrack = tracks.find((track) => track.cue_count > 0);
      const currentTrack = state.project.tracks.find((track) => track.id === state.activeTrackId);
      const currentTrackUsable = currentTrack ? currentTrack.cue_count > 0 : false;
      const nextActiveTrackId = currentTrackUsable
        ? state.activeTrackId
        : firstUsableTrack?.id || state.activeTrackId || "";
      return {
        project: { ...state.project, tracks: nextTracks, cues: nextCues },
        activeTrackId: nextActiveTrackId,
        selectedCueIds: new Set<string>(),
        query: "",
      };
    }),
  setExportOptions: (options) =>
    set((state) => ({
      exportOptions: {
        ...state.exportOptions,
        ...options,
      },
    })),
  setPreferences: (preferences) => set({ preferences }),
  setBusyLabel: (busyLabel) => set({ busyLabel }),
  setMessage: (message) => set({ message }),
  setWarnings: (warnings) =>
    set((state) => ({
      warnings: typeof warnings === "function" ? warnings(state.warnings) : warnings,
    })),
  setExportResult: (exportResult) => set({ exportResult }),
}));
