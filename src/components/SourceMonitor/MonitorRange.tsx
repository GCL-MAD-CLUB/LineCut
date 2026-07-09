import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEventHandler } from "react";
import { clampTimelineStart } from "../../timeline";

type ActiveRangeHandle = "start" | "end" | "both" | null;
type RangeDragUpdate = (deltaRatio: number) => void;
type RangeHandleDragController = {
  update: (deltaRatio: number) => void;
  end: () => void;
};

interface MonitorRangeProps {
  hasMedia: boolean;
  durationUs: number;
  timelineStartUs: number;
  timelineSpanUs: number;
  minTimelineSpanUs: number;
  onTimelineStartUsChange: (startUs: number) => void;
  onTimelineSpanUsChange: (spanUs: number) => void;
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
  durationUs,
  timelineStartUs,
  timelineSpanUs,
  minTimelineSpanUs,
  onTimelineStartUsChange,
  onTimelineSpanUsChange,
}: MonitorRangeProps) {
  const rangeRef = useRef<HTMLDivElement | null>(null);
  const timelineStartUsRef = useRef(timelineStartUs);
  const timelineSpanUsRef = useRef(timelineSpanUs);
  const [rangeWidthPx, setRangeWidthPx] = useState(0);
  const [rangeMinBarWidthPx, setRangeMinBarWidthPx] = useState(0);
  const [activeRangeHandle, setActiveRangeHandle] = useState<ActiveRangeHandle>(null);

  const timelineEndUs = Math.min(durationUs, timelineStartUs + timelineSpanUs);
  const timelineVisibleSpanUs = Math.max(1, timelineEndUs - timelineStartUs);
  const indicatorWidthRatio = rangeWidthRatioForSpan(timelineVisibleSpanUs);
  const indicatorLeftRatio = rangeLeftRatioForStart(timelineStartUs, timelineVisibleSpanUs);
  const rangeBarStyle = {
    "--monitor-range-left": `${indicatorLeftRatio * 100}%`,
    "--monitor-range-width": `${indicatorWidthRatio * 100}%`,
  } as CSSProperties;

  useEffect(() => {
    timelineStartUsRef.current = timelineStartUs;
  }, [timelineStartUs]);

  useEffect(() => {
    timelineSpanUsRef.current = timelineSpanUs;
  }, [timelineSpanUs]);

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
  }, [durationUs, hasMedia, minTimelineSpanUs, rangeMinBarWidthPx, rangeWidthPx]);

  function rangeWidthRatioForSpan(spanUs: number) {
    if (durationUs <= 0) {
      return 1;
    }
    const logicalWidthRatio = clamp(spanUs / durationUs, 0, 1);
    if (rangeWidthPx <= 0) {
      return logicalWidthRatio;
    }
    const minLogicalWidthRatio = clamp(minTimelineSpanUs / durationUs, 0, 1);
    const minVisualWidthRatio = clamp(rangeMinBarWidthPx / rangeWidthPx, 0, 1);
    if (minLogicalWidthRatio >= 1 || minVisualWidthRatio >= 1) {
      return 1;
    }
    return mapLogicalRangeRatio(logicalWidthRatio, minLogicalWidthRatio, minVisualWidthRatio);
  }

  function spanForRangeWidthRatio(widthRatio: number) {
    if (durationUs <= 0) {
      return 0;
    }
    if (rangeWidthPx <= 0) {
      return clamp(widthRatio, 0, 1) * durationUs;
    }
    const minLogicalWidthRatio = clamp(minTimelineSpanUs / durationUs, 0, 1);
    const minVisualWidthRatio = clamp(rangeMinBarWidthPx / rangeWidthPx, 0, 1);
    if (minLogicalWidthRatio >= 1 || minVisualWidthRatio >= 1) {
      return durationUs;
    }
    return mapVisualRangeRatio(widthRatio, minLogicalWidthRatio, minVisualWidthRatio) * durationUs;
  }

  function rangeCenterRatioForStart(startUs: number, spanUs: number) {
    if (durationUs <= 0) {
      return 0;
    }
    const widthRatio = rangeWidthRatioForSpan(spanUs);
    const maxStartUs = Math.max(0, durationUs - spanUs);
    if (maxStartUs <= 0) {
      return 0.5;
    }
    const movableCenterRatio = Math.max(0, 1 - widthRatio);
    return widthRatio / 2 + clamp(startUs / maxStartUs, 0, 1) * movableCenterRatio;
  }

  function rangeLeftRatioForStart(startUs: number, spanUs: number) {
    const widthRatio = rangeWidthRatioForSpan(spanUs);
    return clamp(rangeCenterRatioForStart(startUs, spanUs) - widthRatio / 2, 0, 1);
  }

  function rangeStartForCenterRatio(centerRatio: number, spanUs: number) {
    if (durationUs <= 0) {
      return 0;
    }
    const widthRatio = rangeWidthRatioForSpan(spanUs);
    const minCenterRatio = widthRatio / 2;
    const maxCenterRatio = 1 - widthRatio / 2;
    const movableCenterRatio = Math.max(0, maxCenterRatio - minCenterRatio);
    const maxStartUs = Math.max(0, durationUs - spanUs);
    if (movableCenterRatio <= 0 || maxStartUs <= 0) {
      return 0;
    }
    const centerProgress =
      (clamp(centerRatio, minCenterRatio, maxCenterRatio) - minCenterRatio) / movableCenterRatio;
    return clampTimelineStart(centerProgress * maxStartUs, spanUs, durationUs);
  }

  function shiftTimeline(deltaUs: number) {
    if (!hasMedia || durationUs <= 0) {
      return;
    }
    const currentStart = timelineStartUsRef.current;
    const currentSpan = timelineSpanUsRef.current;
    const nextStart = clampTimelineStart(currentStart + deltaUs, currentSpan, durationUs);
    timelineStartUsRef.current = nextStart;
    onTimelineStartUsChange(nextStart);
  }

  function resizeTimeline(deltaPx: number, anchorRatio = 0.5) {
    if (!hasMedia || durationUs <= 0) {
      return;
    }
    const currentStart = timelineStartUsRef.current;
    const currentSpan = timelineSpanUsRef.current;
    const scale = Math.exp(clamp(deltaPx, -1200, 1200) * MONITOR_RANGE_ZOOM_SENSITIVITY);
    const nextSpan = clamp(currentSpan * scale, minTimelineSpanUs, durationUs);
    const anchorUs = currentStart + currentSpan * anchorRatio;
    const nextStart = clampTimelineStart(anchorUs - nextSpan * anchorRatio, nextSpan, durationUs);

    timelineSpanUsRef.current = nextSpan;
    timelineStartUsRef.current = nextStart;
    onTimelineSpanUsChange(nextSpan);
    onTimelineStartUsChange(nextStart);
  }

  function handleIndicatorWheel(event: WheelEvent) {
    if (!hasMedia) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const delta = wheelDeltaPx(event);
    if (event.altKey) {
      shiftTimeline(delta * timelineSpanUsRef.current * MONITOR_RANGE_SCROLL_SENSITIVITY);
      return;
    }
    resizeTimeline(delta);
  }

  function beginRangeDrag(): RangeDragUpdate | null {
    if (!hasMedia || durationUs <= 0) {
      return null;
    }
    const spanUs = timelineSpanUsRef.current;
    const startCenterRatio = rangeCenterRatioForStart(timelineStartUsRef.current, spanUs);
    return (deltaRatio: number) => {
      const nextStart = rangeStartForCenterRatio(startCenterRatio + deltaRatio, spanUs);
      timelineStartUsRef.current = nextStart;
      onTimelineStartUsChange(nextStart);
    };
  }

  function beginRangeHandleDrag(side: "start" | "end"): RangeHandleDragController | null {
    if (!hasMedia || durationUs <= 0) {
      return null;
    }
    setActiveRangeHandle("both");
    const startSpanUs = timelineSpanUsRef.current;
    const startRangeWidthRatio = rangeWidthRatioForSpan(startSpanUs);
    const centerUs = timelineStartUsRef.current + startSpanUs / 2;

    return {
      update: (deltaRatio: number) => {
        const nextRangeWidthRatio =
          side === "start"
            ? startRangeWidthRatio - deltaRatio * 2
            : startRangeWidthRatio + deltaRatio * 2;
        const nextSpanUs = clamp(
          spanForRangeWidthRatio(nextRangeWidthRatio),
          minTimelineSpanUs,
          durationUs,
        );
        timelineSpanUsRef.current = nextSpanUs;
        timelineStartUsRef.current = clampTimelineStart(
          centerUs - nextSpanUs / 2,
          nextSpanUs,
          durationUs,
        );
        onTimelineSpanUsChange(nextSpanUs);
        onTimelineStartUsChange(timelineStartUsRef.current);
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
