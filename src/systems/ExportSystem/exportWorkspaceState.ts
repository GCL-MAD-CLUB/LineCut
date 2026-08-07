import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { getProjectExportContext } from "../ProjectSystem";
import type { ExportResult, ExportSettings, ExportSource } from "./exportTypes";

const exportDirStorageKey = "linecut:export-dir";

/** Reads the last export directory the user picked, if any. */
export function readRememberedExportDir() {
  try {
    return window.localStorage.getItem(exportDirStorageKey) ?? "";
  } catch {
    return "";
  }
}

/** Remembers the export directory so the next export can default to it. */
export function rememberExportDir(dir: string) {
  try {
    window.localStorage.setItem(exportDirStorageKey, dir);
  } catch {
    // Remembering the export directory is a convenience; export itself must still work.
  }
}

export type ExportWorkspaceStatus = "idle" | "running" | "done";

export interface ExportWorkspaceState {
  source: ExportSource | null;
  selectedClipIds: Set<string>;
  settings: ExportSettings;
  /** Project id whose recorded settings back `settings`; null before any project load. */
  settingsProjectId: string | null;
  results: ExportResult | null;
  status: ExportWorkspaceStatus;
  /** The clip currently previewed in the export source player. */
  previewClipId: string | null;
  /** True while any export is in flight; exports are serialized. */
  isExporting: boolean;
  setSource: (source: ExportSource | null) => void;
  /** Loads the open project's recorded export settings when the project changed. */
  applyProjectExportSettings: () => void;
  toggleClip: (clipId: string) => void;
  setAllSelected: (selected: boolean) => void;
  updateSettings: (updates: Partial<ExportSettings>) => void;
  setResults: (results: ExportResult | null) => void;
  setStatus: (status: ExportWorkspaceStatus) => void;
  resetResults: () => void;
  setPreviewClip: (clipId: string | null) => void;
  setExporting: (isExporting: boolean) => void;
}

export function defaultExportSettings(): ExportSettings {
  return {
    mode: "individual",
    container: "mp4_h264",
    resolution: "match_source",
    customWidth: 1920,
    customHeight: 1080,
    frameRate: null,
    quality: "high",
    encoderSpeed: "balanced",
    includeAudio: true,
    audioCodec: "aac",
    audioSampleRateHz: null,
    audioChannels: "stereo",
    audioBitrateKbps: 192,
    importIntoProject: false,
    useProxy: false,
    destination: "specified",
    useSubfolder: false,
    subfolderName: "",
    outputDir: "",
    outputStem: "",
    renameRule: "filename",
    customName: "",
    startNumber: 1,
    extensionCase: "lower",
    // Key order must match the backend's ExportOptions serialization; exportSettingsEqual compares via JSON.stringify.
    outputName: "",
    existingFileMode: "ask",
  };
}

function reconcileSettings(
  settings: ExportSettings,
  settingsProjectId: string | null,
): { settings: ExportSettings; settingsProjectId: string | null } {
  const { projectId, exportState } = getProjectExportContext();
  if (projectId === settingsProjectId) {
    return { settings, settingsProjectId };
  }
  return {
    settings: exportState
      ? { ...defaultExportSettings(), ...exportState }
      : defaultExportSettings(),
    settingsProjectId: projectId,
  };
}

export const exportWorkspaceStore = createStore<ExportWorkspaceState>()((set) => ({
  source: null,
  selectedClipIds: new Set<string>(),
  settings: defaultExportSettings(),
  settingsProjectId: null,
  results: null,
  status: "idle",
  previewClipId: null,
  isExporting: false,
  setSource: (source) =>
    set((state) => {
      const reconciled = reconcileSettings(state.settings, state.settingsProjectId);
      return {
        source,
        selectedClipIds: source ? new Set(source.clips.map((clip) => clip.id)) : new Set<string>(),
        previewClipId: source?.clips[0]?.id ?? null,
        // The output stem is derived by the export workspace from the project/source,
        // so it is left untouched here.
        settings: reconciled.settings,
        settingsProjectId: reconciled.settingsProjectId,
        results: null,
        status: "idle",
      };
    }),
  applyProjectExportSettings: () =>
    set((state) => {
      const reconciled = reconcileSettings(state.settings, state.settingsProjectId);
      return reconciled.settings === state.settings ? state : reconciled;
    }),
  toggleClip: (clipId) =>
    set((state) => {
      const selectedClipIds = new Set(state.selectedClipIds);
      if (selectedClipIds.has(clipId)) {
        selectedClipIds.delete(clipId);
      } else {
        selectedClipIds.add(clipId);
      }
      return { selectedClipIds };
    }),
  setAllSelected: (selected) =>
    set((state) => ({
      selectedClipIds:
        selected && state.source
          ? new Set(state.source.clips.map((clip) => clip.id))
          : new Set<string>(),
    })),
  updateSettings: (updates) => set((state) => ({ settings: { ...state.settings, ...updates } })),
  setResults: (results) => set({ results }),
  setStatus: (status) => set({ status }),
  resetResults: () => set({ results: null, status: "idle" }),
  setPreviewClip: (previewClipId) => set({ previewClipId }),
  setExporting: (isExporting) => set({ isExporting }),
}));

export function useExportWorkspaceState<Selection>(
  selector: (state: ExportWorkspaceState) => Selection,
) {
  return useStore(exportWorkspaceStore, selector);
}
