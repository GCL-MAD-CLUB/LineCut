import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

export interface TransientVideoFrame {
  sessionId: string;
  src: string;
  frame: number;
  frameRate: number;
}

export function TransientVideoPreview({
  preview,
  style,
}: {
  preview: TransientVideoFrame;
  style: CSSProperties;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);
  const targetRef = useRef(0);
  targetRef.current = (preview.frame + 0.125) / preview.frameRate;

  function seek(video: HTMLVideoElement) {
    if (video.readyState < 1 || video.seeking) return;
    const target = Math.max(
      0,
      Math.min(
        targetRef.current,
        Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.001) : targetRef.current,
      ),
    );
    if (Math.abs(video.currentTime - target) > 0.000001) {
      video.currentTime = target;
    } else if (video.readyState >= 2) {
      setReady(true);
    }
  }

  useEffect(() => {
    if (videoRef.current) seek(videoRef.current);
  }, [preview.frame, preview.frameRate]);

  return (
    <video
      ref={videoRef}
      src={preview.src}
      className={`source-transient-preview ${ready ? "is-ready" : ""}`}
      style={style}
      muted
      playsInline
      preload="auto"
      aria-hidden="true"
      onLoadedMetadata={(event) => seek(event.currentTarget)}
      onLoadedData={(event) => seek(event.currentTarget)}
      onSeeked={(event) => seek(event.currentTarget)}
    />
  );
}
