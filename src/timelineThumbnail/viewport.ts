import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

const virtualListTrailingSpace = 8;

interface TimelineThumbnailListResizeAnchorOptions<Element extends HTMLElement> {
  enabled?: boolean;
  itemCount: number;
  itemHeight: number;
  measure: () => void;
  scrollRef: RefObject<Element | null>;
  scrollToOffset: (offset: number) => void;
}

/** Keeps the item under the viewport center fixed while fixed-height rows resize. */
export function useTimelineThumbnailListResizeAnchor<Element extends HTMLElement>({
  enabled = true,
  itemCount,
  itemHeight,
  measure,
  scrollRef,
  scrollToOffset,
}: TimelineThumbnailListResizeAnchorOptions<Element>) {
  const pendingCenterPositionRef = useRef<number | null>(null);

  const captureCenter = useCallback(() => {
    const scrollContainer = scrollRef.current;
    if (!enabled || !scrollContainer || itemCount === 0) {
      pendingCenterPositionRef.current = null;
      return;
    }

    const centerOffset = scrollContainer.scrollTop + scrollContainer.clientHeight / 2;
    pendingCenterPositionRef.current = Math.min(
      itemCount,
      Math.max(0, centerOffset / Math.max(1, itemHeight)),
    );
  }, [enabled, itemCount, itemHeight, scrollRef]);

  useLayoutEffect(() => {
    const centerPosition = pendingCenterPositionRef.current;
    const scrollContainer = scrollRef.current;
    if (centerPosition === null) {
      return;
    }
    if (!enabled || !scrollContainer || itemCount === 0) {
      pendingCenterPositionRef.current = null;
      return;
    }
    pendingCenterPositionRef.current = null;

    measure();
    const desiredScrollTop =
      centerPosition * Math.max(1, itemHeight) - scrollContainer.clientHeight / 2;
    const maximumScrollTop = Math.max(
      0,
      itemCount * Math.max(1, itemHeight) + virtualListTrailingSpace - scrollContainer.clientHeight,
    );
    scrollToOffset(Math.min(maximumScrollTop, Math.max(0, desiredScrollTop)));
  }, [enabled, itemCount, itemHeight, measure, scrollRef, scrollToOffset]);

  return captureCenter;
}
