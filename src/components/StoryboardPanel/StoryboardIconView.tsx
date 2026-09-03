import { Star } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { formatMonitorFrame, formatMonitorTime } from "../../time";
import {
  timelineThumbnails,
  timelineThumbnailResolutionForDisplay,
  timelineThumbnailWindowContains,
  useTimelineThumbnailWindow,
  type TimelineThumbnailVisibleRange,
} from "../../timelineThumbnail";
import type { StoryboardShot } from "../../types";
import {
  PopupMenu,
  PopupMenuItem,
  PopupMenuSeparator,
  useCloseOnOutsidePointer,
} from "../PopupMenu";
import { StoryboardShotThumbnail } from "./StoryboardShotThumbnail";
import {
  useStoryboardPanelState,
  type StoryboardIconMetadataMode,
  type StoryboardShotStack,
  type StoryboardShotVisualLabel,
} from "./storyboardPanelState";

type StoryboardAnnotationMenuKind = "flag" | "color";

const storyboardColorValues: Record<StoryboardShotVisualLabel, string> = {
  red: "#ef4444",
  yellow: "#eab308",
  green: "#22c55e",
  blue: "#3b82f6",
  purple: "#a855f7",
  custom: "#ffffff",
};

const storyboardIconMetadataOptions: Array<
  | { type: "option"; value: StoryboardIconMetadataMode; label: string }
  | { type: "separator"; id: string }
> = [
  { type: "option", value: "none", label: "无" },
  { type: "separator", id: "after-none" },
  { type: "option", value: "ratingAndColorLabel", label: "星级和标签" },
  { type: "separator", id: "after-rating-and-color-label" },
  { type: "option", value: "index", label: "索引编号" },
  { type: "option", value: "title", label: "标题" },
  { type: "option", value: "mediaStart", label: "媒体开始" },
  { type: "option", value: "mediaEnd", label: "媒体结束" },
  { type: "option", value: "duration", label: "媒体时长" },
  { type: "separator", id: "after-time" },
  { type: "option", value: "rating", label: "星级" },
  { type: "option", value: "colorLabel", label: "标签" },
];

interface StoryboardIconViewProps {
  shots: StoryboardShot[];
  currentShotId: string | undefined;
  assetId: string;
  fingerprint: string;
  videoPath: string;
  previewVideoPath: string;
  frameRate: number;
  gridCardWidth: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onSelectShot: (
    event: ReactMouseEvent<HTMLElement>,
    shot: StoryboardShot,
    focusRange?: boolean,
  ) => void;
  onDoubleClickShot: (event: ReactMouseEvent<HTMLElement>, shot: StoryboardShot) => void;
  onStartKeywordDrag: (event: ReactPointerEvent<HTMLButtonElement>, shot: StoryboardShot) => void;
  onOpenAnnotationMenu: (
    event: ReactMouseEvent<HTMLButtonElement>,
    shotId: string,
    kind: StoryboardAnnotationMenuKind,
  ) => void;
  shotTitle: (shot: StoryboardShot) => string;
  shotLabel: (shot: StoryboardShot) => string;
}

interface StoryboardGridLayout {
  columns: number;
  cardWidth: number;
}

interface StoryboardGridResizeAnchor {
  shotId: string | undefined;
  fallbackIndex: number;
  rowFraction: number;
  expectedColumns: number;
  expectedCardWidth: number;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function stacksByShotId(stacks: readonly StoryboardShotStack[]) {
  const result = new Map<string, StoryboardShotStack>();
  for (const stack of stacks) {
    for (const shotId of stack.shotIds) {
      result.set(shotId, stack);
    }
  }
  return result;
}

function annotationTargets(
  shotId: string,
  selectedShotIds: ReadonlySet<string>,
  stackMap: ReadonlyMap<string, StoryboardShotStack>,
) {
  const sourceShotIds = selectedShotIds.has(shotId) ? selectedShotIds : [shotId];
  const result = new Set<string>();
  for (const sourceShotId of sourceShotIds) {
    const stack = stackMap.get(sourceShotId);
    if (stack && !stack.expanded) {
      for (const stackShotId of stack.shotIds) {
        result.add(stackShotId);
      }
    } else {
      result.add(sourceShotId);
    }
  }
  return result;
}

interface StoryboardIconRatingProps {
  rating: number;
  onSetRating: (rating: number) => void;
}

function StoryboardIconRating({ rating, onSetRating }: StoryboardIconRatingProps) {
  return (
    <div className="shot-thumbnail-rating" role="group" aria-label={`${rating} 星`}>
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= rating;
        return (
          <button
            key={star}
            type="button"
            className={`shot-thumbnail-rating-slot ${filled ? "is-filled" : "is-empty"}`}
            onClick={(event) => {
              event.stopPropagation();
              onSetRating(rating === star ? 0 : star);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            title={`${star} 星`}
            aria-label={`${star} 星`}
            aria-pressed={rating === star}
          >
            {filled ? <Star aria-hidden="true" /> : <span aria-hidden="true">·</span>}
          </button>
        );
      })}
    </div>
  );
}

function metadataText(
  mode: StoryboardIconMetadataMode,
  shot: StoryboardShot,
  rowNumber: number,
  title: string,
  frameRate: number,
  label: string,
) {
  if (mode === "index") {
    return String(rowNumber);
  }
  if (mode === "title") {
    return title;
  }
  if (mode === "mediaStart") {
    return formatMonitorTime(shot.start_us, frameRate);
  }
  if (mode === "mediaEnd") {
    return formatMonitorTime(shot.end_us, frameRate);
  }
  if (mode === "duration") {
    return formatMonitorFrame(Math.max(0, shot.end_frame - shot.start_frame + 1), frameRate);
  }
  if (mode === "colorLabel") {
    return label || null;
  }
  return null;
}

export function StoryboardIconView({
  shots,
  currentShotId,
  assetId,
  fingerprint,
  videoPath,
  previewVideoPath,
  frameRate,
  gridCardWidth,
  scrollRef,
  onPointerDown,
  onContextMenu,
  onSelectShot,
  onDoubleClickShot,
  onStartKeywordDrag,
  onOpenAnnotationMenu,
  shotTitle,
  shotLabel,
}: StoryboardIconViewProps) {
  const {
    activeShotId,
    selectedShotIds,
    shotAnnotations,
    shotStacks,
    iconMetadataMode,
    setShotRatings,
    setShotFlags,
    setShotStackExpanded,
    setIconMetadataMode,
  } = useStoryboardPanelState((state) => state);
  const [gridLayout, setGridLayout] = useState<StoryboardGridLayout>({
    columns: 1,
    cardWidth: gridCardWidth,
  });
  const [thumbnailVisibleRange, setThumbnailVisibleRange] = useState<TimelineThumbnailVisibleRange>(
    {
      startIndex: -1,
      endIndex: -1,
      centerIndex: -1,
    },
  );
  const gridRef = useRef<HTMLDivElement | null>(null);
  const previousGridCardWidthRef = useRef(gridCardWidth);
  const pendingGridResizeAnchorRef = useRef<StoryboardGridResizeAnchor | null>(null);
  const [metadataMenu, setMetadataMenu] = useState<{ x: number; y: number } | null>(null);
  const stackMap = stacksByShotId(shotStacks);
  const gridStyle = {
    "--storyboard-icon-column-count": gridLayout.columns,
    "--storyboard-icon-card-render-width": `${gridLayout.cardWidth}px`,
    "--storyboard-icon-row-number-size": `${gridLayout.cardWidth * 0.295}px`,
    "--storyboard-row-height": `${gridLayout.cardWidth}px`,
  } as CSSProperties;

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) {
      return;
    }
    const scrollContainer = scrollRef.current;
    const targetWidthChanged = previousGridCardWidthRef.current !== gridCardWidth;
    const itemCount = grid.children.length;
    const centerPosition = scrollContainer
      ? (scrollContainer.scrollTop + scrollContainer.clientHeight / 2) /
        Math.max(1, gridLayout.cardWidth)
      : 0;
    const centerRow = clamp(
      Math.floor(centerPosition),
      0,
      Math.max(0, Math.ceil(itemCount / Math.max(1, gridLayout.columns)) - 1),
    );
    const centerColumn = scrollContainer
      ? clamp(
          Math.floor(scrollContainer.clientWidth / 2 / Math.max(1, gridLayout.cardWidth)),
          0,
          Math.max(0, gridLayout.columns - 1),
        )
      : 0;
    const anchorIndex = clamp(
      centerRow * Math.max(1, gridLayout.columns) + centerColumn,
      0,
      Math.max(0, itemCount - 1),
    );
    const resizeAnchor =
      targetWidthChanged && scrollContainer && itemCount > 0
        ? {
            shotId: (grid.children.item(anchorIndex) as HTMLElement | null)?.dataset
              .storyboardShotId,
            fallbackIndex: anchorIndex,
            rowFraction: clamp(centerPosition - centerRow, 0, 1),
          }
        : null;
    previousGridCardWidthRef.current = gridCardWidth;
    let shouldRecordResizeAnchor = targetWidthChanged;

    const updateGridLayout = () => {
      const currentItemCount = grid.children.length;
      if (currentItemCount === 0) {
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

      for (let candidateColumns = currentItemCount; candidateColumns >= 1; candidateColumns -= 1) {
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
      if (shouldRecordResizeAnchor) {
        shouldRecordResizeAnchor = false;
        pendingGridResizeAnchorRef.current =
          resizeAnchor && (gridLayout.columns !== columns || gridLayout.cardWidth !== cardWidth)
            ? {
                ...resizeAnchor,
                expectedColumns: columns,
                expectedCardWidth: cardWidth,
              }
            : null;
      }
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
  }, [gridCardWidth, gridLayout.cardWidth, gridLayout.columns, scrollRef, shots.length]);

  useLayoutEffect(() => {
    const resizeAnchor = pendingGridResizeAnchorRef.current;
    const scrollContainer = scrollRef.current;
    if (
      !resizeAnchor ||
      !scrollContainer ||
      resizeAnchor.expectedColumns !== gridLayout.columns ||
      resizeAnchor.expectedCardWidth !== gridLayout.cardWidth
    ) {
      return;
    }
    pendingGridResizeAnchorRef.current = null;

    const matchingIndex = resizeAnchor.shotId
      ? shots.findIndex((shot) => shot.id === resizeAnchor.shotId)
      : -1;
    const anchorIndex = clamp(
      matchingIndex >= 0 ? matchingIndex : resizeAnchor.fallbackIndex,
      0,
      Math.max(0, shots.length - 1),
    );
    const row = Math.floor(anchorIndex / Math.max(1, gridLayout.columns));
    const desiredScrollTop =
      (row + resizeAnchor.rowFraction) * gridLayout.cardWidth - scrollContainer.clientHeight / 2;
    const contentHeight =
      Math.ceil(shots.length / Math.max(1, gridLayout.columns)) * gridLayout.cardWidth;
    const maximumScrollTop = Math.max(0, contentHeight - scrollContainer.clientHeight);
    scrollContainer.scrollTop = clamp(desiredScrollTop, 0, maximumScrollTop);
  }, [gridLayout.cardWidth, gridLayout.columns, scrollRef, shots]);

  useLayoutEffect(() => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer || shots.length === 0) {
      setThumbnailVisibleRange({ startIndex: -1, endIndex: -1, centerIndex: -1 });
      return;
    }

    const updateVisibleRange = () => {
      const rowHeight = Math.max(1, gridLayout.cardWidth);
      const columnCount = Math.max(1, gridLayout.columns);
      const lastRow = Math.max(0, Math.ceil(shots.length / columnCount) - 1);
      const firstVisibleRow = clamp(Math.floor(scrollContainer.scrollTop / rowHeight), 0, lastRow);
      const lastVisibleRow = clamp(
        Math.floor(
          Math.max(
            scrollContainer.scrollTop,
            scrollContainer.scrollTop + scrollContainer.clientHeight - 0.5,
          ) / rowHeight,
        ),
        firstVisibleRow,
        lastRow,
      );
      const centerRow = clamp(
        Math.floor((scrollContainer.scrollTop + scrollContainer.clientHeight / 2) / rowHeight),
        firstVisibleRow,
        lastVisibleRow,
      );
      const centerColumn = clamp(
        Math.floor(scrollContainer.clientWidth / 2 / rowHeight),
        0,
        columnCount - 1,
      );
      const next = {
        startIndex: firstVisibleRow * columnCount,
        endIndex: Math.min(shots.length - 1, (lastVisibleRow + 1) * columnCount - 1),
        centerIndex: Math.min(shots.length - 1, centerRow * columnCount + centerColumn),
      };
      setThumbnailVisibleRange((current) =>
        current.startIndex === next.startIndex &&
        current.endIndex === next.endIndex &&
        current.centerIndex === next.centerIndex
          ? current
          : next,
      );
    };

    const resizeObserver = new ResizeObserver(updateVisibleRange);
    resizeObserver.observe(scrollContainer);
    scrollContainer.addEventListener("scroll", updateVisibleRange, { passive: true });
    updateVisibleRange();
    return () => {
      resizeObserver.disconnect();
      scrollContainer.removeEventListener("scroll", updateVisibleRange);
    };
  }, [gridLayout.cardWidth, gridLayout.columns, scrollRef, shots.length]);

  const thumbnailTargetResolution = timelineThumbnailResolutionForDisplay(
    gridLayout.cardWidth * 0.8,
    gridLayout.cardWidth * 0.45454545,
  );
  const thumbnailWindow = useTimelineThumbnailWindow({
    enabled: Boolean(videoPath),
    sourceKey: `${assetId}:${fingerprint}:${videoPath}`,
    items: shots,
    getItemKey: (shot) => `${shot.id}:${shot.start_us}`,
    visibleRange: thumbnailVisibleRange,
    targetResolution: thumbnailTargetResolution,
    requestThumbnail: (shot, _index, resolution, priority) =>
      timelineThumbnails.request({
        kind: "storyboard",
        assetId,
        fingerprint,
        videoPath,
        timeUs: shot.start_us,
        frameRate,
        priority,
        resolution,
      }),
    backfillThumbnail: (shot, _index, resolution, priority) =>
      timelineThumbnails.backfill({
        kind: "storyboard",
        assetId,
        fingerprint,
        videoPath,
        timeUs: shot.start_us,
        frameRate,
        priority,
        resolution,
      }),
  });

  useCloseOnOutsidePointer(Boolean(metadataMenu), () => setMetadataMenu(null), {
    capturePointerdown: true,
    ignorePopupMenuTargets: true,
  });

  return (
    <>
      <div
        ref={scrollRef}
        className="storyboard-icon-view"
        data-storyboard-shot-drag-surface=""
        role="list"
        aria-label="分镜图标视图"
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
      >
        <div ref={gridRef} className="storyboard-icon-grid" style={gridStyle}>
          {shots.map((shot, index) => {
            const selected = selectedShotIds.has(shot.id);
            const annotation = shotAnnotations[shot.id];
            const rating = annotation?.rating ?? 0;
            const flag = annotation?.retained
              ? "retained"
              : annotation?.excluded
                ? "excluded"
                : "none";
            const colorLabel = annotation?.colorLabel ?? undefined;
            const visualLabel: StoryboardShotVisualLabel | undefined =
              annotation?.customLabel?.trim() ? "custom" : colorLabel;
            const label = shotLabel(shot);
            const stack = stackMap.get(shot.id);
            const stackIndex = stack?.shotIds.indexOf(shot.id) ?? -1;
            const targetShotIds = () => annotationTargets(shot.id, selectedShotIds, stackMap);
            const text = metadataText(
              iconMetadataMode,
              shot,
              index + 1,
              shotTitle(shot),
              frameRate,
              label,
            );
            return (
              <div
                key={shot.id}
                role="listitem"
                tabIndex={0}
                data-storyboard-shot-id={shot.id}
                className={`storyboard-icon-card ${selected ? "is-selected" : ""} ${
                  selected && shot.id === activeShotId ? "is-primary" : ""
                } ${shot.id === currentShotId ? "is-current" : ""} ${
                  visualLabel ? "has-color-label" : ""
                } ${stack ? "has-shot-stack" : ""} ${
                  stack?.expanded ? "is-expanded-stack-member" : ""
                }`}
                style={
                  visualLabel
                    ? ({
                        "--storyboard-color-label": storyboardColorValues[visualLabel],
                      } as CSSProperties)
                    : undefined
                }
                onClick={(event) => onSelectShot(event, shot)}
                onDoubleClick={(event) => onDoubleClickShot(event, shot)}
              >
                <div className="shot-thumbnail-cell">
                  <StoryboardShotThumbnail
                    shot={shot}
                    rowNumber={index + 1}
                    hasKeywords={Boolean(annotation?.keywordIds?.length)}
                    rating={rating}
                    flag={flag}
                    colorLabel={visualLabel}
                    stack={stack}
                    stackIndex={stackIndex}
                    assetId={assetId}
                    fingerprint={fingerprint}
                    videoPath={videoPath}
                    previewVideoPath={previewVideoPath}
                    frameRate={frameRate}
                    priority={Math.abs(index - thumbnailWindow.centerIndex)}
                    requestEnabled={timelineThumbnailWindowContains(thumbnailWindow, index)}
                    targetResolution={thumbnailTargetResolution}
                    onSelectFrame={(event) => onSelectShot(event, shot, true)}
                    onStartKeywordDrag={(event) => onStartKeywordDrag(event, shot)}
                    onToggleStack={() => stack && setShotStackExpanded(shot.id, !stack.expanded)}
                    onSetRating={(nextRating) => setShotRatings(targetShotIds(), nextRating)}
                    onSetFlag={(nextFlag) => setShotFlags(targetShotIds(), nextFlag)}
                    onOpenFlagMenu={(event) => onOpenAnnotationMenu(event, shot.id, "flag")}
                    onOpenColorMenu={(event) => onOpenAnnotationMenu(event, shot.id, "color")}
                  />
                  <div
                    className={`storyboard-icon-metadata is-${iconMetadataMode}`}
                    aria-label="图标信息显示方式"
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setMetadataMenu({ x: event.clientX, y: event.clientY });
                    }}
                  >
                    {(iconMetadataMode === "ratingAndColorLabel" ||
                      iconMetadataMode === "rating") && (
                      <StoryboardIconRating
                        rating={rating}
                        onSetRating={(nextRating) => setShotRatings(targetShotIds(), nextRating)}
                      />
                    )}
                    {iconMetadataMode === "ratingAndColorLabel" && (
                      <button
                        type="button"
                        className={`shot-thumbnail-color-label ${
                          visualLabel ? "has-color-label" : "is-none"
                        }`}
                        onClick={(event) => onOpenAnnotationMenu(event, shot.id, "color")}
                        onDoubleClick={(event) => event.stopPropagation()}
                        title={visualLabel ? "更改标签" : "设置标签"}
                        aria-label={visualLabel ? "更改标签" : "设置标签"}
                      />
                    )}
                    {text !== null && (
                      <span className="storyboard-icon-metadata-text" title={text}>
                        {text}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {metadataMenu &&
        createPortal(
          <PopupMenu
            className="storyboard-context-menu storyboard-icon-metadata-menu"
            contextMenuAnchor={metadataMenu}
            ariaLabel="图标信息显示方式"
            style={{ position: "fixed", left: metadataMenu.x, top: metadataMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {storyboardIconMetadataOptions.map((option) =>
              option.type === "separator" ? (
                <PopupMenuSeparator key={option.id} />
              ) : (
                <PopupMenuItem
                  key={option.value}
                  checked={iconMetadataMode === option.value}
                  onSelect={() => {
                    setIconMetadataMode(option.value);
                    setMetadataMenu(null);
                  }}
                >
                  {option.label}
                </PopupMenuItem>
              ),
            )}
          </PopupMenu>,
          document.body,
        )}
    </>
  );
}
