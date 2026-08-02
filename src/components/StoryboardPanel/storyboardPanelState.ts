import { createPanelState } from "../../runtime/systems/PanelState";
import { useProjectPort } from "../../systems/ProjectSystem";
import type {
  StoryboardShot,
  StoryboardShotAnnotation,
  StoryboardShotColorLabel,
  StoryboardShotStackState,
  StoryboardState,
} from "../../types";

export type { StoryboardShotAnnotation, StoryboardShotColorLabel };

export interface StoryboardShotStack extends StoryboardShotStackState {
  expanded: boolean;
}

export type StoryboardRatingComparator = "gte" | "lte" | "eq";
export type StoryboardShotFlag = "retained" | "none" | "excluded";
export type StoryboardShotEditFilter = "edited" | "unedited";
export type StoryboardShotVisualLabel = StoryboardShotColorLabel | "custom";
export type StoryboardShotColorLabelFilter = StoryboardShotVisualLabel | "none";
export type StoryboardViewMode = "list" | "grid";
export type StoryboardIconMetadataMode =
  | "none"
  | "ratingAndColorLabel"
  | "index"
  | "title"
  | "mediaStart"
  | "mediaEnd"
  | "duration"
  | "rating"
  | "colorLabel";

interface StoryboardVideoSessionState {
  query: string;
  showOnlySelected: boolean;
  minimumRating: number;
  ratingComparator: StoryboardRatingComparator;
  flagFilters: StoryboardShotFlag[];
  editFilters: StoryboardShotEditFilter[];
  colorLabelFilters: StoryboardShotColorLabelFilter[];
  activeShotId: string | null;
  selectedShotIds: Set<string>;
  expandedStackIds: Set<string>;
}

interface StoryboardPanelUiState extends StoryboardVideoSessionState {
  videoContext: string;
  sessions: Record<string, StoryboardVideoSessionState>;
  detectingVideoContext: string | null;
  viewMode: StoryboardViewMode;
  iconMetadataMode: StoryboardIconMetadataMode;
  thumbnailSize: number;
  gridSize: number;
  syncVideoContext: (videoContext: string) => void;
  setQuery: (query: string) => void;
  setShowOnlySelected: (value: boolean) => void;
  setMinimumRating: (rating: number) => void;
  setRatingComparator: (comparator: StoryboardRatingComparator) => void;
  setFlagFilters: (flags: StoryboardShotFlag[]) => void;
  setEditFilters: (editFilters: StoryboardShotEditFilter[]) => void;
  setColorLabelFilters: (colorLabels: StoryboardShotColorLabelFilter[]) => void;
  setViewMode: (viewMode: StoryboardViewMode) => void;
  setIconMetadataMode: (mode: StoryboardIconMetadataMode) => void;
  setThumbnailSize: (size: number) => void;
  setGridSize: (size: number) => void;
  detectionStarted: (videoContext: string) => void;
  detectionFinished: (videoContext: string) => void;
  shotSelectionCleared: () => void;
  shotSelectionReplaced: (shotIds: string[], primaryShotId?: string | null) => void;
  setExpandedStackIds: (stackIds: Iterable<string>) => void;
}

interface StoryboardPanelState
  extends Omit<StoryboardPanelUiState, "sessions">, Omit<StoryboardState, "shotStacks"> {
  shotStacks: StoryboardShotStack[];
  setShotTitle: (shotId: string, title: string) => void;
  setShotCustomLabel: (shotId: string, customLabel: string) => void;
  setShotCustomLabels: (
    shotIds: Iterable<string>,
    customLabel: string,
    historyGroupId?: string,
  ) => void;
  setShotRating: (shotId: string, rating: number) => void;
  setShotRatings: (shotIds: Iterable<string>, rating: number, historyGroupId?: string) => void;
  adjustShotRatings: (shotIds: Iterable<string>, delta: number) => void;
  setShotFlags: (
    shotIds: Iterable<string>,
    flag: StoryboardShotFlag,
    historyGroupId?: string,
  ) => void;
  setShotColorLabels: (
    shotIds: Iterable<string>,
    colorLabel: StoryboardShotColorLabel | null,
    historyGroupId?: string,
  ) => void;
  createShotStack: (shotIds: string[]) => void;
  cancelShotStack: (shotId: string) => void;
  removeShotFromStack: (shotId: string) => void;
  splitShotStack: (shotId: string) => void;
  setShotStackExpanded: (shotId: string, expanded: boolean) => void;
  setAllShotStacksExpanded: (expanded: boolean) => void;
  detectionCompleted: (videoContext: string, shots: StoryboardShot[]) => void;
}

function defaultVideoSessionState(): StoryboardVideoSessionState {
  return {
    query: "",
    showOnlySelected: false,
    minimumRating: 0,
    ratingComparator: "gte",
    flagFilters: [],
    editFilters: [],
    colorLabelFilters: [],
    activeShotId: null,
    selectedShotIds: new Set<string>(),
    expandedStackIds: new Set<string>(),
  };
}

function videoSessionFromState(state: StoryboardPanelUiState): StoryboardVideoSessionState {
  return {
    query: state.query,
    showOnlySelected: state.showOnlySelected,
    minimumRating: state.minimumRating,
    ratingComparator: state.ratingComparator,
    flagFilters: state.flagFilters,
    editFilters: state.editFilters,
    colorLabelFilters: state.colorLabelFilters,
    activeShotId: state.activeShotId,
    selectedShotIds: state.selectedShotIds,
    expandedStackIds: state.expandedStackIds,
  };
}

function createStack(shotIds: string[]): StoryboardShotStackState | null {
  const uniqueShotIds = Array.from(new Set(shotIds));
  if (uniqueShotIds.length < 2) {
    return null;
  }
  return {
    id: uniqueShotIds[0],
    shotIds: uniqueShotIds,
  };
}

function splitIntoStacks(shotIdGroups: string[][]): StoryboardShotStackState[] {
  return shotIdGroups
    .map((shotIds) => createStack(shotIds))
    .filter((stack): stack is StoryboardShotStackState => stack !== null);
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

function normalizedRating(rating: number) {
  return Number.isFinite(rating) ? Math.min(5, Math.max(0, Math.round(rating))) : 0;
}

function annotationWithDefaults(
  current: StoryboardShotAnnotation | undefined,
  update: Partial<StoryboardShotAnnotation>,
): StoryboardShotAnnotation {
  return {
    ...current,
    rating: current?.rating ?? 0,
    retained: current?.retained ?? false,
    excluded: current?.excluded ?? false,
    ...update,
  };
}

const useStoryboardPanelUiState = createPanelState<StoryboardPanelUiState>(() => (set) => ({
  videoContext: "",
  sessions: {},
  ...defaultVideoSessionState(),
  detectingVideoContext: null,
  viewMode: "list",
  iconMetadataMode: "ratingAndColorLabel",
  thumbnailSize: 0,
  gridSize: 0,
  syncVideoContext: (videoContext) =>
    set((state) => {
      if (state.videoContext === videoContext) {
        return state;
      }
      const sessions = state.videoContext
        ? {
            ...state.sessions,
            [state.videoContext]: videoSessionFromState(state),
          }
        : state.sessions;
      return {
        videoContext,
        sessions,
        ...(sessions[videoContext] ?? defaultVideoSessionState()),
      };
    }),
  setQuery: (query) => set({ query }),
  setShowOnlySelected: (showOnlySelected) => set({ showOnlySelected }),
  setMinimumRating: (minimumRating) => set({ minimumRating: normalizedRating(minimumRating) }),
  setRatingComparator: (ratingComparator) => set({ ratingComparator }),
  setFlagFilters: (flagFilters) => set({ flagFilters: Array.from(new Set(flagFilters)) }),
  setEditFilters: (editFilters) => set({ editFilters: Array.from(new Set(editFilters)) }),
  setColorLabelFilters: (colorLabelFilters) =>
    set({ colorLabelFilters: Array.from(new Set(colorLabelFilters)) }),
  setViewMode: (viewMode) => set({ viewMode }),
  setIconMetadataMode: (iconMetadataMode) => set({ iconMetadataMode }),
  setThumbnailSize: (thumbnailSize) =>
    set({
      thumbnailSize: Number.isFinite(thumbnailSize) ? Math.min(100, Math.max(0, thumbnailSize)) : 0,
    }),
  setGridSize: (gridSize) =>
    set({
      gridSize: Number.isFinite(gridSize) ? Math.min(100, Math.max(0, gridSize)) : 0,
    }),
  detectionStarted: (detectingVideoContext) => set({ detectingVideoContext }),
  detectionFinished: (videoContext) =>
    set((state) =>
      state.detectingVideoContext === videoContext ? { detectingVideoContext: null } : state,
    ),
  shotSelectionCleared: () => set({ selectedShotIds: new Set<string>(), activeShotId: null }),
  shotSelectionReplaced: (shotIds, primaryShotId) =>
    set(() => {
      const selectedShotIds = new Set(shotIds);
      const activeShotId =
        primaryShotId && selectedShotIds.has(primaryShotId)
          ? primaryShotId
          : (selectedShotIds.values().next().value ?? null);
      return { selectedShotIds, activeShotId };
    }),
  setExpandedStackIds: (stackIds) => set({ expandedStackIds: new Set(stackIds) }),
}));

export function useStoryboardPanelState<Selection>(
  selector: (state: StoryboardPanelState) => Selection,
) {
  const uiState = useStoryboardPanelUiState((state) => state);
  const { storyboards, storyboardUpdated } = useProjectPort(["storyboards"], ["storyboardUpdated"]);
  const storyboard = storyboards[uiState.videoContext] ?? {
    shots: [],
    shotStacks: [],
    shotAnnotations: {},
  };
  const shotStacks = storyboard.shotStacks.map((stack) => ({
    ...stack,
    expanded: uiState.expandedStackIds.has(stack.id),
  }));
  const commitStoryboard = (
    historyLabel: string,
    recipe: (current: StoryboardState) => StoryboardState,
    videoContext = uiState.videoContext,
    historyGroupId?: string,
  ) => storyboardUpdated(videoContext, historyLabel, recipe, historyGroupId);

  const setShotRatings = (shotIds: Iterable<string>, rating: number, historyGroupId?: string) => {
    const normalized = normalizedRating(rating);
    const uniqueShotIds = Array.from(new Set(shotIds));
    if (uniqueShotIds.length === 0) {
      return;
    }
    commitStoryboard(
      "设置分镜星级",
      (current) => {
        const shotAnnotations = { ...current.shotAnnotations };
        let changed = false;
        for (const shotId of uniqueShotIds) {
          if ((shotAnnotations[shotId]?.rating ?? 0) === normalized) {
            continue;
          }
          shotAnnotations[shotId] = annotationWithDefaults(shotAnnotations[shotId], {
            rating: normalized,
          });
          changed = true;
        }
        return changed ? { ...current, shotAnnotations } : current;
      },
      uiState.videoContext,
      historyGroupId,
    );
  };

  const setShotCustomLabels = (
    shotIds: Iterable<string>,
    customLabel: string,
    historyGroupId?: string,
  ) => {
    const uniqueShotIds = Array.from(new Set(shotIds));
    const normalized = customLabel.trim();
    if (uniqueShotIds.length === 0) {
      return;
    }
    commitStoryboard(
      "设置分镜标签",
      (current) => {
        const shotAnnotations = { ...current.shotAnnotations };
        let changed = false;
        for (const shotId of uniqueShotIds) {
          const previous = shotAnnotations[shotId];
          if ((previous?.customLabel ?? "") === normalized && previous?.colorLabel == null) {
            continue;
          }
          shotAnnotations[shotId] = annotationWithDefaults(previous, {
            customLabel: normalized || undefined,
            colorLabel: undefined,
          });
          changed = true;
        }
        return changed ? { ...current, shotAnnotations } : current;
      },
      uiState.videoContext,
      historyGroupId,
    );
  };

  const state: StoryboardPanelState = {
    ...uiState,
    ...storyboard,
    shotStacks,
    setShotTitle: (shotId, title) =>
      commitStoryboard("重命名分镜", (current) => {
        const previous = current.shotAnnotations[shotId];
        if ((previous?.title ?? "") === title) {
          return current;
        }
        return {
          ...current,
          shotAnnotations: {
            ...current.shotAnnotations,
            [shotId]: annotationWithDefaults(previous, { title }),
          },
        };
      }),
    setShotCustomLabel: (shotId, customLabel) => setShotCustomLabels([shotId], customLabel),
    setShotCustomLabels,
    setShotRating: (shotId, rating) => setShotRatings([shotId], rating),
    setShotRatings,
    adjustShotRatings: (shotIds, delta) => {
      const normalizedDelta = Number.isFinite(delta) ? Math.round(delta) : 0;
      const uniqueShotIds = Array.from(new Set(shotIds));
      if (normalizedDelta === 0 || uniqueShotIds.length === 0) {
        return;
      }
      commitStoryboard("调整分镜星级", (current) => {
        const shotAnnotations = { ...current.shotAnnotations };
        let changed = false;
        for (const shotId of uniqueShotIds) {
          const previous = shotAnnotations[shotId];
          const rating = Math.min(5, Math.max(0, (previous?.rating ?? 0) + normalizedDelta));
          if (rating === (previous?.rating ?? 0)) {
            continue;
          }
          shotAnnotations[shotId] = annotationWithDefaults(previous, {
            rating,
          });
          changed = true;
        }
        return changed ? { ...current, shotAnnotations } : current;
      });
    },
    setShotFlags: (shotIds, flag, historyGroupId) => {
      const uniqueShotIds = Array.from(new Set(shotIds));
      if (uniqueShotIds.length === 0) {
        return;
      }
      commitStoryboard(
        "设置分镜旗标",
        (current) => {
          const shotAnnotations = { ...current.shotAnnotations };
          let changed = false;
          for (const shotId of uniqueShotIds) {
            const previous = shotAnnotations[shotId];
            const previousFlag = previous?.retained
              ? "retained"
              : previous?.excluded
                ? "excluded"
                : "none";
            if (previousFlag === flag) {
              continue;
            }
            shotAnnotations[shotId] = annotationWithDefaults(shotAnnotations[shotId], {
              retained: flag === "retained",
              excluded: flag === "excluded",
            });
            changed = true;
          }
          return changed ? { ...current, shotAnnotations } : current;
        },
        uiState.videoContext,
        historyGroupId,
      );
    },
    setShotColorLabels: (shotIds, colorLabel, historyGroupId) => {
      const uniqueShotIds = Array.from(new Set(shotIds));
      if (uniqueShotIds.length === 0) {
        return;
      }
      commitStoryboard(
        "设置分镜色标",
        (current) => {
          const shotAnnotations = { ...current.shotAnnotations };
          let changed = false;
          for (const shotId of uniqueShotIds) {
            const previous = shotAnnotations[shotId];
            if (
              (previous?.colorLabel ?? null) === colorLabel &&
              !(previous?.customLabel?.trim() ?? "")
            ) {
              continue;
            }
            shotAnnotations[shotId] = annotationWithDefaults(previous, {
              colorLabel: colorLabel ?? undefined,
              customLabel: undefined,
            });
            changed = true;
          }
          return changed ? { ...current, shotAnnotations } : current;
        },
        uiState.videoContext,
        historyGroupId,
      );
    },
    createShotStack: (shotIds) => {
      const flattenedShotIds = new Set(shotIds);
      for (const currentStack of storyboard.shotStacks) {
        if (currentStack.shotIds.some((shotId) => flattenedShotIds.has(shotId))) {
          for (const shotId of currentStack.shotIds) {
            flattenedShotIds.add(shotId);
          }
        }
      }
      const orderedShotIds = storyboard.shots
        .filter((shot) => flattenedShotIds.has(shot.id))
        .map((shot) => shot.id);
      const nextStack = createStack(orderedShotIds);
      if (!nextStack) {
        return;
      }
      const replacedStackIds = new Set(
        storyboard.shotStacks
          .filter((stack) => stack.shotIds.some((shotId) => flattenedShotIds.has(shotId)))
          .map((stack) => stack.id),
      );
      commitStoryboard("组成分镜堆叠", (current) => {
        const nextIds = new Set(shotIds);
        const replacedStackIds = new Set<string>();
        for (const currentStack of current.shotStacks) {
          if (currentStack.shotIds.some((shotId) => nextIds.has(shotId))) {
            replacedStackIds.add(currentStack.id);
            for (const shotId of currentStack.shotIds) {
              nextIds.add(shotId);
            }
          }
        }
        const stack = createStack(
          current.shots.filter((shot) => nextIds.has(shot.id)).map((shot) => shot.id),
        );
        if (!stack) {
          return current;
        }
        return {
          ...current,
          shotStacks: [
            ...current.shotStacks.filter((candidate) => !replacedStackIds.has(candidate.id)),
            stack,
          ],
        };
      });
      const expandedStackIds = new Set(uiState.expandedStackIds);
      for (const stackId of replacedStackIds) {
        expandedStackIds.delete(stackId);
      }
      expandedStackIds.delete(nextStack.id);
      uiState.setExpandedStackIds(expandedStackIds);
      uiState.shotSelectionReplaced([nextStack.shotIds[0]], nextStack.shotIds[0]);
    },
    cancelShotStack: (shotId) => {
      const targetStack = shotStacks.find((stack) => stack.shotIds.includes(shotId));
      commitStoryboard("取消分镜堆叠", (current) => {
        const shotStacks = current.shotStacks.filter((stack) => !stack.shotIds.includes(shotId));
        return shotStacks.length === current.shotStacks.length
          ? current
          : { ...current, shotStacks };
      });
      if (targetStack) {
        const expandedStackIds = new Set(uiState.expandedStackIds);
        expandedStackIds.delete(targetStack.id);
        uiState.setExpandedStackIds(expandedStackIds);
      }
    },
    removeShotFromStack: (shotId) => {
      const visibleTargetStack = shotStacks.find((stack) => stack.shotIds.includes(shotId));
      if (!visibleTargetStack) {
        return;
      }
      const visibleTargetIndex = visibleTargetStack.shotIds.indexOf(shotId);
      const visibleReplacementStacks = splitIntoStacks([
        visibleTargetStack.shotIds.slice(0, visibleTargetIndex),
        visibleTargetStack.shotIds.slice(visibleTargetIndex + 1),
      ]);
      commitStoryboard("从分镜堆叠中移去", (current) => {
        const targetStack = current.shotStacks.find((stack) => stack.shotIds.includes(shotId));
        if (!targetStack) {
          return current;
        }
        const targetIndex = targetStack.shotIds.indexOf(shotId);
        const replacementStacks = splitIntoStacks([
          targetStack.shotIds.slice(0, targetIndex),
          targetStack.shotIds.slice(targetIndex + 1),
        ]);
        return {
          ...current,
          shotStacks: current.shotStacks.flatMap((stack) =>
            stack.id === targetStack.id ? replacementStacks : [stack],
          ),
        };
      });
      const expandedStackIds = new Set(uiState.expandedStackIds);
      expandedStackIds.delete(visibleTargetStack.id);
      if (visibleTargetStack.expanded) {
        for (const stack of visibleReplacementStacks) {
          expandedStackIds.add(stack.id);
        }
      }
      uiState.setExpandedStackIds(expandedStackIds);
    },
    splitShotStack: (shotId) => {
      const visibleTargetStack = shotStacks.find((stack) => stack.shotIds.includes(shotId));
      if (!visibleTargetStack) {
        return;
      }
      const visibleTargetIndex = visibleTargetStack.shotIds.indexOf(shotId);
      if (visibleTargetIndex <= 0) {
        return;
      }
      const visibleReplacementStacks = splitIntoStacks([
        visibleTargetStack.shotIds.slice(0, visibleTargetIndex),
        visibleTargetStack.shotIds.slice(visibleTargetIndex),
      ]);
      commitStoryboard("拆分分镜堆叠", (current) => {
        const targetStack = current.shotStacks.find((stack) => stack.shotIds.includes(shotId));
        if (!targetStack) {
          return current;
        }
        const targetIndex = targetStack.shotIds.indexOf(shotId);
        if (targetIndex <= 0) {
          return current;
        }
        const replacementStacks = splitIntoStacks([
          targetStack.shotIds.slice(0, targetIndex),
          targetStack.shotIds.slice(targetIndex),
        ]);
        return {
          ...current,
          shotStacks: current.shotStacks.flatMap((stack) =>
            stack.id === targetStack.id ? replacementStacks : [stack],
          ),
        };
      });
      const expandedStackIds = new Set(uiState.expandedStackIds);
      expandedStackIds.delete(visibleTargetStack.id);
      if (visibleTargetStack.expanded) {
        for (const stack of visibleReplacementStacks) {
          expandedStackIds.add(stack.id);
        }
      }
      uiState.setExpandedStackIds(expandedStackIds);
    },
    setShotStackExpanded: (shotId, expanded) => {
      const targetStack = shotStacks.find((stack) => stack.shotIds.includes(shotId));
      if (!targetStack || targetStack.expanded === expanded) {
        return;
      }
      const nextShotStacks = shotStacks.map((stack) =>
        stack.id === targetStack.id ? { ...stack, expanded } : stack,
      );
      const expandedStackIds = new Set(uiState.expandedStackIds);
      if (expanded) {
        expandedStackIds.add(targetStack.id);
      } else {
        expandedStackIds.delete(targetStack.id);
      }
      uiState.setExpandedStackIds(expandedStackIds);
      const selectedShotIds = selectionForVisibleStacks(uiState.selectedShotIds, nextShotStacks);
      const visibleActiveShotId = shotIdForVisibleStacks(uiState.activeShotId, nextShotStacks);
      const activeShotId =
        visibleActiveShotId && selectedShotIds.has(visibleActiveShotId)
          ? visibleActiveShotId
          : selectedShotIds.has(targetStack.shotIds[0])
            ? targetStack.shotIds[0]
            : null;
      uiState.shotSelectionReplaced([...selectedShotIds], activeShotId);
    },
    setAllShotStacksExpanded: (expanded) => {
      if (shotStacks.every((stack) => stack.expanded === expanded)) {
        return;
      }
      const nextShotStacks = shotStacks.map((stack) => ({ ...stack, expanded }));
      uiState.setExpandedStackIds(expanded ? shotStacks.map((stack) => stack.id) : []);
      const selectedShotIds = selectionForVisibleStacks(uiState.selectedShotIds, nextShotStacks);
      const visibleActiveShotId = shotIdForVisibleStacks(uiState.activeShotId, nextShotStacks);
      uiState.shotSelectionReplaced(
        [...selectedShotIds],
        visibleActiveShotId && selectedShotIds.has(visibleActiveShotId)
          ? visibleActiveShotId
          : null,
      );
    },
    detectionCompleted: (videoContext, shots) => {
      commitStoryboard(
        "生成分镜",
        (current) => ({
          ...current,
          shots,
          shotStacks: [],
        }),
        videoContext,
      );
      if (uiState.videoContext === videoContext) {
        const firstShotId = shots[0]?.id;
        if (firstShotId) {
          uiState.shotSelectionReplaced([firstShotId], firstShotId);
        } else {
          uiState.shotSelectionCleared();
        }
        uiState.setShowOnlySelected(false);
        uiState.setExpandedStackIds([]);
      }
      uiState.detectionFinished(videoContext);
    },
  };

  return selector(state);
}
