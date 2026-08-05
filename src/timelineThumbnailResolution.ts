import { useLayoutEffect, useState } from "react";

export const timelineThumbnailResolutions = [
  { width: 160, height: 90 },
  { width: 640, height: 360 },
  { width: 1280, height: 720 },
] as const;

export type TimelineThumbnailResolution = (typeof timelineThumbnailResolutions)[number];

export const baseTimelineThumbnailResolution = timelineThumbnailResolutions[0];

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
  const [resolution, setResolution] = useState<TimelineThumbnailResolution>(
    baseTimelineThumbnailResolution,
  );

  useLayoutEffect(() => {
    if (!element) {
      return;
    }
    const updateResolution = () => {
      const bounds = element.getBoundingClientRect();
      const next = timelineThumbnailResolutionForDisplay(bounds.width, bounds.height);
      setResolution((current) => (current.width === next.width ? current : next));
    };
    updateResolution();
    const observer = new ResizeObserver(updateResolution);
    observer.observe(element);
    window.addEventListener("resize", updateResolution);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateResolution);
    };
  }, [element]);

  return { resolution, thumbnailContainerRef: setElement };
}
