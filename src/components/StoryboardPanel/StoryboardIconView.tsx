import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { StoryboardShot } from "../../types";
import { StoryboardShotThumbnail } from "./StoryboardShotThumbnail";
import {
  useStoryboardPanelState,
  type StoryboardShotColorLabel,
  type StoryboardShotStack,
} from "./storyboardPanelState";

type StoryboardAnnotationMenuKind = "flag" | "color";

const storyboardColorValues: Record<StoryboardShotColorLabel, string> = {
  red: "#ef4444",
  yellow: "#eab308",
  green: "#22c55e",
  blue: "#3b82f6",
  purple: "#a855f7",
};

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
  onOpenAnnotationMenu: (
    event: ReactMouseEvent<HTMLButtonElement>,
    shotId: string,
    kind: StoryboardAnnotationMenuKind,
  ) => void;
}

interface StoryboardGridLayout {
  columns: number;
  cardWidth: number;
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
  onOpenAnnotationMenu,
}: StoryboardIconViewProps) {
  const {
    activeShotId,
    selectedShotIds,
    shotAnnotations,
    shotStacks,
    setShotRatings,
    setShotFlags,
    setShotStackExpanded,
  } = useStoryboardPanelState((state) => state);
  const [gridLayout, setGridLayout] = useState<StoryboardGridLayout>({
    columns: 1,
    cardWidth: gridCardWidth,
  });
  const gridRef = useRef<HTMLDivElement | null>(null);
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
  }, [gridCardWidth, shots.length]);

  return (
    <div
      ref={scrollRef}
      className="storyboard-icon-view"
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
          const stack = stackMap.get(shot.id);
          const stackIndex = stack?.shotIds.indexOf(shot.id) ?? -1;
          const targetShotIds = () => annotationTargets(shot.id, selectedShotIds, stackMap);
          return (
            <div
              key={shot.id}
              role="listitem"
              tabIndex={0}
              data-storyboard-shot-id={shot.id}
              className={`storyboard-icon-card ${selected ? "is-selected" : ""} ${
                selected && shot.id === activeShotId ? "is-primary" : ""
              } ${shot.id === currentShotId ? "is-current" : ""} ${
                colorLabel ? "has-color-label" : ""
              } ${stack ? "has-shot-stack" : ""} ${
                stack?.expanded ? "is-expanded-stack-member" : ""
              }`}
              style={
                colorLabel
                  ? ({
                      "--storyboard-color-label": storyboardColorValues[colorLabel],
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
                  priority={index}
                  onSelectFrame={(event) => onSelectShot(event, shot, true)}
                  onToggleStack={() => stack && setShotStackExpanded(shot.id, !stack.expanded)}
                  onSetRating={(nextRating) => setShotRatings(targetShotIds(), nextRating)}
                  onSetFlag={(nextFlag) => setShotFlags(targetShotIds(), nextFlag)}
                  onOpenFlagMenu={(event) => onOpenAnnotationMenu(event, shot.id, "flag")}
                  onOpenColorMenu={(event) => onOpenAnnotationMenu(event, shot.id, "color")}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
