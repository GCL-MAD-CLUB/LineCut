import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import { Star } from "lucide-react";
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
import { formatMonitorTime } from "../../time";
import type { SubtitleCue } from "../../types";
import { subtitleCueColorLabels } from "./SubtitleColorLabelButtons";
import { SubtitleCueThumbnail } from "./SubtitleCueThumbnail";
import { useSubtitlePanelState, type SubtitleCueVisualLabel } from "./subtitlePanelState";

const cellEditDelayMs = 350;

type ActiveColumn = "subtitle" | "mediaStart" | "mediaEnd" | "duration" | "label";
type SubtitleAnnotationMenuKind = "flag" | "color";

interface ActiveCell {
  cueId: string;
  columnId: ActiveColumn;
}

function annotationTargets(cueId: string, selectedCueIds: ReadonlySet<string>) {
  return selectedCueIds.has(cueId) ? selectedCueIds : [cueId];
}

interface SubtitleListViewProps {
  cues: SubtitleCue[];
  currentCueIndex: number;
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
  onSelectCue: (
    event: ReactMouseEvent<HTMLElement>,
    cue: SubtitleCue,
    focusRange?: boolean,
  ) => void;
  onDoubleClickCue: (event: ReactMouseEvent<HTMLElement>, cue: SubtitleCue) => void;
  onOpenAnnotationMenu: (
    event: ReactMouseEvent<HTMLButtonElement>,
    cueId: string,
    kind: SubtitleAnnotationMenuKind,
  ) => void;
  cueLabel: (cue: SubtitleCue) => string;
}

export function SubtitleListView({
  cues,
  currentCueIndex,
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
  onSelectCue,
  onDoubleClickCue,
  onOpenAnnotationMenu,
  cueLabel,
}: SubtitleListViewProps) {
  const {
    activeCueId,
    selectedCueIds,
    cueAnnotations,
    setCueCustomLabels,
    setCueRatings,
    setCueFlags,
    setCueColorLabels,
  } = useSubtitlePanelState((state) => state);
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);
  const [editingCueId, setEditingCueId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const pendingCellEditRef = useRef<number | null>(null);

  useEffect(() => {
    cancelPendingCellEdit();
    setEditingCueId(null);
    setActiveCell(null);
  }, [resetKey]);

  useEffect(
    () => () => {
      cancelPendingCellEdit();
    },
    [],
  );

  function cancelPendingCellEdit() {
    if (pendingCellEditRef.current === null) {
      return;
    }
    window.clearTimeout(pendingCellEditRef.current);
    pendingCellEditRef.current = null;
  }

  function activateCell(cueId: string, columnId: ActiveColumn) {
    cancelPendingCellEdit();
    setActiveCell({ cueId, columnId });
  }

  function cellClassName(
    cueId: string,
    columnId: ActiveColumn,
    selected: boolean,
    baseClassName: string,
  ) {
    return [
      baseClassName,
      selected && activeCell?.cueId === cueId && activeCell.columnId === columnId
        ? "subtitle-active-cell"
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  function beginLabelEdit(cue: SubtitleCue) {
    cancelPendingCellEdit();
    setEditValue(cueLabel(cue));
    setEditingCueId(cue.id);
  }

  function scheduleLabelEdit(cue: SubtitleCue) {
    cancelPendingCellEdit();
    pendingCellEditRef.current = window.setTimeout(() => {
      pendingCellEditRef.current = null;
      beginLabelEdit(cue);
    }, cellEditDelayMs);
  }

  function finishLabelEdit(cue: SubtitleCue, commit: boolean) {
    cancelPendingCellEdit();
    if (editingCueId !== cue.id) {
      return;
    }
    const nextValue = editValue.trim();
    if (commit && nextValue !== cueLabel(cue)) {
      const colorLabel = subtitleCueColorLabels.find(([, label]) => label === nextValue)?.[0];
      if (colorLabel) {
        setCueColorLabels([cue.id], colorLabel);
      } else {
        setCueCustomLabels([cue.id], nextValue);
      }
    }
    setEditingCueId(null);
  }

  return (
    <div className="subtitle-list-frame" role="table" aria-label="字幕列表" style={tableStyle}>
      <div className="subtitle-list-header-viewport">
        <div ref={headerRef} className="subtitle-list-header" role="row">
          {headerContent}
        </div>
        <div className="subtitle-list-header-fixed-overlay" aria-hidden="true">
          <span className="subtitle-column-header subtitle-column-thumbnail" />
        </div>
      </div>

      <div
        ref={scrollRef}
        className="cue-list"
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onContextMenu={(event) => {
          cancelPendingCellEdit();
          setActiveCell(null);
          onContextMenu(event);
        }}
      >
        {cues.length > 0 && (
          <div
            className="virtual-spacer"
            role="rowgroup"
            style={{ height: `${rowVirtualizer.getTotalSize() + 8}px` }}
          >
            {virtualRows.map((virtualRow) => {
              const cue = cues[virtualRow.index];
              const selected = selectedCueIds.has(cue.id);
              const annotation = cueAnnotations[cue.id];
              const rating = annotation?.rating ?? 0;
              const flag = annotation?.retained
                ? "retained"
                : annotation?.excluded
                  ? "excluded"
                  : "none";
              const colorLabel = annotation?.colorLabel ?? undefined;
              const visualLabel: SubtitleCueVisualLabel | undefined =
                annotation?.customLabel?.trim() ? "custom" : colorLabel;
              const targetCueIds = () => annotationTargets(cue.id, selectedCueIds);
              return (
                <div
                  key={cue.id}
                  ref={rowVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  data-subtitle-cue-id={cue.id}
                  className={`cue-row ${selected ? "is-selected" : ""} ${
                    selected && cue.id === activeCueId ? "is-primary" : ""
                  } ${virtualRow.index === currentCueIndex ? "is-current" : ""} ${
                    visualLabel ? "has-color-label" : ""
                  }`}
                  style={
                    {
                      transform: `translateY(${virtualRow.start}px)`,
                      ...(visualLabel
                        ? {
                            "--subtitle-color-label": {
                              red: "#ef4444",
                              yellow: "#eab308",
                              green: "#22c55e",
                              blue: "#3b82f6",
                              purple: "#a855f7",
                              custom: "#ffffff",
                            }[visualLabel],
                          }
                        : {}),
                    } as CSSProperties
                  }
                  role="row"
                  onClick={(event) => {
                    if (!(event.target as HTMLElement).closest(".cue-label-cell")) {
                      cancelPendingCellEdit();
                    }
                    onSelectCue(event, cue);
                  }}
                  onDoubleClick={(event) => onDoubleClickCue(event, cue)}
                >
                  <div className="cue-thumbnail-cell" role="cell">
                    <SubtitleCueThumbnail
                      cue={cue}
                      rowNumber={virtualRow.index + 1}
                      rating={rating}
                      flag={flag}
                      colorLabel={visualLabel}
                      assetId={assetId}
                      fingerprint={fingerprint}
                      videoPath={videoPath}
                      previewVideoPath={previewVideoPath}
                      priority={Math.abs(virtualRow.index - thumbnailPriorityCenterIndex)}
                      onSelectFrame={(event) => {
                        cancelPendingCellEdit();
                        setActiveCell(null);
                        onSelectCue(event, cue, true);
                      }}
                      onSetRating={(nextRating) => setCueRatings(targetCueIds(), nextRating)}
                      onSetFlag={(nextFlag) => setCueFlags(targetCueIds(), nextFlag)}
                      onOpenFlagMenu={(event) => onOpenAnnotationMenu(event, cue.id, "flag")}
                      onOpenColorMenu={(event) => onOpenAnnotationMenu(event, cue.id, "color")}
                    />
                  </div>
                  <span
                    className={cellClassName(cue.id, "subtitle", selected, "cue-subtitle-cell")}
                    role="cell"
                    title={cue.plain_text}
                    onClick={() => activateCell(cue.id, "subtitle")}
                  >
                    <span className="cue-subtitle-copy">{cue.plain_text}</span>
                  </span>
                  <span
                    className={cellClassName(cue.id, "mediaStart", selected, "cue-time-cell")}
                    role="cell"
                    onClick={() => activateCell(cue.id, "mediaStart")}
                  >
                    {formatMonitorTime(cue.start_us, frameRate)}
                  </span>
                  <span
                    className={cellClassName(cue.id, "mediaEnd", selected, "cue-time-cell")}
                    role="cell"
                    onClick={() => activateCell(cue.id, "mediaEnd")}
                  >
                    {formatMonitorTime(cue.end_us, frameRate)}
                  </span>
                  <span
                    className={cellClassName(cue.id, "duration", selected, "cue-duration-cell")}
                    role="cell"
                    onClick={() => activateCell(cue.id, "duration")}
                  >
                    {formatMonitorTime(Math.max(0, cue.end_us - cue.start_us), frameRate)}
                  </span>
                  <div className="cue-rating-cell" role="cell" aria-label={`${rating} 星`}>
                    {[1, 2, 3, 4, 5].map((star) => (
                      <button
                        key={star}
                        type="button"
                        className="cue-rating-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setCueRatings(targetCueIds(), rating === star ? 0 : star);
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
                  <div className="cue-retain-cell" role="cell">
                    <div className="cue-flag-controls">
                      {(["retained", "excluded"] as const).map((nextFlag) => {
                        const active = flag === nextFlag;
                        const label = nextFlag === "retained" ? "留用旗标" : "排除旗标";
                        return (
                          <button
                            key={nextFlag}
                            type="button"
                            className={`cue-flag-button subtitle-footer-flag-button ${active ? "active" : ""}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setCueFlags(targetCueIds(), active ? "none" : nextFlag);
                            }}
                            onDoubleClick={(event) => event.stopPropagation()}
                            title={active ? `取消${label}` : `设为${label}`}
                            aria-label={active ? `取消${label}` : `设为${label}`}
                            aria-pressed={active}
                          >
                            <span
                              className={`cue-thumbnail-flag is-${nextFlag}`}
                              aria-hidden="true"
                            />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <span
                    className={cellClassName(cue.id, "label", selected, "cue-label-cell")}
                    role="cell"
                    onClick={(event) => {
                      activateCell(cue.id, "label");
                      if (selected && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                        if (event.detail === 1) {
                          scheduleLabelEdit(cue);
                        } else {
                          cancelPendingCellEdit();
                        }
                      }
                    }}
                  >
                    {editingCueId === cue.id ? (
                      <input
                        className="cue-label-editor"
                        value={editValue}
                        aria-label="编辑字幕标签"
                        autoFocus
                        onFocus={(event) => event.currentTarget.select()}
                        onChange={(event) => setEditValue(event.currentTarget.value)}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onBlur={() => finishLabelEdit(cue, true)}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            finishLabelEdit(cue, false);
                          }
                        }}
                      />
                    ) : (
                      <span
                        className="cue-label-copy"
                        title={cueLabel(cue) || undefined}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          beginLabelEdit(cue);
                        }}
                      >
                        {cueLabel(cue) || "无"}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
