import { useState, type CSSProperties } from "react";
import { ImportMediaVisual } from "./ImportMediaVisual";
import { importZoomRange } from "./ImportZoomControl";
import {
  fileExtension,
  formatDuration,
  formatFrameRate,
  pathKey,
  type ImportEntry,
  type ImportMetadata,
} from "./importBrowserModel";

function ImportFile({
  entry,
  selected,
  imported,
  view,
  disabled,
  onToggle,
  onNavigate,
}: {
  entry: ImportEntry;
  selected: boolean;
  imported: boolean;
  view: "grid" | "list";
  disabled: boolean;
  onToggle: (entry: ImportEntry, range: boolean) => void;
  onNavigate: (path: string) => void;
}) {
  const [metadata, setMetadata] = useState<ImportMetadata | null>(null);
  const type = entry.is_directory ? "FOLDER" : fileExtension(entry.path).toUpperCase();
  return (
    <div
      className={`import-file ${selected ? "selected" : ""} ${imported ? "imported" : ""}`}
      role={view === "list" ? "row" : "listitem"}
      onClick={(event) => {
        if (disabled || imported || (event.target as Element).closest("button, input")) return;
        onToggle(entry, event.shiftKey);
      }}
      onDoubleClick={(event) => {
        if (entry.is_directory && !disabled && !(event.target as Element).closest("button, input"))
          onNavigate(entry.path);
      }}
    >
      <div className="import-file-preview">
        <button
          className="import-file-hit"
          aria-label={`${selected ? "取消选择" : "选择"} ${entry.name}`}
          title={entry.is_directory ? `双击打开 ${entry.name}` : entry.path}
          aria-pressed={selected}
          disabled={disabled || imported}
          onClick={(event) => {
            onToggle(entry, event.shiftKey);
          }}
          onDoubleClick={() => {
            if (entry.is_directory) onNavigate(entry.path);
          }}
          onKeyDown={(event) => {
            if (entry.is_directory && event.key === "Enter") {
              event.preventDefault();
              onNavigate(entry.path);
            }
          }}
        >
          <ImportMediaVisual entry={entry} scrub onMetadata={setMetadata} />
        </button>
        <input
          className="import-file-check"
          type="checkbox"
          aria-label={`选择 ${entry.name}`}
          checked={selected || imported}
          disabled={disabled || imported}
          onChange={() => onToggle(entry, false)}
        />
      </div>
      <button
        className="import-file-caption"
        title={entry.path}
        disabled={disabled || imported}
        onClick={(event) => onToggle(entry, event.shiftKey)}
        onDoubleClick={() => {
          if (entry.is_directory) onNavigate(entry.path);
        }}
        onKeyDown={(event) => {
          if (entry.is_directory && event.key === "Enter") {
            event.preventDefault();
            onNavigate(entry.path);
          }
        }}
      >
        <span className="import-file-name">{entry.name}</span>
        <span className="import-file-type">
          {type}
          {view === "grid" && metadata?.duration_us
            ? ` · ${formatDuration(metadata.duration_us)}`
            : ""}
          {imported ? " · 已导入" : ""}
        </span>
      </button>
      {view === "list" && (
        <>
          <span role="cell">{formatDuration(metadata?.duration_us ?? 0)}</span>
          <span role="cell">
            {entry.created_at
              ? new Date(entry.created_at * 1000).toLocaleString("zh-CN", { hour12: false })
              : "—"}
          </span>
          <span role="cell">
            {metadata?.width && metadata.height ? `${metadata.width} × ${metadata.height}` : "—"}
          </span>
          <span role="cell">{formatFrameRate(metadata?.frame_rate)}</span>
          <span role="cell">{metadata?.codec?.toUpperCase() ?? "—"}</span>
        </>
      )}
    </div>
  );
}
/** List rows interpolate between these heights across the zoom range. */
const listRowHeightMin = 31;
const listRowHeightMax = 104;
/** The list thumbnail is a square standing at 95% of the row height. */
const listThumbHeightRatio = 0.95;
/** The list row's 1px bottom border, from the list CSS. */
const listRowBorder = 1;
/** Name line (20px) + caption gap (12px) + type line (18px), from the list CSS. */
const listCaptionTwoLineHeight = 50;
/** The square takes 95% of the row, so a two-line caption needs a row this tall
    to sit beside it without stretching the row. Below it the caption folds into
    a single line — every zoom step up to 170. */
const listCompactRowHeight = Math.ceil(listCaptionTwoLineHeight / listThumbHeightRatio);

export function ImportFileView({
  entries,
  selected,
  imported,
  view,
  zoom,
  disabled,
  loading,
  error,
  desktop,
  onToggle,
  onNavigate,
  onSelectAll,
}: {
  entries: ImportEntry[];
  selected: Set<string>;
  imported: Set<string>;
  view: "grid" | "list";
  zoom: number;
  disabled: boolean;
  loading: boolean;
  error: string;
  desktop: boolean;
  onToggle: (entry: ImportEntry, range: boolean) => void;
  onNavigate: (path: string) => void;
  onSelectAll: () => void;
}) {
  const zoomRatio = (zoom - importZoomRange.min) / (importZoomRange.max - importZoomRange.min);
  const rowHeight = Math.round(
    listRowHeightMin + zoomRatio * (listRowHeightMax - listRowHeightMin),
  );
  const thumbSize = Math.round(rowHeight * listThumbHeightRatio);
  /** What the square leaves of the row, split evenly as the row's vertical padding. */
  const rowPadding = Math.max(0, (rowHeight - thumbSize - listRowBorder) / 2);
  const compactCaption = view === "list" && rowHeight < listCompactRowHeight;
  return (
    <div
      className={`import-file-view is-${view} ${compactCaption ? "is-compact" : ""}`}
      style={
        {
          "--import-card-size": `${zoom}px`,
          "--import-row-height": `${rowHeight}px`,
          "--import-row-padding": `${rowPadding}px`,
          "--import-thumb-width": `${thumbSize}px`,
          "--import-thumb-height": `${thumbSize}px`,
        } as CSSProperties
      }
      tabIndex={0}
      aria-label="文件和文件夹"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
          event.preventDefault();
          onSelectAll();
        }
      }}
    >
      {error ? (
        <p className="import-empty" role="alert">
          {error}
        </p>
      ) : loading ? (
        <p className="import-empty" role="status">
          正在读取文件夹…
        </p>
      ) : !desktop ? (
        <div className="import-empty">
          <p>浏览本地媒体</p>
          <span>请在桌面应用中选择文件夹并导入媒体。</span>
        </div>
      ) : entries.length === 0 ? (
        <p className="import-empty">此文件夹中没有符合条件的文件</p>
      ) : (
        <div
          className="import-file-collection"
          role={view === "list" ? "table" : "list"}
          aria-label="媒体文件"
        >
          {view === "list" && (
            <div className="import-list-heading" role="row">
              <span />
              <span role="columnheader">名称</span>
              <span role="columnheader">持续时间</span>
              <span role="columnheader">创建日期</span>
              <span role="columnheader">帧大小</span>
              <span role="columnheader">帧速率</span>
              <span role="columnheader">视频编码</span>
            </div>
          )}
          {entries.map((entry) => (
            <ImportFile
              key={entry.path}
              entry={entry}
              selected={selected.has(pathKey(entry.path))}
              imported={imported.has(pathKey(entry.path))}
              view={view}
              disabled={disabled}
              onToggle={onToggle}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
