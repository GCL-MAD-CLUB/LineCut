import { open } from "@tauri-apps/plugin-dialog";
import {
  Captions,
  CheckCircle2,
  ChevronRight,
  FileAudio2,
  FileVideo2,
  FolderOpen,
  HardDrive,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { useMemo, useState } from "react";
import { runMediaImportTask } from "../../mediaImportTask";
import { useAppStore } from "../../store";
import { isTauriRuntime } from "../../tauriRuntime";
import type { MediaBinItem } from "../../types";
import { getTaskProgressStatus } from "../TaskProgress";
import "./ImportWorkspace.css";

interface ImportWorkspaceProps {
  onImportCompleted?: () => void;
}

type PendingMediaKind = "video" | "audio" | "subtitle";

interface PendingMediaItem {
  kind: PendingMediaKind;
  path: string;
}

const videoFilters = [
  {
    name: "Video",
    extensions: ["mkv", "mp4", "mov", "webm", "avi", "ts", "m2ts", "mpeg", "mpg"],
  },
];

const audioFilters = [
  {
    name: "Audio",
    extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "wma"],
  },
];

const subtitleFilters = [
  {
    name: "Subtitle",
    extensions: ["srt", "ass", "ssa", "vtt", "webvtt"],
  },
];

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function parentPath(path: string) {
  const segments = path.split(/[\\/]/);
  const separator = path.includes("\\") ? "\\" : "/";
  return segments.slice(0, -1).join(separator) || path;
}

function extension(path: string) {
  return fileName(path).split(".").pop()?.toUpperCase() ?? "";
}

function uniquePaths(current: string[], additions: string[]) {
  const knownPaths = new Set(current.map(pathKey));
  return [
    ...current,
    ...additions.filter((path) => {
      const key = pathKey(path);
      if (knownPaths.has(key)) {
        return false;
      }
      knownPaths.add(key);
      return true;
    }),
  ];
}

function pathKey(path: string) {
  return path.replaceAll("\\", "/").toLocaleLowerCase();
}

function pendingMediaIcon(kind: PendingMediaKind) {
  if (kind === "video") {
    return <FileVideo2 aria-hidden="true" />;
  }
  if (kind === "audio") {
    return <FileAudio2 aria-hidden="true" />;
  }
  return <Captions aria-hidden="true" />;
}

function pendingMediaLabel(kind: PendingMediaKind) {
  if (kind === "video") {
    return "视频";
  }
  if (kind === "audio") {
    return "音频";
  }
  return "字幕";
}

function standaloneSubtitleItem(path: string, index: number): MediaBinItem {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${index}`;
  return {
    id: `external-subtitle:${random}:${path.length}`,
    bin_id: null,
    kind: "subtitle",
    enabled: true,
    hidden: false,
    offline: false,
    path,
    file_name: fileName(path),
    duration_us: 0,
    start_time_us: 0,
    bound_to_video_id: null,
    source_video_id: null,
    stream_index: null,
    subtitle_track_id: null,
    codec: path.split(".").pop()?.toLowerCase() ?? "subtitle",
    language: null,
    extracted: false,
    origin: "imported",
    color: "#893a04",
  };
}

export function ImportWorkspace({ onImportCompleted }: ImportWorkspaceProps) {
  const [videoPaths, setVideoPaths] = useState<string[]>([]);
  const [audioPaths, setAudioPaths] = useState<string[]>([]);
  const [subtitlePaths, setSubtitlePaths] = useState<string[]>([]);
  const mediaItems = useAppStore((state) => state.mediaItems);
  const isMediaBinReadOnly = useAppStore((state) => state.mediaBinReadOnly);
  const mediaProjectsAdded = useAppStore((state) => state.actions.mediaProjectsAdded);
  const mediaItemsAdded = useAppStore((state) => state.actions.mediaItemsAdded);
  const messagePublished = useAppStore((state) => state.actions.messagePublished);
  const warningsAppended = useAppStore((state) => state.actions.warningsAppended);
  const exportResultChanged = useAppStore((state) => state.actions.exportResultChanged);
  const { isRunning: isImporting } = getTaskProgressStatus("import");
  const pendingItems = useMemo<PendingMediaItem[]>(
    () => [
      ...videoPaths.map((path) => ({ kind: "video" as const, path })),
      ...audioPaths.map((path) => ({ kind: "audio" as const, path })),
      ...subtitlePaths.map((path) => ({ kind: "subtitle" as const, path })),
    ],
    [audioPaths, subtitlePaths, videoPaths],
  );
  const importedItems = useMemo(
    () => mediaItems.filter((item) => item.origin === "imported"),
    [mediaItems],
  );
  const importedPathKeys = useMemo(
    () => new Set(importedItems.map((item) => pathKey(item.path))),
    [importedItems],
  );
  const itemCounts = useMemo(
    () => ({
      video: importedItems.filter((item) => item.kind === "video").length + videoPaths.length,
      audio: importedItems.filter((item) => item.kind === "audio").length + audioPaths.length,
      subtitle:
        importedItems.filter((item) => item.kind === "subtitle").length + subtitlePaths.length,
    }),
    [audioPaths.length, importedItems, subtitlePaths.length, videoPaths.length],
  );
  const hasSelection = pendingItems.length > 0;
  const hasItems = importedItems.length > 0 || hasSelection;

  async function choosePaths(kind: PendingMediaKind, filters: typeof videoFilters, title: string) {
    if (isMediaBinReadOnly) {
      messagePublished("项目处于只读状态。");
      return;
    }
    if (!isTauriRuntime()) {
      messagePublished("请在 Tauri 桌面窗口中选择本地媒体。");
      return;
    }
    const picked = await open({ multiple: true, title, filters });
    const selectedPaths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    const paths = selectedPaths.filter((path) => !importedPathKeys.has(pathKey(path)));
    if (paths.length === 0) {
      if (selectedPaths.length > 0) {
        messagePublished("所选媒体已在当前项目中。");
      }
      return;
    }
    if (kind === "video") {
      setVideoPaths((current) => uniquePaths(current, paths));
    } else if (kind === "audio") {
      setAudioPaths((current) => uniquePaths(current, paths));
    } else {
      setSubtitlePaths((current) => uniquePaths(current, paths));
    }
    const ignoredCount = selectedPaths.length - paths.length;
    messagePublished(
      `已添加 ${paths.length} 个${pendingMediaLabel(kind)}文件${ignoredCount > 0 ? `，忽略 ${ignoredCount} 个已有媒体` : ""}`,
    );
  }

  function removePendingItem(item: PendingMediaItem) {
    if (item.kind === "video") {
      setVideoPaths((current) => current.filter((path) => path !== item.path));
    } else if (item.kind === "audio") {
      setAudioPaths((current) => current.filter((path) => path !== item.path));
    } else {
      setSubtitlePaths((current) => current.filter((path) => path !== item.path));
    }
  }

  function clearPendingItems() {
    setVideoPaths([]);
    setAudioPaths([]);
    setSubtitlePaths([]);
  }

  async function importSelectedMedia() {
    if (isMediaBinReadOnly) {
      messagePublished("项目处于只读状态，请先解除只读。");
      return;
    }
    if (!isTauriRuntime()) {
      messagePublished("浏览器预览不能导入本地媒体，请运行 Tauri 桌面应用。");
      return;
    }
    if (!hasSelection) {
      messagePublished("请先选择需要导入的媒体。");
      return;
    }

    const probeItems = pendingItems.filter((item) => item.kind !== "subtitle");
    exportResultChanged(null);
    if (subtitlePaths.length > 0) {
      mediaItemsAdded(subtitlePaths.map(standaloneSubtitleItem));
      setSubtitlePaths([]);
    }

    const outcomes = await Promise.all(
      probeItems.map((item) =>
        runMediaImportTask({
          path: item.path,
          operation: "import",
          taskIdPrefix: `import-${item.kind}`,
          onSuccess: (result) => {
            mediaProjectsAdded([result.project]);
            warningsAppended(result.warnings);
            removePendingItem(item);
          },
        }),
      ),
    );
    const loadedResults = outcomes.flatMap((outcome) =>
      outcome.status === "success" ? [outcome.result] : [],
    );
    const errors = outcomes.filter((outcome) => outcome.status === "failed");
    const cancelledCount = outcomes.filter((outcome) => outcome.status === "cancelled").length;

    const importedCount = loadedResults.length + subtitlePaths.length;
    clearPendingItems();
    const resultParts = [
      importedCount > 0 ? `已导入 ${importedCount} 个媒体` : "未导入任何媒体",
      ...(errors.length > 0 ? [`${errors.length} 个失败`] : []),
      ...(cancelledCount > 0 ? [`${cancelledCount} 个已取消`] : []),
    ];
    messagePublished(resultParts.join("，"));
    if (importedCount > 0) {
      onImportCompleted?.();
    }
  }

  return (
    <section className="import-workspace" aria-label="导入工作区">
      <header className="import-workspace-heading">
        <div>
          <span className="import-workspace-eyebrow">媒体浏览器</span>
          <h1>导入媒体</h1>
          <p>当前媒体与待导入文件统一显示；新选择的文件始终追加到项目。</p>
        </div>
        <span className="import-workspace-limit">多个视频 · 多个音频 · 多个字幕</span>
      </header>

      <div className="import-browser">
        <aside className="import-browser-sidebar">
          <h2>导入位置</h2>
          <button type="button" className="import-location active">
            <HardDrive aria-hidden="true" />
            <span>本地媒体</span>
          </button>
          <div className="import-browser-summary">
            <span>导入媒体</span>
            <strong>{importedItems.length + pendingItems.length}</strong>
          </div>
          <dl>
            <div>
              <dt>视频</dt>
              <dd>{itemCounts.video}</dd>
            </div>
            <div>
              <dt>音频</dt>
              <dd>{itemCounts.audio}</dd>
            </div>
            <div>
              <dt>字幕</dt>
              <dd>{itemCounts.subtitle}</dd>
            </div>
          </dl>
        </aside>

        <div className="import-browser-main">
          <div className="import-browser-toolbar">
            <div className="import-breadcrumb" title="本地媒体 / 导入媒体">
              <FolderOpen aria-hidden="true" />
              <span>本地媒体</span>
              <ChevronRight aria-hidden="true" />
              <strong>导入媒体</strong>
            </div>
            <div className="import-picker-actions">
              <button
                type="button"
                onClick={() => void choosePaths("video", videoFilters, "添加多个视频")}
                disabled={isMediaBinReadOnly || isImporting}
              >
                <FileVideo2 aria-hidden="true" /> 添加视频
              </button>
              <button
                type="button"
                onClick={() => void choosePaths("audio", audioFilters, "添加多个音频")}
                disabled={isMediaBinReadOnly || isImporting}
              >
                <FileAudio2 aria-hidden="true" /> 添加音频
              </button>
              <button
                type="button"
                onClick={() => void choosePaths("subtitle", subtitleFilters, "添加多个字幕")}
                disabled={isMediaBinReadOnly || isImporting}
              >
                <Plus aria-hidden="true" /> 添加字幕
              </button>
            </div>
          </div>

          <div className="import-file-list" role="table" aria-label="导入媒体">
            <div className="import-file-list-header" role="row">
              <span role="columnheader">名称</span>
              <span role="columnheader">类型</span>
              <span role="columnheader">所在位置</span>
              <span role="columnheader" aria-label="状态或操作" />
            </div>

            {!hasItems && (
              <div className="import-empty-state">
                <Upload aria-hidden="true" />
                <strong>选择要导入的本地媒体</strong>
                <span>可以一次添加多个视频、音频和字幕文件。</span>
                <button
                  type="button"
                  onClick={() => void choosePaths("video", videoFilters, "添加多个视频")}
                  disabled={isMediaBinReadOnly || isImporting}
                >
                  选择视频
                </button>
              </div>
            )}

            {importedItems.map((item) => (
              <div className="import-file-row is-imported" role="row" key={`imported:${item.id}`}>
                <span className="import-file-name" role="cell" title={item.path}>
                  <span className={`import-file-icon ${item.kind}`}>
                    {pendingMediaIcon(item.kind)}
                  </span>
                  <strong>{item.file_name}</strong>
                </span>
                <span role="cell">
                  {extension(item.path)} {pendingMediaLabel(item.kind)}
                </span>
                <span className="import-file-path" role="cell" title={parentPath(item.path)}>
                  {parentPath(item.path)}
                </span>
                <span className="import-existing-status" role="cell" title="已在当前项目中">
                  <CheckCircle2 aria-hidden="true" />
                </span>
              </div>
            ))}

            {pendingItems.map((item) => (
              <div className="import-file-row" role="row" key={`${item.kind}:${item.path}`}>
                <span className="import-file-name" role="cell" title={item.path}>
                  <span className={`import-file-icon ${item.kind}`}>
                    {pendingMediaIcon(item.kind)}
                  </span>
                  <strong>{fileName(item.path)}</strong>
                </span>
                <span role="cell">
                  {extension(item.path)} {pendingMediaLabel(item.kind)}
                </span>
                <span className="import-file-path" role="cell" title={parentPath(item.path)}>
                  {parentPath(item.path)}
                </span>
                <button
                  type="button"
                  className="import-remove-button"
                  onClick={() => removePendingItem(item)}
                  disabled={isMediaBinReadOnly || isImporting}
                  title={`移除${pendingMediaLabel(item.kind)}`}
                  aria-label={`移除 ${fileName(item.path)}`}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <footer className="import-workspace-footer">
        <div>
          <strong>
            {pendingItems.length > 0
              ? `${importedItems.length} 个已导入 · ${pendingItems.length} 个待导入`
              : `${importedItems.length} 个媒体已在项目中`}
          </strong>
          <span>
            {itemCounts.video} 个视频 · {itemCounts.audio} 个音频 · {itemCounts.subtitle} 个字幕
          </span>
        </div>
        <div className="import-footer-actions">
          <button
            type="button"
            className="import-clear-button"
            onClick={clearPendingItems}
            disabled={isMediaBinReadOnly || !hasSelection || isImporting}
          >
            清除
          </button>
          <button
            type="button"
            className="import-confirm-button"
            onClick={() => void importSelectedMedia()}
            disabled={isMediaBinReadOnly || !hasSelection || isImporting}
          >
            <Upload aria-hidden="true" />
            {isImporting ? "正在导入" : "导入全部"}
          </button>
        </div>
      </footer>
    </section>
  );
}
