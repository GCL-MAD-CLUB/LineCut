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
import { requestSubtitleThumbnail } from "../../subtitleThumbnail";
import { isTauriRuntime } from "../../tauriRuntime";
import { formatDuration } from "../../time";
import {
  timelineThumbnailResolutions,
  useTimelineThumbnailResolution,
} from "../../timelineThumbnailResolution";
import type { SubtitleCue } from "../../types";
import type { SubtitleCueFlag, SubtitleCueVisualLabel } from "./subtitlePanelState";

const subtitleCueFlagLabels: Record<SubtitleCueFlag, string> = {
  retained: "留用旗标",
  none: "无旗标",
  excluded: "排除旗标",
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

interface SubtitleCueFrameButtonProps {
  cue: SubtitleCue;
  assetId: string;
  fingerprint: string;
  videoPath: string;
  previewVideoPath: string;
  priority: number;
  onSelect: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

function SubtitleCueFrameButton({
  cue,
  assetId,
  fingerprint,
  videoPath,
  previewVideoPath,
  priority,
  onSelect,
}: SubtitleCueFrameButtonProps) {
  const { resolution, thumbnailContainerRef } = useTimelineThumbnailResolution<HTMLButtonElement>();
  const thumbnailIdentity = `${fingerprint}:${videoPath}:${cue.start_us}`;
  const [thumbnail, setThumbnail] = useState<{
    identity: string;
    src: string;
    width: number;
    height: number;
  } | null>(null);
  const [hoverProgress, setHoverProgress] = useState<number | null>(null);
  const [hoverFrameReady, setHoverFrameReady] = useState(false);
  const hoverVideoRef = useRef<HTMLVideoElement | null>(null);
  const hoverTargetTimeUs = useMemo(
    () =>
      hoverProgress === null
        ? null
        : Math.round(
            cue.start_us + Math.max(0, cue.end_us - cue.start_us) * clamp(hoverProgress, 0, 1),
          ),
    [cue.end_us, cue.start_us, hoverProgress],
  );
  const previewSrc = isTauriRuntime() ? convertFileSrc(previewVideoPath) : previewVideoPath;

  useEffect(() => {
    let active = true;
    const requestedResolutions = timelineThumbnailResolutions.filter(
      (candidate) => candidate.width <= resolution.width,
    );
    const requests = requestedResolutions.map((candidate) => {
      const request = requestSubtitleThumbnail({
        assetId,
        fingerprint,
        videoPath,
        timeUs: cue.start_us,
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
    cue.start_us,
    fingerprint,
    priority,
    resolution.width,
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
      className="cue-frame-button"
      onClick={onSelect}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerMove={updateHoverPreview}
      onPointerLeave={() => setHoverProgress(null)}
      aria-label={`从 ${formatDuration(cue.start_us)} 播放此字幕`}
    >
      {visibleThumbnail && (
        <img
          className="cue-frame"
          src={visibleThumbnail.src}
          alt=""
          width={visibleThumbnail.width}
          height={visibleThumbnail.height}
          decoding="async"
          draggable={false}
        />
      )}
      {hoverTargetTimeUs !== null && previewVideoPath && (
        <video
          ref={hoverVideoRef}
          className={`cue-frame cue-hover-frame ${hoverFrameReady ? "is-ready" : ""}`}
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
        <span className="cue-hover-progress" aria-hidden="true">
          <span style={{ width: `${hoverProgress * 100}%` }} />
        </span>
      )}
      <Film className="cue-frame-placeholder" aria-hidden="true" />
    </button>
  );
}

export interface SubtitleCueThumbnailProps {
  cue: SubtitleCue;
  rowNumber: number;
  rating: number;
  flag: SubtitleCueFlag;
  colorLabel: SubtitleCueVisualLabel | undefined;
  assetId: string;
  fingerprint: string;
  videoPath: string;
  previewVideoPath: string;
  priority: number;
  onSelectFrame: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onSetRating: (rating: number) => void;
  onSetFlag: (flag: SubtitleCueFlag) => void;
  onOpenFlagMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onOpenColorMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

export function SubtitleCueThumbnail({
  cue,
  rowNumber,
  rating,
  flag,
  colorLabel,
  assetId,
  fingerprint,
  videoPath,
  previewVideoPath,
  priority,
  onSelectFrame,
  onSetRating,
  onSetFlag,
  onOpenFlagMenu,
  onOpenColorMenu,
}: SubtitleCueThumbnailProps) {
  return (
    <>
      <div className="cue-thumbnail-topline">
        <span className="cue-thumbnail-row-number" aria-hidden="true">
          {rowNumber}
        </span>
        <button
          type="button"
          className={`cue-thumbnail-flag is-${flag}`}
          onClick={(event) => {
            event.stopPropagation();
            onSetFlag(flag === "none" ? (event.altKey ? "excluded" : "retained") : "none");
          }}
          onContextMenu={onOpenFlagMenu}
          onDoubleClick={(event) => event.stopPropagation()}
          title={flag === "none" ? "设为留用旗标" : `取消${subtitleCueFlagLabels[flag]}`}
          aria-label={flag === "none" ? "设为留用旗标" : `取消${subtitleCueFlagLabels[flag]}`}
          aria-pressed={flag !== "none"}
        />
      </div>
      {videoPath && (
        <SubtitleCueFrameButton
          cue={cue}
          assetId={assetId}
          fingerprint={fingerprint}
          videoPath={videoPath}
          previewVideoPath={previewVideoPath}
          priority={priority}
          onSelect={(event) => {
            event.stopPropagation();
            onSelectFrame(event);
          }}
        />
      )}
      <button
        type="button"
        className={`cue-thumbnail-color-label ${colorLabel ? "has-color-label" : "is-none"}`}
        onClick={onOpenColorMenu}
        onDoubleClick={(event) => event.stopPropagation()}
        title={colorLabel ? "更改标签" : "设置标签"}
        aria-label={colorLabel ? "更改标签" : "设置标签"}
      />
      <div className="cue-thumbnail-rating" role="group" aria-label={`${rating} 星`}>
        {[1, 2, 3, 4, 5].map((star) => {
          const filled = star <= rating;
          return (
            <button
              key={star}
              type="button"
              className={`cue-thumbnail-rating-slot ${filled ? "is-filled" : "is-empty"}`}
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
