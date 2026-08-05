import { formatDuration } from "../../time";
import type { ExportClip, ExportSource } from "../../systems/ExportSystem";
import { ExportClipThumbnail } from "./ExportClipThumbnail";

interface ExportSourceListProps {
  source: ExportSource;
  selectedClipIds: Set<string>;
  onToggleClip: (clipId: string) => void;
  onSetAllSelected: (selected: boolean) => void;
}

const sourceKindLabels = {
  storyboard: "分镜片段",
  subtitle: "字幕片段",
  "media-bin": "媒体库视频",
} as const;

function clipDurationUs(clip: ExportClip) {
  if (clip.endUs > 0) {
    return Math.max(0, clip.endUs - clip.startUs);
  }
  return Math.max(0, clip.durationUs);
}

export function ExportSourceList({
  source,
  selectedClipIds,
  onToggleClip,
  onSetAllSelected,
}: ExportSourceListProps) {
  const allSelected =
    source.clips.length > 0 && source.clips.every((clip) => selectedClipIds.has(clip.id));
  const selectedClips = source.clips.filter((clip) => selectedClipIds.has(clip.id));
  const totalDurationUs = selectedClips.reduce((sum, clip) => sum + clipDurationUs(clip), 0);
  const kindLabel = sourceKindLabels[source.kind];

  return (
    <section className="export-source-pane">
      <header className="export-pane-header">
        <div>
          <div className="export-pane-eyebrow">导出片段</div>
          <h2 className="export-pane-title" title={source.title}>
            {source.title}
          </h2>
        </div>
        <span className="export-source-kind-badge">{kindLabel}</span>
      </header>

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
        {selectedClips.length > 0 && (
          <button type="button" className="toolbar-button" onClick={() => onSetAllSelected(false)}>
            清空
          </button>
        )}
      </div>

      <div className="export-clip-list">
        {source.clips.map((clip, index) => {
          const selected = selectedClipIds.has(clip.id);
          return (
            <label
              key={clip.id}
              className={`export-clip-row ${selected ? "is-selected" : ""}`}
              title={clip.sourcePath}
            >
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onToggleClip(clip.id)}
                className="export-clip-checkbox"
              />
              <span className="export-clip-index">{index + 1}</span>
              <ExportClipThumbnail clip={clip} />
              <span className="export-clip-label">{clip.label}</span>
              <span className="export-clip-time">
                {clip.endUs > 0
                  ? `${formatDuration(clip.startUs)} → ${formatDuration(clip.endUs)}`
                  : formatDuration(clip.startUs)}
              </span>
              <span className="export-clip-duration">{formatDuration(clipDurationUs(clip))}</span>
            </label>
          );
        })}
      </div>
    </section>
  );
}
