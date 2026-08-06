import { formatDuration } from "../../time";
import type { ExportClip, ExportSource } from "../../systems/ExportSystem";
import { ExportClipThumbnail } from "./ExportClipThumbnail";

interface ExportSourceListProps {
  source: ExportSource;
  selectedClipIds: Set<string>;
  previewClipId: string | null;
  onToggleClip: (clipId: string) => void;
  onSetAllSelected: (selected: boolean) => void;
  onPreviewClip: (clipId: string) => void;
}

function clipDurationUs(clip: ExportClip) {
  if (clip.endUs > 0) {
    return Math.max(0, clip.endUs - clip.startUs);
  }
  return Math.max(0, clip.durationUs);
}

export function ExportSourceList({
  source,
  selectedClipIds,
  previewClipId,
  onToggleClip,
  onSetAllSelected,
  onPreviewClip,
}: ExportSourceListProps) {
  const allSelected =
    source.clips.length > 0 && source.clips.every((clip) => selectedClipIds.has(clip.id));
  const selectedClips = source.clips.filter((clip) => selectedClipIds.has(clip.id));
  const totalDurationUs = selectedClips.reduce((sum, clip) => sum + clipDurationUs(clip), 0);

  return (
    <section className="export-clips-panel">
      <div className="export-source-toolbar">
        <label className="export-check-label">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(event) => onSetAllSelected(event.target.checked)}
          />
          <span>全选</span>
        </label>
        <span className="export-source-summary">
          已选 {selectedClips.length} / {source.clips.length} 个 · 总时长{" "}
          {formatDuration(totalDurationUs)}
        </span>
      </div>

      <div className="export-clip-list">
        {source.clips.map((clip) => {
          const selected = selectedClipIds.has(clip.id);
          const previewing = previewClipId === clip.id;
          return (
            <div
              key={clip.id}
              className={`export-clip-row ${selected ? "is-selected" : ""} ${
                previewing ? "is-previewing" : ""
              }`}
              title={clip.sourcePath}
              onClick={() => onPreviewClip(clip.id)}
            >
              <span
                className="export-clip-checkbox-cell"
                onClick={(event) => event.stopPropagation()}
              >
                <input type="checkbox" checked={selected} onChange={() => onToggleClip(clip.id)} />
              </span>
              <ExportClipThumbnail clip={clip} />
              <span className="export-clip-info">
                <span className="export-clip-label">{clip.label}</span>
                <span className="export-clip-meta">
                  {clip.endUs > 0
                    ? `${formatDuration(clip.startUs)} → ${formatDuration(clip.endUs)}`
                    : formatDuration(clip.startUs)}
                  <span className="export-clip-meta-separator">·</span>
                  {formatDuration(clipDurationUs(clip))}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
