import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEventHandler } from "react";
import {
  buildTimelineRuler,
  clampTimelineStart,
  minTimelineSpanUs as getMinTimelineSpanUs,
} from "../../timeline";
import type { MonitorCueRange } from "./sourceMonitorState";

const CURSOR_EDGE_INSET_PX = 6;
const TIMELINE_EDGE_SCROLL_BASE_SPANS_PER_SECOND = 0.2;
const TIMELINE_EDGE_SCROLL_MAX_SPANS_PER_SECOND = 1.2;

interface TimelineRulerProps {
  hasMedia: boolean;
  currentTimeUs: number;
  durationUs: number;
  frameRate: number;
  timelineStartUs: number;
  timelineSpanUs: number;
  cueRange: MonitorCueRange | null;
  onMinTimelineSpanUsChange: (minSpanUs: number) => void;
  onTimelineStartUsChange: (startUs: number) => void;
  onSeekUs: (timeUs: number) => number;
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
  currentTimeUs,
  durationUs,
  frameRate,
  timelineStartUs,
  timelineSpanUs,
  cueRange,
  onMinTimelineSpanUsChange,
  onTimelineStartUsChange,
  onSeekUs,
  onStepFrame,
}: TimelineRulerProps) {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineStartUsRef = useRef(timelineStartUs);
  const timelineSpanUsRef = useRef(timelineSpanUs);
  const timelineDragScrollAtRef = useRef(0);
  const [timelineWidthPx, setTimelineWidthPx] = useState(0);

  const timelineEndUs = Math.min(durationUs, timelineStartUs + timelineSpanUs);
  const timelineVisibleSpanUs = Math.max(1, timelineEndUs - timelineStartUs);
  const currentTimeClampedUs = clamp(currentTimeUs, 0, durationUs || currentTimeUs);
  const cursorPercent =
    currentTimeClampedUs >= timelineStartUs && currentTimeClampedUs <= timelineEndUs
      ? ((currentTimeClampedUs - timelineStartUs) / timelineVisibleSpanUs) * 100
      : null;
  const cueRangePercent = cueRange
    ? {
        start: ((cueRange.startUs - timelineStartUs) / timelineVisibleSpanUs) * 100,
        end: ((cueRange.endUs - timelineStartUs) / timelineVisibleSpanUs) * 100,
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
        startUs: timelineStartUs,
        spanUs: timelineVisibleSpanUs,
        durationUs,
        widthPx: timelineWidthPx,
        frameRate,
      }),
    [durationUs, frameRate, timelineStartUs, timelineVisibleSpanUs, timelineWidthPx],
  );
  const minSpanUs = useMemo(
    () =>
      durationUs > 0
        ? getMinTimelineSpanUs(Math.max(1, timelineWidthPx), frameRate, durationUs)
        : 0,
    [durationUs, frameRate, timelineWidthPx],
  );

  useEffect(() => {
    timelineStartUsRef.current = timelineStartUs;
  }, [timelineStartUs]);

  useEffect(() => {
    timelineSpanUsRef.current = timelineSpanUs;
  }, [timelineSpanUs]);

  useEffect(() => {
    onMinTimelineSpanUsChange(minSpanUs);
  }, [minSpanUs, onMinTimelineSpanUsChange]);

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
    if (rect.width <= 0 || durationUs <= 0) {
      return;
    }

    const now = performance.now();
    const elapsedMs = now - timelineDragScrollAtRef.current;
    const elapsedSeconds =
      timelineDragScrollAtRef.current > 0 && elapsedMs <= 100
        ? clamp(elapsedMs / 1000, 0, 0.05)
        : 0;
    timelineDragScrollAtRef.current = now;

    const currentStartUs = timelineStartUsRef.current;
    const currentSpanUs = timelineSpanUsRef.current;
    const edgeInsetRatio = Math.min(CURSOR_EDGE_INSET_PX / rect.width, 0.25);
    const leftEdgeX = rect.left + CURSOR_EDGE_INSET_PX;
    const rightEdgeX = rect.right - CURSOR_EDGE_INSET_PX;
    const atLeftEdge = clientX <= leftEdgeX;
    const atRightEdge = clientX >= rightEdgeX;

    if (!atLeftEdge && !atRightEdge) {
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      onSeekUs(currentStartUs + ratio * currentSpanUs);
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
    const nextStartUs = clampTimelineStart(
      currentStartUs + direction * currentSpanUs * scrollSpeed * elapsedSeconds,
      currentSpanUs,
      durationUs,
    );
    const maxStartUs = Math.max(0, durationUs - currentSpanUs);
    const reachedVideoEdge =
      (direction < 0 && nextStartUs <= 0) || (direction > 0 && nextStartUs >= maxStartUs);
    const cursorRatio = direction < 0 ? edgeInsetRatio : 1 - edgeInsetRatio;
    const targetUs = reachedVideoEdge
      ? direction < 0
        ? 0
        : durationUs
      : nextStartUs + cursorRatio * currentSpanUs;

    timelineStartUsRef.current = nextStartUs;
    onTimelineStartUsChange(nextStartUs);
    onSeekUs(targetUs);
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
              key={tick.timeUs}
              className={`timeline-tick ${tick.major ? "major" : ""}`}
              data-frame={tick.frame}
              data-time-us={tick.timeUs}
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
