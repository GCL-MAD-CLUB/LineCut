import { createPanelState } from "../../runtime/systems/PanelState";
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

export const shuttlePlaybackRates = [-16, -8, -4, -2, -1, 1, 2, 4, 8, 16] as const;
export type ShuttlePlaybackRate = (typeof shuttlePlaybackRates)[number];
export type PlaybackRate = ShuttlePlaybackRate | 0;
export type SlowPlaybackMode = "slow-reverse" | "slow-forward";
export type PlaybackMode = PlaybackRate | SlowPlaybackMode;

export function isSlowPlaybackMode(mode: PlaybackMode): mode is SlowPlaybackMode {
  return typeof mode === "string";
}

export function nextShuttlePlaybackRate(
  currentRate: PlaybackRate,
  direction: -1 | 1,
): PlaybackRate {
  if (currentRate === 0) {
    return direction < 0 ? -1 : 1;
  }

  const currentIndex = shuttlePlaybackRates.indexOf(currentRate as ShuttlePlaybackRate);
  const nextIndex = Math.min(
    shuttlePlaybackRates.length - 1,
    Math.max(0, currentIndex + direction),
  );
  return shuttlePlaybackRates[nextIndex];
}

type StateUpdate<Value> = Value | ((current: Value) => Value);

function resolveUpdate<Value>(current: Value, update: StateUpdate<Value>) {
  return typeof update === "function" ? (update as (current: Value) => Value)(current) : update;
}

interface SourceMonitorState {
  mediaKey: string;
  playbackHistoryVideoIds: string[];
  currentFrame: number;
  playbackMode: PlaybackMode;
  isPlaying: boolean;
  zoomLevel: MonitorZoomLevel;
  zoomPan: ZoomPan;
  timelineStartFrame: number;
  timelineSpanFrames: number;
  cueRange: MonitorCueRange | null;
  playedVideoRecorded: (videoId: string) => void;
  playedVideoRemoved: (videoId: string) => void;
  playbackHistoryCleared: () => void;
  syncMedia: (mediaKey: string, durationFrames: number) => void;
  setCurrentFrame: (update: StateUpdate<number>) => void;
  setPlaybackMode: (playbackMode: PlaybackMode) => void;
  setZoomLevel: (update: StateUpdate<MonitorZoomLevel>) => void;
  setZoomPan: (update: StateUpdate<ZoomPan>) => void;
  setTimelineStartFrame: (update: StateUpdate<number>) => void;
  setTimelineSpanFrames: (update: StateUpdate<number>) => void;
  setCueRange: (cueRange: MonitorCueRange | null) => void;
}

const DEFAULT_TIMELINE_SPAN_FRAMES = DEFAULT_FRAME_RATE * 60;

export const useSourceMonitorState = createPanelState<SourceMonitorState>(() => (set) => ({
  mediaKey: "",
  playbackHistoryVideoIds: [],
  currentFrame: 0,
  playbackMode: 0,
  isPlaying: false,
  zoomLevel: "fit",
  zoomPan: { x: 0, y: 0 },
  timelineStartFrame: 0,
  timelineSpanFrames: DEFAULT_TIMELINE_SPAN_FRAMES,
  cueRange: null,
  playedVideoRecorded: (videoId) =>
    set((state) => {
      if (!videoId || state.playbackHistoryVideoIds.at(-1) === videoId) {
        return state;
      }
      return {
        playbackHistoryVideoIds: [
          ...state.playbackHistoryVideoIds.filter((candidateId) => candidateId !== videoId),
          videoId,
        ],
      };
    }),
  playedVideoRemoved: (videoId) =>
    set((state) => {
      const playbackHistoryVideoIds = state.playbackHistoryVideoIds.filter(
        (candidateId) => candidateId !== videoId,
      );
      return playbackHistoryVideoIds.length === state.playbackHistoryVideoIds.length
        ? state
        : { playbackHistoryVideoIds };
    }),
  playbackHistoryCleared: () =>
    set((state) =>
      state.playbackHistoryVideoIds.length === 0 ? state : { playbackHistoryVideoIds: [] },
    ),
  syncMedia: (mediaKey, durationFrames) =>
    set((state) =>
      state.mediaKey === mediaKey
        ? state
        : {
            mediaKey,
            currentFrame: 0,
            playbackMode: 0,
            isPlaying: false,
            zoomLevel: "fit",
            zoomPan: { x: 0, y: 0 },
            timelineStartFrame: 0,
            timelineSpanFrames: durationFrames > 0 ? durationFrames : DEFAULT_TIMELINE_SPAN_FRAMES,
            cueRange: null,
          },
    ),
  setCurrentFrame: (update) =>
    set((state) => ({ currentFrame: resolveUpdate(state.currentFrame, update) })),
  setPlaybackMode: (playbackMode) => set({ playbackMode, isPlaying: playbackMode !== 0 }),
  setZoomLevel: (update) => set((state) => ({ zoomLevel: resolveUpdate(state.zoomLevel, update) })),
  setZoomPan: (update) => set((state) => ({ zoomPan: resolveUpdate(state.zoomPan, update) })),
  setTimelineStartFrame: (update) =>
    set((state) => ({ timelineStartFrame: resolveUpdate(state.timelineStartFrame, update) })),
  setTimelineSpanFrames: (update) =>
    set((state) => ({ timelineSpanFrames: resolveUpdate(state.timelineSpanFrames, update) })),
  setCueRange: (cueRange) => set({ cueRange }),
}));
