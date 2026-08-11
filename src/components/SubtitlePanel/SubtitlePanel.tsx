import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownAZ,
  ArrowDownZA,
  Captions,
  ChevronDown,
  ChevronsUpDown,
  ListFilter,
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
import { useEditCapability } from "../../runtime/capabilities/EditCapability";
import { useExportCapability } from "../../runtime/capabilities/ExportCapability";
import { usePlaybackStatus } from "../../runtime/capabilities/PlaybackCapability";
import { eventSource } from "../../runtime/events/EventHub";
import { publishEvent } from "../../runtime/events/react";
import { useStableIdentity } from "../../runtime/state/react";
import { usePanelActive, usePanelInstanceId } from "../../runtime/systems/PanelState";
import {
  isMediaItemEnabled,
  subtitleTrackCues,
  useProjectPort,
  visibleSubtitleTracks,
} from "../../systems/ProjectSystem";
import {
  buildSubtitleExportSource,
  enqueueQuickExport,
  requestExport,
} from "../../systems/ExportSystem";
import { requestSubtitleThumbnail } from "../../subtitleThumbnail";
import { normalizeFrameRate, timeUsToFrame } from "../../timeline";
import type { SubtitleCue } from "../../types";
import { usePanelManagerState } from "../DockLayout";
import {
  PopupMenu,
  PopupMenuItem,
  PopupMenuSeparator,
  PopupMenuSubmenu,
  useCloseOnOutsidePointer,
} from "../PopupMenu";
import "./SubtitlePanel.css";
import {
  SubtitleColorLabelButtons,
  subtitleCueColorFilterLabels,
  subtitleCueColorLabelValues,
  subtitleCueColorLabels,
} from "./SubtitleColorLabelButtons";
import { SubtitleListView } from "./SubtitleListView";
import {
  useSubtitlePanelState,
  type SubtitleCueAnnotation,
  type SubtitleCueColorLabel,
  type SubtitleCueColorLabelFilter,
  type SubtitleCueEditFilter,
  type SubtitleCueFlag,
  type SubtitleCueVisualLabel,
  type SubtitleRatingComparator,
} from "./subtitlePanelState";

const subtitleEventSource = eventSource("subtitle-panel");
const MIN_UPCOMING_SCROLL_DURATION_MS = 1000;
const MAX_UPCOMING_SCROLL_DURATION_MS = 1200;
const THUMBNAIL_PREFETCH_ROWS_BEFORE = 10;
const THUMBNAIL_PREFETCH_ROWS_AFTER = 28;
const SUBTITLE_THUMBNAIL_HEIGHT = 46;
const SUBTITLE_THUMBNAIL_WIDTH = 82;
const SUBTITLE_ROW_VERTICAL_PADDING = 36;
const SUBTITLE_THUMBNAIL_COLUMN_PADDING = 16;
const SUBTITLE_STATUS_GUTTER_WIDTH = 16;
const MARQUEE_DRAG_THRESHOLD = 4;

type SubtitleResizableColumnId =
  | "thumbnail"
  | "subtitle"
  | "mediaStart"
  | "mediaEnd"
  | "duration"
  | "rating"
  | "retained"
  | "label";
type SubtitleSortableColumnId =
  "subtitle" | "mediaStart" | "mediaEnd" | "duration" | "rating" | "retained" | "colorLabel";
type SubtitleTableColumnId = SubtitleResizableColumnId | "trailing";
type SubtitleSortDirection = "ascending" | "descending";

interface SubtitleSort {
  columnId: SubtitleSortableColumnId;
  direction: SubtitleSortDirection;
}

const defaultSubtitleSort: SubtitleSort = {
  columnId: "mediaStart",
  direction: "ascending",
};

const subtitleTableHeaders: Array<{
  id: SubtitleTableColumnId;
  label: string;
  sortColumnId?: SubtitleSortableColumnId;
  resizeColumn?: SubtitleResizableColumnId;
}> = [
  { id: "thumbnail", label: "" },
  { id: "subtitle", label: "字幕", sortColumnId: "subtitle" },
  {
    id: "mediaStart",
    label: "媒体开始",
    sortColumnId: "mediaStart",
    resizeColumn: "subtitle",
  },
  {
    id: "mediaEnd",
    label: "媒体结束",
    sortColumnId: "mediaEnd",
    resizeColumn: "mediaStart",
  },
  {
    id: "duration",
    label: "媒体持续时间",
    sortColumnId: "duration",
    resizeColumn: "mediaEnd",
  },
  { id: "rating", label: "星级", sortColumnId: "rating", resizeColumn: "duration" },
  { id: "retained", label: "留用", resizeColumn: "rating" },
  {
    id: "label",
    label: "标签",
    sortColumnId: "colorLabel",
    resizeColumn: "retained",
  },
  { id: "trailing", label: "", resizeColumn: "label" },
];

const subtitleSortOptions: Array<{
  id: SubtitleSortableColumnId;
  label: string;
  defaultDirection: SubtitleSortDirection;
}> = [
  { id: "subtitle", label: "字幕", defaultDirection: "ascending" },
  { id: "mediaStart", label: "媒体开始", defaultDirection: "ascending" },
  { id: "mediaEnd", label: "媒体结束", defaultDirection: "ascending" },
  { id: "duration", label: "媒体持续时间", defaultDirection: "ascending" },
  { id: "rating", label: "星级", defaultDirection: "descending" },
  { id: "retained", label: "留用", defaultDirection: "ascending" },
  { id: "colorLabel", label: "标签", defaultDirection: "ascending" },
];

type SubtitleColumnWidths = Record<SubtitleResizableColumnId, number>;

const initialSubtitleColumnWidths: SubtitleColumnWidths = {
  thumbnail: 104,
  subtitle: 256,
  mediaStart: 128,
  mediaEnd: 128,
  duration: 140,
  label: 128,
  rating: 112,
  retained: 128,
};

const minimumSubtitleColumnWidths: SubtitleColumnWidths = {
  thumbnail: 60,
  subtitle: 38,
  mediaStart: 21,
  mediaEnd: 21,
  duration: 21,
  label: 38,
  rating: 30,
  retained: 21,
};

const maximumSubtitleColumnWidths: SubtitleColumnWidths = {
  thumbnail: 720,
  subtitle: 720,
  mediaStart: 300,
  mediaEnd: 300,
  duration: 320,
  label: 720,
  rating: 180,
  retained: 300,
};

const subtitleResizableColumnLabels: Record<SubtitleResizableColumnId, string> = {
  thumbnail: "缩略图",
  subtitle: "字幕",
  mediaStart: "媒体开始",
  mediaEnd: "媒体结束",
  duration: "媒体持续时间",
  rating: "星级",
  retained: "留用",
  label: "标签",
};

const subtitleRatingFilters = [1, 2, 3, 4, 5] as const;
const subtitleRatingComparatorOptions: Array<readonly [SubtitleRatingComparator, string]> = [
  ["gte", "星级大于等于"],
  ["lte", "星级小于等于"],
  ["eq", "星级等于"],
];
const subtitleRatingComparatorSymbols: Record<SubtitleRatingComparator, string> = {
  gte: "≥",
  lte: "≤",
  eq: "=",
};
const subtitleRatingComparatorLabels: Record<SubtitleRatingComparator, string> = {
  gte: "星级大于等于",
  lte: "星级小于等于",
  eq: "星级等于",
};
const subtitleCueFlags: SubtitleCueFlag[] = ["retained", "none", "excluded"];
const subtitleCueEditFilters: SubtitleCueEditFilter[] = ["edited", "unedited"];
const subtitleCueFlagLabels: Record<SubtitleCueFlag, string> = {
  retained: "留用旗标",
  none: "无旗标",
  excluded: "排除旗标",
};
const subtitleTextCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const subtitleColorLabelNames = Object.fromEntries(subtitleCueColorLabels) as Record<
  SubtitleCueColorLabel,
  string
>;

interface CueFrameRange {
  startFrame: number;
  endFrame: number;
  maximumEndFrame: number;
}

interface SubtitleMarqueeSelection {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface SubtitleMenuAnchor {
  x: number;
  y: number;
}

interface SubtitleContextMenuState extends SubtitleMenuAnchor {
  cueId: string | null;
  flagSubmenuOpen: boolean;
  ratingSubmenuOpen: boolean;
  colorSubmenuOpen: boolean;
  exportSubmenuOpen: boolean;
}

interface SubtitleAnnotationMenuState extends SubtitleMenuAnchor {
  cueId: string;
  kind: "flag" | "color";
}

type SubtitleSprayMode = "colorLabel" | "flag" | "rating";

const subtitleSprayModeOptions: Array<readonly [SubtitleSprayMode, string]> = [
  ["colorLabel", "标签"],
  ["flag", "旗标"],
  ["rating", "星级"],
];
const subtitleSprayModeLabels = Object.fromEntries(subtitleSprayModeOptions) as Record<
  SubtitleSprayMode,
  string
>;

interface SubtitleFooterAreaVisibility {
  colorLabel: boolean;
  flag: boolean;
  rating: boolean;
  selection: boolean;
  sprayTool: boolean;
  sort: boolean;
  thumbnailSize: boolean;
}

const defaultSubtitleFooterAreaVisibility: SubtitleFooterAreaVisibility = {
  colorLabel: false,
  flag: false,
  rating: false,
  selection: true,
  sprayTool: true,
  sort: false,
  thumbnailSize: true,
};

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

function cueLabel(annotation: SubtitleCueAnnotation | undefined) {
  const customLabel = annotation?.customLabel?.trim() ?? "";
  if (customLabel) {
    return customLabel;
  }
  return annotation?.colorLabel ? subtitleColorLabelNames[annotation.colorLabel] : "";
}

function cueVisualLabel(
  annotation: SubtitleCueAnnotation | undefined,
): SubtitleCueVisualLabel | undefined {
  return annotation?.customLabel?.trim() ? "custom" : annotation?.colorLabel || undefined;
}

function cueFlag(annotation: SubtitleCueAnnotation | undefined): SubtitleCueFlag {
  if (annotation?.retained) {
    return "retained";
  }
  if (annotation?.excluded) {
    return "excluded";
  }
  return "none";
}

function cueIsEdited(annotation: SubtitleCueAnnotation | undefined) {
  return Boolean(
    annotation &&
    ((annotation.rating ?? 0) > 0 ||
      annotation.retained ||
      annotation.excluded ||
      annotation.colorLabel ||
      annotation.customLabel?.trim()),
  );
}

function cueMatches(
  cue: SubtitleCue,
  annotation: SubtitleCueAnnotation | undefined,
  query: string,
) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) {
    return true;
  }
  const haystack = `${cue.plain_text} ${cue.speaker ?? ""} ${cue.style ?? ""} ${cueLabel(
    annotation,
  )}`.toLocaleLowerCase();
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function cueMatchesFilter(
  annotation: SubtitleCueAnnotation | undefined,
  minimumRating: number,
  ratingComparator: SubtitleRatingComparator,
  flagFilters: readonly SubtitleCueFlag[],
  editFilters: readonly SubtitleCueEditFilter[],
  colorLabelFilters: readonly SubtitleCueColorLabelFilter[],
) {
  const rating = annotation?.rating ?? 0;
  const flag = cueFlag(annotation);
  const colorLabel = cueVisualLabel(annotation) ?? "none";
  const matchesRating =
    minimumRating === 0 ||
    (ratingComparator === "gte"
      ? rating >= minimumRating
      : ratingComparator === "lte"
        ? rating <= minimumRating
        : rating === minimumRating);
  const editState: SubtitleCueEditFilter = cueIsEdited(annotation) ? "edited" : "unedited";
  return (
    matchesRating &&
    (flagFilters.length === 0 || flagFilters.includes(flag)) &&
    (editFilters.length === 0 || editFilters.includes(editState)) &&
    (colorLabelFilters.length === 0 || colorLabelFilters.includes(colorLabel))
  );
}

function seekToCue(cue: SubtitleCue, focusRange = false) {
  void publishEvent(
    "playback.seek.requested",
    {
      timeUs: cue.start_us,
      focusEndUs: focusRange ? cue.end_us : undefined,
      play: focusRange,
    },
    subtitleEventSource,
  );
}

function currentCueIndexAtFrame(ranges: CueFrameRange[], currentFrame: number) {
  let low = 0;
  let high = ranges.length - 1;
  let latestStartedIndex = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].startFrame <= currentFrame) {
      latestStartedIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  for (let index = latestStartedIndex; index >= 0; index -= 1) {
    const range = ranges[index];
    if (range.maximumEndFrame < currentFrame) {
      break;
    }
    if (currentFrame <= range.endFrame) {
      return index;
    }
  }
  return -1;
}

function nextCueIndexAfterFrame(ranges: CueFrameRange[], currentFrame: number) {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].startFrame <= currentFrame) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low > 0 && low < ranges.length ? low : -1;
}

function nextCueIndexAfterCurrentCue(
  ranges: CueFrameRange[],
  currentCueIndex: number,
  currentFrame: number,
) {
  for (let index = currentCueIndex + 1; index < ranges.length; index += 1) {
    if (ranges[index].endFrame >= currentFrame) {
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

function closestCueIndexToViewportCenter(
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

function subtitleCueSortValue(
  cue: SubtitleCue,
  columnId: SubtitleSortableColumnId,
  cueAnnotations: Record<string, SubtitleCueAnnotation>,
) {
  const annotation = cueAnnotations[cue.id];
  if (columnId === "subtitle") {
    return cue.plain_text;
  }
  if (columnId === "mediaStart") {
    return cue.start_us;
  }
  if (columnId === "mediaEnd") {
    return cue.end_us;
  }
  if (columnId === "duration") {
    return Math.max(0, cue.end_us - cue.start_us);
  }
  if (columnId === "rating") {
    return annotation?.rating ?? 0;
  }
  if (columnId === "colorLabel") {
    return cueLabel(annotation);
  }
  const flag = cueFlag(annotation);
  return flag === "retained" ? 0 : flag === "none" ? 1 : 2;
}

function sortSubtitleCues(
  cues: readonly SubtitleCue[],
  sort: SubtitleSort,
  cueAnnotations: Record<string, SubtitleCueAnnotation>,
) {
  const direction = sort.direction === "ascending" ? 1 : -1;
  const compareValues = (left: string | number, right: string | number) => {
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    if (typeof left === "number") {
      return -1;
    }
    if (typeof right === "number") {
      return 1;
    }
    return subtitleTextCollator.compare(left, right);
  };
  return cues
    .map((cue, index) => ({ cue, index }))
    .sort((left, right) => {
      const valueDelta = compareValues(
        subtitleCueSortValue(left.cue, sort.columnId, cueAnnotations),
        subtitleCueSortValue(right.cue, sort.columnId, cueAnnotations),
      );
      return (
        valueDelta * direction || left.cue.sequence - right.cue.sequence || left.index - right.index
      );
    })
    .map(({ cue }) => cue);
}

function SortArrow({ direction }: { direction: SubtitleSortDirection }) {
  const isAscending = direction === "ascending";
  return (
    <svg className="subtitle-sort-arrow" viewBox="0 0 16 16" fill="none" aria-hidden="true">
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

function subtitleSprayBottleMarkSvg(
  mode: SubtitleSprayMode,
  flag: SubtitleCueFlag,
  rating: number,
  customLabel: boolean,
) {
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

function subtitleSprayCursor(
  fillColor: string,
  mode: SubtitleSprayMode,
  flag: SubtitleCueFlag,
  rating: number,
  customLabel: boolean,
) {
  const mark = subtitleSprayBottleMarkSvg(mode, flag, rating, customLabel);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="17" height="20" viewBox="0 0 20 24"><path d="M8.25 1.5h3.5v2h-3.5zM9 3.5h2v2H9zM6.5 5.5h7v2.25h-7z" fill="#d0d0d0"/><path d="M6.25 8.25h7.5l1.5 2.25v10.25H4.75V10.5l1.5-2.25Z" fill="${fillColor}" stroke="#d0d0d0" stroke-width="1.25" stroke-linejoin="round"/><path d="M4 21.25h12v1.5H4z" fill="${fillColor}" stroke="#d0d0d0"/><path d="M6.25 11h7.5M6.25 18.75h7.5" stroke="#686868" stroke-width=".75"/>${mark}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 8 2, crosshair`;
}

interface SubtitleSprayBottleIconProps {
  fillColor: string;
  mode: SubtitleSprayMode;
  flag: SubtitleCueFlag;
  rating: number;
  customLabel: boolean;
}

function SubtitleSprayBottleIcon({
  fillColor,
  mode,
  flag,
  rating,
  customLabel,
}: SubtitleSprayBottleIconProps) {
  return (
    <svg className="subtitle-spray-bottle-icon" viewBox="0 0 20 24" fill="none" aria-hidden="true">
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
      <path d="M4 21.25h12v1.5H4z" fill={fillColor} stroke="currentColor" />
      <path d="M6.25 11h7.5M6.25 18.75h7.5" stroke="#686868" strokeWidth="0.75" />
      {mode === "colorLabel" && customLabel && (
        <text x="10" y="17.8" fill="#fff" fontSize="7.5" fontWeight="700" textAnchor="middle">
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
        <text x="10" y="17.8" fill="#fff" fontSize="7.5" fontWeight="700" textAnchor="middle">
          {rating}
        </text>
      )}
    </svg>
  );
}

function SubtitleFlagIcon({ flag }: { flag: SubtitleCueFlag }) {
  if (flag === "retained") {
    return (
      <svg className="subtitle-flag-icon" viewBox="12 5 39 43" fill="none" aria-hidden="true">
        <g className="subtitle-flag-strokes" strokeWidth="2">
          <path d="M36 9L47.5 20.5 31.5 36.5" />
          <path d="M31.5 36.5 40 45M36 9 25.46 19.49M23.34 28.35 31.5 36.5" />
          <path d="M15.4 24.49 17.99 27.03 22.55 22.42" />
        </g>
        <path className="subtitle-flag-fill" d="M36 11.875 45.125 21 32 34.125 22.875 25Z" />
      </svg>
    );
  }
  if (flag === "none") {
    return (
      <svg className="subtitle-flag-icon" viewBox="57 5 33 43" fill="none" aria-hidden="true">
        <path
          className="subtitle-flag-strokes"
          d="M59.5 24.5 75.5 8.5 87.5 20.5 71.5 36.5ZM71.5 36.5 80.6 45.6"
          strokeWidth="2"
          strokeDasharray="2.2 3.457"
        />
      </svg>
    );
  }
  return (
    <svg className="subtitle-flag-icon" viewBox="94 5 36 43" fill="none" aria-hidden="true">
      <g className="subtitle-flag-strokes" strokeWidth="2">
        <path d="M96.79 21.81 103.21 28.19M103.21 21.81 96.79 28.19" />
        <path d="M116 9 127.5 20.5 111.5 36.5M111.5 36.5 120 45M116 9 105.44 19.54M105.24 30.19 111.5 36.5" />
      </g>
    </svg>
  );
}

function SubtitleEditFilterIcon({ edited }: { edited: boolean }) {
  return (
    <svg className="subtitle-edit-filter-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.35" shapeRendering="crispEdges">
        <path d="M2 6h5m4 0h11M2 12h10m4 0h6M2 18h3m4 0h13" />
        <path d="M9 3.5v5M14 9.5v5M7 15.5v5" />
        {!edited && <path d="M3 3l18 18" strokeWidth="2" shapeRendering="auto" />}
      </g>
    </svg>
  );
}

interface SubtitleFlagMenuItemsProps {
  checkedFlag: SubtitleCueFlag | null;
  onSelect: (flag: SubtitleCueFlag) => void;
}

function SubtitleFlagMenuItems({ checkedFlag, onSelect }: SubtitleFlagMenuItemsProps) {
  return (
    <>
      {subtitleCueFlags.map((flag) => (
        <PopupMenuItem key={flag} checked={checkedFlag === flag} onSelect={() => onSelect(flag)}>
          {subtitleCueFlagLabels[flag]}
        </PopupMenuItem>
      ))}
    </>
  );
}

interface SubtitleColorMenuItemsProps {
  checkedColorLabel: SubtitleCueVisualLabel | null | undefined;
  onSelect: (colorLabel: SubtitleCueColorLabel | null) => void;
}

function SubtitleColorMenuItems({ checkedColorLabel, onSelect }: SubtitleColorMenuItemsProps) {
  return (
    <>
      {subtitleCueColorLabels.map(([colorLabel, label]) => (
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

export function SubtitlePanel() {
  const panelInstanceId = usePanelInstanceId();
  const panelActive = usePanelActive();
  const focusedPanelId = usePanelManagerState((state) => state.focusedPanelId);
  const identity = useStableIdentity("subtitle-panel", panelInstanceId);
  const {
    project,
    projects,
    mediaItems,
    activeVideoId,
    activeTrackId,
    detachedVideoIds,
    exportState,
    activeTrackChanged,
    messagePublished,
  } = useProjectPort(
    [
      "project",
      "projects",
      "mediaItems",
      "activeVideoId",
      "activeTrackId",
      "detachedVideoIds",
      "exportState",
    ],
    ["activeTrackChanged", "messagePublished"],
  );
  const {
    query,
    showOnlySelected,
    minimumRating,
    ratingComparator,
    flagFilters,
    editFilters,
    colorLabelFilters,
    activeCueId,
    selectedCueIds,
    cueAnnotations,
    thumbnailSize,
    syncTrackContext,
    setQuery,
    setShowOnlySelected,
    setMinimumRating,
    setRatingComparator,
    setFlagFilters,
    setEditFilters,
    setColorLabelFilters,
    setThumbnailSize,
    setCueCustomLabels,
    setCueRatings,
    adjustCueRatings,
    setCueFlags,
    setCueColorLabels,
    cueSelectionCleared,
    cueSelectionReplaced,
  } = useSubtitlePanelState((state) => state);
  const playback = usePlaybackStatus();
  const panelRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const tableHeaderRef = useRef<HTMLDivElement | null>(null);
  const scrollAnimationRef = useRef<number | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const selectionFocusRef = useRef<string | null>(null);
  const marqueeCleanupRef = useRef<(() => void) | null>(null);
  const sprayGestureCleanupRef = useRef<(() => void) | null>(null);
  const [cueSort, setCueSort] = useState<SubtitleSort>(defaultSubtitleSort);
  const [trackMenu, setTrackMenu] = useState<SubtitleMenuAnchor | null>(null);
  const [ratingComparatorMenu, setRatingComparatorMenu] = useState<SubtitleMenuAnchor | null>(null);
  const [footerSortMenu, setFooterSortMenu] = useState<SubtitleMenuAnchor | null>(null);
  const [footerSprayMenu, setFooterSprayMenu] = useState<SubtitleMenuAnchor | null>(null);
  const [footerOptionsMenu, setFooterOptionsMenu] = useState<SubtitleMenuAnchor | null>(null);
  const [contextMenu, setContextMenu] = useState<SubtitleContextMenuState | null>(null);
  const [annotationMenu, setAnnotationMenu] = useState<SubtitleAnnotationMenuState | null>(null);
  const [sprayActive, setSprayActive] = useState(false);
  const [sprayMode, setSprayMode] = useState<SubtitleSprayMode>("colorLabel");
  const [sprayColorLabel, setSprayColorLabel] = useState<SubtitleCueColorLabel | null>(null);
  const [sprayCustomLabel, setSprayCustomLabel] = useState("");
  const [sprayFlag, setSprayFlag] = useState<SubtitleCueFlag>("none");
  const [sprayRating, setSprayRating] = useState(0);
  const [footerAreaVisibility, setFooterAreaVisibility] = useState(
    defaultSubtitleFooterAreaVisibility,
  );
  const [marqueeSelection, setMarqueeSelection] = useState<SubtitleMarqueeSelection | null>(null);
  const [subtitleColumnWidths, setSubtitleColumnWidths] = useState(initialSubtitleColumnWidths);
  const columnResizeRef = useRef<{
    columnId: SubtitleResizableColumnId;
    startX: number;
    startWidth: number;
    pointerId: number;
  } | null>(null);

  const visibleTracks = useMemo(
    () => visibleSubtitleTracks(project, mediaItems, activeVideoId, projects),
    [activeVideoId, mediaItems, project, projects],
  );
  const activeTrack = visibleTracks.find((track) => track.id === activeTrackId);
  const allCues = useMemo(
    () =>
      activeTrack
        ? subtitleTrackCues(project, projects, mediaItems, activeVideoId, activeTrack.id)
        : [],
    [activeTrack, activeVideoId, mediaItems, project, projects],
  );
  const trackContext = `${activeVideoId}:${project?.asset.id ?? ""}:${
    project?.asset.fingerprint ?? ""
  }:${activeTrack?.id ?? ""}`;
  const filteredCues = useMemo(
    () =>
      allCues.filter(
        (cue) =>
          (!showOnlySelected || selectedCueIds.has(cue.id)) &&
          cueMatches(cue, cueAnnotations[cue.id], query) &&
          cueMatchesFilter(
            cueAnnotations[cue.id],
            minimumRating,
            ratingComparator,
            flagFilters,
            editFilters,
            colorLabelFilters,
          ),
      ),
    [
      allCues,
      colorLabelFilters,
      cueAnnotations,
      editFilters,
      flagFilters,
      minimumRating,
      query,
      ratingComparator,
      selectedCueIds,
      showOnlySelected,
    ],
  );
  const sortedCues = useMemo(
    () => sortSubtitleCues(filteredCues, cueSort, cueAnnotations),
    [cueAnnotations, cueSort, filteredCues],
  );
  const selectedCount = selectedCueIds.size;
  const hasSecondarySelection =
    selectedCount > (activeCueId && selectedCueIds.has(activeCueId) ? 1 : 0);
  const isEditAuthority = panelActive && focusedPanelId === panelInstanceId;
  const footerSortLabel =
    subtitleSortOptions.find((option) => option.id === cueSort.columnId)?.label ?? "媒体开始";
  const sprayUsesCustomLabel = sprayMode === "colorLabel" && sprayCustomLabel.trim().length > 0;
  const sprayBottleFillColor =
    sprayMode === "colorLabel" && sprayColorLabel
      ? subtitleCueColorLabelValues[sprayColorLabel]
      : "#252525";
  const panelStyle = {
    "--subtitle-spray-cursor": subtitleSprayCursor(
      sprayBottleFillColor,
      sprayMode,
      sprayFlag,
      sprayRating,
      sprayUsesCustomLabel,
    ),
  } as CSSProperties;
  const thumbnailAssetId = project?.asset.id ?? "";
  const thumbnailFingerprint = project?.asset.fingerprint ?? "";
  const thumbnailVideoPath = project?.asset.path ?? "";
  const thumbnailPreviewVideoPath = project?.proxy_path || thumbnailVideoPath;
  const thumbnailScale = 1 + thumbnailSize / 100;
  const thumbnailWidth = SUBTITLE_THUMBNAIL_WIDTH * thumbnailScale;
  const thumbnailHeight = SUBTITLE_THUMBNAIL_HEIGHT * thumbnailScale;
  const subtitleRowHeight = thumbnailHeight + SUBTITLE_ROW_VERTICAL_PADDING;
  const thumbnailColumnWidth =
    Math.max(subtitleColumnWidths.thumbnail, thumbnailWidth + SUBTITLE_THUMBNAIL_COLUMN_PADDING) +
    SUBTITLE_STATUS_GUTTER_WIDTH;
  const tableMinWidth =
    thumbnailColumnWidth +
    subtitleColumnWidths.subtitle +
    subtitleColumnWidths.mediaStart +
    subtitleColumnWidths.mediaEnd +
    subtitleColumnWidths.duration +
    subtitleColumnWidths.rating +
    subtitleColumnWidths.retained +
    subtitleColumnWidths.label;
  const tableStyle = {
    "--subtitle-fixed-thumbnail-width": `${thumbnailColumnWidth}px`,
    "--subtitle-status-gutter-width": `${SUBTITLE_STATUS_GUTTER_WIDTH}px`,
    "--subtitle-col-thumbnail": `${thumbnailColumnWidth}px`,
    "--subtitle-col-subtitle": `${subtitleColumnWidths.subtitle}px`,
    "--subtitle-col-media-start": `${subtitleColumnWidths.mediaStart}px`,
    "--subtitle-col-media-end": `${subtitleColumnWidths.mediaEnd}px`,
    "--subtitle-col-duration": `${subtitleColumnWidths.duration}px`,
    "--subtitle-col-rating": `${subtitleColumnWidths.rating}px`,
    "--subtitle-col-retained": `${subtitleColumnWidths.retained}px`,
    "--subtitle-col-label": `${subtitleColumnWidths.label}px`,
    "--subtitle-table-min-width": `${tableMinWidth}px`,
    "--subtitle-thumbnail-width": `${thumbnailWidth}px`,
    "--subtitle-thumbnail-height": `${thumbnailHeight}px`,
    "--subtitle-row-height": `${subtitleRowHeight}px`,
  } as CSSProperties;
  const frameRate = useMemo(() => {
    const videoStream =
      project?.streams.find((stream) => stream.index === project.asset.video_stream_index) ??
      project?.streams.find((stream) => stream.codec_type === "video");
    return normalizeFrameRate(videoStream?.avg_frame_rate, videoStream?.r_frame_rate);
  }, [project]);
  const currentFrame = playback?.currentFrame ?? 0;
  const isPlaying = playback?.isPlaying ?? false;
  const currentFrameRef = useRef(currentFrame);
  currentFrameRef.current = currentFrame;
  const cueFrameRanges = useMemo(() => {
    let maximumEndFrame = 0;
    return filteredCues.map((cue) => {
      const startFrame = timeUsToFrame(cue.start_us, frameRate);
      const endFrame = timeUsToFrame(cue.end_us, frameRate);
      maximumEndFrame = Math.max(maximumEndFrame, endFrame);
      return { startFrame, endFrame, maximumEndFrame };
    });
  }, [filteredCues, frameRate]);
  const chronologicalCurrentCueIndex = useMemo(
    () => currentCueIndexAtFrame(cueFrameRanges, currentFrame),
    [cueFrameRanges, currentFrame],
  );
  const chronologicalUpcomingCueIndex = useMemo(
    () => nextCueIndexAfterFrame(cueFrameRanges, currentFrame),
    [cueFrameRanges, currentFrame],
  );
  const nextChronologicalCueIndex = useMemo(
    () =>
      chronologicalCurrentCueIndex >= 0
        ? nextCueIndexAfterCurrentCue(cueFrameRanges, chronologicalCurrentCueIndex, currentFrame)
        : -1,
    [chronologicalCurrentCueIndex, cueFrameRanges, currentFrame],
  );
  const currentCueId =
    chronologicalCurrentCueIndex >= 0 ? filteredCues[chronologicalCurrentCueIndex]?.id : undefined;
  const chronologicalFollowCueIndex = useMemo(() => {
    if (chronologicalCurrentCueIndex < 0) {
      return chronologicalUpcomingCueIndex;
    }
    if (
      currentFrame >= cueFrameRanges[chronologicalCurrentCueIndex].endFrame &&
      nextChronologicalCueIndex >= 0
    ) {
      return nextChronologicalCueIndex;
    }
    return chronologicalCurrentCueIndex;
  }, [
    chronologicalCurrentCueIndex,
    chronologicalUpcomingCueIndex,
    cueFrameRanges,
    currentFrame,
    nextChronologicalCueIndex,
  ]);
  const followCueId =
    chronologicalFollowCueIndex >= 0 ? filteredCues[chronologicalFollowCueIndex]?.id : undefined;
  const currentCueIndex = currentCueId
    ? sortedCues.findIndex((cue) => cue.id === currentCueId)
    : -1;
  const followCueIndex = followCueId ? sortedCues.findIndex((cue) => cue.id === followCueId) : -1;
  const rowVirtualizer = useVirtualizer({
    count: sortedCues.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => subtitleRowHeight,
    getItemKey: (index) => sortedCues[index].id,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 6,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const firstRenderedCueIndex = virtualRows[0]?.index ?? 0;
  const lastRenderedCueIndex = virtualRows.at(-1)?.index ?? 0;
  const thumbnailPriorityCenterIndex = closestCueIndexToViewportCenter(
    virtualRows,
    rowVirtualizer.scrollOffset ?? 0,
    rowVirtualizer.scrollRect?.height ?? 0,
  );
  const thumbnailPrefetchStart = Math.max(
    0,
    firstRenderedCueIndex - THUMBNAIL_PREFETCH_ROWS_BEFORE,
  );
  const thumbnailPrefetchEnd = Math.min(
    sortedCues.length,
    lastRenderedCueIndex + 1 + THUMBNAIL_PREFETCH_ROWS_AFTER,
  );

  const contextMenuCueIds = Array.from(selectedCueIds);
  const contextMenuRatings = contextMenuCueIds.map((cueId) => cueAnnotations[cueId]?.rating ?? 0);
  const contextMenuRating =
    contextMenuRatings.length > 0 &&
    contextMenuRatings.every((rating) => rating === contextMenuRatings[0])
      ? contextMenuRatings[0]
      : null;
  const contextMenuFlags = contextMenuCueIds.map((cueId) => cueFlag(cueAnnotations[cueId]));
  const contextMenuFlag =
    contextMenuFlags.length > 0 && contextMenuFlags.every((flag) => flag === contextMenuFlags[0])
      ? contextMenuFlags[0]
      : null;
  const contextMenuColorLabels = contextMenuCueIds.map(
    (cueId) => cueVisualLabel(cueAnnotations[cueId]) ?? null,
  );
  const contextMenuColorLabel =
    contextMenuColorLabels.length > 0 &&
    contextMenuColorLabels.every((label) => label === contextMenuColorLabels[0])
      ? contextMenuColorLabels[0]
      : undefined;
  const annotationMenuCueIds = annotationMenu
    ? Array.from(
        selectedCueIds.has(annotationMenu.cueId) ? selectedCueIds : new Set([annotationMenu.cueId]),
      )
    : [];
  const annotationMenuFlags = annotationMenuCueIds.map((cueId) => cueFlag(cueAnnotations[cueId]));
  const annotationMenuFlag =
    annotationMenuFlags.length > 0 &&
    annotationMenuFlags.every((flag) => flag === annotationMenuFlags[0])
      ? annotationMenuFlags[0]
      : null;
  const annotationMenuColorLabels = annotationMenuCueIds.map(
    (cueId) => cueVisualLabel(cueAnnotations[cueId]) ?? null,
  );
  const annotationMenuColorLabel =
    annotationMenuColorLabels.length > 0 &&
    annotationMenuColorLabels.every((label) => label === annotationMenuColorLabels[0])
      ? annotationMenuColorLabels[0]
      : undefined;
  const contextSubmenuOpen = Boolean(
    contextMenu &&
    (contextMenu.flagSubmenuOpen ||
      contextMenu.ratingSubmenuOpen ||
      contextMenu.colorSubmenuOpen ||
      contextMenu.exportSubmenuOpen),
  );
  const trackOptions = visibleTracks.map((track) => {
    const mediaItem = mediaItems.find(
      (item) =>
        item.kind === "subtitle" &&
        item.bound_to_video_id === activeVideoId &&
        item.subtitle_track_id === track.id &&
        isMediaItemEnabled(item),
    );
    return {
      id: track.id,
      label: `${mediaItem?.file_name || track.title || track.language || track.codec} · ${track.cue_count} 条`,
    };
  });
  const activeTrackLabel =
    trackOptions.find((option) => option.id === activeTrack?.id)?.label ??
    (project ? "无可用字幕" : "未选择视频");

  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowVirtualizer, subtitleRowHeight]);

  useEffect(() => {
    syncTrackContext(trackContext);
    sprayGestureCleanupRef.current?.();
    setSprayActive(false);
    setTrackMenu(null);
    setContextMenu(null);
    setAnnotationMenu(null);
    setRatingComparatorMenu(null);
    setFooterSortMenu(null);
    setFooterSprayMenu(null);
    setFooterOptionsMenu(null);
    setCueSort(defaultSubtitleSort);
  }, [syncTrackContext, trackContext]);

  useEffect(() => {
    if (showOnlySelected && selectedCount === 0) {
      setShowOnlySelected(false);
    }
  }, [selectedCount, setShowOnlySelected, showOnlySelected]);

  useEffect(() => {
    if (sprayActive) {
      return;
    }
    sprayGestureCleanupRef.current?.();
    setFooterSprayMenu(null);
  }, [sprayActive]);

  useCloseOnOutsidePointer(
    Boolean(contextMenu) || Boolean(annotationMenu),
    () => {
      setContextMenu(null);
      setAnnotationMenu(null);
    },
    {
      capturePointerdown: true,
      ignorePopupMenuTargets: true,
    },
  );

  const anyMenu = Boolean(
    trackMenu ||
    contextMenu ||
    annotationMenu ||
    ratingComparatorMenu ||
    footerSortMenu ||
    footerSprayMenu ||
    footerOptionsMenu,
  );
  useCloseOnOutsidePointer(anyMenu, () => {
    setContextMenu(null);
    setAnnotationMenu(null);
    setTrackMenu(null);
    setRatingComparatorMenu(null);
    setFooterSortMenu(null);
    setFooterSprayMenu(null);
    setFooterOptionsMenu(null);
  });

  useEffect(() => {
    const visibleSelectedIds = sortedCues
      .map((cue) => cue.id)
      .filter((cueId) => selectedCueIds.has(cueId));
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
  }, [selectedCueIds, sortedCues]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const handleSelectionKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || isEditableKeyboardTarget(event.target) || sortedCues.length === 0) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target !== panel && !target?.closest("[data-subtitle-cue-id]")) {
        return;
      }
      const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      if (direction === 0 || (!event.shiftKey && (event.ctrlKey || event.metaKey))) {
        return;
      }
      event.preventDefault();
      const focusedIndex = selectionFocusRef.current
        ? sortedCues.findIndex((cue) => cue.id === selectionFocusRef.current)
        : -1;
      const selectedIndex = sortedCues.findIndex((cue) => selectedCueIds.has(cue.id));
      const currentIndex = focusedIndex >= 0 ? focusedIndex : selectedIndex;
      const targetIndex =
        currentIndex < 0
          ? direction > 0
            ? 0
            : sortedCues.length - 1
          : clamp(currentIndex + direction, 0, sortedCues.length - 1);
      const targetId = sortedCues[targetIndex].id;
      selectionFocusRef.current = targetId;
      if (!event.shiftKey) {
        selectionAnchorRef.current = targetId;
        cueSelectionReplaced([targetId], targetId);
        rowVirtualizer.scrollToIndex(targetIndex, { align: "auto" });
        return;
      }
      const anchorIndex = selectionAnchorRef.current
        ? sortedCues.findIndex((cue) => cue.id === selectionAnchorRef.current)
        : -1;
      const resolvedAnchorIndex =
        anchorIndex >= 0 ? anchorIndex : Math.max(currentIndex, targetIndex);
      selectionAnchorRef.current = sortedCues[resolvedAnchorIndex].id;
      const start = Math.min(resolvedAnchorIndex, targetIndex);
      const end = Math.max(resolvedAnchorIndex, targetIndex);
      const nextSelection =
        event.ctrlKey || event.metaKey ? new Set(selectedCueIds) : new Set<string>();
      for (const cue of sortedCues.slice(start, end + 1)) {
        nextSelection.add(cue.id);
      }
      const primaryCueId = activeCueId && nextSelection.has(activeCueId) ? activeCueId : targetId;
      cueSelectionReplaced(nextSelection, primaryCueId);
      rowVirtualizer.scrollToIndex(targetIndex, { align: "auto" });
    };
    panel.addEventListener("keydown", handleSelectionKeyDown);
    return () => panel.removeEventListener("keydown", handleSelectionKeyDown);
  }, [activeCueId, cueSelectionReplaced, rowVirtualizer, selectedCueIds, sortedCues]);

  useEffect(() => {
    const handleRatingKey = (event: KeyboardEvent) => {
      if (
        !isEditAuthority ||
        selectedCueIds.size === 0 ||
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
        setCueRatings(selectedCueIds, 0);
        setContextMenu(null);
        return;
      }
      const rating = Number(event.key);
      if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
        return;
      }
      event.preventDefault();
      setCueRatings(selectedCueIds, rating);
    };
    window.addEventListener("keydown", handleRatingKey);
    return () => window.removeEventListener("keydown", handleRatingKey);
  }, [contextMenu, isEditAuthority, selectedCueIds, setCueRatings]);

  useEffect(
    () => () => {
      if (scrollAnimationRef.current !== null) {
        cancelAnimationFrame(scrollAnimationRef.current);
      }
      marqueeCleanupRef.current?.();
      sprayGestureCleanupRef.current?.();
      document.body.classList.remove("is-resizing-subtitle-column");
    },
    [],
  );

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    const list = listRef.current;
    const cue = sortedCues[followCueIndex];
    if (!list || !cue || followCueIndex < 0) {
      return;
    }
    const offsetInfo = rowVirtualizer.getOffsetForIndex(followCueIndex, "center");
    if (!offsetInfo) {
      return;
    }
    if (scrollAnimationRef.current !== null) {
      cancelAnimationFrame(scrollAnimationRef.current);
    }
    const startOffset = list.scrollTop;
    const initialTargetOffset = offsetInfo[0];
    const distance = Math.abs(initialTargetOffset - startOffset);
    const range = cueFrameRanges[chronologicalFollowCueIndex];
    const animationStartFrame = currentFrameRef.current;
    const isUpcomingCue =
      Boolean(range && animationStartFrame < range.startFrame) ||
      followCueIndex !== currentCueIndex;
    const viewportDistance = distance / Math.max(1, list.clientHeight);
    const distanceDuration = clamp(180 + Math.sqrt(viewportDistance) * 300, 160, 900);
    const preferredDuration = range
      ? (Math.max(0, range.startFrame - 1 - animationStartFrame) / frameRate) * 1000
      : distanceDuration;
    const latestDuration = range
      ? (Math.max(0, range.endFrame - 1 - animationStartFrame) / frameRate) * 1000
      : distanceDuration;
    const duration = isUpcomingCue
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
      return;
    }
    let startedAt: number | null = null;
    const animate = (timestamp: number) => {
      startedAt ??= timestamp;
      const progress = clamp((timestamp - startedAt) / duration, 0, 1);
      const currentOffsetInfo = rowVirtualizer.getOffsetForIndex(followCueIndex, "center");
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
  }, [
    chronologicalFollowCueIndex,
    cueFrameRanges,
    currentCueIndex,
    followCueId,
    followCueIndex,
    frameRate,
    isPlaying,
    rowVirtualizer,
    sortedCues,
  ]);

  useEffect(() => {
    if (!thumbnailVideoPath || thumbnailPrefetchStart >= thumbnailPrefetchEnd) {
      return;
    }
    const requests = sortedCues
      .slice(thumbnailPrefetchStart, thumbnailPrefetchEnd)
      .map((cue, offset) =>
        requestSubtitleThumbnail({
          assetId: thumbnailAssetId,
          fingerprint: thumbnailFingerprint,
          videoPath: thumbnailVideoPath,
          timeUs: cue.start_us,
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
    sortedCues,
    thumbnailAssetId,
    thumbnailFingerprint,
    thumbnailPrefetchEnd,
    thumbnailPrefetchStart,
    thumbnailPriorityCenterIndex,
    thumbnailVideoPath,
  ]);

  function selectVisibleCues() {
    const nextSelection = new Set(selectedCueIds);
    for (const cue of sortedCues) {
      nextSelection.add(cue.id);
    }
    const primaryCueId =
      activeCueId && nextSelection.has(activeCueId)
        ? activeCueId
        : (nextSelection.values().next().value ?? null);
    cueSelectionReplaced(nextSelection, primaryCueId);
  }

  function clearCueSelection() {
    const primaryCueId =
      activeCueId && selectedCueIds.has(activeCueId)
        ? activeCueId
        : (selectedCueIds.values().next().value ?? null);
    selectionAnchorRef.current = primaryCueId;
    selectionFocusRef.current = primaryCueId;
    if (primaryCueId) {
      cueSelectionReplaced([primaryCueId], primaryCueId);
      return;
    }
    cueSelectionCleared();
  }

  function handleCueSelection(
    event: ReactMouseEvent<HTMLElement>,
    cue: SubtitleCue,
    focusRange = false,
  ) {
    const additive = event.ctrlKey || event.metaKey;
    selectionFocusRef.current = cue.id;
    const currentSelection = new Set(selectedCueIds);
    let nextSelection: Set<string>;
    let primaryCueId = activeCueId;
    let shouldSeek = false;

    if (!event.shiftKey) {
      if (!additive) {
        selectionAnchorRef.current = cue.id;
      }
      if (additive) {
        nextSelection = new Set(currentSelection);
        if (nextSelection.has(cue.id)) {
          nextSelection.delete(cue.id);
          if (primaryCueId === cue.id) {
            primaryCueId = null;
          }
        } else {
          nextSelection.add(cue.id);
          if (!primaryCueId) {
            primaryCueId = cue.id;
            shouldSeek = true;
          }
        }
      } else {
        nextSelection = new Set([cue.id]);
        primaryCueId = cue.id;
        shouldSeek = true;
      }
    } else {
      const cueIndex = sortedCues.findIndex((candidate) => candidate.id === cue.id);
      if (cueIndex < 0) {
        return;
      }
      const anchorIndex = selectionAnchorRef.current
        ? sortedCues.findIndex((candidate) => candidate.id === selectionAnchorRef.current)
        : sortedCues.findIndex((candidate) => currentSelection.has(candidate.id));
      const resolvedAnchorIndex = anchorIndex >= 0 ? anchorIndex : cueIndex;
      const start = Math.min(resolvedAnchorIndex, cueIndex);
      const end = Math.max(resolvedAnchorIndex, cueIndex);
      nextSelection = additive ? new Set(currentSelection) : new Set<string>();
      for (const candidate of sortedCues.slice(start, end + 1)) {
        nextSelection.add(candidate.id);
      }
      if (primaryCueId) {
        nextSelection.add(primaryCueId);
      }
      selectionAnchorRef.current = sortedCues[resolvedAnchorIndex]?.id ?? cue.id;
      if (!primaryCueId) {
        primaryCueId = cue.id;
        shouldSeek = true;
      }
    }

    cueSelectionReplaced(nextSelection, primaryCueId);
    if (shouldSeek && primaryCueId === cue.id) {
      seekToCue(cue, focusRange);
    }
  }

  function handleCueDoubleClick(event: ReactMouseEvent<HTMLElement>, cue: SubtitleCue) {
    const target = event.target as HTMLElement;
    if (target.closest(".cue-frame-button, .cue-rating-button, .cue-flag-button")) {
      return;
    }
    seekToCue(cue, true);
  }

  function syncTableHeaderScroll(event: ReactUIEvent<HTMLDivElement>) {
    if (tableHeaderRef.current) {
      tableHeaderRef.current.style.transform = `translateX(${-event.currentTarget.scrollLeft}px)`;
    }
  }

  function buildCurrentSubtitleSource() {
    return buildSubtitleExportSource({
      videoId: activeVideoId,
      trackId: activeTrackId,
      cueIds: contextMenuCueIds,
      mediaItems,
      projects,
      detachedVideoIds,
    });
  }

  function exportSelectedCues() {
    const source = buildCurrentSubtitleSource();
    if (source) {
      requestExport(source);
      setContextMenu(null);
    }
  }

  async function quickExportWithLastSettings() {
    // Close the menu before awaiting: the export may take a long time or throw,
    // and a deferred close would otherwise leave the context menu hanging open.
    setContextMenu(null);
    const source = buildCurrentSubtitleSource();
    if (!source || !exportState) {
      return;
    }
    const submission = enqueueQuickExport(source, exportState);
    messagePublished(
      submission.queuePosition === 1
        ? "已开始导出"
        : `已加入导出队列，前面有 ${submission.queuePosition - 1} 个任务`,
    );
    const outcome = await submission.completion;
    if (outcome.status === "success") {
      const completed = outcome.result.outputs.filter(
        (output) => output.status === "completed",
      ).length;
      const failed = outcome.result.outputs.filter((output) => output.status === "failed").length;
      messagePublished(`已导出 ${completed} 个片段${failed > 0 ? `，${failed} 个失败` : ""}`);
    } else if (outcome.status === "cancelled") {
      messagePublished("导出已取消");
    }
  }

  useExportCapability({
    identity,
    active: isEditAuthority,
    selectedCount: buildCurrentSubtitleSource()?.clips.length ?? 0,
    hasLastSettings: Boolean(exportState),
    handlers: {
      configure: exportSelectedCues,
      quick: quickExportWithLastSettings,
    },
  });

  function openContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-subtitle-cue-id]",
    );
    const cueId = row?.dataset.subtitleCueId;
    if (cueId && !selectedCueIds.has(cueId)) {
      cueSelectionReplaced([cueId], cueId);
      selectionAnchorRef.current = cueId;
      selectionFocusRef.current = cueId;
    }
    panelRef.current?.focus({ preventScroll: true });
    setTrackMenu(null);
    setAnnotationMenu(null);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      cueId: cueId ?? null,
      exportSubmenuOpen: false,
      flagSubmenuOpen: false,
      ratingSubmenuOpen: false,
      colorSubmenuOpen: false,
    });
  }

  function openAnnotationMenu(
    event: ReactMouseEvent<HTMLButtonElement>,
    cueId: string,
    kind: "flag" | "color",
  ) {
    event.preventDefault();
    event.stopPropagation();
    panelRef.current?.focus({ preventScroll: true });
    setTrackMenu(null);
    setContextMenu(null);
    setAnnotationMenu({
      x: event.clientX,
      y: event.clientY,
      cueId,
      kind,
    });
  }

  function startMarqueeSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const surface = event.currentTarget;
    const bounds = surface.getBoundingClientRect();
    const pointsAtScrollbar =
      event.clientX >= bounds.left + surface.clientWidth ||
      event.clientY >= bounds.top + surface.clientHeight;
    if (
      event.button !== 0 ||
      sortedCues.length === 0 ||
      pointsAtScrollbar ||
      (event.target as HTMLElement | null)?.closest("[data-subtitle-cue-id]")
    ) {
      return;
    }
    event.preventDefault();
    marqueeCleanupRef.current?.();
    const pointerId = event.pointerId;
    const initialSelection = new Set(selectedCueIds);
    const togglesSelection = event.ctrlKey || event.metaKey;
    const addsSelection = event.shiftKey && !togglesSelection;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let lastSelection = new Set(selectedCueIds);
    const selectionsMatch = (left: Set<string>, right: Set<string>) =>
      left.size === right.size && Array.from(left).every((cueId) => right.has(cueId));
    const updateSelection = (currentX: number, currentY: number) => {
      const left = Math.min(startX, currentX);
      const right = Math.max(startX, currentX);
      const top = Math.min(startY, currentY);
      const bottom = Math.max(startY, currentY);
      const hitIds = new Set(
        Array.from(surface.querySelectorAll<HTMLElement>("[data-subtitle-cue-id]"))
          .filter((element) => {
            const rowBounds = element.getBoundingClientRect();
            return (
              rowBounds.right >= left &&
              rowBounds.left <= right &&
              rowBounds.bottom >= top &&
              rowBounds.top <= bottom
            );
          })
          .map((element) => element.dataset.subtitleCueId)
          .filter((cueId): cueId is string => Boolean(cueId)),
      );
      const nextSelection =
        togglesSelection || addsSelection ? new Set(initialSelection) : new Set<string>();
      if (togglesSelection) {
        for (const cueId of hitIds) {
          if (initialSelection.has(cueId)) {
            nextSelection.delete(cueId);
          } else {
            nextSelection.add(cueId);
          }
        }
      } else {
        for (const cueId of hitIds) {
          nextSelection.add(cueId);
        }
      }

      if (!selectionsMatch(lastSelection, nextSelection)) {
        lastSelection = nextSelection;
        let lastHitId: string | undefined;
        for (const cue of sortedCues) {
          if (hitIds.has(cue.id)) {
            lastHitId = cue.id;
          }
        }
        if (lastHitId && nextSelection.has(lastHitId)) {
          selectionAnchorRef.current = lastHitId;
          selectionFocusRef.current = lastHitId;
        } else if (nextSelection.size === 0) {
          selectionAnchorRef.current = null;
          selectionFocusRef.current = null;
        }
        const primaryCueId =
          lastHitId && nextSelection.has(lastHitId)
            ? lastHitId
            : activeCueId && nextSelection.has(activeCueId)
              ? activeCueId
              : null;
        cueSelectionReplaced(nextSelection, primaryCueId);
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
        cueSelectionCleared();
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

  function applySprayToCue(cueId: string, historyGroupId: string) {
    if (sprayMode === "colorLabel") {
      const customLabel = sprayCustomLabel.trim();
      if (customLabel) {
        setCueCustomLabels([cueId], customLabel, historyGroupId);
      } else {
        setCueColorLabels([cueId], sprayColorLabel, historyGroupId);
      }
    } else if (sprayMode === "flag") {
      setCueFlags([cueId], sprayFlag, historyGroupId);
    } else {
      setCueRatings([cueId], sprayRating, historyGroupId);
    }
  }

  function cueIdFromPoint(target: EventTarget | null, clientX: number, clientY: number) {
    const element = target instanceof Element ? target : null;
    if (!element || !panelRef.current?.contains(element)) {
      return null;
    }
    const cueElement = element.closest<HTMLElement>("[data-subtitle-cue-id]");
    const thumbnail = cueElement?.querySelector<HTMLElement>(".cue-frame-button");
    if (!cueElement || !thumbnail) {
      return null;
    }
    const bounds = thumbnail.getBoundingClientRect();
    return clientX >= bounds.left &&
      clientX <= bounds.right &&
      clientY >= bounds.top &&
      clientY <= bounds.bottom
      ? (cueElement.dataset.subtitleCueId ?? null)
      : null;
  }

  function startSprayGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sprayActive || event.button !== 0 || !event.isPrimary) {
      return;
    }
    const initialCueId = cueIdFromPoint(event.target, event.clientX, event.clientY);
    if (!initialCueId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    panelRef.current?.focus({ preventScroll: true });
    sprayGestureCleanupRef.current?.();
    const pointerId = event.pointerId;
    const historyGroupId = `subtitle-spray-${Date.now()}-${pointerId}`;
    const paintedCueIds = new Set<string>();
    const paintTarget = (target: EventTarget | null, clientX: number, clientY: number) => {
      const cueId = cueIdFromPoint(target, clientX, clientY);
      if (!cueId || paintedCueIds.has(cueId)) {
        return;
      }
      paintedCueIds.add(cueId);
      applySprayToCue(cueId, historyGroupId);
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
    paintedCueIds.add(initialCueId);
    applySprayToCue(initialCueId, historyGroupId);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onFinish);
    window.addEventListener("pointercancel", onFinish);
    window.addEventListener("blur", cleanup);
  }

  function suppressSprayClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (
      !sprayActive ||
      event.button !== 0 ||
      !cueIdFromPoint(event.target, event.clientX, event.clientY)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function deactivateSprayTool() {
    sprayGestureCleanupRef.current?.();
    setFooterSprayMenu(null);
    setSprayActive(false);
  }

  function setRatingFilter(rating: number) {
    setMinimumRating(minimumRating === rating ? 0 : rating);
  }

  function toggleFlagFilter(flag: SubtitleCueFlag) {
    setFlagFilters(
      flagFilters.includes(flag)
        ? flagFilters.filter((current) => current !== flag)
        : subtitleCueFlags.filter((current) => current === flag || flagFilters.includes(current)),
    );
  }

  function toggleEditFilter(editFilter: SubtitleCueEditFilter) {
    setEditFilters(
      editFilters.includes(editFilter)
        ? editFilters.filter((current) => current !== editFilter)
        : subtitleCueEditFilters.filter(
            (current) => current === editFilter || editFilters.includes(current),
          ),
    );
  }

  function toggleColorLabelFilter(colorLabel: SubtitleCueColorLabelFilter) {
    setColorLabelFilters(
      colorLabelFilters.includes(colorLabel)
        ? colorLabelFilters.filter((current) => current !== colorLabel)
        : subtitleCueColorFilterLabels
            .map(([current]) => current)
            .filter((current) => current === colorLabel || colorLabelFilters.includes(current)),
    );
  }

  function toggleCueSort(columnId: SubtitleSortableColumnId) {
    if (allCues.length === 0) {
      return;
    }
    setCueSort((current) =>
      current.columnId === columnId
        ? {
            columnId,
            direction: current.direction === "ascending" ? "descending" : "ascending",
          }
        : { columnId, direction: "ascending" },
    );
  }

  function startColumnResize(
    event: ReactPointerEvent<HTMLButtonElement>,
    columnId: SubtitleResizableColumnId,
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
      startWidth: subtitleColumnWidths[columnId],
      pointerId: event.pointerId,
    };
    document.body.classList.add("is-resizing-subtitle-column");
  }

  function updateColumnResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const resize = columnResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) {
      return;
    }
    const width = clamp(
      resize.startWidth + event.clientX - resize.startX,
      minimumSubtitleColumnWidths[resize.columnId],
      maximumSubtitleColumnWidths[resize.columnId],
    );
    setSubtitleColumnWidths((current) =>
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
    document.body.classList.remove("is-resizing-subtitle-column");
  }

  function resetColumnWidth(columnId: SubtitleResizableColumnId) {
    setSubtitleColumnWidths((current) => ({
      ...current,
      [columnId]: initialSubtitleColumnWidths[columnId],
    }));
  }

  function renderTableHeader(header: (typeof subtitleTableHeaders)[number]) {
    const isActive =
      header.sortColumnId !== undefined &&
      allCues.length > 0 &&
      cueSort.columnId === header.sortColumnId;
    const nextDirection = isActive && cueSort.direction === "ascending" ? "降序" : "升序";
    return (
      <span
        key={header.id}
        className={`subtitle-column-header subtitle-column-${header.id}`}
        role="columnheader"
        aria-sort={isActive ? cueSort.direction : undefined}
      >
        {header.sortColumnId ? (
          <button
            type="button"
            className={`subtitle-column-sort-button ${isActive ? "active" : ""}`}
            title={`按${header.label}${nextDirection}排列`}
            aria-label={`按${header.label}${nextDirection}排列`}
            onClick={() => toggleCueSort(header.sortColumnId!)}
            disabled={allCues.length === 0}
          >
            <span className="subtitle-column-label-text">{header.label}</span>
            {isActive && <SortArrow direction={cueSort.direction} />}
          </button>
        ) : header.label ? (
          <span className="subtitle-column-label-text">{header.label}</span>
        ) : null}
        {header.resizeColumn && (
          <button
            type="button"
            className="subtitle-column-resizer"
            title={`调整${subtitleResizableColumnLabels[header.resizeColumn]}列宽，双击恢复默认`}
            aria-label={`调整${subtitleResizableColumnLabels[header.resizeColumn]}列宽`}
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

  useEditCapability({
    identity,
    active: isEditAuthority,
    selectedCount,
    visibleCount: sortedCues.length,
    handlers: {
      selectAll: selectVisibleCues,
      clearSelection: hasSecondarySelection ? clearCueSelection : undefined,
    },
  });

  return (
    <section ref={panelRef} className="subtitle-panel" style={panelStyle} tabIndex={-1}>
      <div className="subtitle-project-row">
        <Captions aria-hidden="true" />
        <span>字幕</span>
        <button
          type="button"
          className={`subtitle-track-trigger ${trackMenu ? "active" : ""}`}
          disabled={trackOptions.length === 0}
          title={activeTrackLabel}
          aria-label={`选择字幕，当前为${activeTrackLabel}`}
          aria-haspopup="menu"
          aria-expanded={Boolean(trackMenu)}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (trackMenu) {
              setTrackMenu(null);
              return;
            }
            setContextMenu(null);
            setAnnotationMenu(null);
            setRatingComparatorMenu(null);
            setFooterSortMenu(null);
            setFooterSprayMenu(null);
            setFooterOptionsMenu(null);
            const bounds = event.currentTarget.getBoundingClientRect();
            setTrackMenu({ x: bounds.left, y: bounds.bottom });
          }}
        >
          <span className="subtitle-track-name">{activeTrackLabel}</span>
          <ChevronsUpDown aria-hidden="true" />
        </button>
      </div>

      <div className="subtitle-search-row">
        <label className="subtitle-search">
          <Search aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="搜索字幕"
            disabled={!activeTrack}
          />
        </label>
        <span className="subtitle-selection-summary">
          {selectedCount} 条已选择，共 {sortedCues.length} 条
        </span>
      </div>

      <div
        className={`subtitle-filter-row ${
          flagFilters.length === 0 &&
          editFilters.length === 0 &&
          minimumRating === 0 &&
          colorLabelFilters.length === 0
            ? "is-filter-closed"
            : ""
        }`}
      >
        <span className="subtitle-filter-label">过滤器</span>
        <span className="subtitle-filter-separator" aria-hidden="true" />
        <span className={`subtitle-filter-section-label ${flagFilters.length ? "is-active" : ""}`}>
          旗标
        </span>
        <div className="subtitle-filter-flags" aria-label="按旗标过滤">
          {subtitleCueFlags.map((flag) => (
            <button
              key={flag}
              type="button"
              className={flagFilters.includes(flag) ? "active" : ""}
              onClick={() => toggleFlagFilter(flag)}
              disabled={allCues.length === 0}
              title={subtitleCueFlagLabels[flag]}
              aria-label={subtitleCueFlagLabels[flag]}
              aria-pressed={flagFilters.includes(flag)}
            >
              <SubtitleFlagIcon flag={flag} />
            </button>
          ))}
        </div>
        <span className="subtitle-filter-separator" aria-hidden="true" />
        <span className={`subtitle-filter-section-label ${editFilters.length ? "is-active" : ""}`}>
          编辑
        </span>
        <div className="subtitle-filter-edits" aria-label="按编辑状态过滤">
          {subtitleCueEditFilters.map((editFilter) => {
            const edited = editFilter === "edited";
            const label = edited ? "已编辑" : "未编辑";
            return (
              <button
                key={editFilter}
                type="button"
                className={editFilters.includes(editFilter) ? "active" : ""}
                onClick={() => toggleEditFilter(editFilter)}
                disabled={allCues.length === 0}
                title={label}
                aria-label={label}
                aria-pressed={editFilters.includes(editFilter)}
              >
                <SubtitleEditFilterIcon edited={edited} />
              </button>
            );
          })}
        </div>
        <span className="subtitle-filter-separator" aria-hidden="true" />
        <span className={`subtitle-filter-section-label ${minimumRating ? "is-active" : ""}`}>
          星级
        </span>
        <button
          type="button"
          className={`subtitle-filter-comparator is-${ratingComparator} ${
            ratingComparatorMenu ? "open" : ""
          }`}
          aria-label="星级比较方式"
          aria-haspopup="menu"
          aria-expanded={Boolean(ratingComparatorMenu)}
          title={subtitleRatingComparatorLabels[ratingComparator]}
          disabled={allCues.length === 0}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (ratingComparatorMenu) {
              setRatingComparatorMenu(null);
              return;
            }
            setContextMenu(null);
            setAnnotationMenu(null);
            setTrackMenu(null);
            setFooterSortMenu(null);
            setFooterSprayMenu(null);
            setFooterOptionsMenu(null);
            const bounds = event.currentTarget.getBoundingClientRect();
            setRatingComparatorMenu({ x: bounds.left, y: bounds.bottom });
          }}
        >
          <span>{subtitleRatingComparatorSymbols[ratingComparator]}</span>
        </button>
        <div className="subtitle-filter-stars" aria-label="按星级过滤">
          {subtitleRatingFilters.map((rating) => (
            <button
              key={rating}
              type="button"
              className={rating <= minimumRating ? "active" : ""}
              onClick={() => setRatingFilter(rating)}
              disabled={allCues.length === 0}
              title={`筛选${subtitleRatingComparatorLabels[ratingComparator]} ${rating} 星`}
              aria-label={`筛选${subtitleRatingComparatorLabels[ratingComparator]} ${rating} 星`}
              aria-pressed={rating <= minimumRating}
            >
              <Star aria-hidden="true" />
            </button>
          ))}
        </div>
        <span className="subtitle-filter-separator" aria-hidden="true" />
        <span
          className={`subtitle-filter-section-label ${colorLabelFilters.length ? "is-active" : ""}`}
        >
          颜色
        </span>
        <SubtitleColorLabelButtons
          className="subtitle-filter-colors"
          activeValues={colorLabelFilters}
          ariaLabel="按色标过滤"
          buttonLabel={(_, label) => `按${label}色标过滤`}
          includeNone
          onSelect={toggleColorLabelFilter}
          disabled={allCues.length === 0}
        />
      </div>

      <div
        className={`subtitle-content ${sprayActive ? "is-spraying" : ""}`}
        onPointerDownCapture={startSprayGesture}
        onClickCapture={suppressSprayClick}
        onDoubleClickCapture={suppressSprayClick}
        onPointerDown={(event) => {
          if (!isEditableKeyboardTarget(event.target)) {
            panelRef.current?.focus({ preventScroll: true });
          }
        }}
      >
        {activeTrack?.warning && <div className="warning-line">{activeTrack.warning}</div>}
        <SubtitleListView
          cues={sortedCues}
          currentCueIndex={currentCueIndex}
          tableStyle={tableStyle}
          headerContent={subtitleTableHeaders.map(renderTableHeader)}
          rowVirtualizer={rowVirtualizer}
          virtualRows={virtualRows}
          thumbnailPriorityCenterIndex={thumbnailPriorityCenterIndex}
          assetId={thumbnailAssetId}
          fingerprint={thumbnailFingerprint}
          videoPath={thumbnailVideoPath}
          previewVideoPath={thumbnailPreviewVideoPath}
          frameRate={frameRate}
          resetKey={trackContext}
          headerRef={tableHeaderRef}
          scrollRef={listRef}
          onScroll={syncTableHeaderScroll}
          onPointerDown={startMarqueeSelection}
          onContextMenu={openContextMenu}
          onSelectCue={handleCueSelection}
          onDoubleClickCue={handleCueDoubleClick}
          onOpenAnnotationMenu={openAnnotationMenu}
          cueLabel={(cue) => cueLabel(cueAnnotations[cue.id])}
        />
      </div>

      {marqueeSelection &&
        createPortal(
          <div
            className="subtitle-marquee-selection"
            style={{
              left: Math.min(marqueeSelection.startX, marqueeSelection.currentX),
              top: Math.min(marqueeSelection.startY, marqueeSelection.currentY),
              width: Math.abs(marqueeSelection.currentX - marqueeSelection.startX),
              height: Math.abs(marqueeSelection.currentY - marqueeSelection.startY),
            }}
          />,
          document.body,
        )}

      <footer className="subtitle-footer">
        <div className="subtitle-selection-tools">
          {footerAreaVisibility.selection && (
            <div className="subtitle-footer-area subtitle-footer-selection-area">
              <button
                type="button"
                className={showOnlySelected ? "active" : ""}
                onClick={() => setShowOnlySelected(!showOnlySelected)}
                disabled={selectedCount === 0}
                title="仅展示选中字幕"
                aria-pressed={showOnlySelected}
              >
                <ListFilter aria-hidden="true" />
              </button>
              <span className="subtitle-filter-separator subtitle-footer-separator" />
            </div>
          )}
          {footerAreaVisibility.sprayTool && (
            <div
              className={`subtitle-footer-area subtitle-footer-spray-area ${sprayActive ? "is-active" : ""}`}
            >
              {sprayActive ? (
                <>
                  <button
                    type="button"
                    className="subtitle-footer-spray-button is-empty"
                    onClick={deactivateSprayTool}
                    title="放回喷瓶并退出喷涂"
                    aria-label="放回喷瓶并退出喷涂"
                  >
                    <span className="subtitle-footer-spray-icon-background" aria-hidden="true" />
                  </button>
                  <div className="subtitle-footer-sort-control subtitle-footer-spray-control">
                    <button
                      type="button"
                      className={`subtitle-footer-sort-trigger subtitle-footer-spray-trigger ${
                        footerSprayMenu ? "active" : ""
                      }`}
                      aria-haspopup="menu"
                      aria-expanded={Boolean(footerSprayMenu)}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        setContextMenu(null);
                        setAnnotationMenu(null);
                        setTrackMenu(null);
                        setFooterSortMenu(null);
                        setFooterOptionsMenu(null);
                        if (footerSprayMenu) {
                          setFooterSprayMenu(null);
                          return;
                        }
                        const bounds = event.currentTarget.getBoundingClientRect();
                        setFooterSprayMenu({ x: bounds.left, y: bounds.top });
                      }}
                    >
                      <span className="subtitle-footer-sort-label">喷涂：</span>
                      <span className="subtitle-footer-sort-value">
                        {subtitleSprayModeLabels[sprayMode]}
                      </span>
                      <ChevronsUpDown aria-hidden="true" />
                    </button>
                  </div>
                  <span className="subtitle-filter-separator subtitle-footer-separator" />
                  {sprayMode === "colorLabel" && (
                    <div className="subtitle-footer-spray-label-controls">
                      <SubtitleColorLabelButtons
                        className="subtitle-footer-colors subtitle-footer-spray-colors"
                        activeValues={sprayColorLabel ? [sprayColorLabel] : []}
                        ariaLabel="选择喷涂标签"
                        buttonLabel={(_, label, active) =>
                          active ? `清除${label}喷涂标签` : `喷涂${label}标签`
                        }
                        onSelect={(colorLabel) => {
                          setSprayCustomLabel("");
                          setSprayColorLabel((current) =>
                            current === colorLabel ? null : (colorLabel as SubtitleCueColorLabel),
                          );
                        }}
                      />
                      <input
                        className="cue-label-editor subtitle-footer-spray-label-input"
                        value={sprayCustomLabel}
                        aria-label="自定义喷涂标签"
                        title="自定义喷涂标签"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => {
                          setSprayCustomLabel(event.currentTarget.value);
                          if (event.currentTarget.value.trim()) {
                            setSprayColorLabel(null);
                          }
                        }}
                      />
                    </div>
                  )}
                  {sprayMode === "flag" && (
                    <div className="subtitle-footer-flag-controls" aria-label="选择喷涂旗标">
                      {(["retained", "excluded"] as const).map((flag) => {
                        const active = sprayFlag === flag;
                        return (
                          <button
                            key={flag}
                            type="button"
                            className={`subtitle-footer-flag-button ${active ? "active" : ""}`}
                            onClick={() => setSprayFlag(active ? "none" : flag)}
                            title={active ? "喷涂无旗标" : `喷涂${subtitleCueFlagLabels[flag]}`}
                            aria-label={
                              active ? "喷涂无旗标" : `喷涂${subtitleCueFlagLabels[flag]}`
                            }
                            aria-pressed={active}
                          >
                            <span className={`cue-thumbnail-flag is-${flag}`} aria-hidden="true" />
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {sprayMode === "rating" && (
                    <div className="subtitle-footer-rating-controls" aria-label="选择喷涂星级">
                      {subtitleRatingFilters.map((rating) => (
                        <button
                          key={rating}
                          type="button"
                          className={rating <= sprayRating ? "active" : ""}
                          onClick={() => setSprayRating(sprayRating === rating ? 0 : rating)}
                          title={sprayRating === rating ? "喷涂零星" : `喷涂 ${rating} 星`}
                          aria-label={sprayRating === rating ? "喷涂零星" : `喷涂 ${rating} 星`}
                          aria-pressed={sprayRating === rating}
                        >
                          <Star aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="subtitle-footer-spray-button"
                  onClick={() => {
                    setContextMenu(null);
                    setAnnotationMenu(null);
                    setTrackMenu(null);
                    setFooterSortMenu(null);
                    setFooterSprayMenu(null);
                    setFooterOptionsMenu(null);
                    setSprayActive(true);
                  }}
                  disabled={allCues.length === 0}
                  title="喷涂工具"
                  aria-label="启用喷涂工具"
                >
                  <span className="subtitle-footer-spray-icon-background">
                    <SubtitleSprayBottleIcon
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
                <span className="subtitle-filter-separator subtitle-footer-separator" />
              )}
            </div>
          )}
          {!sprayActive && footerAreaVisibility.sort && (
            <div className="subtitle-footer-area subtitle-footer-sort-area">
              <div className="subtitle-footer-sort-control">
                <button
                  type="button"
                  className="subtitle-footer-sort-direction"
                  onClick={() => {
                    setFooterSortMenu(null);
                    setCueSort((current) => ({
                      ...current,
                      direction: current.direction === "ascending" ? "descending" : "ascending",
                    }));
                  }}
                  disabled={allCues.length === 0}
                  title={cueSort.direction === "ascending" ? "切换为降序" : "切换为升序"}
                  aria-label={
                    cueSort.direction === "ascending"
                      ? "当前升序，切换为降序"
                      : "当前降序，切换为升序"
                  }
                >
                  {cueSort.direction === "ascending" ? (
                    <ArrowDownAZ aria-hidden="true" />
                  ) : (
                    <ArrowDownZA aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  className={`subtitle-footer-sort-trigger ${footerSortMenu ? "active" : ""}`}
                  aria-haspopup="menu"
                  aria-expanded={Boolean(footerSortMenu)}
                  disabled={allCues.length === 0}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setContextMenu(null);
                    setAnnotationMenu(null);
                    setTrackMenu(null);
                    setFooterOptionsMenu(null);
                    if (footerSortMenu) {
                      setFooterSortMenu(null);
                      return;
                    }
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setFooterSortMenu({ x: bounds.left, y: bounds.top });
                  }}
                >
                  <span className="subtitle-footer-sort-label">排序依据：</span>
                  <span className="subtitle-footer-sort-value">{footerSortLabel}</span>
                  <ChevronsUpDown aria-hidden="true" />
                </button>
              </div>
              <span className="subtitle-filter-separator subtitle-footer-separator" />
            </div>
          )}
          {!sprayActive && footerAreaVisibility.flag && (
            <div className="subtitle-footer-area subtitle-footer-flag-area">
              <div className="subtitle-footer-flag-controls" aria-label="设置所选字幕旗标">
                {(["retained", "excluded"] as const).map((flag) => {
                  const active = contextMenuFlag === flag;
                  return (
                    <button
                      key={flag}
                      type="button"
                      className={`subtitle-footer-flag-button ${active ? "active" : ""}`}
                      onClick={() => setCueFlags(contextMenuCueIds, active ? "none" : flag)}
                      disabled={contextMenuCueIds.length === 0}
                      title={
                        active
                          ? `取消${subtitleCueFlagLabels[flag]}`
                          : `设置${subtitleCueFlagLabels[flag]}`
                      }
                      aria-label={
                        active
                          ? `取消${subtitleCueFlagLabels[flag]}`
                          : `设置${subtitleCueFlagLabels[flag]}`
                      }
                      aria-pressed={active}
                    >
                      <span className={`cue-thumbnail-flag is-${flag}`} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
              <span className="subtitle-filter-separator subtitle-footer-separator" />
            </div>
          )}
          {!sprayActive && footerAreaVisibility.rating && (
            <div className="subtitle-footer-area subtitle-footer-rating-area">
              <div className="subtitle-footer-rating-controls" aria-label="设置所选字幕星级">
                {subtitleRatingFilters.map((rating) => (
                  <button
                    key={rating}
                    type="button"
                    className={
                      contextMenuRating !== null && rating <= contextMenuRating ? "active" : ""
                    }
                    onClick={() =>
                      setCueRatings(contextMenuCueIds, contextMenuRating === rating ? 0 : rating)
                    }
                    disabled={contextMenuCueIds.length === 0}
                    title={contextMenuRating === rating ? "取消星级" : `设为 ${rating} 星`}
                    aria-label={contextMenuRating === rating ? "取消星级" : `设为 ${rating} 星`}
                    aria-pressed={contextMenuRating === rating}
                  >
                    <Star aria-hidden="true" />
                  </button>
                ))}
              </div>
              <span className="subtitle-filter-separator subtitle-footer-separator" />
            </div>
          )}
          {!sprayActive && footerAreaVisibility.colorLabel && (
            <div className="subtitle-footer-area subtitle-footer-color-area">
              <SubtitleColorLabelButtons
                className="subtitle-footer-colors"
                activeValues={contextMenuColorLabel ? [contextMenuColorLabel] : []}
                ariaLabel="设置所选字幕色标"
                buttonLabel={(_, label, active) =>
                  active ? `清除${label}色标` : `设置${label}色标`
                }
                onSelect={(colorLabel) =>
                  setCueColorLabels(
                    contextMenuCueIds,
                    colorLabel === "none" ||
                      colorLabel === "custom" ||
                      contextMenuColorLabel === colorLabel
                      ? null
                      : colorLabel,
                  )
                }
                disabled={contextMenuCueIds.length === 0}
              />
              <span className="subtitle-filter-separator subtitle-footer-separator" />
            </div>
          )}
        </div>
        <div className="subtitle-thumbnail-tools">
          {sprayActive ? (
            <button
              type="button"
              className="subtitle-footer-spray-confirm"
              onClick={deactivateSprayTool}
            >
              完成
            </button>
          ) : (
            <>
              {footerAreaVisibility.thumbnailSize && (
                <>
                  <span className="subtitle-thumbnail-size-label">缩略图：</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={thumbnailSize}
                    aria-label="字幕缩略图大小"
                    onChange={(event) => setThumbnailSize(Number(event.currentTarget.value))}
                  />
                </>
              )}
              <span className="subtitle-filter-separator subtitle-footer-separator" />
              <button
                type="button"
                className={`subtitle-footer-options-trigger ${footerOptionsMenu ? "active" : ""}`}
                aria-haspopup="menu"
                aria-expanded={Boolean(footerOptionsMenu)}
                title="更多选项"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setContextMenu(null);
                  setAnnotationMenu(null);
                  setTrackMenu(null);
                  setFooterSortMenu(null);
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setFooterOptionsMenu(
                    footerOptionsMenu ? null : { x: bounds.left, y: bounds.top },
                  );
                }}
              >
                <ChevronDown aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </footer>

      {trackMenu &&
        createPortal(
          <PopupMenu
            className="subtitle-track-menu"
            contextMenuAnchor={trackMenu}
            ariaLabel="选择字幕"
            style={{ position: "fixed", left: trackMenu.x, top: trackMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {trackOptions.map((option) => (
              <PopupMenuItem
                key={option.id}
                checked={activeTrack?.id === option.id}
                onSelect={() => {
                  activeTrackChanged(option.id);
                  setTrackMenu(null);
                }}
              >
                {option.label}
              </PopupMenuItem>
            ))}
          </PopupMenu>,
          document.body,
        )}

      {ratingComparatorMenu &&
        createPortal(
          <PopupMenu
            className="subtitle-rating-comparator-menu"
            contextMenuAnchor={ratingComparatorMenu}
            ariaLabel="星级比较方式"
            style={{ position: "fixed", left: ratingComparatorMenu.x, top: ratingComparatorMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {subtitleRatingComparatorOptions.map(([comparator, label]) => (
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

      {footerSprayMenu &&
        createPortal(
          <PopupMenu
            className="subtitle-footer-spray-menu"
            contextMenuAnchor={footerSprayMenu}
            ariaLabel="喷涂属性"
            style={{ position: "fixed", left: footerSprayMenu.x, top: footerSprayMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {subtitleSprayModeOptions.map(([mode, label]) => (
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

      {footerSortMenu &&
        createPortal(
          <PopupMenu
            className="subtitle-footer-sort-menu"
            contextMenuAnchor={footerSortMenu}
            ariaLabel="字幕排序依据"
            style={{ position: "fixed", left: footerSortMenu.x, top: footerSortMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {subtitleSortOptions.map((option) => (
              <Fragment key={option.id}>
                {option.id === "rating" && <PopupMenuSeparator />}
                <PopupMenuItem
                  checked={cueSort.columnId === option.id}
                  onSelect={() => {
                    setCueSort((current) =>
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
            className="subtitle-footer-options-menu"
            contextMenuAnchor={footerOptionsMenu}
            ariaLabel="字幕面板更多选项"
            style={{ position: "fixed", left: footerOptionsMenu.x, top: footerOptionsMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
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
              checked={footerAreaVisibility.sort}
              onSelect={() =>
                setFooterAreaVisibility((current) => ({ ...current, sort: !current.sort }))
              }
            >
              排序
            </PopupMenuItem>
            <PopupMenuItem
              checked={footerAreaVisibility.flag}
              onSelect={() =>
                setFooterAreaVisibility((current) => ({ ...current, flag: !current.flag }))
              }
            >
              旗标
            </PopupMenuItem>
            <PopupMenuItem
              checked={footerAreaVisibility.rating}
              onSelect={() =>
                setFooterAreaVisibility((current) => ({ ...current, rating: !current.rating }))
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

      {annotationMenu &&
        createPortal(
          <PopupMenu
            className="subtitle-context-menu"
            contextMenuAnchor={annotationMenu}
            enableMnemonics
            style={{ position: "fixed", left: annotationMenu.x, top: annotationMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {annotationMenu.kind === "flag" ? (
              <SubtitleFlagMenuItems
                checkedFlag={annotationMenuFlag}
                onSelect={(flag) => {
                  setCueFlags(annotationMenuCueIds, flag);
                  setAnnotationMenu(null);
                }}
              />
            ) : (
              <SubtitleColorMenuItems
                checkedColorLabel={annotationMenuColorLabel}
                onSelect={(colorLabel) => {
                  setCueColorLabels(annotationMenuCueIds, colorLabel);
                  setAnnotationMenu(null);
                }}
              />
            )}
          </PopupMenu>,
          document.body,
        )}

      {contextMenu &&
        createPortal(
          <PopupMenu
            className="subtitle-context-menu"
            contextMenuAnchor={contextMenu}
            enableMnemonics={!contextSubmenuOpen}
            style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <PopupMenuSubmenu
              label="设置旗标(F)"
              mnemonic="F"
              open={contextMenu.flagSubmenuOpen}
              enableMnemonics
              menuClassName="subtitle-context-menu"
              onOpenChange={(open) =>
                setContextMenu((current) =>
                  current
                    ? {
                        ...current,
                        exportSubmenuOpen: open ? false : current.exportSubmenuOpen,
                        flagSubmenuOpen: open,
                        ratingSubmenuOpen: open ? false : current.ratingSubmenuOpen,
                        colorSubmenuOpen: open ? false : current.colorSubmenuOpen,
                      }
                    : current,
                )
              }
              disabled={contextMenuCueIds.length === 0}
            >
              <SubtitleFlagMenuItems
                checkedFlag={contextMenuFlag}
                onSelect={(flag) => {
                  setCueFlags(contextMenuCueIds, flag);
                  setContextMenu(null);
                }}
              />
            </PopupMenuSubmenu>
            <PopupMenuSubmenu
              label="设置星级(Z)"
              mnemonic="Z"
              open={contextMenu.ratingSubmenuOpen}
              enableMnemonics
              menuClassName="subtitle-context-menu"
              onOpenChange={(open) =>
                setContextMenu((current) =>
                  current
                    ? {
                        ...current,
                        exportSubmenuOpen: open ? false : current.exportSubmenuOpen,
                        ratingSubmenuOpen: open,
                        flagSubmenuOpen: open ? false : current.flagSubmenuOpen,
                        colorSubmenuOpen: open ? false : current.colorSubmenuOpen,
                      }
                    : current,
                )
              }
              disabled={contextMenuCueIds.length === 0}
            >
              <PopupMenuItem
                checked={contextMenuRating === 0}
                shortcut="0"
                onSelect={() => {
                  setCueRatings(contextMenuCueIds, 0);
                  setContextMenu(null);
                }}
              >
                无
              </PopupMenuItem>
              {subtitleRatingFilters.map((rating) => (
                <PopupMenuItem
                  key={rating}
                  checked={contextMenuRating === rating}
                  shortcut={String(rating)}
                  onSelect={() => {
                    setCueRatings(contextMenuCueIds, rating);
                    setContextMenu(null);
                  }}
                >
                  {rating} 星
                </PopupMenuItem>
              ))}
              <PopupMenuSeparator />
              <PopupMenuItem
                onSelect={() => {
                  adjustCueRatings(contextMenuCueIds, -1);
                  setContextMenu(null);
                }}
                disabled={contextMenuRatings.every((rating) => rating === 0)}
              >
                降低星级
              </PopupMenuItem>
              <PopupMenuItem
                onSelect={() => {
                  adjustCueRatings(contextMenuCueIds, 1);
                  setContextMenu(null);
                }}
                disabled={contextMenuRatings.every((rating) => rating === 5)}
              >
                提升星级
              </PopupMenuItem>
            </PopupMenuSubmenu>
            <PopupMenuSubmenu
              label="设置色标(C)"
              mnemonic="C"
              open={contextMenu.colorSubmenuOpen}
              enableMnemonics
              menuClassName="subtitle-context-menu"
              onOpenChange={(open) =>
                setContextMenu((current) =>
                  current
                    ? {
                        ...current,
                        exportSubmenuOpen: open ? false : current.exportSubmenuOpen,
                        colorSubmenuOpen: open,
                        flagSubmenuOpen: open ? false : current.flagSubmenuOpen,
                        ratingSubmenuOpen: open ? false : current.ratingSubmenuOpen,
                      }
                    : current,
                )
              }
              disabled={contextMenuCueIds.length === 0}
            >
              <SubtitleColorMenuItems
                checkedColorLabel={contextMenuColorLabel}
                onSelect={(colorLabel) => {
                  setCueColorLabels(contextMenuCueIds, colorLabel);
                  setContextMenu(null);
                }}
              />
            </PopupMenuSubmenu>

            <PopupMenuSeparator />
            <PopupMenuSubmenu
              label="导出"
              open={contextMenu.exportSubmenuOpen}
              disabled={contextMenuCueIds.length === 0}
              enableMnemonics
              menuClassName="subtitle-context-menu"
              onOpenChange={(open) =>
                setContextMenu((current) =>
                  current
                    ? {
                        ...current,
                        exportSubmenuOpen: open,
                        flagSubmenuOpen: open ? false : current.flagSubmenuOpen,
                        ratingSubmenuOpen: open ? false : current.ratingSubmenuOpen,
                        colorSubmenuOpen: open ? false : current.colorSubmenuOpen,
                      }
                    : current,
                )
              }
            >
              <PopupMenuItem mnemonic="E" onSelect={exportSelectedCues}>
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
    </section>
  );
}
