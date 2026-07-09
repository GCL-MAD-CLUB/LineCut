import { createPanelState } from "../../panelState";

export type MonitorZoomLevel = "fit" | number;

interface ZoomOrigin {
  x: number;
  y: number;
}

export interface MonitorCueRange {
  startUs: number;
  endUs: number;
}

type StateUpdate<Value> = Value | ((current: Value) => Value);

function resolveUpdate<Value>(current: Value, update: StateUpdate<Value>) {
  return typeof update === "function" ? (update as (current: Value) => Value)(current) : update;
}

interface SourceMonitorState {
  mediaKey: string;
  currentTimeUs: number;
  zoomLevel: MonitorZoomLevel;
  zoomOrigin: ZoomOrigin;
  timelineStartUs: number;
  timelineSpanUs: number;
  cueRange: MonitorCueRange | null;
  syncMedia: (mediaKey: string, durationUs: number) => void;
  setCurrentTimeUs: (update: StateUpdate<number>) => void;
  setZoomLevel: (update: StateUpdate<MonitorZoomLevel>) => void;
  setZoomOrigin: (update: StateUpdate<ZoomOrigin>) => void;
  setTimelineStartUs: (update: StateUpdate<number>) => void;
  setTimelineSpanUs: (update: StateUpdate<number>) => void;
  setCueRange: (cueRange: MonitorCueRange | null) => void;
}

export const useSourceMonitorState = createPanelState<SourceMonitorState>(() => (set) => ({
  mediaKey: "",
  currentTimeUs: 0,
  zoomLevel: "fit",
  zoomOrigin: { x: 50, y: 50 },
  timelineStartUs: 0,
  timelineSpanUs: 60_000_000,
  cueRange: null,
  syncMedia: (mediaKey, durationUs) =>
    set((state) =>
      state.mediaKey === mediaKey
        ? state
        : {
            mediaKey,
            currentTimeUs: 0,
            zoomLevel: "fit",
            zoomOrigin: { x: 50, y: 50 },
            timelineStartUs: 0,
            timelineSpanUs: durationUs > 0 ? durationUs : 60_000_000,
            cueRange: null,
          },
    ),
  setCurrentTimeUs: (update) =>
    set((state) => ({ currentTimeUs: resolveUpdate(state.currentTimeUs, update) })),
  setZoomLevel: (update) => set((state) => ({ zoomLevel: resolveUpdate(state.zoomLevel, update) })),
  setZoomOrigin: (update) =>
    set((state) => ({ zoomOrigin: resolveUpdate(state.zoomOrigin, update) })),
  setTimelineStartUs: (update) =>
    set((state) => ({ timelineStartUs: resolveUpdate(state.timelineStartUs, update) })),
  setTimelineSpanUs: (update) =>
    set((state) => ({ timelineSpanUs: resolveUpdate(state.timelineSpanUs, update) })),
  setCueRange: (cueRange) => set({ cueRange }),
}));
