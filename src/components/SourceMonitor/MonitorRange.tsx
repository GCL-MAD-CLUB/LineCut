import { useEffect, useRef } from "react";
import type { CSSProperties, PointerEventHandler, RefObject } from "react";

type ActiveRangeHandle = "start" | "end" | "both" | null;
type RangeDragUpdate = (deltaRatio: number) => void;
type RangeHandleDragController = {
  update: (deltaRatio: number) => void;
  end: () => void;
};

interface MonitorRangeProps {
  rangeRef: RefObject<HTMLDivElement | null>;
  hasMedia: boolean;
  indicatorLeftPercent: number;
  indicatorWidthPercent: number;
  activeRangeHandle: ActiveRangeHandle;
  onWheel: (event: WheelEvent) => void;
  onRangeDragStart: () => RangeDragUpdate | null;
  onRangeHandleDragStart: (side: "start" | "end") => RangeHandleDragController | null;
}

export function MonitorRange({
  rangeRef,
  hasMedia,
  indicatorLeftPercent,
  indicatorWidthPercent,
  activeRangeHandle,
  onWheel,
  onRangeDragStart,
  onRangeHandleDragStart,
}: MonitorRangeProps) {
  const onWheelRef = useRef(onWheel);
  const rangeBarStyle = {
    "--monitor-range-left": `${indicatorLeftPercent}%`,
    "--monitor-range-width": `${indicatorWidthPercent}%`,
  } as CSSProperties;

  useEffect(() => {
    onWheelRef.current = onWheel;
  }, [onWheel]);

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
      onWheelRef.current(event);
    };

    range.addEventListener("wheel", handleWheel, { passive: false });
    return () => range.removeEventListener("wheel", handleWheel);
  }, [rangeRef]);

  const handleRangePointerDown: PointerEventHandler<HTMLDivElement> = (event) => {
    if (!hasMedia) {
      return;
    }
    event.preventDefault();
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    const updateRange = onRangeDragStart();
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
      const controller = onRangeHandleDragStart(side);
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
            className={`monitor-range-handle start ${activeRangeHandle === "start" || activeRangeHandle === "both" ? "active" : ""}`}
            disabled={!hasMedia}
            onPointerDown={hasMedia ? handleRangeHandlePointerDown("start") : undefined}
            aria-label="调整左边界"
          />
          <button
            type="button"
            className={`monitor-range-handle end ${activeRangeHandle === "end" || activeRangeHandle === "both" ? "active" : ""}`}
            disabled={!hasMedia}
            onPointerDown={hasMedia ? handleRangeHandlePointerDown("end") : undefined}
            aria-label="调整右边界"
          />
        </div>
      </div>
    </div>
  );
}
