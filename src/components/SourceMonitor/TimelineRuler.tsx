import { useEffect } from "react";
import type { PointerEventHandler, RefObject } from "react";
import type { TimelineRuler as TimelineRulerData } from "../../timeline";

interface TimelineRulerProps {
  timelineRef: RefObject<HTMLDivElement | null>;
  hasMedia: boolean;
  ruler: TimelineRulerData;
  cursorPercent: number | null;
  onWheel: (event: WheelEvent) => void;
  onSeekPointer: (clientX: number, element: HTMLDivElement) => void;
}

export function TimelineRuler({
  timelineRef,
  hasMedia,
  ruler,
  cursorPercent,
  onWheel,
  onSeekPointer,
}: TimelineRulerProps) {
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
    onSeekPointer(event.clientX, element);

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      onSeekPointer(moveEvent.clientX, element);
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

  return (
    <div
      ref={timelineRef}
      className={`monitor-timeline ${hasMedia ? "" : "empty-state"}`}
      onPointerDown={hasMedia ? handlePointerDown : undefined}
    >
      <div className="timeline-ruler">
        {hasMedia &&
          ruler.ticks.map((tick) => (
            <span
              key={tick.timeUs}
              className={tick.major ? "major" : undefined}
              data-frame={tick.frame}
              data-time-us={tick.timeUs}
              style={{ left: `${tick.leftPx}px` }}
            />
          ))}
        {hasMedia && cursorPercent !== null && (
          <span className="timeline-cursor" style={{ left: `${cursorPercent}%` }} />
        )}
      </div>
    </div>
  );
}
