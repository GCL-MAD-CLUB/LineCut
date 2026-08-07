import { Film } from "lucide-react";
import { useEffect, useState } from "react";
import { requestStoryboardThumbnail } from "../../storyboardThumbnail";
import { timelineThumbnailResolutionForDisplay } from "../../timelineThumbnailResolution";
import type { ExportClip } from "../../systems/ExportSystem";

interface ExportClipThumbnailProps {
  clip: ExportClip;
}

export function ExportClipThumbnail({ clip }: ExportClipThumbnailProps) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const thumbnail = clip.thumbnail;
    if (!thumbnail || !clip.sourcePath) {
      return;
    }
    let alive = true;
    const resolution = timelineThumbnailResolutionForDisplay(96, 54, window.devicePixelRatio || 1);
    const request = requestStoryboardThumbnail({
      assetId: thumbnail.assetId,
      videoPath: clip.sourcePath,
      fingerprint: thumbnail.fingerprint ?? "",
      timeUs: thumbnail.timeUs,
      priority: 1,
      resolution,
    });
    void request.promise.then(
      (url) => {
        if (alive) {
          setSrc(url);
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
    <span className="export-clip-thumbnail">
      {src ? (
        <img src={src} alt="" draggable={false} />
      ) : (
        <Film className="export-clip-thumbnail-placeholder" size={20} />
      )}
    </span>
  );
}
