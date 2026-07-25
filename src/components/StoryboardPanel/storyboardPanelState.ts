import { createPanelState } from "../../runtime/systems/PanelState";
import type { StoryboardShot } from "../../types";

export type StoryboardShotFilter = "all" | "rated" | "unrated" | "retained" | "custom";

export interface StoryboardShotAnnotation {
  rating: number;
  retained: boolean;
}

interface StoryboardPanelState {
  videoContext: string;
  query: string;
  showOnlySelected: boolean;
  shotFilter: StoryboardShotFilter;
  minimumRating: number;
  activeShotId: string | null;
  shots: StoryboardShot[];
  selectedShotIds: Set<string>;
  shotAnnotations: Record<string, StoryboardShotAnnotation>;
  detectingVideoContext: string | null;
  thumbnailSize: number;
  syncVideoContext: (videoContext: string) => void;
  setQuery: (query: string) => void;
  setShowOnlySelected: (value: boolean) => void;
  setShotFilter: (filter: StoryboardShotFilter) => void;
  setMinimumRating: (rating: number) => void;
  setThumbnailSize: (size: number) => void;
  setShotRating: (shotId: string, rating: number) => void;
  setShotRatings: (shotIds: Iterable<string>, rating: number) => void;
  toggleShotRetained: (shotId: string) => void;
  setShotsRetained: (shotIds: Iterable<string>, retained: boolean) => void;
  detectionStarted: (videoContext: string) => void;
  detectionCompleted: (videoContext: string, shots: StoryboardShot[]) => void;
  detectionFinished: (videoContext: string) => void;
  shotSelectionCleared: () => void;
  shotSelectionReplaced: (shotIds: string[], primaryShotId?: string | null) => void;
}

export const useStoryboardPanelState = createPanelState<StoryboardPanelState>(() => (set) => ({
  videoContext: "",
  query: "",
  showOnlySelected: false,
  shotFilter: "all",
  minimumRating: 0,
  activeShotId: null,
  shots: [],
  selectedShotIds: new Set<string>(),
  shotAnnotations: {},
  detectingVideoContext: null,
  thumbnailSize: 0,
  syncVideoContext: (videoContext) =>
    set((state) =>
      state.videoContext === videoContext
        ? state
        : {
            videoContext,
            query: "",
            showOnlySelected: false,
            shotFilter: "all",
            minimumRating: 0,
            activeShotId: null,
            shots: [],
            selectedShotIds: new Set<string>(),
            shotAnnotations: {},
            detectingVideoContext: null,
          },
    ),
  setQuery: (query) => set({ query }),
  setShowOnlySelected: (showOnlySelected) => set({ showOnlySelected }),
  setShotFilter: (shotFilter) => set({ shotFilter }),
  setMinimumRating: (minimumRating) =>
    set({
      minimumRating: Number.isFinite(minimumRating)
        ? Math.min(5, Math.max(0, Math.round(minimumRating)))
        : 0,
    }),
  setThumbnailSize: (thumbnailSize) =>
    set({
      thumbnailSize: Number.isFinite(thumbnailSize) ? Math.min(100, Math.max(0, thumbnailSize)) : 0,
    }),
  setShotRating: (shotId, rating) =>
    set((state) => {
      const normalizedRating = Number.isFinite(rating)
        ? Math.min(5, Math.max(0, Math.round(rating)))
        : 0;
      const current = state.shotAnnotations[shotId];
      return {
        shotAnnotations: {
          ...state.shotAnnotations,
          [shotId]: {
            rating: normalizedRating,
            retained: current?.retained ?? false,
          },
        },
      };
    }),
  setShotRatings: (shotIds, rating) =>
    set((state) => {
      const normalizedRating = Number.isFinite(rating)
        ? Math.min(5, Math.max(0, Math.round(rating)))
        : 0;
      const uniqueShotIds = Array.from(new Set(shotIds));
      if (uniqueShotIds.length === 0) {
        return state;
      }
      const shotAnnotations = { ...state.shotAnnotations };
      for (const shotId of uniqueShotIds) {
        const current = shotAnnotations[shotId];
        shotAnnotations[shotId] = {
          rating: normalizedRating,
          retained: current?.retained ?? false,
        };
      }
      return { shotAnnotations };
    }),
  toggleShotRetained: (shotId) =>
    set((state) => {
      const current = state.shotAnnotations[shotId];
      return {
        shotAnnotations: {
          ...state.shotAnnotations,
          [shotId]: {
            rating: current?.rating ?? 0,
            retained: !current?.retained,
          },
        },
      };
    }),
  setShotsRetained: (shotIds, retained) =>
    set((state) => {
      const uniqueShotIds = Array.from(new Set(shotIds));
      if (uniqueShotIds.length === 0) {
        return state;
      }
      const shotAnnotations = { ...state.shotAnnotations };
      for (const shotId of uniqueShotIds) {
        const current = shotAnnotations[shotId];
        shotAnnotations[shotId] = {
          rating: current?.rating ?? 0,
          retained,
        };
      }
      return { shotAnnotations };
    }),
  detectionStarted: (detectingVideoContext) => set({ detectingVideoContext }),
  detectionCompleted: (videoContext, shots) =>
    set((state) =>
      state.videoContext === videoContext
        ? {
            shots,
            selectedShotIds: new Set<string>(),
            activeShotId: null,
            showOnlySelected: false,
            detectingVideoContext: null,
          }
        : state,
    ),
  detectionFinished: (videoContext) =>
    set((state) =>
      state.detectingVideoContext === videoContext ? { detectingVideoContext: null } : state,
    ),
  shotSelectionCleared: () => set({ selectedShotIds: new Set<string>(), activeShotId: null }),
  shotSelectionReplaced: (shotIds, primaryShotId) =>
    set(() => {
      const selectedShotIds = new Set(shotIds);
      const activeShotId =
        primaryShotId && selectedShotIds.has(primaryShotId) ? primaryShotId : null;
      return { selectedShotIds, activeShotId };
    }),
}));
