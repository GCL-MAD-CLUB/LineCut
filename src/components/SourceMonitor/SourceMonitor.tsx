import { convertFileSrc } from "@tauri-apps/api/core";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { flushSync } from "react-dom";
import { useAppEvent } from "../../appEvents";
import { useAppStore } from "../../store";
import { formatMonitorTime, parseMonitorTime, snapMonitorTime } from "../../time";
import {
  buildTimelineRuler,
  clampTimelineStart,
  frameDurationUs,
  minTimelineSpanUs,
  normalizeFrameRate,
} from "../../timeline";
import { MonitorRange } from "./MonitorRange";
import "./SourceMonitor.css";
import { TimelineRuler } from "./TimelineRuler";
import { getTaskProgressStatus } from "../TaskProgress";
import { VideoControls } from "./VideoControls";
import { VideoDisplay } from "./VideoDisplay";
import { useSourceMonitorState } from "./sourceMonitorState";

const baseZoomPercentOptions = [10, 25, 50, 75, 100, 150, 200, 400, 800, 1600] as const;
const TIMECODE_SCRUB_LONG_PRESS_MS = 220;
const TIMECODE_SCRUB_PX_PER_FRAME = 6;
const WHEEL_LINE_DELTA_PX = 16;
const WHEEL_PAGE_DELTA_PX = 800;
const MONITOR_RANGE_ZOOM_SENSITIVITY = 0.00035;
const MONITOR_RANGE_SCROLL_SENSITIVITY = 1 / 5000;
const TIMELINE_CURSOR_EDGE_INSET_PX = 6;
const TIMELINE_EDGE_SCROLL_BASE_SPANS_PER_SECOND = 0.2;
const TIMELINE_EDGE_SCROLL_MAX_SPANS_PER_SECOND = 1.2;
const previewModeOptions = ["source", "proxy"] as const;
const previewModeLabels: Record<(typeof previewModeOptions)[number], string> = {
  source: "完整",
  proxy: "代理",
};
type PreviewMode = (typeof previewModeOptions)[number];

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function mapLogicalRangeRatio(
  logicalRatio: number,
  minLogicalRatio: number,
  minVisualRatio: number,
) {
  if (minLogicalRatio <= 0 || minLogicalRatio >= 1 || minVisualRatio >= 1) {
    return clamp(logicalRatio, 0, 1);
  }
  const normalized =
    Math.log(clamp(logicalRatio, minLogicalRatio, 1) / minLogicalRatio) /
    Math.log(1 / minLogicalRatio);
  return minVisualRatio + normalized * (1 - minVisualRatio);
}

function mapVisualRangeRatio(visualRatio: number, minLogicalRatio: number, minVisualRatio: number) {
  if (minLogicalRatio <= 0 || minLogicalRatio >= 1 || minVisualRatio >= 1) {
    return clamp(visualRatio, 0, 1);
  }
  const normalized = clamp((visualRatio - minVisualRatio) / (1 - minVisualRatio), 0, 1);
  return minLogicalRatio * Math.exp(normalized * Math.log(1 / minLogicalRatio));
}

interface TimecodeScrubState {
  pointerId: number;
  startX: number;
  startTimeUs: number;
  lastFrameOffset: number;
  longPressTimer: number | null;
  isScrubbing: boolean;
  suppressClick: boolean;
}

export function SourceMonitor() {
  const project = useAppStore((state) => state.project);
  const proxyPath = useAppStore((state) => state.proxyPath);
  const useProxy = useAppStore((state) => state.useProxy);
  const setMessage = useAppStore((state) => state.actions.messagePublished);
  const sourcePreviewSelected = useAppStore((state) => state.actions.sourcePreviewSelected);
  const proxyPreviewSelected = useAppStore((state) => state.actions.proxyPreviewSelected);
  const proxyDialogOpened = useAppStore((state) => state.actions.proxyDialogOpened);
  const { isRunning: isGeneratingProxy } = getTaskProgressStatus("proxy");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sourceMonitorRef = useRef<HTMLDivElement | null>(null);
  const videoStageRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const rangeRef = useRef<HTMLDivElement | null>(null);
  const timeEditorRef = useRef<HTMLSpanElement | null>(null);
  const timecodeScrubRef = useRef<TimecodeScrubState | null>(null);
  const suppressTimeEditClickRef = useRef(false);
  const seekTargetUsRef = useRef(0);
  const lastSeekCommandAtRef = useRef(0);
  const playbackTickRef = useRef<number | null>(null);
  const cuePlaybackEndUsRef = useRef<number | null>(null);
  const timelineDragScrollAtRef = useRef(0);
  const currentTimeUs = useSourceMonitorState((state) => state.currentTimeUs);
  const setCurrentTimeUs = useSourceMonitorState((state) => state.setCurrentTimeUs);
  const zoomLevel = useSourceMonitorState((state) => state.zoomLevel);
  const setZoomLevel = useSourceMonitorState((state) => state.setZoomLevel);
  const zoomOrigin = useSourceMonitorState((state) => state.zoomOrigin);
  const setZoomOrigin = useSourceMonitorState((state) => state.setZoomOrigin);
  const timelineStartUs = useSourceMonitorState((state) => state.timelineStartUs);
  const setTimelineStartUs = useSourceMonitorState((state) => state.setTimelineStartUs);
  const timelineSpanUs = useSourceMonitorState((state) => state.timelineSpanUs);
  const setTimelineSpanUs = useSourceMonitorState((state) => state.setTimelineSpanUs);
  const cueRange = useSourceMonitorState((state) => state.cueRange);
  const setCueRange = useSourceMonitorState((state) => state.setCueRange);
  const storedMediaKey = useSourceMonitorState((state) => state.mediaKey);
  const syncMedia = useSourceMonitorState((state) => state.syncMedia);
  const timelineStartUsRef = useRef(timelineStartUs);
  const timelineSpanUsRef = useRef(timelineSpanUs);
  const [videoStageSize, setVideoStageSize] = useState({ width: 0, height: 0 });
  const [videoNaturalSize, setVideoNaturalSize] = useState({ width: 0, height: 0 });
  const [isPlaying, setIsPlaying] = useState(false);
  const [editingTime, setEditingTime] = useState(false);
  const [timeEditSelection, setTimeEditSelection] = useState<"all" | "cursor">("cursor");
  const [timeDraft, setTimeDraft] = useState("");
  const [timelineWidthPx, setTimelineWidthPx] = useState(0);
  const [rangeWidthPx, setRangeWidthPx] = useState(0);
  const [rangeMinBarWidthPx, setRangeMinBarWidthPx] = useState(0);
  const [activeRangeHandle, setActiveRangeHandle] = useState<"start" | "end" | "both" | null>(null);

  const hasMedia = Boolean(project);
  const durationUs = project?.asset.duration_us ?? 0;
  const videoStream = useMemo(() => {
    if (!project) {
      return null;
    }
    return (
      project.streams.find((stream) => stream.index === project.asset.video_stream_index) ??
      project.streams.find((stream) => stream.codec_type === "video") ??
      null
    );
  }, [project]);
  const frameRate = useMemo(
    () => normalizeFrameRate(videoStream?.avg_frame_rate, videoStream?.r_frame_rate),
    [videoStream?.avg_frame_rate, videoStream?.r_frame_rate],
  );
  const frameUs = frameDurationUs(frameRate);
  const trueMinTimelineSpanUs =
    durationUs > 0 ? minTimelineSpanUs(Math.max(1, timelineWidthPx), frameRate, durationUs) : 0;
  const videoSrc = useMemo(() => {
    if (!project) {
      return "";
    }
    const path = useProxy ? proxyPath : project.asset.path;
    return path ? convertFileSrc(path) : "";
  }, [project, proxyPath, useProxy]);
  const timelineEndUs = Math.min(durationUs, timelineStartUs + timelineSpanUs);
  const timelineVisibleSpanUs = Math.max(1, timelineEndUs - timelineStartUs);
  const currentTimeClampedUs = clamp(currentTimeUs, 0, durationUs || currentTimeUs);
  const cursorPercent =
    currentTimeClampedUs >= timelineStartUs && currentTimeClampedUs <= timelineEndUs
      ? ((currentTimeClampedUs - timelineStartUs) / timelineVisibleSpanUs) * 100
      : null;
  const cueRangePercent = cueRange
    ? {
        start: ((cueRange.startUs - timelineStartUs) / timelineVisibleSpanUs) * 100,
        end: ((cueRange.endUs - timelineStartUs) / timelineVisibleSpanUs) * 100,
      }
    : null;
  const indicatorWidthRatio = rangeWidthRatioForSpan(timelineVisibleSpanUs);
  const indicatorLeftRatio = rangeLeftRatioForStart(timelineStartUs, timelineVisibleSpanUs);
  const indicatorWidthPercent = indicatorWidthRatio * 100;
  const indicatorLeftPercent = indicatorLeftRatio * 100;
  const zoomScale = zoomLevel === "fit" ? 1 : zoomLevel / 100;
  const fittedVideoSize = useMemo(() => {
    if (
      videoStageSize.width <= 0 ||
      videoStageSize.height <= 0 ||
      videoNaturalSize.width <= 0 ||
      videoNaturalSize.height <= 0
    ) {
      return null;
    }

    const scale = Math.min(
      videoStageSize.width / videoNaturalSize.width,
      videoStageSize.height / videoNaturalSize.height,
    );

    return {
      width: Math.max(1, Math.floor(videoNaturalSize.width * scale)),
      height: Math.max(1, Math.floor(videoNaturalSize.height * scale)),
    };
  }, [
    videoNaturalSize.height,
    videoNaturalSize.width,
    videoStageSize.height,
    videoStageSize.width,
  ]);
  const zoomOptions = useMemo(
    () => ["fit", ...baseZoomPercentOptions] as Array<"fit" | number>,
    [],
  );
  const timelineRuler = useMemo(
    () =>
      buildTimelineRuler({
        startUs: timelineStartUs,
        spanUs: timelineVisibleSpanUs,
        durationUs,
        widthPx: timelineWidthPx,
        frameRate,
      }),
    [durationUs, frameRate, timelineStartUs, timelineVisibleSpanUs, timelineWidthPx],
  );
  const monitorTimeText = hasMedia ? formatMonitorTime(currentTimeUs, frameRate) : "00:00:00:00";
  const monitorDurationText = hasMedia ? formatMonitorTime(durationUs, frameRate) : "00:00:00:00";
  const monitorTimeColumnCh = Math.max(11, monitorTimeText.length, monitorDurationText.length);
  const monitorTimeStyle = { "--monitor-time-ch": monitorTimeColumnCh } as CSSProperties;
  const mediaKey = project
    ? `${project.asset.id}:${durationUs}:${frameRate}`
    : `empty:${frameRate}`;

  useLayoutEffect(() => {
    const mediaChanged = storedMediaKey !== mediaKey;
    const nextSpan = durationUs > 0 ? durationUs : 60_000_000;
    syncMedia(mediaKey, durationUs);
    seekTargetUsRef.current = mediaChanged ? 0 : currentTimeUs;
    timelineStartUsRef.current = mediaChanged ? 0 : timelineStartUs;
    timelineSpanUsRef.current = mediaChanged ? nextSpan : timelineSpanUs;
    cuePlaybackEndUsRef.current = null;
    setIsPlaying(false);
    setEditingTime(false);
    setVideoNaturalSize({ width: 0, height: 0 });
    setActiveRangeHandle(null);
  }, [mediaKey]);

  useEffect(() => {
    timelineStartUsRef.current = timelineStartUs;
  }, [timelineStartUs]);

  useEffect(() => {
    timelineSpanUsRef.current = timelineSpanUs;
  }, [timelineSpanUs]);

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

  useEffect(
    () => () => {
      if (playbackTickRef.current !== null) {
        cancelAnimationFrame(playbackTickRef.current);
      }
      clearTimecodeScrubTimer();
    },
    [],
  );

  useEffect(() => {
    const element = videoStageRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setVideoStageSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    setVideoNaturalSize({ width: 0, height: 0 });
  }, [videoSrc]);

  useEffect(() => {
    const element = timelineRef.current;
    if (!element) {
      return;
    }

    const updateWidth = () => setTimelineWidthPx(element.getBoundingClientRect().width);
    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const element = rangeRef.current;
    if (!element) {
      return;
    }
    const minWidthProbe = element.querySelector<HTMLElement>(".monitor-range-min-width-probe");

    const updateWidth = () => {
      setRangeWidthPx(element.getBoundingClientRect().width);
      setRangeMinBarWidthPx(minWidthProbe?.getBoundingClientRect().width ?? 0);
    };
    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(element);
    if (minWidthProbe) {
      resizeObserver.observe(minWidthProbe);
    }
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    if (durationUs <= 0) {
      return;
    }
    setTimelineSpanUs((current) => {
      const next = clamp(current, trueMinTimelineSpanUs, durationUs);
      setTimelineStartUs((start) => clampTimelineStart(start, next, durationUs));
      return next;
    });
    setCurrentTimeUs((current) => clamp(current, 0, durationUs));
  }, [durationUs, trueMinTimelineSpanUs]);

  useAppEvent("monitor:seek", (detail) => {
    if (!hasMedia) {
      return;
    }
    if (detail.focusEndUs !== undefined) {
      const rangeStartUs = snapUsToFrame(
        clamp(Math.min(detail.timeUs, detail.focusEndUs), 0, durationUs),
      );
      const rangeEndUs = snapUsToFrame(
        clamp(Math.max(detail.timeUs, detail.focusEndUs), rangeStartUs, durationUs),
      );
      setCueRange({ startUs: rangeStartUs, endUs: rangeEndUs });
      centerTimelineOnTime(rangeStartUs);
      cuePlaybackEndUsRef.current = snapUsToFrame(rangeEndUs);
    }
    seekToUs(detail.timeUs, detail.focusEndUs !== undefined);
    void videoRef.current?.play();
  });

  useEffect(() => {
    const isSourceMonitorVisible = () => {
      const element = sourceMonitorRef.current;
      if (!element) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const suppressSpaceEvent = (event: KeyboardEvent) => {
      if ((event.code !== "Space" && event.key !== " ") || !isSourceMonitorVisible()) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return true;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const isFrameStep = event.key === "ArrowLeft" || event.key === "ArrowRight";
      const isPlaybackToggle = event.code === "Space" || event.key === " ";
      if (isPlaybackToggle) {
        if (suppressSpaceEvent(event) && !event.repeat && hasMedia) {
          togglePlayback();
        }
        return;
      }
      if (!isFrameStep) {
        return;
      }
      if (!hasMedia) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        editingTime ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      stepFrame(event.key === "ArrowLeft" ? -1 : 1);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      suppressSpaceEvent(event);
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [durationUs, editingTime, frameUs, hasMedia]);

  function changePreviewMode(value: PreviewMode) {
    if (value === "source") {
      sourcePreviewSelected();
      return;
    }
    if (!project || isGeneratingProxy) {
      return;
    }
    if (proxyPath) {
      proxyPreviewSelected();
      return;
    }
    sourcePreviewSelected();
    proxyDialogOpened();
  }

  function handleVideoError() {
    if (!useProxy && project) {
      if (proxyPath) {
        proxyPreviewSelected();
        setMessage("原文件无法直接播放，已切换到代理模式。");
      } else {
        proxyDialogOpened();
        setMessage("原文件无法直接播放，请创建代理后预览。");
      }
    }
  }

  function snapUsToFrame(valueUs: number) {
    const snappedUs = snapMonitorTime(valueUs, frameRate);
    return clamp(snappedUs, 0, durationUs || snappedUs);
  }

  function seekToUs(nextUs: number, preserveCuePlaybackEnd = false) {
    if (!preserveCuePlaybackEnd) {
      cuePlaybackEndUsRef.current = null;
    }
    const targetUs = snapUsToFrame(nextUs);
    seekTargetUsRef.current = targetUs;
    lastSeekCommandAtRef.current = performance.now();
    flushSync(() => setCurrentTimeUs(targetUs));
    if (videoRef.current) {
      try {
        videoRef.current.currentTime = targetUs / 1_000_000;
      } catch {
        // Ignore seek attempts before the media element is ready.
      }
    }
    return targetUs;
  }

  function centerTimelineOnTime(timeUs: number) {
    if (durationUs <= 0) {
      return;
    }
    const currentSpanUs = timelineSpanUsRef.current;
    const nextStartUs = clampTimelineStart(timeUs - currentSpanUs / 2, currentSpanUs, durationUs);
    timelineStartUsRef.current = nextStartUs;
    setTimelineStartUs(nextStartUs);
  }

  function centerTimelineIfTimeHidden(timeUs: number) {
    const currentStartUs = timelineStartUsRef.current;
    const currentSpanUs = timelineSpanUsRef.current;
    if (timeUs < currentStartUs || timeUs > currentStartUs + currentSpanUs) {
      centerTimelineOnTime(timeUs);
    }
  }

  function playbackTimeUs() {
    if (videoRef.current && Number.isFinite(videoRef.current.currentTime)) {
      return snapUsToFrame(videoRef.current.currentTime * 1_000_000);
    }
    return currentTimeUs;
  }

  function syncCurrentTimeFromVideo(element: HTMLVideoElement) {
    const nextUs = snapUsToFrame(element.currentTime * 1_000_000);
    const targetUs = seekTargetUsRef.current;
    const seekAgeMs = performance.now() - lastSeekCommandAtRef.current;
    const isStaleSeekEvent =
      (element.seeking || seekAgeMs < 500) && Math.abs(nextUs - targetUs) > frameUs / 2;
    if (isStaleSeekEvent) {
      return;
    }

    const cuePlaybackEndUs = cuePlaybackEndUsRef.current;
    if (cuePlaybackEndUs !== null) {
      const reachedCueEnd = element.currentTime * 1_000_000 >= cuePlaybackEndUs;
      centerTimelineIfTimeHidden(reachedCueEnd ? cuePlaybackEndUs : nextUs);
      if (reachedCueEnd) {
        cuePlaybackEndUsRef.current = null;
        seekToUs(cuePlaybackEndUs, true);
        element.pause();
        return;
      }
    }

    seekTargetUsRef.current = nextUs;
    setCurrentTimeUs(nextUs);
  }

  function stopPlaybackTicker() {
    if (playbackTickRef.current !== null) {
      cancelAnimationFrame(playbackTickRef.current);
      playbackTickRef.current = null;
    }
  }

  function startPlaybackTicker() {
    stopPlaybackTicker();
    const tick = () => {
      const video = videoRef.current;
      if (!video || video.paused || video.ended) {
        playbackTickRef.current = null;
        return;
      }
      syncCurrentTimeFromVideo(video);
      playbackTickRef.current = requestAnimationFrame(tick);
    };
    playbackTickRef.current = requestAnimationFrame(tick);
  }

  function updateVideoNaturalSize(element: HTMLVideoElement) {
    if (element.videoWidth <= 0 || element.videoHeight <= 0) {
      return;
    }
    setVideoNaturalSize((current) => {
      if (current.width === element.videoWidth && current.height === element.videoHeight) {
        return current;
      }
      return { width: element.videoWidth, height: element.videoHeight };
    });
  }

  function handleLoadedMetadata(element: HTMLVideoElement) {
    updateVideoNaturalSize(element);
    const restoredTimeUs = clamp(currentTimeUs, 0, durationUs || currentTimeUs);
    seekTargetUsRef.current = restoredTimeUs;
    if (Math.abs(element.currentTime * 1_000_000 - restoredTimeUs) > frameUs / 2) {
      element.currentTime = restoredTimeUs / 1_000_000;
    }
  }

  function togglePlayback() {
    if (!hasMedia || !videoRef.current) {
      return;
    }
    cuePlaybackEndUsRef.current = null;
    if (videoRef.current.paused) {
      void videoRef.current.play();
    } else {
      const pausedAtUs = playbackTimeUs();
      videoRef.current.pause();
      centerTimelineIfTimeHidden(pausedAtUs);
    }
  }

  function pausePlaybackForPreciseSeek() {
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }
  }

  function moveCursorByFrames(frameDelta: number, baseUs?: number) {
    if (!hasMedia || frameDelta === 0) {
      return;
    }
    pausePlaybackForPreciseSeek();
    const originUs =
      baseUs ??
      (Number.isFinite(seekTargetUsRef.current) ? seekTargetUsRef.current : playbackTimeUs());
    const currentFrame = Math.round(originUs / frameUs);
    seekToUs((currentFrame + frameDelta) * frameUs);
  }

  function stepFrame(direction: -1 | 1) {
    moveCursorByFrames(direction);
  }

  function wheelFrameDirection(event: globalThis.WheelEvent) {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) {
      return 0;
    }
    return delta > 0 ? 1 : -1;
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
      startTimeUs: playbackTimeUs(),
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
      pausePlaybackForPreciseSeek();
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
    seekToUs(state.startTimeUs + frameOffset * frameUs);
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
      seekToUs(parsed);
    }
    setEditingTime(false);
  }

  function cancelTimeEdit() {
    setTimeDraft(formatMonitorTime(currentTimeUs, frameRate));
    setEditingTime(false);
  }

  function handleVideoWheel(event: globalThis.WheelEvent, stage: HTMLDivElement) {
    if (!hasMedia) {
      return;
    }
    const usePointerOrigin = event.ctrlKey || event.metaKey;
    const useCenterOrigin = event.altKey && !usePointerOrigin;
    if (!usePointerOrigin && !useCenterOrigin) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (usePointerOrigin) {
      const rect = stage.getBoundingClientRect();
      zoomVideo(delta, {
        x: clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100),
        y: clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100),
      });
    } else if (useCenterOrigin) {
      zoomVideo(delta, { x: 50, y: 50 });
    }
  }

  function zoomVideo(delta: number, origin: { x: number; y: number }) {
    setZoomOrigin(origin);
    setZoomLevel((current) => {
      const numeric = current === "fit" ? 100 : current;
      const next = delta < 0 ? numeric * 1.12 : numeric / 1.12;
      return Math.round(clamp(next, 10, 1600));
    });
  }

  function changeZoomLevel(value: string) {
    if (value === "fit") {
      setZoomLevel("fit");
      setZoomOrigin({ x: 50, y: 50 });
      return;
    }
    setZoomLevel(Number(value));
  }

  function rangeWidthRatioForSpan(spanUs: number) {
    if (durationUs <= 0) {
      return 1;
    }
    const logicalWidthRatio = clamp(spanUs / durationUs, 0, 1);
    if (rangeWidthPx <= 0) {
      return logicalWidthRatio;
    }
    const minLogicalWidthRatio = clamp(trueMinTimelineSpanUs / durationUs, 0, 1);
    const minVisualWidthRatio = clamp(rangeMinBarWidthPx / rangeWidthPx, 0, 1);
    if (minLogicalWidthRatio >= 1 || minVisualWidthRatio >= 1) {
      return 1;
    }
    return mapLogicalRangeRatio(logicalWidthRatio, minLogicalWidthRatio, minVisualWidthRatio);
  }

  function spanForRangeWidthRatio(widthRatio: number) {
    if (durationUs <= 0) {
      return 0;
    }
    if (rangeWidthPx <= 0) {
      return clamp(widthRatio, 0, 1) * durationUs;
    }
    const minLogicalWidthRatio = clamp(trueMinTimelineSpanUs / durationUs, 0, 1);
    const minVisualWidthRatio = clamp(rangeMinBarWidthPx / rangeWidthPx, 0, 1);
    if (minLogicalWidthRatio >= 1 || minVisualWidthRatio >= 1) {
      return durationUs;
    }
    return mapVisualRangeRatio(widthRatio, minLogicalWidthRatio, minVisualWidthRatio) * durationUs;
  }

  function rangeLeftRatioForStart(startUs: number, spanUs: number) {
    if (durationUs <= 0) {
      return 0;
    }
    const widthRatio = rangeWidthRatioForSpan(spanUs);
    const maxStartUs = Math.max(0, durationUs - spanUs);
    const maxLeftRatio = Math.max(0, 1 - widthRatio);
    if (maxStartUs <= 0 || maxLeftRatio <= 0) {
      return 0;
    }
    return clamp((startUs / maxStartUs) * maxLeftRatio, 0, maxLeftRatio);
  }

  function shiftTimeline(deltaUs: number) {
    if (!hasMedia || durationUs <= 0) {
      return;
    }
    const currentStart = timelineStartUsRef.current;
    const currentSpan = timelineSpanUsRef.current;
    const nextStart = clampTimelineStart(currentStart + deltaUs, currentSpan, durationUs);
    timelineStartUsRef.current = nextStart;
    setTimelineStartUs(nextStart);
  }

  function resizeTimeline(deltaPx: number, anchorRatio = 0.5) {
    if (!hasMedia || durationUs <= 0) {
      return;
    }
    const currentStart = timelineStartUsRef.current;
    const currentSpan = timelineSpanUsRef.current;
    const scale = Math.exp(clamp(deltaPx, -1200, 1200) * MONITOR_RANGE_ZOOM_SENSITIVITY);
    const nextSpan = clamp(currentSpan * scale, trueMinTimelineSpanUs, durationUs);
    const anchorUs = currentStart + currentSpan * anchorRatio;
    const nextStart = clampTimelineStart(anchorUs - nextSpan * anchorRatio, nextSpan, durationUs);

    timelineSpanUsRef.current = nextSpan;
    timelineStartUsRef.current = nextStart;
    setTimelineSpanUs(nextSpan);
    setTimelineStartUs(nextStart);
  }

  function wheelDeltaPx(event: globalThis.WheelEvent) {
    const modeMultiplier =
      event.deltaMode === 1 ? WHEEL_LINE_DELTA_PX : event.deltaMode === 2 ? WHEEL_PAGE_DELTA_PX : 1;
    const deltaX = event.deltaX * modeMultiplier;
    const deltaY = event.deltaY * modeMultiplier;
    return Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
  }

  function handleIndicatorWheel(event: globalThis.WheelEvent) {
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

  function handleTimelineWheel(event: globalThis.WheelEvent) {
    if (!hasMedia) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const direction = wheelFrameDirection(event);
    if (direction !== 0) {
      moveCursorByFrames(direction);
    }
  }

  function seekFromTimeline(clientX: number, element: HTMLDivElement) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }

    const now = performance.now();
    const elapsedMs = now - timelineDragScrollAtRef.current;
    const elapsedSeconds =
      timelineDragScrollAtRef.current > 0 && elapsedMs <= 100
        ? clamp(elapsedMs / 1000, 0, 0.05)
        : 0;
    timelineDragScrollAtRef.current = now;

    const currentStartUs = timelineStartUsRef.current;
    const currentSpanUs = timelineSpanUsRef.current;
    const edgeInsetRatio = Math.min(TIMELINE_CURSOR_EDGE_INSET_PX / rect.width, 0.25);
    const leftEdgeX = rect.left + TIMELINE_CURSOR_EDGE_INSET_PX;
    const rightEdgeX = rect.right - TIMELINE_CURSOR_EDGE_INSET_PX;
    const atLeftEdge = clientX <= leftEdgeX;
    const atRightEdge = clientX >= rightEdgeX;

    if (!atLeftEdge && !atRightEdge) {
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      seekToUs(currentStartUs + ratio * currentSpanUs);
      return;
    }

    const direction = atLeftEdge ? -1 : 1;
    const overflowPx =
      direction < 0 ? Math.max(0, leftEdgeX - clientX) : Math.max(0, clientX - rightEdgeX);
    const overflowRatio = clamp(overflowPx / rect.width, 0, 1);
    const scrollSpeed =
      TIMELINE_EDGE_SCROLL_BASE_SPANS_PER_SECOND +
      overflowRatio *
        (TIMELINE_EDGE_SCROLL_MAX_SPANS_PER_SECOND - TIMELINE_EDGE_SCROLL_BASE_SPANS_PER_SECOND);
    const nextStartUs = clampTimelineStart(
      currentStartUs + direction * currentSpanUs * scrollSpeed * elapsedSeconds,
      currentSpanUs,
      durationUs,
    );
    const maxStartUs = Math.max(0, durationUs - currentSpanUs);
    const reachedVideoEdge =
      (direction < 0 && nextStartUs <= 0) || (direction > 0 && nextStartUs >= maxStartUs);
    const cursorRatio = direction < 0 ? edgeInsetRatio : 1 - edgeInsetRatio;
    const targetUs = reachedVideoEdge
      ? direction < 0
        ? 0
        : durationUs
      : nextStartUs + cursorRatio * currentSpanUs;

    timelineStartUsRef.current = nextStartUs;
    setTimelineStartUs(nextStartUs);
    seekToUs(targetUs);
  }

  function beginRangeDrag() {
    if (!hasMedia || durationUs <= 0) {
      return null;
    }
    const startUs = timelineStartUs;
    const spanUs = timelineSpanUs;
    const maxStartUs = Math.max(0, durationUs - spanUs);
    const maxLeftRatio = Math.max(0, 1 - rangeWidthRatioForSpan(spanUs));
    return (deltaRatio: number) => {
      const deltaUs = maxLeftRatio > 0 ? (deltaRatio / maxLeftRatio) * maxStartUs : 0;
      const nextStart = clampTimelineStart(startUs + deltaUs, spanUs, durationUs);
      timelineStartUsRef.current = nextStart;
      setTimelineStartUs(nextStart);
    };
  }

  function beginRangeHandleDrag(side: "start" | "end") {
    if (!hasMedia || durationUs <= 0) {
      return null;
    }
    setActiveRangeHandle("both");
    const startSpanUs = timelineSpanUs;
    const startRangeWidthRatio = rangeWidthRatioForSpan(startSpanUs);
    const centerUs = timelineStartUs + timelineSpanUs / 2;

    return {
      update: (deltaRatio: number) => {
        const nextRangeWidthRatio =
          side === "start"
            ? startRangeWidthRatio - deltaRatio * 2
            : startRangeWidthRatio + deltaRatio * 2;
        const nextSpanUs = clamp(
          spanForRangeWidthRatio(nextRangeWidthRatio),
          trueMinTimelineSpanUs,
          durationUs,
        );
        timelineSpanUsRef.current = nextSpanUs;
        timelineStartUsRef.current = clampTimelineStart(
          centerUs - nextSpanUs / 2,
          nextSpanUs,
          durationUs,
        );
        setTimelineSpanUs(nextSpanUs);
        setTimelineStartUs(timelineStartUsRef.current);
      },
      end: () => {
        setActiveRangeHandle(null);
      },
    };
  }

  return (
    <div ref={sourceMonitorRef} className={`source-monitor ${hasMedia ? "" : "empty-state"}`}>
      <VideoDisplay
        project={project}
        stageRef={videoStageRef}
        videoRef={videoRef}
        videoSrc={videoSrc}
        videoStyle={{
          width: zoomLevel === "fit" && fittedVideoSize ? `${fittedVideoSize.width}px` : undefined,
          height:
            zoomLevel === "fit" && fittedVideoSize ? `${fittedVideoSize.height}px` : undefined,
          transform: `scale(${zoomScale})`,
          transformOrigin: `${zoomOrigin.x}% ${zoomOrigin.y}%`,
        }}
        onVideoError={handleVideoError}
        onLoadedMetadata={handleLoadedMetadata}
        onSyncCurrentTime={syncCurrentTimeFromVideo}
        onPlay={(video) => {
          syncCurrentTimeFromVideo(video);
          setIsPlaying(true);
          startPlaybackTicker();
        }}
        onPause={(video) => {
          cuePlaybackEndUsRef.current = null;
          stopPlaybackTicker();
          syncCurrentTimeFromVideo(video);
          setIsPlaying(false);
        }}
        onWheel={handleVideoWheel}
      />
      <div className="source-controls" style={monitorTimeStyle}>
        <VideoControls
          timeEditorRef={timeEditorRef}
          hasMedia={hasMedia}
          editingTime={editingTime}
          timeDraft={timeDraft}
          monitorTimeText={monitorTimeText}
          monitorDurationText={monitorDurationText}
          zoomLevel={zoomLevel}
          zoomOptions={zoomOptions}
          isPlaying={isPlaying}
          previewMode={useProxy ? "proxy" : "source"}
          previewModeOptions={previewModeOptions}
          previewModeLabels={previewModeLabels}
          onCommitTimeEdit={commitTimeEdit}
          onCancelTimeEdit={cancelTimeEdit}
          onSetTimeEditSelection={setTimeEditSelection}
          onPlaceTimeCaret={placeTimeCaret}
          onSelectTimeEditorText={selectTimeEditorText}
          onTimecodeClick={handleTimecodeClick}
          onTimecodePointerDown={startTimecodeScrub}
          onTimecodePointerMove={updateTimecodeScrub}
          onTimecodePointerUp={finishTimecodeScrub}
          onTimecodePointerCancel={finishTimecodeScrub}
          onZoomLevelChange={changeZoomLevel}
          onStepFrame={stepFrame}
          onTogglePlayback={togglePlayback}
          onPreviewModeChange={changePreviewMode}
          onWheel={handleIndicatorWheel}
        />
        <TimelineRuler
          timelineRef={timelineRef}
          hasMedia={hasMedia}
          ruler={timelineRuler}
          cursorPercent={cursorPercent}
          cueRangePercent={cueRangePercent}
          onWheel={handleTimelineWheel}
          onSeekPointer={seekFromTimeline}
        />
        <MonitorRange
          rangeRef={rangeRef}
          hasMedia={hasMedia}
          indicatorLeftPercent={indicatorLeftPercent}
          indicatorWidthPercent={indicatorWidthPercent}
          activeRangeHandle={activeRangeHandle}
          onWheel={handleIndicatorWheel}
          onRangeDragStart={beginRangeDrag}
          onRangeHandleDragStart={beginRangeHandleDrag}
        />
      </div>
    </div>
  );
}
