import { createPanelState } from "../../runtime/systems/PanelState";
import type { StoryboardShot } from "../../types";

export type StoryboardShotFilter = "all" | "rated" | "unrated" | "retained" | "custom";
export type StoryboardRatingComparator = "gte" | "lte" | "eq";
export type StoryboardShotFlag = "retained" | "none" | "excluded";
export type StoryboardShotColorLabel = "red" | "yellow" | "green" | "blue" | "purple";

export interface StoryboardShotAnnotation {
  rating: number;
  retained: boolean;
  excluded?: boolean;
  title?: string;
  colorLabel?: StoryboardShotColorLabel;
}

export interface StoryboardShotStack {
  id: string;
  shotIds: string[];
  expanded: boolean;
}

interface StoryboardPanelState {
  videoContext: string;
  query: string;
  showOnlySelected: boolean;
  shotFilter: StoryboardShotFilter;
  minimumRating: number;
  ratingComparator: StoryboardRatingComparator;
  flagFilters: StoryboardShotFlag[];
  activeShotId: string | null;
  shots: StoryboardShot[];
  shotStacks: StoryboardShotStack[];
  selectedShotIds: Set<string>;
  shotAnnotations: Record<string, StoryboardShotAnnotation>;
  detectingVideoContext: string | null;
  thumbnailSize: number;
  syncVideoContext: (videoContext: string) => void;
  setQuery: (query: string) => void;
  setShowOnlySelected: (value: boolean) => void;
  setShotFilter: (filter: StoryboardShotFilter) => void;
  setMinimumRating: (rating: number) => void;
  setRatingComparator: (comparator: StoryboardRatingComparator) => void;
  setFlagFilters: (flags: StoryboardShotFlag[]) => void;
  setThumbnailSize: (size: number) => void;
  setShotTitle: (shotId: string, title: string) => void;
  setShotRating: (shotId: string, rating: number) => void;
  setShotRatings: (shotIds: Iterable<string>, rating: number) => void;
  adjustShotRatings: (shotIds: Iterable<string>, delta: number) => void;
  setShotFlags: (shotIds: Iterable<string>, flag: StoryboardShotFlag) => void;
  setShotColorLabels: (
    shotIds: Iterable<string>,
    colorLabel: StoryboardShotColorLabel | null,
  ) => void;
  createShotStack: (shotIds: string[]) => void;
  cancelShotStack: (shotId: string) => void;
  removeShotFromStack: (shotId: string) => void;
  splitShotStack: (shotId: string) => void;
  setShotStackExpanded: (shotId: string, expanded: boolean) => void;
  setAllShotStacksExpanded: (expanded: boolean) => void;
  detectionStarted: (videoContext: string) => void;
  detectionCompleted: (videoContext: string, shots: StoryboardShot[]) => void;
  detectionFinished: (videoContext: string) => void;
  shotSelectionCleared: () => void;
  shotSelectionReplaced: (shotIds: string[], primaryShotId?: string | null) => void;
}

function createStack(shotIds: string[], expanded = false): StoryboardShotStack | null {
  const uniqueShotIds = Array.from(new Set(shotIds));
  if (uniqueShotIds.length < 2) {
    return null;
  }
  return {
    id: uniqueShotIds[0],
    shotIds: uniqueShotIds,
    expanded,
  };
}

function splitIntoStacks(shotIdGroups: string[][], expanded: boolean): StoryboardShotStack[] {
  return shotIdGroups
    .map((shotIds) => createStack(shotIds, expanded))
    .filter((stack): stack is StoryboardShotStack => stack !== null);
}

function selectionForVisibleStacks(
  selectedShotIds: Set<string>,
  shotStacks: StoryboardShotStack[],
) {
  const collapsedRepresentatives = new Map<string, string>();
  for (const stack of shotStacks) {
    if (stack.expanded) {
      continue;
    }
    for (const shotId of stack.shotIds) {
      collapsedRepresentatives.set(shotId, stack.shotIds[0]);
    }
  }
  return new Set(
    Array.from(selectedShotIds, (shotId) => collapsedRepresentatives.get(shotId) ?? shotId),
  );
}

function shotIdForVisibleStacks(shotId: string | null, shotStacks: StoryboardShotStack[]) {
  if (!shotId) {
    return null;
  }
  const collapsedStack = shotStacks.find(
    (stack) => !stack.expanded && stack.shotIds.includes(shotId),
  );
  return collapsedStack?.shotIds[0] ?? shotId;
}

export const useStoryboardPanelState = createPanelState<StoryboardPanelState>(() => (set) => ({
  videoContext: "",
  query: "",
  showOnlySelected: false,
  shotFilter: "all",
  minimumRating: 0,
  ratingComparator: "gte",
  flagFilters: ["retained"],
  activeShotId: null,
  shots: [],
  shotStacks: [],
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
            ratingComparator: "gte",
            flagFilters: ["retained"],
            activeShotId: null,
            shots: [],
            shotStacks: [],
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
  setRatingComparator: (ratingComparator) => set({ ratingComparator }),
  setFlagFilters: (flagFilters) => set({ flagFilters: Array.from(new Set(flagFilters)) }),
  setThumbnailSize: (thumbnailSize) =>
    set({
      thumbnailSize: Number.isFinite(thumbnailSize) ? Math.min(100, Math.max(0, thumbnailSize)) : 0,
    }),
  setShotTitle: (shotId, title) =>
    set((state) => {
      const current = state.shotAnnotations[shotId];
      return {
        shotAnnotations: {
          ...state.shotAnnotations,
          [shotId]: {
            ...current,
            rating: current?.rating ?? 0,
            retained: current?.retained ?? false,
            excluded: current?.excluded ?? false,
            title,
          },
        },
      };
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
            ...current,
            rating: normalizedRating,
            retained: current?.retained ?? false,
            excluded: current?.excluded ?? false,
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
          ...current,
          rating: normalizedRating,
          retained: current?.retained ?? false,
          excluded: current?.excluded ?? false,
        };
      }
      return { shotAnnotations };
    }),
  adjustShotRatings: (shotIds, delta) =>
    set((state) => {
      const normalizedDelta = Number.isFinite(delta) ? Math.round(delta) : 0;
      const uniqueShotIds = Array.from(new Set(shotIds));
      if (normalizedDelta === 0 || uniqueShotIds.length === 0) {
        return state;
      }
      const shotAnnotations = { ...state.shotAnnotations };
      for (const shotId of uniqueShotIds) {
        const current = shotAnnotations[shotId];
        shotAnnotations[shotId] = {
          ...current,
          rating: Math.min(5, Math.max(0, (current?.rating ?? 0) + normalizedDelta)),
          retained: current?.retained ?? false,
          excluded: current?.excluded ?? false,
        };
      }
      return { shotAnnotations };
    }),
  setShotFlags: (shotIds, flag) =>
    set((state) => {
      const uniqueShotIds = Array.from(new Set(shotIds));
      if (uniqueShotIds.length === 0) {
        return state;
      }
      const shotAnnotations = { ...state.shotAnnotations };
      for (const shotId of uniqueShotIds) {
        const current = shotAnnotations[shotId];
        shotAnnotations[shotId] = {
          ...current,
          rating: current?.rating ?? 0,
          retained: flag === "retained",
          excluded: flag === "excluded",
        };
      }
      return { shotAnnotations };
    }),
  setShotColorLabels: (shotIds, colorLabel) =>
    set((state) => {
      const uniqueShotIds = Array.from(new Set(shotIds));
      if (uniqueShotIds.length === 0) {
        return state;
      }
      const shotAnnotations = { ...state.shotAnnotations };
      for (const shotId of uniqueShotIds) {
        const current = shotAnnotations[shotId];
        shotAnnotations[shotId] = {
          ...current,
          rating: current?.rating ?? 0,
          retained: current?.retained ?? false,
          excluded: current?.excluded ?? false,
          colorLabel: colorLabel ?? undefined,
        };
      }
      return { shotAnnotations };
    }),
  createShotStack: (shotIds) =>
    set((state) => {
      const flattenedShotIds = new Set(shotIds);
      const replacedStackIds = new Set<string>();
      for (const currentStack of state.shotStacks) {
        if (currentStack.shotIds.some((shotId) => flattenedShotIds.has(shotId))) {
          replacedStackIds.add(currentStack.id);
          for (const shotId of currentStack.shotIds) {
            flattenedShotIds.add(shotId);
          }
        }
      }
      const orderedShotIds = state.shots
        .filter((shot) => flattenedShotIds.has(shot.id))
        .map((shot) => shot.id);
      const stack = createStack(orderedShotIds);
      if (!stack) {
        return state;
      }
      const representativeShotId = stack.shotIds[0];
      return {
        shotStacks: [
          ...state.shotStacks.filter((current) => !replacedStackIds.has(current.id)),
          stack,
        ],
        selectedShotIds: new Set([representativeShotId]),
        activeShotId: representativeShotId,
      };
    }),
  cancelShotStack: (shotId) =>
    set((state) => {
      const nextStacks = state.shotStacks.filter((stack) => !stack.shotIds.includes(shotId));
      return nextStacks.length === state.shotStacks.length ? state : { shotStacks: nextStacks };
    }),
  removeShotFromStack: (shotId) =>
    set((state) => {
      const targetStack = state.shotStacks.find((stack) => stack.shotIds.includes(shotId));
      if (!targetStack) {
        return state;
      }
      const targetIndex = targetStack.shotIds.indexOf(shotId);
      const replacementStacks = splitIntoStacks(
        [targetStack.shotIds.slice(0, targetIndex), targetStack.shotIds.slice(targetIndex + 1)],
        targetStack.expanded,
      );
      return {
        shotStacks: state.shotStacks.flatMap((stack) =>
          stack.id === targetStack.id ? replacementStacks : [stack],
        ),
      };
    }),
  splitShotStack: (shotId) =>
    set((state) => {
      const targetStack = state.shotStacks.find((stack) => stack.shotIds.includes(shotId));
      if (!targetStack) {
        return state;
      }
      const targetIndex = targetStack.shotIds.indexOf(shotId);
      if (targetIndex <= 0) {
        return state;
      }
      const replacementStacks = splitIntoStacks(
        [targetStack.shotIds.slice(0, targetIndex), targetStack.shotIds.slice(targetIndex)],
        targetStack.expanded,
      );
      return {
        shotStacks: state.shotStacks.flatMap((stack) =>
          stack.id === targetStack.id ? replacementStacks : [stack],
        ),
      };
    }),
  setShotStackExpanded: (shotId, expanded) =>
    set((state) => {
      const targetStack = state.shotStacks.find((stack) => stack.shotIds.includes(shotId));
      if (!targetStack || targetStack.expanded === expanded) {
        return state;
      }
      const shotStacks = state.shotStacks.map((stack) =>
        stack.id === targetStack.id ? { ...stack, expanded } : stack,
      );
      const selectedShotIds = selectionForVisibleStacks(state.selectedShotIds, shotStacks);
      const visibleActiveShotId = shotIdForVisibleStacks(state.activeShotId, shotStacks);
      const activeShotId =
        visibleActiveShotId && selectedShotIds.has(visibleActiveShotId)
          ? visibleActiveShotId
          : selectedShotIds.has(targetStack.shotIds[0])
            ? targetStack.shotIds[0]
            : null;
      return { shotStacks, selectedShotIds, activeShotId };
    }),
  setAllShotStacksExpanded: (expanded) =>
    set((state) => {
      if (state.shotStacks.every((stack) => stack.expanded === expanded)) {
        return state;
      }
      const shotStacks = state.shotStacks.map((stack) => ({ ...stack, expanded }));
      const selectedShotIds = selectionForVisibleStacks(state.selectedShotIds, shotStacks);
      const visibleActiveShotId = shotIdForVisibleStacks(state.activeShotId, shotStacks);
      const activeShotId =
        visibleActiveShotId && selectedShotIds.has(visibleActiveShotId)
          ? visibleActiveShotId
          : null;
      return { shotStacks, selectedShotIds, activeShotId };
    }),
  detectionStarted: (detectingVideoContext) => set({ detectingVideoContext }),
  detectionCompleted: (videoContext, shots) =>
    set((state) =>
      state.videoContext === videoContext
        ? {
            shots,
            shotStacks: [],
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
