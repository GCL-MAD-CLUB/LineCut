import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Eye,
  Filter,
  Grid2X2,
  List,
  Search,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { mediaGridLayout } from "../../mediaGridLayout";
import {
  PopupMenu,
  PopupMenuItem,
  PopupMenuSeparator,
  useCloseOnOutsidePointer,
} from "../PopupMenu";
import { SelectDropdown, selectDropdownItems } from "../SelectDropdown";
import { BrowserSystemIcon, BrowserVisual } from "./BrowserVisual";
import { invokeCommand, runOperation, type OperationKey } from "../../errors";
import { ModalDialog } from "../ModalDialog";
import "./MediaBrowserDialog.css";

export interface MediaBrowserFilter {
  name: string;
  extensions: string[];
}

interface MediaBrowserDialogProps {
  title: string;
  filters: MediaBrowserFilter[];
  initialDirectory?: string;
  selectionMode?: "single" | "multiple";
  suggestedPaths?: string[];
  operation?: OperationKey;
  onCancel: () => void;
  onConfirm: (paths: string[]) => void;
  onDirectoryChange?: (directory: string) => void;
}

interface MediaBrowserEntry {
  path: string;
  name: string;
  is_directory: boolean;
  is_hidden: boolean;
  size: number;
}

interface MediaBrowserDirectory {
  directory: string;
  parent: string | null;
  entries: MediaBrowserEntry[];
}

interface MediaBrowserRoot {
  path: string;
  name: string;
}

type NavigationMode = "push" | "history" | "replace";
type BrowserView = "list" | "grid";

function pathKey(path: string) {
  return path.replaceAll("\\", "/").toLocaleLowerCase();
}

function pathIsWithin(path: string, directory: string) {
  const normalizedPath = pathKey(path);
  const normalizedDirectory = pathKey(directory);
  return (
    normalizedPath === normalizedDirectory ||
    normalizedPath.startsWith(
      normalizedDirectory.endsWith("/") ? normalizedDirectory : `${normalizedDirectory}/`,
    )
  );
}

function extension(path: string) {
  const name = path.split(/[\\/]/).pop() ?? path;
  const separator = name.lastIndexOf(".");
  return separator < 0 ? "" : name.slice(separator + 1).toLocaleLowerCase();
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function MediaBrowserDialog({
  title,
  filters,
  initialDirectory = "",
  selectionMode = "single",
  suggestedPaths,
  operation = "media.link",
  onCancel,
  onConfirm,
  onDirectoryChange,
}: MediaBrowserDialogProps) {
  const [roots, setRoots] = useState<MediaBrowserRoot[]>([]);
  const [listing, setListing] = useState<MediaBrowserDirectory | null>(null);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [treeChildren, setTreeChildren] = useState<Record<string, MediaBrowserEntry[]>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [shownExtensions, setShownExtensions] = useState<Set<string> | null>(null);
  const [filterAnchor, setFilterAnchor] = useState<DOMRect | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [view, setView] = useState<BrowserView>("grid");
  const [zoom, setZoom] = useState(0);
  const itemsRef = useRef<HTMLDivElement>(null);
  const [gridLayout, setGridLayout] = useState({ columns: 4, cardWidth: 150 });
  useCloseOnOutsidePointer(Boolean(filterAnchor), () => setFilterAnchor(null), {
    ignorePopupMenuTargets: true,
  });
  const manualSelectionDirectoryRef = useRef("");

  const compatibleExtensions = useMemo(
    () =>
      new Set(
        filters.flatMap((filter) =>
          filter.extensions.map((value) => value.trim().replace(/^\./, "").toLocaleLowerCase()),
        ),
      ),
    [filters],
  );

  async function loadDirectory(path: string, mode: NavigationMode = "push") {
    if (!path) {
      return false;
    }
    setLoading(true);
    const outcome = await runOperation(
      operation,
      () =>
        invokeCommand<MediaBrowserDirectory>("list_media_browser_directory", { directory: path }),
      { displayName: path, resourceKind: "media" },
    );
    setLoading(false);
    if (outcome.status !== "success") {
      return false;
    }

    const next = outcome.value;
    setListing(next);
    manualSelectionDirectoryRef.current = "";
    setSelectedPaths(new Set());
    const directoryKey = pathKey(next.directory);
    setExpandedPaths((current) => new Set(current).add(directoryKey));
    setTreeChildren((current) => ({
      ...current,
      [directoryKey]: next.entries.filter((entry) => entry.is_directory && !entry.is_hidden),
    }));
    onDirectoryChange?.(next.directory);
    if (mode === "replace") {
      setHistory([next.directory]);
      setHistoryIndex(0);
    } else if (mode === "push") {
      setHistory((current) => {
        const nextHistory = [...current.slice(0, historyIndex + 1), next.directory];
        setHistoryIndex(nextHistory.length - 1);
        return nextHistory;
      });
    }
    return next;
  }

  async function revealDirectoryInTree(
    currentListing: MediaBrowserDirectory,
    availableRoots: MediaBrowserRoot[],
  ) {
    const root = availableRoots
      .filter((entry) => pathIsWithin(currentListing.directory, entry.path))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (!root) {
      return;
    }

    const branchListings = [currentListing];
    let parent = currentListing.parent;
    for (let depth = 0; parent && pathIsWithin(parent, root.path) && depth < 32; depth += 1) {
      const parentDirectory = parent;
      const outcome = await runOperation(
        operation,
        () =>
          invokeCommand<MediaBrowserDirectory>("list_media_browser_directory", {
            directory: parentDirectory,
          }),
        { displayName: parentDirectory, resourceKind: "media" },
      );
      if (outcome.status !== "success") {
        break;
      }
      branchListings.push(outcome.value);
      if (pathKey(outcome.value.directory) === pathKey(root.path)) {
        break;
      }
      parent = outcome.value.parent;
    }

    setExpandedPaths((current) => {
      const next = new Set(current);
      branchListings.forEach((entry) => next.add(pathKey(entry.directory)));
      return next;
    });
    setTreeChildren((current) => {
      const next = { ...current };
      branchListings.forEach((entry) => {
        next[pathKey(entry.directory)] = entry.entries.filter(
          (child) => child.is_directory && !child.is_hidden,
        );
      });
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rootsOutcome = await runOperation(operation, () =>
        invokeCommand<MediaBrowserRoot[]>("list_media_browser_roots"),
      );
      if (cancelled || rootsOutcome.status !== "success") {
        setLoading(false);
        return;
      }
      setRoots(rootsOutcome.value);
      let target = initialDirectory;
      if (target) {
        const exists = await invokeCommand<boolean>("path_is_directory", { path: target });
        if (!exists) {
          target = "";
        }
      }
      target ||= rootsOutcome.value[0]?.path ?? "";
      if (target && !cancelled) {
        const initialListing = await loadDirectory(target, "replace");
        if (initialListing && !cancelled) {
          await revealDirectoryInTree(initialListing, rootsOutcome.value);
        }
      } else {
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // The initial directory is intentionally read once per dialog instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function isCompatible(entry: MediaBrowserEntry) {
    return entry.is_directory || compatibleExtensions.has(extension(entry.path));
  }

  const visibleEntries = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return (listing?.entries ?? []).filter(
      (entry) =>
        (showHidden || !entry.is_hidden) &&
        (entry.is_directory ||
          (shownExtensions ?? compatibleExtensions).has(extension(entry.path))) &&
        (!query || entry.name.toLocaleLowerCase().includes(query)),
    );
  }, [compatibleExtensions, listing, searchQuery, showHidden, shownExtensions]);

  useLayoutEffect(() => {
    const element = itemsRef.current;
    if (!element || view !== "grid") return;
    const update = () => {
      const style = getComputedStyle(element);
      const width =
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setGridLayout(mediaGridLayout(width, visibleEntries.length, [190, 260, 340][zoom], 8));
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [view, zoom, visibleEntries.length]);

  const suggestedSelectionKey = (suggestedPaths ?? []).map(pathKey).join("\u0000");

  useEffect(() => {
    if (
      !listing ||
      !suggestedSelectionKey ||
      manualSelectionDirectoryRef.current === pathKey(listing.directory)
    ) {
      return;
    }
    const entriesByPath = new Map(listing.entries.map((entry) => [pathKey(entry.path), entry]));
    const matchingPaths = (suggestedPaths ?? [])
      .map((path) => entriesByPath.get(pathKey(path)))
      .filter((entry): entry is MediaBrowserEntry => Boolean(entry && !entry.is_directory))
      .map((entry) => entry.path);
    if (matchingPaths.length > 0) {
      setSelectedPaths(
        new Set(selectionMode === "single" ? matchingPaths.slice(0, 1) : matchingPaths),
      );
    }
    // Paths are compared through the stable normalized key so an equivalent prop array does not
    // replace a manual selection on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing, selectionMode, suggestedSelectionKey]);

  async function goBack() {
    if (historyIndex <= 0) return;
    const targetIndex = historyIndex - 1;
    if (await loadDirectory(history[targetIndex], "history")) {
      setHistoryIndex(targetIndex);
    }
  }

  async function goForward() {
    if (historyIndex >= history.length - 1) return;
    const targetIndex = historyIndex + 1;
    if (await loadDirectory(history[targetIndex], "history")) {
      setHistoryIndex(targetIndex);
    }
  }

  async function toggleTreePath(path: string) {
    const key = pathKey(path);
    if (expandedPaths.has(key)) {
      setExpandedPaths((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      return;
    }
    setExpandedPaths((current) => new Set(current).add(key));
    if (treeChildren[key]) {
      return;
    }
    const outcome = await runOperation(
      operation,
      () =>
        invokeCommand<MediaBrowserDirectory>("list_media_browser_directory", { directory: path }),
      { displayName: path, resourceKind: "media" },
    );
    if (outcome.status === "success") {
      setTreeChildren((current) => ({
        ...current,
        [key]: outcome.value.entries.filter((entry) => entry.is_directory && !entry.is_hidden),
      }));
    }
  }

  function toggleFile(path: string) {
    manualSelectionDirectoryRef.current = pathKey(listing?.directory ?? "");
    setSelectedPaths((current) => {
      if (selectionMode === "single") {
        return new Set([path]);
      }
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function confirmSelection(path?: string) {
    const paths = path ? [path] : Array.from(selectedPaths);
    if (paths.length > 0) {
      onConfirm(paths);
    }
  }

  function renderTreeNode(node: MediaBrowserRoot | MediaBrowserEntry, depth: number) {
    const key = pathKey(node.path);
    const expanded = expandedPaths.has(key);
    const children = treeChildren[key] ?? [];
    return (
      <div className="media-browser-tree-branch" key={node.path}>
        <div
          className={`media-browser-tree-row ${pathKey(listing?.directory ?? "") === key ? "active" : ""}`}
          style={{ "--media-browser-tree-depth": depth } as React.CSSProperties}
        >
          <button
            type="button"
            className="media-browser-tree-toggle"
            aria-label={expanded ? "折叠文件夹" : "展开文件夹"}
            onClick={() => void toggleTreePath(node.path)}
          >
            {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="media-browser-tree-name"
            onClick={() => void loadDirectory(node.path)}
          >
            <BrowserSystemIcon path={node.path} directory />
            <span>{node.name}</span>
          </button>
        </div>
        {expanded && children.map((child) => renderTreeNode(child, depth + 1))}
      </div>
    );
  }

  const selectedCount = selectedPaths.size;
  const activeRoot = roots
    .filter((root) => pathIsWithin(listing?.directory ?? "", root.path))
    .sort((left, right) => right.path.length - left.path.length)[0];

  return (
    <ModalDialog
      title={title}
      className="modal-dialog-large media-browser-dialog"
      bodyClassName="media-browser-dialog-body"
      onCancel={onCancel}
      onConfirm={() => confirmSelection()}
      confirmDisabled={selectedCount === 0 || loading}
      confirmLabel="确定"
    >
      <div className="media-browser-toolbar">
        <SelectDropdown
          aria-label="当前位置"
          value={activeRoot?.path ?? ""}
          selectedLabel={
            listing?.directory.split(/[\\/]/).filter(Boolean).pop() ?? activeRoot?.name
          }
          items={selectDropdownItems(roots.map((root) => [root.path, root.name] as const))}
          onChange={(path) => void loadDirectory(path)}
        />
        <button
          type="button"
          title="后退"
          onClick={() => void goBack()}
          disabled={historyIndex <= 0 || loading}
        >
          <ArrowLeft aria-hidden="true" />
        </button>
        <button
          type="button"
          title="前进"
          onClick={() => void goForward()}
          disabled={historyIndex >= history.length - 1 || loading}
        >
          <ArrowRight aria-hidden="true" />
        </button>
        <span className="media-browser-toolbar-spacer" />
        <button
          type="button"
          title="文件类型已显示"
          aria-label="文件类型已显示"
          aria-expanded={Boolean(filterAnchor)}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) =>
            setFilterAnchor(filterAnchor ? null : event.currentTarget.getBoundingClientRect())
          }
        >
          <Filter aria-hidden="true" />
        </button>
        <button
          type="button"
          className={showHidden ? "active" : ""}
          title={showHidden ? "隐藏隐藏项目" : "显示隐藏项目"}
          onClick={() => setShowHidden((current) => !current)}
        >
          <Eye aria-hidden="true" />
        </button>
        <div className="media-browser-search">
          <Search aria-hidden="true" />
          <input
            aria-label="搜索当前文件夹"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
          />
          {searchQuery && (
            <button
              type="button"
              aria-label="清空搜索"
              title="清空搜索"
              onClick={() => setSearchQuery("")}
            >
              <X />
            </button>
          )}
        </div>
        {filterAnchor &&
          createPortal(
            <PopupMenu
              ariaLabel="文件类型已显示"
              contextMenuAnchor={{ x: filterAnchor.left, y: filterAnchor.bottom + 4 }}
              style={{
                position: "fixed",
                left: filterAnchor.left,
                top: filterAnchor.bottom + 4,
                zIndex: 100,
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <PopupMenuItem
                checked={shownExtensions === null}
                onSelect={() => setShownExtensions(null)}
              >
                所有支持的文件
              </PopupMenuItem>
              <PopupMenuSeparator />
              {Array.from(compatibleExtensions)
                .sort()
                .map((ext) => (
                  <PopupMenuItem
                    key={ext}
                    checked={shownExtensions?.has(ext) ?? false}
                    onSelect={() =>
                      setShownExtensions((current) => {
                        const next = new Set(current ?? []);
                        if (next.has(ext)) next.delete(ext);
                        else next.add(ext);
                        return next;
                      })
                    }
                  >
                    {ext.toUpperCase()} 文件
                  </PopupMenuItem>
                ))}
            </PopupMenu>,
            document.body,
          )}
      </div>

      <div className="media-browser-content">
        <aside className="media-browser-tree" aria-label="文件夹树">
          {roots.map((root) => renderTreeNode(root, 0))}
        </aside>

        <div
          ref={itemsRef}
          className={`media-browser-items is-${view}`}
          style={
            {
              "--media-browser-card-size": `${gridLayout.cardWidth}px`,
              "--media-browser-columns": gridLayout.columns,
            } as React.CSSProperties
          }
          role={view === "grid" ? "grid" : "table"}
          aria-label="文件和文件夹"
        >
          {loading ? (
            <p className="media-browser-empty">正在读取文件夹...</p>
          ) : visibleEntries.length === 0 ? (
            <p className="media-browser-empty">此文件夹中没有可显示的项目。</p>
          ) : (
            visibleEntries.map((entry) => {
              const compatible = isCompatible(entry);
              const selected = selectedPaths.has(entry.path);
              return (
                <button
                  type="button"
                  className={`${entry.is_directory ? "is-directory" : "is-file"} ${
                    selected ? "selected" : ""
                  } ${compatible ? "" : "incompatible"}`}
                  key={entry.path}
                  title={entry.path}
                  aria-selected={selected}
                  onClick={() => !entry.is_directory && compatible && toggleFile(entry.path)}
                  onDoubleClick={() => {
                    if (entry.is_directory) void loadDirectory(entry.path);
                    else if (compatible && selectionMode === "single") confirmSelection(entry.path);
                    else if (compatible) toggleFile(entry.path);
                  }}
                >
                  <BrowserVisual
                    path={entry.path}
                    directory={entry.is_directory}
                    preview={view === "grid"}
                  />
                  <span className="media-browser-item-name">{entry.name}</span>
                  <span className="media-browser-item-type">
                    {entry.is_directory ? "文件夹" : extension(entry.path).toUpperCase() || "文件"}
                  </span>
                  <span className="media-browser-item-size">
                    {entry.is_directory ? "" : formatFileSize(entry.size)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="media-browser-view-controls">
        <span>
          {selectedCount > 0 ? `已选择 ${selectedCount} 个文件` : (listing?.directory ?? "")}
        </span>
        <button
          type="button"
          className={view === "list" ? "active" : ""}
          title="列表视图"
          onClick={() => setView("list")}
        >
          <List aria-hidden="true" />
        </button>
        <button
          type="button"
          className={view === "grid" ? "active" : ""}
          title="缩略图视图"
          onClick={() => setView("grid")}
        >
          <Grid2X2 aria-hidden="true" />
        </button>
        <input
          type="range"
          min="0"
          max="2"
          step="1"
          value={zoom}
          aria-label="缩略图大小"
          aria-valuetext={["小", "中", "大"][zoom]}
          disabled={view !== "grid"}
          onChange={(event) => setZoom(Number(event.currentTarget.value))}
        />
      </div>
    </ModalDialog>
  );
}
