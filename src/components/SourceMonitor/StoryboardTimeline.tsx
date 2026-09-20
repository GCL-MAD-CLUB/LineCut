import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { formatMonitorFrame, parseMonitorFrame } from "../../core/editor/time";
import { timeUsToFrame } from "../../core/editor/timeline";
import {
  moveStoryboardCuts,
  removeStoryboardCuts,
  splitStoryboardShot,
  storyboardCutDeltaBounds,
} from "../../core/editor/storyboardCuts";
import { useProjectPort } from "../../systems/ProjectSystem";
import type { StoryboardShot, StoryboardShotAnnotation } from "../../types";
import { ModalDialog } from "../ModalDialog";
import {
  PopupMenu,
  PopupMenuItem,
  PopupMenuSeparator,
  useCloseOnOutsidePointer,
} from "../PopupMenu";
import { storyboardShotColorLabelValues } from "../StoryboardPanel/StoryboardColorLabelButtons";
import type { MonitorCueRange } from "./sourceMonitorState";
import { TimelineRuler, type TimelineRulerProps } from "./TimelineRuler";

interface StoryboardTimelineProps extends TimelineRulerProps {
  videoContext: string;
  frameRate: number;
  onCueRangeChange: (range: MonitorCueRange | null) => void;
  onPause: () => void;
  onPauseForInteraction: () => void;
  showStoryboardCuts: boolean;
  onShowStoryboardCutsChange: (show: boolean) => void;
  showTimelineTimecodes: boolean;
  onShowTimelineTimecodesChange: (show: boolean) => void;
}

interface CutDrag {
  pointerId: number;
  clientX: number;
  framesPerPixel: number;
  ids: Set<string>;
  min: number;
  max: number;
  appliedDelta: number;
  moved: boolean;
  additive: boolean;
  groupId: string;
}

const emptyShots: StoryboardShot[] = [];
const CUT_LABEL_HIT_AREA_PX = 18;
const CUT_CUSTOM_LABEL_COLOR = "#ffffff";
const CUT_NO_LABEL_COLOR = "#b8b8b8";

function storyboardCutColor(annotation: StoryboardShotAnnotation | undefined) {
  if (annotation?.customLabel?.trim()) {
    return CUT_CUSTOM_LABEL_COLOR;
  }
  if (!annotation?.colorLabel) {
    return CUT_NO_LABEL_COLOR;
  }
  return `color-mix(in srgb, ${storyboardShotColorLabelValues[annotation.colorLabel]} 68%, #9a9a9a)`;
}

export function StoryboardTimeline({
  videoContext,
  frameRate,
  onCueRangeChange,
  onPause,
  onPauseForInteraction,
  showStoryboardCuts,
  onShowStoryboardCutsChange,
  showTimelineTimecodes,
  onShowTimelineTimecodesChange,
  ...rulerProps
}: StoryboardTimelineProps) {
  const { storyboards, storyboardUpdated } = useProjectPort(["storyboards"], ["storyboardUpdated"]);
  const storyboard = storyboards[videoContext];
  const shots = storyboard?.shots ?? emptyShots;
  const cuts = shots.slice(1);
  const {
    currentFrame,
    cueRange,
    timelineStartFrame,
    timelineSpanFrames,
    durationFrames,
    hasMedia,
    onSeekFrame,
  } = rulerProps;
  const visibleSpan = Math.max(
    1,
    Math.min(durationFrames, timelineStartFrame + timelineSpanFrames) - timelineStartFrame,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<CutDrag | null>(null);
  const deselectionPointerRef = useRef<number | null>(null);
  const suppressDeselectionClickRef = useRef(false);
  const previousShotsRef = useRef(shots);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; cutId?: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const selectedCuts = cuts.filter((shot) => selectedIds.has(shot.id));
  const editingIndex = cuts.findIndex((shot) => shot.id === editingId);
  const editingCut = cuts[editingIndex];
  const editFrame = parseMonitorFrame(editValue, frameRate);
  const editBounds = editingCut ? storyboardCutDeltaBounds(shots, new Set([editingCut.id])) : null;
  const validEdit = Boolean(
    editingCut &&
    editFrame !== null &&
    editBounds &&
    editFrame >= editingCut.start_frame + editBounds.min &&
    editFrame <= editingCut.start_frame + editBounds.max,
  );
  const nextCut = cuts.find((shot) => shot.start_frame > currentFrame);
  const previousCut = [...cuts].reverse().find((shot) => shot.start_frame < currentFrame);
  const rangeCuts = cueRange
    ? cuts.filter(
        (shot) => shot.start_frame >= cueRange.startFrame && shot.start_frame <= cueRange.endFrame,
      )
    : [];
  const contextCut = cuts.find((shot) => shot.id === menu?.cutId);
  const menuEditCut = contextCut && selectedIds.has(contextCut.id) ? contextCut : selectedCuts[0];
  const canAdd =
    hasMedia &&
    shots.some((shot) => currentFrame > shot.start_frame && currentFrame <= shot.end_frame);

  useCloseOnOutsidePointer(Boolean(menu), () => setMenu(null), { ignorePopupMenuTargets: true });

  useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set(
        [...current].filter((id) => shots.slice(1).some((shot) => shot.id === id)),
      );
      return next.size === current.size ? current : next;
    });
    if (editingId && !shots.slice(1).some((shot) => shot.id === editingId)) setEditingId(null);
    const previous = previousShotsRef.current;
    previousShotsRef.current = shots;
    if (!cueRange || previous === shots) return;
    const oldFirst = previous.find((shot) => shot.start_frame === cueRange.startFrame);
    const oldLast = previous.find(
      (shot) => timeUsToFrame(shot.end_us, frameRate) === cueRange.endFrame,
    );
    if (!oldFirst || !oldLast) return;
    const first =
      shots.find((shot) => shot.id === oldFirst.id) ??
      shots.find(
        (shot) =>
          shot.start_frame <= oldFirst.start_frame && shot.end_frame >= oldFirst.start_frame,
      );
    const last =
      shots.find((shot) => shot.id === oldLast.id) ??
      shots.find(
        (shot) => shot.start_frame <= oldLast.end_frame && shot.end_frame >= oldLast.end_frame,
      );
    const nextRange =
      first && last
        ? { startFrame: first.start_frame, endFrame: timeUsToFrame(last.end_us, frameRate) }
        : null;
    if (
      !nextRange ||
      nextRange.startFrame !== cueRange.startFrame ||
      nextRange.endFrame !== cueRange.endFrame
    )
      onCueRangeChange(nextRange);
  }, [shots, editingId, cueRange, frameRate, onCueRangeChange]);

  function focusTimeline() {
    rootRef.current?.focus({ preventScroll: true });
  }

  function removeCuts(ids: Iterable<string>) {
    const removed = new Set(ids);
    setMenu(null);
    if (!removed.size) {
      focusTimeline();
      return;
    }
    onPause();
    storyboardUpdated(videoContext, "清除切点", (current) =>
      removeStoryboardCuts(current, removed),
    );
    setSelectedIds((current) => new Set([...current].filter((id) => !removed.has(id))));
    setMenu(null);
    focusTimeline();
  }

  function addCut() {
    if (!canAdd) return;
    onPause();
    const id = `shot:${crypto.randomUUID()}`;
    storyboardUpdated(videoContext, "添加切点", (current) =>
      splitStoryboardShot(current, currentFrame, frameRate, id),
    );
    setSelectedIds(new Set([id]));
    setMenu(null);
    focusTimeline();
  }

  function goToCut(shot: StoryboardShot | undefined) {
    if (!shot) return;
    onPause();
    onSeekFrame(shot.start_frame);
    setMenu(null);
    focusTimeline();
  }

  function openEditor(shot: StoryboardShot | undefined) {
    if (!shot) return;
    onPause();
    setEditingId(shot.id);
    setEditValue(formatMonitorFrame(shot.start_frame, frameRate));
    setSelectedIds(new Set([shot.id]));
    setMenu(null);
    onSeekFrame(shot.start_frame);
  }

  function closeEditor() {
    setEditingId(null);
    focusTimeline();
  }

  function confirmEdit() {
    if (!validEdit || !editingCut || editFrame === null) return;
    storyboardUpdated(videoContext, "编辑切点", (current) => {
      const cut = current.shots.find((shot) => shot.id === editingCut.id);
      return cut
        ? moveStoryboardCuts(current, new Set([cut.id]), editFrame - cut.start_frame, frameRate)
        : current;
    });
    onSeekFrame(editFrame);
    closeEditor();
  }

  function beginDrag(event: PointerEvent<HTMLButtonElement>, shot: StoryboardShot) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onPauseForInteraction();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const ids =
      additive || selectedIds.has(shot.id)
        ? new Set(selectedCuts.map((cut) => cut.id))
        : new Set<string>();
    ids.add(shot.id);
    setSelectedIds(ids);
    const width =
      event.currentTarget.closest(".monitor-timeline")?.getBoundingClientRect().width ?? 1;
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      framesPerPixel: visibleSpan / Math.max(1, width),
      ids,
      ...storyboardCutDeltaBounds(shots, ids),
      appliedDelta: 0,
      moved: false,
      additive,
      groupId: `cut-drag:${crypto.randomUUID()}`,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const distance = event.clientX - drag.clientX;
    if (!drag.moved && Math.abs(distance) < 3) return;
    drag.moved = true;
    const delta = Math.max(
      drag.min,
      Math.min(drag.max, Math.round(distance * drag.framesPerPixel)),
    );
    const change = delta - drag.appliedDelta;
    if (change === 0) return;
    storyboardUpdated(
      videoContext,
      "移动切点",
      (current) => moveStoryboardCuts(current, drag.ids, change, frameRate),
      drag.groupId,
    );
    drag.appliedDelta = delta;
  }

  function deselectFromLabelArea(event: PointerEvent<HTMLDivElement>) {
    if (
      !showStoryboardCuts ||
      event.button !== 0 ||
      selectedIds.size === 0 ||
      !(event.target instanceof Element)
    )
      return;
    if (event.target.closest(".storyboard-cut-marker")) return;
    const timeline = event.target.closest<HTMLElement>(".monitor-timeline.storyboard-mode");
    if (!timeline) return;
    const offsetY = event.clientY - timeline.getBoundingClientRect().top;
    if (offsetY < 0 || offsetY >= CUT_LABEL_HIT_AREA_PX) return;

    event.preventDefault();
    event.stopPropagation();
    deselectionPointerRef.current = event.pointerId;
    suppressDeselectionClickRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedIds(new Set());
  }

  function consumeDeselectionPointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (deselectionPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    deselectionPointerRef.current = null;
    window.setTimeout(() => {
      suppressDeselectionClickRef.current = false;
    }, 0);
  }

  function cancelDeselectionPointer(event: PointerEvent<HTMLDivElement>) {
    if (deselectionPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    deselectionPointerRef.current = null;
    suppressDeselectionClickRef.current = false;
  }

  function consumeDeselectionClick(event: MouseEvent<HTMLDivElement>) {
    if (!suppressDeselectionClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressDeselectionClickRef.current = false;
  }

  return (
    <div
      ref={rootRef}
      className="storyboard-timeline"
      tabIndex={-1}
      onPointerDownCapture={deselectFromLabelArea}
      onPointerUpCapture={consumeDeselectionPointerEnd}
      onPointerCancelCapture={cancelDeselectionPointer}
      onClickCapture={consumeDeselectionClick}
    >
      <TimelineRuler
        {...rulerProps}
        storyboardMode={showStoryboardCuts}
        showTimecodeLabels={showTimelineTimecodes}
        formatTimecodeLabel={(frame) => formatMonitorFrame(frame, frameRate)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!hasMedia) return;
          const cutId =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-cut-id]")?.dataset.cutId
              : undefined;
          setMenu({ x: event.clientX, y: event.clientY, cutId });
        }}
      >
        {hasMedia &&
          showStoryboardCuts &&
          cuts.map((shot) => {
            const position = (shot.start_frame - timelineStartFrame) / visibleSpan;
            if (position < 0 || position > 1) return null;
            const selected = selectedIds.has(shot.id);
            const color = storyboardCutColor(storyboard?.shotAnnotations[shot.id]);
            return (
              <button
                key={shot.id}
                type="button"
                data-cut-id={shot.id}
                className={`storyboard-cut-marker ${selected ? "selected" : ""} ${selectedCuts.length === 0 ? "unselected-all" : ""}`}
                style={
                  {
                    left: `${position * 100}%`,
                    "--storyboard-cut-color": color,
                  } as CSSProperties
                }
                title={`切点 @${formatMonitorFrame(shot.start_frame, frameRate)}`}
                aria-label={`切点 @${formatMonitorFrame(shot.start_frame, frameRate)}`}
                aria-pressed={selected}
                onPointerDown={(event) => beginDrag(event, shot)}
                onPointerMove={moveDrag}
                onPointerUp={(event) => {
                  const drag = dragRef.current;
                  if (!drag || event.pointerId !== drag.pointerId) return;
                  if (!drag.moved) {
                    if (!drag.additive) setSelectedIds(new Set([shot.id]));
                    onSeekFrame(shot.start_frame);
                  }
                  dragRef.current = null;
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onLostPointerCapture={() => {
                  dragRef.current = null;
                }}
                onPointerCancel={() => {
                  dragRef.current = null;
                }}
              >
                <svg viewBox="0 0 18 26" aria-hidden="true">
                  <path className="cut-outline" d="M2 2H16V16L9 24L2 16Z" />
                  <path className="cut-fill" d="M2 2H16V16L9 24L2 16Z" />
                </svg>
              </button>
            );
          })}
      </TimelineRuler>
      {menu &&
        createPortal(
          <PopupMenu
            className="storyboard-cut-menu"
            ariaLabel="切点菜单"
            contextMenuAnchor={menu}
            style={{ position: "fixed", left: menu.x, top: menu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <PopupMenuItem disabled={!canAdd} onSelect={addCut}>
              添加切点
            </PopupMenuItem>
            <PopupMenuItem disabled={!nextCut} onSelect={() => goToCut(nextCut)}>
              转到下一个切点
            </PopupMenuItem>
            <PopupMenuItem disabled={!previousCut} onSelect={() => goToCut(previousCut)}>
              转到上一个切点
            </PopupMenuItem>
            <PopupMenuSeparator />
            <PopupMenuItem
              disabled={!selectedCuts.length}
              onSelect={() => removeCuts(selectedCuts.map((shot) => shot.id))}
            >
              清除所选的切点
            </PopupMenuItem>
            <PopupMenuItem
              disabled={!cueRange}
              onSelect={() => removeCuts(rangeCuts.map((shot) => shot.id))}
            >
              清除切点
            </PopupMenuItem>
            <PopupMenuSeparator />
            <PopupMenuItem disabled={!selectedCuts.length} onSelect={() => openEditor(menuEditCut)}>
              编辑切点...
            </PopupMenuItem>
            <PopupMenuSeparator />
            <PopupMenuItem
              checked={showStoryboardCuts}
              onSelect={() => {
                const show = !showStoryboardCuts;
                onShowStoryboardCutsChange(show);
                if (!show) setSelectedIds(new Set());
                setMenu(null);
              }}
            >
              显示切点
            </PopupMenuItem>
            <PopupMenuItem
              checked={showTimelineTimecodes}
              onSelect={() => {
                onShowTimelineTimecodesChange(!showTimelineTimecodes);
                setMenu(null);
              }}
            >
              时间标尺数字
            </PopupMenuItem>
          </PopupMenu>,
          document.body,
        )}
      {editingCut &&
        createPortal(
          <ModalDialog
            className="storyboard-cut-dialog"
            title={`切点 @${formatMonitorFrame(editingCut.start_frame, frameRate)}`}
            onCancel={closeEditor}
            onConfirm={confirmEdit}
            actions={
              <>
                <button
                  type="button"
                  className="modal-dialog-confirm"
                  disabled={!validEdit}
                  onClick={confirmEdit}
                >
                  确定
                </button>
                <button type="button" className="modal-dialog-cancel" onClick={closeEditor}>
                  取消
                </button>
                <button
                  type="button"
                  className="modal-dialog-cancel"
                  disabled={editingIndex === 0}
                  onClick={() => openEditor(cuts[editingIndex - 1])}
                >
                  上一个
                </button>
                <button
                  type="button"
                  className="modal-dialog-cancel"
                  disabled={editingIndex === cuts.length - 1}
                  onClick={() => openEditor(cuts[editingIndex + 1])}
                >
                  下一个
                </button>
                <button
                  type="button"
                  className="modal-dialog-cancel"
                  onClick={() => {
                    const neighbor = cuts[editingIndex + 1] ?? cuts[editingIndex - 1];
                    removeCuts([editingCut.id]);
                    if (neighbor) openEditor(neighbor);
                    else closeEditor();
                  }}
                >
                  删除
                </button>
              </>
            }
          >
            <label className="cut-timecode-field">
              时间码
              <input
                key={editingId}
                autoFocus
                value={editValue}
                aria-label="切点时间码"
                aria-invalid={!validEdit}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setEditValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    confirmEdit();
                  }
                }}
              />
            </label>
            <p className="cut-timecode-help">
              {editBounds &&
                `范围：${formatMonitorFrame(editingCut.start_frame + editBounds.min, frameRate)} – ${formatMonitorFrame(editingCut.start_frame + editBounds.max, frameRate)}`}
            </p>
          </ModalDialog>,
          document.body,
        )}
    </div>
  );
}
