import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownAZ,
  ArrowDownZA,
  ChevronDown,
  ChevronsUpDown,
  Film,
  Grid2X2,
  List,
  ListFilter,
  Loader2,
  Scissors,
  Search,
  Star,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
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
import { mediaDisplayName, useProjectPort } from "../../systems/ProjectSystem";
import {
  buildStoryboardExportSource,
  requestExport,
  runQuickExport,
} from "../../systems/ExportSystem";
import { createTaskProgress, useTaskProgressStatus } from "../../systems/TaskSystem";
import { requestStoryboardThumbnail } from "../../storyboardThumbnail";
import { isTauriRuntime } from "../../tauriRuntime";
import { normalizeFrameRate } from "../../timeline";
import type { StoryboardDetectionResult, StoryboardShot } from "../../types";
import { usePanelManagerState } from "../DockLayout";
import {
  isPopupMenuEventTarget,
  PopupMenu,
  PopupMenuItem,
  PopupMenuSeparator,
  PopupMenuSubmenu,
} from "../PopupMenu";
import "./StoryboardPanel.css";
import {
  StoryboardColorLabelButtons,
  storyboardShotColorLabelValues,
  storyboardShotColorFilterLabels,
  storyboardShotColorLabels,
} from "./StoryboardColorLabelButtons";
import { StoryboardIconView } from "./StoryboardIconView";
import { StoryboardKeywordPanel } from "./StoryboardKeywordPanel";
import {
  formatParsedStoryboardKeywords,
  parseStoryboardKeywordInput,
  storyboardKeywordSearchValues,
  storyboardMatchesQuickFilter,
} from "./storyboardKeywords";
import { StoryboardListView } from "./StoryboardListView";
import {
  formatStoryboardKeywords,
  useStoryboardPanelState,
  type StoryboardKeywordNode,
  type StoryboardRatingComparator,
  type StoryboardSearchRule,
  type StoryboardSearchScope,
  type StoryboardShotAnnotation,
  type StoryboardShotColorLabel,
  type StoryboardShotColorLabelFilter,
  type StoryboardShotEditFilter,
  type StoryboardShotFlag,
  type StoryboardShotStack,
  type StoryboardShotVisualLabel,
  type StoryboardViewMode,
} from "./storyboardPanelState";

const storyboardEventSource = eventSource("storyboard-panel");
const MIN_UPCOMING_SCROLL_DURATION_MS = 1000;
const MAX_UPCOMING_SCROLL_DURATION_MS = 1200;
const THUMBNAIL_PREFETCH_ROWS_BEFORE = 10;
const THUMBNAIL_PREFETCH_ROWS_AFTER = 28;
const STORYBOARD_THUMBNAIL_HEIGHT = 46;
const STORYBOARD_THUMBNAIL_WIDTH = 82;
const STORYBOARD_ROW_VERTICAL_PADDING = 36;
const STORYBOARD_THUMBNAIL_COLUMN_PADDING = 16;
const STORYBOARD_STATUS_GUTTER_WIDTH = 16;

type StoryboardResizableColumnId =
  | "thumbnail"
  | "title"
  | "mediaStart"
  | "mediaEnd"
  | "duration"
  | "keywords"
  | "label"
  | "rating"
  | "retained";
type StoryboardSortableColumnId =
  | "title"
  | "mediaStart"
  | "mediaEnd"
  | "duration"
  | "keywords"
  | "rating"
  | "retained"
  | "colorLabel";
type StoryboardTableColumnId = StoryboardResizableColumnId | "trailing";
type StoryboardSortDirection = "ascending" | "descending";

interface StoryboardSort {
  columnId: StoryboardSortableColumnId;
  direction: StoryboardSortDirection;
}

const defaultStoryboardSort: StoryboardSort = {
  columnId: "mediaStart",
  direction: "ascending",
};

const defaultStoryboardGridSort: StoryboardSort = {
  columnId: "mediaStart",
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
  { id: "keywords", label: "关键字", sortColumnId: "keywords", resizeColumn: "duration" },
  { id: "rating", label: "星级", sortColumnId: "rating", resizeColumn: "keywords" },
  { id: "retained", label: "留用", resizeColumn: "rating" },
  { id: "label", label: "标签", sortColumnId: "colorLabel", resizeColumn: "retained" },
  { id: "trailing", label: "", resizeColumn: "label" },
];

const storyboardGridSortOptions: Array<{
  id: StoryboardSortableColumnId;
  label: string;
  defaultDirection: StoryboardSortDirection;
}> = [
  { id: "title", label: "标题", defaultDirection: "ascending" },
  { id: "mediaStart", label: "媒体开始", defaultDirection: "ascending" },
  { id: "mediaEnd", label: "媒体结束", defaultDirection: "ascending" },
  { id: "duration", label: "媒体持续时间", defaultDirection: "ascending" },
  { id: "keywords", label: "关键字", defaultDirection: "ascending" },
  { id: "rating", label: "星级", defaultDirection: "descending" },
  { id: "retained", label: "留用", defaultDirection: "ascending" },
  { id: "colorLabel", label: "标签", defaultDirection: "ascending" },
];

type StoryboardResizableColumnWidths = Record<StoryboardResizableColumnId, number>;

const initialStoryboardColumnWidths: StoryboardResizableColumnWidths = {
  thumbnail: 104,
  title: 128,
  mediaStart: 128,
  mediaEnd: 128,
  duration: 140,
  keywords: 128,
  label: 128,
  rating: 112,
  retained: 128,
};

const minimumStoryboardColumnWidths: StoryboardResizableColumnWidths = {
  thumbnail: 60,
  title: 38,
  mediaStart: 21,
  mediaEnd: 21,
  duration: 21,
  keywords: 38,
  label: 38,
  rating: 30,
  retained: 21,
};

const maximumStoryboardColumnWidths: StoryboardResizableColumnWidths = {
  thumbnail: 720,
  title: 720,
  mediaStart: 300,
  mediaEnd: 300,
  duration: 320,
  keywords: 720,
  label: 720,
  rating: 180,
  retained: 300,
};

const storyboardResizableColumnLabels: Record<StoryboardResizableColumnId, string> = {
  thumbnail: "缩略图",
  title: "标题",
  mediaStart: "媒体开始",
  mediaEnd: "媒体结束",
  duration: "媒体持续时间",
  keywords: "关键字",
  label: "标签",
  rating: "星级",
  retained: "留用",
};

const storyboardRatingFilters = [1, 2, 3, 4, 5] as const;
const storyboardRatingComparatorOptions: Array<readonly [StoryboardRatingComparator, string]> = [
  ["gte", "星级大于等于"],
  ["lte", "星级小于等于"],
  ["eq", "星级等于"],
];
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
const storyboardSearchScopeLabels: Record<StoryboardSearchScope, string> = {
  any: "任何可搜索的字段",
  title: "标题",
  keywords: "关键字",
};
const storyboardSearchRuleLabels: Record<StoryboardSearchRule, string> = {
  contains: "包含",
  containsAll: "包含所有",
  containsWords: "包含单词",
  doesNotContain: "不含",
  startsWith: "开头为",
  endsWith: "结尾为",
  isEmpty: "为空",
  isNotEmpty: "不为空",
};
const storyboardShotFlags: StoryboardShotFlag[] = ["retained", "none", "excluded"];
const storyboardShotEditFilters: StoryboardShotEditFilter[] = ["edited", "unedited"];
const storyboardShotFlagLabels: Record<StoryboardShotFlag, string> = {
  retained: "留用旗标",
  none: "无旗标",
  excluded: "排除旗标",
};
const storyboardTitleCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const storyboardColorLabelNames = Object.fromEntries(storyboardShotColorLabels) as Record<
  StoryboardShotColorLabel,
  string
>;

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
  exportSubmenuOpen: boolean;
}

interface StoryboardAnnotationMenuState {
  kind: "flag" | "color";
  x: number;
  y: number;
  shotId: string;
}

interface StoryboardMenuAnchor {
  x: number;
  y: number;
}

type StoryboardSprayMode = "keywords" | "colorLabel" | "flag" | "rating";

const storyboardSprayModeOptions: Array<readonly [StoryboardSprayMode, string]> = [
  ["keywords", "关键字"],
  ["colorLabel", "标签"],
  ["flag", "旗标"],
  ["rating", "星级"],
];

const storyboardSprayModeLabels = Object.fromEntries(storyboardSprayModeOptions) as Record<
  StoryboardSprayMode,
  string
>;

interface StoryboardFooterAreaVisibility {
  colorLabel: boolean;
  flag: boolean;
  rating: boolean;
  selection: boolean;
  sprayTool: boolean;
  viewMode: boolean;
  sort: Record<StoryboardViewMode, boolean>;
  thumbnailSize: boolean;
}

const defaultStoryboardFooterAreaVisibility: StoryboardFooterAreaVisibility = {
  colorLabel: false,
  flag: false,
  rating: false,
  selection: true,
  sprayTool: true,
  viewMode: true,
  sort: {
    list: false,
    grid: true,
  },
  thumbnailSize: true,
};

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

function storyboardShotLabel(annotation: StoryboardShotAnnotation | undefined) {
  const customLabel = annotation?.customLabel?.trim() ?? "";
  if (customLabel) {
    return customLabel;
  }
  return annotation?.colorLabel ? storyboardColorLabelNames[annotation.colorLabel] : "";
}

function storyboardShotVisualLabel(
  annotation: StoryboardShotAnnotation | undefined,
): StoryboardShotVisualLabel | undefined {
  return annotation?.customLabel?.trim() ? "custom" : annotation?.colorLabel || undefined;
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

function storyboardShotIsEdited(annotation: StoryboardShotAnnotation | undefined) {
  return Boolean(
    annotation &&
    ((annotation.rating ?? 0) > 0 ||
      annotation.retained ||
      annotation.excluded ||
      annotation.title?.trim() ||
      annotation.keywordIds?.length ||
      annotation.colorLabel ||
      annotation.customLabel?.trim()),
  );
}

function storyboardSearchTerms(query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) {
    return [];
  }
  return normalized.match(/[\p{L}\p{N}_]+/gu) ?? [normalized];
}

function containsWholeSearchWord(value: string, term: string) {
  const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapedTerm}(?:$|[^\\p{L}\\p{N}_])`, "u").test(value);
}

function shotMatchesSearch(
  shot: StoryboardShot,
  annotation: StoryboardShotAnnotation | undefined,
  shotCount: number,
  keywordNodes: readonly StoryboardKeywordNode[],
  query: string,
  scope: StoryboardSearchScope,
  rule: StoryboardSearchRule,
) {
  const values = [
    ...(scope === "any" || scope === "title"
      ? [storyboardShotTitle(shot, shotCount, annotation)]
      : []),
    ...(scope === "any" || scope === "keywords"
      ? storyboardKeywordSearchValues(annotation?.keywordIds, keywordNodes)
      : []),
  ].map((value) => value.trim().toLocaleLowerCase());
  const populatedValues = values.filter(Boolean);
  if (rule === "isEmpty") {
    return populatedValues.length === 0;
  }
  if (rule === "isNotEmpty") {
    return populatedValues.length > 0;
  }
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  const terms = storyboardSearchTerms(query);
  const searchableText = populatedValues.join(" ");
  if (rule === "contains") {
    return terms.some((term) => searchableText.includes(term));
  }
  if (rule === "containsAll") {
    return terms.every((term) => searchableText.includes(term));
  }
  if (rule === "containsWords") {
    return terms.every((term) => containsWholeSearchWord(searchableText, term));
  }
  if (rule === "doesNotContain") {
    return terms.every((term) => !searchableText.includes(term));
  }
  if (rule === "startsWith") {
    return populatedValues.some((value) => value.startsWith(normalizedQuery));
  }
  return populatedValues.some((value) => value.endsWith(normalizedQuery));
}

function shotMatchesFilter(
  annotation: StoryboardShotAnnotation | undefined,
  minimumRating: number,
  ratingComparator: StoryboardRatingComparator,
  flagFilters: readonly StoryboardShotFlag[],
  editFilters: readonly StoryboardShotEditFilter[],
  colorLabelFilters: readonly StoryboardShotColorLabelFilter[],
) {
  const rating = annotation?.rating ?? 0;
  const flag = storyboardShotFlag(annotation);
  const colorLabel = storyboardShotVisualLabel(annotation) ?? "none";
  const matchesRating =
    minimumRating === 0 ||
    (ratingComparator === "gte"
      ? rating >= minimumRating
      : ratingComparator === "lte"
        ? rating <= minimumRating
        : rating === minimumRating);

  const matchesColorLabel =
    colorLabelFilters.length === 0 || colorLabelFilters.includes(colorLabel);
  const matchesFlag = flagFilters.length === 0 || flagFilters.includes(flag);
  const editState: StoryboardShotEditFilter = storyboardShotIsEdited(annotation)
    ? "edited"
    : "unedited";
  const matchesEdit = editFilters.length === 0 || editFilters.includes(editState);
  return matchesFlag && matchesEdit && matchesRating && matchesColorLabel;
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

interface StoryboardDropdownTriggerProps {
  label: string;
  value: string;
  open: boolean;
  disabled?: boolean;
  className?: string;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

function StoryboardDropdownTrigger({
  label,
  value,
  open,
  disabled,
  className = "",
  onClick,
}: StoryboardDropdownTriggerProps) {
  return (
    <button
      type="button"
      className={`storyboard-footer-sort-trigger ${className} ${open ? "active" : ""}`.trim()}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      <span className="storyboard-footer-sort-label">{label}</span>
      <span className="storyboard-footer-sort-value">{value}</span>
      <ChevronsUpDown aria-hidden="true" />
    </button>
  );
}

function storyboardSprayBottleMarkSvg(
  mode: StoryboardSprayMode,
  flag: StoryboardShotFlag,
  rating: number,
  customLabel: boolean,
) {
  if (mode === "keywords") {
    return '<text x="10" y="17.8" fill="#fff" font-family="Arial,sans-serif" font-size="7.5" font-weight="700" text-anchor="middle">K</text>';
  }
  if (mode === "colorLabel" && customLabel) {
    return '<text x="10" y="17.8" fill="#fff" font-family="Arial,sans-serif" font-size="7.5" font-weight="700" text-anchor="middle">T</text>';
  }
  if (mode === "flag" && flag !== "none") {
    const excludedMark =
      flag === "excluded"
        ? '<path d="M8.4 12.2l3.5 2.6m0-2.6-3.5 2.6" stroke="#1d1d1d" stroke-width=".75"/>'
        : "";
    return `<path d="M7.2 11v7" stroke="#d9d9d9" stroke-width=".9"/><rect x="8" y="11.7" width="4.4" height="3.6" fill="#fff"/>${excludedMark}`;
  }
  if (mode === "rating") {
    return `<text x="10" y="17.8" fill="#fff" font-family="Arial,sans-serif" font-size="7.5" font-weight="700" text-anchor="middle">${rating}</text>`;
  }
  return "";
}

function storyboardSprayCursor(
  fillColor: string,
  mode: StoryboardSprayMode,
  flag: StoryboardShotFlag,
  rating: number,
  customLabel: boolean,
) {
  const mark = storyboardSprayBottleMarkSvg(mode, flag, rating, customLabel);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="17" height="20" viewBox="0 0 20 24"><path d="M8.25 1.5h3.5v2h-3.5zM9 3.5h2v2H9zM6.5 5.5h7v2.25h-7z" fill="#d0d0d0"/><path d="M6.25 8.25h7.5l1.5 2.25v10.25H4.75V10.5l1.5-2.25Z" fill="${fillColor}" stroke="#d0d0d0" stroke-width="1.25" stroke-linejoin="round"/><path d="M4 21.25h12v1.5H4z" fill="${fillColor}" stroke="#d0d0d0"/><path d="M6.25 11h7.5M6.25 18.75h7.5" stroke="#686868" stroke-width=".75"/>${mark}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 8 2, crosshair`;
}

interface StoryboardSprayBottleIconProps {
  fillColor: string;
  mode: StoryboardSprayMode;
  flag: StoryboardShotFlag;
  rating: number;
  customLabel: boolean;
}

function StoryboardSprayBottleIcon({
  fillColor,
  mode,
  flag,
  rating,
  customLabel,
}: StoryboardSprayBottleIconProps) {
  return (
    <svg
      className="storyboard-spray-bottle-icon"
      viewBox="0 0 20 24"
      fill="none"
      aria-hidden="true"
    >
      <path d="M8.25 1.5h3.5v2h-3.5z" fill="currentColor" />
      <path d="M9 3.5h2v2H9z" fill="currentColor" />
      <path d="M6.5 5.5h7v2.25h-7z" fill="currentColor" />
      <path
        d="M6.25 8.25h7.5l1.5 2.25v10.25H4.75V10.5l1.5-2.25Z"
        fill={fillColor}
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.25"
      />
      <path d="M4 21.25h12v1.5H4z" fill={fillColor} stroke="currentColor" strokeWidth="1" />
      <path d="M6.25 11h7.5M6.25 18.75h7.5" stroke="#686868" strokeWidth="0.75" />
      {mode === "keywords" && (
        <text
          x="10"
          y="17.8"
          fill="#fff"
          fontFamily="Arial, sans-serif"
          fontSize="7.5"
          fontWeight="700"
          textAnchor="middle"
        >
          K
        </text>
      )}
      {mode === "colorLabel" && customLabel && (
        <text
          x="10"
          y="17.8"
          fill="#fff"
          fontFamily="Arial, sans-serif"
          fontSize="7.5"
          fontWeight="700"
          textAnchor="middle"
        >
          T
        </text>
      )}
      {mode === "flag" && flag !== "none" && (
        <>
          <path d="M7.2 11v7" stroke="#d9d9d9" strokeWidth="0.9" />
          <rect x="8" y="11.7" width="4.4" height="3.6" fill="#fff" />
          {flag === "excluded" && (
            <path d="M8.4 12.2l3.5 2.6m0-2.6-3.5 2.6" stroke="#1d1d1d" strokeWidth="0.75" />
          )}
        </>
      )}
      {mode === "rating" && (
        <text
          x="10"
          y="17.8"
          fill="#fff"
          fontFamily="Arial, sans-serif"
          fontSize="7.5"
          fontWeight="700"
          textAnchor="middle"
        >
          {rating}
        </text>
      )}
    </svg>
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

function StoryboardEditFilterIcon({ edited }: { edited: boolean }) {
  return (
    <svg className="storyboard-edit-filter-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.35" shapeRendering="crispEdges">
        <path d="M2 6h5m4 0h11M2 12h10m4 0h6M2 18h3m4 0h13" />
        <path d="M9 3.5v5M14 9.5v5M7 15.5v5" />
        {!edited && <path d="M3 3l18 18" strokeWidth="2" shapeRendering="auto" />}
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
  checkedColorLabel: StoryboardShotVisualLabel | null | undefined;
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
  keywordNodes: readonly StoryboardKeywordNode[],
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
  if (columnId === "keywords") {
    return formatStoryboardKeywords(annotation?.keywordIds, keywordNodes);
  }
  if (columnId === "colorLabel") {
    return storyboardShotLabel(annotation);
  }
  const flag = storyboardShotFlag(annotation);
  return flag === "retained" ? 0 : flag === "none" ? 1 : 2;
}

function sortStoryboardShots(
  shots: readonly StoryboardShot[],
  sort: StoryboardSort,
  shotAnnotations: Record<string, StoryboardShotAnnotation>,
  keywordNodes: readonly StoryboardKeywordNode[],
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
        storyboardShotSortValue(
          leftSortShot,
          sort.columnId,
          shotAnnotations,
          keywordNodes,
          shotCount,
        ),
        storyboardShotSortValue(
          rightSortShot,
          sort.columnId,
          shotAnnotations,
          keywordNodes,
          shotCount,
        ),
      );
      return (
        valueDelta * direction ||
        left.shot.sequence - right.shot.sequence ||
        left.index - right.index
      );
    })
    .map(({ shot }) => shot);
}

export function StoryboardPanel() {
  const panelInstanceId = usePanelInstanceId();
  const panelActive = usePanelActive();
  const focusedPanelId = usePanelManagerState((state) => state.focusedPanelId);
  const identity = useStableIdentity("storyboard-panel", panelInstanceId);
  const {
    project,
    activeVideoId,
    mediaItems,
    projects,
    storyboards,
    exportState,
    messagePublished,
  } = useProjectPort(
    ["project", "activeVideoId", "mediaItems", "projects", "storyboards", "exportState"],
    ["messagePublished"],
  );
  const {
    query,
    searchScope,
    searchRule,
    showOnlySelected,
    minimumRating,
    ratingComparator,
    flagFilters,
    editFilters,
    colorLabelFilters,
    quickFilterKeywordIds,
    activeShotId,
    shots,
    shotStacks,
    keywordNodes,
    selectedShotIds,
    shotAnnotations,
    detectingVideoContext,
    viewMode,
    thumbnailSize,
    gridSize,
    syncVideoContext,
    setQuery,
    setSearchScope,
    setSearchRule,
    setShowOnlySelected,
    setMinimumRating,
    setRatingComparator,
    setFlagFilters,
    setEditFilters,
    setColorLabelFilters,
    setViewMode,
    setThumbnailSize,
    setGridSize,
    setShotRatings,
    adjustShotRatings,
    setShotFlags,
    setShotColorLabels,
    setShotCustomLabels,
    appendShotKeywords,
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
  const contentLayoutRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const tableHeaderRef = useRef<HTMLDivElement | null>(null);
  const scrollAnimationRef = useRef<number | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const selectionFocusRef = useRef<string | null>(null);
  const marqueeCleanupRef = useRef<(() => void) | null>(null);
  const sprayGestureCleanupRef = useRef<(() => void) | null>(null);
  const keywordResizeCleanupRef = useRef<(() => void) | null>(null);
  const hadShotsRef = useRef(shots.length > 0);
  const [shotSort, setShotSort] = useState<StoryboardSort>(defaultStoryboardSort);
  const [gridShotSort, setGridShotSort] = useState<StoryboardSort>(defaultStoryboardGridSort);
  const [ratingComparatorMenu, setRatingComparatorMenu] = useState<StoryboardMenuAnchor | null>(
    null,
  );
  const [searchScopeMenu, setSearchScopeMenu] = useState<StoryboardMenuAnchor | null>(null);
  const [searchRuleMenu, setSearchRuleMenu] = useState<StoryboardMenuAnchor | null>(null);
  const [footerSortMenu, setFooterSortMenu] = useState<StoryboardMenuAnchor | null>(null);
  const [footerSprayMenu, setFooterSprayMenu] = useState<StoryboardMenuAnchor | null>(null);
  const [footerOptionsMenu, setFooterOptionsMenu] = useState<StoryboardMenuAnchor | null>(null);
  const [sprayActive, setSprayActive] = useState(false);
  const [sprayMode, setSprayMode] = useState<StoryboardSprayMode>("keywords");
  const [sprayKeywordInput, setSprayKeywordInput] = useState("");
  const [sprayColorLabel, setSprayColorLabel] = useState<StoryboardShotColorLabel | null>(null);
  const [sprayCustomLabel, setSprayCustomLabel] = useState("");
  const [sprayFlag, setSprayFlag] = useState<StoryboardShotFlag>("none");
  const [sprayRating, setSprayRating] = useState(0);
  const [storyboardViewRatio, setStoryboardViewRatio] = useState(2 / 3);
  const [keywordPanelOpen, setKeywordPanelOpen] = useState(true);
  const [footerAreaVisibility, setFooterAreaVisibility] = useState(
    defaultStoryboardFooterAreaVisibility,
  );
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
  const videoLabel = mediaDisplayName(project, mediaItems, activeVideoId) || "未选择视频";
  const canDetect = isTauriRuntime() && Boolean(project) && hasVideo && !isDetecting;
  const selectedCount = selectedShotIds.size;
  const hasSecondarySelection =
    selectedCount > (activeShotId && selectedShotIds.has(activeShotId) ? 1 : 0);
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
          shotMatchesSearch(
            shot,
            shotAnnotations[shot.id],
            shotCount,
            keywordNodes,
            query,
            searchScope,
            searchRule,
          ) &&
          shotMatchesFilter(
            shotAnnotations[shot.id],
            minimumRating,
            ratingComparator,
            flagFilters,
            editFilters,
            colorLabelFilters,
          ) &&
          storyboardMatchesQuickFilter(
            shotAnnotations[shot.id]?.keywordIds,
            keywordNodes,
            quickFilterKeywordIds,
          ),
      ),
    [
      displayShots,
      colorLabelFilters,
      editFilters,
      flagFilters,
      minimumRating,
      keywordNodes,
      query,
      quickFilterKeywordIds,
      ratingComparator,
      searchRule,
      searchScope,
      selectedShotIds,
      shotCount,
      shotAnnotations,
      showOnlySelected,
    ],
  );
  const activeShotSort = viewMode === "grid" ? gridShotSort : shotSort;
  const setActiveShotSort = viewMode === "grid" ? setGridShotSort : setShotSort;
  const sortedShots = useMemo(
    () =>
      sortStoryboardShots(
        filteredShots,
        activeShotSort,
        shotAnnotations,
        keywordNodes,
        shotCount,
        sortShotsById,
      ),
    [activeShotSort, filteredShots, keywordNodes, shotAnnotations, shotCount, sortShotsById],
  );
  const footerSortLabel =
    storyboardGridSortOptions.find((option) => option.id === activeShotSort.columnId)?.label ??
    "标题";
  const footerSortVisible = footerAreaVisibility.sort[viewMode];
  const sprayKeywordParseResult = parseStoryboardKeywordInput(sprayKeywordInput);
  const sprayKeywords = sprayKeywordParseResult.paths;
  const sprayKeywordsDisplay = formatParsedStoryboardKeywords(sprayKeywords);
  const sprayUsesCustomLabel = sprayMode === "colorLabel" && sprayCustomLabel.trim().length > 0;
  const sprayBottleFillColor =
    sprayMode === "colorLabel" && sprayColorLabel
      ? storyboardShotColorLabelValues[sprayColorLabel]
      : "#252525";
  const panelStyle = {
    "--storyboard-spray-cursor": storyboardSprayCursor(
      sprayBottleFillColor,
      sprayMode,
      sprayFlag,
      sprayRating,
      sprayUsesCustomLabel,
    ),
  } as CSSProperties;
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
  const gridScale = gridSize < 34 ? 1 : gridSize < 67 ? 1.3 : 1.6;
  const gridCardWidth = 200 * gridScale;
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
    storyboardColumnWidths.keywords +
    storyboardColumnWidths.label +
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
    "--storyboard-col-keywords": `${storyboardColumnWidths.keywords}px`,
    "--storyboard-col-label": `${storyboardColumnWidths.label}px`,
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
    count: viewMode === "list" ? sortedShots.length : 0,
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
  const keywordPanelShotIds = contextMenuShotIds;
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
    (shotId) => storyboardShotVisualLabel(shotAnnotations[shotId]) ?? null,
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
    (shotId) => storyboardShotVisualLabel(shotAnnotations[shotId]) ?? null,
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
      contextMenu.stackSubmenuOpen ||
      contextMenu.exportSubmenuOpen),
  );

  useEffect(() => {
    if (viewMode === "list") {
      rowVirtualizer.measure();
    }
  }, [rowVirtualizer, storyboardRowHeight, viewMode]);

  useEffect(() => {
    syncVideoContext(videoContext);
    sprayGestureCleanupRef.current?.();
    setSprayActive(false);
    setContextMenu(null);
    setAnnotationMenu(null);
    setRatingComparatorMenu(null);
    setSearchScopeMenu(null);
    setSearchRuleMenu(null);
    setFooterSortMenu(null);
    setFooterSprayMenu(null);
    setFooterOptionsMenu(null);
    setGridShotSort(defaultStoryboardGridSort);
  }, [syncVideoContext, videoContext]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const close = (event?: Event) => {
      if (event && isPopupMenuEventTarget(event.target)) {
        return;
      }
      setContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!annotationMenu) {
      return;
    }
    const close = (event?: Event) => {
      if (event && isPopupMenuEventTarget(event.target)) {
        return;
      }
      setAnnotationMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [annotationMenu]);

  useEffect(() => {
    if (!ratingComparatorMenu) {
      return;
    }
    const close = () => setRatingComparatorMenu(null);
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
  }, [ratingComparatorMenu]);

  useEffect(() => {
    if (!searchScopeMenu && !searchRuleMenu) {
      return;
    }
    const close = () => {
      setSearchScopeMenu(null);
      setSearchRuleMenu(null);
    };
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
  }, [searchRuleMenu, searchScopeMenu]);

  useEffect(() => {
    if (!footerSortMenu) {
      return;
    }
    const close = () => setFooterSortMenu(null);
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
  }, [footerSortMenu]);

  useEffect(() => {
    if (!footerSprayMenu) {
      return;
    }
    const close = () => setFooterSprayMenu(null);
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
  }, [footerSprayMenu]);

  useEffect(() => {
    if (!footerOptionsMenu) {
      return;
    }
    const close = () => setFooterOptionsMenu(null);
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
  }, [footerOptionsMenu]);

  useEffect(() => {
    setFooterSortMenu(null);
    setFooterSprayMenu(null);
  }, [viewMode]);

  useEffect(() => {
    if (sprayActive) {
      return;
    }
    sprayGestureCleanupRef.current?.();
    setFooterSprayMenu(null);
  }, [sprayActive]);

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
      const grid = listRef.current?.querySelector<HTMLElement>(".storyboard-icon-grid");
      const gridColumnCount =
        viewMode === "grid" && grid
          ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").length)
          : 1;
      const direction =
        event.key === "ArrowLeft"
          ? -1
          : event.key === "ArrowRight"
            ? 1
            : event.key === "ArrowUp"
              ? -gridColumnCount
              : event.key === "ArrowDown"
                ? gridColumnCount
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
      const scrollToTarget = () => {
        if (viewMode === "list") {
          rowVirtualizer.scrollToIndex(targetIndex, { align: "auto" });
          return;
        }
        Array.from(
          listRef.current?.querySelectorAll<HTMLElement>("[data-storyboard-shot-id]") ?? [],
        )
          .find((element) => element.dataset.storyboardShotId === targetId)
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      };

      if (!event.shiftKey) {
        selectionAnchorRef.current = targetId;
        shotSelectionReplaced([targetId], targetId);
        scrollToTarget();
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
      const primaryShotId =
        activeShotId && nextSelection.has(activeShotId) ? activeShotId : targetId;
      shotSelectionReplaced(Array.from(nextSelection), primaryShotId);
      scrollToTarget();
    };

    panel.addEventListener("keydown", handleSelectionKeyDown);
    return () => panel.removeEventListener("keydown", handleSelectionKeyDown);
  }, [activeShotId, rowVirtualizer, selectedShotIds, shotSelectionReplaced, sortedShots, viewMode]);

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
      marqueeCleanupRef.current?.();
      sprayGestureCleanupRef.current?.();
      keywordResizeCleanupRef.current?.();
      document.body.classList.remove("is-resizing-storyboard-column");
      document.body.classList.remove("is-resizing-storyboard-keyword-panel");
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
    if (viewMode === "grid") {
      Array.from(list.querySelectorAll<HTMLElement>("[data-storyboard-shot-id]"))
        .find((element) => element.dataset.storyboardShotId === shot.id)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
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
  }, [followShotId, followShotIndex, frameRate, isPlaying, rowVirtualizer, sortedShots, viewMode]);

  useEffect(() => {
    if (
      viewMode !== "list" ||
      !thumbnailVideoPath ||
      thumbnailPrefetchStart >= thumbnailPrefetchEnd
    ) {
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
    viewMode,
  ]);

  function clearShotSelection() {
    const primaryShotId =
      activeShotId && selectedShotIds.has(activeShotId)
        ? activeShotId
        : (selectedShotIds.values().next().value ?? null);
    selectionAnchorRef.current = primaryShotId;
    selectionFocusRef.current = primaryShotId;
    if (primaryShotId) {
      shotSelectionReplaced([primaryShotId], primaryShotId);
      return;
    }
    shotSelectionCleared();
  }

  function deactivateSprayTool() {
    sprayGestureCleanupRef.current?.();
    setFooterSprayMenu(null);
    setSprayActive(false);
  }

  function applySprayToShot(shotId: string, historyGroupId: string) {
    const targetShotIds = annotationShotIdsForSelection([shotId], shotStacksByShotId);
    if (sprayMode === "keywords") {
      appendShotKeywords(targetShotIds, sprayKeywordInput, historyGroupId);
      return;
    }
    if (sprayMode === "colorLabel") {
      const customLabel = sprayCustomLabel.trim();
      if (customLabel) {
        setShotCustomLabels(targetShotIds, customLabel, historyGroupId);
      } else {
        setShotColorLabels(targetShotIds, sprayColorLabel, historyGroupId);
      }
      return;
    }
    if (sprayMode === "flag") {
      setShotFlags(targetShotIds, sprayFlag, historyGroupId);
      return;
    }
    setShotRatings(targetShotIds, sprayRating, historyGroupId);
  }

  function sprayShotIdFromPoint(target: EventTarget | null, clientX: number, clientY: number) {
    const element = target instanceof Element ? target : null;
    if (!element || !panelRef.current?.contains(element)) {
      return null;
    }
    const shotElement = element.closest<HTMLElement>("[data-storyboard-shot-id]");
    const thumbnail = shotElement?.querySelector<HTMLElement>(".shot-frame-button");
    if (!shotElement || !thumbnail) {
      return null;
    }
    const bounds = thumbnail.getBoundingClientRect();
    return clientX >= bounds.left &&
      clientX <= bounds.right &&
      clientY >= bounds.top &&
      clientY <= bounds.bottom
      ? (shotElement.dataset.storyboardShotId ?? null)
      : null;
  }

  function startSprayGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sprayActive || event.button !== 0 || !event.isPrimary) {
      return;
    }
    const initialShotId = sprayShotIdFromPoint(event.target, event.clientX, event.clientY);
    if (!initialShotId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    panelRef.current?.focus({ preventScroll: true });
    sprayGestureCleanupRef.current?.();

    const pointerId = event.pointerId;
    const historyGroupId = `storyboard-spray-${Date.now()}-${pointerId}`;
    const paintedShotIds = new Set<string>();
    const paintTarget = (target: EventTarget | null, clientX: number, clientY: number) => {
      const shotId = sprayShotIdFromPoint(target, clientX, clientY);
      if (!shotId || paintedShotIds.has(shotId)) {
        return;
      }
      paintedShotIds.add(shotId);
      applySprayToShot(shotId, historyGroupId);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onFinish);
      window.removeEventListener("pointercancel", onFinish);
      window.removeEventListener("blur", cleanup);
      if (sprayGestureCleanupRef.current === cleanup) {
        sprayGestureCleanupRef.current = null;
      }
    };
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      moveEvent.preventDefault();
      paintTarget(
        document.elementFromPoint(moveEvent.clientX, moveEvent.clientY),
        moveEvent.clientX,
        moveEvent.clientY,
      );
    };
    const onFinish = (finishEvent: globalThis.PointerEvent) => {
      if (finishEvent.pointerId === pointerId) {
        cleanup();
      }
    };

    sprayGestureCleanupRef.current = cleanup;
    paintedShotIds.add(initialShotId);
    applySprayToShot(initialShotId, historyGroupId);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onFinish);
    window.addEventListener("pointercancel", onFinish);
    window.addEventListener("blur", cleanup);
  }

  function suppressSprayClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (
      !sprayActive ||
      event.button !== 0 ||
      !sprayShotIdFromPoint(event.target, event.clientX, event.clientY)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
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

  function startKeywordPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    const layout = contentLayoutRef.current;
    if (!layout) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    keywordResizeCleanupRef.current?.();
    document.body.classList.add("is-resizing-storyboard-keyword-panel");
    const bounds = layout.getBoundingClientRect();
    const layoutStyle = getComputedStyle(layout);
    const paddingLeft = Number.parseFloat(layoutStyle.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(layoutStyle.paddingRight) || 0;
    const resizeHandleWidth = 4;
    const availableWidth = Math.max(
      1,
      bounds.width - paddingLeft - paddingRight - resizeHandleWidth,
    );
    const update = (clientX: number) => {
      const ratio = (clientX - bounds.left - paddingLeft - resizeHandleWidth / 2) / availableWidth;
      setStoryboardViewRatio(Math.min(0.8, Math.max(0.35, ratio)));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("is-resizing-storyboard-keyword-panel");
      if (keywordResizeCleanupRef.current === cleanup) {
        keywordResizeCleanupRef.current = null;
      }
    };
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      moveEvent.preventDefault();
      update(moveEvent.clientX);
    };
    const onUp = (upEvent: globalThis.PointerEvent) => {
      update(upEvent.clientX);
      cleanup();
    };
    keywordResizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function openAnnotationMenu(
    event: ReactMouseEvent<HTMLButtonElement>,
    shotId: string,
    kind: StoryboardAnnotationMenuState["kind"],
  ) {
    event.preventDefault();
    event.stopPropagation();
    panelRef.current?.focus({ preventScroll: true });
    setContextMenu(null);
    setAnnotationMenu({
      kind,
      x: event.clientX,
      y: event.clientY,
      shotId,
    });
  }

  function buildCurrentStoryboardSource() {
    return buildStoryboardExportSource({
      videoId: activeVideoId,
      assetId: project?.asset.id ?? "",
      fingerprint: project?.asset.fingerprint ?? "",
      shotIds: contextMenuShotIds,
      storyboards,
      mediaItems,
      projects,
    });
  }

  function exportSelectedShots() {
    const source = buildCurrentStoryboardSource();
    if (source) {
      requestExport(source);
      setContextMenu(null);
    }
  }

  async function quickExportWithLastSettings() {
    const source = buildCurrentStoryboardSource();
    if (!source || !exportState) {
      return;
    }
    const outcome = await runQuickExport(source, exportState);
    if (outcome.status === "success") {
      const completed = outcome.result.outputs.filter(
        (output) => output.status === "completed",
      ).length;
      const failed = outcome.result.outputs.filter((output) => output.status === "failed").length;
      messagePublished(`已导出 ${completed} 个片段${failed > 0 ? `，${failed} 个失败` : ""}`);
    } else if (outcome.status === "cancelled") {
      messagePublished("导出已取消");
    }
    setContextMenu(null);
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
      exportSubmenuOpen: false,
    });
  }

  function selectVisibleShots() {
    selectionAnchorRef.current = null;
    selectionFocusRef.current = null;
    const nextSelection = new Set(selectedShotIds);
    for (const shot of sortedShots) {
      nextSelection.add(shot.id);
    }
    const primaryShotId =
      activeShotId && nextSelection.has(activeShotId)
        ? activeShotId
        : (nextSelection.values().next().value ?? null);
    shotSelectionReplaced(Array.from(nextSelection), primaryShotId);
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
      if (!additive) {
        selectionAnchorRef.current = shot.id;
      }
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
    setMinimumRating(nextMinimum);
  }

  function toggleFlagFilter(flag: StoryboardShotFlag) {
    const nextFlagFilters = flagFilters.includes(flag)
      ? flagFilters.filter((current) => current !== flag)
      : storyboardShotFlags.filter((current) => current === flag || flagFilters.includes(current));
    setFlagFilters(nextFlagFilters);
  }

  function toggleEditFilter(editFilter: StoryboardShotEditFilter) {
    const nextEditFilters = editFilters.includes(editFilter)
      ? editFilters.filter((current) => current !== editFilter)
      : storyboardShotEditFilters.filter(
          (current) => current === editFilter || editFilters.includes(current),
        );
    setEditFilters(nextEditFilters);
  }

  function toggleColorLabelFilter(colorLabel: StoryboardShotColorLabelFilter) {
    const nextColorLabelFilters = colorLabelFilters.includes(colorLabel)
      ? colorLabelFilters.filter((current) => current !== colorLabel)
      : storyboardShotColorFilterLabels
          .map(([current]) => current)
          .filter((current) => current === colorLabel || colorLabelFilters.includes(current));
    setColorLabelFilters(nextColorLabelFilters);
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
      clearSelection: hasSecondarySelection ? clearShotSelection : undefined,
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
      label: `分镜拆分 ${videoLabel}`,
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
        task.fail(error, { displayName: videoLabel, resourceKind: "media" });
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
    <section ref={panelRef} className="storyboard-panel" style={panelStyle} tabIndex={-1}>
      <div className="storyboard-project-row">
        <Film aria-hidden="true" />
        <span>分镜</span>
        <span className="storyboard-video-name" title={videoLabel}>
          {videoLabel}
        </span>
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
        <span
          className="storyboard-filter-separator storyboard-search-separator"
          aria-hidden="true"
        />
        <div className="storyboard-search-dropdown-control storyboard-search-scope-control">
          <StoryboardDropdownTrigger
            label="范围："
            value={storyboardSearchScopeLabels[searchScope]}
            open={Boolean(searchScopeMenu)}
            disabled={shots.length === 0}
            onClick={(event) => {
              event.stopPropagation();
              setContextMenu(null);
              setAnnotationMenu(null);
              setRatingComparatorMenu(null);
              setSearchRuleMenu(null);
              setFooterSortMenu(null);
              setFooterSprayMenu(null);
              setFooterOptionsMenu(null);
              if (searchScopeMenu) {
                setSearchScopeMenu(null);
                return;
              }
              const bounds = event.currentTarget.getBoundingClientRect();
              setSearchScopeMenu({ x: bounds.left, y: bounds.bottom });
            }}
          />
        </div>
        <span
          className="storyboard-filter-separator storyboard-search-separator"
          aria-hidden="true"
        />
        <div className="storyboard-search-dropdown-control">
          <StoryboardDropdownTrigger
            label="规则："
            value={storyboardSearchRuleLabels[searchRule]}
            open={Boolean(searchRuleMenu)}
            disabled={shots.length === 0}
            onClick={(event) => {
              event.stopPropagation();
              setContextMenu(null);
              setAnnotationMenu(null);
              setRatingComparatorMenu(null);
              setSearchScopeMenu(null);
              setFooterSortMenu(null);
              setFooterSprayMenu(null);
              setFooterOptionsMenu(null);
              if (searchRuleMenu) {
                setSearchRuleMenu(null);
                return;
              }
              const bounds = event.currentTarget.getBoundingClientRect();
              setSearchRuleMenu({ x: bounds.left, y: bounds.bottom });
            }}
          />
        </div>
        <span className="storyboard-selection-summary">
          {selectedCount} 条已选择，共 {sortedShots.length} 条
        </span>
      </div>

      <div
        className={`storyboard-filter-row ${
          flagFilters.length === 0 &&
          editFilters.length === 0 &&
          minimumRating === 0 &&
          colorLabelFilters.length === 0
            ? "is-filter-closed"
            : ""
        }`}
      >
        <span className="storyboard-filter-label">过滤器</span>
        <span className="storyboard-filter-separator" aria-hidden="true" />
        <span
          className={`storyboard-filter-section-label ${flagFilters.length > 0 ? "is-active" : ""}`}
        >
          旗标
        </span>
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
        <span
          className={`storyboard-filter-section-label ${editFilters.length > 0 ? "is-active" : ""}`}
        >
          编辑
        </span>
        <div className="storyboard-filter-edits" aria-label="按编辑状态过滤">
          {storyboardShotEditFilters.map((editFilter) => {
            const edited = editFilter === "edited";
            const label = edited ? "已编辑" : "未编辑";
            return (
              <button
                key={editFilter}
                type="button"
                className={editFilters.includes(editFilter) ? "active" : ""}
                onClick={() => toggleEditFilter(editFilter)}
                disabled={shots.length === 0}
                title={label}
                aria-label={label}
                aria-pressed={editFilters.includes(editFilter)}
              >
                <StoryboardEditFilterIcon edited={edited} />
              </button>
            );
          })}
        </div>
        <span className="storyboard-filter-separator" aria-hidden="true" />
        <span className={`storyboard-filter-section-label ${minimumRating > 0 ? "is-active" : ""}`}>
          星级
        </span>
        <button
          type="button"
          className={`storyboard-filter-comparator is-${ratingComparator} ${
            ratingComparatorMenu ? "open" : ""
          }`}
          aria-label="星级比较方式"
          aria-haspopup="menu"
          aria-expanded={Boolean(ratingComparatorMenu)}
          title={storyboardRatingComparatorLabels[ratingComparator]}
          disabled={shots.length === 0}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (ratingComparatorMenu) {
              setRatingComparatorMenu(null);
              return;
            }
            setContextMenu(null);
            setAnnotationMenu(null);
            setSearchScopeMenu(null);
            setSearchRuleMenu(null);
            setFooterSortMenu(null);
            setFooterSprayMenu(null);
            setFooterOptionsMenu(null);
            const bounds = event.currentTarget.getBoundingClientRect();
            setRatingComparatorMenu({ x: bounds.left, y: bounds.bottom });
          }}
        >
          <span>{storyboardRatingComparatorSymbols[ratingComparator]}</span>
        </button>
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
        <span
          className={`storyboard-filter-section-label ${colorLabelFilters.length > 0 ? "is-active" : ""}`}
        >
          颜色
        </span>
        <StoryboardColorLabelButtons
          className="storyboard-filter-colors"
          activeValues={colorLabelFilters}
          ariaLabel="按色标过滤"
          buttonLabel={(_, label) => `按${label}色标过滤`}
          includeNone
          onSelect={toggleColorLabelFilter}
          disabled={shots.length === 0}
        />
      </div>

      <div
        ref={contentLayoutRef}
        className={`storyboard-content ${sprayActive ? "is-spraying" : ""} ${
          keywordPanelOpen ? "" : "is-keyword-panel-closed"
        }`.trim()}
        style={{
          gridTemplateColumns: keywordPanelOpen
            ? `minmax(0, ${storyboardViewRatio}fr) 4px minmax(0, ${1 - storyboardViewRatio}fr)`
            : "minmax(0, 1fr) 0 0",
        }}
        onPointerDownCapture={startSprayGesture}
        onClickCapture={suppressSprayClick}
        onDoubleClickCapture={suppressSprayClick}
        onPointerDown={(event) => {
          if (!isEditableKeyboardTarget(event.target)) {
            panelRef.current?.focus({ preventScroll: true });
          }
        }}
      >
        <div className="storyboard-primary-view">
          {viewMode === "list" ? (
            <StoryboardListView
              shots={sortedShots}
              currentShotIndex={currentShotIndex}
              tableStyle={tableStyle}
              headerContent={storyboardTableHeaders.map(renderTableHeader)}
              rowVirtualizer={rowVirtualizer}
              virtualRows={virtualRows}
              thumbnailPriorityCenterIndex={thumbnailPriorityCenterIndex}
              assetId={thumbnailAssetId}
              fingerprint={thumbnailFingerprint}
              videoPath={thumbnailVideoPath}
              previewVideoPath={thumbnailPreviewVideoPath}
              frameRate={frameRate}
              resetKey={videoContext}
              headerRef={tableHeaderRef}
              scrollRef={listRef}
              onScroll={syncTableHeaderScroll}
              onPointerDown={startMarqueeSelection}
              onContextMenu={openContextMenu}
              onSelectShot={handleShotSelection}
              onDoubleClickShot={handleShotDoubleClick}
              onOpenAnnotationMenu={openAnnotationMenu}
              shotTitle={(shot) => storyboardShotTitle(shot, shotCount, shotAnnotations[shot.id])}
              shotLabel={(shot) => storyboardShotLabel(shotAnnotations[shot.id])}
            />
          ) : (
            <StoryboardIconView
              shots={sortedShots}
              currentShotId={currentShotId}
              assetId={thumbnailAssetId}
              fingerprint={thumbnailFingerprint}
              videoPath={thumbnailVideoPath}
              previewVideoPath={thumbnailPreviewVideoPath}
              frameRate={frameRate}
              gridCardWidth={gridCardWidth}
              scrollRef={listRef}
              onPointerDown={startMarqueeSelection}
              onContextMenu={openContextMenu}
              onSelectShot={handleShotSelection}
              onDoubleClickShot={handleShotDoubleClick}
              onOpenAnnotationMenu={openAnnotationMenu}
              shotTitle={(shot) => storyboardShotTitle(shot, shotCount, shotAnnotations[shot.id])}
              shotLabel={(shot) => storyboardShotLabel(shotAnnotations[shot.id])}
            />
          )}
        </div>
        {keywordPanelOpen && (
          <div
            className="storyboard-keyword-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整分镜表格和关键字面板宽度"
            onPointerDown={startKeywordPanelResize}
          />
        )}
        <StoryboardKeywordPanel
          shotIds={keywordPanelShotIds}
          resetKey={videoContext}
          onSetQuickKeyword={setSprayKeywordInput}
          quickKeywordLabel={sprayKeywordInput}
        />
        <div className={`storyboard-keyword-collapse-rail ${keywordPanelOpen ? "is-open" : ""}`}>
          <button
            type="button"
            onClick={() => setKeywordPanelOpen((current) => !current)}
            title={keywordPanelOpen ? "关闭关键字面板" : "展开关键字面板"}
            aria-label={keywordPanelOpen ? "关闭关键字面板" : "展开关键字面板"}
            aria-expanded={keywordPanelOpen}
          >
            <span aria-hidden="true" />
          </button>
        </div>
      </div>

      {renderMarqueeOverlay()}

      <footer className="storyboard-footer">
        <div className="storyboard-selection-tools">
          {footerAreaVisibility.viewMode && (
            <div className="storyboard-footer-area storyboard-footer-view-area">
              <button
                type="button"
                className={viewMode === "list" ? "active" : ""}
                onClick={() => setViewMode("list")}
                title="标签视图"
                aria-pressed={viewMode === "list"}
              >
                <List aria-hidden="true" />
              </button>
              <button
                type="button"
                className={viewMode === "grid" ? "active" : ""}
                onClick={() => setViewMode("grid")}
                title="图标视图"
                aria-pressed={viewMode === "grid"}
              >
                <Grid2X2 aria-hidden="true" />
              </button>
              <span className="storyboard-filter-separator storyboard-footer-separator" />
            </div>
          )}
          {footerAreaVisibility.selection && (
            <div className="storyboard-footer-area storyboard-footer-selection-area">
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
              <span className="storyboard-filter-separator storyboard-footer-separator" />
            </div>
          )}
          {footerAreaVisibility.sprayTool && (
            <div
              className={`storyboard-footer-area storyboard-footer-spray-area ${
                sprayActive ? "is-active" : ""
              }`}
            >
              {sprayActive ? (
                <>
                  <button
                    type="button"
                    className="storyboard-footer-spray-button is-empty"
                    onClick={deactivateSprayTool}
                    title="放回喷瓶并退出喷涂"
                    aria-label="放回喷瓶并退出喷涂"
                  >
                    <span className="storyboard-footer-spray-icon-background" aria-hidden="true" />
                  </button>
                  <div className="storyboard-footer-sort-control storyboard-footer-spray-control">
                    <StoryboardDropdownTrigger
                      className="storyboard-footer-spray-trigger"
                      label="喷涂："
                      value={storyboardSprayModeLabels[sprayMode]}
                      open={Boolean(footerSprayMenu)}
                      onClick={(event) => {
                        event.stopPropagation();
                        setContextMenu(null);
                        setAnnotationMenu(null);
                        setSearchScopeMenu(null);
                        setSearchRuleMenu(null);
                        setFooterSortMenu(null);
                        setFooterOptionsMenu(null);
                        if (footerSprayMenu) {
                          setFooterSprayMenu(null);
                          return;
                        }
                        const bounds = event.currentTarget.getBoundingClientRect();
                        setFooterSprayMenu({ x: bounds.left, y: bounds.top });
                      }}
                    />
                  </div>
                  <span className="storyboard-filter-separator storyboard-footer-separator" />
                  {sprayMode === "keywords" && (
                    <input
                      className="shot-title-editor storyboard-footer-spray-keyword-input"
                      value={sprayKeywordInput}
                      aria-label="喷涂关键字"
                      aria-invalid={Boolean(sprayKeywordParseResult.error)}
                      title={
                        sprayKeywordParseResult.error ??
                        "支持 父>子、子<父、父|子；多个关键字用逗号分隔"
                      }
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setSprayKeywordInput(event.currentTarget.value)}
                    />
                  )}
                  {sprayMode === "colorLabel" && (
                    <div className="storyboard-footer-spray-label-controls">
                      <StoryboardColorLabelButtons
                        className="storyboard-footer-colors storyboard-footer-spray-colors"
                        activeValues={sprayColorLabel ? [sprayColorLabel] : []}
                        ariaLabel="选择喷涂标签"
                        buttonLabel={(_, label, active) =>
                          active ? `清除${label}喷涂标签` : `喷涂${label}标签`
                        }
                        onSelect={(colorLabel) => {
                          setSprayCustomLabel("");
                          setSprayColorLabel((current) =>
                            current === colorLabel
                              ? null
                              : (colorLabel as StoryboardShotColorLabel),
                          );
                        }}
                      />
                      <input
                        className="shot-title-editor storyboard-footer-spray-label-input"
                        value={sprayCustomLabel}
                        aria-label="自定义喷涂标签"
                        title="自定义喷涂标签"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setSprayCustomLabel(value);
                          if (value.trim()) {
                            setSprayColorLabel(null);
                          }
                        }}
                      />
                    </div>
                  )}
                  {sprayMode === "flag" && (
                    <div className="storyboard-footer-flag-controls" aria-label="选择喷涂旗标">
                      {(["retained", "excluded"] as const).map((flag) => {
                        const active = sprayFlag === flag;
                        return (
                          <button
                            key={flag}
                            type="button"
                            className={`storyboard-footer-flag-button ${active ? "active" : ""}`}
                            onClick={() => setSprayFlag(active ? "none" : flag)}
                            title={active ? "喷涂无旗标" : `喷涂${storyboardShotFlagLabels[flag]}`}
                            aria-label={
                              active ? "喷涂无旗标" : `喷涂${storyboardShotFlagLabels[flag]}`
                            }
                            aria-pressed={active}
                          >
                            <span className={`shot-thumbnail-flag is-${flag}`} aria-hidden="true" />
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {sprayMode === "rating" && (
                    <div className="storyboard-footer-rating-controls" aria-label="选择喷涂星级">
                      {storyboardRatingFilters.map((rating) => {
                        const active = rating <= sprayRating;
                        return (
                          <button
                            key={rating}
                            type="button"
                            className={active ? "active" : ""}
                            onClick={() => setSprayRating(sprayRating === rating ? 0 : rating)}
                            title={sprayRating === rating ? "喷涂零星" : `喷涂 ${rating} 星`}
                            aria-label={sprayRating === rating ? "喷涂零星" : `喷涂 ${rating} 星`}
                            aria-pressed={sprayRating === rating}
                          >
                            <Star aria-hidden="true" />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="storyboard-footer-spray-button"
                  onClick={() => {
                    setContextMenu(null);
                    setAnnotationMenu(null);
                    setFooterSortMenu(null);
                    setFooterSprayMenu(null);
                    setFooterOptionsMenu(null);
                    setSprayActive(true);
                  }}
                  disabled={shots.length === 0}
                  title="喷涂工具"
                  aria-label="启用喷涂工具"
                >
                  <span className="storyboard-footer-spray-icon-background">
                    <StoryboardSprayBottleIcon
                      fillColor={sprayBottleFillColor}
                      mode={sprayMode}
                      flag={sprayFlag}
                      rating={sprayRating}
                      customLabel={sprayUsesCustomLabel}
                    />
                  </span>
                </button>
              )}
              {!sprayActive && (
                <span className="storyboard-filter-separator storyboard-footer-separator" />
              )}
            </div>
          )}
          {!sprayActive && footerSortVisible && (
            <div className="storyboard-footer-area storyboard-footer-sort-area">
              <div className="storyboard-footer-sort-control">
                <button
                  type="button"
                  className="storyboard-footer-sort-direction"
                  onClick={() => {
                    setFooterSortMenu(null);
                    setActiveShotSort((current) => ({
                      ...current,
                      direction: current.direction === "ascending" ? "descending" : "ascending",
                    }));
                  }}
                  disabled={displayShots.length === 0}
                  title={activeShotSort.direction === "ascending" ? "切换为降序" : "切换为升序"}
                  aria-label={
                    activeShotSort.direction === "ascending"
                      ? "当前升序，切换为降序"
                      : "当前降序，切换为升序"
                  }
                >
                  {activeShotSort.direction === "ascending" ? (
                    <ArrowDownAZ aria-hidden="true" />
                  ) : (
                    <ArrowDownZA aria-hidden="true" />
                  )}
                </button>
                <StoryboardDropdownTrigger
                  label="排序依据："
                  value={footerSortLabel}
                  open={Boolean(footerSortMenu)}
                  disabled={displayShots.length === 0}
                  onClick={(event) => {
                    event.stopPropagation();
                    setContextMenu(null);
                    setAnnotationMenu(null);
                    setSearchScopeMenu(null);
                    setSearchRuleMenu(null);
                    setFooterOptionsMenu(null);
                    if (footerSortMenu) {
                      setFooterSortMenu(null);
                      return;
                    }
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setFooterSortMenu({ x: bounds.left, y: bounds.top });
                  }}
                />
              </div>
              <span className="storyboard-filter-separator storyboard-footer-separator" />
            </div>
          )}
          {!sprayActive && footerAreaVisibility.flag && (
            <div className="storyboard-footer-area storyboard-footer-flag-area">
              <div className="storyboard-footer-flag-controls" aria-label="设置所选分镜旗标">
                {(["retained", "excluded"] as const).map((flag) => {
                  const active = contextMenuFlag === flag;
                  return (
                    <button
                      key={flag}
                      type="button"
                      className={`storyboard-footer-flag-button ${active ? "active" : ""}`}
                      onClick={() => setShotFlags(contextMenuShotIds, active ? "none" : flag)}
                      disabled={contextMenuShotIds.length === 0}
                      title={
                        active
                          ? `取消${storyboardShotFlagLabels[flag]}`
                          : `设置${storyboardShotFlagLabels[flag]}`
                      }
                      aria-label={
                        active
                          ? `取消${storyboardShotFlagLabels[flag]}`
                          : `设置${storyboardShotFlagLabels[flag]}`
                      }
                      aria-pressed={active}
                    >
                      <span className={`shot-thumbnail-flag is-${flag}`} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
              <span className="storyboard-filter-separator storyboard-footer-separator" />
            </div>
          )}
          {!sprayActive && footerAreaVisibility.rating && (
            <div className="storyboard-footer-area storyboard-footer-rating-area">
              <div className="storyboard-footer-rating-controls" aria-label="设置所选分镜星级">
                {storyboardRatingFilters.map((rating) => {
                  const active = contextMenuRating !== null && rating <= contextMenuRating;
                  return (
                    <button
                      key={rating}
                      type="button"
                      className={active ? "active" : ""}
                      onClick={() =>
                        setShotRatings(
                          contextMenuShotIds,
                          contextMenuRating === rating ? 0 : rating,
                        )
                      }
                      disabled={contextMenuShotIds.length === 0}
                      title={contextMenuRating === rating ? "取消星级" : `设为 ${rating} 星`}
                      aria-label={contextMenuRating === rating ? "取消星级" : `设为 ${rating} 星`}
                      aria-pressed={contextMenuRating === rating}
                    >
                      <Star aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
              <span className="storyboard-filter-separator storyboard-footer-separator" />
            </div>
          )}
          {!sprayActive && footerAreaVisibility.colorLabel && (
            <div className="storyboard-footer-area storyboard-footer-color-area">
              <StoryboardColorLabelButtons
                className="storyboard-footer-colors"
                activeValues={contextMenuColorLabel ? [contextMenuColorLabel] : []}
                ariaLabel="设置所选分镜色标"
                buttonLabel={(_, label, active) =>
                  active ? `清除${label}色标` : `设置${label}色标`
                }
                onSelect={(colorLabel) =>
                  setShotColorLabels(
                    contextMenuShotIds,
                    colorLabel === "none" ||
                      colorLabel === "custom" ||
                      contextMenuColorLabel === colorLabel
                      ? null
                      : colorLabel,
                  )
                }
                disabled={contextMenuShotIds.length === 0}
              />
              <span className="storyboard-filter-separator storyboard-footer-separator" />
            </div>
          )}
        </div>
        <div className="storyboard-thumbnail-tools">
          {sprayActive ? (
            <button
              type="button"
              className="storyboard-footer-spray-confirm"
              onClick={deactivateSprayTool}
            >
              完成
            </button>
          ) : (
            <>
              {footerAreaVisibility.thumbnailSize && (
                <>
                  <span className="storyboard-thumbnail-size-label">缩略图：</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={viewMode === "list" ? thumbnailSize : gridSize}
                    aria-label={viewMode === "list" ? "分镜缩略图大小" : "分镜图标大小"}
                    onChange={(event) => {
                      const size = Number(event.currentTarget.value);
                      if (viewMode === "list") {
                        setThumbnailSize(size);
                      } else {
                        setGridSize(size);
                      }
                    }}
                  />
                </>
              )}
              <span className="storyboard-filter-separator storyboard-footer-separator" />
              <button
                type="button"
                className={`storyboard-footer-options-trigger ${footerOptionsMenu ? "active" : ""}`}
                aria-haspopup="menu"
                aria-expanded={Boolean(footerOptionsMenu)}
                title="更多选项"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setContextMenu(null);
                  setAnnotationMenu(null);
                  setSearchScopeMenu(null);
                  setSearchRuleMenu(null);
                  setFooterSortMenu(null);
                  if (footerOptionsMenu) {
                    setFooterOptionsMenu(null);
                    return;
                  }
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setFooterOptionsMenu({ x: bounds.left, y: bounds.top });
                }}
              >
                <ChevronDown aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </footer>

      {footerSprayMenu &&
        createPortal(
          <PopupMenu
            className="storyboard-footer-spray-menu"
            contextMenuAnchor={footerSprayMenu}
            ariaLabel="喷涂属性"
            style={{
              position: "fixed",
              left: footerSprayMenu.x,
              top: footerSprayMenu.y,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {storyboardSprayModeOptions.map(([mode, label]) => (
              <PopupMenuItem
                key={mode}
                checked={sprayMode === mode}
                onSelect={() => {
                  setSprayMode(mode);
                  setFooterSprayMenu(null);
                }}
              >
                {label}
              </PopupMenuItem>
            ))}
          </PopupMenu>,
          document.body,
        )}

      {searchScopeMenu &&
        createPortal(
          <PopupMenu
            className="storyboard-search-scope-menu"
            contextMenuAnchor={searchScopeMenu}
            ariaLabel="分镜搜索范围"
            style={{
              position: "fixed",
              left: searchScopeMenu.x,
              top: searchScopeMenu.y,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <PopupMenuItem
              checked={searchScope === "any"}
              onSelect={() => {
                setSearchScope("any");
                setSearchScopeMenu(null);
              }}
            >
              {storyboardSearchScopeLabels.any}
            </PopupMenuItem>
            <PopupMenuSeparator />
            {(["title", "keywords"] as const).map((scope) => (
              <PopupMenuItem
                key={scope}
                checked={searchScope === scope}
                onSelect={() => {
                  setSearchScope(scope);
                  setSearchScopeMenu(null);
                }}
              >
                {storyboardSearchScopeLabels[scope]}
              </PopupMenuItem>
            ))}
          </PopupMenu>,
          document.body,
        )}

      {searchRuleMenu &&
        createPortal(
          <PopupMenu
            className="storyboard-search-rule-menu"
            contextMenuAnchor={searchRuleMenu}
            ariaLabel="分镜搜索规则"
            style={{
              position: "fixed",
              left: searchRuleMenu.x,
              top: searchRuleMenu.y,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {(["contains", "containsAll", "containsWords", "doesNotContain"] as const).map(
              (rule) => (
                <PopupMenuItem
                  key={rule}
                  checked={searchRule === rule}
                  onSelect={() => {
                    setSearchRule(rule);
                    setSearchRuleMenu(null);
                  }}
                >
                  {storyboardSearchRuleLabels[rule]}
                </PopupMenuItem>
              ),
            )}
            <PopupMenuSeparator />
            {(["startsWith", "endsWith"] as const).map((rule) => (
              <PopupMenuItem
                key={rule}
                checked={searchRule === rule}
                onSelect={() => {
                  setSearchRule(rule);
                  setSearchRuleMenu(null);
                }}
              >
                {storyboardSearchRuleLabels[rule]}
              </PopupMenuItem>
            ))}
            <PopupMenuSeparator />
            {(["isEmpty", "isNotEmpty"] as const).map((rule) => (
              <PopupMenuItem
                key={rule}
                checked={searchRule === rule}
                onSelect={() => {
                  setSearchRule(rule);
                  setSearchRuleMenu(null);
                }}
              >
                {storyboardSearchRuleLabels[rule]}
              </PopupMenuItem>
            ))}
          </PopupMenu>,
          document.body,
        )}

      {ratingComparatorMenu &&
        createPortal(
          <PopupMenu
            className="storyboard-rating-comparator-menu"
            contextMenuAnchor={ratingComparatorMenu}
            ariaLabel="星级比较方式"
            style={{
              position: "fixed",
              left: ratingComparatorMenu.x,
              top: ratingComparatorMenu.y,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {storyboardRatingComparatorOptions.map(([comparator, label]) => (
              <PopupMenuItem
                key={comparator}
                checked={ratingComparator === comparator}
                onSelect={() => {
                  setRatingComparator(comparator);
                  setRatingComparatorMenu(null);
                }}
              >
                {label}
              </PopupMenuItem>
            ))}
          </PopupMenu>,
          document.body,
        )}

      {footerSortMenu &&
        createPortal(
          <PopupMenu
            className="storyboard-footer-sort-menu"
            contextMenuAnchor={footerSortMenu}
            ariaLabel="分镜排序依据"
            style={{
              position: "fixed",
              left: footerSortMenu.x,
              top: footerSortMenu.y,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {storyboardGridSortOptions.map((option) => (
              <Fragment key={option.id}>
                {option.id === "rating" && <PopupMenuSeparator />}
                <PopupMenuItem
                  checked={activeShotSort.columnId === option.id}
                  onSelect={() => {
                    setActiveShotSort((current) =>
                      current.columnId === option.id
                        ? current
                        : { columnId: option.id, direction: option.defaultDirection },
                    );
                    setFooterSortMenu(null);
                  }}
                >
                  {option.label}
                </PopupMenuItem>
              </Fragment>
            ))}
          </PopupMenu>,
          document.body,
        )}

      {footerOptionsMenu &&
        createPortal(
          <PopupMenu
            className="storyboard-footer-options-menu"
            contextMenuAnchor={footerOptionsMenu}
            ariaLabel="分镜面板更多选项"
            style={{
              position: "fixed",
              left: footerOptionsMenu.x,
              top: footerOptionsMenu.y,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <PopupMenuItem
              checked={footerAreaVisibility.viewMode}
              onSelect={() =>
                setFooterAreaVisibility((current) => ({
                  ...current,
                  viewMode: !current.viewMode,
                }))
              }
            >
              视图模式
            </PopupMenuItem>
            <PopupMenuSeparator />
            <PopupMenuItem
              checked={footerAreaVisibility.selection}
              onSelect={() =>
                setFooterAreaVisibility((current) => ({
                  ...current,
                  selection: !current.selection,
                }))
              }
            >
              选中
            </PopupMenuItem>
            <PopupMenuItem
              checked={footerAreaVisibility.sprayTool}
              onSelect={() =>
                setFooterAreaVisibility((current) => ({
                  ...current,
                  sprayTool: !current.sprayTool,
                }))
              }
            >
              喷涂工具
            </PopupMenuItem>
            <PopupMenuItem
              checked={footerSortVisible}
              onSelect={() =>
                setFooterAreaVisibility((current) => ({
                  ...current,
                  sort: {
                    ...current.sort,
                    [viewMode]: !current.sort[viewMode],
                  },
                }))
              }
            >
              排序
            </PopupMenuItem>
            <PopupMenuItem
              checked={footerAreaVisibility.flag}
              onSelect={() =>
                setFooterAreaVisibility((current) => ({
                  ...current,
                  flag: !current.flag,
                }))
              }
            >
              旗标
            </PopupMenuItem>
            <PopupMenuItem
              checked={footerAreaVisibility.rating}
              onSelect={() =>
                setFooterAreaVisibility((current) => ({
                  ...current,
                  rating: !current.rating,
                }))
              }
            >
              星级
            </PopupMenuItem>
            <PopupMenuItem
              checked={footerAreaVisibility.colorLabel}
              onSelect={() =>
                setFooterAreaVisibility((current) => ({
                  ...current,
                  colorLabel: !current.colorLabel,
                }))
              }
            >
              色标
            </PopupMenuItem>
            <PopupMenuItem
              checked={footerAreaVisibility.thumbnailSize}
              onSelect={() =>
                setFooterAreaVisibility((current) => ({
                  ...current,
                  thumbnailSize: !current.thumbnailSize,
                }))
              }
            >
              缩略图大小
            </PopupMenuItem>
          </PopupMenu>,
          document.body,
        )}

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
                        exportSubmenuOpen: open ? false : current.exportSubmenuOpen,
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
                        exportSubmenuOpen: open ? false : current.exportSubmenuOpen,
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
                        exportSubmenuOpen: open ? false : current.exportSubmenuOpen,
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

            <PopupMenuItem
              mnemonic="A"
              onSelect={() => {
                appendShotKeywords(contextMenuShotIds, sprayKeywordInput);
                setContextMenu(null);
              }}
              disabled={
                contextMenuShotIds.length === 0 ||
                sprayKeywords.length === 0 ||
                Boolean(sprayKeywordParseResult.error)
              }
            >
              {sprayKeywords.length > 0
                ? `添加关键字“${sprayKeywordsDisplay}”(A)`
                : "添加快捷关键字(A)"}
            </PopupMenuItem>

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
                        exportSubmenuOpen: open ? false : current.exportSubmenuOpen,
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

            <PopupMenuSeparator />
            <PopupMenuSubmenu
              label="导出"
              open={contextMenu.exportSubmenuOpen}
              disabled={contextMenuShotIds.length === 0}
              enableMnemonics
              menuClassName="storyboard-context-menu"
              onOpenChange={(open) =>
                setContextMenu((current) =>
                  current
                    ? {
                        ...current,
                        exportSubmenuOpen: open,
                        flagSubmenuOpen: open ? false : current.flagSubmenuOpen,
                        ratingSubmenuOpen: open ? false : current.ratingSubmenuOpen,
                        colorSubmenuOpen: open ? false : current.colorSubmenuOpen,
                        stackSubmenuOpen: open ? false : current.stackSubmenuOpen,
                      }
                    : current,
                )
              }
            >
              <PopupMenuItem mnemonic="E" onSelect={exportSelectedShots}>
                导出(E)...
              </PopupMenuItem>
              <PopupMenuItem
                mnemonic="W"
                disabled={!exportState}
                onSelect={() => void quickExportWithLastSettings()}
              >
                使用上次设置导出(W)
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
