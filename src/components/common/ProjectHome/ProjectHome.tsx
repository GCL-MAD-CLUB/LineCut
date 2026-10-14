import { ChevronLeft, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { invokeCommand, runOperation } from "../../../errors";
import { isTauriRuntime } from "../../../platform/tauri/runtime";
import type { RecentProjectEntry } from "../../../types";
import "./ProjectHome.css";

const appIconUrl = new URL("../../../../src-tauri/icons/icon.ico", import.meta.url).href;
const columns = [
  ["name", "名称"],
  ["type", "类型"],
  ["recent", "最近使用项"],
  ["size", "大小"],
] as const;
type Column = (typeof columns)[number][0];
type Bounds = { x: number; y: number; width: number; height: number };
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const nameOf = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.lcp$/i, "");

function relativeTime(timestamp: number | undefined, now: number) {
  if (!timestamp || !Number.isFinite(timestamp)) return "—";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return seconds < 10 ? "刚刚" : `${seconds}秒钟前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}天前`;
  if (seconds < 31536000) return `${Math.floor(seconds / 2592000)}个月前`;
  return `${Math.floor(seconds / 31536000)}年前`;
}
function fileSize(size: number | null | undefined) {
  if (size == null) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1048576) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1048576).toFixed(1)} MB`;
}

interface Props {
  showWelcome: boolean;
  projects: RecentProjectEntry[];
  busy: boolean;
  suspended: boolean;
  onClose: () => void;
  onNew: () => Promise<void>;
  onOpen: (path?: string) => Promise<void>;
}

export function ProjectHome({
  showWelcome,
  projects,
  busy,
  suspended,
  onClose,
  onNew,
  onOpen,
}: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gesture = useRef<{ mode: string; x: number; y: number; bounds: Bounds } | null>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [sizes, setSizes] = useState<Record<string, number | null>>({});
  const [now, setNow] = useState(Date.now);
  const [sort, setSort] = useState<{ column: Column; ascending: boolean }>({
    column: "recent",
    ascending: false,
  });

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    const observer = new ResizeObserver(() => {
      const layer = layerRef.current;
      if (!layer) return;
      setBounds(
        (current) =>
          current && {
            x: Math.max(
              0,
              Math.min(current.x, layer.clientWidth - Math.min(current.width, layer.clientWidth)),
            ),
            y: Math.max(
              0,
              Math.min(
                current.y,
                layer.clientHeight - Math.min(current.height, layer.clientHeight),
              ),
            ),
            width: Math.min(current.width, layer.clientWidth),
            height: Math.min(current.height, layer.clientHeight),
          },
      );
    });
    if (layerRef.current) observer.observe(layerRef.current);
    return () => {
      window.clearInterval(timer);
      observer.disconnect();
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (!suspended) dialogRef.current?.focus();
  }, [suspended]);

  useEffect(() => {
    if (!isTauriRuntime() || !projects.length) return;
    let cancelled = false;
    void runOperation("storage.recentPaths", () =>
      invokeCommand<Array<number | null>>("recent_project_sizes", {
        paths: projects.map((entry) => entry.path),
      }),
    ).then((result) => {
      if (!cancelled && result.status === "success") {
        setSizes(
          Object.fromEntries(
            projects.map((entry, index) => [entry.path, result.value[index] ?? null]),
          ),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projects]);

  const rows = useMemo(
    () =>
      projects
        .map((entry, index) => ({ ...entry, index }))
        .filter((entry) =>
          nameOf(entry.path).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
        )
        .sort((a, b) => {
          let comparison = 0;
          if (sort.column === "name") comparison = collator.compare(nameOf(a.path), nameOf(b.path));
          if (sort.column === "recent")
            comparison = (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0) || b.index - a.index;
          if (sort.column === "size") comparison = (sizes[a.path] ?? -1) - (sizes[b.path] ?? -1);
          return (sort.ascending ? comparison : -comparison) || a.index - b.index;
        }),
    [projects, query, sort, sizes],
  );

  async function runAction(action: () => Promise<void>) {
    if (busy || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await action();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  function startGesture(event: PointerEvent<HTMLElement>, mode: string) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input")) return;
    const layer = layerRef.current!;
    const current = bounds ?? { x: 0, y: 0, width: layer.clientWidth, height: layer.clientHeight };
    gesture.current = { mode, x: event.clientX, y: event.clientY, bounds: current };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function moveGesture(event: PointerEvent<HTMLElement>) {
    const current = gesture.current;
    const layer = layerRef.current;
    if (!current || !layer) return;
    const { mode, bounds: original } = current;
    const dx = event.clientX - current.x,
      dy = event.clientY - current.y;
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    let { x, y, width, height } = original;
    if (mode === "move") {
      // Keep the title bar reachable while allowing a full-size window to move.
      x = clamp(x + dx, -width + 160, layer.clientWidth - 160);
      y = clamp(y + dy, 0, layer.clientHeight - 80);
    } else {
      const minWidth = Math.min(640, layer.clientWidth),
        minHeight = Math.min(320, layer.clientHeight);
      if (mode.includes("e")) width = clamp(width + dx, minWidth, layer.clientWidth - x);
      if (mode.includes("s")) height = clamp(height + dy, minHeight, layer.clientHeight - y);
      if (mode.includes("w")) {
        x = clamp(x + dx, 0, x + width - minWidth);
        width += original.x - x;
      }
      if (mode.includes("n")) {
        y = clamp(y + dy, 0, y + height - minHeight);
        height += original.y - y;
      }
    }
    setBounds({ x, y, width, height });
  }

  return (
    <div className="project-home-layer" ref={layerRef}>
      <section
        className="project-home"
        role="dialog"
        inert={suspended}
        aria-label="项目首页"
        tabIndex={-1}
        ref={dialogRef}
        style={
          bounds
            ? { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }
            : undefined
        }
        onPointerMove={moveGesture}
        onPointerUp={() => {
          gesture.current = null;
        }}
        onPointerCancel={() => {
          gesture.current = null;
        }}
        onLostPointerCapture={() => {
          gesture.current = null;
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
          if (event.key === "Tab") {
            const controls = Array.from(
              dialogRef.current!.querySelectorAll<HTMLElement>("button:not(:disabled), input"),
            );
            const first = controls[0],
              last = controls[controls.length - 1];
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === dialogRef.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header
          className="project-home-titlebar"
          onPointerDown={(event) => startGesture(event, "move")}
          onDoubleClick={() => setBounds(null)}
        >
          <button
            type="button"
            className="project-home-close"
            aria-label="关闭项目首页"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </header>
        <div
          className="project-home-toolbar"
          onPointerDown={(event) => startGesture(event, "move")}
          onDoubleClick={() => setBounds(null)}
        >
          <button
            type="button"
            className="project-home-back"
            aria-label="返回工作区"
            onClick={onClose}
          >
            <ChevronLeft size={18} />
          </button>
          <img src={appIconUrl} alt="LineCut" />
          <button
            type="button"
            className="project-home-search"
            aria-label="搜索最近项目"
            onClick={() => searchRef.current?.focus()}
          >
            <Search size={26} />
          </button>
        </div>
        <div className="project-home-body">
          <aside className="project-home-sidebar">
            <button
              type="button"
              className="project-home-new"
              disabled={busy || pending}
              onClick={() => void runAction(onNew)}
            >
              新建项目
            </button>
            <button
              type="button"
              className="project-home-open"
              disabled={busy || pending}
              onClick={() => void runAction(() => onOpen())}
            >
              打开项目
            </button>
          </aside>
          <main className="project-home-recent">
            {showWelcome && <p className="project-home-welcome">欢迎使用 Linecut</p>}
            <h2>最近使用项</h2>
            <label className="project-home-filter">
              <span>筛选</span>
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="筛选最近的文件"
              />
            </label>
            <div className="project-home-table-scroll">
              <table className="project-home-table">
                <colgroup>
                  <col className="project-home-name-column" />
                  <col />
                  <col />
                  <col className="project-home-size-column" />
                </colgroup>
                <thead>
                  <tr>
                    {columns.map(([column, label]) => (
                      <th
                        key={column}
                        aria-sort={
                          sort.column === column
                            ? sort.ascending
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setSort((current) => ({
                              column,
                              ascending: current.column === column ? !current.ascending : true,
                            }))
                          }
                        >
                          {label}
                          {sort.column === column && (
                            <svg
                              className="project-home-sort-arrow"
                              viewBox="0 0 16 16"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d={
                                  sort.ascending
                                    ? "M8 14 L8 2.5 M5 5.5 L8 2.5 L11 5.5"
                                    : "M8 2 L8 13.5 M5 10.5 L8 13.5 L11 10.5"
                                }
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2.75"
                              />
                            </svg>
                          )}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((entry) => (
                    <tr key={entry.path}>
                      <td>
                        <button
                          type="button"
                          className="project-home-project"
                          title={entry.path}
                          disabled={busy || pending}
                          onClick={() => void runAction(() => onOpen(entry.path))}
                        >
                          {nameOf(entry.path)}
                        </button>
                      </td>
                      <td>LineCut 项目</td>
                      <td
                        title={
                          entry.lastUsedAt
                            ? new Date(entry.lastUsedAt).toLocaleString()
                            : "旧记录未保存使用时间"
                        }
                      >
                        {relativeTime(entry.lastUsedAt, now)}
                      </td>
                      <td>{fileSize(sizes[entry.path])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!rows.length && (
                <p className="project-home-empty">
                  {query ? "没有匹配的最近项目" : "暂无最近使用的项目"}
                </p>
              )}
            </div>
          </main>
        </div>
        {["n", "ne", "e", "se", "s", "sw", "w", "nw"].map((edge) => (
          <div
            key={edge}
            className={`project-home-resize project-home-resize-${edge}`}
            onPointerDown={(event) => startGesture(event, edge)}
          />
        ))}
      </section>
    </div>
  );
}
