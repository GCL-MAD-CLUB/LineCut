import { createPanelState } from "../../panelState";
import { DEFAULT_FRAME_RATE } from "../../timeline";

export type MonitorZoomLevel = "fit" | number;

export interface ZoomPan {
  x: number;
  y: number;
}

export interface MonitorCueRange {
  startFrame: number;
  endFrame: number;
}

type StateUpdate<Value> = Value | ((current: Value) => Value);

function resolveUpdate<Value>(current: Value, update: StateUpdate<Value>) {
  return typeof update === "function" ? (update as (current: Value) => Value)(current) : update;
}

interface SourceMonitorState {
  mediaKey: string;
  currentFrame: number;
  zoomLevel: MonitorZoomLevel;
  zoomPan: ZoomPan;
  timelineStartFrame: number;
  timelineSpanFrames: number;
  cueRange: MonitorCueRange | null;
  syncMedia: (mediaKey: string, durationFrames: number) => void;
  setCurrentFrame: (update: StateUpdate<number>) => void;
  setZoomLevel: (update: StateUpdate<MonitorZoomLevel>) => void;
  setZoomPan: (update: StateUpdate<ZoomPan>) => void;
  setTimelineStartFrame: (update: StateUpdate<number>) => void;
  setTimelineSpanFrames: (update: StateUpdate<number>) => void;
  setCueRange: (cueRange: MonitorCueRange | null) => void;
}

const DEFAULT_TIMELINE_SPAN_FRAMES = DEFAULT_FRAME_RATE * 60;

export const useSourceMonitorState = createPanelState<SourceMonitorState>(() => (set) => ({
  mediaKey: "",
  currentFrame: 0,
  zoomLevel: "fit",
  zoomPan: { x: 0, y: 0 },
  timelineStartFrame: 0,
  timelineSpanFrames: DEFAULT_TIMELINE_SPAN_FRAMES,
  cueRange: null,
  syncMedia: (mediaKey, durationFrames) =>
    set((state) =>
      state.mediaKey === mediaKey
        ? state
        : {
            mediaKey,
            currentFrame: 0,
            zoomLevel: "fit",
            zoomPan: { x: 0, y: 0 },
            timelineStartFrame: 0,
            timelineSpanFrames: durationFrames > 0 ? durationFrames : DEFAULT_TIMELINE_SPAN_FRAMES,
            cueRange: null,
          },
    ),
  setCurrentFrame: (update) =>
    set((state) => ({ currentFrame: resolveUpdate(state.currentFrame, update) })),
  setZoomLevel: (update) => set((state) => ({ zoomLevel: resolveUpdate(state.zoomLevel, update) })),
  setZoomPan: (update) => set((state) => ({ zoomPan: resolveUpdate(state.zoomPan, update) })),
  setTimelineStartFrame: (update) =>
    set((state) => ({ timelineStartFrame: resolveUpdate(state.timelineStartFrame, update) })),
  setTimelineSpanFrames: (update) =>
    set((state) => ({ timelineSpanFrames: resolveUpdate(state.timelineSpanFrames, update) })),
  setCueRange: (cueRange) => set({ cueRange }),
}));
