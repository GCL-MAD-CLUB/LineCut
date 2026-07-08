import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { Captions, FolderOpen, Loader2, Settings, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DockLayout, type DockLayoutState, type DockPanelDefinition } from "./components/DockLayout";
import { ExportPanel } from "./components/ExportPanel";
import { PreferencesDialog } from "./components/PreferencesDialog";
import { ProxyCreationDialog } from "./components/ProxyCreationDialog";
import { SourceMonitor } from "./components/SourceMonitor";
import { SubtitlePanel } from "./components/SubtitlePanel";
import { TaskProgress, clearTaskProgress, removeTaskProgress, showTaskProgress } from "./components/TaskProgress";
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
  const busyLabel = useAppStore((state) => state.busyLabel);
  const message = useAppStore((state) => state.message);
  const warnings = useAppStore((state) => state.warnings);
  const exportResult = useAppStore((state) => state.exportResult);
  const setProject = useAppStore((state) => state.setProject);
  const addExternalSubtitles = useAppStore((state) => state.addExternalSubtitles);
  const setPreferences = useAppStore((state) => state.setPreferences);
  const setBusyLabel = useAppStore((state) => state.setBusyLabel);
  const setMessage = useAppStore((state) => state.setMessage);
  const setWarnings = useAppStore((state) => state.setWarnings);
  const setExportResult = useAppStore((state) => state.setExportResult);

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
    const title = project?.asset.file_name ? `${baseTitle} - ${project.asset.file_name}` : baseTitle;
    void getCurrentWindow().setTitle(title);
  }, [project]);

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
      setBusyLabel("正在导入外挂字幕");
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
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyLabel("");
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

    setBusyLabel("正在探测媒体并抽取字幕");
    const importTaskId = `import:${path}`;
    showTaskProgress({
      task_id: importTaskId,
      operation: "import",
      label: "导入媒体",
      current: 0,
      total: 1,
      progress: 0,
      done: false,
    });
    setWarnings([]);
    setExportResult(null);
    try {
      const result = await invoke<ImportResult>("import_media", {
        path,
        externalSubtitles: externalSubtitlePaths,
      });
      setProject(result.project);
      setWarnings(result.warnings);
      setExternalSubtitlePaths([]);
      setMessage(`已导入 ${result.project.asset.file_name}`);
      removeTaskProgress(importTaskId);
    } catch (error) {
      removeTaskProgress(importTaskId);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyLabel("");
    }
  }

  async function cancelCurrentTask() {
    if (!isTauriRuntime()) {
      clearTaskProgress();
      return;
    }
    try {
      const cancelled = await invoke<boolean>("cancel_current_task");
      setMessage(cancelled ? "正在取消任务" : "当前没有可取消的 FFmpeg 任务");
      if (!cancelled) {
        clearTaskProgress();
      }
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
            <TaskProgress onCancel={cancelCurrentTask}>
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
          <button className="toolbar-button" onClick={chooseExternalSubtitles} disabled={Boolean(busyLabel)}>
            <Captions size={16} />
            外挂字幕
          </button>
          <button className="accent-button" onClick={importVideo} disabled={Boolean(busyLabel)}>
            {busyLabel ? <Loader2 className="spin" size={16} /> : <FolderOpen size={16} />}
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
        <span className={busyLabel ? "busy-status" : ""}>
          {busyLabel ? (
            <>
              <Loader2 className="spin" size={14} />
              {busyLabel}
            </>
          ) : (
            message
          )}
        </span>
        {warnings.length > 0 && <span>{warnings.length} 条导入提示</span>}
        {exportResult && <span title={exportResult.files.join("\n")}>{exportResult.output_dir}</span>}
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
