import { create } from "zustand";
import type { ExportOptions, Project, SubtitleCue, SubtitleTrack } from "./types";

interface AppStore {
  project: Project | null;
  activeTrackId: string;
  query: string;
  selectedCueIds: Set<string>;
  proxyPath: string | null;
  exportOptions: ExportOptions;
  setProject: (project: Project) => void;
  setActiveTrackId: (trackId: string) => void;
  setQuery: (query: string) => void;
  toggleCue: (cueId: string) => void;
  clearSelection: () => void;
  selectCueIds: (cueIds: string[]) => void;
  setProxyPath: (path: string | null) => void;
  setExportOptions: (options: Partial<ExportOptions>) => void;
  addExternalSubtitles: (tracks: SubtitleTrack[], cues: Record<string, SubtitleCue[]>) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  project: null,
  activeTrackId: "",
  query: "",
  selectedCueIds: new Set<string>(),
  proxyPath: null,
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
  setProject: (project) => {
    const firstTextTrack =
      project.tracks.find((track) => track.kind === "text" && track.cue_count > 0) ??
      project.tracks[0];
    set({
      project,
      activeTrackId: firstTextTrack?.id ?? "",
      selectedCueIds: new Set<string>(),
      proxyPath: project.proxy_path,
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
}));
