import { ArrowUpDown, ChevronRight, Eye, Filter, Grid3X3, List, Search, X } from "lucide-react";
import { SelectDropdown, selectDropdownItems, type SelectDropdownItem } from "../SelectDropdown";
import { ImportFolderChevronIcon } from "./ImportFolderIcon";
import { ImportZoomControl } from "./ImportZoomControl";
import { breadcrumbs, type ImportFilter } from "./importBrowserModel";
import type { useImportBrowser } from "./useImportBrowser";

type ImportSortMenuValue =
  "sort:name" | "sort:created" | "direction:ascending" | "direction:descending";

const filterItems = selectDropdownItems<ImportFilter>([
  ["all", "所有支持的文件"],
  ["video", "仅视频"],
  ["audio", "仅音频"],
  ["image", "仅图像"],
  ["subtitle", "仅字幕"],
]);

const sortItems: Array<SelectDropdownItem<ImportSortMenuValue>> = [
  { type: "option", value: "sort:name", label: "名称" },
  { type: "option", value: "sort:created", label: "创建日期" },
  { type: "separator" },
  { type: "option", value: "direction:ascending", label: "升序" },
  { type: "option", value: "direction:descending", label: "降序" },
];

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
  const parts = breadcrumbs(browser.listing?.directory ?? "");
  const currentPath = browser.listing?.directory ?? "";
  const sortValue: ImportSortMenuValue = `sort:${browser.sort}`;
  const directionValue: ImportSortMenuValue = browser.descending
    ? "direction:descending"
    : "direction:ascending";

  function changeSort(value: ImportSortMenuValue) {
    if (value === "sort:name" || value === "sort:created") {
      browser.setSort(value.slice(5) as "name" | "created");
      return;
    }
    browser.setDescending(value === "direction:descending");
  }
  return (
    <header className="import-toolbar">
      <div className="import-path">
        <SelectDropdown
          className="import-toolbar-dropdown import-path-dropdown"
          menuClassName="import-select-dropdown-menu"
          menuMinWidth={105}
          menuWidth="content"
          ariaLabel="当前位置"
          title="当前位置"
          value={currentPath}
          items={selectDropdownItems(parts.map((part) => [part.path, part.name] as const))}
          trigger={<ImportFolderChevronIcon />}
          onChange={(path) => void browser.navigate(path)}
        />
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
        <SelectDropdown
          className="import-toolbar-dropdown"
          menuClassName="import-select-dropdown-menu"
          menuMinWidth={105}
          menuWidth="content"
          ariaLabel="排序"
          title="排序"
          value={sortValue}
          selectedValues={[sortValue, directionValue]}
          items={sortItems}
          trigger={<ArrowUpDown />}
          onChange={changeSort}
        />
        <SelectDropdown
          className={`import-toolbar-dropdown ${browser.filter !== "all" ? "active" : ""}`}
          menuClassName="import-select-dropdown-menu"
          menuMinWidth={105}
          menuWidth="content"
          ariaLabel="文件类型"
          title="文件类型"
          value={browser.filter}
          items={filterItems}
          trigger={<Filter />}
          onChange={browser.setFilter}
        />
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
    </header>
  );
}
