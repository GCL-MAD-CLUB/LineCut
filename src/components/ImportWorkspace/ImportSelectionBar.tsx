import { Info } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { PopupMenuItem } from "../PopupMenu";
import { ImportMenu } from "./ImportMenu";
import { ImportMediaVisual } from "./ImportMediaVisual";
import { parentDirectory } from "./importBrowserModel";
import type { ImportSelectionItem } from "./importFolderScan";
import { ImportFolderBadge } from "./ImportFolderBadge";

export function ImportSelectionBar({
  items,
  mediaCount,
  scanning,
  busy,
  canImport,
  status,
  onRemove,
  onClear,
  onRetry,
  onSelectAll,
  onNavigate,
  onCancel,
  onImport,
}: {
  items: ImportSelectionItem[];
  mediaCount: number;
  scanning: boolean;
  busy: boolean;
  canImport: boolean;
  status: string;
  onRemove: (path: string) => void;
  onClear: () => void;
  onRetry: (path: string) => void;
  onSelectAll: () => void;
  onNavigate: (path: string) => void;
  onCancel: () => void;
  onImport: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [tooltip, setTooltip] = useState<{ path: string; x: number; y: number } | null>(null);
  function select(action: () => void) {
    action();
    setMenu(null);
  }
  return (
    <footer className="import-selection-bar">
      {items.length ? (
        <>
          <div className="import-selection-items" aria-label="待导入媒体">
            {items.map(({ entry, files, scanning: folderScanning, unreadable }) => (
              <button
                className={`import-selection-item ${entry.is_directory ? "is-folder" : ""}`}
                key={entry.path}
                aria-label={entry.name}
                onPointerEnter={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setTooltip({
                    path: entry.path,
                    x: Math.min(Math.max(rect.left, 12), Math.max(12, window.innerWidth - 572)),
                    y: rect.top - 12,
                  });
                }}
                onPointerLeave={() => setTooltip(null)}
                onFocus={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setTooltip({ path: entry.path, x: rect.left, y: rect.top - 12 });
                }}
                onBlur={() => setTooltip(null)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setTooltip(null);
                  if (!busy) setMenu({ path: entry.path, x: event.clientX, y: event.clientY });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Delete" && !busy) onRemove(entry.path);
                }}
              >
                {entry.is_directory ? (
                  <ImportFolderBadge
                    count={files.length}
                    scanning={folderScanning}
                    hasErrors={unreadable.length > 0}
                  />
                ) : (
                  <ImportMediaVisual entry={entry} />
                )}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="import-selection-empty">
          <span className="import-selection-hint">
            <Info />
            选择要导入的媒体
          </span>
        </div>
      )}
      <span className="import-sr-only" role="status">
        {scanning ? `正在扫描，已找到 ${mediaCount} 个媒体` : `已选择 ${mediaCount} 个媒体`}
      </span>
      {status && (
        <span className="import-selection-status" role="status">
          {status}
        </span>
      )}
      <div className="import-selection-actions">
        <button className="import-cancel" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button className="import-submit" disabled={!canImport || busy} onClick={onImport}>
          {busy ? "正在导入…" : "导入"}
        </button>
      </div>
      {tooltip &&
        !menu &&
        createPortal(
          <div
            className="import-path-tooltip"
            role="tooltip"
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            {tooltip.path}
          </div>,
          document.body,
        )}
      {menu && (
        <ImportMenu light anchor={menu} label="待导入媒体操作" onClose={() => setMenu(null)}>
          {items.some((item) => item.entry.path === menu.path && item.entry.is_directory) && (
            <PopupMenuItem disabled={busy} onSelect={() => select(() => onRetry(menu.path))}>
              重新扫描文件夹
            </PopupMenuItem>
          )}
          <PopupMenuItem onSelect={() => select(() => onRemove(menu.path))}>清除</PopupMenuItem>
          <PopupMenuItem onSelect={() => select(onClear)}>清除全部</PopupMenuItem>
          <PopupMenuItem onSelect={() => select(onSelectAll)}>全选</PopupMenuItem>
          <PopupMenuItem onSelect={() => select(() => onNavigate(parentDirectory(menu.path)))}>
            查看所在文件夹
          </PopupMenuItem>
        </ImportMenu>
      )}
    </footer>
  );
}
