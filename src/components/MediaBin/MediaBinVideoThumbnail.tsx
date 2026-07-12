import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { isTauriRuntime } from "../../tauriRuntime";
import { frameDurationUs, frameToTimeUs, normalizeFrameRate } from "../../timeline";
import type { MediaBinItem, Project } from "../../types";

interface MediaBinVideoThumbnailProps {
  item: MediaBinItem;
  project: Project;
  frame: number;
}

interface ThumbnailCacheEntry {
  timeUs: number;
  bytes: Uint8Array;
}

const thumbnailCache = new Map<string, ThumbnailCacheEntry>();
const maximumCachedThumbnails = 200;
let thumbnailQueue: Promise<void> = Promise.resolve();

function enqueueThumbnail<Value>(task: () => Promise<Value>) {
  const result = thumbnailQueue.then(task, task);
  thumbnailQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function rememberThumbnail(itemId: string, entry: ThumbnailCacheEntry) {
  thumbnailCache.delete(itemId);
  thumbnailCache.set(itemId, entry);
  while (thumbnailCache.size > maximumCachedThumbnails) {
    const oldestItemId = thumbnailCache.keys().next().value;
    if (oldestItemId === undefined) {
      break;
    }
    thumbnailCache.delete(oldestItemId);
  }
}

function thumbnailTimeUs(project: Project, frame: number) {
  const videoStream =
    project.streams.find((stream) => stream.index === project.asset.video_stream_index) ??
    project.streams.find((stream) => stream.codec_type === "video");
  const frameRate = normalizeFrameRate(videoStream?.avg_frame_rate, videoStream?.r_frame_rate);
  const requestedTimeUs = frameToTimeUs(frame, frameRate);
  const latestFrameTimeUs = Math.max(
    0,
    project.asset.duration_us - Math.round(frameDurationUs(frameRate)),
  );
  return Math.min(requestedTimeUs, latestFrameTimeUs);
}

function currentVideo(event: SyntheticEvent<HTMLVideoElement>) {
  return event.currentTarget;
}

export function MediaBinVideoThumbnail({ item, project, frame }: MediaBinVideoThumbnailProps) {
  const targetTimeUs = useMemo(() => thumbnailTimeUs(project, frame), [frame, project]);
  const [thumbnailSrc, setThumbnailSrc] = useState("");
  const [useVideoFallback, setUseVideoFallback] = useState(false);
  const fallbackVideoRef = useRef<HTMLVideoElement | null>(null);
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

    const cached = thumbnailCache.get(item.id);
    if (cached?.timeUs === targetTimeUs) {
      showThumbnail(cached.bytes);
      return () => {
        cancelled = true;
        URL.revokeObjectURL(objectUrl);
      };
    }

    if (!isTauriRuntime()) {
      setUseVideoFallback(true);
      return () => {
        cancelled = true;
      };
    }

    void enqueueThumbnail(() =>
      invoke<number[]>("generate_video_thumbnail", {
        assetId: item.id,
        timeUs: targetTimeUs,
      }),
    )
      .then((serializedBytes) => {
        const bytes = new Uint8Array(serializedBytes);
        rememberThumbnail(item.id, { timeUs: targetTimeUs, bytes });
        showThumbnail(bytes);
      })
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
  }, [item.id, targetTimeUs]);

  useEffect(() => {
    const video = fallbackVideoRef.current;
    if (!video || !useVideoFallback || video.readyState < HTMLMediaElement.HAVE_METADATA) {
      return;
    }
    const targetSeconds = targetTimeUs / 1_000_000;
    const latestTime = Number.isFinite(video.duration)
      ? Math.max(0, video.duration - 0.001)
      : targetSeconds;
    video.currentTime = Math.min(targetSeconds, latestTime);
  }, [targetTimeUs, useVideoFallback]);

  function seekFallbackVideo(video: HTMLVideoElement) {
    const targetSeconds = targetTimeUs / 1_000_000;
    const latestTime = Number.isFinite(video.duration)
      ? Math.max(0, video.duration - 0.001)
      : targetSeconds;
    const clampedTime = Math.min(targetSeconds, latestTime);
    if (Math.abs(video.currentTime - clampedTime) > 0.001) {
      video.currentTime = clampedTime;
    }
  }

  if (thumbnailSrc && !useVideoFallback) {
    return <img className="media-bin-card-thumbnail" src={thumbnailSrc} alt="" draggable={false} />;
  }

  if (useVideoFallback) {
    return (
      <video
        ref={fallbackVideoRef}
        className="media-bin-card-thumbnail"
        src={fallbackSrc}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
        draggable={false}
        onLoadedMetadata={(event) => seekFallbackVideo(currentVideo(event))}
      />
    );
  }

  return null;
}
