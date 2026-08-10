import { convertFileSrc } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type SyntheticEvent,
} from "react";
import { flushSync } from "react-dom";
import { usePlaybackCapability } from "../../runtime/capabilities/PlaybackCapability";
import { runBackgroundOperation, runOperation } from "../../errors";
import { useStableIdentity } from "../../runtime/state/react";
import { usePanelActive, usePanelInstanceId } from "../../runtime/systems/PanelState";
import {
  isMediaItemEnabled,
  isMediaItemOffline,
  isMediaVideoDetached,
  resolvedMediaAudioSources,
  useProjectPort,
} from "../../systems/ProjectSystem";
import { useTaskProgressStatus } from "../../systems/TaskSystem";
import {
  clampTimelineStartFrame,
  frameToTimeUs,
  normalizeFrameRate,
  timeUsToFrame,
} from "../../timeline";
import { MonitorRange } from "./MonitorRange";
import { activeMediaDragVideoId, markMediaDragHandled } from "../MediaBin/mediaDrag";
import { usePanelManagerState } from "../DockLayout";
import "./SourceMonitor.css";
import { TimelineRuler } from "./TimelineRuler";
import { VideoControls } from "./VideoControls";
import { VideoDisplay } from "./VideoDisplay";
import { RollingPcmAudioController, type RollingPcmAudioSource } from "./rollingPcmAudio";
import {
  isSlowPlaybackMode,
  nextShuttlePlaybackRate,
  useSourceMonitorState,
  type PlaybackMode,
  type PlaybackRate,
} from "./sourceMonitorState";

const previewModeOptions = ["source", "proxy"] as const;
const SLOW_PLAYBACK_FRAMES_PER_SECOND = 5;
const previewModeLabels: Record<(typeof previewModeOptions)[number], string> = {
  source: "完整",
  proxy: "代理",
};
type PreviewMode = (typeof previewModeOptions)[number];

interface PendingPreviewRestore {
  frame: number;
  playbackMode: PlaybackMode;
}

interface BoundAudioElementProps {
  itemId: string;
  path: string;
  audioTrackIndex: number;
  onElementChanged: (itemId: string, element: HTMLAudioElement | null) => void;
}

interface PcmPlaybackConfig {
  direction: -1 | 1;
  playbackRate: number;
  algorithm: "phase-vocoder" | "wsola";
}

interface SelectableAudioTrack {
  enabled: boolean;
}

interface SelectableAudioTrackList {
  length: number;
  [index: number]: SelectableAudioTrack;
}

function selectEmbeddedAudioTrack(element: HTMLAudioElement, audioTrackIndex: number) {
  const audioTracks = (element as HTMLAudioElement & { audioTracks?: SelectableAudioTrackList })
    .audioTracks;
  if (!audioTracks || audioTrackIndex < 0 || audioTrackIndex >= audioTracks.length) {
    return;
  }
  for (let index = 0; index < audioTracks.length; index += 1) {
    audioTracks[index].enabled = index === audioTrackIndex;
  }
}

function BoundAudioElement({
  itemId,
  path,
  audioTrackIndex,
  onElementChanged,
}: BoundAudioElementProps) {
  const setElement = useCallback(
    (element: HTMLAudioElement | null) => {
      if (element) {
        selectEmbeddedAudioTrack(element, audioTrackIndex);
      }
      onElementChanged(itemId, element);
    },
    [audioTrackIndex, itemId, onElementChanged],
  );
  const handleLoadedMetadata = useCallback(
    (event: SyntheticEvent<HTMLAudioElement>) => {
      selectEmbeddedAudioTrack(event.currentTarget, audioTrackIndex);
    },
    [audioTrackIndex],
  );
  return (
    <audio
      ref={setElement}
      src={convertFileSrc(path)}
      preload="auto"
      onLoadedMetadata={handleLoadedMetadata}
    />
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function effectivePlaybackRate(mode: PlaybackMode, frameRate: number) {
  if (!isSlowPlaybackMode(mode)) {
    return mode;
  }
  const direction = mode === "slow-reverse" ? -1 : 1;
  return direction * (SLOW_PLAYBACK_FRAMES_PER_SECOND / frameRate);
}

function pcmPlaybackConfig(mode: PlaybackMode, frameRate: number): PcmPlaybackConfig | null {
  const effectiveRate = effectivePlaybackRate(mode, frameRate);
  const absoluteRate = Math.abs(effectiveRate);
  const needsPcmAudio =
    absoluteRate > 0 &&
    absoluteRate <= 4 &&
    (effectiveRate < 0 || isSlowPlaybackMode(mode) || absoluteRate === 4);
  if (!needsPcmAudio) {
    return null;
  }
  return {
    direction: effectiveRate < 0 ? -1 : 1,
    playbackRate: absoluteRate,
    algorithm: isSlowPlaybackMode(mode) ? "phase-vocoder" : "wsola",
  };
}

function usesManualPlaybackClock(mode: PlaybackMode) {
  return isSlowPlaybackMode(mode) || mode < 0;
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
  const panelInstanceId = usePanelInstanceId();
  const panelActive = usePanelActive();
  const focusedPanelId = usePanelManagerState((state) => state.focusedPanelId);
  const identity = useStableIdentity("source-monitor", panelInstanceId);
  const [lastFocusedAt, setLastFocusedAt] = useState(panelInstanceId === "source" ? 1 : 0);
  useEffect(() => {
    if (focusedPanelId === panelInstanceId) {
      setLastFocusedAt(Date.now());
    }
  }, [focusedPanelId, panelInstanceId]);
  const {
    project,
    projects,
    mediaItems,
    activeVideoId,
    detachedVideoIds,
    activeVideoChanged,
    proxyPath,
    useProxy,
    messagePublished,
    sourcePreviewSelected,
    proxyPreviewSelected,
    proxyDialogOpened,
  } = useProjectPort(
    [
      "project",
      "projects",
      "mediaItems",
      "activeVideoId",
      "detachedVideoIds",
      "proxyPath",
      "useProxy",
    ],
    [
      "activeVideoChanged",
      "messagePublished",
      "sourcePreviewSelected",
      "proxyPreviewSelected",
      "proxyDialogOpened",
    ],
  );
  const {
    currentFrame,
    setCurrentFrame,
    playbackMode,
    setPlaybackMode,
    isPlaying,
    zoomLevel,
    zoomPan,
    timelineStartFrame,
    setTimelineStartFrame,
    timelineSpanFrames,
    setTimelineSpanFrames,
    cueRange,
    setCueRange,
    mediaKey: panelMediaKey,
    playedVideoRecorded,
    syncMedia,
  } = useSourceMonitorState((state) => state);
  const { isRunning: isGeneratingProxy } = useTaskProgressStatus("proxy.generate");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const boundAudioRefs = useRef(new Map<string, HTMLAudioElement>());
  const rollingPcmAudioRef = useRef<RollingPcmAudioController | null>(null);
  const sourceMonitorRef = useRef<HTMLDivElement | null>(null);
  const videoStageRef = useRef<HTMLDivElement | null>(null);
  const seekTargetFrameRef = useRef(0);
  const pendingVideoSeekFrameRef = useRef<number | null>(null);
  const videoSeekInFlightRef = useRef(false);
  const lastSeekCommandAtRef = useRef(0);
  const playbackTickRef = useRef<number | null>(null);
  const playbackModeRef = useRef<PlaybackMode>(playbackMode);
  const manualPlaybackFrameRef = useRef(currentFrame);
  const manualPlaybackTickAtRef = useRef<number | null>(null);
  const kKeyHeldRef = useRef(false);
  const jKeyHeldRef = useRef(false);
  const lKeyHeldRef = useRef(false);
  const lastShuttleDirectionHeldRef = useRef<-1 | 1>(1);
  const cuePlaybackVideoFrameCallbackRef = useRef<{
    video: HTMLVideoElement;
    callbackId: number;
  } | null>(null);
  const cuePlaybackUsesVideoFrameCallbackRef = useRef(false);
  const cuePlaybackPauseFrameRef = useRef<number | null>(null);
  const pendingPreviewRestoreRef = useRef<PendingPreviewRestore | null>(null);
  const cuePlaybackEndFrameRef = useRef<number | null>(null);
  const currentFrameRef = useRef(currentFrame);
  const timelineStartFrameRef = useRef(timelineStartFrame);
  const timelineSpanFramesRef = useRef(timelineSpanFrames);
  const [isVideoDragOver, setIsVideoDragOver] = useState(false);
  const [minTimelineSpanFrames, setMinTimelineSpanFrames] = useState(0);

  const registerBoundAudioElement = useCallback(
    (itemId: string, element: HTMLAudioElement | null) => {
      const previous = boundAudioRefs.current.get(itemId);
      if (!element) {
        previous?.pause();
        boundAudioRefs.current.delete(itemId);
        return;
      }
      if (previous && previous !== element) {
        previous.pause();
      }
      element.preservesPitch = true;
      boundAudioRefs.current.set(itemId, element);
      const video = videoRef.current;
      if (!video || video.paused || video.ended || video.playbackRate > 4) {
        return;
      }
      try {
        element.currentTime = video.currentTime;
      } catch {
        // Metadata may not be available during the first ref callback.
      }
      element.playbackRate = video.playbackRate;
      runBackgroundOperation("media.playback", () => element.play());
    },
    [],
  );

  const hasMedia = Boolean(project);
  const activeVideoItem = mediaItems.find((item) => item.id === activeVideoId);
  const activeVideoOffline = Boolean(activeVideoItem && isMediaItemOffline(activeVideoItem));
  const sourceAudioDetached = activeVideoItem
    ? isMediaVideoDetached(activeVideoItem, detachedVideoIds)
    : false;

  useEffect(() => {
    if (activeVideoItem?.kind === "video" && isMediaItemEnabled(activeVideoItem)) {
      playedVideoRecorded(activeVideoItem.id);
    }
  }, [activeVideoItem, playedVideoRecorded]);
  const resolvedAudioSources = useMemo(
    () =>
      project
        ? resolvedMediaAudioSources(activeVideoId, project, projects, mediaItems, detachedVideoIds)
        : [],
    [activeVideoId, detachedVideoIds, mediaItems, project, projects],
  );
  const primaryAudioSource = resolvedAudioSources.find((source) => source.primary);
  const primaryVirtualAudioEnabled = sourceAudioDetached && Boolean(primaryAudioSource);
  const boundAudioSources = useMemo(
    () =>
      resolvedAudioSources
        .filter((source) => !source.primary)
        .map((source) => ({
          itemId: source.id,
          path: source.path,
          audioTrackIndex: source.audioTrackIndex,
        })),
    [resolvedAudioSources],
  );
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
  const previewPath = useMemo(() => {
    if (!project) {
      return "";
    }
    return useProxy ? (proxyPath ?? "") : activeVideoOffline ? "" : project.asset.path;
  }, [activeVideoOffline, project, proxyPath, useProxy]);
  const videoSrc = useMemo(() => (previewPath ? convertFileSrc(previewPath) : ""), [previewPath]);
  const rollingPcmSources = useMemo(() => {
    const sources: RollingPcmAudioSource[] = boundAudioSources.map((source) => ({
      id: `bound:${source.itemId}:${source.audioTrackIndex}:${source.path}`,
      path: source.path,
      audioTrackIndex: source.audioTrackIndex,
    }));
    const primaryAudioPath = activeVideoOffline ? proxyPath : project?.asset.path;
    const primaryAudioTrackIndex = activeVideoOffline
      ? primaryAudioSource
        ? 0
        : -1
      : (primaryAudioSource?.audioTrackIndex ?? -1);
    if (
      primaryAudioPath &&
      project &&
      primaryAudioTrackIndex >= 0 &&
      (!sourceAudioDetached || primaryVirtualAudioEnabled)
    ) {
      sources.unshift({
        id: `primary:${project.asset.id}:${primaryAudioPath}`,
        path: primaryAudioPath,
        audioTrackIndex: primaryAudioTrackIndex,
      });
    }
    return sources;
  }, [
    activeVideoOffline,
    boundAudioSources,
    primaryVirtualAudioEnabled,
    project?.asset.id,
    project?.asset.path,
    primaryAudioSource,
    proxyPath,
    sourceAudioDetached,
  ]);
  const mediaKey = project
    ? `${activeVideoId}:${project.asset.id}:${durationUs}:${frameRate}`
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
    const mediaChanged = panelMediaKey !== mediaKey;
    const nextSpan = durationFrames > 0 ? durationFrames : defaultTimelineSpanFrames;
    syncMedia(mediaKey, durationFrames);
    seekTargetFrameRef.current = mediaChanged ? 0 : currentFrame;
    pendingVideoSeekFrameRef.current = null;
    videoSeekInFlightRef.current = false;
    currentFrameRef.current = mediaChanged ? 0 : currentFrame;
    timelineStartFrameRef.current = mediaChanged ? 0 : timelineStartFrame;
    timelineSpanFramesRef.current = mediaChanged ? nextSpan : timelineSpanFrames;
    if (mediaChanged) {
      pendingPreviewRestoreRef.current = null;
    }
    stopCuePlaybackFrameMonitor();
    cuePlaybackPauseFrameRef.current = null;
    cuePlaybackEndFrameRef.current = null;
    playbackModeRef.current = 0;
    manualPlaybackTickAtRef.current = null;
    stopRollingPcmAudio();
    setPlaybackMode(0);
  }, [mediaKey]);

  useEffect(() => {
    currentFrameRef.current = currentFrame;
  }, [currentFrame]);

  useEffect(() => {
    playbackModeRef.current = playbackMode;
  }, [playbackMode]);

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
      stopCuePlaybackFrameMonitor();
      rollingPcmAudioRef.current?.dispose();
      rollingPcmAudioRef.current = null;
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

  const { isAuthority: isPlaybackShortcutAuthority } = usePlaybackCapability({
    identity,
    active: panelActive,
    lastFocusedAt,
    currentFrame,
    isPlaying,
    fallbackAuthority: identity.instanceId === "source",
    onSeek: (detail) => {
      if (!hasMedia) {
        return false;
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
      const video = videoRef.current;
      seekToFrame(
        usToMonitorFrame(detail.timeUs),
        detail.focusEndUs !== undefined,
        detail.focusEndUs === undefined,
      );
      if (detail.focusEndUs !== undefined && video) {
        startCuePlaybackFrameMonitor(video);
      }
      if (detail.play && video) {
        applyPlaybackMode(1, detail.focusEndUs !== undefined);
      }
      return true;
    },
  });

  useEffect(() => {
    const isShortcutScopeActive = () => {
      if (!panelActive || !isPlaybackShortcutAuthority) {
        return false;
      }
      const element = sourceMonitorRef.current;
      if (!element) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const suppressSpaceEvent = (event: KeyboardEvent) => {
      if ((event.code !== "Space" && event.key !== " ") || !isShortcutScopeActive()) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return true;
    };

    const isShuttleKey = (event: KeyboardEvent) =>
      event.code === "KeyJ" || event.code === "KeyK" || event.code === "KeyL";

    const suppressShuttleEvent = (event: KeyboardEvent) => {
      if (!isShuttleKey(event) || !isShortcutScopeActive()) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return true;
    };

    const heldSlowPlaybackMode = (): PlaybackMode | null => {
      if (!kKeyHeldRef.current || (!jKeyHeldRef.current && !lKeyHeldRef.current)) {
        return null;
      }
      if (jKeyHeldRef.current && !lKeyHeldRef.current) {
        return "slow-reverse";
      }
      if (lKeyHeldRef.current && !jKeyHeldRef.current) {
        return "slow-forward";
      }
      return lastShuttleDirectionHeldRef.current < 0 ? "slow-reverse" : "slow-forward";
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isShortcutScopeActive()) {
        return;
      }
      const isFrameStep = event.key === "ArrowLeft" || event.key === "ArrowRight";
      const isPlaybackToggle = event.code === "Space" || event.key === " ";
      if (isPlaybackToggle) {
        if (
          isEditableKeyboardTarget(event.target) ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        ) {
          return;
        }
        if (suppressSpaceEvent(event) && !event.repeat && hasMedia) {
          togglePlayback();
        }
        return;
      }
      if (isShuttleKey(event)) {
        if (
          isEditableKeyboardTarget(event.target) ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          !suppressShuttleEvent(event)
        ) {
          return;
        }
        if (event.code === "KeyK") {
          kKeyHeldRef.current = true;
        } else if (event.code === "KeyJ") {
          jKeyHeldRef.current = true;
          lastShuttleDirectionHeldRef.current = -1;
        } else {
          lKeyHeldRef.current = true;
          lastShuttleDirectionHeldRef.current = 1;
        }
        if (event.repeat || !hasMedia) {
          return;
        }
        const slowMode = heldSlowPlaybackMode();
        if (slowMode !== null) {
          applyPlaybackMode(slowMode);
        } else if (event.code === "KeyK") {
          applyPlaybackMode(0);
        } else {
          const currentRate: PlaybackRate =
            typeof playbackModeRef.current === "number" ? playbackModeRef.current : 0;
          const nextRate = nextShuttlePlaybackRate(currentRate, event.code === "KeyL" ? 1 : -1);
          if (nextRate !== currentRate) {
            applyPlaybackMode(nextRate);
          }
        }
        return;
      }
      if (
        !isFrameStep ||
        !hasMedia ||
        isEditableKeyboardTarget(event.target) ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      event.preventDefault();
      stepFrame(event.key === "ArrowLeft" ? -1 : 1);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "KeyK") {
        kKeyHeldRef.current = false;
      } else if (event.code === "KeyJ") {
        jKeyHeldRef.current = false;
      } else if (event.code === "KeyL") {
        lKeyHeldRef.current = false;
      }
      if (isSlowPlaybackMode(playbackModeRef.current)) {
        applyPlaybackMode(heldSlowPlaybackMode() ?? 0);
      }
      if (!isEditableKeyboardTarget(event.target)) {
        suppressSpaceEvent(event);
        suppressShuttleEvent(event);
      }
    };

    const onWindowBlur = () => {
      const wasSlowPlaying = isSlowPlaybackMode(playbackModeRef.current);
      kKeyHeldRef.current = false;
      jKeyHeldRef.current = false;
      lKeyHeldRef.current = false;
      if (wasSlowPlaying) {
        applyPlaybackMode(0);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [durationFrames, hasMedia, isPlaybackShortcutAuthority, panelActive]);

  function changePreviewMode(value: PreviewMode) {
    if (value === "source") {
      if (activeVideoOffline) {
        messagePublished("完整分辨率媒体已脱机，请先重新链接媒体。");
        return;
      }
      if (!useProxy) {
        return;
      }
      preservePreviewPlayback();
      sourcePreviewSelected();
      return;
    }
    if (!project || isGeneratingProxy) {
      return;
    }
    if (proxyPath) {
      if (useProxy) {
        return;
      }
      preservePreviewPlayback();
      proxyPreviewSelected();
      return;
    }
    sourcePreviewSelected();
    proxyDialogOpened();
  }

  function handleVideoError() {
    if (!useProxy && project) {
      if (proxyPath) {
        preservePreviewPlayback();
        proxyPreviewSelected();
        messagePublished("原文件无法直接播放，已切换到代理模式。");
      } else {
        pendingPreviewRestoreRef.current = null;
        proxyDialogOpened();
        messagePublished("原文件无法直接播放，请创建代理后预览。");
      }
    }
  }

  function clampMonitorFrame(valueFrame: number) {
    const roundedFrame = Number.isFinite(valueFrame) ? Math.round(valueFrame) : 0;
    return durationFrames > 0 ? clamp(roundedFrame, 0, durationFrames) : Math.max(0, roundedFrame);
  }

  function preservePreviewPlayback() {
    const pending = pendingPreviewRestoreRef.current;
    const frame = clampMonitorFrame(pending?.frame ?? playbackFrame());
    const preservedPlaybackMode = pending?.playbackMode ?? playbackModeRef.current;
    pendingPreviewRestoreRef.current = { frame, playbackMode: preservedPlaybackMode };
    currentFrameRef.current = frame;
    seekTargetFrameRef.current = frame;
    setCurrentFrame(frame);
    stopPlaybackTicker();
    manualPlaybackTickAtRef.current = null;
    pauseBoundAudio();
    stopRollingPcmAudio();
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
      stopCuePlaybackFrameMonitor();
      cuePlaybackPauseFrameRef.current = null;
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
    if (usesManualPlaybackClock(playbackModeRef.current)) {
      return seekTargetFrameRef.current;
    }
    if (videoRef.current && Number.isFinite(videoRef.current.currentTime)) {
      return usToMonitorFrame(videoRef.current.currentTime * 1_000_000);
    }
    return currentFrameRef.current;
  }

  function syncCurrentTimeFromVideo(element: HTMLVideoElement) {
    if (cuePlaybackPauseFrameRef.current !== null) {
      return;
    }
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
    if (cuePlaybackEndFrame !== null && !cuePlaybackUsesVideoFrameCallbackRef.current) {
      const reachedCueEnd =
        element.currentTime * 1_000_000 >= frameToClampedUs(cuePlaybackEndFrame);
      centerTimelineIfFrameHidden(reachedCueEnd ? cuePlaybackEndFrame : nextFrame);
      if (reachedCueEnd) {
        finishCuePlaybackAtFrame(element, cuePlaybackEndFrame);
        return;
      }
    }

    seekTargetFrameRef.current = nextFrame;
    currentFrameRef.current = nextFrame;
    setCurrentFrame(nextFrame);
    if (!pcmPlaybackConfig(playbackModeRef.current, frameRate)) {
      syncBoundAudio(element);
    }
    finishVideoSeek(element);
  }

  function syncBoundAudio(video: HTMLVideoElement, force = false) {
    for (const audio of boundAudioRefs.current.values()) {
      if (force || Math.abs(audio.currentTime - video.currentTime) > 0.16) {
        try {
          audio.currentTime = video.currentTime;
        } catch {
          // The browser may reject a seek until metadata is available.
        }
      }
      audio.preservesPitch = true;
      audio.playbackRate = video.playbackRate;
    }
  }

  function playBoundAudio(video: HTMLVideoElement) {
    if (video.playbackRate > 4) {
      pauseBoundAudio();
      return;
    }
    syncBoundAudio(video, true);
    for (const audio of boundAudioRefs.current.values()) {
      runBackgroundOperation("media.playback", () => audio.play());
    }
  }

  function pauseBoundAudio() {
    for (const audio of boundAudioRefs.current.values()) {
      audio.pause();
    }
  }

  function rollingPcmAudioController() {
    rollingPcmAudioRef.current ??= new RollingPcmAudioController();
    return rollingPcmAudioRef.current;
  }

  function playRollingPcmAudio(mode: PlaybackMode) {
    const config = pcmPlaybackConfig(mode, frameRate);
    if (!config) {
      stopRollingPcmAudio();
      return;
    }
    const sourceTimeSeconds = usesManualPlaybackClock(mode)
      ? manualPlaybackFrameRef.current / frameRate
      : (videoRef.current?.currentTime ?? currentFrameRef.current / frameRate);
    void rollingPcmAudioController().play({
      sources: rollingPcmSources,
      sourceTimeSeconds,
      durationSeconds: Math.max(0, durationUs / 1_000_000),
      playbackRate: config.playbackRate,
      direction: config.direction,
      algorithm: config.algorithm,
    });
  }

  function stopRollingPcmAudio() {
    rollingPcmAudioRef.current?.stop();
  }

  function handleVideoDragOver(event: DragEvent<HTMLDivElement>) {
    const hasSupportedDragType =
      Boolean(activeMediaDragVideoId()) ||
      event.dataTransfer.types.includes("application/x-linecut-video") ||
      event.dataTransfer.types.includes("application/x-linecut-media") ||
      event.dataTransfer.types.includes("text/plain");
    if (!hasSupportedDragType) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsVideoDragOver(true);
  }

  function handleVideoDrop(event: DragEvent<HTMLDivElement>) {
    const directVideoId = event.dataTransfer.getData("application/x-linecut-video");
    const serializedIds =
      event.dataTransfer.getData("application/x-linecut-media") ||
      event.dataTransfer.getData("text/plain");
    let draggedIds: string[] = [];
    if (serializedIds) {
      try {
        const parsed = JSON.parse(serializedIds);
        draggedIds = Array.isArray(parsed)
          ? parsed.filter((itemId): itemId is string => typeof itemId === "string")
          : [];
      } catch {
        draggedIds = [serializedIds];
      }
    }
    const videoId =
      directVideoId ||
      activeMediaDragVideoId() ||
      draggedIds.find((itemId) =>
        mediaItems.some(
          (item) => item.id === itemId && item.kind === "video" && isMediaItemEnabled(item),
        ),
      );
    setIsVideoDragOver(false);
    if (
      !videoId ||
      !mediaItems.some(
        (item) => item.id === videoId && item.kind === "video" && isMediaItemEnabled(item),
      )
    ) {
      return;
    }
    event.preventDefault();
    markMediaDragHandled();
    activeVideoChanged(videoId);
  }

  function stopPlaybackTicker() {
    if (playbackTickRef.current !== null) {
      cancelAnimationFrame(playbackTickRef.current);
      playbackTickRef.current = null;
    }
  }

  function stopCuePlaybackFrameMonitor() {
    const activeCallback = cuePlaybackVideoFrameCallbackRef.current;
    cuePlaybackVideoFrameCallbackRef.current = null;
    cuePlaybackUsesVideoFrameCallbackRef.current = false;
    if (activeCallback) {
      activeCallback.video.cancelVideoFrameCallback(activeCallback.callbackId);
    }
  }

  function startCuePlaybackFrameMonitor(video: HTMLVideoElement) {
    stopCuePlaybackFrameMonitor();
    if (
      cuePlaybackEndFrameRef.current === null ||
      typeof video.requestVideoFrameCallback !== "function"
    ) {
      return;
    }

    cuePlaybackUsesVideoFrameCallbackRef.current = true;
    const monitorPresentedFrame: VideoFrameRequestCallback = (_now, metadata) => {
      cuePlaybackVideoFrameCallbackRef.current = null;
      const cueEndFrame = cuePlaybackEndFrameRef.current;
      if (videoRef.current !== video || cueEndFrame === null || video.paused || video.ended) {
        cuePlaybackUsesVideoFrameCallbackRef.current = false;
        return;
      }

      const presentedFrame = usToMonitorFrame(metadata.mediaTime * 1_000_000);
      if (presentedFrame >= cueEndFrame) {
        finishCuePlaybackAtFrame(video, cueEndFrame);
        return;
      }

      const callbackId = video.requestVideoFrameCallback(monitorPresentedFrame);
      cuePlaybackVideoFrameCallbackRef.current = { video, callbackId };
    };
    const callbackId = video.requestVideoFrameCallback(monitorPresentedFrame);
    cuePlaybackVideoFrameCallbackRef.current = { video, callbackId };
  }

  function finishCuePlaybackAtFrame(video: HTMLVideoElement, endFrame: number) {
    stopCuePlaybackTickerAndFrameMonitor();
    cuePlaybackEndFrameRef.current = null;
    cuePlaybackPauseFrameRef.current = endFrame;
    seekTargetFrameRef.current = endFrame;
    currentFrameRef.current = endFrame;
    centerTimelineIfFrameHidden(endFrame);
    setCurrentFrame(endFrame);
    commitPlaybackMode(0);
    pauseBoundAudio();
    stopRollingPcmAudio();
    video.pause();
  }

  function stopCuePlaybackTickerAndFrameMonitor() {
    stopPlaybackTicker();
    stopCuePlaybackFrameMonitor();
  }

  function startPlaybackTicker() {
    stopPlaybackTicker();
    const tick = () => {
      const video = videoRef.current;
      const mode = playbackModeRef.current;
      const isNativeForwardPlayback = typeof mode === "number" && mode > 0;
      if (!video || !isNativeForwardPlayback || video.paused || video.ended) {
        if (isNativeForwardPlayback) {
          commitPlaybackMode(0);
          pauseBoundAudio();
          stopRollingPcmAudio();
        }
        playbackTickRef.current = null;
        return;
      }
      syncCurrentTimeFromVideo(video);
      playbackTickRef.current = requestAnimationFrame(tick);
    };
    playbackTickRef.current = requestAnimationFrame(tick);
  }

  function startManualPlaybackTicker(video: HTMLVideoElement) {
    stopPlaybackTicker();
    manualPlaybackTickAtRef.current = performance.now();

    const tick = (now: number) => {
      const mode = playbackModeRef.current;
      if (videoRef.current !== video || !usesManualPlaybackClock(mode)) {
        playbackTickRef.current = null;
        manualPlaybackTickAtRef.current = null;
        return;
      }

      const previousTickAt = manualPlaybackTickAtRef.current ?? now;
      manualPlaybackTickAtRef.current = now;
      const elapsedSeconds = Math.max(0, (now - previousTickAt) / 1000);
      const effectiveRate = effectivePlaybackRate(mode, frameRate);
      const nextFrame = clamp(
        manualPlaybackFrameRef.current + elapsedSeconds * frameRate * effectiveRate,
        0,
        durationFrames,
      );
      manualPlaybackFrameRef.current = nextFrame;
      const targetFrame = clampMonitorFrame(
        effectiveRate < 0 ? Math.ceil(nextFrame) : Math.floor(nextFrame),
      );
      if (targetFrame !== seekTargetFrameRef.current) {
        seekToFrame(targetFrame);
      }
      const reachedPlaybackEdge =
        (effectiveRate < 0 && nextFrame <= 0) || (effectiveRate > 0 && nextFrame >= durationFrames);
      if (reachedPlaybackEdge) {
        playbackTickRef.current = null;
        manualPlaybackTickAtRef.current = null;
        commitPlaybackMode(0);
        pauseBoundAudio();
        stopRollingPcmAudio();
        centerTimelineIfFrameHidden(targetFrame);
        return;
      }
      playbackTickRef.current = requestAnimationFrame(tick);
    };

    playbackTickRef.current = requestAnimationFrame(tick);
  }

  function commitPlaybackMode(nextMode: PlaybackMode) {
    playbackModeRef.current = nextMode;
    setPlaybackMode(nextMode);
  }

  function applyPlaybackMode(nextMode: PlaybackMode, preserveCuePlaybackEnd = false) {
    const video = videoRef.current;
    if (!hasMedia || !video) {
      commitPlaybackMode(0);
      stopRollingPcmAudio();
      return;
    }

    if (!preserveCuePlaybackEnd) {
      stopCuePlaybackFrameMonitor();
      cuePlaybackPauseFrameRef.current = null;
      cuePlaybackEndFrameRef.current = null;
    }

    const currentMode = playbackModeRef.current;
    if (nextMode === 0) {
      const pausedAtFrame = playbackFrame();
      commitPlaybackMode(0);
      stopPlaybackTicker();
      manualPlaybackTickAtRef.current = null;
      if (!video.paused) {
        video.pause();
      }
      pauseBoundAudio();
      stopRollingPcmAudio();
      centerTimelineIfFrameHidden(pausedAtFrame);
      return;
    }

    if (usesManualPlaybackClock(nextMode)) {
      const manualOriginFrame = usesManualPlaybackClock(currentMode)
        ? manualPlaybackFrameRef.current
        : playbackFrame();
      commitPlaybackMode(nextMode);
      manualPlaybackFrameRef.current = manualOriginFrame;
      if (!video.paused) {
        video.pause();
      }
      video.muted = true;
      pauseBoundAudio();
      if (pcmPlaybackConfig(nextMode, frameRate)) {
        playRollingPcmAudio(nextMode);
      } else {
        stopRollingPcmAudio();
      }
      startManualPlaybackTicker(video);
      return;
    }

    if (typeof nextMode !== "number" || nextMode <= 0) {
      return;
    }
    commitPlaybackMode(nextMode);
    manualPlaybackTickAtRef.current = null;
    if (usesManualPlaybackClock(currentMode)) {
      stopPlaybackTicker();
      seekToFrame(manualPlaybackFrameRef.current, preserveCuePlaybackEnd);
    }
    if (video.ended && durationFrames > 0) {
      seekToFrame(0, preserveCuePlaybackEnd);
    }
    video.preservesPitch = true;
    video.playbackRate = nextMode;
    video.muted = shouldMuteVideo(nextMode);
    if (pcmPlaybackConfig(nextMode, frameRate)) {
      pauseBoundAudio();
      playRollingPcmAudio(nextMode);
    } else if (nextMode > 4) {
      pauseBoundAudio();
      stopRollingPcmAudio();
    } else if (video.paused) {
      stopRollingPcmAudio();
      syncBoundAudio(video, true);
    } else {
      stopRollingPcmAudio();
      playBoundAudio(video);
    }
    void runOperation("media.playback", () => video.play()).then((outcome) => {
      if (outcome.status !== "success" && playbackModeRef.current === nextMode && video.paused) {
        commitPlaybackMode(0);
        pauseBoundAudio();
        stopRollingPcmAudio();
      }
    });
  }

  function handleLoadedMetadata(element: HTMLVideoElement) {
    element.preservesPitch = true;
    element.muted = shouldMuteVideo(playbackModeRef.current);
    const restore = pendingPreviewRestoreRef.current;
    const restoredFrame = clampMonitorFrame(restore?.frame ?? currentFrame);
    seekTargetFrameRef.current = restoredFrame;
    const restorePlayback = () => {
      if (pendingPreviewRestoreRef.current !== restore) {
        return;
      }
      pendingPreviewRestoreRef.current = null;
      if (!restore || restore.playbackMode === 0) {
        return;
      }
      applyPlaybackMode(restore.playbackMode);
    };
    if (usToMonitorFrame(element.currentTime * 1_000_000) !== restoredFrame) {
      element.addEventListener("seeked", restorePlayback, { once: true });
      try {
        element.currentTime = frameToClampedUs(restoredFrame) / 1_000_000;
      } catch {
        element.removeEventListener("seeked", restorePlayback);
        restorePlayback();
      }
      return;
    }
    restorePlayback();
  }

  function togglePlayback() {
    applyPlaybackMode(playbackModeRef.current === 0 ? 1 : 0);
  }

  function pausePlaybackForPreciseSeek() {
    applyPlaybackMode(0);
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

  function shouldMuteVideo(mode: PlaybackMode) {
    const effectiveRate = effectivePlaybackRate(mode, frameRate);
    return (
      (sourceAudioDetached && !primaryVirtualAudioEnabled) ||
      Boolean(pcmPlaybackConfig(mode, frameRate)) ||
      Math.abs(effectiveRate) > 4
    );
  }

  return (
    <div
      ref={sourceMonitorRef}
      className={`source-monitor ${hasMedia ? "" : "empty-state"} ${
        isVideoDragOver ? "video-drag-over" : ""
      }`}
      onDragEnter={handleVideoDragOver}
      onDragOver={handleVideoDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsVideoDragOver(false);
        }
      }}
      onDrop={handleVideoDrop}
    >
      <VideoDisplay
        key={mediaKey}
        stageRef={videoStageRef}
        videoRef={videoRef}
        videoSrc={videoSrc}
        muted={shouldMuteVideo(playbackMode)}
        zoomLevel={zoomLevel}
        zoomPan={zoomPan}
        onVideoError={handleVideoError}
        onLoadedMetadata={handleLoadedMetadata}
        onSyncCurrentTime={syncCurrentTimeFromVideo}
        onPlay={(video) => {
          const activePlaybackMode = playbackModeRef.current;
          cuePlaybackPauseFrameRef.current = null;
          if (usesManualPlaybackClock(activePlaybackMode)) {
            video.pause();
            return;
          }
          if (typeof activePlaybackMode !== "number" || activePlaybackMode <= 0) {
            video.pause();
            return;
          }
          video.preservesPitch = true;
          video.playbackRate = activePlaybackMode;
          video.muted = shouldMuteVideo(activePlaybackMode);
          syncCurrentTimeFromVideo(video);
          if (pcmPlaybackConfig(activePlaybackMode, frameRate)) {
            pauseBoundAudio();
          } else if (activePlaybackMode > 4) {
            pauseBoundAudio();
            stopRollingPcmAudio();
          } else {
            stopRollingPcmAudio();
            playBoundAudio(video);
          }
          startPlaybackTicker();
          startCuePlaybackFrameMonitor(video);
        }}
        onPause={(video) => {
          const cuePauseFrame = cuePlaybackPauseFrameRef.current;
          cuePlaybackPauseFrameRef.current = null;
          stopCuePlaybackFrameMonitor();
          cuePlaybackEndFrameRef.current = null;
          if (pendingPreviewRestoreRef.current) {
            stopPlaybackTicker();
            manualPlaybackTickAtRef.current = null;
            pauseBoundAudio();
            return;
          }
          if (usesManualPlaybackClock(playbackModeRef.current)) {
            pauseBoundAudio();
            return;
          }
          stopPlaybackTicker();
          manualPlaybackTickAtRef.current = null;
          if (cuePauseFrame !== null) {
            seekTargetFrameRef.current = cuePauseFrame;
            currentFrameRef.current = cuePauseFrame;
            setCurrentFrame(cuePauseFrame);
            pauseBoundAudio();
            stopRollingPcmAudio();
            commitPlaybackMode(0);
            return;
          }
          syncCurrentTimeFromVideo(video);
          pauseBoundAudio();
          stopRollingPcmAudio();
          commitPlaybackMode(0);
        }}
      />
      <div className="bound-audio-stack" aria-hidden="true">
        {boundAudioSources.map((source) => (
          <BoundAudioElement
            key={source.itemId}
            itemId={source.itemId}
            path={source.path}
            audioTrackIndex={source.audioTrackIndex}
            onElementChanged={registerBoundAudioElement}
          />
        ))}
      </div>
      {isVideoDragOver && <div className="source-drop-overlay">释放以载入源预览</div>}
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
