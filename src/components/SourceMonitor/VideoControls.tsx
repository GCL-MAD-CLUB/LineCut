import { ChevronDown } from "lucide-react";
import { useEffect, useRef } from "react";
import type {
  KeyboardEvent,
  MouseEvent,
  PointerEventHandler,
  RefObject,
} from "react";

type ZoomLevel = "fit" | number;

interface VideoControlsProps {
  timeEditorRef: RefObject<HTMLSpanElement | null>;
  hasMedia: boolean;
  editingTime: boolean;
  timeDraft: string;
  monitorTimeText: string;
  monitorDurationText: string;
  zoomLevel: ZoomLevel;
  isCustomZoom: boolean;
  zoomOptions: ZoomLevel[];
  isPlaying: boolean;
  resolutionLevel: string;
  resolutionOptions: readonly string[];
  resolutionLabels: Record<string, string>;
  onCommitTimeEdit: () => void;
  onCancelTimeEdit: () => void;
  onSetTimeEditSelection: (selection: "all" | "cursor") => void;
  onPlaceTimeCaret: (clientX: number, clientY: number) => void;
  onSelectTimeEditorText: () => void;
  onTimecodeClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onTimecodePointerDown: PointerEventHandler<HTMLButtonElement>;
  onTimecodePointerMove: PointerEventHandler<HTMLButtonElement>;
  onTimecodePointerUp: PointerEventHandler<HTMLButtonElement>;
  onTimecodePointerCancel: PointerEventHandler<HTMLButtonElement>;
  onZoomLevelChange: (value: string) => void;
  onStepFrame: (direction: -1 | 1) => void;
  onTogglePlayback: () => void;
  onResolutionLevelChange: (value: string) => void;
  onWheel: (event: WheelEvent) => void;
}

export function VideoControls({
  timeEditorRef,
  hasMedia,
  editingTime,
  timeDraft,
  monitorTimeText,
  monitorDurationText,
  zoomLevel,
  isCustomZoom,
  zoomOptions,
  isPlaying,
  resolutionLevel,
  resolutionOptions,
  resolutionLabels,
  onCommitTimeEdit,
  onCancelTimeEdit,
  onSetTimeEditSelection,
  onPlaceTimeCaret,
  onSelectTimeEditorText,
  onTimecodeClick,
  onTimecodePointerDown,
  onTimecodePointerMove,
  onTimecodePointerUp,
  onTimecodePointerCancel,
  onZoomLevelChange,
  onStepFrame,
  onTogglePlayback,
  onResolutionLevelChange,
  onWheel,
}: VideoControlsProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      onWheel(event);
    };

    row.addEventListener("wheel", handleWheel, { passive: false });
    return () => row.removeEventListener("wheel", handleWheel);
  }, [onWheel]);

  function handleTimeEditorKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      onCommitTimeEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancelTimeEdit();
    }
  }

  function handleTimeEditorClick(event: MouseEvent<HTMLSpanElement>) {
    onSetTimeEditSelection("cursor");
    requestAnimationFrame(() => onPlaceTimeCaret(event.clientX, event.clientY));
  }

  function handleTimeEditorDoubleClick(event: MouseEvent<HTMLSpanElement>) {
    event.preventDefault();
    onSetTimeEditSelection("all");
    requestAnimationFrame(onSelectTimeEditorText);
  }

  return (
    <div ref={rowRef} className={`source-control-row ${hasMedia ? "" : "empty-state"}`}>
      {editingTime && hasMedia ? (
        <span
          ref={timeEditorRef}
          className="monitor-time monitor-time-editor"
          role="textbox"
          tabIndex={0}
          contentEditable
          suppressContentEditableWarning
          autoFocus
          onBlur={onCommitTimeEdit}
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
          onClick={onTimecodeClick}
          onPointerDown={onTimecodePointerDown}
          onPointerMove={onTimecodePointerMove}
          onPointerUp={onTimecodePointerUp}
          onPointerCancel={onTimecodePointerCancel}
          onLostPointerCapture={onTimecodePointerCancel}
        >
          {monitorTimeText}
        </button>
      )}
      {hasMedia && (
        <label className="monitor-select">
          <select
            value={zoomLevel === "fit" ? "fit" : String(zoomLevel)}
            onChange={(event) => onZoomLevelChange(event.currentTarget.value)}
          >
            {isCustomZoom && (
              <option value={zoomLevel} hidden>
                {zoomLevel}%
              </option>
            )}
            {zoomOptions.map((value) => (
              <option key={value} value={value}>
                {value === "fit" ? "适合" : `${value}%`}
              </option>
            ))}
          </select>
          <ChevronDown size={18} />
        </label>
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
        <label className="monitor-select">
          <select value={resolutionLevel} onChange={(event) => onResolutionLevelChange(event.currentTarget.value)}>
            {resolutionOptions.map((value) => (
              <option key={value} value={value}>
                {resolutionLabels[value]}
              </option>
            ))}
          </select>
          <ChevronDown size={18} />
        </label>
      )}
      <span className="monitor-duration">{monitorDurationText}</span>
    </div>
  );
}
