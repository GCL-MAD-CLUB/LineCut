import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  Captions,
  ChevronRight,
  Film,
  Folder,
  FolderOpen,
  Link2,
  Music2,
  SplitSquareVertical,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  isMediaItemEnabled,
  isMediaItemHidden,
  isMediaItemOffline,
  isMediaVideoDetached,
  mediaItemProject,
  visibleSubtitleTracks,
} from "../../store";
import { isTauriRuntime } from "../../tauriRuntime";
import { formatMonitorTime } from "../../time";
import { normalizeFrameRate } from "../../timeline";
import type { MediaBinFolder, MediaBinItem, Project } from "../../types";
import type { MediaBinViewMode } from "./mediaBinState";
import { MediaBinVideoThumbnail } from "./MediaBinVideoThumbnail";

export type MediaBinTableRow =
  | { type: "folder"; folder: MediaBinFolder; depth: number }
  | { type: "item"; item: MediaBinItem; depth: number; boundChild: boolean };

interface MediaBinTableProps {
  rows: MediaBinTableRow[];
  hasItems: boolean;
  mediaItems: MediaBinItem[];
  projects: Record<string, Project>;
  detachedVideoIds: Set<string>;
  gridCardWidth: number;
  listIconScale: number;
  selectedIds: Set<string>;
  expandedFolderIds: Set<string>;
  renamingFolderId: string | null;
  viewMode: MediaBinViewMode;
  isReadOnly: boolean;
  canImport: boolean;
  onSelectOnly: (itemId: string) => void;
  onToggleSelected: (itemId: string) => void;
  onSelectItems: (itemIds: string[]) => void;
  onEntryFocused: (entryId: string) => void;
  onToggleFolder: (folderId: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onFinishRenameFolder: () => void;
  onMoveEntriesToFolder: (itemIds: string[], folderIds: string[], folderId: string | null) => void;
  onRenameItem: (itemId: string, fileName: string) => void;
  onSetItemsEnabled: (itemIds: string[], enabled: boolean) => void;
  onSetItemsHidden: (itemIds: string[], hidden: boolean) => void;
  onSetFoldersHidden: (folderIds: string[], hidden: boolean) => void;
  onPreviewVideo: (videoId: string) => void;
  onBindItems: (itemIds: string[], videoId: string) => void | Promise<void>;
  onImportPaths: (paths: string[]) => void;
}

const previousLabelColumnWidth = 42;
const labelColumnWidth = 25;
const titleColumnLeadingSpace = previousLabelColumnWidth - labelColumnWidth;
const booleanColumnWidth = 62;
const titleRenameDelayMs = 350;

type ResizableColumnId =
  "title" | "frameRate" | "mediaStart" | "mediaEnd" | "duration" | "videoInfo" | "audioInfo";
type SortableColumnId = "label" | ResizableColumnId;
type SortDirection = "ascending" | "descending";

interface MediaBinSort {
  columnId: SortableColumnId;
  direction: SortDirection;
}

const defaultMediaBinSort: MediaBinSort = {
  columnId: "title",
  direction: "ascending",
};

type ResizableColumnWidths = Record<ResizableColumnId, number>;

interface PointerMediaDragPreview {
  item?: MediaBinItem;
  folder?: MediaBinFolder;
  project?: Project;
  x: number;
  y: number;
}

interface ActiveMediaCell {
  itemId: string;
  columnId: ResizableColumnId;
}

interface GridLayout {
  columns: number;
  cardWidth: number;
}

interface GridVideoHover {
  itemId: string;
  progress: number;
}

interface MarqueeSelection {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

const marqueeDragThreshold = 4;

const initialColumnWidths: ResizableColumnWidths = {
  title: 300 + titleColumnLeadingSpace,
  frameRate: 112,
  mediaStart: 128,
  mediaEnd: 128,
  duration: 140,
  videoInfo: 190,
  audioInfo: 270,
};

const minimumColumnWidths: ResizableColumnWidths = {
  title: 38 + titleColumnLeadingSpace,
  frameRate: 21,
  mediaStart: 21,
  mediaEnd: 21,
  duration: 21,
  videoInfo: 80,
  audioInfo: 80,
};

const maximumColumnWidths: ResizableColumnWidths = {
  title: 720 + titleColumnLeadingSpace,
  frameRate: 280,
  mediaStart: 300,
  mediaEnd: 300,
  duration: 320,
  videoInfo: 420,
  audioInfo: 520,
};

const tableHeaders: Array<{
  id: SortableColumnId | "enabled" | "hidden" | "trailing";
  label: string;
  resizeColumn?: ResizableColumnId;
}> = [
  { id: "label", label: "" },
  { id: "title", label: "标题" },
  { id: "frameRate", label: "帧速率", resizeColumn: "title" },
  { id: "mediaStart", label: "媒体开始", resizeColumn: "frameRate" },
  { id: "mediaEnd", label: "媒体结束", resizeColumn: "mediaStart" },
  { id: "duration", label: "媒体持续时间", resizeColumn: "mediaEnd" },
  { id: "videoInfo", label: "视频信息", resizeColumn: "duration" },
  { id: "audioInfo", label: "音频信息", resizeColumn: "videoInfo" },
  { id: "enabled", label: "启用", resizeColumn: "audioInfo" },
  { id: "hidden", label: "隐藏" },
  { id: "trailing", label: "" },
];

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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

function itemIcon(item: MediaBinItem, project?: Project, isDetachedVideo = false) {
  if (item.kind === "video") {
    if (!isDetachedVideo && project?.asset.audio_stream_index != null) {
      return (
        <span className="media-bin-video-audio-icon" title="有声视频">
          <Film aria-hidden="true" />
          <Music2 aria-hidden="true" />
        </span>
      );
    }
    return <Film aria-hidden="true" />;
  }
  if (item.kind === "audio") {
    return <Music2 aria-hidden="true" />;
  }
  return <Captions aria-hidden="true" />;
}

function SubtitleBadgeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" />
      <path d="M7 10h10M7 14h10" fill="none" stroke="currentColor" />
    </svg>
  );
}

function itemFrameRate(item: MediaBinItem, project: Project | undefined) {
  if (item.kind === "audio") {
    const stream =
      project?.streams.find(
        (candidate) => candidate.codec_type === "audio" && candidate.index === item.stream_index,
      ) ?? project?.streams.find((candidate) => candidate.codec_type === "audio");
    const sampleRate = Number.parseInt(stream?.sample_rate ?? "", 10);
    return Number.isFinite(sampleRate) ? `${sampleRate} Hz` : "";
  }
  if (item.kind === "subtitle") {
    return item.codec?.toUpperCase() || "字幕";
  }
  const stream = project?.streams.find((candidate) => candidate.codec_type === "video");
  const frameRate = normalizeFrameRate(stream?.avg_frame_rate, stream?.r_frame_rate);
  return `${frameRate.toFixed(frameRate % 1 === 0 ? 2 : 3)} fps`;
}

function formatItemTime(item: MediaBinItem, project: Project | undefined, valueUs: number) {
  const stream = project?.streams.find((candidate) => candidate.codec_type === "video");
  const frameRate = normalizeFrameRate(stream?.avg_frame_rate, stream?.r_frame_rate);
  return formatMonitorTime(valueUs, frameRate);
}

function formatGridItemDuration(item: MediaBinItem, project: Project | undefined) {
  const timecode = formatItemTime(item, project, item.duration_us);
  const fields = timecode.split(":");
  const firstNonZeroField = fields.findIndex((field) => Number(field) !== 0);

  if (firstNonZeroField === -1) {
    return fields.at(-1) ?? "00";
  }

  return [String(Number(fields[firstNonZeroField])), ...fields.slice(firstNonZeroField + 1)].join(
    ":",
  );
}

function bindingTargetVideoId(item: MediaBinItem) {
  return item.kind === "video" ? item.id : item.bound_to_video_id;
}

function SortArrow({ direction }: { direction: SortDirection }) {
  const isAscending = direction === "ascending";
  return (
    <svg className="media-bin-sort-arrow" viewBox="0 0 16 16" fill="none" aria-hidden="true">
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

const mediaNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function itemProject(item: MediaBinItem, projects: Record<string, Project>) {
  return (
    projects[item.id] ??
    (item.source_video_id ? projects[item.source_video_id] : undefined) ??
    (item.bound_to_video_id ? projects[item.bound_to_video_id] : undefined)
  );
}

function itemMediaStream(
  item: MediaBinItem,
  codecType: "video" | "audio",
  projects: Record<string, Project>,
) {
  const project = itemProject(item, projects);
  if (!project) {
    return undefined;
  }
  const preferredIndex =
    codecType === "video"
      ? item.kind === "video"
        ? item.stream_index
        : project.asset.video_stream_index
      : item.kind === "audio"
        ? item.stream_index
        : project.asset.audio_stream_index;
  return (
    project.streams.find(
      (stream) => stream.codec_type === codecType && stream.index === preferredIndex,
    ) ?? project.streams.find((stream) => stream.codec_type === codecType)
  );
}

function formatPixelAspectRatio(value: string | null | undefined) {
  const [numeratorText, denominatorText] = value?.split(":") ?? [];
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  const ratio =
    Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 && numerator > 0
      ? numerator / denominator
      : 1;
  return ratio.toFixed(3).replace(/0+$/, "").replace(/\.$/, ".0");
}

function itemVideoInfo(item: MediaBinItem, projects: Record<string, Project>) {
  if (item.kind !== "video") {
    return "";
  }
  const stream = itemMediaStream(item, "video", projects);
  if (!stream?.width || !stream.height) {
    return "";
  }
  return `${stream.width} x ${stream.height} (${formatPixelAspectRatio(stream.sample_aspect_ratio)})`;
}

function audioChannelDescription(
  channelLayout: string | null | undefined,
  channels: number | null,
) {
  const normalizedLayout = channelLayout?.trim().toLocaleLowerCase();
  if (normalizedLayout === "mono") {
    return "单声道";
  }
  if (normalizedLayout === "stereo") {
    return "立体声";
  }
  if (channelLayout?.trim()) {
    return channelLayout.trim();
  }
  if (channels === 1) {
    return "单声道";
  }
  if (channels === 2) {
    return "立体声";
  }
  return channels ? `${channels} 声道` : "";
}

function audioCompressionDescription(codecName: string) {
  if (!codecName) {
    return "";
  }
  return /^(?:pcm(?:_|$)|dsd_|s302m$)/i.test(codecName) ? "未压缩" : "已压缩";
}

function itemAudioInfo(item: MediaBinItem, projects: Record<string, Project>) {
  if (item.kind === "subtitle") {
    return "";
  }
  const stream = itemMediaStream(item, "audio", projects);
  if (!stream) {
    return "";
  }
  const sampleRate = Number.parseInt(stream.sample_rate ?? "", 10);
  return [
    Number.isFinite(sampleRate) ? `${sampleRate} Hz` : "",
    audioCompressionDescription(stream.codec_name),
    audioChannelDescription(stream.channel_layout, stream.channels),
  ]
    .filter(Boolean)
    .join(" - ");
}

function itemSortValue(
  item: MediaBinItem,
  columnId: SortableColumnId,
  projects: Record<string, Project>,
) {
  if (columnId === "label") {
    return item.color;
  }
  if (columnId === "title") {
    return item.file_name;
  }
  if (columnId === "mediaStart") {
    return item.start_time_us;
  }
  if (columnId === "mediaEnd") {
    return item.start_time_us + item.duration_us;
  }
  if (columnId === "duration") {
    return item.duration_us;
  }
  if (columnId === "videoInfo") {
    return itemVideoInfo(item, projects);
  }
  if (columnId === "audioInfo") {
    return itemAudioInfo(item, projects);
  }
  if (item.kind === "audio") {
    const sampleRate = Number.parseInt(
      itemMediaStream(item, "audio", projects)?.sample_rate ?? "",
      10,
    );
    return Number.isFinite(sampleRate) ? sampleRate : "";
  }
  if (item.kind === "subtitle") {
    return item.codec?.toUpperCase() || "字幕";
  }
  const project = itemProject(item, projects);
  const stream = project?.streams.find((candidate) => candidate.codec_type === "video");
  return normalizeFrameRate(stream?.avg_frame_rate, stream?.r_frame_rate);
}

function folderSortValue(folder: MediaBinFolder, columnId: SortableColumnId) {
  if (columnId === "label") {
    return folder.color;
  }
  if (columnId === "title") {
    return folder.name;
  }
  return null;
}

function compareSortValues(left: string | number, right: string | number) {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "number") {
    return -1;
  }
  if (typeof right === "number") {
    return 1;
  }
  return mediaNameCollator.compare(left, right);
}

function sortMediaRows(
  rows: MediaBinTableProps["rows"],
  sort: MediaBinSort | null,
  projects: Record<string, Project>,
) {
  if (!sort) {
    return rows;
  }

  const direction = sort.direction === "ascending" ? 1 : -1;
  const rowSortValue = (row: MediaBinTableRow) =>
    row.type === "folder"
      ? folderSortValue(row.folder, sort.columnId)
      : itemSortValue(row.item, sort.columnId, projects);
  interface RowNode {
    row: MediaBinTableRow;
    children: RowNode[];
    index: number;
  }
  const roots: RowNode[] = [];
  const stack: RowNode[] = [];
  rows.forEach((row, index) => {
    const node = { row, children: [], index };
    stack.length = Math.min(stack.length, row.depth);
    const parent = row.depth > 0 ? stack[row.depth - 1] : undefined;
    (parent?.children ?? roots).push(node);
    stack[row.depth] = node;
    stack.length = row.depth + 1;
  });
  const compareNodes = (left: RowNode, right: RowNode) => {
    const leftValue = rowSortValue(left.row);
    const rightValue = rowSortValue(right.row);
    if (leftValue !== null && rightValue !== null) {
      return compareSortValues(leftValue, rightValue) * direction || left.index - right.index;
    }
    if (leftValue === null && rightValue !== null) {
      return -1;
    }
    if (leftValue !== null && rightValue === null) {
      return 1;
    }
    if (left.row.type === "folder" && right.row.type === "folder") {
      return (
        mediaNameCollator.compare(left.row.folder.name, right.row.folder.name) ||
        left.index - right.index
      );
    }
    return left.index - right.index;
  };
  const flatten = (nodes: RowNode[]): MediaBinTableRow[] =>
    nodes.sort(compareNodes).flatMap((node) => [node.row, ...flatten(node.children)]);
  return flatten(roots);
}

function mediaBinRowId(row: MediaBinTableRow) {
  return row.type === "folder" ? row.folder.id : row.item.id;
}

export function MediaBinTable({
  rows,
  hasItems,
  mediaItems,
  projects,
  detachedVideoIds,
  gridCardWidth,
  listIconScale,
  selectedIds,
  expandedFolderIds,
  renamingFolderId,
  viewMode,
  isReadOnly,
  canImport,
  onSelectOnly,
  onToggleSelected,
  onSelectItems,
  onEntryFocused,
  onToggleFolder,
  onRenameFolder,
  onFinishRenameFolder,
  onMoveEntriesToFolder,
  onRenameItem,
  onSetItemsEnabled,
  onSetItemsHidden,
  onSetFoldersHidden,
  onPreviewVideo,
  onBindItems,
  onImportPaths,
}: MediaBinTableProps) {
  const [dropTargetVideoId, setDropTargetVideoId] = useState<string | null>(null);
  const [dropTargetFolderId, setDropTargetFolderId] = useState<string | null>(null);
  const [pointerDragPreview, setPointerDragPreview] = useState<PointerMediaDragPreview | null>(
    null,
  );
  const [columnWidths, setColumnWidths] = useState(initialColumnWidths);
  const [sort, setSort] = useState<MediaBinSort>(defaultMediaBinSort);
  const [activeCell, setActiveCell] = useState<ActiveMediaCell | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [gridLayout, setGridLayout] = useState<GridLayout>({
    columns: 1,
    cardWidth: gridCardWidth,
  });
  const [gridVideoHover, setGridVideoHover] = useState<GridVideoHover | null>(null);
  const [gridVideoPersistedProgress, setGridVideoPersistedProgress] = useState<
    Record<string, number>
  >({});
  const [renameValue, setRenameValue] = useState("");
  const [systemFileDragOver, setSystemFileDragOver] = useState(false);
  const [systemFileDragActive, setSystemFileDragActive] = useState(false);
  const [marqueeSelection, setMarqueeSelection] = useState<MarqueeSelection | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const selectionRootRef = useRef<HTMLDivElement | null>(null);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const onImportPathsRef = useRef(onImportPaths);
  const selectionAnchorRef = useRef<string | null>(null);
  const selectionFocusRef = useRef<string | null>(null);
  const marqueeCleanupRef = useRef<(() => void) | null>(null);
  const pendingTitleRenameRef = useRef<number | null>(null);
  const columnResizeRef = useRef<{
    columnId: ResizableColumnId;
    startX: number;
    startWidth: number;
    pointerId: number;
  } | null>(null);
  const suppressRowClickRef = useRef(false);
  const hadItemsRef = useRef(hasItems);
  const tableMinWidth =
    labelColumnWidth +
    booleanColumnWidth * 2 +
    Object.values(columnWidths).reduce((total, width) => total + width, 0);
  const tableStyle = {
    "--media-col-label": `${labelColumnWidth}px`,
    "--media-col-title": `${columnWidths.title}px`,
    "--media-title-leading-space": `${titleColumnLeadingSpace}px`,
    "--media-col-frame-rate": `${columnWidths.frameRate}px`,
    "--media-col-start": `${columnWidths.mediaStart}px`,
    "--media-col-end": `${columnWidths.mediaEnd}px`,
    "--media-col-duration": `${columnWidths.duration}px`,
    "--media-col-video-info": `${columnWidths.videoInfo}px`,
    "--media-col-audio-info": `${columnWidths.audioInfo}px`,
    "--media-col-boolean": `${booleanColumnWidth}px`,
    "--media-table-min-width": `${tableMinWidth}px`,
  } as CSSProperties;
  const gridStyle = {
    "--media-grid-column-count": gridLayout.columns,
    "--media-grid-card-render-width": `${gridLayout.cardWidth}px`,
  } as CSSProperties;
  const sortedRows = useMemo(() => sortMediaRows(rows, sort, projects), [projects, rows, sort]);

  onImportPathsRef.current = onImportPaths;

  useEffect(() => {
    if (!renamingFolderId) {
      return;
    }
    const folderRow = sortedRows.find(
      (row) => row.type === "folder" && row.folder.id === renamingFolderId,
    );
    if (folderRow?.type === "folder") {
      if (tableScrollRef.current) {
        tableScrollRef.current.scrollLeft = 0;
      }
      setRenameValue(folderRow.folder.name);
      setEditingItemId(null);
      setEditingFolderId(folderRow.folder.id);
    }
  }, [renamingFolderId, sortedRows]);

  function selectItem(event: ReactMouseEvent<HTMLElement>, itemId: string) {
    const additive = event.ctrlKey || event.metaKey;
    onEntryFocused(itemId);
    selectionFocusRef.current = itemId;
    if (!event.shiftKey) {
      selectionAnchorRef.current = itemId;
      if (additive) {
        onToggleSelected(itemId);
      } else {
        onSelectOnly(itemId);
      }
      return;
    }

    const targetIndex = sortedRows.findIndex((row) => mediaBinRowId(row) === itemId);
    if (targetIndex < 0) {
      return;
    }
    const anchorId = selectionAnchorRef.current;
    const anchorIndex = anchorId
      ? sortedRows.findIndex((row) => mediaBinRowId(row) === anchorId)
      : sortedRows.findIndex((row) => selectedIds.has(mediaBinRowId(row)));
    const resolvedAnchorIndex = anchorIndex >= 0 ? anchorIndex : targetIndex;
    const start = Math.min(resolvedAnchorIndex, targetIndex);
    const end = Math.max(resolvedAnchorIndex, targetIndex);
    const nextSelection = additive ? new Set(selectedIds) : new Set<string>();
    for (const row of sortedRows.slice(start, end + 1)) {
      nextSelection.add(mediaBinRowId(row));
    }
    selectionAnchorRef.current = mediaBinRowId(sortedRows[resolvedAnchorIndex]);
    onSelectItems(Array.from(nextSelection));
  }

  useEffect(() => {
    const visibleSelectedIds = sortedRows
      .map(mediaBinRowId)
      .filter((itemId) => selectedIds.has(itemId));
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
  }, [selectedIds, sortedRows]);

  useEffect(() => {
    const panel = selectionRootRef.current?.closest<HTMLElement>(".media-bin-panel");
    if (!panel) {
      return;
    }

    const scrollItemIntoView = (itemId: string) => {
      requestAnimationFrame(() => {
        const root = selectionRootRef.current;
        const item = root
          ? Array.from(root.querySelectorAll<HTMLElement>("[data-media-entry-id]")).find(
              (element) => element.dataset.mediaEntryId === itemId,
            )
          : null;
        item?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    };

    const handleSelectionKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || isEditableKeyboardTarget(event.target) || sortedRows.length === 0) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target !== panel && !target?.closest("[data-media-entry-id]")) {
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
        ? sortedRows.findIndex((row) => mediaBinRowId(row) === selectionFocusRef.current)
        : -1;
      const selectedIndex = sortedRows.findIndex((row) => selectedIds.has(mediaBinRowId(row)));
      const currentIndex = focusedIndex >= 0 ? focusedIndex : selectedIndex;
      const step =
        viewMode === "grid" && (event.key === "ArrowUp" || event.key === "ArrowDown")
          ? Math.max(1, gridLayout.columns)
          : 1;
      const targetIndex =
        currentIndex < 0
          ? direction > 0
            ? 0
            : sortedRows.length - 1
          : clamp(currentIndex + direction * step, 0, sortedRows.length - 1);
      const targetId = mediaBinRowId(sortedRows[targetIndex]);
      selectionFocusRef.current = targetId;
      onEntryFocused(targetId);

      if (!event.shiftKey) {
        selectionAnchorRef.current = targetId;
        onSelectOnly(targetId);
        scrollItemIntoView(targetId);
        return;
      }

      const anchorIndex = selectionAnchorRef.current
        ? sortedRows.findIndex((row) => mediaBinRowId(row) === selectionAnchorRef.current)
        : -1;
      const resolvedAnchorIndex =
        anchorIndex >= 0 ? anchorIndex : Math.max(currentIndex, targetIndex);
      selectionAnchorRef.current = mediaBinRowId(sortedRows[resolvedAnchorIndex]);
      const start = Math.min(resolvedAnchorIndex, targetIndex);
      const end = Math.max(resolvedAnchorIndex, targetIndex);
      const nextSelection =
        event.ctrlKey || event.metaKey ? new Set(selectedIds) : new Set<string>();
      for (const row of sortedRows.slice(start, end + 1)) {
        nextSelection.add(mediaBinRowId(row));
      }
      onSelectItems(Array.from(nextSelection));
      scrollItemIntoView(targetId);
    };

    panel.addEventListener("keydown", handleSelectionKeyDown);
    return () => panel.removeEventListener("keydown", handleSelectionKeyDown);
  }, [
    gridLayout.columns,
    onEntryFocused,
    onSelectItems,
    onSelectOnly,
    selectedIds,
    sortedRows,
    viewMode,
  ]);

  function startMarqueeSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const surface = event.currentTarget;
    const surfaceBounds = surface.getBoundingClientRect();
    const pointsAtScrollbar =
      surface === tableScrollRef.current &&
      (event.clientX >= surfaceBounds.left + surface.clientWidth ||
        event.clientY >= surfaceBounds.top + surface.clientHeight);
    if (
      event.button !== 0 ||
      sortedRows.length === 0 ||
      pointsAtScrollbar ||
      (event.target as HTMLElement | null)?.closest("[data-media-entry-id]")
    ) {
      return;
    }

    event.preventDefault();
    cancelPendingTitleRename();
    setActiveCell(null);
    marqueeCleanupRef.current?.();

    const pointerId = event.pointerId;
    const initialSelection = new Set(selectedIds);
    const togglesSelection = event.ctrlKey || event.metaKey;
    const addsSelection = event.shiftKey && !togglesSelection;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let lastSelection = new Set(selectedIds);

    const selectionsMatch = (left: Set<string>, right: Set<string>) =>
      left.size === right.size && Array.from(left).every((itemId) => right.has(itemId));

    const updateSelection = (currentX: number, currentY: number) => {
      const left = Math.min(startX, currentX);
      const right = Math.max(startX, currentX);
      const top = Math.min(startY, currentY);
      const bottom = Math.max(startY, currentY);
      const hitIds = new Set(
        Array.from(surface.querySelectorAll<HTMLElement>("[data-media-entry-id]"))
          .filter((element) => {
            const bounds = element.getBoundingClientRect();
            return (
              bounds.right >= left &&
              bounds.left <= right &&
              bounds.bottom >= top &&
              bounds.top <= bottom
            );
          })
          .map((element) => element.dataset.mediaEntryId)
          .filter((itemId): itemId is string => Boolean(itemId)),
      );
      const nextSelection =
        togglesSelection || addsSelection ? new Set(initialSelection) : new Set<string>();
      if (togglesSelection) {
        for (const itemId of hitIds) {
          if (initialSelection.has(itemId)) {
            nextSelection.delete(itemId);
          } else {
            nextSelection.add(itemId);
          }
        }
      } else {
        for (const itemId of hitIds) {
          nextSelection.add(itemId);
        }
      }

      if (!selectionsMatch(lastSelection, nextSelection)) {
        lastSelection = nextSelection;
        onSelectItems(Array.from(nextSelection));
      }
      let lastHitId: string | undefined;
      for (const row of sortedRows) {
        const entryId = mediaBinRowId(row);
        if (hitIds.has(entryId)) {
          lastHitId = entryId;
        }
      }
      if (lastHitId && nextSelection.has(lastHitId)) {
        selectionAnchorRef.current = lastHitId;
        selectionFocusRef.current = lastHitId;
        onEntryFocused(lastHitId);
      } else if (nextSelection.size === 0) {
        selectionAnchorRef.current = null;
        selectionFocusRef.current = null;
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
        onSelectItems([]);
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
        Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < marqueeDragThreshold
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

  useEffect(
    () => () => {
      marqueeCleanupRef.current?.();
    },
    [],
  );

  useEffect(() => {
    document.body.classList.toggle("system-file-drag-active", systemFileDragActive);

    return () => {
      document.body.classList.remove("system-file-drag-active");
    };
  }, [systemFileDragActive]);

  useEffect(() => {
    if (!hadItemsRef.current && hasItems) {
      setSort(defaultMediaBinSort);
    }
    hadItemsRef.current = hasItems;
  }, [hasItems]);

  useEffect(
    () => () => {
      if (pendingTitleRenameRef.current !== null) {
        window.clearTimeout(pendingTitleRenameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isReadOnly) {
      return;
    }
    cancelPendingTitleRename();
    setEditingItemId(null);
    setEditingFolderId(null);
    onFinishRenameFolder();
  }, [isReadOnly]);

  useEffect(() => {
    if (!isTauriRuntime() || viewMode !== "list" || !canImport) {
      setSystemFileDragOver(false);
      setSystemFileDragActive(false);
      if (isTauriRuntime()) {
        void invoke("set_media_import_drop_region", { region: null });
      }
      return;
    }

    const tableScroll = tableScrollRef.current;
    if (!tableScroll) {
      return;
    }
    let frameId: number | null = null;
    const updateDropRegion = () => {
      const scaleFactor = window.devicePixelRatio || 1;
      const bounds = tableScroll.getBoundingClientRect();
      void invoke("set_media_import_drop_region", {
        region: {
          left: Math.floor(bounds.left * scaleFactor),
          top: Math.floor(bounds.top * scaleFactor),
          right: Math.ceil(bounds.right * scaleFactor),
          bottom: Math.ceil(bounds.bottom * scaleFactor),
        },
      });
    };
    const scheduleDropRegionUpdate = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        updateDropRegion();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleDropRegionUpdate);
    resizeObserver.observe(tableScroll);
    window.addEventListener("resize", scheduleDropRegionUpdate);
    updateDropRegion();

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleDropRegionUpdate);
      void invoke("set_media_import_drop_region", { region: null });
    };
  }, [canImport, viewMode]);

  useEffect(() => {
    if (!isTauriRuntime() || viewMode !== "list" || !canImport) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;
    const positionIsInTableArea = (x: number, y: number) => {
      const tableScroll = tableScrollRef.current;
      if (!tableScroll) {
        return false;
      }
      const scaleFactor = window.devicePixelRatio || 1;
      const clientX = x / scaleFactor;
      const clientY = y / scaleFactor;
      const bounds = tableScroll.getBoundingClientRect();
      return (
        clientX >= bounds.left &&
        clientX <= bounds.right &&
        clientY >= bounds.top &&
        clientY <= bounds.bottom
      );
    };

    void getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "leave") {
          setSystemFileDragOver(false);
          setSystemFileDragActive(false);
          return;
        }
        const isOverTable = positionIsInTableArea(payload.position.x, payload.position.y);
        if (payload.type === "drop") {
          setSystemFileDragOver(false);
          setSystemFileDragActive(false);
          if (isOverTable && payload.paths.length > 0) {
            onImportPathsRef.current(Array.from(new Set(payload.paths)));
          }
          return;
        }
        setSystemFileDragActive(true);
        setSystemFileDragOver(isOverTable);
      })
      .then((stopListening) => {
        if (disposed) {
          stopListening();
        } else {
          unlisten = stopListening;
        }
      })
      .catch(() => {
        if (!disposed) {
          setSystemFileDragOver(false);
          setSystemFileDragActive(false);
        }
      });

    return () => {
      disposed = true;
      setSystemFileDragOver(false);
      setSystemFileDragActive(false);
      unlisten?.();
    };
  }, [canImport, viewMode]);

  useLayoutEffect(() => {
    if (viewMode !== "grid") {
      return;
    }
    const grid = gridRef.current;
    if (!grid) {
      return;
    }
    const updateGridLayout = () => {
      const itemCount = grid.children.length;
      if (itemCount === 0) {
        return;
      }
      const style = getComputedStyle(grid);
      const horizontalPadding =
        Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const columnGap = Number.parseFloat(style.columnGap) || 0;
      const availableWidth = Math.max(0, grid.clientWidth - horizontalPadding);
      let columns = 1;
      let minimumCardWidth = 0;
      let fittedCardWidth = availableWidth;

      for (let candidateColumns = itemCount; candidateColumns >= 1; candidateColumns -= 1) {
        const candidateMinimumCardWidth =
          (gridCardWidth * Math.max(0, candidateColumns - 1) +
            columnGap * Math.max(0, candidateColumns - 2) -
            Math.max(0, candidateColumns - 1)) /
          candidateColumns;
        const candidateFittedCardWidth =
          (availableWidth - Math.max(0, candidateColumns - 1) * columnGap) / candidateColumns;
        if (candidateFittedCardWidth >= candidateMinimumCardWidth) {
          columns = candidateColumns;
          minimumCardWidth = candidateMinimumCardWidth;
          fittedCardWidth = candidateFittedCardWidth;
          break;
        }
      }
      const cardWidth = clamp(fittedCardWidth, minimumCardWidth, gridCardWidth);
      setGridLayout((current) =>
        current.columns === columns && current.cardWidth === cardWidth
          ? current
          : { columns, cardWidth },
      );
    };
    const resizeObserver = new ResizeObserver(updateGridLayout);
    resizeObserver.observe(grid);
    updateGridLayout();
    return () => resizeObserver.disconnect();
  }, [gridCardWidth, sortedRows.length, viewMode]);

  function toggleSort(columnId: SortableColumnId) {
    if (!hasItems) {
      return;
    }
    setSort((current) =>
      current?.columnId === columnId
        ? {
            columnId,
            direction: current.direction === "ascending" ? "descending" : "ascending",
          }
        : { columnId, direction: "ascending" },
    );
  }

  function updateGridVideoHover(event: ReactPointerEvent<HTMLSpanElement>, itemId: string) {
    if (event.buttons !== 0) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const progress = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    setGridVideoHover((current) =>
      current?.itemId === itemId && current.progress === progress ? current : { itemId, progress },
    );
  }

  function finishGridVideoHover(itemId: string) {
    if (gridVideoHover?.itemId !== itemId) {
      return;
    }
    if (selectedIds.has(itemId)) {
      setGridVideoPersistedProgress((current) => ({
        ...current,
        [itemId]: gridVideoHover.progress,
      }));
    } else {
      setGridVideoPersistedProgress(({ [itemId]: _removed, ...remaining }) => remaining);
    }
    setGridVideoHover(null);
  }

  function cancelPendingTitleRename() {
    if (pendingTitleRenameRef.current === null) {
      return;
    }
    window.clearTimeout(pendingTitleRenameRef.current);
    pendingTitleRenameRef.current = null;
  }

  function activateCell(itemId: string, columnId: ResizableColumnId) {
    cancelPendingTitleRename();
    setActiveCell({ itemId, columnId });
  }

  function cellClassName(
    itemId: string,
    columnId: ResizableColumnId,
    selected: boolean,
    baseClassName = "",
  ) {
    return [
      baseClassName,
      selected && activeCell?.itemId === itemId && activeCell.columnId === columnId
        ? "media-bin-active-cell"
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  function beginTitleRename(entry: MediaBinItem | MediaBinFolder) {
    if (isReadOnly) {
      return;
    }
    cancelPendingTitleRename();
    if ("file_name" in entry) {
      setRenameValue(entry.file_name);
      setEditingFolderId(null);
      setEditingItemId(entry.id);
    } else {
      setRenameValue(entry.name);
      setEditingItemId(null);
      setEditingFolderId(entry.id);
    }
  }

  function scheduleTitleRename(entry: MediaBinItem | MediaBinFolder) {
    if (isReadOnly) {
      return;
    }
    cancelPendingTitleRename();
    pendingTitleRenameRef.current = window.setTimeout(() => {
      pendingTitleRenameRef.current = null;
      beginTitleRename(entry);
    }, titleRenameDelayMs);
  }

  function handleTitleCellClick(
    event: ReactMouseEvent<HTMLElement>,
    entry: MediaBinItem | MediaBinFolder,
    selected: boolean,
  ) {
    if (suppressRowClickRef.current) {
      return;
    }
    activateCell(entry.id, "title");
    if (selected && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (!isReadOnly && event.detail === 1) {
        scheduleTitleRename(entry);
      } else {
        cancelPendingTitleRename();
      }
    }
  }

  function finishTitleRename(item: MediaBinItem, commit: boolean) {
    cancelPendingTitleRename();
    if (editingItemId !== item.id) {
      return;
    }
    const nextName = renameValue.trim();
    if (!isReadOnly && commit && nextName && nextName !== item.file_name) {
      onRenameItem(item.id, nextName);
    }
    setEditingItemId(null);
  }

  function finishFolderRename(folder: MediaBinFolder, commit: boolean) {
    cancelPendingTitleRename();
    if (editingFolderId !== folder.id) {
      return;
    }
    const nextName = renameValue.trim();
    if (!isReadOnly && commit && nextName && nextName !== folder.name) {
      onRenameFolder(folder.id, nextName);
    }
    setEditingFolderId(null);
    onFinishRenameFolder();
  }

  function startColumnResize(
    event: ReactPointerEvent<HTMLButtonElement>,
    columnId: ResizableColumnId,
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
      startWidth: columnWidths[columnId],
      pointerId: event.pointerId,
    };
    document.body.classList.add("is-resizing-media-column");
  }

  function updateColumnResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const resize = columnResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) {
      return;
    }
    const width = clamp(
      resize.startWidth + event.clientX - resize.startX,
      minimumColumnWidths[resize.columnId],
      maximumColumnWidths[resize.columnId],
    );
    setColumnWidths((current) =>
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
    document.body.classList.remove("is-resizing-media-column");
  }

  function resetColumnWidth(columnId: ResizableColumnId) {
    setColumnWidths((current) => ({
      ...current,
      [columnId]: initialColumnWidths[columnId],
    }));
  }

  function startPointerMediaDrag(
    event: ReactPointerEvent<HTMLElement>,
    item: MediaBinItem,
    allowBinding = true,
  ) {
    if (event.button !== 0 || (!allowBinding && !isMediaItemEnabled(item))) {
      return;
    }
    const itemIds = selectedIds.has(item.id)
      ? mediaItems
          .filter((candidate) => selectedIds.has(candidate.id))
          .map((candidate) => candidate.id)
      : [item.id];
    const folderIds = selectedIds.has(item.id)
      ? rows.flatMap((row) =>
          row.type === "folder" && selectedIds.has(row.folder.id) ? [row.folder.id] : [],
        )
      : [];
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    const targetFromPoint = (clientX: number, clientY: number) => {
      const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      const bindingTarget =
        isReadOnly || !allowBinding
          ? null
          : (element?.closest<HTMLElement>("[data-media-bind-video-id]") ?? null);
      const sourceTarget =
        element?.closest<HTMLElement>("[data-source-monitor-drop-target]") ?? null;
      const folderTarget = isReadOnly
        ? null
        : (element?.closest<HTMLElement>("[data-media-folder-id]") ?? null);
      return {
        videoId: bindingTarget?.dataset.mediaBindVideoId ?? null,
        folderId: folderTarget?.dataset.mediaFolderId ?? null,
        sourceTarget,
      };
    };

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 4) {
        return;
      }
      if (!dragging) {
        dragging = true;
        document.body.classList.add("is-dragging-media-title");
      }
      moveEvent.preventDefault();
      const target = targetFromPoint(moveEvent.clientX, moveEvent.clientY);
      setDropTargetVideoId(target.videoId);
      setDropTargetFolderId(target.folderId);
      setPointerDragPreview({
        item,
        project: mediaItemProject(item, projects, mediaItems),
        x: moveEvent.clientX,
        y: moveEvent.clientY,
      });
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      document.body.classList.remove("is-dragging-media-title");
      setDropTargetVideoId(null);
      setDropTargetFolderId(null);
      setPointerDragPreview(null);
    };

    const finish = (finishEvent: globalThis.PointerEvent, cancelled: boolean) => {
      if (dragging) {
        finishEvent.preventDefault();
        suppressRowClickRef.current = true;
        window.setTimeout(() => {
          suppressRowClickRef.current = false;
        }, 0);
      }
      if (dragging && !cancelled) {
        const target = targetFromPoint(finishEvent.clientX, finishEvent.clientY);
        if (target.sourceTarget && item.kind === "video" && isMediaItemEnabled(item)) {
          onPreviewVideo(item.id);
        } else if (target.folderId) {
          onMoveEntriesToFolder(itemIds, folderIds, target.folderId);
        } else if (allowBinding && !isReadOnly && target.videoId) {
          void onBindItems(itemIds, target.videoId);
        } else if (!isReadOnly) {
          onMoveEntriesToFolder(itemIds, folderIds, null);
        }
      }
      cleanup();
    };

    const onUp = (upEvent: globalThis.PointerEvent) => finish(upEvent, false);
    const onCancel = (cancelEvent: globalThis.PointerEvent) => finish(cancelEvent, true);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onCancel, { once: true });
  }

  function startPointerFolderDrag(event: ReactPointerEvent<HTMLElement>, folder: MediaBinFolder) {
    if (event.button !== 0 || isReadOnly) {
      return;
    }
    const selectionIncludesFolder = selectedIds.has(folder.id);
    const folderIds = selectionIncludesFolder
      ? rows.flatMap((row) =>
          row.type === "folder" && selectedIds.has(row.folder.id) ? [row.folder.id] : [],
        )
      : [folder.id];
    const itemIds = selectionIncludesFolder
      ? mediaItems.filter((item) => selectedIds.has(item.id)).map((item) => item.id)
      : [];
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    const folderTargetFromPoint = (clientX: number, clientY: number) => {
      const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      return element?.closest<HTMLElement>("[data-media-folder-id]")?.dataset.mediaFolderId ?? null;
    };
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 4) {
        return;
      }
      if (!dragging) {
        dragging = true;
        document.body.classList.add("is-dragging-media-title");
      }
      moveEvent.preventDefault();
      const targetFolderId = folderTargetFromPoint(moveEvent.clientX, moveEvent.clientY);
      setDropTargetFolderId(targetFolderId);
      setPointerDragPreview({ folder, x: moveEvent.clientX, y: moveEvent.clientY });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      document.body.classList.remove("is-dragging-media-title");
      setDropTargetFolderId(null);
      setPointerDragPreview(null);
    };
    const finish = (finishEvent: globalThis.PointerEvent, cancelled: boolean) => {
      if (dragging) {
        finishEvent.preventDefault();
        suppressRowClickRef.current = true;
        window.setTimeout(() => {
          suppressRowClickRef.current = false;
        }, 0);
      }
      if (dragging && !cancelled) {
        onMoveEntriesToFolder(
          itemIds,
          folderIds,
          folderTargetFromPoint(finishEvent.clientX, finishEvent.clientY),
        );
      }
      cleanup();
    };
    const onUp = (upEvent: globalThis.PointerEvent) => finish(upEvent, false);
    const onCancel = (cancelEvent: globalThis.PointerEvent) => finish(cancelEvent, true);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onCancel, { once: true });
  }

  function syncHeaderScroll(event: UIEvent<HTMLDivElement>) {
    if (headerRef.current) {
      headerRef.current.style.transform = `translateX(${-event.currentTarget.scrollLeft}px)`;
    }
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
        className="media-bin-marquee-selection"
        style={{ left, top, width, height }}
        aria-hidden="true"
      />,
      document.body,
    );
  }

  if (viewMode === "grid") {
    if (sortedRows.length === 0) {
      return (
        <div className="media-bin-empty media-bin-grid-empty">
          <Film aria-hidden="true" />
          <strong>项目为空</strong>
          <span>使用底部导入按钮添加视频、音频或字幕。</span>
        </div>
      );
    }
    return (
      <>
        <div
          ref={(node) => {
            gridRef.current = node;
            selectionRootRef.current = node;
          }}
          className="media-bin-grid"
          role="list"
          style={gridStyle}
          onPointerDown={startMarqueeSelection}
        >
          {sortedRows.map((row) => {
            if (row.type === "folder") {
              const { folder } = row;
              const expanded = expandedFolderIds.has(folder.id);
              return (
                <button
                  type="button"
                  role="listitem"
                  key={folder.id}
                  data-media-folder-id={folder.id}
                  data-media-entry-id={folder.id}
                  className={`media-bin-card media-bin-folder-card ${
                    selectedIds.has(folder.id) ? "selected" : ""
                  } ${dropTargetFolderId === folder.id ? "folder-drop-target" : ""}`}
                  onPointerDown={(event) => startPointerFolderDrag(event, folder)}
                  onClick={(event) => selectItem(event, folder.id)}
                  onDoubleClick={() => onToggleFolder(folder.id)}
                >
                  <span className="media-bin-card-preview-shell">
                    <span className="media-bin-card-preview folder">
                      {expanded ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}
                    </span>
                  </span>
                  <span className="media-bin-card-meta">
                    <span className="media-bin-card-name">{folder.name}</span>
                    <span className="media-bin-card-duration">媒体箱</span>
                  </span>
                </button>
              );
            }
            const { item } = row;
            const project = mediaItemProject(item, projects, mediaItems);
            const isVideoHovered = gridVideoHover?.itemId === item.id;
            const isSelected = selectedIds.has(item.id);
            const previewProgress = isVideoHovered
              ? gridVideoHover.progress
              : isSelected
                ? (gridVideoPersistedProgress[item.id] ?? null)
                : null;
            const isDetachedVideo = isMediaVideoDetached(item, detachedVideoIds);
            const hasSourceAudio =
              item.kind === "video" &&
              !isDetachedVideo &&
              project?.asset.audio_stream_index != null;
            const hasSubtitleTrack =
              item.kind === "video" &&
              Boolean(
                project && visibleSubtitleTracks(project, mediaItems, item.id, projects).length > 0,
              );
            return (
              <button
                type="button"
                role="listitem"
                key={item.id}
                data-media-item-id={item.id}
                data-media-entry-id={item.id}
                className={`media-bin-card ${isSelected ? "selected" : ""} ${
                  isMediaItemEnabled(item) ? "" : "is-disabled"
                } ${isMediaItemOffline(item) ? "is-offline" : ""}`}
                draggable={false}
                onPointerDown={(event) => startPointerMediaDrag(event, item, false)}
                onClick={(event) => selectItem(event, item.id)}
                onDoubleClick={() =>
                  item.kind === "video" &&
                  isMediaItemEnabled(item) &&
                  (!isMediaItemOffline(item) || Boolean(project?.proxy_path)) &&
                  onPreviewVideo(item.id)
                }
              >
                <span className="media-bin-card-preview-shell">
                  <span
                    className={`media-bin-card-preview ${item.kind}`}
                    onPointerMove={
                      item.kind === "video" &&
                      project &&
                      (!isMediaItemOffline(item) || Boolean(project.proxy_path))
                        ? (event) => updateGridVideoHover(event, item.id)
                        : undefined
                    }
                    onPointerLeave={
                      item.kind === "video" &&
                      project &&
                      (!isMediaItemOffline(item) || Boolean(project.proxy_path))
                        ? () => finishGridVideoHover(item.id)
                        : undefined
                    }
                  >
                    {item.kind === "video" &&
                    project &&
                    (!isMediaItemOffline(item) || Boolean(project.proxy_path)) ? (
                      <>
                        <MediaBinVideoThumbnail
                          item={item}
                          project={project}
                          hoverProgress={previewProgress}
                        />
                        <span className="media-bin-card-type-badges" aria-hidden="true">
                          <span className="media-bin-card-type-badge video">
                            <Film />
                          </span>
                          {hasSourceAudio && (
                            <span className="media-bin-card-type-badge audio">
                              <Music2 />
                            </span>
                          )}
                          {hasSubtitleTrack && (
                            <span className="media-bin-card-type-badge subtitle">
                              <SubtitleBadgeIcon />
                            </span>
                          )}
                        </span>
                      </>
                    ) : (
                      <>
                        {itemIcon(item, project, isDetachedVideo)}
                        <span className="media-bin-card-type-badges" aria-hidden="true">
                          <span className={`media-bin-card-type-badge ${item.kind}`}>
                            {item.kind === "audio" ? <Music2 /> : <SubtitleBadgeIcon />}
                          </span>
                        </span>
                      </>
                    )}
                    {isMediaItemOffline(item) && (
                      <span className="media-bin-card-offline">媒体脱机</span>
                    )}
                  </span>
                  {previewProgress !== null && (
                    <span
                      className={`media-bin-card-hover-progress ${isSelected ? "is-selected" : ""}`}
                      aria-hidden="true"
                    >
                      <span style={{ width: `${previewProgress * 100}%` }} />
                    </span>
                  )}
                </span>
                <span className="media-bin-card-meta">
                  <span className="media-bin-card-name">{item.file_name}</span>
                  {item.kind !== "subtitle" && (
                    <span className="media-bin-card-duration">
                      {formatGridItemDuration(item, project)}
                    </span>
                  )}
                </span>
                {item.bound_to_video_id && (
                  <span className="media-bin-card-bound" title="已绑定">
                    <Link2 aria-hidden="true" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {renderMarqueeOverlay()}
      </>
    );
  }

  return (
    <div
      ref={selectionRootRef}
      className="media-bin-table"
      role="table"
      aria-label="媒体列表"
      style={tableStyle}
    >
      <div className="media-bin-table-frame">
        <div className="media-bin-table-header-viewport">
          <div ref={headerRef} className="media-bin-table-header" role="row">
            {tableHeaders.map((header) => {
              const sortColumnId: SortableColumnId | null =
                header.id === "enabled" || header.id === "hidden" || header.id === "trailing"
                  ? null
                  : header.id;
              const isActive = hasItems && sortColumnId !== null && sort?.columnId === sortColumnId;
              const headerName = header.id === "label" ? "标签" : header.label;
              const nextDirection = isActive && sort.direction === "ascending" ? "降序" : "升序";
              return (
                <span
                  key={header.id}
                  className={`media-bin-column-header media-bin-column-${header.id}`}
                  role="columnheader"
                  aria-label={header.id === "label" ? "标签" : undefined}
                  aria-sort={isActive ? sort.direction : undefined}
                >
                  {sortColumnId ? (
                    <button
                      type="button"
                      className={`media-bin-column-sort-button ${isActive ? "active" : ""}`}
                      title={`按${headerName}${nextDirection}排列`}
                      aria-label={`按${headerName}${nextDirection}排列`}
                      onClick={() => toggleSort(sortColumnId)}
                      disabled={!hasItems}
                    >
                      {header.label && (
                        <span className="media-bin-column-label-text">{header.label}</span>
                      )}
                      {isActive &&
                        (sort.direction === "ascending" ? (
                          <SortArrow direction="ascending" />
                        ) : (
                          <SortArrow direction="descending" />
                        ))}
                    </button>
                  ) : (
                    <span className="media-bin-column-label-text">{header.label}</span>
                  )}
                  {header.resizeColumn && (
                    <button
                      type="button"
                      className="media-bin-column-resizer"
                      title={`调整${tableHeaders.find((item) => item.id === header.resizeColumn)?.label || "持续时间"}列宽，双击恢复默认`}
                      aria-label={`调整${tableHeaders.find((item) => item.id === header.resizeColumn)?.label || "持续时间"}列宽`}
                      onPointerDown={(event) => startColumnResize(event, header.resizeColumn!)}
                      onPointerMove={updateColumnResize}
                      onPointerUp={finishColumnResize}
                      onPointerCancel={finishColumnResize}
                      onDoubleClick={() => resetColumnWidth(header.resizeColumn!)}
                    />
                  )}
                </span>
              );
            })}
          </div>
        </div>
        <div
          ref={tableScrollRef}
          className={`media-bin-table-scroll ${systemFileDragOver ? "system-file-drop-target" : ""}`}
          onScroll={syncHeaderScroll}
          onPointerDown={startMarqueeSelection}
        >
          {sortedRows.length === 0 ? (
            <div className="media-bin-table-empty-content">
              <div className="media-bin-empty">
                <Film aria-hidden="true" />
                <strong>项目为空</strong>
                <span>使用底部导入按钮或将系统媒体拖入此处。</span>
              </div>
              <div className="media-bin-table-tail-spacer" aria-hidden="true" />
            </div>
          ) : (
            <div className="media-bin-table-body" role="rowgroup">
              {sortedRows.map((row, rowIndex) => {
                if (row.type === "folder") {
                  const { folder, depth } = row;
                  const expanded = expandedFolderIds.has(folder.id);
                  const selected = selectedIds.has(folder.id);
                  return (
                    <div
                      key={folder.id}
                      data-media-folder-id={folder.id}
                      data-media-entry-id={folder.id}
                      className={`media-bin-row media-bin-folder-row ${selected ? "selected" : ""} ${
                        dropTargetFolderId === folder.id ? "folder-drop-target" : ""
                      }`}
                      role="row"
                      onClick={(event) => {
                        if (suppressRowClickRef.current) {
                          event.preventDefault();
                          return;
                        }
                        selectItem(event, folder.id);
                      }}
                    >
                      <span
                        className="media-bin-label-cell media-bin-folder-label-cell"
                        role="cell"
                        onClick={() => {
                          cancelPendingTitleRename();
                          setActiveCell(null);
                        }}
                      >
                        <span
                          className="media-bin-label-color"
                          style={{ background: folder.color || "#596b91" }}
                        />
                        <button
                          type="button"
                          className={`media-bin-folder-toggle ${expanded ? "expanded" : ""}`}
                          style={{
                            right: `${14 * listIconScale - 15 - titleColumnLeadingSpace}px`,
                            transform: `translateX(${depth * 22 * listIconScale}px)`,
                          }}
                          aria-label={`${expanded ? "折叠" : "展开"}${folder.name}`}
                          aria-expanded={expanded}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleFolder(folder.id);
                          }}
                        >
                          <ChevronRight aria-hidden="true" />
                        </button>
                      </span>
                      <span
                        className={cellClassName(
                          folder.id,
                          "title",
                          selected,
                          "media-bin-title-cell media-bin-folder-title-cell",
                        )}
                        role="cell"
                        style={{
                          paddingLeft: `${8 + titleColumnLeadingSpace + depth * 22 * listIconScale}px`,
                        }}
                        onPointerDown={(event) => {
                          if (editingFolderId !== folder.id) {
                            startPointerFolderDrag(event, folder);
                          }
                        }}
                        onClick={(event) => handleTitleCellClick(event, folder, selected)}
                        onDoubleClick={() => {
                          cancelPendingTitleRename();
                          beginTitleRename(folder);
                        }}
                      >
                        <span className="media-bin-kind-icon folder">
                          {expanded ? (
                            <FolderOpen aria-hidden="true" />
                          ) : (
                            <Folder aria-hidden="true" />
                          )}
                        </span>
                        {editingFolderId === folder.id ? (
                          <input
                            className="media-bin-title-editor"
                            value={renameValue}
                            aria-label="重命名媒体箱"
                            autoFocus
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) => setRenameValue(event.currentTarget.value)}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onBlur={() => finishFolderRename(folder, true)}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Enter") {
                                event.preventDefault();
                                event.currentTarget.blur();
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                finishFolderRename(folder, false);
                              }
                            }}
                          />
                        ) : (
                          <span className="media-bin-name-copy" title={folder.name}>
                            {folder.name}
                          </span>
                        )}
                      </span>
                      {(
                        [
                          "frameRate",
                          "mediaStart",
                          "mediaEnd",
                          "duration",
                          "videoInfo",
                          "audioInfo",
                        ] as ResizableColumnId[]
                      ).map((columnId) => (
                        <span
                          key={columnId}
                          className={cellClassName(
                            folder.id,
                            columnId,
                            selected,
                            "media-bin-folder-empty-cell",
                          )}
                          role="cell"
                          onClick={() => activateCell(folder.id, columnId)}
                        />
                      ))}
                      <span className="media-bin-folder-empty-cell" role="cell" />
                      <span className="media-bin-boolean-cell" role="cell">
                        <input
                          type="checkbox"
                          checked={folder.hidden === true}
                          aria-label={`隐藏 ${folder.name}`}
                          disabled={isReadOnly}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            onSetFoldersHidden([folder.id], event.currentTarget.checked)
                          }
                        />
                      </span>
                    </div>
                  );
                }
                const { item, depth, boundChild } = row;
                const project = mediaItemProject(item, projects, mediaItems);
                const selected = selectedIds.has(item.id);
                const endUs = item.start_time_us + item.duration_us;
                const targetVideoId = bindingTargetVideoId(item);
                const nextRow = sortedRows[rowIndex + 1];
                const isLastBoundChild =
                  boundChild &&
                  (!nextRow ||
                    nextRow.type !== "item" ||
                    !nextRow.boundChild ||
                    nextRow.item.bound_to_video_id !== item.bound_to_video_id);
                return (
                  <div
                    key={item.id}
                    data-media-item-id={item.id}
                    data-media-entry-id={item.id}
                    className={`media-bin-row ${selected ? "selected" : ""} ${
                      boundChild ? "bound-child" : ""
                    } ${isLastBoundChild ? "last-bound-child" : ""} ${
                      targetVideoId && dropTargetVideoId === targetVideoId ? "binding-target" : ""
                    } ${isMediaItemEnabled(item) ? "" : "is-disabled"} ${
                      isMediaItemOffline(item) ? "is-offline" : ""
                    }`}
                    role="row"
                    onClick={(event) => {
                      if (suppressRowClickRef.current) {
                        event.preventDefault();
                        return;
                      }
                      selectItem(event, item.id);
                    }}
                    onDoubleClick={() => {
                      cancelPendingTitleRename();
                      if (
                        item.kind === "video" &&
                        isMediaItemEnabled(item) &&
                        (!isMediaItemOffline(item) || Boolean(project?.proxy_path))
                      ) {
                        onPreviewVideo(item.id);
                      }
                    }}
                  >
                    <span
                      className="media-bin-label-cell"
                      role="cell"
                      onClick={() => {
                        cancelPendingTitleRename();
                        setActiveCell(null);
                      }}
                    >
                      <span className="media-bin-label-color" style={{ background: item.color }} />
                    </span>
                    <span
                      className={cellClassName(item.id, "title", selected, "media-bin-title-cell")}
                      role="cell"
                      style={{
                        paddingLeft: `${
                          8 +
                          titleColumnLeadingSpace +
                          (depth - (boundChild ? 1 : 0)) * 22 * listIconScale
                        }px`,
                      }}
                      data-media-bind-video-id={targetVideoId ?? undefined}
                      onPointerDown={(event) => {
                        if (editingItemId !== item.id) {
                          startPointerMediaDrag(event, item);
                        }
                      }}
                      onClick={(event) => handleTitleCellClick(event, item, selected)}
                      onDoubleClick={() => {
                        cancelPendingTitleRename();
                        if (!isReadOnly && item.kind !== "video") {
                          beginTitleRename(item);
                        }
                      }}
                    >
                      {boundChild && <span className="media-bin-bind-branch" aria-hidden="true" />}
                      <span className={`media-bin-kind-icon ${item.kind}`}>
                        {itemIcon(item, project, isMediaVideoDetached(item, detachedVideoIds))}
                      </span>
                      {editingItemId === item.id ? (
                        <input
                          className="media-bin-title-editor"
                          value={renameValue}
                          aria-label="重命名媒体"
                          autoFocus
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => setRenameValue(event.currentTarget.value)}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                          onDoubleClick={(event) => event.stopPropagation()}
                          onBlur={() => finishTitleRename(item, true)}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Enter") {
                              event.preventDefault();
                              event.currentTarget.blur();
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              finishTitleRename(item, false);
                            }
                          }}
                        />
                      ) : (
                        <>
                          <span className="media-bin-name-copy" title={item.file_name}>
                            {item.file_name}
                          </span>
                          {item.bound_to_video_id && (
                            <Link2 className="media-bin-bound-icon" aria-label="已绑定" />
                          )}
                          {item.kind === "video" &&
                            isMediaVideoDetached(item, detachedVideoIds) && (
                              <SplitSquareVertical
                                className="media-bin-status-icon"
                                aria-label="已分解"
                              />
                            )}
                          {isMediaItemOffline(item) && (
                            <span className="media-bin-offline-label">脱机</span>
                          )}
                        </>
                      )}
                    </span>
                    <span
                      className={cellClassName(item.id, "frameRate", selected)}
                      role="cell"
                      onClick={() => activateCell(item.id, "frameRate")}
                    >
                      {itemFrameRate(item, project)}
                    </span>
                    <span
                      className={cellClassName(item.id, "mediaStart", selected)}
                      role="cell"
                      onClick={() => activateCell(item.id, "mediaStart")}
                    >
                      {formatItemTime(item, project, item.start_time_us)}
                    </span>
                    <span
                      className={cellClassName(item.id, "mediaEnd", selected)}
                      role="cell"
                      onClick={() => activateCell(item.id, "mediaEnd")}
                    >
                      {formatItemTime(item, project, endUs)}
                    </span>
                    <span
                      className={cellClassName(item.id, "duration", selected)}
                      role="cell"
                      onClick={() => activateCell(item.id, "duration")}
                    >
                      {formatItemTime(item, project, item.duration_us)}
                    </span>
                    <span
                      className={cellClassName(item.id, "videoInfo", selected)}
                      role="cell"
                      onClick={() => activateCell(item.id, "videoInfo")}
                    >
                      {itemVideoInfo(item, projects)}
                    </span>
                    <span
                      className={cellClassName(item.id, "audioInfo", selected)}
                      role="cell"
                      onClick={() => activateCell(item.id, "audioInfo")}
                    >
                      {itemAudioInfo(item, projects)}
                    </span>
                    <span className="media-bin-boolean-cell" role="cell">
                      <input
                        type="checkbox"
                        checked={isMediaItemEnabled(item)}
                        aria-label={`启用 ${item.file_name}`}
                        disabled={isReadOnly}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          onSetItemsEnabled([item.id], event.currentTarget.checked)
                        }
                      />
                    </span>
                    <span className="media-bin-boolean-cell" role="cell">
                      <input
                        type="checkbox"
                        checked={isMediaItemHidden(item)}
                        aria-label={`隐藏 ${item.file_name}`}
                        disabled={isReadOnly}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          onSetItemsHidden([item.id], event.currentTarget.checked)
                        }
                      />
                    </span>
                  </div>
                );
              })}
              <div className="media-bin-table-tail-spacer" aria-hidden="true" />
            </div>
          )}
        </div>
      </div>
      {pointerDragPreview &&
        createPortal(
          <div
            className="media-bin-pointer-drag-preview"
            style={{
              transform: `translate(${pointerDragPreview.x + 12}px, ${pointerDragPreview.y + 10}px)`,
            }}
          >
            <span
              className={`media-bin-kind-icon ${
                pointerDragPreview.item?.kind ?? (pointerDragPreview.folder ? "folder" : "")
              }`}
            >
              {pointerDragPreview.item ? (
                itemIcon(
                  pointerDragPreview.item,
                  pointerDragPreview.project,
                  isMediaVideoDetached(pointerDragPreview.item, detachedVideoIds),
                )
              ) : (
                <Folder aria-hidden="true" />
              )}
            </span>
            <span>
              {pointerDragPreview.item?.file_name ?? pointerDragPreview.folder?.name ?? ""}
            </span>
          </div>,
          document.body,
        )}
      {renderMarqueeOverlay()}
    </div>
  );
}
