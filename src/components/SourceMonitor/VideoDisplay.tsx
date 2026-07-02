import { FileVideo } from "lucide-react";
import { useEffect } from "react";
import type { CSSProperties, RefObject, SyntheticEvent } from "react";
import type { Project } from "../../types";

interface VideoDisplayProps {
  project: Project | null;
  stageRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  videoSrc: string | null;
  videoStyle: CSSProperties;
  onVideoError: () => void;
  onLoadedMetadata: (video: HTMLVideoElement) => void;
  onSyncCurrentTime: (video: HTMLVideoElement) => void;
  onPlay: (video: HTMLVideoElement) => void;
  onPause: (video: HTMLVideoElement) => void;
  onWheel: (event: WheelEvent, stage: HTMLDivElement) => void;
}

function currentVideo(event: SyntheticEvent<HTMLVideoElement>) {
  return event.currentTarget;
}

export function VideoDisplay({
  project,
  stageRef,
  videoRef,
  videoSrc,
  videoStyle,
  onVideoError,
  onLoadedMetadata,
  onSyncCurrentTime,
  onPlay,
  onPause,
  onWheel,
}: VideoDisplayProps) {
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      focusStage(stage);
      onWheel(event, stage);
    };

    stage.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => stage.removeEventListener("wheel", handleWheel, true);
  }, [onWheel, stageRef]);

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
          onLoadedMetadata={(event) => onLoadedMetadata(currentVideo(event))}
          onTimeUpdate={(event) => onSyncCurrentTime(currentVideo(event))}
          onSeeked={(event) => onSyncCurrentTime(currentVideo(event))}
          onPlay={(event) => onPlay(currentVideo(event))}
          onPause={(event) => onPause(currentVideo(event))}
          style={videoStyle}
        />
      ) : (
        <div className="empty-preview">
          <FileVideo size={38} />
          <span>{project ? "生成 MP4 代理后可在这里预览并定位台词" : "导入视频后可选择原文件或代理模式预览"}</span>
        </div>
      )}
    </div>
  );
}
