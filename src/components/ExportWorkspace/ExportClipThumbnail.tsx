import { Film } from "lucide-react";
import { useEffect, useState } from "react";
import { requestStoryboardThumbnail } from "../../storyboardThumbnail";
import { baseTimelineThumbnailResolution } from "../../timelineThumbnailResolution";
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
    const request = requestStoryboardThumbnail({
      assetId: thumbnail.assetId,
      videoPath: clip.sourcePath,
      fingerprint: thumbnail.fingerprint ?? "",
      timeUs: thumbnail.timeUs,
      priority: 1,
      resolution: baseTimelineThumbnailResolution,
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
        <Film className="export-clip-thumbnail-placeholder" size={16} />
      )}
    </span>
  );
}
