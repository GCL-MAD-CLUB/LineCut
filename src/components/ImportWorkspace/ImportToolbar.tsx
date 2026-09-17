import {
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  Eye,
  Filter,
  FolderOpen,
  Grid3X3,
  List,
  Search,
  X,
} from "lucide-react";
import { useState, type MouseEvent } from "react";
import { PopupMenuItem, PopupMenuSeparator } from "../PopupMenu";
import { ImportMenu } from "./ImportMenu";
import { ImportZoomControl } from "./ImportZoomControl";
import { breadcrumbs, type ImportFilter } from "./importBrowserModel";
import type { useImportBrowser } from "./useImportBrowser";

export function ImportToolbar({
  browser,
  view,
  onView,
  zoom,
  onZoom,
}: {
  browser: ReturnType<typeof useImportBrowser>;
  view: "grid" | "list";
  onView: (view: "grid" | "list") => void;
  zoom: number;
  onZoom: (zoom: number) => void;
}) {
  const [menu, setMenu] = useState<{
    kind: "path" | "sort" | "filter";
    x: number;
    y: number;
  } | null>(null);
  const parts = breadcrumbs(browser.listing?.directory ?? "");
  function openMenu(kind: "path" | "sort" | "filter", event: MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu(menu?.kind === kind ? null : { kind, x: rect.left, y: rect.bottom + 6 });
  }
  function select(action: () => void) {
    action();
    setMenu(null);
  }
  return (
    <header className="import-toolbar">
      <div className="import-path">
        <button
          className="import-icon-button"
          title="当前位置"
          aria-label="当前位置"
          aria-expanded={menu?.kind === "path"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => openMenu("path", e)}
        >
          <FolderOpen />
        </button>
        <nav aria-label="文件夹路径">
          {parts.map((part, index) => (
            <span key={part.path}>
              <ChevronRight />
              <button
                title={part.path}
                aria-current={index === parts.length - 1 ? "location" : undefined}
                onClick={() => void browser.navigate(part.path)}
              >
                {part.name}
              </button>
            </span>
          ))}
        </nav>
        <button
          className="import-icon-button"
          title="上一级文件夹"
          aria-label="上一级文件夹"
          disabled={!browser.listing?.parent}
          onClick={() => void browser.navigate(browser.listing?.parent ?? "")}
        >
          <ArrowUp />
        </button>
      </div>
      <div className="import-toolbar-controls">
        <ImportZoomControl value={zoom} onChange={onZoom} />
        <button
          className={`import-icon-button ${view === "grid" ? "active" : ""}`}
          title="缩略图视图"
          aria-label="缩略图视图"
          aria-pressed={view === "grid"}
          onClick={() => onView("grid")}
        >
          <Grid3X3 />
        </button>
        <button
          className={`import-icon-button ${view === "list" ? "active" : ""}`}
          title="列表视图"
          aria-label="列表视图"
          aria-pressed={view === "list"}
          onClick={() => onView("list")}
        >
          <List />
        </button>
        <span className="import-toolbar-divider" />
        <button
          className={`import-icon-button ${menu?.kind === "sort" ? "active" : ""}`}
          title="排序"
          aria-label="排序"
          aria-expanded={menu?.kind === "sort"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => openMenu("sort", e)}
        >
          <ArrowUpDown />
        </button>
        <button
          className={`import-icon-button ${browser.filter !== "all" || menu?.kind === "filter" ? "active" : ""}`}
          title="文件类型"
          aria-label="文件类型"
          aria-expanded={menu?.kind === "filter"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => openMenu("filter", e)}
        >
          <Filter />
        </button>
        <button
          className={`import-icon-button ${browser.showHidden ? "active" : ""}`}
          title="显示隐藏文件"
          aria-label="显示隐藏文件"
          aria-pressed={browser.showHidden}
          onClick={() => browser.setShowHidden(!browser.showHidden)}
        >
          <Eye />
        </button>
        <label className="import-search">
          <Search />
          <input
            aria-label="搜索当前文件夹"
            value={browser.query}
            onChange={(e) => browser.setQuery(e.currentTarget.value)}
          />
          {browser.query && (
            <button aria-label="清空搜索" onClick={() => browser.setQuery("")}>
              <X />
            </button>
          )}
        </label>
      </div>
      {menu && (
        <ImportMenu
          anchor={menu}
          label={{ path: "文件夹路径", sort: "排序", filter: "文件类型" }[menu.kind]}
          onClose={() => setMenu(null)}
        >
          {menu.kind === "path" &&
            parts.map((part, index) => (
              <PopupMenuItem
                key={part.path}
                checked={index === parts.length - 1}
                onSelect={() => select(() => void browser.navigate(part.path))}
              >
                {part.name}
              </PopupMenuItem>
            ))}
          {menu.kind === "sort" && (
            <>
              <PopupMenuItem
                checked={browser.sort === "name"}
                onSelect={() => select(() => browser.setSort("name"))}
              >
                名称
              </PopupMenuItem>
              <PopupMenuItem
                checked={browser.sort === "created"}
                onSelect={() => select(() => browser.setSort("created"))}
              >
                创建日期
              </PopupMenuItem>
              <PopupMenuSeparator />
              <PopupMenuItem
                checked={!browser.descending}
                onSelect={() => select(() => browser.setDescending(false))}
              >
                升序
              </PopupMenuItem>
              <PopupMenuItem
                checked={browser.descending}
                onSelect={() => select(() => browser.setDescending(true))}
              >
                降序
              </PopupMenuItem>
            </>
          )}
          {menu.kind === "filter" &&
            (
              [
                ["all", "所有支持的文件"],
                ["video", "仅视频"],
                ["audio", "仅音频"],
                ["image", "仅图像"],
                ["subtitle", "仅字幕"],
              ] as [ImportFilter, string][]
            ).map(([value, label]) => (
              <PopupMenuItem
                key={value}
                checked={browser.filter === value}
                onSelect={() => select(() => browser.setFilter(value))}
              >
                {label}
              </PopupMenuItem>
            ))}
        </ImportMenu>
      )}
    </header>
  );
}
