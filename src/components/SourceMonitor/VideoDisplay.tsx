import { FileVideo } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
  type SyntheticEvent,
} from "react";
import type { Project } from "../../types";
import { useSourceMonitorState, type MonitorZoomLevel, type ZoomPan } from "./sourceMonitorState";

interface VideoDisplayProps {
  project: Project | null;
  stageRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  videoSrc: string | null;
  zoomLevel: MonitorZoomLevel;
  zoomPan: ZoomPan;
  onVideoError: () => void;
  onLoadedMetadata: (video: HTMLVideoElement) => void;
  onSyncCurrentTime: (video: HTMLVideoElement) => void;
  onPlay: (video: HTMLVideoElement) => void;
  onPause: (video: HTMLVideoElement) => void;
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
  project,
  stageRef,
  videoRef,
  videoSrc,
  zoomLevel,
  zoomPan,
  onVideoError,
  onLoadedMetadata,
  onSyncCurrentTime,
  onPlay,
  onPause,
}: VideoDisplayProps) {
  const setZoomLevel = useSourceMonitorState((state) => state.setZoomLevel);
  const setZoomPan = useSourceMonitorState((state) => state.setZoomPan);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const zoomLevelRef = useRef(zoomLevel);
  const zoomPanRef = useRef(zoomPan);

  useEffect(() => {
    zoomLevelRef.current = zoomLevel;
  }, [zoomLevel]);

  useEffect(() => {
    zoomPanRef.current = zoomPan;
  }, [zoomPan]);

  const fittedSize = useMemo(() => {
    if (
      stageSize.width <= 0 ||
      stageSize.height <= 0 ||
      naturalSize.width <= 0 ||
      naturalSize.height <= 0
    ) {
      return null;
    }

    const scale = Math.min(
      stageSize.width / naturalSize.width,
      stageSize.height / naturalSize.height,
    );

    return {
      width: Math.max(1, Math.floor(naturalSize.width * scale)),
      height: Math.max(1, Math.floor(naturalSize.height * scale)),
    };
  }, [stageSize, naturalSize]);

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
  }, [stageRef, videoSrc]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }

    const updateSize = () => {
      const rect = stage.getBoundingClientRect();
      setStageSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(stage);
    return () => resizeObserver.disconnect();
  }, [stageRef]);

  useEffect(() => {
    setNaturalSize({ width: 0, height: 0 });
  }, [videoSrc]);

  const zoomScale = zoomLevel === "fit" ? 1 : zoomLevel / 100;
  const currentZoomPan = zoomLevel === "fit" ? { x: 0, y: 0 } : zoomPan;
  const videoStyle: CSSProperties = {
    width: fittedSize ? `${fittedSize.width}px` : "100%",
    height: fittedSize ? `${fittedSize.height}px` : "100%",
    transform: `translate(${currentZoomPan.x}px, ${currentZoomPan.y}px) scale(${zoomScale})`,
    transformOrigin: "50% 50%",
  };

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

  function handleLoadedMetadata(video: HTMLVideoElement) {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setNaturalSize((current) =>
        current.width === video.videoWidth && current.height === video.videoHeight
          ? current
          : { width: video.videoWidth, height: video.videoHeight },
      );
    }
    onLoadedMetadata(video);
  }

  function handleVideoWheel(event: WheelEvent, stage: HTMLDivElement) {
    const hasMedia = Boolean(videoSrc);
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
      tabIndex={-1}
      onPointerEnter={() => focusStage()}
      onPointerDown={() => focusStage()}
    >
      {videoSrc ? (
        <video
          ref={videoRef}
          src={videoSrc}
          controls={false}
          preload="auto"
          onError={onVideoError}
          onLoadedMetadata={(event) => handleLoadedMetadata(currentVideo(event))}
          onTimeUpdate={(event) => onSyncCurrentTime(currentVideo(event))}
          onSeeked={(event) => onSyncCurrentTime(currentVideo(event))}
          onPlay={(event) => onPlay(currentVideo(event))}
          onPause={(event) => onPause(currentVideo(event))}
          style={videoStyle}
        />
      ) : (
        <div className="empty-preview">
          <FileVideo size={38} />
          <span>
            {project
              ? "生成 MP4 代理后可在这里预览并定位台词"
              : "导入视频后可选择原文件或代理模式预览"}
          </span>
        </div>
      )}
    </div>
  );
}
