import { createPanelState } from "../../panelState";

export type MediaBinViewMode = "list" | "grid";

interface MediaBinPanelState {
  query: string;
  selectedIds: Set<string>;
  viewMode: MediaBinViewMode;
  bindingPopoverOpen: boolean;
  bindingVideoId: string;
  setQuery: (query: string) => void;
  selectOnly: (itemId: string) => void;
  toggleSelected: (itemId: string) => void;
  clearSelection: () => void;
  setViewMode: (viewMode: MediaBinViewMode) => void;
  setBindingPopoverOpen: (open: boolean) => void;
  setBindingVideoId: (videoId: string) => void;
}

export const useMediaBinState = createPanelState<MediaBinPanelState>(() => (set) => ({
  query: "",
  selectedIds: new Set<string>(),
  viewMode: "list",
  bindingPopoverOpen: false,
  bindingVideoId: "",
  setQuery: (query) => set({ query }),
  selectOnly: (itemId) => set({ selectedIds: new Set([itemId]) }),
  toggleSelected: (itemId) =>
    set((state) => {
      const selectedIds = new Set(state.selectedIds);
      if (selectedIds.has(itemId)) {
        selectedIds.delete(itemId);
      } else {
        selectedIds.add(itemId);
      }
      return { selectedIds };
    }),
  clearSelection: () => set({ selectedIds: new Set<string>() }),
  setViewMode: (viewMode) => set({ viewMode }),
  setBindingPopoverOpen: (bindingPopoverOpen) => set({ bindingPopoverOpen }),
  setBindingVideoId: (bindingVideoId) => set({ bindingVideoId }),
}));
