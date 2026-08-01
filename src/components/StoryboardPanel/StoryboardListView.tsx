import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type UIEvent as ReactUIEvent,
} from "react";
import { Star } from "lucide-react";
import { formatMonitorFrame, formatMonitorTime } from "../../time";
import type { StoryboardShot } from "../../types";
import { StoryboardShotThumbnail } from "./StoryboardShotThumbnail";
import { useStoryboardPanelState, type StoryboardShotStack } from "./storyboardPanelState";

const titleRenameDelayMs = 350;

type ActiveColumn = "title" | "mediaStart" | "mediaEnd" | "duration";
type StoryboardAnnotationMenuKind = "flag" | "color";

interface ActiveCell {
  shotId: string;
  columnId: ActiveColumn;
}

interface StoryboardListViewProps {
  shots: StoryboardShot[];
  currentShotIndex: number;
  tableStyle: CSSProperties;
  headerContent: ReactNode;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  virtualRows: VirtualItem[];
  thumbnailPriorityCenterIndex: number;
  assetId: string;
  fingerprint: string;
  videoPath: string;
  previewVideoPath: string;
  frameRate: number;
  resetKey: string;
  headerRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: (event: ReactUIEvent<HTMLDivElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onSelectShot: (
    event: ReactMouseEvent<HTMLElement>,
    shot: StoryboardShot,
    focusRange?: boolean,
  ) => void;
  onDoubleClickShot: (event: ReactMouseEvent<HTMLElement>, shot: StoryboardShot) => void;
  onOpenAnnotationMenu: (
    event: ReactMouseEvent<HTMLButtonElement>,
    shotId: string,
    kind: StoryboardAnnotationMenuKind,
  ) => void;
  shotTitle: (shot: StoryboardShot) => string;
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

export function StoryboardListView({
  shots,
  currentShotIndex,
  tableStyle,
  headerContent,
  rowVirtualizer,
  virtualRows,
  thumbnailPriorityCenterIndex,
  assetId,
  fingerprint,
  videoPath,
  previewVideoPath,
  frameRate,
  resetKey,
  headerRef,
  scrollRef,
  onScroll,
  onPointerDown,
  onContextMenu,
  onSelectShot,
  onDoubleClickShot,
  onOpenAnnotationMenu,
  shotTitle,
}: StoryboardListViewProps) {
  const {
    activeShotId,
    selectedShotIds,
    shotAnnotations,
    shotStacks,
    setShotTitle,
    setShotRatings,
    setShotFlags,
    setShotStackExpanded,
  } = useStoryboardPanelState((state) => state);
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);
  const [editingShotId, setEditingShotId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const pendingTitleRenameRef = useRef<number | null>(null);
  const stackMap = stacksByShotId(shotStacks);

  useEffect(() => {
    cancelPendingTitleRename();
    setEditingShotId(null);
    setActiveCell(null);
  }, [resetKey]);

  useEffect(
    () => () => {
      cancelPendingTitleRename();
    },
    [],
  );

  function cancelPendingTitleRename() {
    if (pendingTitleRenameRef.current === null) {
      return;
    }
    window.clearTimeout(pendingTitleRenameRef.current);
    pendingTitleRenameRef.current = null;
  }

  function activateCell(shotId: string, columnId: ActiveColumn) {
    cancelPendingTitleRename();
    setActiveCell({ shotId, columnId });
  }

  function cellClassName(
    shotId: string,
    columnId: ActiveColumn,
    selected: boolean,
    baseClassName: string,
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
    setRenameValue(shotTitle(shot));
    setEditingShotId(shot.id);
  }

  function scheduleTitleRename(shot: StoryboardShot) {
    cancelPendingTitleRename();
    pendingTitleRenameRef.current = window.setTimeout(() => {
      pendingTitleRenameRef.current = null;
      beginTitleRename(shot);
    }, titleRenameDelayMs);
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
    const currentTitle = shotTitle(shot);
    if (commit && nextTitle && nextTitle !== currentTitle) {
      setShotTitle(shot.id, nextTitle);
    }
    setEditingShotId(null);
  }

  return (
    <div className="storyboard-list-frame" role="table" aria-label="分镜列表" style={tableStyle}>
      <div className="storyboard-list-header-viewport">
        <div ref={headerRef} className="storyboard-list-header" role="row">
          {headerContent}
        </div>
        <div className="storyboard-list-header-fixed-overlay" aria-hidden="true">
          <span className="storyboard-column-header storyboard-column-thumbnail" />
        </div>
      </div>

      <div
        ref={scrollRef}
        className="shot-list"
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onContextMenu={(event) => {
          cancelPendingTitleRename();
          setActiveCell(null);
          onContextMenu(event);
        }}
      >
        {shots.length > 0 && (
          <div
            className="virtual-spacer"
            role="rowgroup"
            style={{ height: `${rowVirtualizer.getTotalSize() + 8}px` }}
          >
            {virtualRows.map((virtualRow) => {
              const shot = shots[virtualRow.index];
              const selected = selectedShotIds.has(shot.id);
              const annotation = shotAnnotations[shot.id];
              const rating = annotation?.rating ?? 0;
              const flag = annotation?.retained
                ? "retained"
                : annotation?.excluded
                  ? "excluded"
                  : "none";
              const colorLabel = annotation?.colorLabel ?? undefined;
              const stack = stackMap.get(shot.id);
              const stackIndex = stack?.shotIds.indexOf(shot.id) ?? -1;
              const targetShotIds = () => annotationTargets(shot.id, selectedShotIds, stackMap);
              return (
                <div
                  key={shot.id}
                  ref={rowVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  data-storyboard-shot-id={shot.id}
                  className={`shot-row ${selected ? "is-selected" : ""} ${
                    selected && shot.id === activeShotId ? "is-primary" : ""
                  } ${virtualRow.index === currentShotIndex ? "is-current" : ""} ${
                    colorLabel ? "has-color-label" : ""
                  } ${stack ? "has-shot-stack" : ""} ${
                    stack?.expanded ? "is-expanded-stack-member" : ""
                  }`}
                  style={
                    {
                      transform: `translateY(${virtualRow.start}px)`,
                      ...(colorLabel
                        ? {
                            "--storyboard-color-label": {
                              red: "#ef4444",
                              yellow: "#eab308",
                              green: "#22c55e",
                              blue: "#3b82f6",
                              purple: "#a855f7",
                            }[colorLabel],
                          }
                        : {}),
                    } as CSSProperties
                  }
                  role="row"
                  onClick={(event) => {
                    cancelPendingTitleRename();
                    onSelectShot(event, shot);
                  }}
                  onDoubleClick={(event) => onDoubleClickShot(event, shot)}
                >
                  <div className="shot-thumbnail-cell" role="cell">
                    <StoryboardShotThumbnail
                      shot={shot}
                      rowNumber={virtualRow.index + 1}
                      rating={rating}
                      flag={flag}
                      colorLabel={colorLabel}
                      stack={stack}
                      stackIndex={stackIndex}
                      assetId={assetId}
                      fingerprint={fingerprint}
                      videoPath={videoPath}
                      previewVideoPath={previewVideoPath}
                      frameRate={frameRate}
                      priority={Math.abs(virtualRow.index - thumbnailPriorityCenterIndex)}
                      onSelectFrame={(event) => {
                        cancelPendingTitleRename();
                        setActiveCell(null);
                        onSelectShot(event, shot, true);
                      }}
                      onToggleStack={() => stack && setShotStackExpanded(shot.id, !stack.expanded)}
                      onSetRating={(nextRating) => setShotRatings(targetShotIds(), nextRating)}
                      onSetFlag={(nextFlag) => setShotFlags(targetShotIds(), nextFlag)}
                      onOpenFlagMenu={(event) => onOpenAnnotationMenu(event, shot.id, "flag")}
                      onOpenColorMenu={(event) => onOpenAnnotationMenu(event, shot.id, "color")}
                    />
                  </div>
                  <span
                    className={cellClassName(shot.id, "title", selected, "shot-title-cell")}
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
                        title={shotTitle(shot)}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          beginTitleRename(shot);
                        }}
                      >
                        {shotTitle(shot)}
                      </span>
                    )}
                  </span>
                  <span
                    className={cellClassName(shot.id, "mediaStart", selected, "shot-time-cell")}
                    role="cell"
                    onClick={() => activateCell(shot.id, "mediaStart")}
                  >
                    {formatMonitorTime(shot.start_us, frameRate)}
                  </span>
                  <span
                    className={cellClassName(shot.id, "mediaEnd", selected, "shot-time-cell")}
                    role="cell"
                    onClick={() => activateCell(shot.id, "mediaEnd")}
                  >
                    {formatMonitorTime(shot.end_us, frameRate)}
                  </span>
                  <span
                    className={cellClassName(shot.id, "duration", selected, "shot-duration-cell")}
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
                          setShotRatings(targetShotIds(), rating === star ? 0 : star);
                        }}
                        onDoubleClick={(event) => event.stopPropagation()}
                        title={`${star} 星`}
                        aria-label={`${star} 星`}
                        aria-pressed={rating === star}
                      >
                        <Star className={star <= rating ? "is-filled" : ""} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                  <div className="shot-retain-cell" role="cell">
                    <div className="shot-flag-controls">
                      {(["retained", "excluded"] as const).map((nextFlag) => {
                        const active = flag === nextFlag;
                        const label = nextFlag === "retained" ? "留用旗标" : "排除旗标";
                        return (
                          <button
                            key={nextFlag}
                            type="button"
                            className={`shot-flag-button storyboard-footer-flag-button ${active ? "active" : ""}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setShotFlags(targetShotIds(), active ? "none" : nextFlag);
                            }}
                            onDoubleClick={(event) => event.stopPropagation()}
                            title={active ? `取消${label}` : `设为${label}`}
                            aria-label={active ? `取消${label}` : `设为${label}`}
                            aria-pressed={active}
                          >
                            <span
                              className={`shot-thumbnail-flag is-${nextFlag}`}
                              aria-hidden="true"
                            />
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
  );
}
