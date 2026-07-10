import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEventHandler } from "react";
import {
  buildTimelineRuler,
  clampTimelineStartFrame,
  minTimelineSpanFrames as getMinTimelineSpanFrames,
} from "../../timeline";
import type { MonitorCueRange } from "./sourceMonitorState";

const CURSOR_EDGE_INSET_PX = 6;
const TIMELINE_EDGE_SCROLL_BASE_SPANS_PER_SECOND = 0.2;
const TIMELINE_EDGE_SCROLL_MAX_SPANS_PER_SECOND = 1.2;

interface TimelineRulerProps {
  hasMedia: boolean;
  currentFrame: number;
  durationFrames: number;
  timelineStartFrame: number;
  timelineSpanFrames: number;
  cueRange: MonitorCueRange | null;
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
  hasMedia,
  currentFrame,
  durationFrames,
  timelineStartFrame,
  timelineSpanFrames,
  cueRange,
  onMinTimelineSpanFramesChange,
  onTimelineStartFrameChange,
  onSeekFrame,
  onStepFrame,
}: TimelineRulerProps) {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineStartFrameRef = useRef(timelineStartFrame);
  const timelineSpanFramesRef = useRef(timelineSpanFrames);
  const timelineDragScrollAtRef = useRef(0);
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
        end: ((cueRange.endFrame - timelineStartFrame) / timelineVisibleSpanFrames) * 100,
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
    if (!hasMedia) {
      return;
    }
    event.preventDefault();
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
    animationFrame = requestAnimationFrame(scrollAtEdge);
  };

  return (
    <div
      ref={timelineRef}
      className={`monitor-timeline ${hasMedia ? "" : "empty-state"}`}
      onPointerDown={hasMedia ? handlePointerDown : undefined}
    >
      <div className="timeline-ruler">
        {hasMedia && visibleCueRange && (
          <div className="timeline-cue-range" aria-hidden="true">
            <div
              className="timeline-cue-fill"
              style={{
                left: `${visibleCueRange.start}%`,
                right: `${100 - visibleCueRange.end}%`,
              }}
            />
            {visibleCueRange.showStart && (
              <svg
                className="timeline-cue-brace start"
                style={{ left: `${visibleCueRange.actualStart}%` }}
                viewBox="0 0 2 20"
                preserveAspectRatio="none"
              >
                <path d="M2 0V8L0 10L2 12V20" />
              </svg>
            )}
            {visibleCueRange.showEnd && (
              <svg
                className="timeline-cue-brace end"
                style={{ left: `${visibleCueRange.actualEnd}%` }}
                viewBox="0 0 2 20"
                preserveAspectRatio="none"
              >
                <path d="M0 0V8L2 10L0 12V20" />
              </svg>
            )}
          </div>
        )}
        {hasMedia &&
          ruler.ticks.map((tick) => (
            <span
              key={tick.frame}
              className={`timeline-tick ${tick.major ? "major" : ""}`}
              data-frame={tick.frame}
              style={{ left: `${tick.leftPx}px` }}
            />
          ))}
        {hasMedia && cursorPercent !== null && (
          <span
            className="timeline-cursor"
            style={{
              left: `${cursorPercent}%`,
            }}
          />
        )}
      </div>
    </div>
  );
}
