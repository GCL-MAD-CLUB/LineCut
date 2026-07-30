import { useVirtualizer } from "@tanstack/react-virtual";
import { convertFileSrc } from "@tauri-apps/api/core";
import { CheckCheck, Film, ListFilter, Loader2, Scissors, Search, Star, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
  type UIEvent as ReactUIEvent,
} from "react";
import { createPortal } from "react-dom";
import { invokeCommand } from "../../errors";
import { useEditCapability } from "../../runtime/capabilities/EditCapability";
import { usePlaybackStatus } from "../../runtime/capabilities/PlaybackCapability";
import { eventSource } from "../../runtime/events/EventHub";
import { publishEvent } from "../../runtime/events/react";
import { useStableIdentity } from "../../runtime/state/react";
import { usePanelActive, usePanelInstanceId } from "../../runtime/systems/PanelState";
import {
  cancelFfmpegTask,
  createFfmpegTaskId,
  listenToFfmpegTaskProgress,
} from "../../ffmpegProgress";
import { useProjectPort } from "../../systems/ProjectSystem";
import { createTaskProgress, useTaskProgressStatus } from "../../systems/TaskSystem";
import { requestStoryboardThumbnail } from "../../storyboardThumbnail";
import { isTauriRuntime } from "../../tauriRuntime";
import { formatDuration, formatMonitorFrame, formatMonitorTime } from "../../time";
import { frameToTimeUs, normalizeFrameRate } from "../../timeline";
import {
  timelineThumbnailResolutions,
  useTimelineThumbnailResolution,
} from "../../timelineThumbnailResolution";
import type { StoryboardDetectionResult, StoryboardShot } from "../../types";
import { usePanelManagerState } from "../DockLayout";
import { PopupMenu, PopupMenuItem, PopupMenuSeparator, PopupMenuSubmenu } from "../PopupMenu";
import { SelectDropdown, selectDropdownItems, type SelectDropdownItem } from "../SelectDropdown";
import "./StoryboardPanel.css";
import {
  useStoryboardPanelState,
  type StoryboardRatingComparator,
  type StoryboardShotAnnotation,
  type StoryboardShotColorLabel,
  type StoryboardShotColorLabelFilter,
  type StoryboardShotFilter,
  type StoryboardShotFlag,
  type StoryboardShotStack,
} from "./storyboardPanelState";

const storyboardEventSource = eventSource("storyboard-panel");
const MIN_UPCOMING_SCROLL_DURATION_MS = 1000;
const MAX_UPCOMING_SCROLL_DURATION_MS = 1200;
const THUMBNAIL_PREFETCH_ROWS_BEFORE = 10;
const THUMBNAIL_PREFETCH_ROWS_AFTER = 28;
const TABLE_SCROLLBAR_SPACER_PX = 8;
const STORYBOARD_THUMBNAIL_HEIGHT = 46;
const STORYBOARD_THUMBNAIL_WIDTH = 82;
const STORYBOARD_ROW_VERTICAL_PADDING = 36;
const STORYBOARD_THUMBNAIL_COLUMN_PADDING = 16;
const STORYBOARD_STATUS_GUTTER_WIDTH = 16;
const TITLE_RENAME_DELAY_MS = 350;

type StoryboardResizableColumnId =
  "thumbnail" | "title" | "mediaStart" | "mediaEnd" | "duration" | "rating" | "retained";
type StoryboardSortableColumnId =
  "title" | "mediaStart" | "mediaEnd" | "duration" | "rating" | "retained";
type StoryboardTableColumnId = StoryboardResizableColumnId | "trailing";
type StoryboardSortDirection = "ascending" | "descending";

interface StoryboardSort {
  columnId: StoryboardSortableColumnId;
  direction: StoryboardSortDirection;
}

const defaultStoryboardSort: StoryboardSort = {
  columnId: "title",
  direction: "ascending",
};

const storyboardTableHeaders: Array<{
  id: StoryboardTableColumnId;
  label: string;
  sortColumnId?: StoryboardSortableColumnId;
  resizeColumn?: StoryboardResizableColumnId;
}> = [
  { id: "thumbnail", label: "" },
  { id: "title", label: "标题", sortColumnId: "title" },
  { id: "mediaStart", label: "媒体开始", sortColumnId: "mediaStart", resizeColumn: "title" },
  { id: "mediaEnd", label: "媒体结束", sortColumnId: "mediaEnd", resizeColumn: "mediaStart" },
  {
    id: "duration",
    label: "媒体持续时间",
    sortColumnId: "duration",
    resizeColumn: "mediaEnd",
  },
  { id: "rating", label: "星级", sortColumnId: "rating", resizeColumn: "duration" },
  { id: "retained", label: "留用", resizeColumn: "rating" },
  { id: "trailing", label: "", resizeColumn: "retained" },
];

type StoryboardResizableColumnWidths = Record<StoryboardResizableColumnId, number>;

const initialStoryboardColumnWidths: StoryboardResizableColumnWidths = {
  thumbnail: 104,
  title: 128,
  mediaStart: 128,
  mediaEnd: 128,
  duration: 140,
  rating: 112,
  retained: 128,
};

const minimumStoryboardColumnWidths: StoryboardResizableColumnWidths = {
  thumbnail: 60,
  title: 38,
  mediaStart: 21,
  mediaEnd: 21,
  duration: 21,
  rating: 30,
  retained: 21,
};

const maximumStoryboardColumnWidths: StoryboardResizableColumnWidths = {
  thumbnail: 720,
  title: 720,
  mediaStart: 300,
  mediaEnd: 300,
  duration: 320,
  rating: 180,
  retained: 300,
};

const storyboardResizableColumnLabels: Record<StoryboardResizableColumnId, string> = {
  thumbnail: "缩略图",
  title: "标题",
  mediaStart: "媒体开始",
  mediaEnd: "媒体结束",
  duration: "媒体持续时间",
  rating: "星级",
  retained: "留用",
};

const storyboardRatingFilters = [1, 2, 3, 4, 5] as const;
const storyboardRatingComparatorOptions: Array<readonly [StoryboardRatingComparator, string]> = [
  ["gte", "星级大于等于"],
  ["lte", "星级小于等于"],
  ["eq", "星级等于"],
];
const storyboardRatingComparatorItems = selectDropdownItems(storyboardRatingComparatorOptions);
const storyboardRatingComparatorSymbols: Record<StoryboardRatingComparator, string> = {
  gte: "≥",
  lte: "≤",
  eq: "=",
};
const storyboardRatingComparatorLabels: Record<StoryboardRatingComparator, string> = {
  gte: "星级大于等于",
  lte: "星级小于等于",
  eq: "星级等于",
};
const storyboardShotFlags: StoryboardShotFlag[] = ["retained", "none", "excluded"];
const storyboardShotFlagLabels: Record<StoryboardShotFlag, string> = {
  retained: "留用旗标",
  none: "无旗标",
  excluded: "排除旗标",
};
const storyboardShotColorLabels: Array<readonly [StoryboardShotColorLabel, string]> = [
  ["red", "红色"],
  ["yellow", "黄色"],
  ["green", "绿色"],
  ["blue", "蓝色"],
  ["purple", "紫色"],
];
const storyboardShotColorLabelValues: Record<StoryboardShotColorLabel, string> = {
  red: "#ef4444",
  yellow: "#eab308",
  green: "#22c55e",
  blue: "#3b82f6",
  purple: "#a855f7",
};
const storyboardShotColorFilterLabels: Array<readonly [StoryboardShotColorLabelFilter, string]> = [
  ...storyboardShotColorLabels,
  ["none", "无"],
];
const storyboardShotColorFilterValues: Record<StoryboardShotColorLabelFilter, string> = {
  ...storyboardShotColorLabelValues,
  none: "#7f7f7f",
};
const storyboardFilterOptions: Array<readonly [StoryboardShotFilter, string]> = [
  ["all", "关闭过滤器"],
  ["retained", "留用"],
  ["rated", "有星级"],
  ["unrated", "无星级"],
];
const storyboardFilterItems = selectDropdownItems(storyboardFilterOptions);
const storyboardCustomFilterItems: Array<SelectDropdownItem<StoryboardShotFilter>> = [
  { type: "option", value: "custom", label: "自定义过滤" },
  { type: "separator" },
  ...storyboardFilterItems,
];
const storyboardTitleCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

interface ActiveStoryboardCell {
  shotId: string;
  columnId: StoryboardResizableColumnId;
}

interface StoryboardMarqueeSelection {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface StoryboardContextMenuState {
  x: number;
  y: number;
  shotId: string | null;
  flagSubmenuOpen: boolean;
  ratingSubmenuOpen: boolean;
  colorSubmenuOpen: boolean;
  stackSubmenuOpen: boolean;
}

interface StoryboardAnnotationMenuState {
  kind: "flag" | "color";
  x: number;
  y: number;
  shotId: string;
}

const MARQUEE_DRAG_THRESHOLD = 4;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return (
    element?.tagName === "INPUT" ||
    element?.tagName === "TEXTAREA" ||
    element?.tagName === "SELECT" ||
    Boolean(element?.isContentEditable)
  );
}

function defaultShotTitle(shot: StoryboardShot, shotCount: number) {
  const digits = Math.max(1, String(Math.max(1, shotCount)).length);
  return `分镜 ${String(shot.sequence).padStart(digits, "0")}`;
}

function storyboardShotTitle(
  shot: StoryboardShot,
  shotCount: number,
  annotation: StoryboardShotAnnotation | undefined,
) {
  return annotation?.title || defaultShotTitle(shot, shotCount);
}

function storyboardShotFlag(annotation: StoryboardShotAnnotation | undefined): StoryboardShotFlag {
  if (annotation?.retained) {
    return "retained";
  }
  if (annotation?.excluded) {
    return "excluded";
  }
  return "none";
}

function shotMatches(title: string, query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) {
    return true;
  }
  const haystack = title.toLocaleLowerCase();
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function shotMatchesFilter(
  annotation: StoryboardShotAnnotation | undefined,
  filter: StoryboardShotFilter,
  minimumRating: number,
  ratingComparator: StoryboardRatingComparator,
  flagFilters: readonly StoryboardShotFlag[],
  colorLabelFilters: readonly StoryboardShotColorLabelFilter[],
) {
  const rating = annotation?.rating ?? 0;
  const flag = storyboardShotFlag(annotation);
  const colorLabel = annotation?.colorLabel ?? "none";
  const matchesRating =
    minimumRating === 0 ||
    (ratingComparator === "gte"
      ? rating >= minimumRating
      : ratingComparator === "lte"
        ? rating <= minimumRating
        : rating === minimumRating);

  const matchesColorLabel =
    colorLabelFilters.length === 0 || colorLabelFilters.includes(colorLabel);
  const matchesBaseFilter =
    filter === "all"
      ? matchesRating
      : filter === "retained"
        ? flagFilters.includes(flag) && matchesRating
        : filter === "rated"
          ? minimumRating > 0
            ? matchesRating
            : rating > 0
          : filter === "unrated"
            ? rating === 0
            : flagFilters.includes(flag) && matchesRating;
  return matchesBaseFilter && matchesColorLabel;
}

function stackByShotId(shotStacks: readonly StoryboardShotStack[]) {
  const result = new Map<string, StoryboardShotStack>();
  for (const stack of shotStacks) {
    for (const shotId of stack.shotIds) {
      result.set(shotId, stack);
    }
  }
  return result;
}

function mergedStackShot(
  stack: StoryboardShotStack,
  shotsById: ReadonlyMap<string, StoryboardShot>,
) {
  const firstShot = shotsById.get(stack.shotIds[0]);
  const lastShot = shotsById.get(stack.shotIds.at(-1) ?? "");
  if (!firstShot || !lastShot) {
    return null;
  }
  return {
    ...firstShot,
    end_frame: lastShot.end_frame,
    end_us: lastShot.end_us,
  };
}

function visibleStoryboardShots(
  shots: readonly StoryboardShot[],
  shotStacks: readonly StoryboardShotStack[],
) {
  const shotsById = new Map(shots.map((shot) => [shot.id, shot]));
  const stacksByShotId = stackByShotId(shotStacks);
  const result: StoryboardShot[] = [];
  for (const shot of shots) {
    const stack = stacksByShotId.get(shot.id);
    if (!stack || stack.expanded) {
      result.push(shot);
      continue;
    }
    if (shot.id !== stack.shotIds[0]) {
      continue;
    }
    result.push(mergedStackShot(stack, shotsById) ?? shot);
  }
  return result;
}

function stackSortShotsByShotId(
  shots: readonly StoryboardShot[],
  shotStacks: readonly StoryboardShotStack[],
) {
  const shotsById = new Map(shots.map((shot) => [shot.id, shot]));
  const result = new Map<string, StoryboardShot>();
  for (const stack of shotStacks) {
    const mergedShot = mergedStackShot(stack, shotsById);
    if (!mergedShot) {
      continue;
    }
    for (const shotId of stack.shotIds) {
      result.set(shotId, mergedShot);
    }
  }
  return result;
}

function adjacentShotIds(shotIds: Iterable<string>, shots: readonly StoryboardShot[]) {
  const selectedShotIds = new Set(shotIds);
  const orderedIndices = shots
    .map((shot, index) => ({ shot, index }))
    .filter(({ shot }) => selectedShotIds.has(shot.id));
  if (
    orderedIndices.length < 2 ||
    orderedIndices.length !== selectedShotIds.size ||
    orderedIndices.some(
      ({ index }, selectedIndex) =>
        selectedIndex > 0 && index !== orderedIndices[selectedIndex - 1].index + 1,
    )
  ) {
    return null;
  }
  return orderedIndices.map(({ shot }) => shot.id);
}

function stackCompositionShotIds(
  selectedShotIds: Iterable<string>,
  shots: readonly StoryboardShot[],
  stacksByShotId: ReadonlyMap<string, StoryboardShotStack>,
) {
  const sourceUnits = new Set<string>();
  const flattenedShotIds = new Set<string>();
  for (const shotId of selectedShotIds) {
    const stack = stacksByShotId.get(shotId);
    if (stack) {
      sourceUnits.add(`stack:${stack.id}`);
      for (const stackShotId of stack.shotIds) {
        flattenedShotIds.add(stackShotId);
      }
    } else {
      sourceUnits.add(`shot:${shotId}`);
      flattenedShotIds.add(shotId);
    }
  }
  if (sourceUnits.size < 2) {
    return null;
  }
  return adjacentShotIds(flattenedShotIds, shots);
}

function annotationShotIdsForSelection(
  selectedShotIds: Iterable<string>,
  stacksByShotId: ReadonlyMap<string, StoryboardShotStack>,
) {
  const targetShotIds = new Set<string>();
  for (const shotId of selectedShotIds) {
    const stack = stacksByShotId.get(shotId);
    if (stack && !stack.expanded) {
      for (const stackShotId of stack.shotIds) {
        targetShotIds.add(stackShotId);
      }
    } else {
      targetShotIds.add(shotId);
    }
  }
  return targetShotIds;
}

function seekToShot(shot: StoryboardShot, focusRange = false) {
  void publishEvent(
    "playback.seek.requested",
    {
      timeUs: shot.start_us,
      focusEndUs: focusRange ? shot.end_us : undefined,
      play: focusRange,
    },
    storyboardEventSource,
  );
}

function shotIndexAtFrame(shots: StoryboardShot[], currentFrame: number) {
  let low = 0;
  let high = shots.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const shot = shots[middle];
    if (currentFrame < shot.start_frame) {
      high = middle - 1;
    } else if (currentFrame > shot.end_frame) {
      low = middle + 1;
    } else {
      return middle;
    }
  }
  return -1;
}

function nextShotIndexAfterFrame(shots: StoryboardShot[], currentFrame: number) {
  let low = 0;
  let high = shots.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (shots[middle].start_frame <= currentFrame) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low > 0 && low < shots.length ? low : -1;
}

function nextShotIndexAfterCurrentShot(
  shots: StoryboardShot[],
  currentShotIndex: number,
  currentFrame: number,
) {
  for (let index = currentShotIndex + 1; index < shots.length; index += 1) {
    if (shots[index].end_frame >= currentFrame) {
      return index;
    }
  }
  return -1;
}

function easeInOutCubic(progress: number) {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

function closestShotIndexToViewportCenter(
  rows: readonly { index: number; start: number; end: number }[],
  scrollOffset: number,
  viewportHeight: number,
) {
  if (rows.length === 0) {
    return 0;
  }
  const centerOffset = scrollOffset + Math.max(0, viewportHeight) / 2;
  return rows.reduce((best, row) => {
    const bestDistance = Math.abs((best.start + best.end) / 2 - centerOffset);
    const rowDistance = Math.abs((row.start + row.end) / 2 - centerOffset);
    return rowDistance < bestDistance ? row : best;
  }).index;
}

function SortArrow({ direction }: { direction: StoryboardSortDirection }) {
  const isAscending = direction === "ascending";
  return (
    <svg className="storyboard-sort-arrow" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d={
          isAscending
            ? "M8 14 L8 2.5 M5 5.5 L8 2.5 L11 5.5"
            : "M8 2 L8 13.5 M5 10.5 L8 13.5 L11 10.5"
        }
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.75"
      />
    </svg>
  );
}

interface StoryboardStackBadgeProps {
  stack: StoryboardShotStack;
  shotIndex: number;
  onToggle: () => void;
}

function StoryboardStackBadge({ stack, shotIndex, onToggle }: StoryboardStackBadgeProps) {
  const count = stack.shotIds.length;
  const position = shotIndex + 1;
  const isFirst = shotIndex === 0;
  const className = [
    "storyboard-stack-badge",
    stack.expanded ? "is-expanded" : "is-collapsed",
    isFirst ? "is-first" : "",
    count > 2 ? "has-third-layer" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (stack.expanded && !isFirst) {
    return (
      <span className={className} aria-hidden="true">
        <span className="storyboard-stack-badge-face">
          {position}/{count}
        </span>
      </span>
    );
  }

  return (
    <span className={className}>
      <span className="storyboard-stack-badge-face">
        <span className="storyboard-stack-badge-count">{count}</span>
        {stack.expanded && (
          <span className="storyboard-stack-badge-position">
            {position}/{count}
          </span>
        )}
        <button
          type="button"
          className="storyboard-stack-badge-toggle"
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          aria-label={
            stack.expanded ? `折叠包含 ${count} 个分镜的堆叠` : `展开包含 ${count} 个分镜的堆叠`
          }
        />
      </span>
    </span>
  );
}

function StoryboardFlagIcon({ flag }: { flag: StoryboardShotFlag }) {
  if (flag === "retained") {
    return (
      <svg
        className="storyboard-flag-icon is-retained"
        viewBox="12 5 39 43"
        width="78"
        height="86"
        fill="none"
        aria-hidden="true"
      >
        <g className="storyboard-flag-strokes" strokeWidth="2">
          <path d="M 36 9 L 47.5 20.5 L 31.5 36.5" strokeLinejoin="miter" />
          <path d="M 31.5 36.5 L 40 45" />
          <path d="M 36 9 L 25.46 19.49" strokeLinecap="round" />
          <path d="M 23.34 28.35 L 31.5 36.5" strokeLinecap="round" />
          <path
            d="M 15.40 24.49 L 17.99 27.03 L 22.55 22.42"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        <path
          className="storyboard-flag-fill"
          d="M 36 11.875 L 45.125 21 L 32 34.125 L 22.875 25 Z"
        />
      </svg>
    );
  }

  if (flag === "none") {
    return (
      <svg
        className="storyboard-flag-icon is-none"
        viewBox="57 5 33 43"
        width="66"
        height="86"
        fill="none"
        aria-hidden="true"
      >
        <g
          className="storyboard-flag-strokes"
          strokeWidth="2"
          strokeDasharray="2.2 3.457"
          strokeDashoffset="1.1"
        >
          <path d="M 59.5 24.5 L 75.5 8.5 L 87.5 20.5 L 71.5 36.5 Z" />
          <path d="M 71.5 36.5 L 80.6 45.6" />
        </g>
      </svg>
    );
  }

  return (
    <svg
      className="storyboard-flag-icon is-excluded"
      viewBox="94 5 36 43"
      width="72"
      height="86"
      fill="none"
      aria-hidden="true"
    >
      <g className="storyboard-flag-strokes" strokeWidth="2">
        <path d="M 96.79 21.81 L 103.21 28.19 M 103.21 21.81 L 96.79 28.19" />
        <path d="M 116 9 L 127.5 20.5 L 111.5 36.5" strokeLinejoin="miter" />
        <path d="M 111.5 36.5 L 120 45" />
        <path d="M 116 9 L 105.44 19.54" strokeLinecap="round" />
        <path d="M 105.24 30.19 L 111.5 36.5" strokeLinecap="round" />
      </g>
    </svg>
  );
}

interface StoryboardFlagMenuItemsProps {
  checkedFlag: StoryboardShotFlag | null;
  onSelect: (flag: StoryboardShotFlag) => void;
}

function StoryboardFlagMenuItems({ checkedFlag, onSelect }: StoryboardFlagMenuItemsProps) {
  return (
    <>
      <PopupMenuItem
        checked={checkedFlag === "retained"}
        mnemonic="F"
        onSelect={() => onSelect("retained")}
      >
        留用(F)
      </PopupMenuItem>
      <PopupMenuItem
        checked={checkedFlag === "none"}
        mnemonic="U"
        onSelect={() => onSelect("none")}
      >
        无旗标(U)
      </PopupMenuItem>
      <PopupMenuItem
        checked={checkedFlag === "excluded"}
        mnemonic="R"
        onSelect={() => onSelect("excluded")}
      >
        排除(R)
      </PopupMenuItem>
    </>
  );
}

interface StoryboardColorMenuItemsProps {
  checkedColorLabel: StoryboardShotColorLabel | null | undefined;
  onSelect: (colorLabel: StoryboardShotColorLabel | null) => void;
}

function StoryboardColorMenuItems({ checkedColorLabel, onSelect }: StoryboardColorMenuItemsProps) {
  return (
    <>
      {storyboardShotColorLabels.map(([colorLabel, label]) => (
        <PopupMenuItem
          key={colorLabel}
          checked={checkedColorLabel === colorLabel}
          onSelect={() => onSelect(colorLabel)}
        >
          {label}
        </PopupMenuItem>
      ))}
      <PopupMenuSeparator />
      <PopupMenuItem checked={checkedColorLabel === null} onSelect={() => onSelect(null)}>
        无
      </PopupMenuItem>
    </>
  );
}

function storyboardShotSortValue(
  shot: StoryboardShot,
  columnId: StoryboardSortableColumnId,
  shotAnnotations: Record<string, StoryboardShotAnnotation>,
  shotCount: number,
) {
  const annotation = shotAnnotations[shot.id];
  if (columnId === "title") {
    return storyboardShotTitle(shot, shotCount, annotation);
  }
  if (columnId === "mediaStart") {
    return shot.start_us;
  }
  if (columnId === "mediaEnd") {
    return shot.end_us;
  }
  if (columnId === "duration") {
    return Math.max(0, shot.end_frame - shot.start_frame + 1);
  }
  if (columnId === "rating") {
    return annotation?.rating ?? 0;
  }
  const flag = storyboardShotFlag(annotation);
  return flag === "retained" ? 1 : flag === "excluded" ? -1 : 0;
}

function sortStoryboardShots(
  shots: readonly StoryboardShot[],
  sort: StoryboardSort,
  shotAnnotations: Record<string, StoryboardShotAnnotation>,
  shotCount: number,
  sortShotsById: ReadonlyMap<string, StoryboardShot>,
) {
  const direction = sort.direction === "ascending" ? 1 : -1;
  const compareSortValues = (left: string | number, right: string | number) => {
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    if (typeof left === "number") {
      return -1;
    }
    if (typeof right === "number") {
      return 1;
    }
    return storyboardTitleCollator.compare(left, right);
  };
  return shots
    .map((shot, index) => ({ shot, index }))
    .sort((left, right) => {
      const leftSortShot = sortShotsById.get(left.shot.id) ?? left.shot;
      const rightSortShot = sortShotsById.get(right.shot.id) ?? right.shot;
      const valueDelta = compareSortValues(
        storyboardShotSortValue(leftSortShot, sort.columnId, shotAnnotations, shotCount),
        storyboardShotSortValue(rightSortShot, sort.columnId, shotAnnotations, shotCount),
      );
      return (
        valueDelta * direction ||
        left.shot.sequence - right.shot.sequence ||
        left.index - right.index
      );
    })
    .map(({ shot }) => shot);
}

interface ShotFrameButtonProps {
  shot: StoryboardShot;
  assetId: string;
  fingerprint: string;
  videoPath: string;
  previewVideoPath: string;
  frameRate: number;
  priority: number;
  onSelect: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

function ShotFrameButton({
  shot,
  assetId,
  fingerprint,
  videoPath,
  previewVideoPath,
  frameRate,
  priority,
  onSelect,
}: ShotFrameButtonProps) {
  const { resolution, thumbnailContainerRef } = useTimelineThumbnailResolution<HTMLButtonElement>();
  const thumbnailIdentity = `${fingerprint}:${videoPath}:${shot.start_us}`;
  const [thumbnail, setThumbnail] = useState<{
    identity: string;
    src: string;
    width: number;
    height: number;
  } | null>(null);
  const [hoverProgress, setHoverProgress] = useState<number | null>(null);
  const [hoverFrameReady, setHoverFrameReady] = useState(false);
  const hoverVideoRef = useRef<HTMLVideoElement | null>(null);
  const hoverTargetTimeUs = useMemo(() => {
    if (hoverProgress === null) {
      return null;
    }
    const endTimeUs = Math.max(shot.start_us, frameToTimeUs(shot.end_frame, frameRate));
    return Math.round(shot.start_us + (endTimeUs - shot.start_us) * clamp(hoverProgress, 0, 1));
  }, [frameRate, hoverProgress, shot.end_frame, shot.start_us]);
  const previewSrc = isTauriRuntime() ? convertFileSrc(previewVideoPath) : previewVideoPath;

  useEffect(() => {
    let active = true;
    const requestedResolutions = timelineThumbnailResolutions.filter(
      (candidate) => candidate.width <= resolution.width,
    );
    const requests = requestedResolutions.map((candidate) => {
      const request = requestStoryboardThumbnail({
        assetId,
        fingerprint,
        videoPath,
        timeUs: shot.start_us,
        priority,
        resolution: candidate,
      });
      void request.promise.then(
        (src) => {
          if (!active) {
            return;
          }
          setThumbnail((current) => {
            if (
              current?.identity === thumbnailIdentity &&
              current.width > candidate.width &&
              current.width <= resolution.width
            ) {
              return current;
            }
            return {
              identity: thumbnailIdentity,
              src,
              width: candidate.width,
              height: candidate.height,
            };
          });
        },
        () => undefined,
      );
      return request;
    });
    return () => {
      active = false;
      for (const request of requests) {
        request.cancel();
      }
    };
  }, [
    assetId,
    fingerprint,
    priority,
    resolution.width,
    shot.start_us,
    thumbnailIdentity,
    videoPath,
  ]);

  useEffect(() => {
    if (hoverTargetTimeUs === null) {
      setHoverFrameReady(false);
      return;
    }
    const video = hoverVideoRef.current;
    if (video && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      seekHoverVideo(video);
    }
  }, [hoverTargetTimeUs]);

  function seekHoverVideo(video: HTMLVideoElement) {
    if (hoverTargetTimeUs === null) {
      return;
    }
    const targetSeconds = hoverTargetTimeUs / 1_000_000;
    const latestTime = Number.isFinite(video.duration)
      ? Math.max(0, video.duration - 0.001)
      : targetSeconds;
    const clampedTime = Math.min(targetSeconds, latestTime);
    if (Math.abs(video.currentTime - clampedTime) > 0.001) {
      video.currentTime = clampedTime;
    } else if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      setHoverFrameReady(true);
    }
  }

  function updateHoverPreview(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.buttons !== 0) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const progress = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    setHoverProgress((current) => (current === progress ? current : progress));
  }

  function currentVideo(event: SyntheticEvent<HTMLVideoElement>) {
    return event.currentTarget;
  }

  const visibleThumbnail = thumbnail?.identity === thumbnailIdentity ? thumbnail : null;

  return (
    <button
      ref={thumbnailContainerRef}
      type="button"
      className="shot-frame-button"
      onClick={onSelect}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerMove={updateHoverPreview}
      onPointerLeave={() => setHoverProgress(null)}
      aria-label={`从 ${formatDuration(shot.start_us)} 播放此镜头`}
    >
      {visibleThumbnail && (
        <img
          className="shot-frame"
          src={visibleThumbnail.src}
          alt=""
          width={visibleThumbnail.width}
          height={visibleThumbnail.height}
          decoding="async"
          draggable={false}
        />
      )}
      {hoverTargetTimeUs !== null && (
        <video
          ref={hoverVideoRef}
          className={`shot-frame shot-hover-frame ${hoverFrameReady ? "is-ready" : ""}`}
          src={previewSrc}
          muted
          playsInline
          preload="auto"
          aria-hidden="true"
          draggable={false}
          onLoadedMetadata={(event) => seekHoverVideo(currentVideo(event))}
          onLoadedData={(event) => seekHoverVideo(currentVideo(event))}
          onSeeked={() => setHoverFrameReady(true)}
        />
      )}
      {hoverProgress !== null && (
        <span className="shot-hover-progress" aria-hidden="true">
          <span style={{ width: `${hoverProgress * 100}%` }} />
        </span>
      )}
      <Film className="shot-frame-placeholder" aria-hidden="true" />
    </button>
  );
}

export function StoryboardPanel() {
  const panelInstanceId = usePanelInstanceId();
  const panelActive = usePanelActive();
  const focusedPanelId = usePanelManagerState((state) => state.focusedPanelId);
  const identity = useStableIdentity("storyboard-panel", panelInstanceId);
  const { project, activeVideoId } = useProjectPort(["project", "activeVideoId"], []);
  const {
    query,
    showOnlySelected,
    shotFilter,
    minimumRating,
    ratingComparator,
    flagFilters,
    colorLabelFilters,
    activeShotId,
    shots,
    shotStacks,
    selectedShotIds,
    shotAnnotations,
    detectingVideoContext,
    thumbnailSize,
    syncVideoContext,
    setQuery,
    setShowOnlySelected,
    setShotFilter,
    setMinimumRating,
    setRatingComparator,
    setFlagFilters,
    setColorLabelFilters,
    setThumbnailSize,
    setShotTitle,
    setShotRatings,
    adjustShotRatings,
    setShotFlags,
    setShotColorLabels,
    createShotStack,
    cancelShotStack,
    removeShotFromStack,
    splitShotStack,
    setShotStackExpanded,
    setAllShotStacksExpanded,
    detectionStarted,
    detectionCompleted,
    detectionFinished,
    shotSelectionCleared,
    shotSelectionReplaced,
  } = useStoryboardPanelState((state) => state);
  const { isRunning: isDetecting } = useTaskProgressStatus("storyboard.detect");
  const playback = usePlaybackStatus();
  const panelRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const tableHeaderRef = useRef<HTMLDivElement | null>(null);
  const scrollAnimationRef = useRef<number | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const selectionFocusRef = useRef<string | null>(null);
  const pendingTitleRenameRef = useRef<number | null>(null);
  const marqueeCleanupRef = useRef<(() => void) | null>(null);
  const hadShotsRef = useRef(shots.length > 0);
  const [shotSort, setShotSort] = useState<StoryboardSort>(defaultStoryboardSort);
  const [activeCell, setActiveCell] = useState<ActiveStoryboardCell | null>(null);
  const [editingShotId, setEditingShotId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [marqueeSelection, setMarqueeSelection] = useState<StoryboardMarqueeSelection | null>(null);
  const [contextMenu, setContextMenu] = useState<StoryboardContextMenuState | null>(null);
  const [annotationMenu, setAnnotationMenu] = useState<StoryboardAnnotationMenuState | null>(null);
  const [storyboardColumnWidths, setStoryboardColumnWidths] = useState(
    initialStoryboardColumnWidths,
  );
  const columnResizeRef = useRef<{
    columnId: StoryboardResizableColumnId;
    startX: number;
    startWidth: number;
    pointerId: number;
  } | null>(null);
  const videoContext = `${activeVideoId}:${project?.asset.id ?? ""}:${project?.asset.fingerprint ?? ""}`;
  const hasVideo = Boolean(
    project?.asset.video_stream_index !== null && project?.asset.video_stream_index !== undefined,
  );
  const videoLabel = project?.asset.file_name ?? "未选择视频";
  const canDetect = isTauriRuntime() && Boolean(project) && hasVideo && !isDetecting;
  const selectedCount = selectedShotIds.size;
  const shotCount = shots.length;
  const shotStacksByShotId = useMemo(() => stackByShotId(shotStacks), [shotStacks]);
  const sortShotsById = useMemo(
    () => stackSortShotsByShotId(shots, shotStacks),
    [shotStacks, shots],
  );
  const displayShots = useMemo(
    () => visibleStoryboardShots(shots, shotStacks),
    [shotStacks, shots],
  );
  const filteredShots = useMemo(
    () =>
      displayShots.filter(
        (shot) =>
          (!showOnlySelected || selectedShotIds.has(shot.id)) &&
          shotMatches(storyboardShotTitle(shot, shotCount, shotAnnotations[shot.id]), query) &&
          shotMatchesFilter(
            shotAnnotations[shot.id],
            shotFilter,
            minimumRating,
            ratingComparator,
            flagFilters,
            colorLabelFilters,
          ),
      ),
    [
      displayShots,
      colorLabelFilters,
      flagFilters,
      minimumRating,
      query,
      ratingComparator,
      selectedShotIds,
      shotCount,
      shotAnnotations,
      shotFilter,
      showOnlySelected,
    ],
  );
  const sortedShots = useMemo(
    () => sortStoryboardShots(filteredShots, shotSort, shotAnnotations, shotCount, sortShotsById),
    [filteredShots, shotAnnotations, shotCount, shotSort, sortShotsById],
  );
  const currentFrame = playback?.currentFrame ?? 0;
  const isPlaying = playback?.isPlaying ?? false;
  const currentFrameRef = useRef(currentFrame);
  currentFrameRef.current = currentFrame;
  const chronologicalCurrentShotIndex = useMemo(
    () => shotIndexAtFrame(filteredShots, currentFrame),
    [currentFrame, filteredShots],
  );
  const chronologicalUpcomingShotIndex = useMemo(
    () => nextShotIndexAfterFrame(filteredShots, currentFrame),
    [currentFrame, filteredShots],
  );
  const nextChronologicalShotAfterCurrentIndex = useMemo(
    () =>
      chronologicalCurrentShotIndex >= 0
        ? nextShotIndexAfterCurrentShot(filteredShots, chronologicalCurrentShotIndex, currentFrame)
        : -1,
    [chronologicalCurrentShotIndex, currentFrame, filteredShots],
  );
  const currentShotId =
    chronologicalCurrentShotIndex >= 0
      ? filteredShots[chronologicalCurrentShotIndex]?.id
      : undefined;
  const chronologicalFollowShotIndex = useMemo(() => {
    if (chronologicalCurrentShotIndex < 0) {
      return chronologicalUpcomingShotIndex;
    }
    if (
      currentFrame >= filteredShots[chronologicalCurrentShotIndex].end_frame &&
      nextChronologicalShotAfterCurrentIndex >= 0
    ) {
      return nextChronologicalShotAfterCurrentIndex;
    }
    return chronologicalCurrentShotIndex;
  }, [
    chronologicalCurrentShotIndex,
    chronologicalUpcomingShotIndex,
    currentFrame,
    filteredShots,
    nextChronologicalShotAfterCurrentIndex,
  ]);
  const followShotId =
    chronologicalFollowShotIndex >= 0 ? filteredShots[chronologicalFollowShotIndex]?.id : undefined;
  const currentShotIndex = useMemo(
    () => (currentShotId ? sortedShots.findIndex((shot) => shot.id === currentShotId) : -1),
    [currentShotId, sortedShots],
  );
  const followShotIndex = useMemo(
    () => (followShotId ? sortedShots.findIndex((shot) => shot.id === followShotId) : -1),
    [followShotId, sortedShots],
  );
  const thumbnailAssetId = project?.asset.id ?? "";
  const thumbnailFingerprint = project?.asset.fingerprint ?? "";
  const thumbnailVideoPath = project?.asset.path ?? "";
  const thumbnailPreviewVideoPath = project?.proxy_path || thumbnailVideoPath;
  const thumbnailScale = 1 + thumbnailSize / 100;
  const thumbnailWidth = STORYBOARD_THUMBNAIL_WIDTH * thumbnailScale;
  const thumbnailHeight = STORYBOARD_THUMBNAIL_HEIGHT * thumbnailScale;
  const storyboardRowHeight = thumbnailHeight + STORYBOARD_ROW_VERTICAL_PADDING;
  const thumbnailColumnWidth =
    Math.max(
      storyboardColumnWidths.thumbnail,
      thumbnailWidth + STORYBOARD_THUMBNAIL_COLUMN_PADDING,
    ) + STORYBOARD_STATUS_GUTTER_WIDTH;
  const tableMinWidth =
    thumbnailColumnWidth +
    storyboardColumnWidths.title +
    storyboardColumnWidths.mediaStart +
    storyboardColumnWidths.mediaEnd +
    storyboardColumnWidths.duration +
    storyboardColumnWidths.rating +
    storyboardColumnWidths.retained;
  const tableStyle = {
    "--storyboard-fixed-thumbnail-width": `${thumbnailColumnWidth}px`,
    "--storyboard-status-gutter-width": `${STORYBOARD_STATUS_GUTTER_WIDTH}px`,
    "--storyboard-col-thumbnail": `${thumbnailColumnWidth}px`,
    "--storyboard-col-title": `${storyboardColumnWidths.title}px`,
    "--storyboard-col-media-start": `${storyboardColumnWidths.mediaStart}px`,
    "--storyboard-col-media-end": `${storyboardColumnWidths.mediaEnd}px`,
    "--storyboard-col-duration": `${storyboardColumnWidths.duration}px`,
    "--storyboard-col-rating": `${storyboardColumnWidths.rating}px`,
    "--storyboard-col-retained": `${storyboardColumnWidths.retained}px`,
    "--storyboard-table-min-width": `${tableMinWidth}px`,
    "--storyboard-thumbnail-width": `${thumbnailWidth}px`,
    "--storyboard-thumbnail-height": `${thumbnailHeight}px`,
    "--storyboard-row-height": `${storyboardRowHeight}px`,
  } as CSSProperties;
  const frameRate = useMemo(() => {
    const videoStream =
      project?.streams.find((stream) => stream.index === project.asset.video_stream_index) ??
      project?.streams.find((stream) => stream.codec_type === "video");
    return normalizeFrameRate(videoStream?.avg_frame_rate, videoStream?.r_frame_rate);
  }, [project]);
  const rowVirtualizer = useVirtualizer({
    count: sortedShots.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => storyboardRowHeight,
    getItemKey: (index) => sortedShots[index].id,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 4,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const firstRenderedShotIndex = virtualRows[0]?.index ?? 0;
  const lastRenderedShotIndex = virtualRows.at(-1)?.index ?? 0;
  const thumbnailPriorityCenterIndex = closestShotIndexToViewportCenter(
    virtualRows,
    rowVirtualizer.scrollOffset ?? 0,
    rowVirtualizer.scrollRect?.height ?? 0,
  );
  const thumbnailPrefetchStart = Math.max(
    0,
    firstRenderedShotIndex - THUMBNAIL_PREFETCH_ROWS_BEFORE,
  );
  const thumbnailPrefetchEnd = Math.min(
    sortedShots.length,
    lastRenderedShotIndex + 1 + THUMBNAIL_PREFETCH_ROWS_AFTER,
  );
  const isEditAuthority = panelActive && focusedPanelId === panelInstanceId;
  const selectedAnnotationShotIds = useMemo(
    () => annotationShotIdsForSelection(selectedShotIds, shotStacksByShotId),
    [selectedShotIds, shotStacksByShotId],
  );
  const contextMenuShotIds = Array.from(selectedAnnotationShotIds);
  const contextMenuRatings = contextMenuShotIds.map(
    (shotId) => shotAnnotations[shotId]?.rating ?? 0,
  );
  const contextMenuRating =
    contextMenuRatings.length > 0 &&
    contextMenuRatings.every((rating) => rating === contextMenuRatings[0])
      ? contextMenuRatings[0]
      : null;
  const contextMenuFlags = contextMenuShotIds.map((shotId) =>
    storyboardShotFlag(shotAnnotations[shotId]),
  );
  const contextMenuFlag =
    contextMenuFlags.length > 0 && contextMenuFlags.every((flag) => flag === contextMenuFlags[0])
      ? contextMenuFlags[0]
      : null;
  const contextMenuColorLabels = contextMenuShotIds.map(
    (shotId) => shotAnnotations[shotId]?.colorLabel ?? null,
  );
  const contextMenuColorLabel =
    contextMenuColorLabels.length > 0 &&
    contextMenuColorLabels.every((colorLabel) => colorLabel === contextMenuColorLabels[0])
      ? contextMenuColorLabels[0]
      : undefined;
  const annotationMenuShotIds = annotationMenu
    ? Array.from(
        annotationShotIdsForSelection(
          selectedShotIds.has(annotationMenu.shotId) ? selectedShotIds : [annotationMenu.shotId],
          shotStacksByShotId,
        ),
      )
    : [];
  const annotationMenuFlags = annotationMenuShotIds.map((shotId) =>
    storyboardShotFlag(shotAnnotations[shotId]),
  );
  const annotationMenuFlag =
    annotationMenuFlags.length > 0 &&
    annotationMenuFlags.every((flag) => flag === annotationMenuFlags[0])
      ? annotationMenuFlags[0]
      : null;
  const annotationMenuColorLabels = annotationMenuShotIds.map(
    (shotId) => shotAnnotations[shotId]?.colorLabel ?? null,
  );
  const annotationMenuColorLabel =
    annotationMenuColorLabels.length > 0 &&
    annotationMenuColorLabels.every((colorLabel) => colorLabel === annotationMenuColorLabels[0])
      ? annotationMenuColorLabels[0]
      : undefined;
  const composableShotIds = stackCompositionShotIds(selectedShotIds, shots, shotStacksByShotId);
  const canCreateShotStack = composableShotIds !== null;
  const contextMenuStackShotIds = Array.from(selectedShotIds).filter((shotId) =>
    shotStacksByShotId.has(shotId),
  );
  const contextMenuStacks = Array.from(
    new Map(
      contextMenuStackShotIds.map((shotId) => {
        const stack = shotStacksByShotId.get(shotId)!;
        return [stack.id, stack] as const;
      }),
    ).values(),
  );
  const contextMenuStackRepresentatives = contextMenuStacks.map((stack) => stack.shotIds[0]);
  const canSplitSelectedShotStacks = contextMenuStackShotIds.some((shotId) => {
    const stack = shotStacksByShotId.get(shotId);
    return stack ? stack.shotIds.indexOf(shotId) > 0 : false;
  });
  const expandSelectedShotStacks = contextMenuStacks.some((stack) => !stack.expanded);
  const hasExpandedShotStacks = shotStacks.some((stack) => stack.expanded);
  const hasCollapsedShotStacks = shotStacks.some((stack) => !stack.expanded);
  const contextSubmenuOpen = Boolean(
    contextMenu &&
    (contextMenu.flagSubmenuOpen ||
      contextMenu.ratingSubmenuOpen ||
      contextMenu.colorSubmenuOpen ||
      contextMenu.stackSubmenuOpen),
  );

  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowVirtualizer, storyboardRowHeight]);

  useEffect(() => {
    syncVideoContext(videoContext);
    cancelPendingTitleRename();
    setEditingShotId(null);
    setActiveCell(null);
    setContextMenu(null);
    setAnnotationMenu(null);
  }, [syncVideoContext, videoContext]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!annotationMenu) {
      return;
    }
    const close = () => setAnnotationMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [annotationMenu]);

  useEffect(() => {
    if (showOnlySelected && selectedCount === 0) {
      setShowOnlySelected(false);
    }
  }, [selectedCount, setShowOnlySelected, showOnlySelected]);

  useEffect(() => {
    const hasShots = displayShots.length > 0;
    if (!hadShotsRef.current && hasShots) {
      setShotSort(defaultStoryboardSort);
    }
    hadShotsRef.current = hasShots;
  }, [displayShots.length]);

  useEffect(() => {
    const visibleSelectedIds = sortedShots
      .map((shot) => shot.id)
      .filter((shotId) => selectedShotIds.has(shotId));
    if (visibleSelectedIds.length === 0) {
      selectionAnchorRef.current = null;
      selectionFocusRef.current = null;
      return;
    }
    if (!selectionFocusRef.current || !visibleSelectedIds.includes(selectionFocusRef.current)) {
      const fallbackId = visibleSelectedIds.at(-1)!;
      selectionFocusRef.current = fallbackId;
      selectionAnchorRef.current = fallbackId;
    }
  }, [selectedShotIds, sortedShots]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    const handleSelectionKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || isEditableKeyboardTarget(event.target) || sortedShots.length === 0) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target !== panel && !target?.closest("[data-storyboard-shot-id]")) {
        return;
      }
      const direction =
        event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : event.key === "ArrowDown" || event.key === "ArrowRight"
            ? 1
            : 0;
      if (direction === 0 || (!event.shiftKey && (event.ctrlKey || event.metaKey))) {
        return;
      }

      event.preventDefault();
      const focusedIndex = selectionFocusRef.current
        ? sortedShots.findIndex((shot) => shot.id === selectionFocusRef.current)
        : -1;
      const selectedIndex = sortedShots.findIndex((shot) => selectedShotIds.has(shot.id));
      const currentIndex = focusedIndex >= 0 ? focusedIndex : selectedIndex;
      const targetIndex =
        currentIndex < 0
          ? direction > 0
            ? 0
            : sortedShots.length - 1
          : clamp(currentIndex + direction, 0, sortedShots.length - 1);
      const targetId = sortedShots[targetIndex].id;
      selectionFocusRef.current = targetId;

      if (!event.shiftKey) {
        selectionAnchorRef.current = targetId;
        shotSelectionReplaced([targetId], targetId);
        rowVirtualizer.scrollToIndex(targetIndex, { align: "auto" });
        return;
      }

      const anchorIndex = selectionAnchorRef.current
        ? sortedShots.findIndex((shot) => shot.id === selectionAnchorRef.current)
        : -1;
      const resolvedAnchorIndex =
        anchorIndex >= 0 ? anchorIndex : Math.max(currentIndex, targetIndex);
      selectionAnchorRef.current = sortedShots[resolvedAnchorIndex].id;
      const start = Math.min(resolvedAnchorIndex, targetIndex);
      const end = Math.max(resolvedAnchorIndex, targetIndex);
      const nextSelection =
        event.ctrlKey || event.metaKey ? new Set(selectedShotIds) : new Set<string>();
      for (const shot of sortedShots.slice(start, end + 1)) {
        nextSelection.add(shot.id);
      }
      shotSelectionReplaced(Array.from(nextSelection), targetId);
      rowVirtualizer.scrollToIndex(targetIndex, { align: "auto" });
    };

    panel.addEventListener("keydown", handleSelectionKeyDown);
    return () => panel.removeEventListener("keydown", handleSelectionKeyDown);
  }, [rowVirtualizer, selectedShotIds, shotSelectionReplaced, sortedShots]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !isEditAuthority ||
        selectedShotIds.size === 0 ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isEditableKeyboardTarget(event.target)
      ) {
        return;
      }
      if (contextMenu) {
        if (!contextMenu.ratingSubmenuOpen || event.key !== "0") {
          return;
        }
        event.preventDefault();
        setShotRatings(selectedAnnotationShotIds, 0);
        setContextMenu(null);
        return;
      }
      const rating = Number(event.key);
      if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
        return;
      }
      event.preventDefault();
      setShotRatings(selectedAnnotationShotIds, rating);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    contextMenu,
    isEditAuthority,
    selectedAnnotationShotIds,
    selectedShotIds.size,
    setShotRatings,
  ]);

  useEffect(
    () => () => {
      if (scrollAnimationRef.current !== null) {
        cancelAnimationFrame(scrollAnimationRef.current);
      }
      if (pendingTitleRenameRef.current !== null) {
        window.clearTimeout(pendingTitleRenameRef.current);
      }
      marqueeCleanupRef.current?.();
      document.body.classList.remove("is-resizing-storyboard-column");
    },
    [],
  );

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    const list = listRef.current;
    const shot = sortedShots[followShotIndex];
    if (!list || !shot || followShotIndex < 0) {
      return;
    }
    const offsetInfo = rowVirtualizer.getOffsetForIndex(followShotIndex, "center");
    if (!offsetInfo) {
      return;
    }

    if (scrollAnimationRef.current !== null) {
      cancelAnimationFrame(scrollAnimationRef.current);
    }
    const startOffset = list.scrollTop;
    const initialTargetOffset = offsetInfo[0];
    const distance = Math.abs(initialTargetOffset - startOffset);
    const animationStartFrame = currentFrameRef.current;
    const isUpcomingShot =
      animationStartFrame < shot.start_frame || followShotIndex !== currentShotIndex;
    const viewportDistance = distance / Math.max(1, list.clientHeight);
    const distanceDuration = clamp(180 + Math.sqrt(viewportDistance) * 300, 160, 900);
    const preferredArrivalFrame = shot.start_frame - 1;
    const latestArrivalFrame = shot.end_frame - 1;
    const preferredDuration =
      (Math.max(0, preferredArrivalFrame - animationStartFrame) / frameRate) * 1000;
    const latestDuration =
      (Math.max(0, latestArrivalFrame - animationStartFrame) / frameRate) * 1000;
    const duration = isUpcomingShot
      ? Math.min(
          clamp(
            preferredDuration,
            MIN_UPCOMING_SCROLL_DURATION_MS,
            MAX_UPCOMING_SCROLL_DURATION_MS,
          ),
          latestDuration,
        )
      : distanceDuration;
    if (distance < 1 || duration <= 0) {
      list.scrollTop = initialTargetOffset;
      scrollAnimationRef.current = null;
      return;
    }
    let startedAt: number | null = null;

    const animate = (timestamp: number) => {
      startedAt ??= timestamp;
      const progress = clamp((timestamp - startedAt) / duration, 0, 1);
      const currentOffsetInfo = rowVirtualizer.getOffsetForIndex(followShotIndex, "center");
      const targetOffset = currentOffsetInfo?.[0] ?? initialTargetOffset;
      list.scrollTop = startOffset + (targetOffset - startOffset) * easeInOutCubic(progress);
      if (progress < 1) {
        scrollAnimationRef.current = requestAnimationFrame(animate);
      } else {
        list.scrollTop = targetOffset;
        scrollAnimationRef.current = null;
      }
    };

    scrollAnimationRef.current = requestAnimationFrame(animate);
    return () => {
      if (scrollAnimationRef.current !== null) {
        cancelAnimationFrame(scrollAnimationRef.current);
        scrollAnimationRef.current = null;
      }
    };
  }, [followShotId, followShotIndex, frameRate, isPlaying, rowVirtualizer, sortedShots]);

  useEffect(() => {
    if (!thumbnailVideoPath || thumbnailPrefetchStart >= thumbnailPrefetchEnd) {
      return;
    }
    const requests = sortedShots
      .slice(thumbnailPrefetchStart, thumbnailPrefetchEnd)
      .map((shot, offset) =>
        requestStoryboardThumbnail({
          assetId: thumbnailAssetId,
          fingerprint: thumbnailFingerprint,
          videoPath: thumbnailVideoPath,
          timeUs: shot.start_us,
          priority: Math.abs(thumbnailPrefetchStart + offset - thumbnailPriorityCenterIndex),
        }),
      );
    for (const request of requests) {
      void request.promise.then(
        () => undefined,
        () => undefined,
      );
    }
    return () => {
      for (const request of requests) {
        request.cancel();
      }
    };
  }, [
    sortedShots,
    thumbnailAssetId,
    thumbnailFingerprint,
    thumbnailPrefetchEnd,
    thumbnailPrefetchStart,
    thumbnailPriorityCenterIndex,
    thumbnailVideoPath,
  ]);

  function clearShotSelection() {
    cancelPendingTitleRename();
    setActiveCell(null);
    selectionAnchorRef.current = null;
    selectionFocusRef.current = null;
    shotSelectionCleared();
  }

  function startMarqueeSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const surface = event.currentTarget;
    const bounds = surface.getBoundingClientRect();
    const pointsAtScrollbar =
      event.clientX >= bounds.left + surface.clientWidth ||
      event.clientY >= bounds.top + surface.clientHeight;
    if (
      event.button !== 0 ||
      sortedShots.length === 0 ||
      pointsAtScrollbar ||
      (event.target as HTMLElement | null)?.closest("[data-storyboard-shot-id]")
    ) {
      return;
    }

    event.preventDefault();
    cancelPendingTitleRename();
    setActiveCell(null);
    marqueeCleanupRef.current?.();

    const pointerId = event.pointerId;
    const initialSelection = new Set(selectedShotIds);
    const togglesSelection = event.ctrlKey || event.metaKey;
    const addsSelection = event.shiftKey && !togglesSelection;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let lastSelection = new Set(selectedShotIds);

    const selectionsMatch = (left: Set<string>, right: Set<string>) =>
      left.size === right.size && Array.from(left).every((shotId) => right.has(shotId));

    const updateSelection = (currentX: number, currentY: number) => {
      const left = Math.min(startX, currentX);
      const right = Math.max(startX, currentX);
      const top = Math.min(startY, currentY);
      const bottom = Math.max(startY, currentY);
      const hitIds = new Set(
        Array.from(surface.querySelectorAll<HTMLElement>("[data-storyboard-shot-id]"))
          .filter((element) => {
            const rowBounds = element.getBoundingClientRect();
            return (
              rowBounds.right >= left &&
              rowBounds.left <= right &&
              rowBounds.bottom >= top &&
              rowBounds.top <= bottom
            );
          })
          .map((element) => element.dataset.storyboardShotId)
          .filter((shotId): shotId is string => Boolean(shotId)),
      );
      const nextSelection =
        togglesSelection || addsSelection ? new Set(initialSelection) : new Set<string>();
      if (togglesSelection) {
        for (const shotId of hitIds) {
          if (initialSelection.has(shotId)) {
            nextSelection.delete(shotId);
          } else {
            nextSelection.add(shotId);
          }
        }
      } else {
        for (const shotId of hitIds) {
          nextSelection.add(shotId);
        }
      }

      if (!selectionsMatch(lastSelection, nextSelection)) {
        lastSelection = nextSelection;
        let lastHitId: string | undefined;
        for (const shot of sortedShots) {
          if (hitIds.has(shot.id)) {
            lastHitId = shot.id;
          }
        }
        if (lastHitId && nextSelection.has(lastHitId)) {
          selectionAnchorRef.current = lastHitId;
          selectionFocusRef.current = lastHitId;
        } else if (nextSelection.size === 0) {
          selectionAnchorRef.current = null;
          selectionFocusRef.current = null;
        }
        const nextPrimaryShotId =
          lastHitId && nextSelection.has(lastHitId)
            ? lastHitId
            : activeShotId && nextSelection.has(activeShotId)
              ? activeShotId
              : null;
        shotSelectionReplaced(Array.from(nextSelection), nextPrimaryShotId);
      }
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      document.body.classList.remove("is-marquee-selecting");
      setMarqueeSelection(null);
      if (marqueeCleanupRef.current === cleanup) {
        marqueeCleanupRef.current = null;
      }
    };
    const finish = (finishEvent: globalThis.PointerEvent, cancelled: boolean) => {
      if (finishEvent.pointerId !== pointerId) {
        return;
      }
      if (!cancelled && !dragging && !togglesSelection && !addsSelection) {
        shotSelectionCleared();
        selectionAnchorRef.current = null;
        selectionFocusRef.current = null;
      }
      cleanup();
    };
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      if (
        !dragging &&
        Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < MARQUEE_DRAG_THRESHOLD
      ) {
        return;
      }
      if (!dragging) {
        dragging = true;
        document.body.classList.add("is-marquee-selecting");
      }
      moveEvent.preventDefault();
      const nextMarquee = {
        startX,
        startY,
        currentX: moveEvent.clientX,
        currentY: moveEvent.clientY,
      };
      setMarqueeSelection(nextMarquee);
      updateSelection(nextMarquee.currentX, nextMarquee.currentY);
    };
    const onUp = (upEvent: globalThis.PointerEvent) => finish(upEvent, false);
    const onCancel = (cancelEvent: globalThis.PointerEvent) => finish(cancelEvent, true);

    marqueeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  function renderMarqueeOverlay() {
    if (!marqueeSelection) {
      return null;
    }
    const left = Math.min(marqueeSelection.startX, marqueeSelection.currentX);
    const top = Math.min(marqueeSelection.startY, marqueeSelection.currentY);
    const width = Math.abs(marqueeSelection.currentX - marqueeSelection.startX);
    const height = Math.abs(marqueeSelection.currentY - marqueeSelection.startY);
    return createPortal(
      <div
        className="storyboard-marquee-selection"
        style={{ left, top, width, height }}
        aria-hidden="true"
      />,
      document.body,
    );
  }

  function annotationTargetShotIds(shotId: string) {
    return annotationShotIdsForSelection(
      selectedShotIds.has(shotId) ? selectedShotIds : [shotId],
      shotStacksByShotId,
    );
  }

  function openAnnotationMenu(
    event: ReactMouseEvent<HTMLButtonElement>,
    shotId: string,
    kind: StoryboardAnnotationMenuState["kind"],
  ) {
    event.preventDefault();
    event.stopPropagation();
    cancelPendingTitleRename();
    setActiveCell(null);
    panelRef.current?.focus({ preventScroll: true });
    setContextMenu(null);
    setAnnotationMenu({
      kind,
      x: event.clientX,
      y: event.clientY,
      shotId,
    });
  }

  function openContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const shotElement = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-storyboard-shot-id]",
    );
    const shotId = shotElement?.dataset.storyboardShotId;
    if (shotId && !selectedShotIds.has(shotId)) {
      selectionAnchorRef.current = shotId;
      selectionFocusRef.current = shotId;
      shotSelectionReplaced([shotId], shotId);
    }
    cancelPendingTitleRename();
    setActiveCell(null);
    panelRef.current?.focus({ preventScroll: true });
    setAnnotationMenu(null);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      shotId: shotId ?? null,
      flagSubmenuOpen: false,
      ratingSubmenuOpen: false,
      colorSubmenuOpen: false,
      stackSubmenuOpen: false,
    });
  }

  function cancelPendingTitleRename() {
    if (pendingTitleRenameRef.current === null) {
      return;
    }
    window.clearTimeout(pendingTitleRenameRef.current);
    pendingTitleRenameRef.current = null;
  }

  function activateCell(shotId: string, columnId: StoryboardResizableColumnId) {
    cancelPendingTitleRename();
    setActiveCell({ shotId, columnId });
  }

  function storyboardCellClassName(
    shotId: string,
    columnId: StoryboardResizableColumnId,
    selected: boolean,
    baseClassName = "",
  ) {
    return [
      baseClassName,
      selected && activeCell?.shotId === shotId && activeCell.columnId === columnId
        ? "storyboard-active-cell"
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  function beginTitleRename(shot: StoryboardShot) {
    cancelPendingTitleRename();
    setRenameValue(storyboardShotTitle(shot, shotCount, shotAnnotations[shot.id]));
    setEditingShotId(shot.id);
  }

  function scheduleTitleRename(shot: StoryboardShot) {
    cancelPendingTitleRename();
    pendingTitleRenameRef.current = window.setTimeout(() => {
      pendingTitleRenameRef.current = null;
      beginTitleRename(shot);
    }, TITLE_RENAME_DELAY_MS);
  }

  function handleTitleCellClick(
    event: ReactMouseEvent<HTMLElement>,
    shot: StoryboardShot,
    selected: boolean,
  ) {
    activateCell(shot.id, "title");
    if (selected && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (event.detail === 1) {
        scheduleTitleRename(shot);
      } else {
        cancelPendingTitleRename();
      }
    }
  }

  function finishTitleRename(shot: StoryboardShot, commit: boolean) {
    cancelPendingTitleRename();
    if (editingShotId !== shot.id) {
      return;
    }
    const nextTitle = renameValue.trim();
    const currentTitle = storyboardShotTitle(shot, shotCount, shotAnnotations[shot.id]);
    if (commit && nextTitle && nextTitle !== currentTitle) {
      setShotTitle(shot.id, nextTitle);
    }
    setEditingShotId(null);
  }

  function selectVisibleShots() {
    selectionAnchorRef.current = null;
    selectionFocusRef.current = null;
    shotSelectionReplaced(
      sortedShots.map((shot) => shot.id),
      null,
    );
  }

  function handleShotSelection(
    event: ReactMouseEvent<HTMLElement>,
    shot: StoryboardShot,
    focusRange = false,
  ) {
    const additive = event.ctrlKey || event.metaKey;
    selectionFocusRef.current = shot.id;
    const currentSelection = new Set(selectedShotIds);
    let nextSelection: Set<string>;
    let primaryShotId = activeShotId;
    let shouldSeek = false;

    if (!event.shiftKey) {
      selectionAnchorRef.current = shot.id;
      if (additive) {
        nextSelection = new Set(currentSelection);
        if (nextSelection.has(shot.id)) {
          nextSelection.delete(shot.id);
          if (primaryShotId === shot.id) {
            primaryShotId = null;
          }
        } else {
          nextSelection.add(shot.id);
          if (!primaryShotId) {
            primaryShotId = shot.id;
            shouldSeek = true;
          }
        }
      } else {
        nextSelection = new Set([shot.id]);
        primaryShotId = shot.id;
        shouldSeek = true;
      }
    } else {
      const targetIndex = sortedShots.findIndex((candidate) => candidate.id === shot.id);
      if (targetIndex < 0) {
        return;
      }

      const anchorIndex = selectionAnchorRef.current
        ? sortedShots.findIndex((candidate) => candidate.id === selectionAnchorRef.current)
        : sortedShots.findIndex((candidate) => currentSelection.has(candidate.id));
      const resolvedAnchorIndex = anchorIndex >= 0 ? anchorIndex : targetIndex;
      const start = Math.min(resolvedAnchorIndex, targetIndex);
      const end = Math.max(resolvedAnchorIndex, targetIndex);
      nextSelection = additive ? new Set(currentSelection) : new Set<string>();
      for (const rangeShot of sortedShots.slice(start, end + 1)) {
        nextSelection.add(rangeShot.id);
      }
      if (primaryShotId) {
        nextSelection.add(primaryShotId);
      }
      selectionAnchorRef.current = sortedShots[resolvedAnchorIndex]?.id ?? shot.id;
      if (!primaryShotId) {
        primaryShotId = shot.id;
        shouldSeek = true;
      }
    }

    shotSelectionReplaced(Array.from(nextSelection), primaryShotId);
    if (shouldSeek && primaryShotId === shot.id) {
      seekToShot(shot, focusRange);
    }
  }

  function handleShotDoubleClick(event: ReactMouseEvent<HTMLElement>, shot: StoryboardShot) {
    const target = event.target as HTMLElement;
    if (target.closest(".shot-frame-button, .shot-rating-button, .shot-flag-button")) {
      return;
    }
    seekToShot(shot, true);
  }

  function syncTableHeaderScroll(event: ReactUIEvent<HTMLDivElement>) {
    if (tableHeaderRef.current) {
      tableHeaderRef.current.style.transform = `translateX(${-event.currentTarget.scrollLeft}px)`;
    }
  }

  function toggleShotSort(columnId: StoryboardSortableColumnId) {
    if (displayShots.length === 0) {
      return;
    }
    setShotSort((current) =>
      current.columnId === columnId
        ? {
            columnId,
            direction: current.direction === "ascending" ? "descending" : "ascending",
          }
        : { columnId, direction: "ascending" },
    );
  }

  function setRatingFilter(minimum: number) {
    const nextMinimum = minimumRating === minimum ? 0 : minimum;

    if (shotFilter === "retained") {
      setMinimumRating(nextMinimum);
      setShotFilter(nextMinimum > 0 ? "custom" : "retained");
      return;
    }
    if (shotFilter === "custom") {
      setMinimumRating(nextMinimum);
      setShotFilter(nextMinimum > 0 ? "custom" : "retained");
      return;
    }

    setMinimumRating(nextMinimum);
    setShotFilter(nextMinimum > 0 ? "rated" : "all");
  }

  function toggleFlagFilter(flag: StoryboardShotFlag) {
    const nextFlagFilters = flagFilters.includes(flag)
      ? flagFilters.filter((current) => current !== flag)
      : storyboardShotFlags.filter((current) => current === flag || flagFilters.includes(current));
    setFlagFilters(nextFlagFilters);
    setShotFilter(minimumRating > 0 ? "custom" : "retained");
  }

  function toggleColorLabelFilter(colorLabel: StoryboardShotColorLabelFilter) {
    const nextColorLabelFilters = colorLabelFilters.includes(colorLabel)
      ? colorLabelFilters.filter((current) => current !== colorLabel)
      : storyboardShotColorFilterLabels
          .map(([current]) => current)
          .filter((current) => current === colorLabel || colorLabelFilters.includes(current));
    setColorLabelFilters(nextColorLabelFilters);
  }

  function handleShotFilterChange(filter: StoryboardShotFilter) {
    if (filter === "custom") {
      return;
    }
    setShotFilter(filter);
    setColorLabelFilters([]);
    if (filter === "retained") {
      setFlagFilters(["retained"]);
    }
    setMinimumRating(filter === "rated" ? Math.max(1, minimumRating) : 0);
  }

  function startColumnResize(
    event: ReactPointerEvent<HTMLButtonElement>,
    columnId: StoryboardResizableColumnId,
  ) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    columnResizeRef.current = {
      columnId,
      startX: event.clientX,
      startWidth: storyboardColumnWidths[columnId],
      pointerId: event.pointerId,
    };
    document.body.classList.add("is-resizing-storyboard-column");
  }

  function updateColumnResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const resize = columnResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) {
      return;
    }
    const width = clamp(
      resize.startWidth + event.clientX - resize.startX,
      minimumStoryboardColumnWidths[resize.columnId],
      maximumStoryboardColumnWidths[resize.columnId],
    );
    setStoryboardColumnWidths((current) =>
      current[resize.columnId] === width
        ? current
        : {
            ...current,
            [resize.columnId]: width,
          },
    );
  }

  function finishColumnResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const resize = columnResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) {
      return;
    }
    columnResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-resizing-storyboard-column");
  }

  function resetColumnWidth(columnId: StoryboardResizableColumnId) {
    setStoryboardColumnWidths((current) => ({
      ...current,
      [columnId]: initialStoryboardColumnWidths[columnId],
    }));
  }

  useEditCapability({
    identity,
    active: isEditAuthority,
    selectedCount,
    visibleCount: sortedShots.length,
    handlers: {
      selectAll: selectVisibleShots,
      clearSelection: clearShotSelection,
    },
  });

  async function detectStoryboard() {
    if (!project || !canDetect) {
      return;
    }
    const taskId = createFfmpegTaskId("storyboard-detect");
    const context = videoContext;
    let cancelled = false;
    detectionStarted(context);
    const task = await createTaskProgress({
      operation: "storyboard.detect",
      label: `分镜拆分 ${project.asset.file_name}`,
      current: 0,
      total: 1,
      listener: listenToFfmpegTaskProgress(taskId),
      on_cancel: async () => {
        cancelled = true;
        await cancelFfmpegTask(taskId);
      },
    });
    try {
      const result = await invokeCommand<StoryboardDetectionResult>("detect_storyboard_shots", {
        assetId: project.asset.id,
        taskId,
      });
      if (cancelled) {
        task.remove();
        detectionFinished(context);
        return;
      }
      detectionCompleted(context, result.shots);
      task.remove();
    } catch (error) {
      if (cancelled) {
        task.remove();
      } else {
        task.fail(error, { displayName: project.asset.file_name, resourceKind: "media" });
      }
      detectionFinished(context);
    }
  }

  function renderTableHeader(header: (typeof storyboardTableHeaders)[number]) {
    const isActive =
      header.sortColumnId !== undefined &&
      displayShots.length > 0 &&
      shotSort.columnId === header.sortColumnId;
    const nextDirection = isActive && shotSort.direction === "ascending" ? "降序" : "升序";
    return (
      <span
        key={header.id}
        className={`storyboard-column-header storyboard-column-${header.id}`}
        role="columnheader"
        aria-sort={isActive ? shotSort.direction : undefined}
      >
        {header.sortColumnId ? (
          <button
            type="button"
            className={`storyboard-column-sort-button ${isActive ? "active" : ""}`}
            title={`按${header.label}${nextDirection}排列`}
            aria-label={`按${header.label}${nextDirection}排列`}
            onClick={() => toggleShotSort(header.sortColumnId!)}
            disabled={displayShots.length === 0}
          >
            <span className="storyboard-column-label-text">{header.label}</span>
            {isActive && <SortArrow direction={shotSort.direction} />}
          </button>
        ) : header.label ? (
          <span className="storyboard-column-label-text">{header.label}</span>
        ) : null}
        {header.resizeColumn && (
          <button
            type="button"
            className="storyboard-column-resizer"
            title={`调整${storyboardResizableColumnLabels[header.resizeColumn]}列宽，双击恢复默认`}
            aria-label={`调整${storyboardResizableColumnLabels[header.resizeColumn]}列宽`}
            onPointerDown={(event) => startColumnResize(event, header.resizeColumn!)}
            onPointerMove={updateColumnResize}
            onPointerUp={finishColumnResize}
            onPointerCancel={finishColumnResize}
            onDoubleClick={() => resetColumnWidth(header.resizeColumn!)}
          />
        )}
      </span>
    );
  }

  return (
    <section ref={panelRef} className="storyboard-panel" tabIndex={-1}>
      <div className="storyboard-project-row">
        <Film aria-hidden="true" />
        <span>分镜</span>
        <span className="storyboard-video-name" title={videoLabel}>
          {videoLabel}
        </span>
      </div>

      <div className="storyboard-search-row">
        <label className="storyboard-search">
          <Search aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="搜索分镜"
            disabled={shots.length === 0}
          />
        </label>
        <button
          type="button"
          className={`storyboard-detect-button ${isDetecting ? "is-detecting" : ""}`}
          onClick={() => void detectStoryboard()}
          disabled={!canDetect}
          title={
            isDetecting
              ? "正在切分"
              : canDetect
                ? shots.length > 0
                  ? "重新切分"
                  : "切分"
                : "请先导入可用视频"
          }
          aria-busy={isDetecting}
        >
          {isDetecting || detectingVideoContext === videoContext ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Scissors aria-hidden="true" />
          )}
        </button>
      </div>

      <div
        className={`storyboard-filter-row ${
          shotFilter === "all" && colorLabelFilters.length === 0 ? "is-filter-closed" : ""
        }`}
      >
        <span className="storyboard-filter-label">过滤器：</span>
        {(shotFilter === "retained" || shotFilter === "custom") && (
          <>
            <div className="storyboard-filter-flags" aria-label="按旗标过滤">
              {storyboardShotFlags.map((flag) => (
                <button
                  key={flag}
                  type="button"
                  className={flagFilters.includes(flag) ? "active" : ""}
                  onClick={() => toggleFlagFilter(flag)}
                  disabled={shots.length === 0}
                  title={storyboardShotFlagLabels[flag]}
                  aria-label={storyboardShotFlagLabels[flag]}
                  aria-pressed={flagFilters.includes(flag)}
                >
                  <StoryboardFlagIcon flag={flag} />
                </button>
              ))}
            </div>
            <span className="storyboard-filter-separator" aria-hidden="true" />
          </>
        )}
        <SelectDropdown
          ariaLabel="星级比较方式"
          className={`storyboard-filter-comparator is-${ratingComparator}`}
          menuClassName="storyboard-rating-comparator-menu"
          value={ratingComparator}
          selectedLabel={storyboardRatingComparatorSymbols[ratingComparator]}
          title={storyboardRatingComparatorLabels[ratingComparator]}
          items={storyboardRatingComparatorItems}
          onChange={setRatingComparator}
          disabled={shots.length === 0}
        />
        <div className="storyboard-filter-stars" aria-label="按星级过滤">
          {storyboardRatingFilters.map((rating) => (
            <button
              key={rating}
              type="button"
              className={rating <= minimumRating ? "active" : ""}
              onClick={() => setRatingFilter(rating)}
              disabled={shots.length === 0}
              title={`筛选${storyboardRatingComparatorLabels[ratingComparator]} ${rating} 星`}
              aria-label={`筛选${storyboardRatingComparatorLabels[ratingComparator]} ${rating} 星`}
              aria-pressed={rating <= minimumRating}
            >
              <Star aria-hidden="true" />
            </button>
          ))}
        </div>
        <span className="storyboard-filter-separator" aria-hidden="true" />
        <div className="storyboard-filter-colors" aria-label="按色标过滤">
          {storyboardShotColorFilterLabels.map(([colorLabel, label]) => {
            const active = colorLabelFilters.includes(colorLabel);
            return (
              <button
                key={colorLabel}
                type="button"
                className={active ? "active" : ""}
                style={
                  {
                    "--storyboard-filter-color": storyboardShotColorFilterValues[colorLabel],
                  } as CSSProperties
                }
                onClick={() => toggleColorLabelFilter(colorLabel)}
                disabled={shots.length === 0}
                title={`${label}色标`}
                aria-label={`按${label}色标过滤`}
                aria-pressed={active}
              />
            );
          })}
        </div>
        <span className="storyboard-filter-separator" aria-hidden="true" />
        <SelectDropdown
          ariaLabel="分镜过滤器"
          className="storyboard-filter-dropdown"
          menuClassName="storyboard-filter-menu"
          value={shotFilter}
          selectedLabel={
            shotFilter === "custom" || colorLabelFilters.length > 0 ? "自定义过滤" : undefined
          }
          items={
            shotFilter === "custom" || colorLabelFilters.length > 0
              ? storyboardCustomFilterItems
              : storyboardFilterItems
          }
          onChange={handleShotFilterChange}
          disabled={shots.length === 0}
        />
      </div>

      <div
        className="storyboard-content"
        onPointerDown={(event) => {
          if (!isEditableKeyboardTarget(event.target)) {
            panelRef.current?.focus({ preventScroll: true });
          }
        }}
      >
        <div
          className="storyboard-list-frame"
          role="table"
          aria-label="分镜列表"
          style={tableStyle}
        >
          <div className="storyboard-list-header-viewport">
            <div ref={tableHeaderRef} className="storyboard-list-header" role="row">
              {storyboardTableHeaders.map(renderTableHeader)}
            </div>
            <div className="storyboard-list-header-fixed-overlay" aria-hidden="true">
              <span className="storyboard-column-header storyboard-column-thumbnail" />
            </div>
          </div>

          <div
            ref={listRef}
            className="shot-list"
            onScroll={syncTableHeaderScroll}
            onPointerDown={startMarqueeSelection}
            onContextMenu={openContextMenu}
          >
            {sortedShots.length > 0 && (
              <div
                className="virtual-spacer"
                role="rowgroup"
                style={{
                  height: `${rowVirtualizer.getTotalSize() + TABLE_SCROLLBAR_SPACER_PX}px`,
                }}
              >
                {virtualRows.map((virtualRow) => {
                  const shot = sortedShots[virtualRow.index];
                  const selected = selectedShotIds.has(shot.id);
                  const isPrimaryShot = selected && shot.id === activeShotId;
                  const isCurrentShot = virtualRow.index === currentShotIndex;
                  const annotation = shotAnnotations[shot.id];
                  const title = storyboardShotTitle(shot, shotCount, annotation);
                  const rating = annotation?.rating ?? 0;
                  const flag = storyboardShotFlag(annotation);
                  const colorLabel = annotation?.colorLabel;
                  const shotStack = shotStacksByShotId.get(shot.id);
                  const shotStackIndex = shotStack?.shotIds.indexOf(shot.id) ?? -1;
                  return (
                    <div
                      key={shot.id}
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualRow.index}
                      data-storyboard-shot-id={shot.id}
                      className={`shot-row ${selected ? "is-selected" : ""} ${
                        isPrimaryShot ? "is-primary" : ""
                      } ${isCurrentShot ? "is-current" : ""} ${
                        colorLabel ? "has-color-label" : ""
                      } ${shotStack ? "has-shot-stack" : ""} ${
                        shotStack?.expanded ? "is-expanded-stack-member" : ""
                      }`}
                      style={
                        {
                          transform: `translateY(${virtualRow.start}px)`,
                          ...(colorLabel
                            ? {
                                "--storyboard-color-label":
                                  storyboardShotColorLabelValues[colorLabel],
                              }
                            : {}),
                        } as CSSProperties
                      }
                      role="row"
                      onClick={(event) => handleShotSelection(event, shot)}
                      onDoubleClick={(event) => handleShotDoubleClick(event, shot)}
                    >
                      <div className="shot-thumbnail-cell" role="cell">
                        <div className="shot-thumbnail-topline">
                          <span className="shot-thumbnail-row-number" aria-hidden="true">
                            {virtualRow.index + 1}
                          </span>
                          <button
                            type="button"
                            className={`shot-thumbnail-flag is-${flag}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setShotFlags(
                                annotationTargetShotIds(shot.id),
                                flag === "none" ? "retained" : "none",
                              );
                            }}
                            onContextMenu={(event) => openAnnotationMenu(event, shot.id, "flag")}
                            onDoubleClick={(event) => event.stopPropagation()}
                            title={
                              flag === "none"
                                ? "设为留用旗标"
                                : `取消${storyboardShotFlagLabels[flag]}`
                            }
                            aria-label={
                              flag === "none"
                                ? "设为留用旗标"
                                : `取消${storyboardShotFlagLabels[flag]}`
                            }
                            aria-pressed={flag !== "none"}
                          />
                        </div>
                        {shotStack && (
                          <StoryboardStackBadge
                            stack={shotStack}
                            shotIndex={shotStackIndex}
                            onToggle={() => setShotStackExpanded(shot.id, !shotStack.expanded)}
                          />
                        )}
                        {thumbnailVideoPath && (
                          <ShotFrameButton
                            shot={shot}
                            assetId={thumbnailAssetId}
                            fingerprint={thumbnailFingerprint}
                            videoPath={thumbnailVideoPath}
                            previewVideoPath={thumbnailPreviewVideoPath}
                            frameRate={frameRate}
                            priority={Math.abs(virtualRow.index - thumbnailPriorityCenterIndex)}
                            onSelect={(event) => {
                              event.stopPropagation();
                              cancelPendingTitleRename();
                              setActiveCell(null);
                              handleShotSelection(event, shot, true);
                            }}
                          />
                        )}
                        <button
                          type="button"
                          className={`shot-thumbnail-color-label ${
                            colorLabel ? "has-color-label" : "is-none"
                          }`}
                          onClick={(event) => openAnnotationMenu(event, shot.id, "color")}
                          onDoubleClick={(event) => event.stopPropagation()}
                          title={colorLabel ? "更改色标" : "设置色标"}
                          aria-label={colorLabel ? "更改色标" : "设置色标"}
                        />
                        <div
                          className="shot-thumbnail-rating"
                          role="group"
                          aria-label={`${rating} 星`}
                        >
                          {[1, 2, 3, 4, 5].map((star) => {
                            const filled = star <= rating;
                            return (
                              <button
                                key={star}
                                type="button"
                                className={`shot-thumbnail-rating-slot ${
                                  filled ? "is-filled" : "is-empty"
                                }`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setShotRatings(
                                    annotationTargetShotIds(shot.id),
                                    rating === star ? 0 : star,
                                  );
                                }}
                                onDoubleClick={(event) => event.stopPropagation()}
                                title={`${star} 星`}
                                aria-label={`${star} 星`}
                                aria-pressed={rating === star}
                              >
                                {filled ? (
                                  <Star aria-hidden="true" />
                                ) : (
                                  <span aria-hidden="true">·</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <span
                        className={storyboardCellClassName(
                          shot.id,
                          "title",
                          selected,
                          "shot-title-cell",
                        )}
                        role="cell"
                        onClick={(event) => handleTitleCellClick(event, shot, selected)}
                      >
                        {editingShotId === shot.id ? (
                          <input
                            className="shot-title-editor"
                            value={renameValue}
                            aria-label="重命名分镜"
                            autoFocus
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) => setRenameValue(event.currentTarget.value)}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onBlur={() => finishTitleRename(shot, true)}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Enter") {
                                event.preventDefault();
                                event.currentTarget.blur();
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                finishTitleRename(shot, false);
                              }
                            }}
                          />
                        ) : (
                          <span
                            className="shot-title-copy"
                            title={title}
                            onDoubleClick={(event) => {
                              event.stopPropagation();
                              beginTitleRename(shot);
                            }}
                          >
                            {title}
                          </span>
                        )}
                      </span>
                      <span
                        className={storyboardCellClassName(
                          shot.id,
                          "mediaStart",
                          selected,
                          "shot-time-cell",
                        )}
                        role="cell"
                        onClick={() => activateCell(shot.id, "mediaStart")}
                      >
                        {formatMonitorTime(shot.start_us, frameRate)}
                      </span>
                      <span
                        className={storyboardCellClassName(
                          shot.id,
                          "mediaEnd",
                          selected,
                          "shot-time-cell",
                        )}
                        role="cell"
                        onClick={() => activateCell(shot.id, "mediaEnd")}
                      >
                        {formatMonitorTime(shot.end_us, frameRate)}
                      </span>
                      <span
                        className={storyboardCellClassName(
                          shot.id,
                          "duration",
                          selected,
                          "shot-duration-cell",
                        )}
                        role="cell"
                        onClick={() => activateCell(shot.id, "duration")}
                      >
                        {formatMonitorFrame(
                          Math.max(0, shot.end_frame - shot.start_frame + 1),
                          frameRate,
                        )}
                      </span>
                      <div className="shot-rating-cell" role="cell" aria-label={`${rating} 星`}>
                        {[1, 2, 3, 4, 5].map((star) => (
                          <button
                            key={star}
                            type="button"
                            className="shot-rating-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setShotRatings(
                                annotationTargetShotIds(shot.id),
                                rating === star ? 0 : star,
                              );
                            }}
                            onDoubleClick={(event) => event.stopPropagation()}
                            title={`${star} 星`}
                            aria-label={`${star} 星`}
                            aria-pressed={rating === star}
                          >
                            <Star
                              className={star <= rating ? "is-filled" : ""}
                              aria-hidden="true"
                            />
                          </button>
                        ))}
                      </div>
                      <div className="shot-retain-cell" role="cell">
                        <div className="shot-flag-controls">
                          {(["retained", "excluded"] as const).map((nextFlag) => {
                            const active = flag === nextFlag;
                            const label = storyboardShotFlagLabels[nextFlag];
                            return (
                              <button
                                key={nextFlag}
                                type="button"
                                className={`shot-flag-button ${active ? "active" : ""}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setShotFlags(
                                    annotationTargetShotIds(shot.id),
                                    active ? "none" : nextFlag,
                                  );
                                }}
                                onDoubleClick={(event) => event.stopPropagation()}
                                title={active ? `取消${label}` : `设为${label}`}
                                aria-label={active ? `取消${label}` : `设为${label}`}
                                aria-pressed={active}
                              >
                                <StoryboardFlagIcon flag={nextFlag} />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {renderMarqueeOverlay()}

      <footer className="storyboard-footer">
        <div className="storyboard-selection-tools">
          <button
            type="button"
            onClick={selectVisibleShots}
            disabled={sortedShots.length === 0}
            title="全选分镜"
          >
            <CheckCheck aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={clearShotSelection}
            disabled={selectedCount === 0}
            title="清空选择"
          >
            <X aria-hidden="true" />
          </button>
          <button
            type="button"
            className={showOnlySelected ? "active" : ""}
            onClick={() => setShowOnlySelected(!showOnlySelected)}
            disabled={selectedCount === 0}
            title="仅展示选中分镜"
            aria-pressed={showOnlySelected}
          >
            <ListFilter aria-hidden="true" />
          </button>
          <input
            type="range"
            min="0"
            max="100"
            value={thumbnailSize}
            aria-label="分镜缩略图大小"
            onChange={(event) => setThumbnailSize(Number(event.currentTarget.value))}
          />
        </div>
        <span>
          {selectedCount} 条已选择，共 {sortedShots.length} 条
        </span>
      </footer>

      {contextMenu &&
        createPortal(
          <PopupMenu
            className="storyboard-context-menu"
            contextMenuAnchor={contextMenu}
            enableMnemonics={!contextSubmenuOpen}
            style={{
              position: "fixed",
              left: contextMenu.x,
              top: contextMenu.y,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <PopupMenuSubmenu
              label="设置旗标(F)"
              mnemonic="F"
              open={contextMenu.flagSubmenuOpen}
              enableMnemonics
              menuClassName="storyboard-context-menu"
              onOpenChange={(open) =>
                setContextMenu((current) =>
                  current
                    ? {
                        ...current,
                        flagSubmenuOpen: open,
                        ratingSubmenuOpen: open ? false : current.ratingSubmenuOpen,
                        colorSubmenuOpen: open ? false : current.colorSubmenuOpen,
                        stackSubmenuOpen: open ? false : current.stackSubmenuOpen,
                      }
                    : current,
                )
              }
              disabled={contextMenuShotIds.length === 0}
            >
              <StoryboardFlagMenuItems
                checkedFlag={contextMenuFlag}
                onSelect={(flag) => {
                  setShotFlags(contextMenuShotIds, flag);
                  setContextMenu(null);
                }}
              />
            </PopupMenuSubmenu>

            <PopupMenuSubmenu
              label="设置星级(Z)"
              mnemonic="Z"
              open={contextMenu.ratingSubmenuOpen}
              enableMnemonics
              menuClassName="storyboard-context-menu"
              onOpenChange={(open) =>
                setContextMenu((current) =>
                  current
                    ? {
                        ...current,
                        ratingSubmenuOpen: open,
                        flagSubmenuOpen: open ? false : current.flagSubmenuOpen,
                        colorSubmenuOpen: open ? false : current.colorSubmenuOpen,
                        stackSubmenuOpen: open ? false : current.stackSubmenuOpen,
                      }
                    : current,
                )
              }
              disabled={contextMenuShotIds.length === 0}
            >
              <PopupMenuItem
                checked={contextMenuRating === 0}
                mnemonic="N"
                shortcut="0"
                onSelect={() => {
                  setShotRatings(contextMenuShotIds, 0);
                  setContextMenu(null);
                }}
              >
                无(N)
              </PopupMenuItem>
              {[1, 2, 3, 4, 5].map((rating) => (
                <PopupMenuItem
                  key={rating}
                  checked={contextMenuRating === rating}
                  mnemonic={String(rating)}
                  onSelect={() => {
                    setShotRatings(contextMenuShotIds, rating);
                    setContextMenu(null);
                  }}
                >
                  {rating} 星({rating})
                </PopupMenuItem>
              ))}
              <PopupMenuSeparator />
              <PopupMenuItem
                onSelect={() => {
                  adjustShotRatings(contextMenuShotIds, -1);
                  setContextMenu(null);
                }}
                disabled={
                  contextMenuShotIds.length === 0 ||
                  contextMenuRatings.every((rating) => rating === 0)
                }
              >
                降低星级
              </PopupMenuItem>
              <PopupMenuItem
                onSelect={() => {
                  adjustShotRatings(contextMenuShotIds, 1);
                  setContextMenu(null);
                }}
                disabled={
                  contextMenuShotIds.length === 0 ||
                  contextMenuRatings.every((rating) => rating === 5)
                }
              >
                提升星级
              </PopupMenuItem>
            </PopupMenuSubmenu>

            <PopupMenuSubmenu
              label="设置色标(C)"
              mnemonic="C"
              open={contextMenu.colorSubmenuOpen}
              enableMnemonics
              menuClassName="storyboard-context-menu"
              onOpenChange={(open) =>
                setContextMenu((current) =>
                  current
                    ? {
                        ...current,
                        colorSubmenuOpen: open,
                        flagSubmenuOpen: open ? false : current.flagSubmenuOpen,
                        ratingSubmenuOpen: open ? false : current.ratingSubmenuOpen,
                        stackSubmenuOpen: open ? false : current.stackSubmenuOpen,
                      }
                    : current,
                )
              }
              disabled={contextMenuShotIds.length === 0}
            >
              <StoryboardColorMenuItems
                checkedColorLabel={contextMenuColorLabel}
                onSelect={(colorLabel) => {
                  setShotColorLabels(contextMenuShotIds, colorLabel);
                  setContextMenu(null);
                }}
              />
            </PopupMenuSubmenu>

            <PopupMenuSeparator />

            <PopupMenuSubmenu
              label="堆叠(X)"
              mnemonic="X"
              open={contextMenu.stackSubmenuOpen}
              enableMnemonics
              menuClassName="storyboard-context-menu"
              onOpenChange={(open) =>
                setContextMenu((current) =>
                  current
                    ? {
                        ...current,
                        stackSubmenuOpen: open,
                        flagSubmenuOpen: open ? false : current.flagSubmenuOpen,
                        ratingSubmenuOpen: open ? false : current.ratingSubmenuOpen,
                        colorSubmenuOpen: open ? false : current.colorSubmenuOpen,
                      }
                    : current,
                )
              }
              disabled={
                !canCreateShotStack && contextMenuStacks.length === 0 && shotStacks.length === 0
              }
            >
              <PopupMenuItem
                mnemonic="G"
                onSelect={() => {
                  if (composableShotIds) {
                    createShotStack(composableShotIds);
                  }
                  setContextMenu(null);
                }}
                disabled={!canCreateShotStack}
              >
                组成堆叠(G)
              </PopupMenuItem>
              <PopupMenuItem
                mnemonic="U"
                onSelect={() => {
                  for (const shotId of contextMenuStackRepresentatives) {
                    cancelShotStack(shotId);
                  }
                  setContextMenu(null);
                }}
                disabled={contextMenuStacks.length === 0}
              >
                取消堆叠(U)
              </PopupMenuItem>
              <PopupMenuItem
                mnemonic="R"
                onSelect={() => {
                  for (const shotId of contextMenuStackShotIds) {
                    removeShotFromStack(shotId);
                  }
                  setContextMenu(null);
                }}
                disabled={contextMenuStackShotIds.length === 0}
              >
                从堆叠中移去(R)
              </PopupMenuItem>
              <PopupMenuItem
                mnemonic="S"
                onSelect={() => {
                  for (const shotId of contextMenuStackShotIds) {
                    splitShotStack(shotId);
                  }
                  setContextMenu(null);
                }}
                disabled={!canSplitSelectedShotStacks}
              >
                拆分堆叠(S)
              </PopupMenuItem>
              <PopupMenuSeparator />
              <PopupMenuItem
                onSelect={() => {
                  for (const shotId of contextMenuStackRepresentatives) {
                    setShotStackExpanded(shotId, expandSelectedShotStacks);
                  }
                  setContextMenu(null);
                }}
                disabled={contextMenuStacks.length === 0}
              >
                {expandSelectedShotStacks ? "展开堆叠" : "折叠堆叠"}
              </PopupMenuItem>
              <PopupMenuSeparator />
              <PopupMenuItem
                mnemonic="C"
                onSelect={() => {
                  setAllShotStacksExpanded(false);
                  setContextMenu(null);
                }}
                disabled={!hasExpandedShotStacks}
              >
                折叠全部堆叠(C)
              </PopupMenuItem>
              <PopupMenuItem
                mnemonic="E"
                onSelect={() => {
                  setAllShotStacksExpanded(true);
                  setContextMenu(null);
                }}
                disabled={!hasCollapsedShotStacks}
              >
                展开全部堆叠(E)
              </PopupMenuItem>
            </PopupMenuSubmenu>
          </PopupMenu>,
          document.body,
        )}
      {annotationMenu &&
        createPortal(
          <PopupMenu
            className="storyboard-context-menu"
            contextMenuAnchor={annotationMenu}
            enableMnemonics
            style={{
              position: "fixed",
              left: annotationMenu.x,
              top: annotationMenu.y,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {annotationMenu.kind === "flag" ? (
              <StoryboardFlagMenuItems
                checkedFlag={annotationMenuFlag}
                onSelect={(flag) => {
                  setShotFlags(annotationMenuShotIds, flag);
                  setAnnotationMenu(null);
                }}
              />
            ) : (
              <StoryboardColorMenuItems
                checkedColorLabel={annotationMenuColorLabel}
                onSelect={(colorLabel) => {
                  setShotColorLabels(annotationMenuShotIds, colorLabel);
                  setAnnotationMenu(null);
                }}
              />
            )}
          </PopupMenu>,
          document.body,
        )}
    </section>
  );
}
