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
  isVirtualMediaItem,
  mediaItemProject,
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
import { useSourceMonitorState } from "./sourceMonitorState";

const previewModeOptions = ["source", "proxy"] as const;
const previewModeLabels: Record<(typeof previewModeOptions)[number], string> = {
  source: "完整",
  proxy: "代理",
};
type PreviewMode = (typeof previewModeOptions)[number];

interface PendingPreviewRestore {
  frame: number;
  resumePlayback: boolean;
}

interface BoundAudioElementProps {
  itemId: string;
  path: string;
  audioTrackIndex: number;
  onElementChanged: (itemId: string, element: HTMLAudioElement | null) => void;
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
    isPlaying,
    setIsPlaying,
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
  const sourceMonitorRef = useRef<HTMLDivElement | null>(null);
  const videoStageRef = useRef<HTMLDivElement | null>(null);
  const seekTargetFrameRef = useRef(0);
  const pendingVideoSeekFrameRef = useRef<number | null>(null);
  const videoSeekInFlightRef = useRef(false);
  const lastSeekCommandAtRef = useRef(0);
  const playbackTickRef = useRef<number | null>(null);
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
      boundAudioRefs.current.set(itemId, element);
      const video = videoRef.current;
      if (!video || video.paused || video.ended) {
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
  const boundAudioItems = useMemo(
    () =>
      mediaItems.filter((item) => {
        const sourceVideo = item.source_video_id
          ? mediaItems.find((candidate) => candidate.id === item.source_video_id)
          : null;
        return (
          item.kind === "audio" &&
          isMediaItemEnabled(item) &&
          !isMediaItemOffline(item) &&
          !Boolean(sourceVideo && isMediaItemOffline(sourceVideo)) &&
          item.bound_to_video_id === activeVideoId
        );
      }),
    [activeVideoId, mediaItems],
  );
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
  const primaryVirtualAudioEnabled = Boolean(
    project &&
    boundAudioItems.some(
      (item) =>
        isVirtualMediaItem(item) &&
        item.source_video_id === project.asset.id &&
        item.stream_index === project.asset.audio_stream_index,
    ),
  );
  const boundAudioSources = useMemo(
    () =>
      boundAudioItems.flatMap((item) => {
        if (!isVirtualMediaItem(item)) {
          return item.path ? [{ itemId: item.id, path: item.path, audioTrackIndex: 0 }] : [];
        }
        const sourceProject = mediaItemProject(item, projects, mediaItems);
        if (!sourceProject) {
          return [];
        }
        if (
          sourceProject.asset.id === project?.asset.id &&
          item.stream_index === sourceProject.asset.audio_stream_index
        ) {
          return [];
        }
        const audioTrackIndex = sourceProject.streams
          .filter((stream) => stream.codec_type === "audio")
          .findIndex((stream) => stream.index === item.stream_index);
        return audioTrackIndex >= 0
          ? [{ itemId: item.id, path: sourceProject.asset.path, audioTrackIndex }]
          : [];
      }),
    [boundAudioItems, mediaItems, project?.asset.id, projects],
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
  const videoSrc = useMemo(() => {
    if (!project) {
      return "";
    }
    const path = useProxy ? proxyPath : activeVideoOffline ? "" : project.asset.path;
    return path ? convertFileSrc(path) : "";
  }, [activeVideoOffline, project, proxyPath, useProxy]);
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

  usePlaybackCapability({
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
      seekToFrame(
        usToMonitorFrame(detail.timeUs),
        detail.focusEndUs !== undefined,
        detail.focusEndUs === undefined,
      );
      if (detail.play) {
        const video = videoRef.current;
        if (video) {
          runBackgroundOperation("media.playback", () => video.play());
        }
      }
      return true;
    },
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
    const video = videoRef.current;
    const pending = pendingPreviewRestoreRef.current;
    const frame = clampMonitorFrame(pending?.frame ?? playbackFrame());
    const resumePlayback =
      pending?.resumePlayback ?? Boolean(video && !video.paused && !video.ended);
    pendingPreviewRestoreRef.current = { frame, resumePlayback };
    currentFrameRef.current = frame;
    seekTargetFrameRef.current = frame;
    setCurrentFrame(frame);
    stopPlaybackTicker();
    pauseBoundAudio();
    if (resumePlayback) {
      setIsPlaying(true);
    }
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
    syncBoundAudio(element);
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
      audio.playbackRate = video.playbackRate;
    }
  }

  function playBoundAudio(video: HTMLVideoElement) {
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

  function startPlaybackTicker() {
    stopPlaybackTicker();
    const tick = () => {
      const video = videoRef.current;
      if (!video || video.paused || video.ended) {
        setIsPlaying(false);
        playbackTickRef.current = null;
        return;
      }
      syncCurrentTimeFromVideo(video);
      playbackTickRef.current = requestAnimationFrame(tick);
    };
    playbackTickRef.current = requestAnimationFrame(tick);
  }

  function handleLoadedMetadata(element: HTMLVideoElement) {
    const restore = pendingPreviewRestoreRef.current;
    const restoredFrame = clampMonitorFrame(restore?.frame ?? currentFrame);
    seekTargetFrameRef.current = restoredFrame;
    const resumePlayback = () => {
      if (pendingPreviewRestoreRef.current !== restore) {
        return;
      }
      pendingPreviewRestoreRef.current = null;
      if (!restore?.resumePlayback) {
        return;
      }
      void runOperation("media.playback", () => element.play()).then((outcome) => {
        if (outcome.status !== "success") {
          setIsPlaying(false);
        }
      });
    };
    if (usToMonitorFrame(element.currentTime * 1_000_000) !== restoredFrame) {
      element.addEventListener("seeked", resumePlayback, { once: true });
      try {
        element.currentTime = frameToClampedUs(restoredFrame) / 1_000_000;
      } catch {
        element.removeEventListener("seeked", resumePlayback);
        resumePlayback();
      }
      return;
    }
    resumePlayback();
  }

  function togglePlayback() {
    if (!hasMedia || !videoRef.current) {
      return;
    }
    cuePlaybackEndFrameRef.current = null;
    if (videoRef.current.paused) {
      const video = videoRef.current;
      runBackgroundOperation("media.playback", () => video.play());
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
        project={project}
        stageRef={videoStageRef}
        videoRef={videoRef}
        videoSrc={videoSrc}
        unavailableMessage={
          activeVideoOffline && !useProxy ? "媒体脱机，请通过右键菜单重新链接媒体" : undefined
        }
        muted={sourceAudioDetached && !primaryVirtualAudioEnabled}
        zoomLevel={zoomLevel}
        zoomPan={zoomPan}
        onVideoError={handleVideoError}
        onLoadedMetadata={handleLoadedMetadata}
        onSyncCurrentTime={syncCurrentTimeFromVideo}
        onPlay={(video) => {
          syncCurrentTimeFromVideo(video);
          playBoundAudio(video);
          setIsPlaying(true);
          startPlaybackTicker();
        }}
        onPause={(video) => {
          cuePlaybackEndFrameRef.current = null;
          stopPlaybackTicker();
          if (pendingPreviewRestoreRef.current) {
            pauseBoundAudio();
            setIsPlaying(pendingPreviewRestoreRef.current.resumePlayback);
            return;
          }
          syncCurrentTimeFromVideo(video);
          pauseBoundAudio();
          setIsPlaying(false);
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
