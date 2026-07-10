import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import {
  Captions,
  ChevronRight,
  FileVideo2,
  FolderOpen,
  HardDrive,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { createTaskProgress, getTaskProgressStatus } from "../TaskProgress";
import {
  cancelFfmpegTask,
  createFfmpegTaskId,
  listenToFfmpegTaskProgress,
} from "../../ffmpegProgress";
import { useAppStore } from "../../store";
import { isTauriRuntime } from "../../tauriRuntime";
import type { ImportResult } from "../../types";
import "./ImportWorkspace.css";

interface ImportWorkspaceProps {
  onImportCompleted?: () => void;
}

const videoFilters = [
  {
    name: "Video",
    extensions: ["mkv", "mp4", "mov", "webm", "avi", "ts", "m2ts"],
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

export function ImportWorkspace({ onImportCompleted }: ImportWorkspaceProps) {
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [subtitlePaths, setSubtitlePaths] = useState<string[]>([]);
  const project = useAppStore((state) => state.project);
  const projectImported = useAppStore((state) => state.actions.projectImported);
  const messagePublished = useAppStore((state) => state.actions.messagePublished);
  const warningsReplaced = useAppStore((state) => state.actions.warningsReplaced);
  const exportResultChanged = useAppStore((state) => state.actions.exportResultChanged);
  const { isRunning: isImporting } = getTaskProgressStatus("import");
  const hasSelection = Boolean(videoPath || subtitlePaths.length > 0);

  async function chooseVideo() {
    if (!isTauriRuntime()) {
      messagePublished("请在 Tauri 桌面窗口中选择本地视频。");
      return;
    }
    const picked = await open({
      multiple: false,
      title: "选择要导入的视频",
      filters: videoFilters,
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) {
      setVideoPath(path);
      messagePublished(`已选择 ${fileName(path)}`);
    }
  }

  async function chooseSubtitles() {
    if (!isTauriRuntime()) {
      messagePublished("请在 Tauri 桌面窗口中选择本地字幕。");
      return;
    }
    const picked = await open({
      multiple: true,
      title: "添加字幕文件",
      filters: subtitleFilters,
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length > 0) {
      setSubtitlePaths((current) => Array.from(new Set([...current, ...paths])));
      messagePublished(`已添加 ${paths.length} 个字幕文件`);
    }
  }

  async function removeBackendProject(assetId = project?.asset.id) {
    if (!assetId || !isTauriRuntime()) {
      return;
    }
    await invoke("close_project", { assetId });
  }

  async function importSelectedMedia() {
    if (!isTauriRuntime()) {
      messagePublished("浏览器预览不能导入本地 MKV，请运行 Tauri 桌面应用。");
      return;
    }
    if (!videoPath) {
      messagePublished("请先选择一个视频。");
      return;
    }
    if (project) {
      const shouldReplace = await confirm("导入新媒体会替换当前项目中的媒体及字幕，是否继续？", {
        title: "LineCut",
        kind: "warning",
        okLabel: "继续导入",
        cancelLabel: "取消",
      });
      if (!shouldReplace) {
        return;
      }
    }

    const importTaskId = createFfmpegTaskId("import");
    let importCancelled = false;
    const importTask = await createTaskProgress({
      operation: "import",
      label: "正在探测媒体并抽取字幕",
      current: 0,
      total: 1,
      listener: listenToFfmpegTaskProgress(importTaskId),
      on_cancel: async () => {
        await cancelFfmpegTask(importTaskId);
        importCancelled = true;
      },
    });
    warningsReplaced([]);
    exportResultChanged(null);
    try {
      const oldAssetId = project?.asset.id;
      const result = await invoke<ImportResult>("import_media", {
        path: videoPath,
        externalSubtitles: subtitlePaths,
        taskId: importTaskId,
      });
      if (oldAssetId && oldAssetId !== result.project.asset.id) {
        await removeBackendProject(oldAssetId);
      }
      projectImported(result.project);
      warningsReplaced(result.warnings);
      setVideoPath(null);
      setSubtitlePaths([]);
      messagePublished(`已导入 ${result.project.asset.file_name}`);
      importTask.update({ current: 1 });
      importTask.remove();
      onImportCompleted?.();
    } catch (error) {
      if (importCancelled) {
        messagePublished("导入已取消");
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      importTask.fail("导入视频失败", errorMessage);
      messagePublished(errorMessage);
    }
  }

  return (
    <section className="import-workspace" aria-label="导入工作区">
      <header className="import-workspace-heading">
        <div>
          <span className="import-workspace-eyebrow">媒体浏览器</span>
          <h1>导入媒体</h1>
          <p>选择一个视频和与其配套的字幕文件，确认后将素材载入编辑工作区。</p>
        </div>
        <span className="import-workspace-limit">1 个视频 · 任意数量字幕</span>
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
            <strong>{(videoPath ? 1 : 0) + subtitlePaths.length}</strong>
          </div>
          <dl>
            <div>
              <dt>视频</dt>
              <dd>{videoPath ? "1 / 1" : "0 / 1"}</dd>
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
              <button type="button" onClick={() => void chooseVideo()} disabled={isImporting}>
                <FileVideo2 aria-hidden="true" />
                {videoPath ? "更换视频" : "选择视频"}
              </button>
              <button type="button" onClick={() => void chooseSubtitles()} disabled={isImporting}>
                <Plus aria-hidden="true" />
                添加字幕
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
                <span>先选择一个视频，也可以同时添加 SRT、ASS、SSA 或 VTT 字幕。</span>
                <button type="button" onClick={() => void chooseVideo()}>
                  选择视频
                </button>
              </div>
            )}

            {videoPath && (
              <div className="import-file-row" role="row">
                <span className="import-file-name" role="cell" title={videoPath}>
                  <span className="import-file-icon video">
                    <FileVideo2 aria-hidden="true" />
                  </span>
                  <span>
                    <strong>{fileName(videoPath)}</strong>
                    <small>主媒体</small>
                  </span>
                </span>
                <span role="cell">{extension(videoPath)} 视频</span>
                <span className="import-file-path" role="cell" title={parentPath(videoPath)}>
                  {parentPath(videoPath)}
                </span>
                <button
                  type="button"
                  className="import-remove-button"
                  onClick={() => setVideoPath(null)}
                  disabled={isImporting}
                  title="移除视频"
                  aria-label="移除视频"
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            )}

            {subtitlePaths.map((path) => (
              <div className="import-file-row" role="row" key={path}>
                <span className="import-file-name" role="cell" title={path}>
                  <span className="import-file-icon subtitle">
                    <Captions aria-hidden="true" />
                  </span>
                  <span>
                    <strong>{fileName(path)}</strong>
                    <small>外挂字幕</small>
                  </span>
                </span>
                <span role="cell">{extension(path)} 字幕</span>
                <span className="import-file-path" role="cell" title={parentPath(path)}>
                  {parentPath(path)}
                </span>
                <button
                  type="button"
                  className="import-remove-button"
                  onClick={() =>
                    setSubtitlePaths((current) => current.filter((item) => item !== path))
                  }
                  disabled={isImporting}
                  title="移除字幕"
                  aria-label={`移除字幕 ${fileName(path)}`}
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
          <strong>{videoPath ? fileName(videoPath) : "尚未选择视频"}</strong>
          <span>{subtitlePaths.length} 个字幕文件</span>
        </div>
        <div className="import-footer-actions">
          <button
            type="button"
            className="import-clear-button"
            onClick={() => {
              setVideoPath(null);
              setSubtitlePaths([]);
            }}
            disabled={!hasSelection || isImporting}
          >
            清除
          </button>
          <button
            type="button"
            className="import-confirm-button"
            onClick={() => void importSelectedMedia()}
            disabled={!videoPath || isImporting}
          >
            <Upload aria-hidden="true" />
            {isImporting ? "正在导入" : "导入"}
          </button>
        </div>
      </footer>
    </section>
  );
}
