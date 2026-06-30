import { create } from "zustand";
import type { ExportOptions, Project } from "./types";

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
  setExportOptions: (options) =>
    set((state) => ({
      exportOptions: {
        ...state.exportOptions,
        ...options,
      },
    })),
}));
