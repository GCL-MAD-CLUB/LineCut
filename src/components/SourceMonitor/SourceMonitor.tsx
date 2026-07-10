import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useAppEvent } from "../../appEvents";
import { useAppStore } from "../../store";
import {
  clampTimelineStartFrame,
  frameToTimeUs,
  normalizeFrameRate,
  timeUsToFrame,
} from "../../timeline";
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
  const seekTargetFrameRef = useRef(0);
  const pendingVideoSeekFrameRef = useRef<number | null>(null);
  const videoSeekInFlightRef = useRef(false);
  const lastSeekCommandAtRef = useRef(0);
  const playbackTickRef = useRef<number | null>(null);
  const cuePlaybackEndFrameRef = useRef<number | null>(null);
  const currentFrame = useSourceMonitorState((state) => state.currentFrame);
  const setCurrentFrame = useSourceMonitorState((state) => state.setCurrentFrame);
  const currentFrameRef = useRef(currentFrame);
  const zoomLevel = useSourceMonitorState((state) => state.zoomLevel);
  const zoomOrigin = useSourceMonitorState((state) => state.zoomOrigin);
  const timelineStartFrame = useSourceMonitorState((state) => state.timelineStartFrame);
  const setTimelineStartFrame = useSourceMonitorState((state) => state.setTimelineStartFrame);
  const timelineSpanFrames = useSourceMonitorState((state) => state.timelineSpanFrames);
  const setTimelineSpanFrames = useSourceMonitorState((state) => state.setTimelineSpanFrames);
  const cueRange = useSourceMonitorState((state) => state.cueRange);
  const setCueRange = useSourceMonitorState((state) => state.setCueRange);
  const storedMediaKey = useSourceMonitorState((state) => state.mediaKey);
  const syncMedia = useSourceMonitorState((state) => state.syncMedia);
  const timelineStartFrameRef = useRef(timelineStartFrame);
  const timelineSpanFramesRef = useRef(timelineSpanFrames);
  const [isPlaying, setIsPlaying] = useState(false);
  const [minTimelineSpanFrames, setMinTimelineSpanFrames] = useState(0);

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
  const durationFrames = timeUsToFrame(durationUs, frameRate);
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

  const defaultTimelineSpanFrames = Math.max(1, Math.round(frameRate * 60));

  const updateTimelineStartFrame = useCallback(
    (startFrame: number) => {
      timelineStartFrameRef.current = startFrame;
      setTimelineStartFrame(startFrame);
    },
    [setTimelineStartFrame],
  );
  const updateTimelineSpanFrames = useCallback(
    (spanFrames: number) => {
      timelineSpanFramesRef.current = spanFrames;
      setTimelineSpanFrames(spanFrames);
    },
    [setTimelineSpanFrames],
  );
  const updateMinTimelineSpanFrames = useCallback((spanFrames: number) => {
    setMinTimelineSpanFrames((current) => (current === spanFrames ? current : spanFrames));
  }, []);

  useLayoutEffect(() => {
    const mediaChanged = storedMediaKey !== mediaKey;
    const nextSpan = durationFrames > 0 ? durationFrames : defaultTimelineSpanFrames;
    syncMedia(mediaKey, durationFrames);
    seekTargetFrameRef.current = mediaChanged ? 0 : currentFrame;
    pendingVideoSeekFrameRef.current = null;
    videoSeekInFlightRef.current = false;
    currentFrameRef.current = mediaChanged ? 0 : currentFrame;
    timelineStartFrameRef.current = mediaChanged ? 0 : timelineStartFrame;
    timelineSpanFramesRef.current = mediaChanged ? nextSpan : timelineSpanFrames;
    cuePlaybackEndFrameRef.current = null;
    setIsPlaying(false);
  }, [mediaKey]);

  useEffect(() => {
    currentFrameRef.current = currentFrame;
  }, [currentFrame]);

  useEffect(() => {
    timelineStartFrameRef.current = timelineStartFrame;
  }, [timelineStartFrame]);

  useEffect(() => {
    timelineSpanFramesRef.current = timelineSpanFrames;
  }, [timelineSpanFrames]);

  useEffect(
    () => () => {
      if (playbackTickRef.current !== null) {
        cancelAnimationFrame(playbackTickRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (durationFrames <= 0) {
      return;
    }
    setTimelineSpanFrames((current) => {
      const safeCurrent = Number.isFinite(current) ? current : minTimelineSpanFrames;
      const next = clamp(safeCurrent, minTimelineSpanFrames, durationFrames);
      timelineSpanFramesRef.current = next;
      setTimelineStartFrame((start) => {
        const nextStart = clampTimelineStartFrame(start, next, durationFrames);
        timelineStartFrameRef.current = nextStart;
        return nextStart;
      });
      return next;
    });
    setCurrentFrame((current) => {
      const next = clamp(Math.round(current), 0, durationFrames);
      currentFrameRef.current = next;
      return next;
    });
  }, [durationFrames, minTimelineSpanFrames]);

  useAppEvent("monitor:seek", (detail) => {
    if (!hasMedia) {
      return;
    }
    if (detail.focusEndUs !== undefined) {
      const rangeStartFrame = usToMonitorFrame(
        clamp(Math.min(detail.timeUs, detail.focusEndUs), 0, durationUs),
      );
      const rangeEndFrame = usToMonitorFrame(
        clamp(
          Math.max(detail.timeUs, detail.focusEndUs),
          frameToClampedUs(rangeStartFrame),
          durationUs,
        ),
      );
      setCueRange({ startFrame: rangeStartFrame, endFrame: rangeEndFrame });
      centerTimelineOnFrame(rangeStartFrame);
      cuePlaybackEndFrameRef.current = rangeEndFrame;
    }
    seekToFrame(
      usToMonitorFrame(detail.timeUs),
      detail.focusEndUs !== undefined,
      detail.focusEndUs === undefined,
    );
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
  }, [durationFrames, hasMedia]);

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

  function clampMonitorFrame(valueFrame: number) {
    const roundedFrame = Number.isFinite(valueFrame) ? Math.round(valueFrame) : 0;
    return durationFrames > 0 ? clamp(roundedFrame, 0, durationFrames) : Math.max(0, roundedFrame);
  }

  function usToMonitorFrame(valueUs: number) {
    const clampedUs = durationUs > 0 ? clamp(valueUs, 0, durationUs) : Math.max(0, valueUs);
    return clampMonitorFrame(timeUsToFrame(clampedUs, frameRate));
  }

  function frameToClampedUs(valueFrame: number) {
    const targetUs = frameToTimeUs(clampMonitorFrame(valueFrame), frameRate);
    return durationUs > 0 ? clamp(targetUs, 0, durationUs) : targetUs;
  }

  function seekToFrame(nextFrame: number, preserveCuePlaybackEnd = false, centerIfHidden = true) {
    if (!preserveCuePlaybackEnd) {
      cuePlaybackEndFrameRef.current = null;
    }
    const targetFrame = clampMonitorFrame(nextFrame);
    const centeredTimelineStartFrame =
      centerIfHidden && isFrameHiddenInTimeline(targetFrame)
        ? timelineStartForCenteredFrame(targetFrame)
        : null;
    seekTargetFrameRef.current = targetFrame;
    currentFrameRef.current = targetFrame;
    lastSeekCommandAtRef.current = performance.now();
    flushSync(() => {
      setCurrentFrame(targetFrame);
      if (centeredTimelineStartFrame !== null) {
        updateTimelineStartFrame(centeredTimelineStartFrame);
      }
    });
    requestVideoSeek(targetFrame);
    return targetFrame;
  }

  function requestVideoSeek(targetFrame: number) {
    pendingVideoSeekFrameRef.current = clampMonitorFrame(targetFrame);
    flushPendingVideoSeek();
  }

  function flushPendingVideoSeek() {
    const video = videoRef.current;
    const targetFrame = pendingVideoSeekFrameRef.current;
    if (!video || targetFrame === null || videoSeekInFlightRef.current) {
      return;
    }
    if (usToMonitorFrame(video.currentTime * 1_000_000) === targetFrame && !video.seeking) {
      pendingVideoSeekFrameRef.current = null;
      return;
    }

    pendingVideoSeekFrameRef.current = null;
    videoSeekInFlightRef.current = true;
    lastSeekCommandAtRef.current = performance.now();
    try {
      video.currentTime = frameToClampedUs(targetFrame) / 1_000_000;
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

  function timelineStartForCenteredFrame(frame: number) {
    const currentSpanFrames = timelineSpanFramesRef.current;
    return clampTimelineStartFrame(
      frame - currentSpanFrames / 2,
      currentSpanFrames,
      durationFrames,
    );
  }

  function centerTimelineOnFrame(frame: number) {
    if (durationFrames <= 0) {
      return;
    }
    updateTimelineStartFrame(timelineStartForCenteredFrame(frame));
  }

  function isFrameHiddenInTimeline(frame: number) {
    const currentStartFrame = timelineStartFrameRef.current;
    const currentEndFrame = Math.min(
      durationFrames,
      currentStartFrame + timelineSpanFramesRef.current,
    );
    return frame < currentStartFrame || frame > currentEndFrame;
  }

  function centerTimelineIfFrameHidden(frame: number) {
    if (isFrameHiddenInTimeline(frame)) {
      centerTimelineOnFrame(frame);
    }
  }

  function playbackFrame() {
    if (videoRef.current && Number.isFinite(videoRef.current.currentTime)) {
      return usToMonitorFrame(videoRef.current.currentTime * 1_000_000);
    }
    return currentFrameRef.current;
  }

  function syncCurrentTimeFromVideo(element: HTMLVideoElement) {
    const nextFrame = usToMonitorFrame(element.currentTime * 1_000_000);
    const targetFrame = seekTargetFrameRef.current;
    const seekAgeMs = performance.now() - lastSeekCommandAtRef.current;
    const hasOutstandingVideoSeek =
      videoSeekInFlightRef.current || pendingVideoSeekFrameRef.current !== null;
    const isStaleSeekEvent =
      (element.seeking || seekAgeMs < 500 || hasOutstandingVideoSeek) && nextFrame !== targetFrame;
    if (isStaleSeekEvent) {
      finishVideoSeek(element);
      return;
    }

    const cuePlaybackEndFrame = cuePlaybackEndFrameRef.current;
    if (cuePlaybackEndFrame !== null) {
      const reachedCueEnd =
        element.currentTime * 1_000_000 >= frameToClampedUs(cuePlaybackEndFrame);
      centerTimelineIfFrameHidden(reachedCueEnd ? cuePlaybackEndFrame : nextFrame);
      if (reachedCueEnd) {
        cuePlaybackEndFrameRef.current = null;
        seekToFrame(cuePlaybackEndFrame, true, false);
        element.pause();
        return;
      }
    }

    seekTargetFrameRef.current = nextFrame;
    currentFrameRef.current = nextFrame;
    setCurrentFrame(nextFrame);
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
    const restoredFrame = clampMonitorFrame(currentFrame);
    seekTargetFrameRef.current = restoredFrame;
    if (usToMonitorFrame(element.currentTime * 1_000_000) !== restoredFrame) {
      element.currentTime = frameToClampedUs(restoredFrame) / 1_000_000;
    }
  }

  function togglePlayback() {
    if (!hasMedia || !videoRef.current) {
      return;
    }
    cuePlaybackEndFrameRef.current = null;
    if (videoRef.current.paused) {
      void videoRef.current.play();
    } else {
      const pausedAtFrame = playbackFrame();
      videoRef.current.pause();
      centerTimelineIfFrameHidden(pausedAtFrame);
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
    const originFrame = stepFrameOriginFrame();
    pausePlaybackForPreciseSeek();
    seekToFrame(originFrame + frameDelta);
  }

  function stepFrameOriginFrame() {
    const current = currentFrameRef.current;
    const pendingSeekFrame = seekTargetFrameRef.current;
    if (Number.isFinite(pendingSeekFrame) && Math.abs(pendingSeekFrame - current) <= 1) {
      return pendingSeekFrame;
    }
    return playbackFrame();
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
          cuePlaybackEndFrameRef.current = null;
          stopPlaybackTicker();
          syncCurrentTimeFromVideo(video);
          setIsPlaying(false);
        }}
      />
      <div className="source-controls">
        <VideoControls
          mediaKey={mediaKey}
          hasMedia={hasMedia}
          currentFrame={currentFrame}
          durationFrames={durationFrames}
          frameRate={frameRate}
          timelineStartFrame={timelineStartFrame}
          timelineSpanFrames={timelineSpanFrames}
          minTimelineSpanFrames={minTimelineSpanFrames}
          isPlaying={isPlaying}
          previewMode={useProxy ? "proxy" : "source"}
          previewModeOptions={previewModeOptions}
          previewModeLabels={previewModeLabels}
          onSeekFrame={seekToFrame}
          onPlaybackFrameRequest={playbackFrame}
          onPauseForPreciseSeek={pausePlaybackForPreciseSeek}
          onTimelineStartFrameChange={updateTimelineStartFrame}
          onTimelineSpanFramesChange={updateTimelineSpanFrames}
          onStepFrame={stepFrame}
          onTogglePlayback={togglePlayback}
          onPreviewModeChange={changePreviewMode}
        />
        <TimelineRuler
          hasMedia={hasMedia}
          currentFrame={currentFrame}
          durationFrames={durationFrames}
          timelineStartFrame={timelineStartFrame}
          timelineSpanFrames={timelineSpanFrames}
          cueRange={cueRange}
          onMinTimelineSpanFramesChange={updateMinTimelineSpanFrames}
          onTimelineStartFrameChange={updateTimelineStartFrame}
          onSeekFrame={seekToFrame}
          onStepFrame={stepFrame}
        />
        <MonitorRange
          hasMedia={hasMedia}
          durationFrames={durationFrames}
          timelineStartFrame={timelineStartFrame}
          timelineSpanFrames={timelineSpanFrames}
          minTimelineSpanFrames={minTimelineSpanFrames}
          onTimelineStartFrameChange={updateTimelineStartFrame}
          onTimelineSpanFramesChange={updateTimelineSpanFrames}
        />
      </div>
    </div>
  );
}
