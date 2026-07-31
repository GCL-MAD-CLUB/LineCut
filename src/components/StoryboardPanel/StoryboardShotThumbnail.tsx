import { convertFileSrc } from "@tauri-apps/api/core";
import { Film, Star } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from "react";
import { requestStoryboardThumbnail } from "../../storyboardThumbnail";
import { isTauriRuntime } from "../../tauriRuntime";
import { formatDuration } from "../../time";
import { frameToTimeUs } from "../../timeline";
import {
  timelineThumbnailResolutions,
  useTimelineThumbnailResolution,
} from "../../timelineThumbnailResolution";
import type { StoryboardShot } from "../../types";
import type {
  StoryboardShotColorLabel,
  StoryboardShotFlag,
  StoryboardShotStack,
} from "./storyboardPanelState";

const storyboardShotFlagLabels: Record<StoryboardShotFlag, string> = {
  retained: "留用旗标",
  none: "无旗标",
  excluded: "排除旗标",
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

interface StoryboardStackBadgeProps {
  stack: StoryboardShotStack;
  shotIndex: number;
  onToggle: () => void;
}

function StoryboardStackBadge({ stack, shotIndex, onToggle }: StoryboardStackBadgeProps) {
  const count = stack.shotIds.length;
  const position = shotIndex + 1;
  const isFirst = shotIndex === 0;
  const className = [
    "storyboard-stack-badge",
    stack.expanded ? "is-expanded" : "is-collapsed",
    isFirst ? "is-first" : "",
    count > 2 ? "has-third-layer" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (stack.expanded && !isFirst) {
    return (
      <span className={className} aria-hidden="true">
        <span className="storyboard-stack-badge-face">
          {position}/{count}
        </span>
      </span>
    );
  }

  return (
    <span className={className}>
      <span className="storyboard-stack-badge-face">
        <span className="storyboard-stack-badge-count">{count}</span>
        {stack.expanded && (
          <span className="storyboard-stack-badge-position">
            {position}/{count}
          </span>
        )}
        <button
          type="button"
          className="storyboard-stack-badge-toggle"
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          aria-label={
            stack.expanded ? `折叠包含 ${count} 个分镜的堆叠` : `展开包含 ${count} 个分镜的堆叠`
          }
        />
      </span>
    </span>
  );
}

interface ShotFrameButtonProps {
  shot: StoryboardShot;
  assetId: string;
  fingerprint: string;
  videoPath: string;
  previewVideoPath: string;
  frameRate: number;
  priority: number;
  onSelect: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

function ShotFrameButton({
  shot,
  assetId,
  fingerprint,
  videoPath,
  previewVideoPath,
  frameRate,
  priority,
  onSelect,
}: ShotFrameButtonProps) {
  const { resolution, thumbnailContainerRef } = useTimelineThumbnailResolution<HTMLButtonElement>();
  const thumbnailIdentity = `${fingerprint}:${videoPath}:${shot.start_us}`;
  const [thumbnail, setThumbnail] = useState<{
    identity: string;
    src: string;
    width: number;
    height: number;
  } | null>(null);
  const [hoverProgress, setHoverProgress] = useState<number | null>(null);
  const [hoverFrameReady, setHoverFrameReady] = useState(false);
  const hoverVideoRef = useRef<HTMLVideoElement | null>(null);
  const hoverTargetTimeUs = useMemo(() => {
    if (hoverProgress === null) {
      return null;
    }
    const endTimeUs = Math.max(shot.start_us, frameToTimeUs(shot.end_frame, frameRate));
    return Math.round(shot.start_us + (endTimeUs - shot.start_us) * clamp(hoverProgress, 0, 1));
  }, [frameRate, hoverProgress, shot.end_frame, shot.start_us]);
  const previewSrc = isTauriRuntime() ? convertFileSrc(previewVideoPath) : previewVideoPath;

  useEffect(() => {
    let active = true;
    const requestedResolutions = timelineThumbnailResolutions.filter(
      (candidate) => candidate.width <= resolution.width,
    );
    const requests = requestedResolutions.map((candidate) => {
      const request = requestStoryboardThumbnail({
        assetId,
        fingerprint,
        videoPath,
        timeUs: shot.start_us,
        priority,
        resolution: candidate,
      });
      void request.promise.then(
        (src) => {
          if (!active) {
            return;
          }
          setThumbnail((current) => {
            if (
              current?.identity === thumbnailIdentity &&
              current.width > candidate.width &&
              current.width <= resolution.width
            ) {
              return current;
            }
            return {
              identity: thumbnailIdentity,
              src,
              width: candidate.width,
              height: candidate.height,
            };
          });
        },
        () => undefined,
      );
      return request;
    });
    return () => {
      active = false;
      for (const request of requests) {
        request.cancel();
      }
    };
  }, [
    assetId,
    fingerprint,
    priority,
    resolution.width,
    shot.start_us,
    thumbnailIdentity,
    videoPath,
  ]);

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

  function updateHoverPreview(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.buttons !== 0) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const progress = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    setHoverProgress((current) => (current === progress ? current : progress));
  }

  function currentVideo(event: SyntheticEvent<HTMLVideoElement>) {
    return event.currentTarget;
  }

  const visibleThumbnail = thumbnail?.identity === thumbnailIdentity ? thumbnail : null;

  return (
    <button
      ref={thumbnailContainerRef}
      type="button"
      className="shot-frame-button"
      onClick={onSelect}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerMove={updateHoverPreview}
      onPointerLeave={() => setHoverProgress(null)}
      aria-label={`从 ${formatDuration(shot.start_us)} 播放此镜头`}
    >
      {visibleThumbnail && (
        <img
          className="shot-frame"
          src={visibleThumbnail.src}
          alt=""
          width={visibleThumbnail.width}
          height={visibleThumbnail.height}
          decoding="async"
          draggable={false}
        />
      )}
      {hoverTargetTimeUs !== null && (
        <video
          ref={hoverVideoRef}
          className={`shot-frame shot-hover-frame ${hoverFrameReady ? "is-ready" : ""}`}
          src={previewSrc}
          muted
          playsInline
          preload="auto"
          aria-hidden="true"
          draggable={false}
          onLoadedMetadata={(event) => seekHoverVideo(currentVideo(event))}
          onLoadedData={(event) => seekHoverVideo(currentVideo(event))}
          onSeeked={() => setHoverFrameReady(true)}
        />
      )}
      {hoverProgress !== null && (
        <span className="shot-hover-progress" aria-hidden="true">
          <span style={{ width: `${hoverProgress * 100}%` }} />
        </span>
      )}
      <Film className="shot-frame-placeholder" aria-hidden="true" />
    </button>
  );
}

export interface StoryboardShotThumbnailProps {
  shot: StoryboardShot;
  rowNumber: number;
  rating: number;
  flag: StoryboardShotFlag;
  colorLabel: StoryboardShotColorLabel | undefined;
  stack: StoryboardShotStack | undefined;
  stackIndex: number;
  assetId: string;
  fingerprint: string;
  videoPath: string;
  previewVideoPath: string;
  frameRate: number;
  priority: number;
  onSelectFrame: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onToggleStack: () => void;
  onSetRating: (rating: number) => void;
  onSetFlag: (flag: StoryboardShotFlag) => void;
  onOpenFlagMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onOpenColorMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

export function StoryboardShotThumbnail({
  shot,
  rowNumber,
  rating,
  flag,
  colorLabel,
  stack,
  stackIndex,
  assetId,
  fingerprint,
  videoPath,
  previewVideoPath,
  frameRate,
  priority,
  onSelectFrame,
  onToggleStack,
  onSetRating,
  onSetFlag,
  onOpenFlagMenu,
  onOpenColorMenu,
}: StoryboardShotThumbnailProps) {
  return (
    <>
      <div className="shot-thumbnail-topline">
        <span className="shot-thumbnail-row-number" aria-hidden="true">
          {rowNumber}
        </span>
        <button
          type="button"
          className={`shot-thumbnail-flag is-${flag}`}
          onClick={(event) => {
            event.stopPropagation();
            onSetFlag(flag === "none" ? "retained" : "none");
          }}
          onContextMenu={onOpenFlagMenu}
          onDoubleClick={(event) => event.stopPropagation()}
          title={flag === "none" ? "设为留用旗标" : `取消${storyboardShotFlagLabels[flag]}`}
          aria-label={flag === "none" ? "设为留用旗标" : `取消${storyboardShotFlagLabels[flag]}`}
          aria-pressed={flag !== "none"}
        />
      </div>
      {stack && (
        <StoryboardStackBadge stack={stack} shotIndex={stackIndex} onToggle={onToggleStack} />
      )}
      {videoPath && (
        <ShotFrameButton
          shot={shot}
          assetId={assetId}
          fingerprint={fingerprint}
          videoPath={videoPath}
          previewVideoPath={previewVideoPath}
          frameRate={frameRate}
          priority={priority}
          onSelect={(event) => {
            event.stopPropagation();
            onSelectFrame(event);
          }}
        />
      )}
      <button
        type="button"
        className={`shot-thumbnail-color-label ${colorLabel ? "has-color-label" : "is-none"}`}
        onClick={onOpenColorMenu}
        onDoubleClick={(event) => event.stopPropagation()}
        title={colorLabel ? "更改色标" : "设置色标"}
        aria-label={colorLabel ? "更改色标" : "设置色标"}
      />
      <div className="shot-thumbnail-rating" role="group" aria-label={`${rating} 星`}>
        {[1, 2, 3, 4, 5].map((star) => {
          const filled = star <= rating;
          return (
            <button
              key={star}
              type="button"
              className={`shot-thumbnail-rating-slot ${filled ? "is-filled" : "is-empty"}`}
              onClick={(event) => {
                event.stopPropagation();
                onSetRating(rating === star ? 0 : star);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              title={`${star} 星`}
              aria-label={`${star} 星`}
              aria-pressed={rating === star}
            >
              {filled ? <Star aria-hidden="true" /> : <span aria-hidden="true">·</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}
