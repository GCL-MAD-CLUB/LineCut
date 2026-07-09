import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useAppEvent } from "../../appEvents";
import { useAppStore } from "../../store";
import { snapMonitorTime } from "../../time";
import { clampTimelineStart, frameDurationUs, normalizeFrameRate } from "../../timeline";
import { MonitorRange } from "./MonitorRange";
import "./SourceMonitor.css";
import { TimelineRuler } from "./TimelineRuler";
import { getTaskProgressStatus } from "../TaskProgress";
import { VideoControls } from "./VideoControls";
import { VideoDisplay } from "./VideoDisplay";
import { useSourceMonitorState } from "./sourceMonitorState";

const previewModeOptions = ["source", "proxy"] as const;
const previewModeLabels: Record<(typeof previewModeOptions)[number], string> = {
  source: "完整",
  proxy: "代理",
};
type PreviewMode = (typeof previewModeOptions)[number];

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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
  const seekTargetUsRef = useRef(0);
  const pendingVideoSeekUsRef = useRef<number | null>(null);
  const videoSeekInFlightRef = useRef(false);
  const lastSeekCommandAtRef = useRef(0);
  const playbackTickRef = useRef<number | null>(null);
  const cuePlaybackEndUsRef = useRef<number | null>(null);
  const currentTimeUs = useSourceMonitorState((state) => state.currentTimeUs);
  const setCurrentTimeUs = useSourceMonitorState((state) => state.setCurrentTimeUs);
  const currentTimeUsRef = useRef(currentTimeUs);
  const zoomLevel = useSourceMonitorState((state) => state.zoomLevel);
  const zoomOrigin = useSourceMonitorState((state) => state.zoomOrigin);
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
  const [isPlaying, setIsPlaying] = useState(false);
  const [minTimelineSpanUs, setMinTimelineSpanUs] = useState(0);

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
  const videoSrc = useMemo(() => {
    if (!project) {
      return "";
    }
    const path = useProxy ? proxyPath : project.asset.path;
    return path ? convertFileSrc(path) : "";
  }, [project, proxyPath, useProxy]);
  const mediaKey = project
    ? `${project.asset.id}:${durationUs}:${frameRate}`
    : `empty:${frameRate}`;

  const updateTimelineStartUs = useCallback(
    (startUs: number) => {
      timelineStartUsRef.current = startUs;
      setTimelineStartUs(startUs);
    },
    [setTimelineStartUs],
  );
  const updateTimelineSpanUs = useCallback(
    (spanUs: number) => {
      timelineSpanUsRef.current = spanUs;
      setTimelineSpanUs(spanUs);
    },
    [setTimelineSpanUs],
  );
  const updateMinTimelineSpanUs = useCallback((spanUs: number) => {
    setMinTimelineSpanUs((current) => (current === spanUs ? current : spanUs));
  }, []);

  useLayoutEffect(() => {
    const mediaChanged = storedMediaKey !== mediaKey;
    const nextSpan = durationUs > 0 ? durationUs : 60_000_000;
    syncMedia(mediaKey, durationUs);
    seekTargetUsRef.current = mediaChanged ? 0 : currentTimeUs;
    pendingVideoSeekUsRef.current = null;
    videoSeekInFlightRef.current = false;
    currentTimeUsRef.current = mediaChanged ? 0 : currentTimeUs;
    timelineStartUsRef.current = mediaChanged ? 0 : timelineStartUs;
    timelineSpanUsRef.current = mediaChanged ? nextSpan : timelineSpanUs;
    cuePlaybackEndUsRef.current = null;
    setIsPlaying(false);
  }, [mediaKey]);

  useEffect(() => {
    currentTimeUsRef.current = currentTimeUs;
  }, [currentTimeUs]);

  useEffect(() => {
    timelineStartUsRef.current = timelineStartUs;
  }, [timelineStartUs]);

  useEffect(() => {
    timelineSpanUsRef.current = timelineSpanUs;
  }, [timelineSpanUs]);

  useEffect(
    () => () => {
      if (playbackTickRef.current !== null) {
        cancelAnimationFrame(playbackTickRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (durationUs <= 0) {
      return;
    }
    setTimelineSpanUs((current) => {
      const next = clamp(current, minTimelineSpanUs, durationUs);
      timelineSpanUsRef.current = next;
      setTimelineStartUs((start) => {
        const nextStart = clampTimelineStart(start, next, durationUs);
        timelineStartUsRef.current = nextStart;
        return nextStart;
      });
      return next;
    });
    setCurrentTimeUs((current) => {
      const next = clamp(current, 0, durationUs);
      currentTimeUsRef.current = next;
      return next;
    });
  }, [durationUs, minTimelineSpanUs]);

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
    seekToUs(detail.timeUs, detail.focusEndUs !== undefined, detail.focusEndUs === undefined);
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
        if (isEditableKeyboardTarget(event.target)) {
          return;
        }
        if (suppressSpaceEvent(event) && !event.repeat && hasMedia) {
          togglePlayback();
        }
        return;
      }
      if (!isFrameStep || !hasMedia || isEditableKeyboardTarget(event.target)) {
        return;
      }
      event.preventDefault();
      stepFrame(event.key === "ArrowLeft" ? -1 : 1);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!isEditableKeyboardTarget(event.target)) {
        suppressSpaceEvent(event);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [durationUs, frameUs, hasMedia]);

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

  function seekToUs(nextUs: number, preserveCuePlaybackEnd = false, centerIfHidden = true) {
    if (!preserveCuePlaybackEnd) {
      cuePlaybackEndUsRef.current = null;
    }
    const targetUs = snapUsToFrame(nextUs);
    const centeredTimelineStartUs =
      centerIfHidden && isTimeHiddenInTimeline(targetUs)
        ? timelineStartForCenteredTime(targetUs)
        : null;
    seekTargetUsRef.current = targetUs;
    currentTimeUsRef.current = targetUs;
    lastSeekCommandAtRef.current = performance.now();
    flushSync(() => {
      setCurrentTimeUs(targetUs);
      if (centeredTimelineStartUs !== null) {
        updateTimelineStartUs(centeredTimelineStartUs);
      }
    });
    requestVideoSeek(targetUs);
    return targetUs;
  }

  function requestVideoSeek(targetUs: number) {
    pendingVideoSeekUsRef.current = targetUs;
    flushPendingVideoSeek();
  }

  function flushPendingVideoSeek() {
    const video = videoRef.current;
    const targetUs = pendingVideoSeekUsRef.current;
    if (!video || targetUs === null || videoSeekInFlightRef.current) {
      return;
    }
    if (Math.abs(video.currentTime * 1_000_000 - targetUs) <= frameUs / 2 && !video.seeking) {
      pendingVideoSeekUsRef.current = null;
      return;
    }

    pendingVideoSeekUsRef.current = null;
    videoSeekInFlightRef.current = true;
    lastSeekCommandAtRef.current = performance.now();
    try {
      video.currentTime = targetUs / 1_000_000;
    } catch {
      videoSeekInFlightRef.current = false;
    }
  }

  function finishVideoSeek(element: HTMLVideoElement) {
    if (element.seeking) {
      return;
    }
    videoSeekInFlightRef.current = false;
    flushPendingVideoSeek();
  }

  function timelineStartForCenteredTime(timeUs: number) {
    const currentSpanUs = timelineSpanUsRef.current;
    return clampTimelineStart(timeUs - currentSpanUs / 2, currentSpanUs, durationUs);
  }

  function centerTimelineOnTime(timeUs: number) {
    if (durationUs <= 0) {
      return;
    }
    updateTimelineStartUs(timelineStartForCenteredTime(timeUs));
  }

  function isTimeHiddenInTimeline(timeUs: number) {
    const currentStartUs = timelineStartUsRef.current;
    const currentEndUs = Math.min(durationUs, currentStartUs + timelineSpanUsRef.current);
    return timeUs < currentStartUs || timeUs > currentEndUs;
  }

  function centerTimelineIfTimeHidden(timeUs: number) {
    if (isTimeHiddenInTimeline(timeUs)) {
      centerTimelineOnTime(timeUs);
    }
  }

  function playbackTimeUs() {
    if (videoRef.current && Number.isFinite(videoRef.current.currentTime)) {
      return snapUsToFrame(videoRef.current.currentTime * 1_000_000);
    }
    return currentTimeUsRef.current;
  }

  function syncCurrentTimeFromVideo(element: HTMLVideoElement) {
    const nextUs = snapUsToFrame(element.currentTime * 1_000_000);
    const targetUs = seekTargetUsRef.current;
    const seekAgeMs = performance.now() - lastSeekCommandAtRef.current;
    const hasOutstandingVideoSeek =
      videoSeekInFlightRef.current || pendingVideoSeekUsRef.current !== null;
    const isStaleSeekEvent =
      (element.seeking || seekAgeMs < 500 || hasOutstandingVideoSeek) &&
      Math.abs(nextUs - targetUs) > frameUs / 2;
    if (isStaleSeekEvent) {
      finishVideoSeek(element);
      return;
    }

    const cuePlaybackEndUs = cuePlaybackEndUsRef.current;
    if (cuePlaybackEndUs !== null) {
      const reachedCueEnd = element.currentTime * 1_000_000 >= cuePlaybackEndUs;
      centerTimelineIfTimeHidden(reachedCueEnd ? cuePlaybackEndUs : nextUs);
      if (reachedCueEnd) {
        cuePlaybackEndUsRef.current = null;
        seekToUs(cuePlaybackEndUs, true, false);
        element.pause();
        return;
      }
    }

    seekTargetUsRef.current = nextUs;
    currentTimeUsRef.current = nextUs;
    setCurrentTimeUs(nextUs);
    finishVideoSeek(element);
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

  function handleLoadedMetadata(element: HTMLVideoElement) {
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

  function moveCursorByFrames(frameDelta: number) {
    if (!hasMedia || frameDelta === 0) {
      return;
    }
    const originUs = stepFrameOriginTimeUs();
    pausePlaybackForPreciseSeek();
    const currentFrame = Math.round(originUs / frameUs);
    seekToUs((currentFrame + frameDelta) * frameUs);
  }

  function stepFrameOriginTimeUs() {
    const currentUs = currentTimeUsRef.current;
    const pendingSeekUs = seekTargetUsRef.current;
    if (Number.isFinite(pendingSeekUs) && Math.abs(pendingSeekUs - currentUs) <= frameUs) {
      return pendingSeekUs;
    }
    return playbackTimeUs();
  }

  function stepFrame(direction: -1 | 1) {
    moveCursorByFrames(direction);
  }

  return (
    <div ref={sourceMonitorRef} className={`source-monitor ${hasMedia ? "" : "empty-state"}`}>
      <VideoDisplay
        project={project}
        stageRef={videoStageRef}
        videoRef={videoRef}
        videoSrc={videoSrc}
        zoomLevel={zoomLevel}
        zoomOrigin={zoomOrigin}
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
      />
      <div className="source-controls">
        <VideoControls
          mediaKey={mediaKey}
          hasMedia={hasMedia}
          currentTimeUs={currentTimeUs}
          durationUs={durationUs}
          frameRate={frameRate}
          timelineStartUs={timelineStartUs}
          timelineSpanUs={timelineSpanUs}
          minTimelineSpanUs={minTimelineSpanUs}
          isPlaying={isPlaying}
          previewMode={useProxy ? "proxy" : "source"}
          previewModeOptions={previewModeOptions}
          previewModeLabels={previewModeLabels}
          onSeekUs={seekToUs}
          onPlaybackTimeRequest={playbackTimeUs}
          onPauseForPreciseSeek={pausePlaybackForPreciseSeek}
          onTimelineStartUsChange={updateTimelineStartUs}
          onTimelineSpanUsChange={updateTimelineSpanUs}
          onStepFrame={stepFrame}
          onTogglePlayback={togglePlayback}
          onPreviewModeChange={changePreviewMode}
        />
        <TimelineRuler
          hasMedia={hasMedia}
          currentTimeUs={currentTimeUs}
          durationUs={durationUs}
          frameRate={frameRate}
          timelineStartUs={timelineStartUs}
          timelineSpanUs={timelineSpanUs}
          cueRange={cueRange}
          onMinTimelineSpanUsChange={updateMinTimelineSpanUs}
          onTimelineStartUsChange={updateTimelineStartUs}
          onSeekUs={seekToUs}
          onStepFrame={stepFrame}
        />
        <MonitorRange
          hasMedia={hasMedia}
          durationUs={durationUs}
          timelineStartUs={timelineStartUs}
          timelineSpanUs={timelineSpanUs}
          minTimelineSpanUs={minTimelineSpanUs}
          onTimelineStartUsChange={updateTimelineStartUs}
          onTimelineSpanUsChange={updateTimelineSpanUs}
        />
      </div>
    </div>
  );
}
