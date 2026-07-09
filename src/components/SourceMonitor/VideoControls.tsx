import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { formatMonitorTime, parseMonitorTime } from "../../time";
import { clampTimelineStart, frameDurationUs } from "../../timeline";
import { SelectDropdown, type SelectDropdownItem } from "../SelectDropdown";
import { useSourceMonitorState, type MonitorZoomLevel } from "./sourceMonitorState";

const baseZoomPercentOptions = [10, 25, 50, 75, 100, 150, 200, 400, 800, 1600] as const;
const TIMECODE_SCRUB_LONG_PRESS_MS = 220;
const TIMECODE_SCRUB_PX_PER_FRAME = 6;
const WHEEL_LINE_DELTA_PX = 16;
const WHEEL_PAGE_DELTA_PX = 800;
const MONITOR_RANGE_ZOOM_SENSITIVITY = 0.00035;
const MONITOR_RANGE_SCROLL_SENSITIVITY = 1 / 5000;

type PreviewMode = "source" | "proxy";

interface TimecodeScrubState {
  pointerId: number;
  startX: number;
  startTimeUs: number;
  lastFrameOffset: number;
  longPressTimer: number | null;
  isScrubbing: boolean;
  suppressClick: boolean;
}

interface VideoControlsProps {
  mediaKey: string;
  hasMedia: boolean;
  currentTimeUs: number;
  durationUs: number;
  frameRate: number;
  timelineStartUs: number;
  timelineSpanUs: number;
  minTimelineSpanUs: number;
  isPlaying: boolean;
  previewMode: PreviewMode;
  previewModeOptions: readonly PreviewMode[];
  previewModeLabels: Record<PreviewMode, string>;
  onSeekUs: (timeUs: number) => number;
  onPlaybackTimeRequest: () => number;
  onPauseForPreciseSeek: () => void;
  onTimelineStartUsChange: (startUs: number) => void;
  onTimelineSpanUsChange: (spanUs: number) => void;
  onStepFrame: (direction: -1 | 1) => void;
  onTogglePlayback: () => void;
  onPreviewModeChange: (value: PreviewMode) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function wheelDeltaPx(event: WheelEvent) {
  const modeMultiplier =
    event.deltaMode === 1 ? WHEEL_LINE_DELTA_PX : event.deltaMode === 2 ? WHEEL_PAGE_DELTA_PX : 1;
  const deltaX = event.deltaX * modeMultiplier;
  const deltaY = event.deltaY * modeMultiplier;
  return Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
}

export function VideoControls({
  mediaKey,
  hasMedia,
  currentTimeUs,
  durationUs,
  frameRate,
  timelineStartUs,
  timelineSpanUs,
  minTimelineSpanUs,
  isPlaying,
  previewMode,
  previewModeOptions,
  previewModeLabels,
  onSeekUs,
  onPlaybackTimeRequest,
  onPauseForPreciseSeek,
  onTimelineStartUsChange,
  onTimelineSpanUsChange,
  onStepFrame,
  onTogglePlayback,
  onPreviewModeChange,
}: VideoControlsProps) {
  const zoomLevel = useSourceMonitorState((state) => state.zoomLevel);
  const setZoomLevel = useSourceMonitorState((state) => state.setZoomLevel);
  const setZoomOrigin = useSourceMonitorState((state) => state.setZoomOrigin);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const timeEditorRef = useRef<HTMLSpanElement | null>(null);
  const timecodeScrubRef = useRef<TimecodeScrubState | null>(null);
  const suppressTimeEditClickRef = useRef(false);
  const timelineStartUsRef = useRef(timelineStartUs);
  const timelineSpanUsRef = useRef(timelineSpanUs);
  const [editingTime, setEditingTime] = useState(false);
  const [timeEditSelection, setTimeEditSelection] = useState<"all" | "cursor">("cursor");
  const [timeDraft, setTimeDraft] = useState("");

  const frameUs = frameDurationUs(frameRate);
  const monitorTimeText = hasMedia ? formatMonitorTime(currentTimeUs, frameRate) : "00:00:00:00";
  const monitorDurationText = hasMedia ? formatMonitorTime(durationUs, frameRate) : "00:00:00:00";
  const monitorTimeColumnCh = Math.max(11, monitorTimeText.length, monitorDurationText.length);
  const monitorTimeStyle = { "--monitor-time-ch": monitorTimeColumnCh } as CSSProperties;

  useEffect(() => {
    timelineStartUsRef.current = timelineStartUs;
  }, [timelineStartUs]);

  useEffect(() => {
    timelineSpanUsRef.current = timelineSpanUs;
  }, [timelineSpanUs]);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      handleTimelineViewportWheel(event);
    };

    row.addEventListener("wheel", handleWheel, { passive: false });
    return () => row.removeEventListener("wheel", handleWheel);
  }, [durationUs, hasMedia, minTimelineSpanUs]);

  useEffect(() => {
    if (!editingTime) {
      return;
    }
    const editor = timeEditorRef.current;
    if (!editor) {
      return;
    }
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    if (timeEditSelection === "cursor") {
      range.collapse(false);
    }
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [editingTime, timeEditSelection]);

  useEffect(() => {
    clearTimecodeScrubTimer();
    timecodeScrubRef.current = null;
    setEditingTime(false);
  }, [mediaKey]);

  useEffect(
    () => () => {
      clearTimecodeScrubTimer();
    },
    [],
  );

  function shiftTimeline(deltaUs: number) {
    if (!hasMedia || durationUs <= 0) {
      return;
    }
    const currentStart = timelineStartUsRef.current;
    const currentSpan = timelineSpanUsRef.current;
    const nextStart = clampTimelineStart(currentStart + deltaUs, currentSpan, durationUs);
    timelineStartUsRef.current = nextStart;
    onTimelineStartUsChange(nextStart);
  }

  function resizeTimeline(deltaPx: number, anchorRatio = 0.5) {
    if (!hasMedia || durationUs <= 0) {
      return;
    }
    const currentStart = timelineStartUsRef.current;
    const currentSpan = timelineSpanUsRef.current;
    const scale = Math.exp(clamp(deltaPx, -1200, 1200) * MONITOR_RANGE_ZOOM_SENSITIVITY);
    const nextSpan = clamp(currentSpan * scale, minTimelineSpanUs, durationUs);
    const anchorUs = currentStart + currentSpan * anchorRatio;
    const nextStart = clampTimelineStart(anchorUs - nextSpan * anchorRatio, nextSpan, durationUs);

    timelineSpanUsRef.current = nextSpan;
    timelineStartUsRef.current = nextStart;
    onTimelineSpanUsChange(nextSpan);
    onTimelineStartUsChange(nextStart);
  }

  function handleTimelineViewportWheel(event: WheelEvent) {
    if (!hasMedia) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const delta = wheelDeltaPx(event);
    if (event.altKey) {
      shiftTimeline(delta * timelineSpanUsRef.current * MONITOR_RANGE_SCROLL_SENSITIVITY);
      return;
    }
    resizeTimeline(delta);
  }

  function clearTimecodeScrubTimer(state = timecodeScrubRef.current) {
    if (!state || state.longPressTimer === null) {
      return;
    }
    window.clearTimeout(state.longPressTimer);
    state.longPressTimer = null;
  }

  function startTimecodeScrub(event: PointerEvent<HTMLButtonElement>) {
    if (!hasMedia || event.button !== 0) {
      return;
    }
    clearTimecodeScrubTimer();
    const state: TimecodeScrubState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startTimeUs: onPlaybackTimeRequest(),
      lastFrameOffset: 0,
      longPressTimer: null,
      isScrubbing: false,
      suppressClick: false,
    };

    state.longPressTimer = window.setTimeout(() => {
      if (timecodeScrubRef.current !== state) {
        return;
      }
      state.isScrubbing = true;
      state.suppressClick = true;
      onPauseForPreciseSeek();
    }, TIMECODE_SCRUB_LONG_PRESS_MS);

    timecodeScrubRef.current = state;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail if the element is detached before the press settles.
    }
  }

  function updateTimecodeScrub(event: PointerEvent<HTMLButtonElement>) {
    const state = timecodeScrubRef.current;
    if (!state || state.pointerId !== event.pointerId || !state.isScrubbing) {
      return;
    }
    event.preventDefault();
    const frameOffset = Math.trunc((event.clientX - state.startX) / TIMECODE_SCRUB_PX_PER_FRAME);
    if (frameOffset === state.lastFrameOffset) {
      return;
    }
    state.lastFrameOffset = frameOffset;
    onSeekUs(state.startTimeUs + frameOffset * frameUs);
  }

  function finishTimecodeScrub(event: PointerEvent<HTMLButtonElement>) {
    const state = timecodeScrubRef.current;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }
    clearTimecodeScrubTimer(state);
    if (state.isScrubbing || state.suppressClick) {
      suppressTimeEditClickRef.current = true;
      event.preventDefault();
    }
    try {
      if (event.currentTarget.hasPointerCapture(state.pointerId)) {
        event.currentTarget.releasePointerCapture(state.pointerId);
      }
    } catch {
      // Ignore pointer capture cleanup after cancellation.
    }
    timecodeScrubRef.current = null;
  }

  function handleTimecodeClick(event: MouseEvent<HTMLButtonElement>) {
    if (suppressTimeEditClickRef.current) {
      suppressTimeEditClickRef.current = false;
      event.preventDefault();
      return;
    }
    beginTimeEdit("all");
  }

  function beginTimeEdit(selection: "all" | "cursor") {
    if (!hasMedia) {
      return;
    }
    setTimeDraft(formatMonitorTime(currentTimeUs, frameRate));
    setTimeEditSelection(selection);
    setEditingTime(true);
  }

  function placeTimeCaret(clientX: number, clientY: number) {
    const editor = timeEditorRef.current;
    if (!editor) {
      return;
    }

    const documentWithCaret = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
    };
    const selection = window.getSelection();
    let range = documentWithCaret.caretRangeFromPoint?.(clientX, clientY) ?? null;
    if (!range && documentWithCaret.caretPositionFromPoint) {
      const position = documentWithCaret.caretPositionFromPoint(clientX, clientY);
      if (position) {
        range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
      }
    }
    if (!range || !editor.contains(range.startContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    } else {
      range.collapse(true);
    }
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function selectTimeEditorText() {
    const editor = timeEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection) {
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function commitTimeEdit() {
    const value = timeEditorRef.current?.textContent ?? timeDraft;
    const parsed = parseMonitorTime(value, frameRate);
    if (parsed !== null && parsed >= 0 && (durationUs <= 0 || parsed <= durationUs)) {
      onSeekUs(parsed);
    }
    setEditingTime(false);
  }

  function cancelTimeEdit() {
    setTimeDraft(formatMonitorTime(currentTimeUs, frameRate));
    setEditingTime(false);
  }

  function handleTimeEditorKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitTimeEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelTimeEdit();
    }
  }

  function handleTimeEditorClick(event: MouseEvent<HTMLSpanElement>) {
    setTimeEditSelection("cursor");
    requestAnimationFrame(() => placeTimeCaret(event.clientX, event.clientY));
  }

  function handleTimeEditorDoubleClick(event: MouseEvent<HTMLSpanElement>) {
    event.preventDefault();
    setTimeEditSelection("all");
    requestAnimationFrame(selectTimeEditorText);
  }

  function changeZoomLevel(value: string) {
    if (value === "fit") {
      setZoomLevel("fit");
      setZoomOrigin({ x: 50, y: 50 });
      return;
    }
    setZoomLevel(Number(value));
  }

  const zoomOptions = ["fit", ...baseZoomPercentOptions] as MonitorZoomLevel[];
  const zoomValue = zoomLevel === "fit" ? "fit" : String(zoomLevel);
  const zoomLabel = zoomLevel === "fit" ? "适合" : `${zoomLevel}%`;
  const zoomItems: Array<SelectDropdownItem<string>> = zoomOptions.map((value) => ({
    type: "option",
    value: String(value),
    label: value === "fit" ? "适合" : `${value}%`,
  }));
  const fitZoomItemIndex = zoomItems.findIndex(
    (item) => item.type === "option" && item.value === "fit",
  );
  if (fitZoomItemIndex >= 0) {
    zoomItems.splice(fitZoomItemIndex + 1, 0, { type: "separator" });
  }
  const previewModeItems: Array<SelectDropdownItem<PreviewMode>> = previewModeOptions.map(
    (value) => ({
      type: "option",
      value,
      label: previewModeLabels[value],
    }),
  );

  return (
    <div
      ref={rowRef}
      className={`source-control-row ${hasMedia ? "" : "empty-state"}`}
      style={monitorTimeStyle}
    >
      {editingTime && hasMedia ? (
        <span
          ref={timeEditorRef}
          className="monitor-time monitor-time-editor"
          role="textbox"
          tabIndex={0}
          contentEditable
          suppressContentEditableWarning
          autoFocus
          onBlur={commitTimeEdit}
          onKeyDown={handleTimeEditorKeyDown}
          onClick={handleTimeEditorClick}
          onDoubleClick={handleTimeEditorDoubleClick}
        >
          {timeDraft}
        </span>
      ) : (
        <button
          className="monitor-time"
          disabled={!hasMedia}
          onClick={handleTimecodeClick}
          onPointerDown={startTimecodeScrub}
          onPointerMove={updateTimecodeScrub}
          onPointerUp={finishTimecodeScrub}
          onPointerCancel={finishTimecodeScrub}
          onLostPointerCapture={finishTimecodeScrub}
        >
          {monitorTimeText}
        </button>
      )}
      {hasMedia && (
        <SelectDropdown
          className="monitor-select"
          menuClassName="monitor-select-menu"
          value={zoomValue}
          selectedLabel={zoomLabel}
          items={zoomItems}
          onChange={changeZoomLevel}
        />
      )}
      <div className="transport-controls">
        <button onClick={() => onStepFrame(-1)} title="上一帧" disabled={!hasMedia}>
          <span className="transport-icon step-left" />
        </button>
        <button onClick={onTogglePlayback} title={isPlaying ? "暂停" : "播放"} disabled={!hasMedia}>
          <span className={`transport-icon ${isPlaying ? "stop" : "play"}`} />
        </button>
        <button onClick={() => onStepFrame(1)} title="下一帧" disabled={!hasMedia}>
          <span className="transport-icon step-right" />
        </button>
      </div>
      {hasMedia && (
        <SelectDropdown
          className="monitor-select"
          menuClassName="monitor-select-menu"
          value={previewMode}
          items={previewModeItems}
          onChange={onPreviewModeChange}
        />
      )}
      <span className="monitor-duration">{monitorDurationText}</span>
    </div>
  );
}
