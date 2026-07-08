import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { Captions, FolderOpen, Loader2, Settings, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  DockLayout,
  type DockLayoutState,
  type DockPanelDefinition,
} from "./components/DockLayout";
import { ExportPanel } from "./components/ExportPanel";
import { PreferencesDialog } from "./components/PreferencesDialog";
import { ProxyCreationDialog } from "./components/ProxyCreationDialog";
import { SourceMonitor } from "./components/SourceMonitor";
import { SubtitlePanel } from "./components/SubtitlePanel";
import {
  TaskProgress,
  cancelAllTaskProgress,
  createTaskProgress,
  getTaskProgressStatus,
} from "./components/TaskProgress";
import { listenToFfmpegTaskProgress } from "./ffmpegProgress";
import { useAppStore } from "./store";
import { isTauriRuntime } from "./tauriRuntime";
import type { AddExternalSubtitlesResult, ImportResult, Preferences } from "./types";

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

const appIconUrl = new URL("../src-tauri/icons/icon.ico", import.meta.url).href;

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

type AppDockPanelId = "source" | "export" | "subtitles";

const initialDockLayout: DockLayoutState<AppDockPanelId> = {
  areas: {
    leftTop: {
      tabs: ["source"],
      activePanelId: "source",
    },
    leftBottom: {
      tabs: ["export"],
      activePanelId: "export",
    },
    right: {
      tabs: ["subtitles"],
      activePanelId: "subtitles",
    },
  },
};

export default function App() {
  const [externalSubtitlePaths, setExternalSubtitlePaths] = useState<string[]>([]);
  const [preferencesOpen, setPreferencesOpen] = useState(false);

  const project = useAppStore((state) => state.project);
  const message = useAppStore((state) => state.message);
  const warnings = useAppStore((state) => state.warnings);
  const exportResult = useAppStore((state) => state.exportResult);
  const setProject = useAppStore((state) => state.setProject);
  const addExternalSubtitles = useAppStore((state) => state.addExternalSubtitles);
  const setPreferences = useAppStore((state) => state.setPreferences);
  const setMessage = useAppStore((state) => state.setMessage);
  const setWarnings = useAppStore((state) => state.setWarnings);
  const setExportResult = useAppStore((state) => state.setExportResult);
  const { tasks: runningTasks } = getTaskProgressStatus();
  const isImportingMedia = runningTasks.some((task) => task.operation === "import");
  const isImportingSubtitles = runningTasks.some((task) => task.operation === "subtitle_import");
  const activeStatusLabel =
    runningTasks.length === 1 ? runningTasks[0].label : `正在执行 ${runningTasks.length} 项操作...`;

  useEffect(() => {
    const suppressBareAltKey = (event: KeyboardEvent) => {
      if (event.key !== "Alt") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", suppressBareAltKey, true);
    window.addEventListener("keyup", suppressBareAltKey, true);
    return () => {
      window.removeEventListener("keydown", suppressBareAltKey, true);
      window.removeEventListener("keyup", suppressBareAltKey, true);
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    void invoke<Preferences>("get_preferences")
      .then((loaded) => {
        setPreferences(loaded);
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    const baseTitle = " LineCut";
    const title = project?.asset.file_name
      ? `${baseTitle} - ${project.asset.file_name}`
      : baseTitle;
    void getCurrentWindow().setTitle(title);
  }, [project]);

  useEffect(() => {
    let closeCancelPromise: Promise<void> | null = null;
    let unlistenCloseRequested: (() => void) | undefined;

    function cancelBeforeClose() {
      if (!closeCancelPromise) {
        closeCancelPromise = (async () => {
          await cancelAllTaskProgress();
          await cancelCurrentTask();
        })();
      }
      return closeCancelPromise;
    }

    function handleBeforeUnload() {
      void cancelBeforeClose();
    }

    window.addEventListener("beforeunload", handleBeforeUnload);

    if (isTauriRuntime()) {
      let disposed = false;
      void getCurrentWindow()
        .onCloseRequested(async () => {
          await cancelBeforeClose();
        })
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          unlistenCloseRequested = unlisten;
        })
        .catch(() => undefined);

      return () => {
        disposed = true;
        unlistenCloseRequested?.();
        window.removeEventListener("beforeunload", handleBeforeUnload);
      };
    }

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  async function chooseExternalSubtitles() {
    if (!isTauriRuntime()) {
      setMessage("请在 Tauri 桌面窗口中选择本地外挂字幕。");
      return;
    }
    const picked = await open({
      multiple: true,
      filters: subtitleFilters,
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) {
      return;
    }

    if (project) {
      const subtitleImportTask = createTaskProgress({
        operation: "subtitle_import",
        label: "导入外挂字幕",
        current: 0,
        total: 1,
        on_cancel: () => undefined,
      });
      try {
        const result = await invoke<AddExternalSubtitlesResult>("add_external_subtitles", {
          assetId: project.asset.id,
          paths,
        });
        addExternalSubtitles(result.tracks, result.cues);
        if (result.warnings.length > 0) {
          setWarnings((current) => [...current, ...result.warnings]);
        }
        setMessage("外挂字幕已导入");
        subtitleImportTask.update({ current: 1 });
        subtitleImportTask.remove();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        subtitleImportTask.fail("导入外挂字幕失败", errorMessage);
        setMessage(errorMessage);
      }
    } else {
      setExternalSubtitlePaths((current) => Array.from(new Set([...current, ...paths])));
    }
  }

  async function importVideo() {
    if (!isTauriRuntime()) {
      setMessage("浏览器预览不能导入本地 MKV，请运行 Tauri 桌面应用。");
      return;
    }
    const picked = await open({
      multiple: false,
      filters: videoFilters,
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) {
      return;
    }

    const importTaskId = `import:${path}`;
    let importCancelled = false;
    const importTask = createTaskProgress({
      operation: "import",
      label: "正在探测媒体并抽取字幕",
      current: 0,
      total: 1,
      on_cancel: () => {
        importCancelled = true;
        return cancelCurrentTask();
      },
    });
    setWarnings([]);
    setExportResult(null);
    const stopProgressListener = await listenToFfmpegTaskProgress(importTaskId, importTask);
    try {
      const result = await invoke<ImportResult>("import_media", {
        path,
        externalSubtitles: externalSubtitlePaths,
      });
      setProject(result.project);
      setWarnings(result.warnings);
      setExternalSubtitlePaths([]);
      setMessage(`已导入 ${result.project.asset.file_name}`);
      importTask.update({ current: 1 });
      importTask.remove();
    } catch (error) {
      if (importCancelled) {
        setMessage("导入已取消");
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      importTask.fail("导入视频失败", errorMessage);
      setMessage(errorMessage);
    } finally {
      stopProgressListener();
    }
  }

  async function cancelCurrentTask() {
    if (!isTauriRuntime()) {
      setMessage("浏览器预览没有可取消的后台任务");
      return;
    }
    try {
      const cancelled = await invoke<boolean>("cancel_current_task");
      setMessage(cancelled ? "正在取消任务" : "当前没有可取消的 FFmpeg 任务");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const dockPanels = useMemo<Array<DockPanelDefinition<AppDockPanelId>>>(
    () => [
      {
        id: "source",
        title: `源：${project?.asset.file_name ?? "（无剪辑）"}`,
        render: () => <SourceMonitor />,
      },
      {
        id: "export",
        title: "导出设置",
        render: () => <ExportPanel />,
      },
      {
        id: "subtitles",
        title: "字幕轨",
        render: () => <SubtitlePanel />,
      },
    ],
    [project?.asset.file_name],
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <img src={appIconUrl} alt="" className="app-icon" />
            <TaskProgress>
              <div className="brand-copy">
                <strong>LineCut</strong>
                <span>对白检索与片段导出</span>
              </div>
            </TaskProgress>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="toolbar-button" onClick={() => setPreferencesOpen(true)}>
            <Settings size={16} />
            首选项
          </button>
          <button
            className="toolbar-button"
            onClick={chooseExternalSubtitles}
            disabled={isImportingSubtitles}
          >
            <Captions size={16} />
            外挂字幕
          </button>
          <button className="accent-button" onClick={importVideo} disabled={isImportingMedia}>
            {isImportingMedia ? <Loader2 className="spin" size={16} /> : <FolderOpen size={16} />}
            导入视频
          </button>
        </div>
      </header>

      {externalSubtitlePaths.length > 0 && (
        <div className="subtitle-strip">
          <span>外挂字幕</span>
          {externalSubtitlePaths.map((path) => (
            <button
              key={path}
              className="subtitle-chip"
              onClick={() =>
                setExternalSubtitlePaths((current) => current.filter((item) => item !== path))
              }
              title={path}
            >
              {fileName(path)}
              <X size={13} />
            </button>
          ))}
        </div>
      )}

      <DockLayout panels={dockPanels} initialLayout={initialDockLayout} />

      <footer className="statusbar">
        <span className={runningTasks.length > 0 ? "busy-status" : ""}>
          {runningTasks.length > 0 ? (
            <>
              <Loader2 className="spin" size={14} />
              {activeStatusLabel}
            </>
          ) : (
            message
          )}
        </span>
        {warnings.length > 0 && <span>{warnings.length} 条导入提示</span>}
        {exportResult && (
          <span title={exportResult.files.join("\n")}>{exportResult.output_dir}</span>
        )}
      </footer>

      {(warnings.length > 0 || exportResult) && (
        <aside className="event-drawer">
          {warnings.map((warning) => (
            <div key={warning} className="event warning">
              {warning}
            </div>
          ))}
          {exportResult?.log.map((item) => (
            <div key={item} className="event">
              {item}
            </div>
          ))}
        </aside>
      )}

      <ProxyCreationDialog />
      <PreferencesDialog open={preferencesOpen} onClose={() => setPreferencesOpen(false)} />
    </div>
  );
}
