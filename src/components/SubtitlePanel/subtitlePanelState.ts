import { createPanelState } from "../../panelState";

interface SubtitlePanelState {
  trackContext: string;
  query: string;
  showOnlySelected: boolean;
  activeCueId: string | null;
  syncTrackContext: (trackContext: string) => void;
  setQuery: (query: string) => void;
  setShowOnlySelected: (value: boolean) => void;
  setActiveCueId: (cueId: string) => void;
}

export const useSubtitlePanelState = createPanelState<SubtitlePanelState>(() => (set) => ({
  trackContext: "",
  query: "",
  showOnlySelected: false,
  activeCueId: null,
  syncTrackContext: (trackContext) =>
    set((state) =>
      state.trackContext === trackContext
        ? state
        : {
            trackContext,
            query: "",
            showOnlySelected: false,
            activeCueId: null,
          },
    ),
  setQuery: (query) => set({ query }),
  setShowOnlySelected: (showOnlySelected) => set({ showOnlySelected }),
  setActiveCueId: (activeCueId) => set({ activeCueId }),
}));
