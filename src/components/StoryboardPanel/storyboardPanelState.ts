import { createPanelState } from "../../runtime/systems/PanelState";
import type { StoryboardShot } from "../../types";

export const MIN_STORYBOARD_DISPLAY_THRESHOLD = 0.1;
export const MAX_STORYBOARD_DISPLAY_THRESHOLD = 1;

interface StoryboardPanelState {
  videoContext: string;
  query: string;
  threshold: number;
  showOnlySelected: boolean;
  activeShotId: string | null;
  shots: StoryboardShot[];
  selectedShotIds: Set<string>;
  detectingVideoContext: string | null;
  syncVideoContext: (videoContext: string) => void;
  setQuery: (query: string) => void;
  setThreshold: (threshold: number) => void;
  setShowOnlySelected: (value: boolean) => void;
  setActiveShotId: (shotId: string) => void;
  detectionStarted: (videoContext: string) => void;
  detectionCompleted: (videoContext: string, shots: StoryboardShot[]) => void;
  detectionFinished: (videoContext: string) => void;
  shotSelectionToggled: (shotId: string) => void;
  shotSelectionCleared: () => void;
  shotSelectionReplaced: (shotIds: string[]) => void;
}

export const useStoryboardPanelState = createPanelState<StoryboardPanelState>(() => (set) => ({
  videoContext: "",
  query: "",
  threshold: MIN_STORYBOARD_DISPLAY_THRESHOLD,
  showOnlySelected: false,
  activeShotId: null,
  shots: [],
  selectedShotIds: new Set<string>(),
  detectingVideoContext: null,
  syncVideoContext: (videoContext) =>
    set((state) =>
      state.videoContext === videoContext
        ? state
        : {
            videoContext,
            query: "",
            showOnlySelected: false,
            activeShotId: null,
            shots: [],
            selectedShotIds: new Set<string>(),
            detectingVideoContext: null,
          },
    ),
  setQuery: (query) => set({ query }),
  setThreshold: (threshold) => {
    const normalized = Number.isFinite(threshold)
      ? Math.min(
          Math.max(threshold, MIN_STORYBOARD_DISPLAY_THRESHOLD),
          MAX_STORYBOARD_DISPLAY_THRESHOLD,
        )
      : MIN_STORYBOARD_DISPLAY_THRESHOLD;
    set({ threshold: Math.round(normalized * 100) / 100 });
  },
  setShowOnlySelected: (showOnlySelected) => set({ showOnlySelected }),
  setActiveShotId: (activeShotId) => set({ activeShotId }),
  detectionStarted: (detectingVideoContext) => set({ detectingVideoContext }),
  detectionCompleted: (videoContext, shots) =>
    set((state) =>
      state.videoContext === videoContext
        ? {
            shots,
            selectedShotIds: new Set<string>(),
            activeShotId: shots[0]?.id ?? null,
            showOnlySelected: false,
            detectingVideoContext: null,
          }
        : state,
    ),
  detectionFinished: (videoContext) =>
    set((state) =>
      state.detectingVideoContext === videoContext ? { detectingVideoContext: null } : state,
    ),
  shotSelectionToggled: (shotId) =>
    set((state) => {
      const selectedShotIds = new Set(state.selectedShotIds);
      if (selectedShotIds.has(shotId)) {
        selectedShotIds.delete(shotId);
      } else {
        selectedShotIds.add(shotId);
      }
      return { selectedShotIds };
    }),
  shotSelectionCleared: () => set({ selectedShotIds: new Set<string>() }),
  shotSelectionReplaced: (shotIds) => set({ selectedShotIds: new Set(shotIds) }),
}));
