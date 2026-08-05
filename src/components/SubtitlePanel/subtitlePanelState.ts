import { createPanelState } from "../../runtime/systems/PanelState";
import { useProjectPort } from "../../systems/ProjectSystem";
import type { SubtitleCueAnnotation, SubtitleCueColorLabel, SubtitleState } from "../../types";

export type { SubtitleCueAnnotation, SubtitleCueColorLabel };

export type SubtitleCueFlag = "retained" | "none" | "excluded";
export type SubtitleCueEditFilter = "edited" | "unedited";
export type SubtitleCueVisualLabel = SubtitleCueColorLabel | "custom";
export type SubtitleCueColorLabelFilter = SubtitleCueVisualLabel | "none";
export type SubtitleRatingComparator = "gte" | "lte" | "eq";

interface SubtitleTrackSessionState {
  query: string;
  showOnlySelected: boolean;
  minimumRating: number;
  ratingComparator: SubtitleRatingComparator;
  flagFilters: SubtitleCueFlag[];
  editFilters: SubtitleCueEditFilter[];
  colorLabelFilters: SubtitleCueColorLabelFilter[];
  activeCueId: string | null;
  selectedCueIds: Set<string>;
}

interface SubtitlePanelUiState extends SubtitleTrackSessionState {
  trackContext: string;
  sessions: Record<string, SubtitleTrackSessionState>;
  thumbnailSize: number;
  syncTrackContext: (trackContext: string) => void;
  setQuery: (query: string) => void;
  setShowOnlySelected: (value: boolean) => void;
  setMinimumRating: (rating: number) => void;
  setRatingComparator: (comparator: SubtitleRatingComparator) => void;
  setFlagFilters: (flags: SubtitleCueFlag[]) => void;
  setEditFilters: (filters: SubtitleCueEditFilter[]) => void;
  setColorLabelFilters: (labels: SubtitleCueColorLabelFilter[]) => void;
  setThumbnailSize: (size: number) => void;
  setActiveCueId: (cueId: string | null) => void;
  cueSelectionCleared: () => void;
  cueSelectionReplaced: (cueIds: Iterable<string>, primaryCueId?: string | null) => void;
}

interface SubtitlePanelState extends SubtitlePanelUiState, SubtitleState {
  setCueCustomLabel: (cueId: string, customLabel: string) => void;
  setCueCustomLabels: (
    cueIds: Iterable<string>,
    customLabel: string,
    historyGroupId?: string,
  ) => void;
  setCueRatings: (cueIds: Iterable<string>, rating: number, historyGroupId?: string) => void;
  adjustCueRatings: (cueIds: Iterable<string>, delta: number) => void;
  setCueFlags: (cueIds: Iterable<string>, flag: SubtitleCueFlag, historyGroupId?: string) => void;
  setCueColorLabels: (
    cueIds: Iterable<string>,
    colorLabel: SubtitleCueColorLabel | null,
    historyGroupId?: string,
  ) => void;
}

function defaultTrackSessionState(): SubtitleTrackSessionState {
  return {
    query: "",
    showOnlySelected: false,
    minimumRating: 0,
    ratingComparator: "gte",
    flagFilters: [],
    editFilters: [],
    colorLabelFilters: [],
    activeCueId: null,
    selectedCueIds: new Set<string>(),
  };
}

function trackSessionFromState(state: SubtitlePanelUiState): SubtitleTrackSessionState {
  return {
    query: state.query,
    showOnlySelected: state.showOnlySelected,
    minimumRating: state.minimumRating,
    ratingComparator: state.ratingComparator,
    flagFilters: state.flagFilters,
    editFilters: state.editFilters,
    colorLabelFilters: state.colorLabelFilters,
    activeCueId: state.activeCueId,
    selectedCueIds: state.selectedCueIds,
  };
}

function normalizedRating(rating: number) {
  return Number.isFinite(rating) ? Math.min(5, Math.max(0, Math.round(rating))) : 0;
}

function annotationWithDefaults(
  current: SubtitleCueAnnotation | undefined,
  update: Partial<SubtitleCueAnnotation>,
): SubtitleCueAnnotation {
  return {
    ...current,
    rating: current?.rating ?? 0,
    retained: current?.retained ?? false,
    excluded: current?.excluded ?? false,
    ...update,
  };
}

const useSubtitlePanelUiState = createPanelState<SubtitlePanelUiState>(() => (set) => ({
  trackContext: "",
  sessions: {},
  thumbnailSize: 0,
  ...defaultTrackSessionState(),
  syncTrackContext: (trackContext) =>
    set((state) => {
      if (state.trackContext === trackContext) {
        return state;
      }
      const sessions = state.trackContext
        ? { ...state.sessions, [state.trackContext]: trackSessionFromState(state) }
        : state.sessions;
      return {
        trackContext,
        sessions,
        ...(sessions[trackContext] ?? defaultTrackSessionState()),
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
  setThumbnailSize: (thumbnailSize) =>
    set({
      thumbnailSize: Number.isFinite(thumbnailSize) ? Math.min(100, Math.max(0, thumbnailSize)) : 0,
    }),
  setActiveCueId: (activeCueId) => set({ activeCueId }),
  cueSelectionCleared: () => set({ selectedCueIds: new Set<string>(), activeCueId: null }),
  cueSelectionReplaced: (cueIds, primaryCueId) =>
    set(() => {
      const selectedCueIds = new Set(cueIds);
      const activeCueId =
        primaryCueId && selectedCueIds.has(primaryCueId)
          ? primaryCueId
          : (selectedCueIds.values().next().value ?? null);
      return { selectedCueIds, activeCueId };
    }),
}));

export function useSubtitlePanelState<Selection>(
  selector: (state: SubtitlePanelState) => Selection,
) {
  const uiState = useSubtitlePanelUiState((state) => state);
  const { subtitles, subtitleUpdated } = useProjectPort(["subtitles"], ["subtitleUpdated"]);
  const subtitle = subtitles[uiState.trackContext] ?? { cueAnnotations: {} };
  const commitSubtitle = (
    historyLabel: string,
    recipe: (current: SubtitleState) => SubtitleState,
    historyGroupId?: string,
  ) => subtitleUpdated(uiState.trackContext, historyLabel, recipe, historyGroupId);

  const setCueRatings = (cueIds: Iterable<string>, rating: number, historyGroupId?: string) => {
    const normalized = normalizedRating(rating);
    const uniqueCueIds = Array.from(new Set(cueIds));
    if (uniqueCueIds.length === 0) {
      return;
    }
    commitSubtitle(
      "设置字幕星级",
      (current) => {
        const cueAnnotations = { ...current.cueAnnotations };
        let changed = false;
        for (const cueId of uniqueCueIds) {
          if ((cueAnnotations[cueId]?.rating ?? 0) === normalized) {
            continue;
          }
          cueAnnotations[cueId] = annotationWithDefaults(cueAnnotations[cueId], {
            rating: normalized,
          });
          changed = true;
        }
        return changed ? { ...current, cueAnnotations } : current;
      },
      historyGroupId,
    );
  };

  const setCueCustomLabels = (
    cueIds: Iterable<string>,
    customLabel: string,
    historyGroupId?: string,
  ) => {
    const uniqueCueIds = Array.from(new Set(cueIds));
    const normalized = customLabel.trim();
    if (uniqueCueIds.length === 0) {
      return;
    }
    commitSubtitle(
      "设置字幕标签",
      (current) => {
        const cueAnnotations = { ...current.cueAnnotations };
        let changed = false;
        for (const cueId of uniqueCueIds) {
          const previous = cueAnnotations[cueId];
          if ((previous?.customLabel ?? "") === normalized && previous?.colorLabel == null) {
            continue;
          }
          cueAnnotations[cueId] = annotationWithDefaults(previous, {
            customLabel: normalized || undefined,
            colorLabel: undefined,
          });
          changed = true;
        }
        return changed ? { ...current, cueAnnotations } : current;
      },
      historyGroupId,
    );
  };

  const state: SubtitlePanelState = {
    ...uiState,
    ...subtitle,
    setCueCustomLabel: (cueId, customLabel) => setCueCustomLabels([cueId], customLabel),
    setCueCustomLabels,
    setCueRatings,
    adjustCueRatings: (cueIds, delta) => {
      const normalizedDelta = Number.isFinite(delta) ? Math.round(delta) : 0;
      const uniqueCueIds = Array.from(new Set(cueIds));
      if (normalizedDelta === 0 || uniqueCueIds.length === 0) {
        return;
      }
      commitSubtitle("调整字幕星级", (current) => {
        const cueAnnotations = { ...current.cueAnnotations };
        let changed = false;
        for (const cueId of uniqueCueIds) {
          const previous = cueAnnotations[cueId];
          const rating = Math.min(5, Math.max(0, (previous?.rating ?? 0) + normalizedDelta));
          if (rating === (previous?.rating ?? 0)) {
            continue;
          }
          cueAnnotations[cueId] = annotationWithDefaults(previous, { rating });
          changed = true;
        }
        return changed ? { ...current, cueAnnotations } : current;
      });
    },
    setCueFlags: (cueIds, flag, historyGroupId) => {
      const uniqueCueIds = Array.from(new Set(cueIds));
      if (uniqueCueIds.length === 0) {
        return;
      }
      commitSubtitle(
        "设置字幕旗标",
        (current) => {
          const cueAnnotations = { ...current.cueAnnotations };
          let changed = false;
          for (const cueId of uniqueCueIds) {
            const previous = cueAnnotations[cueId];
            const previousFlag = previous?.retained
              ? "retained"
              : previous?.excluded
                ? "excluded"
                : "none";
            if (previousFlag === flag) {
              continue;
            }
            cueAnnotations[cueId] = annotationWithDefaults(previous, {
              retained: flag === "retained",
              excluded: flag === "excluded",
            });
            changed = true;
          }
          return changed ? { ...current, cueAnnotations } : current;
        },
        historyGroupId,
      );
    },
    setCueColorLabels: (cueIds, colorLabel, historyGroupId) => {
      const uniqueCueIds = Array.from(new Set(cueIds));
      if (uniqueCueIds.length === 0) {
        return;
      }
      commitSubtitle(
        "设置字幕色标",
        (current) => {
          const cueAnnotations = { ...current.cueAnnotations };
          let changed = false;
          for (const cueId of uniqueCueIds) {
            const previous = cueAnnotations[cueId];
            if (
              (previous?.colorLabel ?? null) === colorLabel &&
              !(previous?.customLabel?.trim() ?? "")
            ) {
              continue;
            }
            cueAnnotations[cueId] = annotationWithDefaults(previous, {
              colorLabel: colorLabel ?? undefined,
              customLabel: undefined,
            });
            changed = true;
          }
          return changed ? { ...current, cueAnnotations } : current;
        },
        historyGroupId,
      );
    },
  };

  return selector(state);
}
