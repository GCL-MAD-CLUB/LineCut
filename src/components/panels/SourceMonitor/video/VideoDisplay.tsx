import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { useSourceMonitorState, type MonitorZoomLevel, type ZoomPan } from "../sourceMonitorState";
import { TransientVideoPreview, type TransientVideoFrame } from "./TransientVideoPreview";
import type { FrameHistogram } from "../../../../core/editor/frameHistogram";
import { useVideoHistogram } from "../histogram/useVideoHistogram";
import { useVideoFrameTrace } from "../histogram/useVideoFrameTrace";
import { frameTraceCacheKey } from "../../../../application/media/frameTraceCache";

interface VideoDisplayProps {
  stageRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  videoSrc: string | null;
  transientPreview?: TransientVideoFrame | null;
  frameRate: number;
  muted: boolean;
  zoomLevel: MonitorZoomLevel;
  zoomPan: ZoomPan;
  onVideoError: () => void;
  onLoadedMetadata: (video: HTMLVideoElement) => void;
  onSyncCurrentTime: (video: HTMLVideoElement) => void;
  onPlay: (video: HTMLVideoElement) => void;
  onPause: (video: HTMLVideoElement) => void;
  onHistogram: (source: string | null, histogram: FrameHistogram | null) => void;
  histogramEnabled: boolean;
  traceEnabled: boolean;
  traceFingerprint?: string;
  traceAssetId?: string;
}

interface VideoLayer {
  id: number;
  source: string;
  transform: string;
}

interface VideoLayers {
  requestedSource: string | null;
  current: VideoLayer | null;
  displayed: VideoLayer | null;
  nextId: number;
}

function currentVideo(event: SyntheticEvent<HTMLVideoElement>) {
  return event.currentTarget;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function pointerOffsetFromStageCenter(event: WheelEvent, stageRect: DOMRect) {
  return {
    x: event.clientX - (stageRect.left + stageRect.width / 2),
    y: event.clientY - (stageRect.top + stageRect.height / 2),
  };
}

export function VideoDisplay({
  stageRef,
  videoRef,
  videoSrc,
  transientPreview,
  frameRate,
  muted,
  zoomLevel,
  zoomPan,
  onVideoError,
  onLoadedMetadata,
  onSyncCurrentTime,
  onPlay,
  onPause,
  onHistogram,
  histogramEnabled,
  traceEnabled,
  traceFingerprint,
  traceAssetId,
}: VideoDisplayProps) {
  const setZoomLevel = useSourceMonitorState((state) => state.setZoomLevel);
  const setZoomPan = useSourceMonitorState((state) => state.setZoomPan);
  const zoomLevelRef = useRef(zoomLevel);
  const zoomPanRef = useRef(zoomPan);
  const requestedSource = videoSrc || null;
  const zoomScale = zoomLevel === "fit" ? 1 : zoomLevel / 100;
  const currentZoomPan = zoomLevel === "fit" ? { x: 0, y: 0 } : zoomPan;
  const transform = `translate(${currentZoomPan.x}px, ${currentZoomPan.y}px) scale(${zoomScale})`;
  const [layers, setLayers] = useState<VideoLayers>(() => ({
    requestedSource,
    current: requestedSource ? { id: 0, source: requestedSource, transform } : null,
    displayed: null,
    nextId: 1,
  }));
  const displayedTransformRef = useRef(transform);
  if (layers.requestedSource === requestedSource && layers.current?.id === layers.displayed?.id) {
    displayedTransformRef.current = transform;
  }
  if (layers.requestedSource !== requestedSource) {
    const displayed = layers.displayed
      ? { ...layers.displayed, transform: displayedTransformRef.current }
      : null;
    const current = requestedSource
      ? displayed?.source === requestedSource
        ? displayed
        : { id: layers.nextId, source: requestedSource, transform }
      : null;
    setLayers({
      requestedSource,
      current,
      displayed: requestedSource ? displayed : null,
      nextId: layers.nextId + (current?.id === layers.nextId ? 1 : 0),
    });
  }
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const frameRateRef = useRef(frameRate);
  frameRateRef.current = frameRate;
  const videosRef = useRef(new Map<number, HTMLVideoElement>());
  const histogramVideoRef = useRef<HTMLVideoElement | null>(null);
  histogramVideoRef.current = layers.displayed
    ? (videosRef.current.get(layers.displayed.id) ?? null)
    : null;
  useVideoHistogram(
    histogramVideoRef,
    layers.displayed?.id ?? null,
    histogramEnabled && !transientPreview,
    (histogram) => onHistogram(layers.displayed?.source ?? null, histogram),
  );
  const bindingsRef = useRef(new Map<number, (video: HTMLVideoElement | null) => void>());
  useVideoFrameTrace(
    histogramVideoRef,
    layers.displayed?.id ?? null,
    frameRate,
    traceEnabled && !transientPreview && layers.displayed?.source === requestedSource,
    () => {},
    frameTraceCacheKey(layers.displayed?.source ?? "", frameRate, traceFingerprint, traceAssetId),
  );
  const pendingFrameRef = useRef<{ video: HTMLVideoElement; id: number } | null>(null);
  const pendingRevealRef = useRef<number | null>(null);
  const presentedFrameRef = useRef<{ video: HTMLVideoElement; time: number } | null>(null);

  function finishIncomingFrame(video: HTMLVideoElement) {
    const current = layersRef.current.current;
    if (!current || video !== videoRef.current || video.readyState < 2 || video.seeking)
      return false;
    if (typeof video.requestVideoFrameCallback === "function") {
      const presented = presentedFrameRef.current;
      if (
        !presented ||
        presented.video !== video ||
        Math.abs(presented.time - video.currentTime) > 1 / Math.max(1, frameRateRef.current)
      )
        return false;
    }
    setLayers((state) =>
      state.current?.id === current.id && state.displayed?.id !== current.id
        ? { ...state, displayed: { ...state.current, transform: transformRef.current } }
        : state,
    );
    const pending = pendingFrameRef.current;
    if (pending?.video === video) {
      pending.video.cancelVideoFrameCallback(pending.id);
      pendingFrameRef.current = null;
    }
    if (pendingRevealRef.current !== null) {
      cancelAnimationFrame(pendingRevealRef.current);
      pendingRevealRef.current = null;
    }
    return true;
  }

  function watchIncomingFrame(video: HTMLVideoElement) {
    if (
      video !== videoRef.current ||
      layersRef.current.displayed?.id === layersRef.current.current?.id
    )
      return;
    if (typeof video.requestVideoFrameCallback === "function" && finishIncomingFrame(video)) return;
    if (pendingFrameRef.current?.video === video || pendingRevealRef.current !== null) return;
    if (typeof video.requestVideoFrameCallback === "function") {
      const id = video.requestVideoFrameCallback((_now, metadata) => {
        if (video !== videoRef.current) return;
        pendingFrameRef.current = null;
        presentedFrameRef.current = { video, time: metadata.mediaTime };
        if (!finishIncomingFrame(video)) watchIncomingFrame(video);
      });
      pendingFrameRef.current = { video, id };
    } else if (video.readyState >= 2 && !video.seeking) {
      pendingRevealRef.current = requestAnimationFrame(() => {
        pendingRevealRef.current = requestAnimationFrame(() => {
          pendingRevealRef.current = null;
          finishIncomingFrame(video);
        });
      });
    }
  }

  const bindVideo = useCallback(
    (id: number, video: HTMLVideoElement | null) => {
      const previous = videosRef.current.get(id);
      const pending = pendingFrameRef.current;
      if (!video && pending && pending.video === previous) {
        pending.video.cancelVideoFrameCallback(pending.id);
        pendingFrameRef.current = null;
      }
      if (!video && previous === videoRef.current && pendingRevealRef.current !== null) {
        cancelAnimationFrame(pendingRevealRef.current);
        pendingRevealRef.current = null;
      }
      if (video) {
        videosRef.current.set(id, video);
        if (id === layersRef.current.current?.id) {
          videoRef.current = video;
          watchIncomingFrame(video);
        }
      } else {
        videosRef.current.delete(id);
        if (previous === videoRef.current) videoRef.current = null;
      }
      if (previous && previous !== video) {
        // Ref callbacks are replayed in StrictMode without removing the element.
        queueMicrotask(() => {
          if (!previous.isConnected && previous !== videoRef.current) {
            previous.pause();
            previous.removeAttribute("src");
            previous.load();
            bindingsRef.current.delete(id);
          }
        });
      }
    },
    [videoRef],
  );

  function layerBinding(id: number) {
    let binding = bindingsRef.current.get(id);
    if (!binding) {
      binding = (video) => bindVideo(id, video);
      bindingsRef.current.set(id, binding);
    }
    return binding;
  }

  useLayoutEffect(() => {
    const video = layers.current && videosRef.current.get(layers.current.id);
    videoRef.current = video ?? null;
    const pending = pendingFrameRef.current;
    if (pending && pending.video !== video) {
      pending.video.cancelVideoFrameCallback(pending.id);
      pendingFrameRef.current = null;
    }
    if (pendingRevealRef.current !== null) {
      cancelAnimationFrame(pendingRevealRef.current);
      pendingRevealRef.current = null;
    }
    for (const candidate of videosRef.current.values()) {
      if (candidate !== video && !candidate.paused) candidate.pause();
    }
    if (!video) return;
    watchIncomingFrame(video);
  }, [layers.current?.id, videoRef]);

  function handleVideoEvent(
    event: SyntheticEvent<HTMLVideoElement>,
    handler: (video: HTMLVideoElement) => void,
  ) {
    const video = currentVideo(event);
    if (video === videoRef.current) handler(video);
  }

  useEffect(() => {
    zoomLevelRef.current = zoomLevel;
  }, [zoomLevel]);

  useEffect(() => {
    zoomPanRef.current = zoomPan;
  }, [zoomPan]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      focusStage(stage);
      handleVideoWheel(event, stage);
    };

    stage.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => stage.removeEventListener("wheel", handleWheel, true);
  }, [stageRef]);

  function focusStage(stage = stageRef.current) {
    if (!stage || document.activeElement === stage) {
      return;
    }
    try {
      stage.focus({ preventScroll: true });
    } catch {
      stage.focus();
    }
  }

  function handleVideoWheel(event: WheelEvent, stage: HTMLDivElement) {
    const hasMedia = Boolean(layersRef.current.requestedSource);
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
      zoomVideo(delta, pointerOffsetFromStageCenter(event, stage.getBoundingClientRect()));
    } else if (useCenterOrigin) {
      zoomVideo(delta, { x: 0, y: 0 });
    }
  }

  function zoomVideo(delta: number, pointer: { x: number; y: number }) {
    const currentLevel = zoomLevelRef.current;
    const currentPan = zoomPanRef.current;
    const numeric = currentLevel === "fit" ? 100 : currentLevel;
    const k = delta < 0 ? 1.12 : 1 / 1.12;
    const nextNumeric = Math.round(clamp(numeric * k, 10, 1600));
    const actualK = nextNumeric / numeric;
    const nextPan = {
      x: actualK * currentPan.x + (1 - actualK) * pointer.x,
      y: actualK * currentPan.y + (1 - actualK) * pointer.y,
    };
    zoomLevelRef.current = nextNumeric;
    zoomPanRef.current = nextPan;
    setZoomLevel(nextNumeric);
    setZoomPan(nextPan);
  }

  return (
    <div
      ref={stageRef}
      className="source-video-stage"
      data-source-monitor-drop-target
      tabIndex={-1}
      onPointerDown={() => focusStage()}
    >
      {(layers.displayed && layers.displayed.id !== layers.current?.id
        ? [layers.displayed, ...(layers.current ? [layers.current] : [])]
        : layers.current
          ? [layers.current]
          : []
      ).map((layer) => (
        <video
          key={layer.id}
          ref={layerBinding(layer.id)}
          crossOrigin="anonymous"
          src={layer.source}
          className={`source-video-layer ${layer.id === layers.displayed?.id ? "visible" : "loading"}`}
          muted={layer.id !== layers.current?.id || muted}
          controls={false}
          preload="auto"
          onError={(event) => handleVideoEvent(event, onVideoError)}
          onLoadedMetadata={(event) =>
            handleVideoEvent(event, (video) => {
              onLoadedMetadata(video);
              watchIncomingFrame(video);
            })
          }
          onLoadedData={(event) => handleVideoEvent(event, watchIncomingFrame)}
          onCanPlay={(event) => handleVideoEvent(event, watchIncomingFrame)}
          onTimeUpdate={(event) => handleVideoEvent(event, onSyncCurrentTime)}
          onSeeked={(event) =>
            handleVideoEvent(event, (video) => {
              onSyncCurrentTime(video);
              watchIncomingFrame(video);
            })
          }
          onPlay={(event) => handleVideoEvent(event, onPlay)}
          onPause={(event) => handleVideoEvent(event, onPause)}
          style={
            {
              transform: layer.id === layers.current?.id ? transform : layer.transform,
              transformOrigin: "50% 50%",
            } as CSSProperties
          }
        />
      ))}
      {transientPreview && (
        <TransientVideoPreview
          key={`${transientPreview.sessionId}:${transientPreview.src}`}
          preview={transientPreview}
          histogramEnabled={histogramEnabled}
          onHistogram={(histogram) => onHistogram(requestedSource, histogram)}
          style={{ transform, transformOrigin: "50% 50%" }}
        />
      )}
    </div>
  );
}
