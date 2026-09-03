import { useEffect, useMemo, useRef, useState } from "react";
import type { TimelineThumbnailBackfillRequest, TimelineThumbnailRequest } from "./manager";
import { timelineThumbnailResolutions, type TimelineThumbnailResolution } from "./resolution";

const defaultWindowDebounceMs = 120;
const spreadPriorityOffset = 100_000;
const backfillPriorityOffset = 1_000_000;

export interface TimelineThumbnailVisibleRange {
  startIndex: number;
  endIndex: number;
  centerIndex: number;
}

export interface TimelineThumbnailWindowPlan extends TimelineThumbnailVisibleRange {
  targetStartIndex: number;
  targetEndIndex: number;
  targetIndices: number[];
  spreadIndices: number[];
  backfillIndices: number[];
  signature: string;
}

interface TimelineThumbnailVirtualRow {
  index: number;
  start: number;
  end: number;
}

interface TimelineThumbnailWindowOptions<Item> {
  enabled: boolean;
  sourceKey: string;
  items: readonly Item[];
  getItemKey: (item: Item, index: number) => string;
  visibleRange: TimelineThumbnailVisibleRange;
  targetResolution: TimelineThumbnailResolution;
  requestThumbnail: (
    item: Item,
    index: number,
    resolution: TimelineThumbnailResolution,
    priority: number,
  ) => TimelineThumbnailRequest;
  backfillThumbnail: (
    item: Item,
    index: number,
    resolution: TimelineThumbnailResolution,
    priority: number,
  ) => TimelineThumbnailBackfillRequest;
  debounceMs?: number;
}

type TimelineThumbnailWindowRequest = TimelineThumbnailRequest | TimelineThumbnailBackfillRequest;

interface TimelineThumbnailWindowRequestRecord {
  request: TimelineThumbnailWindowRequest;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function centerOutIndices(startIndex: number, endIndex: number, centerIndex: number) {
  const indices: number[] = [];
  if (startIndex >= endIndex) {
    return indices;
  }
  const center = clamp(centerIndex, startIndex, endIndex - 1);
  indices.push(center);
  for (let distance = 1; indices.length < endIndex - startIndex; distance += 1) {
    const before = center - distance;
    const after = center + distance;
    if (before >= startIndex) {
      indices.push(before);
    }
    if (after < endIndex) {
      indices.push(after);
    }
  }
  return indices;
}

export function createTimelineThumbnailWindowPlan(
  itemCount: number,
  visibleRange: TimelineThumbnailVisibleRange,
): TimelineThumbnailWindowPlan {
  if (
    itemCount <= 0 ||
    visibleRange.startIndex < 0 ||
    visibleRange.endIndex < visibleRange.startIndex
  ) {
    return {
      startIndex: -1,
      endIndex: -1,
      centerIndex: -1,
      targetStartIndex: 0,
      targetEndIndex: 0,
      targetIndices: [],
      spreadIndices: [],
      backfillIndices: [],
      signature: `${itemCount}:empty`,
    };
  }

  const startIndex = clamp(visibleRange.startIndex, 0, itemCount - 1);
  const endIndex = clamp(visibleRange.endIndex, startIndex, itemCount - 1);
  const centerIndex = clamp(visibleRange.centerIndex, startIndex, endIndex);
  const visibleCount = endIndex - startIndex + 1;
  const targetSize = Math.min(itemCount, visibleCount + 2);
  const targetStartIndex = clamp(startIndex - 1, 0, itemCount - targetSize);
  const targetEndIndex = targetStartIndex + targetSize;
  const targetIndices = centerOutIndices(targetStartIndex, targetEndIndex, centerIndex);
  const spreadIndices: number[] = [];
  for (let distance = 1; distance <= targetSize; distance += 1) {
    const before = targetStartIndex - distance;
    const after = targetEndIndex - 1 + distance;
    if (before >= 0) {
      spreadIndices.push(before);
    }
    if (after < itemCount) {
      spreadIndices.push(after);
    }
  }

  return {
    startIndex,
    endIndex,
    centerIndex,
    targetStartIndex,
    targetEndIndex,
    targetIndices,
    spreadIndices,
    backfillIndices: [...targetIndices, ...spreadIndices],
    signature: [
      itemCount,
      startIndex,
      endIndex,
      centerIndex,
      targetStartIndex,
      targetEndIndex,
    ].join(":"),
  };
}

export function timelineThumbnailVisibleRange(
  rows: readonly TimelineThumbnailVirtualRow[],
  scrollOffset: number,
  viewportHeight: number,
): TimelineThumbnailVisibleRange {
  if (rows.length === 0) {
    return { startIndex: -1, endIndex: -1, centerIndex: -1 };
  }

  const viewportStart = Math.max(0, scrollOffset);
  const viewportEnd = viewportStart + Math.max(0, viewportHeight);
  const visibleRows = rows.filter((row) => row.end > viewportStart && row.start < viewportEnd);
  const candidates = visibleRows.length > 0 ? visibleRows : [rows[0]];
  const centerOffset = viewportStart + Math.max(0, viewportHeight) / 2;
  const centerIndex = candidates.reduce((best, row) => {
    const bestDistance = Math.abs((best.start + best.end) / 2 - centerOffset);
    const rowDistance = Math.abs((row.start + row.end) / 2 - centerOffset);
    return rowDistance < bestDistance ? row : best;
  }).index;

  return {
    startIndex: candidates[0].index,
    endIndex: candidates[candidates.length - 1].index,
    centerIndex,
  };
}

export function timelineThumbnailWindowContains(plan: TimelineThumbnailWindowPlan, index: number) {
  return index >= plan.targetStartIndex && index < plan.targetEndIndex;
}

export function useTimelineThumbnailWindow<Item>({
  enabled,
  sourceKey,
  items,
  getItemKey,
  visibleRange,
  targetResolution,
  requestThumbnail,
  backfillThumbnail,
  debounceMs = defaultWindowDebounceMs,
}: TimelineThumbnailWindowOptions<Item>) {
  const getItemKeyRef = useRef(getItemKey);
  const requestThumbnailRef = useRef(requestThumbnail);
  const backfillThumbnailRef = useRef(backfillThumbnail);
  const requestsRef = useRef(new Map<string, TimelineThumbnailWindowRequestRecord>());
  const sessionRef = useRef(0);
  getItemKeyRef.current = getItemKey;
  requestThumbnailRef.current = requestThumbnail;
  backfillThumbnailRef.current = backfillThumbnail;

  const rawPlan = useMemo(
    () => createTimelineThumbnailWindowPlan(items.length, visibleRange),
    [items.length, visibleRange.centerIndex, visibleRange.endIndex, visibleRange.startIndex],
  );
  const [debouncedPlan, setDebouncedPlan] = useState(rawPlan);

  useEffect(() => {
    if (rawPlan.signature === debouncedPlan.signature) {
      return;
    }
    if (debouncedPlan.targetIndices.length === 0 && rawPlan.targetIndices.length > 0) {
      setDebouncedPlan(rawPlan);
      return;
    }
    const timer = window.setTimeout(() => setDebouncedPlan(rawPlan), debounceMs);
    return () => window.clearTimeout(timer);
  }, [debounceMs, debouncedPlan.signature, rawPlan]);

  useEffect(() => {
    if (!enabled || !sourceKey) {
      sessionRef.current += 1;
      for (const record of requestsRef.current.values()) {
        record.request.cancel();
      }
      requestsRef.current.clear();
      return;
    }
    if (rawPlan.signature !== debouncedPlan.signature) {
      return;
    }

    const fullResolution = timelineThumbnailResolutions[timelineThumbnailResolutions.length - 1];
    const stages = [
      {
        indices: debouncedPlan.targetIndices,
        resolution: targetResolution,
        priorityOffset: 0,
        backfill: false,
      },
      {
        indices: debouncedPlan.spreadIndices,
        resolution: targetResolution,
        priorityOffset: spreadPriorityOffset,
        backfill: false,
      },
      ...(targetResolution.width < fullResolution.width
        ? [
            {
              indices: debouncedPlan.backfillIndices,
              resolution: targetResolution,
              priorityOffset: backfillPriorityOffset,
              backfill: true,
            },
          ]
        : []),
    ];
    const itemKey = getItemKeyRef.current;
    const requestTarget = requestThumbnailRef.current;
    const requestBackfill = backfillThumbnailRef.current;
    const requestKey = (
      item: Item,
      index: number,
      resolution: TimelineThumbnailResolution,
      backfill: boolean,
    ) =>
      `${sourceKey}\u0000${itemKey(item, index)}\u0000${resolution.width}\u0000${
        backfill ? "backfill" : "target"
      }`;
    const desiredPriorities = new Map<string, number>();
    for (const stage of stages) {
      stage.indices.forEach((index, order) => {
        const item = items[index];
        if (item !== undefined) {
          desiredPriorities.set(
            requestKey(item, index, stage.resolution, stage.backfill),
            stage.priorityOffset + order,
          );
        }
      });
    }

    // Build the complete next window before touching the old one, then retain
    // and reprioritize its exact image/resolution intersections in place.
    const session = ++sessionRef.current;
    for (const [key, record] of requestsRef.current) {
      const priority = desiredPriorities.get(key);
      if (priority === undefined) {
        record.request.cancel();
        requestsRef.current.delete(key);
      } else {
        record.request.reprioritize(priority);
      }
    }

    const ensureRequest = (
      item: Item,
      index: number,
      resolution: TimelineThumbnailResolution,
      priority: number,
      backfill: boolean,
    ) => {
      const key = requestKey(item, index, resolution, backfill);
      const existing = requestsRef.current.get(key);
      if (existing) {
        existing.request.reprioritize(priority);
        return existing.request;
      }
      const request = backfill
        ? requestBackfill(item, index, resolution, priority)
        : requestTarget(item, index, resolution, priority);
      requestsRef.current.set(key, { request });
      return request;
    };
    const runStage = async (
      indices: readonly number[],
      resolution: TimelineThumbnailResolution,
      priorityOffset: number,
      backfill: boolean,
    ) => {
      if (sessionRef.current !== session) {
        return false;
      }
      const stageRequests = indices.flatMap((index, order) => {
        const item = items[index];
        return item === undefined
          ? []
          : [ensureRequest(item, index, resolution, priorityOffset + order, backfill)];
      });
      await Promise.allSettled(stageRequests.map((request) => request.promise));
      return sessionRef.current === session;
    };

    void (async () => {
      for (const stage of stages) {
        if (
          !(await runStage(stage.indices, stage.resolution, stage.priorityOffset, stage.backfill))
        ) {
          return;
        }
      }
    })();
  }, [debouncedPlan, enabled, items, rawPlan.signature, sourceKey, targetResolution]);

  useEffect(
    () => () => {
      sessionRef.current += 1;
      for (const record of requestsRef.current.values()) {
        record.request.cancel();
      }
      requestsRef.current.clear();
    },
    [],
  );

  return debouncedPlan;
}
