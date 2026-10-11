import { Film } from "lucide-react";
import { useEffect, useState } from "react";
import {
  timelineThumbnails,
  timelineThumbnailResolutionForDisplay,
} from "../../../../timelineThumbnail";
import type { ExportClip } from "../../../../systems/ExportSystem";

interface ExportClipThumbnailProps {
  clip: ExportClip;
  onPlay: () => void;
}

export function ExportClipThumbnail({ clip, onPlay }: ExportClipThumbnailProps) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const thumbnail = clip.thumbnail;
    if (!thumbnail || !clip.sourcePath) {
      return;
    }
    let alive = true;
    const resolution = timelineThumbnailResolutionForDisplay(96, 54, window.devicePixelRatio || 1);
    const request = timelineThumbnails.request({
      kind: "storyboard",
      assetId: thumbnail.assetId,
      videoPath: clip.sourcePath,
      fingerprint: thumbnail.fingerprint ?? "",
      timeUs: thumbnail.timeUs,
      priority: 1,
      resolution,
    });
    void request.promise.then(
      (result) => {
        if (alive) {
          setSrc(result.url);
        }
      },
      () => undefined,
    );
    return () => {
      alive = false;
      request.cancel();
    };
  }, [clip.sourcePath, clip.thumbnail]);

  return (
    <button
      type="button"
      className="export-clip-thumbnail"
      aria-label={`播放 ${clip.label}`}
      onClick={(event) => {
        event.stopPropagation();
        onPlay();
      }}
    >
      {src ? (
        <img src={src} alt="" draggable={false} />
      ) : (
        <Film className="export-clip-thumbnail-placeholder" size={20} />
      )}
    </button>
  );
}
