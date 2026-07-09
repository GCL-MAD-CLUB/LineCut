import { useEffect } from "react";
import type { PointerEventHandler, RefObject } from "react";
import type { TimelineRuler as TimelineRulerData } from "../../timeline";

const CURSOR_EDGE_INSET_PX = 6;

interface TimelineRulerProps {
  timelineRef: RefObject<HTMLDivElement | null>;
  hasMedia: boolean;
  ruler: TimelineRulerData;
  cursorPercent: number | null;
  cueRangePercent: { start: number; end: number } | null;
  onWheel: (event: WheelEvent) => void;
  onSeekPointer: (clientX: number, element: HTMLDivElement) => void;
}

export function TimelineRuler({
  timelineRef,
  hasMedia,
  ruler,
  cursorPercent,
  cueRangePercent,
  onWheel,
  onSeekPointer,
}: TimelineRulerProps) {
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

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      onWheel(event);
    };

    timeline.addEventListener("wheel", handleWheel, { passive: false });
    return () => timeline.removeEventListener("wheel", handleWheel);
  }, [onWheel, timelineRef]);

  const handlePointerDown: PointerEventHandler<HTMLDivElement> = (event) => {
    if (!hasMedia) {
      return;
    }
    event.preventDefault();
    const element = event.currentTarget;
    let latestClientX = event.clientX;
    let animationFrame: number | null = null;
    onSeekPointer(event.clientX, element);

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      latestClientX = moveEvent.clientX;
      onSeekPointer(moveEvent.clientX, element);
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
        onSeekPointer(latestClientX, element);
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
              left: `clamp(${CURSOR_EDGE_INSET_PX}px, ${cursorPercent}%, calc(100% - ${CURSOR_EDGE_INSET_PX}px))`,
            }}
          />
        )}
      </div>
    </div>
  );
}
