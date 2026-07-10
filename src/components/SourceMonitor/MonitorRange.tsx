import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEventHandler } from "react";
import { clampTimelineStartFrame } from "../../timeline";

type ActiveRangeHandle = "start" | "end" | "both" | null;
type RangeDragUpdate = (deltaRatio: number) => void;
type RangeHandleDragController = {
  update: (deltaRatio: number) => void;
  end: () => void;
};

interface MonitorRangeProps {
  hasMedia: boolean;
  durationFrames: number;
  timelineStartFrame: number;
  timelineSpanFrames: number;
  minTimelineSpanFrames: number;
  onTimelineStartFrameChange: (startFrame: number) => void;
  onTimelineSpanFramesChange: (spanFrames: number) => void;
}

const WHEEL_LINE_DELTA_PX = 16;
const WHEEL_PAGE_DELTA_PX = 800;
const MONITOR_RANGE_ZOOM_SENSITIVITY = 0.00035;
const MONITOR_RANGE_SCROLL_SENSITIVITY = 1 / 5000;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function mapLogicalRangeRatio(
  logicalRatio: number,
  minLogicalRatio: number,
  minVisualRatio: number,
) {
  if (minLogicalRatio <= 0 || minLogicalRatio >= 1 || minVisualRatio >= 1) {
    return clamp(logicalRatio, 0, 1);
  }
  const normalized =
    Math.log(clamp(logicalRatio, minLogicalRatio, 1) / minLogicalRatio) /
    Math.log(1 / minLogicalRatio);
  return minVisualRatio + normalized * (1 - minVisualRatio);
}

function mapVisualRangeRatio(visualRatio: number, minLogicalRatio: number, minVisualRatio: number) {
  if (minLogicalRatio <= 0 || minLogicalRatio >= 1 || minVisualRatio >= 1) {
    return clamp(visualRatio, 0, 1);
  }
  const normalized = clamp((visualRatio - minVisualRatio) / (1 - minVisualRatio), 0, 1);
  return minLogicalRatio * Math.exp(normalized * Math.log(1 / minLogicalRatio));
}

function wheelDeltaPx(event: WheelEvent) {
  const modeMultiplier =
    event.deltaMode === 1 ? WHEEL_LINE_DELTA_PX : event.deltaMode === 2 ? WHEEL_PAGE_DELTA_PX : 1;
  const deltaX = event.deltaX * modeMultiplier;
  const deltaY = event.deltaY * modeMultiplier;
  return Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
}

export function MonitorRange({
  hasMedia,
  durationFrames,
  timelineStartFrame,
  timelineSpanFrames,
  minTimelineSpanFrames,
  onTimelineStartFrameChange,
  onTimelineSpanFramesChange,
}: MonitorRangeProps) {
  const rangeRef = useRef<HTMLDivElement | null>(null);
  const timelineStartFrameRef = useRef(timelineStartFrame);
  const timelineSpanFramesRef = useRef(timelineSpanFrames);
  const [rangeWidthPx, setRangeWidthPx] = useState(0);
  const [rangeMinBarWidthPx, setRangeMinBarWidthPx] = useState(0);
  const [activeRangeHandle, setActiveRangeHandle] = useState<ActiveRangeHandle>(null);

  const timelineEndFrame = Math.min(durationFrames, timelineStartFrame + timelineSpanFrames);
  const timelineVisibleSpanFrames = Math.max(1, timelineEndFrame - timelineStartFrame);
  const indicatorWidthRatio = rangeWidthRatioForSpan(timelineVisibleSpanFrames);
  const indicatorLeftRatio = rangeLeftRatioForStart(timelineStartFrame, timelineVisibleSpanFrames);
  const rangeBarStyle = {
    "--monitor-range-left": `${indicatorLeftRatio * 100}%`,
    "--monitor-range-width": `${indicatorWidthRatio * 100}%`,
  } as CSSProperties;

  useEffect(() => {
    timelineStartFrameRef.current = timelineStartFrame;
  }, [timelineStartFrame]);

  useEffect(() => {
    timelineSpanFramesRef.current = timelineSpanFrames;
  }, [timelineSpanFrames]);

  useEffect(() => {
    const range = rangeRef.current;
    if (!range) {
      return;
    }
    const minWidthProbe = range.querySelector<HTMLElement>(".monitor-range-min-width-probe");

    const updateWidth = () => {
      setRangeWidthPx(range.getBoundingClientRect().width);
      setRangeMinBarWidthPx(minWidthProbe?.getBoundingClientRect().width ?? 0);
    };
    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(range);
    if (minWidthProbe) {
      resizeObserver.observe(minWidthProbe);
    }
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const range = rangeRef.current;
    if (!range) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      try {
        range.focus({ preventScroll: true });
      } catch {
        range.focus();
      }
      handleIndicatorWheel(event);
    };

    range.addEventListener("wheel", handleWheel, { passive: false });
    return () => range.removeEventListener("wheel", handleWheel);
  }, [durationFrames, hasMedia, minTimelineSpanFrames, rangeMinBarWidthPx, rangeWidthPx]);

  function rangeWidthRatioForSpan(spanFrames: number) {
    if (durationFrames <= 0) {
      return 1;
    }
    const logicalWidthRatio = clamp(spanFrames / durationFrames, 0, 1);
    if (rangeWidthPx <= 0) {
      return logicalWidthRatio;
    }
    const minLogicalWidthRatio = clamp(minTimelineSpanFrames / durationFrames, 0, 1);
    const minVisualWidthRatio = clamp(rangeMinBarWidthPx / rangeWidthPx, 0, 1);
    if (minLogicalWidthRatio >= 1 || minVisualWidthRatio >= 1) {
      return 1;
    }
    return mapLogicalRangeRatio(logicalWidthRatio, minLogicalWidthRatio, minVisualWidthRatio);
  }

  function spanForRangeWidthRatio(widthRatio: number) {
    if (durationFrames <= 0) {
      return 0;
    }
    if (rangeWidthPx <= 0) {
      return clamp(widthRatio, 0, 1) * durationFrames;
    }
    const minLogicalWidthRatio = clamp(minTimelineSpanFrames / durationFrames, 0, 1);
    const minVisualWidthRatio = clamp(rangeMinBarWidthPx / rangeWidthPx, 0, 1);
    if (minLogicalWidthRatio >= 1 || minVisualWidthRatio >= 1) {
      return durationFrames;
    }
    return (
      mapVisualRangeRatio(widthRatio, minLogicalWidthRatio, minVisualWidthRatio) * durationFrames
    );
  }

  function rangeCenterRatioForStart(startFrame: number, spanFrames: number) {
    if (durationFrames <= 0) {
      return 0;
    }
    const widthRatio = rangeWidthRatioForSpan(spanFrames);
    const maxStartFrame = Math.max(0, durationFrames - spanFrames);
    if (maxStartFrame <= 0) {
      return 0.5;
    }
    const movableCenterRatio = Math.max(0, 1 - widthRatio);
    return widthRatio / 2 + clamp(startFrame / maxStartFrame, 0, 1) * movableCenterRatio;
  }

  function rangeLeftRatioForStart(startFrame: number, spanFrames: number) {
    const widthRatio = rangeWidthRatioForSpan(spanFrames);
    return clamp(rangeCenterRatioForStart(startFrame, spanFrames) - widthRatio / 2, 0, 1);
  }

  function rangeStartForCenterRatio(centerRatio: number, spanFrames: number) {
    if (durationFrames <= 0) {
      return 0;
    }
    const widthRatio = rangeWidthRatioForSpan(spanFrames);
    const minCenterRatio = widthRatio / 2;
    const maxCenterRatio = 1 - widthRatio / 2;
    const movableCenterRatio = Math.max(0, maxCenterRatio - minCenterRatio);
    const maxStartFrame = Math.max(0, durationFrames - spanFrames);
    if (movableCenterRatio <= 0 || maxStartFrame <= 0) {
      return 0;
    }
    const centerProgress =
      (clamp(centerRatio, minCenterRatio, maxCenterRatio) - minCenterRatio) / movableCenterRatio;
    return clampTimelineStartFrame(centerProgress * maxStartFrame, spanFrames, durationFrames);
  }

  function shiftTimeline(deltaFrames: number) {
    if (!hasMedia || durationFrames <= 0) {
      return;
    }
    const currentStart = timelineStartFrameRef.current;
    const currentSpan = timelineSpanFramesRef.current;
    const nextStart = clampTimelineStartFrame(
      currentStart + deltaFrames,
      currentSpan,
      durationFrames,
    );
    timelineStartFrameRef.current = nextStart;
    onTimelineStartFrameChange(nextStart);
  }

  function resizeTimeline(deltaPx: number, anchorRatio = 0.5) {
    if (!hasMedia || durationFrames <= 0) {
      return;
    }
    const currentStart = timelineStartFrameRef.current;
    const currentSpan = timelineSpanFramesRef.current;
    const scale = Math.exp(clamp(deltaPx, -1200, 1200) * MONITOR_RANGE_ZOOM_SENSITIVITY);
    const nextSpan = clamp(currentSpan * scale, minTimelineSpanFrames, durationFrames);
    const anchorFrame = currentStart + currentSpan * anchorRatio;
    const nextStart = clampTimelineStartFrame(
      anchorFrame - nextSpan * anchorRatio,
      nextSpan,
      durationFrames,
    );

    timelineSpanFramesRef.current = nextSpan;
    timelineStartFrameRef.current = nextStart;
    onTimelineSpanFramesChange(nextSpan);
    onTimelineStartFrameChange(nextStart);
  }

  function handleIndicatorWheel(event: WheelEvent) {
    if (!hasMedia) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const delta = wheelDeltaPx(event);
    if (event.altKey) {
      shiftTimeline(delta * timelineSpanFramesRef.current * MONITOR_RANGE_SCROLL_SENSITIVITY);
      return;
    }
    resizeTimeline(delta);
  }

  function beginRangeDrag(): RangeDragUpdate | null {
    if (!hasMedia || durationFrames <= 0) {
      return null;
    }
    const spanFrames = timelineSpanFramesRef.current;
    const startCenterRatio = rangeCenterRatioForStart(timelineStartFrameRef.current, spanFrames);
    return (deltaRatio: number) => {
      const nextStart = rangeStartForCenterRatio(startCenterRatio + deltaRatio, spanFrames);
      timelineStartFrameRef.current = nextStart;
      onTimelineStartFrameChange(nextStart);
    };
  }

  function beginRangeHandleDrag(side: "start" | "end"): RangeHandleDragController | null {
    if (!hasMedia || durationFrames <= 0) {
      return null;
    }
    setActiveRangeHandle("both");
    const startSpanFrames = timelineSpanFramesRef.current;
    const startRangeWidthRatio = rangeWidthRatioForSpan(startSpanFrames);
    const centerFrame = timelineStartFrameRef.current + startSpanFrames / 2;

    return {
      update: (deltaRatio: number) => {
        const nextRangeWidthRatio =
          side === "start"
            ? startRangeWidthRatio - deltaRatio * 2
            : startRangeWidthRatio + deltaRatio * 2;
        const nextSpanFrames = clamp(
          spanForRangeWidthRatio(nextRangeWidthRatio),
          minTimelineSpanFrames,
          durationFrames,
        );
        timelineSpanFramesRef.current = nextSpanFrames;
        timelineStartFrameRef.current = clampTimelineStartFrame(
          centerFrame - nextSpanFrames / 2,
          nextSpanFrames,
          durationFrames,
        );
        onTimelineSpanFramesChange(nextSpanFrames);
        onTimelineStartFrameChange(timelineStartFrameRef.current);
      },
      end: () => {
        setActiveRangeHandle(null);
      },
    };
  }

  const handleRangePointerDown: PointerEventHandler<HTMLDivElement> = (event) => {
    if (!hasMedia) {
      return;
    }
    event.preventDefault();
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    const updateRange = beginRangeDrag();
    if (!rect || !updateRange) {
      return;
    }

    const startX = event.clientX;
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      updateRange((moveEvent.clientX - startX) / rect.width);
    };
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
    window.addEventListener("pointercancel", handleUp, { once: true });
  };

  function handleRangeHandlePointerDown(
    side: "start" | "end",
  ): PointerEventHandler<HTMLButtonElement> {
    return (event) => {
      if (!hasMedia) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const rect = rangeRef.current?.getBoundingClientRect();
      const controller = beginRangeHandleDrag(side);
      if (!rect || !controller) {
        controller?.end();
        return;
      }

      const startX = event.clientX;
      const handleMove = (moveEvent: globalThis.PointerEvent) => {
        controller.update((moveEvent.clientX - startX) / rect.width);
      };
      const handleUp = () => {
        controller.end();
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp, { once: true });
      window.addEventListener("pointercancel", handleUp, { once: true });
    };
  }

  return (
    <div ref={rangeRef} className={`monitor-range ${hasMedia ? "" : "empty-state"}`} tabIndex={-1}>
      <span className="monitor-range-min-width-probe" aria-hidden="true" />
      <div className="monitor-range-track">
        <div
          className="monitor-range-bar"
          style={rangeBarStyle}
          onPointerDown={hasMedia ? handleRangePointerDown : undefined}
        >
          <button
            type="button"
            className={`monitor-range-handle start ${
              activeRangeHandle === "start" || activeRangeHandle === "both" ? "active" : ""
            }`}
            disabled={!hasMedia}
            onPointerDown={hasMedia ? handleRangeHandlePointerDown("start") : undefined}
            aria-label="调整左边界"
          />
          <button
            type="button"
            className={`monitor-range-handle end ${
              activeRangeHandle === "end" || activeRangeHandle === "both" ? "active" : ""
            }`}
            disabled={!hasMedia}
            onPointerDown={hasMedia ? handleRangeHandlePointerDown("end") : undefined}
            aria-label="调整右边界"
          />
        </div>
      </div>
    </div>
  );
}
