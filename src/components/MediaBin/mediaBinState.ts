import { createPanelState } from "../../runtime/systems/PanelState";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export type MediaBinViewMode = "list" | "grid";

interface MediaBinPanelState {
  query: string;
  selectedIds: Set<string>;
  visibleItemCount: number;
  viewMode: MediaBinViewMode;
  listSize: number;
  gridSize: number;
  showHidden: boolean;
  bindingPopoverOpen: boolean;
  bindingVideoId: string;
  setQuery: (query: string) => void;
  setVisibleItemCount: (count: number) => void;
  selectOnly: (itemId: string) => void;
  toggleSelected: (itemId: string) => void;
  selectItems: (itemIds: string[]) => void;
  clearSelection: () => void;
  setViewMode: (viewMode: MediaBinViewMode) => void;
  setListSize: (size: number) => void;
  setGridSize: (size: number) => void;
  setShowHidden: (showHidden: boolean) => void;
  setBindingPopoverOpen: (open: boolean) => void;
  setBindingVideoId: (videoId: string) => void;
}

export const useMediaBinState = createPanelState<MediaBinPanelState>(() => (set) => ({
  query: "",
  selectedIds: new Set<string>(),
  visibleItemCount: 0,
  viewMode: "list",
  listSize: 0,
  gridSize: 0,
  showHidden: false,
  bindingPopoverOpen: false,
  bindingVideoId: "",
  setQuery: (query) => set({ query }),
  setVisibleItemCount: (visibleItemCount) => set({ visibleItemCount }),
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
  selectItems: (itemIds) => set({ selectedIds: new Set(itemIds) }),
  clearSelection: () => set({ selectedIds: new Set<string>() }),
  setViewMode: (viewMode) => set({ viewMode }),
  setListSize: (listSize) => set({ listSize }),
  setGridSize: (gridSize) => set({ gridSize }),
  setShowHidden: (showHidden) => set({ showHidden }),
  setBindingPopoverOpen: (bindingPopoverOpen) => set({ bindingPopoverOpen }),
  setBindingVideoId: (bindingVideoId) => set({ bindingVideoId }),
}));

const mediaBinClipboardStore = createStore<{ itemCount: number }>()(() => ({ itemCount: 0 }));

export function useMediaBinClipboardItemCount() {
  return useStore(mediaBinClipboardStore, (state) => state.itemCount);
}

export function setMediaBinClipboardItemCount(itemCount: number) {
  mediaBinClipboardStore.setState({ itemCount });
}
