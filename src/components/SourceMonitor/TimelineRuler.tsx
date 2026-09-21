import { useEffect, useMemo, useRef, useState } from "react";
import type {
  MouseEventHandler,
  PointerEvent as ReactPointerEvent,
  PointerEventHandler,
  ReactNode,
} from "react";
import {
  buildTimelineRuler,
  clampTimelineStartFrame,
  minTimelineSpanFrames as getMinTimelineSpanFrames,
} from "../../core/editor/timeline";
import type { MonitorCueRange } from "./sourceMonitorState";
import type { StoryboardGap } from "../../core/editor/storyboard";

const CURSOR_EDGE_INSET_PX = 6;
const TIMELINE_EDGE_SCROLL_BASE_SPANS_PER_SECOND = 0.2;
const TIMELINE_EDGE_SCROLL_MAX_SPANS_PER_SECOND = 1.2;

export interface TimelineRulerProps {
  children?: ReactNode;
  storyboardMode?: boolean;
  showTimecodeLabels?: boolean;
  formatTimecodeLabel?: (frame: number) => string;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  hasMedia: boolean;
  currentFrame: number;
  durationFrames: number;
  timelineStartFrame: number;
  timelineSpanFrames: number;
  cueRange: MonitorCueRange | null;
  skippedRanges?: readonly StoryboardGap[];
  onCueRangeChange?: (range: MonitorCueRange) => void;
  onCueRangeDragStart?: () => void;
  onCueRangePreviewFrame?: (frame: number) => void;
  onCueRangePreviewEnd?: () => void;
  onMinTimelineSpanFramesChange: (minSpanFrames: number) => void;
  onTimelineStartFrameChange: (startFrame: number) => void;
  onSeekFrame: (frame: number) => number;
  onStepFrame: (direction: -1 | 1) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function wheelFrameDirection(event: WheelEvent) {
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (delta === 0) {
    return 0;
  }
  return delta > 0 ? 1 : -1;
}

export function TimelineRuler({
  children,
  storyboardMode = false,
  showTimecodeLabels = false,
  formatTimecodeLabel,
  onContextMenu,
  hasMedia,
  currentFrame,
  durationFrames,
  timelineStartFrame,
  timelineSpanFrames,
  cueRange,
  skippedRanges = [],
  onCueRangeChange,
  onCueRangeDragStart,
  onCueRangePreviewFrame,
  onCueRangePreviewEnd,
  onMinTimelineSpanFramesChange,
  onTimelineStartFrameChange,
  onSeekFrame,
  onStepFrame,
}: TimelineRulerProps) {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineStartFrameRef = useRef(timelineStartFrame);
  const timelineSpanFramesRef = useRef(timelineSpanFrames);
  const timelineDragScrollAtRef = useRef(0);
  const timelineDragCleanupRef = useRef<(() => void) | null>(null);
  const cueRangeDragCleanupRef = useRef<(() => void) | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState(0);

  const timelineEndFrame = Math.min(durationFrames, timelineStartFrame + timelineSpanFrames);
  const timelineVisibleSpanFrames = Math.max(1, timelineEndFrame - timelineStartFrame);
  const currentFrameClamped = clamp(currentFrame, 0, durationFrames || currentFrame);
  const cursorPercent =
    currentFrameClamped >= timelineStartFrame && currentFrameClamped <= timelineEndFrame
      ? ((currentFrameClamped - timelineStartFrame) / timelineVisibleSpanFrames) * 100
      : null;
  const cueRangePercent = cueRange
    ? {
        start: ((cueRange.startFrame - timelineStartFrame) / timelineVisibleSpanFrames) * 100,
        end: ((cueRange.endFrame + 1 - timelineStartFrame) / timelineVisibleSpanFrames) * 100,
      }
    : null;
  const visibleCueRange =
    cueRangePercent && cueRangePercent.end >= 0 && cueRangePercent.start <= 100
      ? {
          start: Math.max(0, cueRangePercent.start),
          end: Math.min(100, cueRangePercent.end),
          actualStart: cueRangePercent.start,
          actualEnd: cueRangePercent.end,
          showStart: cueRangePercent.start >= 0 && cueRangePercent.start <= 100,
          showEnd: cueRangePercent.end >= 0 && cueRangePercent.end <= 100,
        }
      : null;

  const ruler = useMemo(
    () =>
      buildTimelineRuler({
        startFrame: timelineStartFrame,
        spanFrames: timelineVisibleSpanFrames,
        durationFrames,
        widthPx: timelineWidthPx,
        minMajorTickWidthPx: 72,
      }),
    [durationFrames, timelineStartFrame, timelineVisibleSpanFrames, timelineWidthPx],
  );
  const minSpanFrames = useMemo(
    () =>
      durationFrames > 0
        ? getMinTimelineSpanFrames(Math.max(1, timelineWidthPx), durationFrames)
        : 0,
    [durationFrames, timelineWidthPx],
  );

  useEffect(() => {
    timelineStartFrameRef.current = timelineStartFrame;
  }, [timelineStartFrame]);

  useEffect(
    () => () => {
      timelineDragCleanupRef.current?.();
      cueRangeDragCleanupRef.current?.();
    },
    [hasMedia],
  );

  useEffect(() => {
    timelineSpanFramesRef.current = timelineSpanFrames;
  }, [timelineSpanFrames]);

  useEffect(() => {
    onMinTimelineSpanFramesChange(minSpanFrames);
  }, [minSpanFrames, onMinTimelineSpanFramesChange]);

  useEffect(() => {
    const element = timelineRef.current;
    if (!element) {
      return;
    }

    const updateWidth = () => setTimelineWidthPx(element.getBoundingClientRect().width);
    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      if (!hasMedia) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const direction = wheelFrameDirection(event);
      if (direction !== 0) {
        onStepFrame(direction);
      }
    };

    timeline.addEventListener("wheel", handleWheel, { passive: false });
    return () => timeline.removeEventListener("wheel", handleWheel);
  }, [hasMedia, onStepFrame]);

  function seekFromTimeline(clientX: number, element: HTMLDivElement) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || durationFrames <= 0) {
      return;
    }

    const now = performance.now();
    const elapsedMs = now - timelineDragScrollAtRef.current;
    const elapsedSeconds =
      timelineDragScrollAtRef.current > 0 && elapsedMs <= 100
        ? clamp(elapsedMs / 1000, 0, 0.05)
        : 0;
    timelineDragScrollAtRef.current = now;

    const currentStartFrame = timelineStartFrameRef.current;
    const currentSpanFrames = timelineSpanFramesRef.current;
    const edgeInsetRatio = Math.min(CURSOR_EDGE_INSET_PX / rect.width, 0.25);
    const leftEdgeX = rect.left + CURSOR_EDGE_INSET_PX;
    const rightEdgeX = rect.right - CURSOR_EDGE_INSET_PX;
    const atLeftEdge = clientX <= leftEdgeX;
    const atRightEdge = clientX >= rightEdgeX;

    if (!atLeftEdge && !atRightEdge) {
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      onSeekFrame(currentStartFrame + ratio * currentSpanFrames);
      return;
    }

    const direction = atLeftEdge ? -1 : 1;
    const overflowPx =
      direction < 0 ? Math.max(0, leftEdgeX - clientX) : Math.max(0, clientX - rightEdgeX);
    const overflowRatio = clamp(overflowPx / rect.width, 0, 1);
    const scrollSpeed =
      TIMELINE_EDGE_SCROLL_BASE_SPANS_PER_SECOND +
      overflowRatio *
        (TIMELINE_EDGE_SCROLL_MAX_SPANS_PER_SECOND - TIMELINE_EDGE_SCROLL_BASE_SPANS_PER_SECOND);
    const nextStartFrame = clampTimelineStartFrame(
      currentStartFrame + direction * currentSpanFrames * scrollSpeed * elapsedSeconds,
      currentSpanFrames,
      durationFrames,
    );
    const maxStartFrame = Math.max(0, durationFrames - currentSpanFrames);
    const reachedVideoEdge =
      (direction < 0 && nextStartFrame <= 0) || (direction > 0 && nextStartFrame >= maxStartFrame);
    const cursorRatio = direction < 0 ? edgeInsetRatio : 1 - edgeInsetRatio;
    const targetFrame = reachedVideoEdge
      ? direction < 0
        ? 0
        : durationFrames
      : nextStartFrame + cursorRatio * currentSpanFrames;

    timelineStartFrameRef.current = nextStartFrame;
    onTimelineStartFrameChange(nextStartFrame);
    onSeekFrame(targetFrame);
  }

  const handlePointerDown: PointerEventHandler<HTMLDivElement> = (event) => {
    if (!hasMedia || event.button !== 0) {
      return;
    }
    event.preventDefault();
    timelineDragCleanupRef.current?.();
    const element = event.currentTarget;
    let latestClientX = event.clientX;
    let animationFrame: number | null = null;
    timelineDragScrollAtRef.current = 0;
    seekFromTimeline(event.clientX, element);

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      latestClientX = moveEvent.clientX;
      seekFromTimeline(moveEvent.clientX, element);
    };
    const handleUp = () => {
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
      }
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      window.removeEventListener("blur", handleUp);
      timelineDragCleanupRef.current = null;
    };
    const scrollAtEdge = () => {
      const rect = element.getBoundingClientRect();
      if (
        latestClientX <= rect.left + CURSOR_EDGE_INSET_PX ||
        latestClientX >= rect.right - CURSOR_EDGE_INSET_PX
      ) {
        seekFromTimeline(latestClientX, element);
      }
      animationFrame = requestAnimationFrame(scrollAtEdge);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
    window.addEventListener("pointercancel", handleUp, { once: true });
    window.addEventListener("blur", handleUp, { once: true });
    timelineDragCleanupRef.current = handleUp;
    animationFrame = requestAnimationFrame(scrollAtEdge);
  };

  function beginCueRangeDrag(
    event: ReactPointerEvent<HTMLSpanElement>,
    part: "start" | "end" | "both",
  ) {
    if (event.button !== 0 || !cueRange || !onCueRangeChange || timelineWidthPx <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    timelineDragCleanupRef.current?.();
    cueRangeDragCleanupRef.current?.();
    onCueRangeDragStart?.();

    const originX = event.clientX;
    const origin = cueRange;
    onCueRangeChange(origin);
    if (part !== "both") {
      onCueRangePreviewFrame?.(part === "start" ? origin.startFrame : origin.endFrame);
    }
    const rangeLength = origin.endFrame - origin.startFrame;
    const framesPerPixel = timelineVisibleSpanFrames / timelineWidthPx;

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      moveEvent.preventDefault();
      const delta = Math.round((moveEvent.clientX - originX) * framesPerPixel);
      let nextRange: MonitorCueRange;
      if (part === "start") {
        nextRange = {
          startFrame: clamp(origin.startFrame + delta, 0, origin.endFrame),
          endFrame: origin.endFrame,
        };
      } else if (part === "end") {
        nextRange = {
          startFrame: origin.startFrame,
          endFrame: clamp(origin.endFrame + delta, origin.startFrame, durationFrames - 1),
        };
      } else {
        const startFrame = clamp(
          origin.startFrame + delta,
          0,
          Math.max(0, durationFrames - 1 - rangeLength),
        );
        nextRange = { startFrame, endFrame: startFrame + rangeLength };
      }
      onCueRangeChange(nextRange);
      if (part !== "both") {
        onCueRangePreviewFrame?.(part === "start" ? nextRange.startFrame : nextRange.endFrame);
      }
    };
    const handleEnd = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
      window.removeEventListener("blur", handleEnd);
      cueRangeDragCleanupRef.current = null;
      if (part !== "both") onCueRangePreviewEnd?.();
    };

    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleEnd, { once: true });
    window.addEventListener("pointercancel", handleEnd, { once: true });
    window.addEventListener("blur", handleEnd, { once: true });
    cueRangeDragCleanupRef.current = handleEnd;
  }

  return (
    <div
      ref={timelineRef}
      className={`monitor-timeline ${storyboardMode ? "storyboard-mode" : ""} ${hasMedia ? "" : "empty-state"}`}
      onPointerDown={hasMedia ? handlePointerDown : undefined}
      onContextMenu={onContextMenu}
    >
      <div className="timeline-ruler">
        {hasMedia && visibleCueRange && (
          <div className="timeline-cue-range">
            <div
              className="timeline-cue-fill"
              style={{
                left: `${visibleCueRange.start}%`,
                right: `${100 - visibleCueRange.end}%`,
              }}
            />
            {visibleCueRange.showStart && (
              <span
                className="timeline-cue-edge start"
                style={{ left: `${visibleCueRange.actualStart}%` }}
                title="拖动选区起点"
                onPointerDown={(event) => beginCueRangeDrag(event, "start")}
              >
                <svg className="timeline-cue-brace" viewBox="0 0 2 20" aria-hidden="true">
                  <path d="M2 0V8L0 10L2 12V20" />
                </svg>
              </span>
            )}
            {visibleCueRange.showEnd && (
              <span
                className="timeline-cue-edge end"
                style={{ left: `${visibleCueRange.actualEnd}%` }}
                title="拖动选区终点"
                onPointerDown={(event) => beginCueRangeDrag(event, "end")}
              >
                <svg className="timeline-cue-brace" viewBox="0 0 2 20" aria-hidden="true">
                  <path d="M0 0V8L2 10L0 12V20" />
                </svg>
              </span>
            )}
            {(visibleCueRange.actualStart + visibleCueRange.actualEnd) / 2 >= 0 &&
              (visibleCueRange.actualStart + visibleCueRange.actualEnd) / 2 <= 100 && (
                <span
                  className="timeline-cue-move-handle"
                  style={{
                    left: `${(visibleCueRange.actualStart + visibleCueRange.actualEnd) / 2}%`,
                  }}
                  title="拖动整个选区"
                  onPointerDown={(event) => beginCueRangeDrag(event, "both")}
                />
              )}
          </div>
        )}
        {hasMedia &&
          skippedRanges.map((gap) => {
            const start = Math.max(timelineStartFrame, gap.startFrame);
            const end = Math.min(timelineEndFrame, gap.endFrame);
            if (end <= start) return null;
            return (
              <span
                key={gap.startFrame}
                className="timeline-skipped-range"
                title="无分镜区域：连续播放时自动跳过，可手动定位播放"
                style={{
                  left: `${((start - timelineStartFrame) / timelineVisibleSpanFrames) * 100}%`,
                  width: `${((end - start) / timelineVisibleSpanFrames) * 100}%`,
                }}
              />
            );
          })}
        {hasMedia &&
          ruler.ticks.map((tick) => (
            <span
              key={tick.frame}
              className={`timeline-tick ${tick.major ? "major" : ""}`}
              data-frame={tick.frame}
              style={{ left: `${tick.leftPx}px` }}
            >
              {showTimecodeLabels && tick.major && formatTimecodeLabel && (
                <span className="timeline-tick-label">{formatTimecodeLabel(tick.frame)}</span>
              )}
            </span>
          ))}
        {hasMedia && cursorPercent !== null && (
          <span
            className="timeline-cursor"
            style={{
              left: `${cursorPercent}%`,
            }}
          >
            {ruler.tickStepFrames === 1 && currentFrameClamped < durationFrames && (
              <span
                className="timeline-cursor-frame"
                style={{ width: `${ruler.tickSpacingPx - 2}px` }}
              />
            )}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
