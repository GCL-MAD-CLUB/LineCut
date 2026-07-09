import { createPanelState } from "../../panelState";

interface SubtitlePanelState {
  trackContext: string;
  query: string;
  showOnlySelected: boolean;
  syncTrackContext: (trackContext: string) => void;
  setQuery: (query: string) => void;
  setShowOnlySelected: (value: boolean) => void;
}

export const useSubtitlePanelState = createPanelState<SubtitlePanelState>(() => (set) => ({
  trackContext: "",
  query: "",
  showOnlySelected: false,
  syncTrackContext: (trackContext) =>
    set((state) =>
      state.trackContext === trackContext
        ? state
        : {
            trackContext,
            query: "",
            showOnlySelected: false,
          },
    ),
  setQuery: (query) => set({ query }),
  setShowOnlySelected: (showOnlySelected) => set({ showOnlySelected }),
}));
