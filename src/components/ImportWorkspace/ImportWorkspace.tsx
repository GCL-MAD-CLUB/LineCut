import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Captions,
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
import { cancelFfmpegTask, createFfmpegTaskId } from "../../ffmpegProgress";
import { useAppStore } from "../../store";
import { isTauriRuntime } from "../../tauriRuntime";
import type { ImportResult, MediaBinItem } from "../../types";
import { createTaskProgress, getTaskProgressStatus } from "../TaskProgress";
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
  return Array.from(new Set([...current, ...additions]));
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
    kind: "subtitle",
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
    color: "#893a04",
  };
}

export function ImportWorkspace({ onImportCompleted }: ImportWorkspaceProps) {
  const [videoPaths, setVideoPaths] = useState<string[]>([]);
  const [audioPaths, setAudioPaths] = useState<string[]>([]);
  const [subtitlePaths, setSubtitlePaths] = useState<string[]>([]);
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
  const hasSelection = pendingItems.length > 0;

  async function choosePaths(kind: PendingMediaKind, filters: typeof videoFilters, title: string) {
    if (!isTauriRuntime()) {
      messagePublished("请在 Tauri 桌面窗口中选择本地素材。");
      return;
    }
    const picked = await open({ multiple: true, title, filters });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) {
      return;
    }
    if (kind === "video") {
      setVideoPaths((current) => uniquePaths(current, paths));
    } else if (kind === "audio") {
      setAudioPaths((current) => uniquePaths(current, paths));
    } else {
      setSubtitlePaths((current) => uniquePaths(current, paths));
    }
    messagePublished(`已添加 ${paths.length} 个${pendingMediaLabel(kind)}文件`);
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
    if (!isTauriRuntime()) {
      messagePublished("浏览器预览不能导入本地媒体，请运行 Tauri 桌面应用。");
      return;
    }
    if (!hasSelection) {
      messagePublished("请先选择需要导入的媒体。");
      return;
    }

    const probeItems = pendingItems.filter((item) => item.kind !== "subtitle");
    const totalSteps = probeItems.length + (subtitlePaths.length > 0 ? 1 : 0);
    let currentTaskId = "";
    let importCancelled = false;
    const importTask = await createTaskProgress({
      operation: "import",
      label: `正在导入 ${pendingItems.length} 个素材`,
      current: 0,
      total: Math.max(1, totalSteps),
      on_cancel: async () => {
        importCancelled = true;
        if (currentTaskId) {
          await cancelFfmpegTask(currentTaskId);
        }
      },
    });
    exportResultChanged(null);

    const loadedResults: ImportResult[] = [];
    const errors: string[] = [];
    let completedSteps = 0;
    for (const item of probeItems) {
      if (importCancelled) {
        break;
      }
      currentTaskId = createFfmpegTaskId(`import-${item.kind}`);
      importTask.update({ label: `正在探测 ${fileName(item.path)}` });
      try {
        const result = await invoke<ImportResult>("import_media", {
          path: item.path,
          externalSubtitles: [],
          taskId: currentTaskId,
        });
        loadedResults.push(result);
      } catch (error) {
        if (!importCancelled) {
          errors.push(
            `${fileName(item.path)}：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      completedSteps += 1;
      importTask.update({ current: completedSteps });
    }

    if (loadedResults.length > 0) {
      mediaProjectsAdded(loadedResults.map((result) => result.project));
      warningsAppended(loadedResults.flatMap((result) => result.warnings));
    }
    if (!importCancelled && subtitlePaths.length > 0) {
      mediaItemsAdded(subtitlePaths.map(standaloneSubtitleItem));
      completedSteps += 1;
      importTask.update({ current: completedSteps });
    }

    if (importCancelled) {
      messagePublished("媒体导入已取消");
      return;
    }

    const importedCount = loadedResults.length + subtitlePaths.length;
    clearPendingItems();
    if (errors.length > 0) {
      importTask.fail("部分素材导入失败", errors.join("\n"));
      messagePublished(`已导入 ${importedCount} 个素材，${errors.length} 个失败`);
    } else {
      importTask.remove();
      messagePublished(`已导入 ${importedCount} 个素材`);
    }
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
          <p>批量选择视频、音频和字幕；所有视频作为同级素材加入素材箱。</p>
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
            <span>待导入素材</span>
            <strong>{pendingItems.length}</strong>
          </div>
          <dl>
            <div>
              <dt>视频</dt>
              <dd>{videoPaths.length}</dd>
            </div>
            <div>
              <dt>音频</dt>
              <dd>{audioPaths.length}</dd>
            </div>
            <div>
              <dt>字幕</dt>
              <dd>{subtitlePaths.length}</dd>
            </div>
          </dl>
        </aside>

        <div className="import-browser-main">
          <div className="import-browser-toolbar">
            <div className="import-breadcrumb" title="本地媒体 / 待导入素材">
              <FolderOpen aria-hidden="true" />
              <span>本地媒体</span>
              <ChevronRight aria-hidden="true" />
              <strong>待导入素材</strong>
            </div>
            <div className="import-picker-actions">
              <button
                type="button"
                onClick={() => void choosePaths("video", videoFilters, "添加多个视频")}
                disabled={isImporting}
              >
                <FileVideo2 aria-hidden="true" /> 添加视频
              </button>
              <button
                type="button"
                onClick={() => void choosePaths("audio", audioFilters, "添加多个音频")}
                disabled={isImporting}
              >
                <FileAudio2 aria-hidden="true" /> 添加音频
              </button>
              <button
                type="button"
                onClick={() => void choosePaths("subtitle", subtitleFilters, "添加多个字幕")}
                disabled={isImporting}
              >
                <Plus aria-hidden="true" /> 添加字幕
              </button>
            </div>
          </div>

          <div className="import-file-list" role="table" aria-label="待导入素材">
            <div className="import-file-list-header" role="row">
              <span role="columnheader">名称</span>
              <span role="columnheader">类型</span>
              <span role="columnheader">所在位置</span>
              <span role="columnheader" aria-label="操作" />
            </div>

            {!hasSelection && (
              <div className="import-empty-state">
                <Upload aria-hidden="true" />
                <strong>选择要导入的本地媒体</strong>
                <span>可以一次添加多个视频、音频和字幕文件。</span>
                <button
                  type="button"
                  onClick={() => void choosePaths("video", videoFilters, "添加多个视频")}
                >
                  选择视频
                </button>
              </div>
            )}

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
                  disabled={isImporting}
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
            {pendingItems.length > 0 ? `${pendingItems.length} 个素材待导入` : "尚未选择素材"}
          </strong>
          <span>
            {videoPaths.length} 个视频 · {audioPaths.length} 个音频 · {subtitlePaths.length} 个字幕
          </span>
        </div>
        <div className="import-footer-actions">
          <button
            type="button"
            className="import-clear-button"
            onClick={clearPendingItems}
            disabled={!hasSelection || isImporting}
          >
            清除
          </button>
          <button
            type="button"
            className="import-confirm-button"
            onClick={() => void importSelectedMedia()}
            disabled={!hasSelection || isImporting}
          >
            <Upload aria-hidden="true" />
            {isImporting ? "正在导入" : "导入全部"}
          </button>
        </div>
      </footer>
    </section>
  );
}
