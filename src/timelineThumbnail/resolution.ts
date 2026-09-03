import { useLayoutEffect, useState } from "react";

export const timelineThumbnailResolutions = [
  { width: 160, height: 90 },
  { width: 640, height: 360 },
  { width: 1280, height: 720 },
] as const;

export type TimelineThumbnailResolution = (typeof timelineThumbnailResolutions)[number];

export const baseTimelineThumbnailResolution = timelineThumbnailResolutions[0];

const resolutionChangeDelayMs = 150;

export function timelineThumbnailResolutionForDisplay(
  width: number,
  height: number,
  pixelRatio = window.devicePixelRatio || 1,
) {
  const requiredWidth = Math.max(width, (height * 16) / 9) * Math.max(1, pixelRatio);
  return (
    timelineThumbnailResolutions.find((resolution) => resolution.width >= requiredWidth) ??
    timelineThumbnailResolutions[timelineThumbnailResolutions.length - 1]
  );
}

export function useTimelineThumbnailResolution<Element extends HTMLElement>() {
  const [element, setElement] = useState<Element | null>(null);
  const [resolution, setResolution] = useState<TimelineThumbnailResolution | null>(null);

  useLayoutEffect(() => {
    if (!element) {
      return;
    }
    const committed = { width: resolution?.width ?? 0 };
    let firstMeasurement = true;
    let timer: number | null = null;

    const applyResolution = (next: TimelineThumbnailResolution) => {
      if (committed.width === next.width) {
        return;
      }
      committed.width = next.width;
      setResolution(next);
    };

    const scheduleResolution = (next: TimelineThumbnailResolution) => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (next.width === committed.width) {
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        applyResolution(next);
      }, resolutionChangeDelayMs);
    };

    const updateResolution = () => {
      const bounds = element.getBoundingClientRect();
      const next = timelineThumbnailResolutionForDisplay(bounds.width, bounds.height);
      if (firstMeasurement) {
        firstMeasurement = false;
        applyResolution(next);
        return;
      }
      if (next.width === committed.width && timer === null) {
        return;
      }
      scheduleResolution(next);
    };

    updateResolution();
    const observer = new ResizeObserver(updateResolution);
    observer.observe(element);
    window.addEventListener("resize", updateResolution);
    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      observer.disconnect();
      window.removeEventListener("resize", updateResolution);
    };
  }, [element]);

  return { resolution, thumbnailContainerRef: setElement };
}
