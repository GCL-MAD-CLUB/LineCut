import { convertFileSrc } from "@tauri-apps/api/core";
import {
  useEffect,
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
import { formatMonitorTime, parseMonitorTime } from "../../time";
import {
  buildTimelineRuler,
  clampTimelineSpan,
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

const baseZoomPercentOptions = [10, 25, 50, 75, 100, 150, 200, 400, 800, 1600] as const;
const TIMECODE_SCRUB_LONG_PRESS_MS = 220;
const TIMECODE_SCRUB_PX_PER_FRAME = 6;
const WHEEL_LINE_DELTA_PX = 16;
const WHEEL_PAGE_DELTA_PX = 800;
const MONITOR_RANGE_ZOOM_SENSITIVITY = 0.00035;
const MONITOR_RANGE_SCROLL_SENSITIVITY = 1 / 5000;
const previewModeOptions = ["source", "proxy"] as const;
const previewModeLabels: Record<(typeof previewModeOptions)[number], string> = {
  source: "完整",
  proxy: "代理",
};
type PreviewMode = (typeof previewModeOptions)[number];

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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
  const setMessage = useAppStore((state) => state.setMessage);
  const setUseProxy = useAppStore((state) => state.setUseProxy);
  const setProxyDialogOpen = useAppStore((state) => state.setProxyDialogOpen);
  const { isRunning: isGeneratingProxy } = getTaskProgressStatus("proxy");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoStageRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const rangeRef = useRef<HTMLDivElement | null>(null);
  const timeEditorRef = useRef<HTMLSpanElement | null>(null);
  const timecodeScrubRef = useRef<TimecodeScrubState | null>(null);
  const suppressTimeEditClickRef = useRef(false);
  const seekTargetUsRef = useRef(0);
  const lastSeekCommandAtRef = useRef(0);
  const playbackTickRef = useRef<number | null>(null);
  const timelineStartUsRef = useRef(0);
  const timelineSpanUsRef = useRef(60_000_000);
  const [videoStageSize, setVideoStageSize] = useState({ width: 0, height: 0 });
  const [videoNaturalSize, setVideoNaturalSize] = useState({ width: 0, height: 0 });
  const [currentTimeUs, setCurrentTimeUs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [editingTime, setEditingTime] = useState(false);
  const [timeEditSelection, setTimeEditSelection] = useState<"all" | "cursor">("cursor");
  const [timeDraft, setTimeDraft] = useState("");
  const [zoomLevel, setZoomLevel] = useState<"fit" | number>("fit");
  const [zoomOrigin, setZoomOrigin] = useState({ x: 50, y: 50 });
  const [timelineStartUs, setTimelineStartUs] = useState(0);
  const [timelineSpanUs, setTimelineSpanUs] = useState(60_000_000);
  const [timelineWidthPx, setTimelineWidthPx] = useState(0);
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
  const isCustomZoom =
    typeof zoomLevel === "number" && !baseZoomPercentOptions.includes(zoomLevel as never);
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

  useEffect(() => {
    const nextSpan = durationUs > 0 ? durationUs : 60_000_000;
    seekTargetUsRef.current = 0;
    timelineStartUsRef.current = 0;
    timelineSpanUsRef.current = nextSpan;
    setCurrentTimeUs(0);
    setTimelineStartUs(0);
    setTimelineSpanUs(nextSpan);
    setIsPlaying(false);
    setEditingTime(false);
    setZoomLevel("fit");
    setZoomOrigin({ x: 50, y: 50 });
    setVideoNaturalSize({ width: 0, height: 0 });
    setActiveRangeHandle(null);
  }, [project?.asset.id, durationUs, frameRate]);

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
    if (durationUs <= 0) {
      return;
    }
    setTimelineSpanUs((current) => {
      const next = clampTimelineSpan(current, Math.max(1, timelineWidthPx), frameRate, durationUs);
      setTimelineStartUs((start) => clampTimelineStart(start, next, durationUs));
      return next;
    });
    setCurrentTimeUs((current) => clamp(current, 0, durationUs));
  }, [durationUs, frameRate, timelineWidthPx]);

  useAppEvent("monitor:seek", (detail) => {
    if (!hasMedia) {
      return;
    }
    seekToUs(detail.timeUs);
    void videoRef.current?.play();
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
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

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [durationUs, editingTime, frameUs, hasMedia]);

  function changePreviewMode(value: PreviewMode) {
    if (value === "source") {
      setProxyDialogOpen(false);
      setUseProxy(false);
      return;
    }
    if (!project || isGeneratingProxy) {
      return;
    }
    if (proxyPath) {
      setUseProxy(true);
      return;
    }
    setUseProxy(false);
    setProxyDialogOpen(true);
  }

  function handleVideoError() {
    if (!useProxy && project) {
      if (proxyPath) {
        setUseProxy(true);
        setMessage("原文件无法直接播放，已切换到代理模式。");
      } else {
        setProxyDialogOpen(true);
        setMessage("原文件无法直接播放，请创建代理后预览。");
      }
    }
  }

  function snapUsToFrame(valueUs: number) {
    const frame = Math.max(0, Math.round(valueUs / frameUs));
    return clamp(frame * frameUs, 0, durationUs || frame * frameUs);
  }

  function seekToUs(nextUs: number) {
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

  function togglePlayback() {
    if (!hasMedia || !videoRef.current) {
      return;
    }
    if (videoRef.current.paused) {
      void videoRef.current.play();
    } else {
      videoRef.current.pause();
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
    return clamp(spanUs / durationUs, 0, 1);
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
    const nextSpan = clampTimelineSpan(
      currentSpan * scale,
      Math.max(1, timelineWidthPx),
      frameRate,
      durationUs,
    );
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
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    seekToUs(snapUsToFrame(timelineStartUs + ratio * timelineVisibleSpanUs));
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
    const centerUs = timelineStartUs + timelineSpanUs / 2;

    return {
      update: (deltaRatio: number) => {
        const deltaUs = deltaRatio * durationUs;
        const nextSpanUs = clampTimelineSpan(
          side === "start" ? startSpanUs - deltaUs * 2 : startSpanUs + deltaUs * 2,
          Math.max(1, timelineWidthPx),
          frameRate,
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
    <div className={`source-monitor ${hasMedia ? "" : "empty-state"}`}>
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
        onLoadedMetadata={updateVideoNaturalSize}
        onSyncCurrentTime={syncCurrentTimeFromVideo}
        onPlay={(video) => {
          syncCurrentTimeFromVideo(video);
          setIsPlaying(true);
          startPlaybackTicker();
        }}
        onPause={(video) => {
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
          isCustomZoom={isCustomZoom}
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
