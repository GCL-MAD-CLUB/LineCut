import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { getProjectExportContext } from "../ProjectSystem";
import type { ExportClip, ExportResult, ExportSettings, ExportSource } from "./exportTypes";

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

interface ExportRangeHistoryEntry {
  clipId: string;
  before: { startUs: number; endUs: number };
  after: { startUs: number; endUs: number };
  groupId: string | undefined;
}

function withClipRange(clip: ExportClip, range: { startUs: number; endUs: number }): ExportClip {
  return {
    ...clip,
    ...range,
    durationUs:
      range.endUs > 0
        ? Math.max(0, range.endUs - range.startUs)
        : Math.max(0, (clip.sourceMedia?.durationUs ?? clip.durationUs) - range.startUs),
    thumbnail: clip.thumbnail ? { ...clip.thumbnail, timeUs: range.startUs } : undefined,
  };
}

export interface ExportWorkspaceState {
  source: ExportSource | null;
  sourceInput: ExportSource | null;
  sourceProjectId: string | null;
  rangeHistory: ExportRangeHistoryEntry[];
  rangeHistoryCursor: number;
  selectedClipIds: Set<string>;
  settings: ExportSettings;
  /** Project id whose recorded settings back `settings`; null before any project load. */
  settingsProjectId: string | null;
  results: ExportResult | null;
  status: ExportWorkspaceStatus;
  previewClipId: string | null;
  previewVersion: number;
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
  updateClipRange: (clipId: string, startUs: number, endUs: number, groupId?: string) => void;
  undoClipRange: () => void;
  redoClipRange: () => void;
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
    hardwareAcceleration: "auto",
    includeVideo: true,
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
  sourceInput: null,
  sourceProjectId: null,
  rangeHistory: [],
  rangeHistoryCursor: 0,
  selectedClipIds: new Set<string>(),
  settings: defaultExportSettings(),
  settingsProjectId: null,
  results: null,
  status: "idle",
  previewClipId: null,
  previewVersion: 0,
  setSource: (source) =>
    set((state) => {
      const { projectId } = getProjectExportContext();
      if (source === state.sourceInput && projectId === state.sourceProjectId) return state;
      const sameProject = projectId === state.sourceProjectId;
      const previousClips = new Map(
        sameProject ? state.source?.clips.map((clip) => [clip.id, clip] as const) : [],
      );
      const retainedIds = new Set<string>();
      const nextSource = source
        ? {
            ...source,
            clips: source.clips.map((clip) => {
              const previous = previousClips.get(clip.id);
              if (!previous || previous.sourcePath !== clip.sourcePath) return clip;
              retainedIds.add(clip.id);
              return withClipRange(clip, previous);
            }),
          }
        : null;
      const rangeHistory = sameProject
        ? state.rangeHistory.filter((entry) => retainedIds.has(entry.clipId))
        : [];
      const rangeHistoryCursor = sameProject
        ? state.rangeHistory
            .slice(0, state.rangeHistoryCursor)
            .filter((entry) => retainedIds.has(entry.clipId)).length
        : 0;
      const reconciled = reconcileSettings(state.settings, state.settingsProjectId);
      return {
        source: nextSource,
        sourceInput: source,
        sourceProjectId: projectId,
        rangeHistory,
        rangeHistoryCursor,
        selectedClipIds: nextSource
          ? new Set(nextSource.clips.map((clip) => clip.id))
          : new Set<string>(),
        previewClipId: nextSource?.clips[0]?.id ?? null,
        previewVersion: state.previewVersion + 1,
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
  setPreviewClip: (previewClipId) =>
    set((state) => ({ previewClipId, previewVersion: state.previewVersion + 1 })),
  updateClipRange: (clipId, startUs, endUs, groupId) =>
    set((state) => {
      const clip = state.source?.clips.find((candidate) => candidate.id === clipId);
      if (!clip || (clip.startUs === startUs && clip.endUs === endUs)) return state;
      const before = { startUs: clip.startUs, endUs: clip.endUs };
      const after = { startUs, endUs };
      const history = state.rangeHistory.slice(0, state.rangeHistoryCursor);
      const last = history.at(-1);
      if (groupId && last?.groupId === groupId && last.clipId === clipId) {
        history[history.length - 1] = { ...last, after };
      } else {
        history.push({ clipId, before, after, groupId });
      }
      return {
        source: {
          ...state.source!,
          clips: state.source!.clips.map((candidate) =>
            candidate.id === clipId ? withClipRange(candidate, after) : candidate,
          ),
        },
        rangeHistory: history,
        rangeHistoryCursor: history.length,
      };
    }),
  undoClipRange: () =>
    set((state) => {
      if (!state.source || state.rangeHistoryCursor === 0) return state;
      const entry = state.rangeHistory[state.rangeHistoryCursor - 1];
      return {
        source: {
          ...state.source,
          clips: state.source.clips.map((clip) =>
            clip.id === entry.clipId ? withClipRange(clip, entry.before) : clip,
          ),
        },
        rangeHistoryCursor: state.rangeHistoryCursor - 1,
      };
    }),
  redoClipRange: () =>
    set((state) => {
      if (!state.source || state.rangeHistoryCursor >= state.rangeHistory.length) return state;
      const entry = state.rangeHistory[state.rangeHistoryCursor];
      return {
        source: {
          ...state.source,
          clips: state.source.clips.map((clip) =>
            clip.id === entry.clipId ? withClipRange(clip, entry.after) : clip,
          ),
        },
        rangeHistoryCursor: state.rangeHistoryCursor + 1,
      };
    }),
}));

export function useExportWorkspaceState<Selection>(
  selector: (state: ExportWorkspaceState) => Selection,
) {
  return useStore(exportWorkspaceStore, selector);
}
