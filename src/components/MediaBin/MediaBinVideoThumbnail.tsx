import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { isTauriRuntime } from "../../tauriRuntime";
import { extractVideoCover } from "../../thumbnail";
import { frameDurationUs, normalizeFrameRate } from "../../timeline";
import type { MediaBinItem, Project } from "../../types";

interface MediaBinVideoThumbnailProps {
  item: MediaBinItem;
  project: Project;
  hoverProgress: number | null;
}

function hoverThumbnailTimeUs(project: Project, progress: number) {
  const videoStream =
    project.streams.find((stream) => stream.index === project.asset.video_stream_index) ??
    project.streams.find((stream) => stream.codec_type === "video");
  const frameRate = normalizeFrameRate(videoStream?.avg_frame_rate, videoStream?.r_frame_rate);
  const latestFrameTimeUs = Math.max(
    0,
    project.asset.duration_us - Math.round(frameDurationUs(frameRate)),
  );
  return Math.min(
    Math.round(project.asset.duration_us * Math.min(1, Math.max(0, progress))),
    latestFrameTimeUs,
  );
}

function currentVideo(event: SyntheticEvent<HTMLVideoElement>) {
  return event.currentTarget;
}

export function MediaBinVideoThumbnail({
  item,
  project,
  hoverProgress,
}: MediaBinVideoThumbnailProps) {
  const hoverTargetTimeUs = useMemo(
    () => (hoverProgress === null ? null : hoverThumbnailTimeUs(project, hoverProgress)),
    [hoverProgress, project],
  );
  const [thumbnailSrc, setThumbnailSrc] = useState("");
  const [useVideoFallback, setUseVideoFallback] = useState(false);
  const [hoverFrameReady, setHoverFrameReady] = useState(false);
  const hoverVideoRef = useRef<HTMLVideoElement | null>(null);
  const fallbackPath = project.proxy_path || item.path;
  const fallbackSrc = isTauriRuntime() ? convertFileSrc(fallbackPath) : fallbackPath;

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";

    const showThumbnail = (bytes: Uint8Array) => {
      if (cancelled) {
        return;
      }
      const imageBuffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(imageBuffer).set(bytes);
      objectUrl = URL.createObjectURL(new Blob([imageBuffer], { type: "image/jpeg" }));
      setThumbnailSrc(objectUrl);
      setUseVideoFallback(false);
    };

    if (!isTauriRuntime()) {
      setUseVideoFallback(true);
      return () => {
        cancelled = true;
      };
    }

    void extractVideoCover(item.id, project.asset.fingerprint)
      .then(showThumbnail)
      .catch(() => {
        if (!cancelled) {
          setUseVideoFallback(true);
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [item.id, project.asset.fingerprint]);

  useEffect(() => {
    if (hoverTargetTimeUs === null) {
      setHoverFrameReady(false);
      return;
    }
    const video = hoverVideoRef.current;
    if (video && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      seekHoverVideo(video);
    }
  }, [hoverTargetTimeUs]);

  function seekHoverVideo(video: HTMLVideoElement) {
    if (hoverTargetTimeUs === null) {
      return;
    }
    const targetSeconds = hoverTargetTimeUs / 1_000_000;
    const latestTime = Number.isFinite(video.duration)
      ? Math.max(0, video.duration - 0.001)
      : targetSeconds;
    const clampedTime = Math.min(targetSeconds, latestTime);
    if (Math.abs(video.currentTime - clampedTime) > 0.001) {
      video.currentTime = clampedTime;
    } else if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      setHoverFrameReady(true);
    }
  }

  const hoverThumbnail = hoverTargetTimeUs !== null && (
    <video
      ref={hoverVideoRef}
      className={`media-bin-card-thumbnail media-bin-card-hover-thumbnail ${
        hoverFrameReady ? "is-ready" : ""
      }`}
      src={fallbackSrc}
      muted
      playsInline
      preload="auto"
      aria-hidden="true"
      draggable={false}
      onLoadedMetadata={(event) => seekHoverVideo(currentVideo(event))}
      onLoadedData={(event) => seekHoverVideo(currentVideo(event))}
      onSeeked={() => setHoverFrameReady(true)}
    />
  );

  if (thumbnailSrc && !useVideoFallback) {
    return (
      <>
        <img className="media-bin-card-thumbnail" src={thumbnailSrc} alt="" draggable={false} />
        {hoverThumbnail}
      </>
    );
  }

  if (useVideoFallback) {
    return (
      <>
        <video
          className="media-bin-card-thumbnail"
          src={fallbackSrc}
          muted
          playsInline
          preload="auto"
          aria-hidden="true"
          draggable={false}
        />
        {hoverThumbnail}
      </>
    );
  }

  return hoverThumbnail;
}
