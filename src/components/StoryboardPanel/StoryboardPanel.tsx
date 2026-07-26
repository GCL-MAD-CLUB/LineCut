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
import { SelectDropdown, selectDropdownItems } from "../SelectDropdown";
import "./StoryboardPanel.css";
import {
  useStoryboardPanelState,
  type StoryboardShotAnnotation,
  type StoryboardShotFilter,
} from "./storyboardPanelState";

const storyboardEventSource = eventSource("storyboard-panel");
const MIN_UPCOMING_SCROLL_DURATION_MS = 1000;
const MAX_UPCOMING_SCROLL_DURATION_MS = 1200;
const THUMBNAIL_PREFETCH_ROWS_BEFORE = 10;
const THUMBNAIL_PREFETCH_ROWS_AFTER = 28;
const TABLE_SCROLLBAR_SPACER_PX = 8;
const STORYBOARD_THUMBNAIL_WIDTH = 88;
const STORYBOARD_THUMBNAIL_HEIGHT = 50;
const STORYBOARD_ROW_VERTICAL_PADDING = 16;
const STORYBOARD_THUMBNAIL_COLUMN_PADDING = 16;

type StoryboardResizableColumnId = "thumbnail" | "mediaStart" | "mediaEnd" | "duration" | "rating";
type StoryboardSortableColumnId = "mediaStart" | "mediaEnd" | "duration" | "rating" | "retained";
type StoryboardTableColumnId = "status" | StoryboardResizableColumnId | "retained" | "trailing";
type StoryboardSortDirection = "ascending" | "descending";

interface StoryboardSort {
  columnId: StoryboardSortableColumnId;
  direction: StoryboardSortDirection;
}

const defaultStoryboardSort: StoryboardSort = {
  columnId: "mediaStart",
  direction: "ascending",
};

const storyboardTableHeaders: Array<{
  id: StoryboardTableColumnId;
  label: string;
  sortColumnId?: StoryboardSortableColumnId;
  resizeColumn?: StoryboardResizableColumnId;
}> = [
  { id: "status", label: "" },
  { id: "thumbnail", label: "" },
  { id: "mediaStart", label: "媒体开始", sortColumnId: "mediaStart", resizeColumn: "thumbnail" },
  { id: "mediaEnd", label: "媒体结束", sortColumnId: "mediaEnd", resizeColumn: "mediaStart" },
  {
    id: "duration",
    label: "媒体持续时间",
    sortColumnId: "duration",
    resizeColumn: "mediaEnd",
  },
  { id: "rating", label: "星级", sortColumnId: "rating", resizeColumn: "duration" },
  { id: "retained", label: "留用", resizeColumn: "rating" },
  { id: "trailing", label: "" },
];

type StoryboardResizableColumnWidths = Record<StoryboardResizableColumnId, number>;

const initialStoryboardColumnWidths: StoryboardResizableColumnWidths = {
  thumbnail: 104,
  mediaStart: 128,
  mediaEnd: 128,
  duration: 140,
  rating: 112,
};

const minimumStoryboardColumnWidths: StoryboardResizableColumnWidths = {
  thumbnail: 60,
  mediaStart: 21,
  mediaEnd: 21,
  duration: 21,
  rating: 30,
};

const maximumStoryboardColumnWidths: StoryboardResizableColumnWidths = {
  thumbnail: 720,
  mediaStart: 300,
  mediaEnd: 300,
  duration: 320,
  rating: 180,
};

const storyboardStatusColumnWidth = 16;
const storyboardRetainedColumnWidth = 62;

const storyboardResizableColumnLabels: Record<StoryboardResizableColumnId, string> = {
  thumbnail: "缩略图",
  mediaStart: "媒体开始",
  mediaEnd: "媒体结束",
  duration: "媒体持续时间",
  rating: "星级",
};

const storyboardRatingFilters = [1, 2, 3, 4, 5] as const;
const storyboardFilterOptions: Array<readonly [StoryboardShotFilter, string]> = [
  ["all", "全部镜头"],
  ["retained", "已留用"],
  ["rated", "有星级"],
  ["unrated", "无星级"],
];
const storyboardFilterItems = selectDropdownItems(storyboardFilterOptions);

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

function shotMatches(shot: StoryboardShot, query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) {
    return true;
  }
  const haystack = `${formatDuration(shot.start_us)} ${formatDuration(shot.end_us)} ${
    shot.start_frame
  } ${shot.end_frame}`.toLocaleLowerCase();
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function shotMatchesFilter(
  annotation: StoryboardShotAnnotation | undefined,
  filter: StoryboardShotFilter,
  minimumRating: number,
) {
  const rating = annotation?.rating ?? 0;
  const retained = annotation?.retained ?? false;
  const matchesMinimumRating = minimumRating === 0 || rating >= minimumRating;

  if (filter === "all") {
    return matchesMinimumRating;
  }
  if (filter === "retained") {
    return retained && matchesMinimumRating;
  }
  if (filter === "rated") {
    return rating >= Math.max(1, minimumRating);
  }
  if (filter === "unrated") {
    return rating === 0;
  }
  return retained && rating >= Math.max(1, minimumRating);
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

function storyboardShotSortValue(
  shot: StoryboardShot,
  columnId: StoryboardSortableColumnId,
  shotAnnotations: Record<string, StoryboardShotAnnotation>,
) {
  const annotation = shotAnnotations[shot.id];
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
  return annotation?.retained ? 1 : 0;
}

function sortStoryboardShots(
  shots: readonly StoryboardShot[],
  sort: StoryboardSort,
  shotAnnotations: Record<string, StoryboardShotAnnotation>,
) {
  const direction = sort.direction === "ascending" ? 1 : -1;
  return shots
    .map((shot, index) => ({ shot, index }))
    .sort((left, right) => {
      const valueDelta =
        storyboardShotSortValue(left.shot, sort.columnId, shotAnnotations) -
        storyboardShotSortValue(right.shot, sort.columnId, shotAnnotations);
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
    activeShotId,
    shots,
    selectedShotIds,
    shotAnnotations,
    detectingVideoContext,
    thumbnailSize,
    syncVideoContext,
    setQuery,
    setShowOnlySelected,
    setShotFilter,
    setMinimumRating,
    setThumbnailSize,
    setShotRatings,
    setShotsRetained,
    detectionStarted,
    detectionCompleted,
    detectionFinished,
    shotSelectionCleared,
    shotSelectionReplaced,
  } = useStoryboardPanelState((state) => state);
  const { isRunning: isDetecting } = useTaskProgressStatus("storyboard.detect");
  const playback = usePlaybackStatus();
  const listRef = useRef<HTMLDivElement | null>(null);
  const tableHeaderRef = useRef<HTMLDivElement | null>(null);
  const scrollAnimationRef = useRef<number | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const [shotSort, setShotSort] = useState<StoryboardSort>(defaultStoryboardSort);
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
  const displayShots = shots;
  const filteredShots = useMemo(
    () =>
      displayShots.filter(
        (shot) =>
          (!showOnlySelected || selectedShotIds.has(shot.id)) &&
          shotMatches(shot, query) &&
          shotMatchesFilter(shotAnnotations[shot.id], shotFilter, minimumRating),
      ),
    [
      displayShots,
      minimumRating,
      query,
      selectedShotIds,
      shotAnnotations,
      shotFilter,
      showOnlySelected,
    ],
  );
  const sortedShots = useMemo(
    () => sortStoryboardShots(filteredShots, shotSort, shotAnnotations),
    [filteredShots, shotAnnotations, shotSort],
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
  const thumbnailColumnWidth = Math.max(
    storyboardColumnWidths.thumbnail,
    thumbnailWidth + STORYBOARD_THUMBNAIL_COLUMN_PADDING,
  );
  const tableMinWidth =
    storyboardStatusColumnWidth +
    storyboardRetainedColumnWidth +
    thumbnailColumnWidth +
    storyboardColumnWidths.mediaStart +
    storyboardColumnWidths.mediaEnd +
    storyboardColumnWidths.duration +
    storyboardColumnWidths.rating;
  const tableStyle = {
    "--storyboard-fixed-status-width": `${storyboardStatusColumnWidth}px`,
    "--storyboard-fixed-thumbnail-width": `${thumbnailColumnWidth}px`,
    "--storyboard-col-thumbnail": `${thumbnailColumnWidth}px`,
    "--storyboard-col-media-start": `${storyboardColumnWidths.mediaStart}px`,
    "--storyboard-col-media-end": `${storyboardColumnWidths.mediaEnd}px`,
    "--storyboard-col-duration": `${storyboardColumnWidths.duration}px`,
    "--storyboard-col-rating": `${storyboardColumnWidths.rating}px`,
    "--storyboard-col-retained": `${storyboardRetainedColumnWidth}px`,
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

  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowVirtualizer, storyboardRowHeight]);

  useEffect(() => {
    syncVideoContext(videoContext);
  }, [syncVideoContext, videoContext]);

  useEffect(() => {
    if (showOnlySelected && selectedCount === 0) {
      setShowOnlySelected(false);
    }
  }, [selectedCount, setShowOnlySelected, showOnlySelected]);

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
      const rating = Number(event.key);
      if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
        return;
      }
      event.preventDefault();
      setShotRatings(selectedShotIds, rating);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isEditAuthority, selectedShotIds, setShotRatings]);

  useEffect(
    () => () => {
      if (scrollAnimationRef.current !== null) {
        cancelAnimationFrame(scrollAnimationRef.current);
      }
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
    const isUpcomingShot = animationStartFrame < shot.start_frame || shot.id !== currentShotId;
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
  }, [
    currentShotId,
    currentShotIndex,
    followShotId,
    followShotIndex,
    frameRate,
    isPlaying,
    rowVirtualizer,
    sortedShots,
  ]);

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
    selectionAnchorRef.current = null;
    shotSelectionCleared();
  }

  function annotationTargetShotIds(shotId: string) {
    return selectedShotIds.has(shotId) ? selectedShotIds : [shotId];
  }

  function selectVisibleShots() {
    selectionAnchorRef.current = null;
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
    if (target.closest(".shot-frame-button, .shot-rating-button, .shot-retain-cell input")) {
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

  function handleShotFilterChange(filter: StoryboardShotFilter) {
    setShotFilter(filter);
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
    <section className="storyboard-panel">
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
            placeholder="搜索时间、帧号"
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

      <div className="storyboard-filter-row">
        <span className="storyboard-filter-label">过滤器：</span>
        <span className="storyboard-filter-comparator" aria-hidden="true">
          &ge;
        </span>
        <div className="storyboard-filter-stars" aria-label="按最低星级过滤">
          {storyboardRatingFilters.map((rating) => (
            <button
              key={rating}
              type="button"
              className={rating <= minimumRating ? "active" : ""}
              onClick={() => setRatingFilter(rating)}
              disabled={shots.length === 0}
              title={`筛选 ${rating} 星及以上`}
              aria-label={`筛选 ${rating} 星及以上`}
              aria-pressed={rating <= minimumRating}
            >
              <Star aria-hidden="true" />
            </button>
          ))}
        </div>
        <span className="storyboard-filter-separator" aria-hidden="true" />
        <SelectDropdown
          ariaLabel="分镜过滤器"
          className="storyboard-filter-dropdown"
          menuClassName="storyboard-filter-menu"
          value={shotFilter}
          selectedLabel={shotFilter === "custom" ? "自定义过滤" : undefined}
          items={storyboardFilterItems}
          onChange={handleShotFilterChange}
          disabled={shots.length === 0}
        />
      </div>

      <div className="storyboard-content">
        <div className="storyboard-list-frame" style={tableStyle}>
          <div className="storyboard-list-header-viewport">
            <div ref={tableHeaderRef} className="storyboard-list-header" role="row">
              {storyboardTableHeaders.map(renderTableHeader)}
            </div>
            <div className="storyboard-list-header-fixed-overlay" aria-hidden="true">
              <span className="storyboard-column-header storyboard-column-status" />
              <span className="storyboard-column-header storyboard-column-thumbnail" />
            </div>
          </div>

          <div ref={listRef} className="shot-list" onScroll={syncTableHeaderScroll}>
            {sortedShots.length > 0 && (
              <div
                className="virtual-spacer"
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
                  const rating = annotation?.rating ?? 0;
                  const retained = annotation?.retained ?? false;
                  return (
                    <div
                      key={shot.id}
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualRow.index}
                      className={`shot-row ${selected ? "is-selected" : ""} ${
                        isPrimaryShot ? "is-primary" : ""
                      } ${isCurrentShot ? "is-current" : ""}`}
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                      onClick={(event) => handleShotSelection(event, shot)}
                      onDoubleClick={(event) => handleShotDoubleClick(event, shot)}
                    >
                      <span className="shot-status-cell" aria-hidden="true" />
                      <div className="shot-thumbnail-cell">
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
                              handleShotSelection(event, shot, true);
                            }}
                          />
                        )}
                      </div>
                      <span className="shot-time-cell">
                        {formatMonitorTime(shot.start_us, frameRate)}
                      </span>
                      <span className="shot-time-cell">
                        {formatMonitorTime(shot.end_us, frameRate)}
                      </span>
                      <span className="shot-duration-cell">
                        {formatMonitorFrame(
                          Math.max(0, shot.end_frame - shot.start_frame + 1),
                          frameRate,
                        )}
                      </span>
                      <div className="shot-rating-cell" aria-label={`${rating} 星`}>
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
                      <div className="shot-retain-cell">
                        <input
                          type="checkbox"
                          checked={retained}
                          onClick={(event) => {
                            event.stopPropagation();
                          }}
                          onDoubleClick={(event) => event.stopPropagation()}
                          onChange={() =>
                            setShotsRetained(annotationTargetShotIds(shot.id), !retained)
                          }
                          title={retained ? "取消留用" : "留用镜头"}
                          aria-label={retained ? "取消留用镜头" : "留用镜头"}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

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
    </section>
  );
}
