import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { emitAppEvent } from "./appEvents";
import { ApplicationMenu } from "./components/ApplicationMenu";
import {
  DockLayout,
  type DockLayoutState,
  type DockPanelDefinition,
} from "./components/DockLayout";
import { ExportPanel } from "./components/ExportPanel";
import { ImportWorkspace } from "./components/ImportWorkspace";
import { PreferencesDialog } from "./components/PreferencesDialog";
import { ProxyCreationDialog } from "./components/ProxyCreationDialog";
import { SecondaryTopbar } from "./components/SecondaryTopbar";
import { SourceMonitor } from "./components/SourceMonitor";
import { SubtitlePanel } from "./components/SubtitlePanel";
import {
  cancelAllTaskProgress,
  createTaskProgress,
  getTaskProgressStatus,
} from "./components/TaskProgress";
import { cancelFfmpegTask, createFfmpegTaskId, listenToFfmpegTaskProgress } from "./ffmpegProgress";
import { useAppStore } from "./store";
import { isTauriRuntime } from "./tauriRuntime";
import type { AddExternalSubtitlesResult, OpenProjectResult, Preferences } from "./types";

const projectFilters = [
  {
    name: "LineCut Project",
    extensions: ["lcp"],
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

type AppDockPanelId = "source" | "export" | "subtitles";

const appWorkspaces = [
  { id: "import", label: "导入" },
  { id: "edit", label: "编辑" },
] as const;

type AppWorkspace = (typeof appWorkspaces)[number]["id"];

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
  const [activeWorkspace, setActiveWorkspace] = useState<AppWorkspace>("edit");
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const closingWindowRef = useRef(false);

  const project = useAppStore((state) => state.project);
  const projectFilePath = useAppStore((state) => state.projectFilePath);
  const projectDirty = useAppStore((state) => state.projectDirty);
  const activeTrackId = useAppStore((state) => state.activeTrackId);
  const selectedCueCount = useAppStore((state) => state.selectedCueIds.size);
  const message = useAppStore((state) => state.message);
  const warnings = useAppStore((state) => state.warnings);
  const exportResult = useAppStore((state) => state.exportResult);
  const projectOpened = useAppStore((state) => state.actions.projectOpened);
  const projectSaved = useAppStore((state) => state.actions.projectSaved);
  const projectClosed = useAppStore((state) => state.actions.projectClosed);
  const subtitleTracksAdded = useAppStore((state) => state.actions.subtitleTracksAdded);
  const preferencesLoaded = useAppStore((state) => state.actions.preferencesLoaded);
  const messagePublished = useAppStore((state) => state.actions.messagePublished);
  const warningsReplaced = useAppStore((state) => state.actions.warningsReplaced);
  const warningsAppended = useAppStore((state) => state.actions.warningsAppended);
  const { tasks: runningTasks } = getTaskProgressStatus();
  const isBusy = runningTasks.length > 0;
  const hasProject = Boolean(projectFilePath || project);
  const activeTrackCues = useMemo(
    () => (project && activeTrackId ? (project.cues[activeTrackId] ?? []) : []),
    [activeTrackId, project],
  );
  const canSelectAllSubtitleCues = activeWorkspace === "edit" && activeTrackCues.length > 0;
  const canClearSubtitleCueSelection = activeWorkspace === "edit" && selectedCueCount > 0;
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
        preferencesLoaded(loaded);
      })
      .catch((error) => messagePublished(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    const projectTitle = projectFilePath ?? (project ? "未命名项目" : "");
    const title = ` LineCut${projectTitle ? ` - ${projectTitle}${projectDirty ? " *" : ""}` : ""}`;
    void getCurrentWindow().setTitle(title);
  }, [project, projectDirty, projectFilePath]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let unlistenCloseRequested: (() => void) | undefined;

    const currentWindow = getCurrentWindow();
    void currentWindow
      .onCloseRequested(async (event) => {
        if (!projectDirty || closingWindowRef.current) {
          await cancelAllTaskProgress();
          return;
        }

        event.preventDefault();
        const shouldClose = await confirm("项目有尚未保存的更改，确定要退出吗？", {
          title: "LineCut",
          kind: "warning",
          okLabel: "退出",
          cancelLabel: "取消",
        });
        if (!shouldClose) {
          return;
        }
        closingWindowRef.current = true;
        await cancelAllTaskProgress();
        await currentWindow.destroy();
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenCloseRequested = unlisten;
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlistenCloseRequested?.();
    };
  }, [projectDirty]);

  function publishError(error: unknown) {
    messagePublished(error instanceof Error ? error.message : String(error));
  }

  async function confirmDiscardChanges(message: string) {
    if (!projectDirty) {
      return true;
    }
    if (!isTauriRuntime()) {
      return window.confirm(message);
    }
    return confirm(message, {
      title: "LineCut",
      kind: "warning",
      okLabel: "不保存",
      cancelLabel: "取消",
    });
  }

  async function removeBackendProject(assetId = project?.asset.id) {
    if (!assetId || !isTauriRuntime()) {
      return;
    }
    await invoke("close_project", { assetId });
  }

  async function exitApplication() {
    if (!isTauriRuntime()) {
      window.close();
      return;
    }
    await getCurrentWindow().close();
  }

  async function newProject() {
    if (!isTauriRuntime()) {
      messagePublished("请在 Tauri 桌面窗口中新建项目。");
      return;
    }
    if (!(await confirmDiscardChanges("当前项目有尚未保存的更改，仍要新建项目吗？"))) {
      return;
    }

    try {
      await removeBackendProject();
      projectClosed();
      setActiveWorkspace("import");
      messagePublished("已新建项目");
    } catch (error) {
      publishError(error);
    }
  }

  async function openProject() {
    if (!isTauriRuntime()) {
      messagePublished("请在 Tauri 桌面窗口中打开项目。");
      return;
    }
    if (!(await confirmDiscardChanges("当前项目有尚未保存的更改，仍要打开其他项目吗？"))) {
      return;
    }
    const picked = await open({
      multiple: false,
      title: "打开 LineCut 项目",
      filters: projectFilters,
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) {
      return;
    }

    try {
      const oldAssetId = project?.asset.id;
      const result = await invoke<OpenProjectResult>("open_project_file", { path });
      if (oldAssetId && oldAssetId !== result.project?.asset.id) {
        await removeBackendProject(oldAssetId);
      }
      projectOpened(result.project, result.path);
      warningsReplaced(result.warnings);
      messagePublished(`已打开项目 ${fileName(result.path)}`);
    } catch (error) {
      publishError(error);
    }
  }

  async function closeProject() {
    if (!(await confirmDiscardChanges("当前项目有尚未保存的更改，仍要关闭吗？"))) {
      return;
    }
    try {
      await removeBackendProject();
      projectClosed();
      messagePublished("项目已关闭");
    } catch (error) {
      publishError(error);
    }
  }

  async function writeProject(path: string, makeCurrent: boolean) {
    const savedPath = await invoke<string>("save_project_file", {
      path,
      assetId: project?.asset.id ?? null,
    });
    if (makeCurrent) {
      projectSaved(savedPath);
      messagePublished(`项目已保存到 ${savedPath}`);
    } else {
      messagePublished(`项目副本已保存到 ${savedPath}`);
    }
  }

  function suggestedProjectName() {
    if (projectFilePath) {
      return projectFilePath;
    }
    const mediaName = project?.asset.file_name.replace(/\.[^.]+$/, "") || "未命名项目";
    return `${mediaName}.lcp`;
  }

  async function saveProjectAs(makeCurrent = true) {
    if (!isTauriRuntime()) {
      messagePublished("请在 Tauri 桌面窗口中保存项目。");
      return;
    }
    const picked = await save({
      title: makeCurrent ? "项目另存为" : "保存项目副本",
      defaultPath: suggestedProjectName(),
      filters: projectFilters,
    });
    if (!picked) {
      return;
    }
    try {
      await writeProject(picked, makeCurrent);
    } catch (error) {
      publishError(error);
    }
  }

  async function saveProject() {
    if (!projectFilePath) {
      await saveProjectAs(true);
      return;
    }
    try {
      await writeProject(projectFilePath, true);
    } catch (error) {
      publishError(error);
    }
  }

  function openImportWorkspace() {
    setActiveWorkspace("import");
  }

  function selectAllSubtitleCues() {
    emitAppEvent("subtitle:select-all");
  }

  function clearSubtitleCueSelection() {
    emitAppEvent("subtitle:clear-selection");
  }

  async function chooseExternalSubtitles() {
    if (!isTauriRuntime()) {
      messagePublished("请在 Tauri 桌面窗口中选择本地外挂字幕。");
      return;
    }
    if (!project) {
      messagePublished("请先在导入工作区选择视频和字幕。");
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

    const subtitleTaskId = createFfmpegTaskId("subtitle-import");
    let subtitleImportCancelled = false;
    const subtitleImportTask = await createTaskProgress({
      operation: "subtitle_import",
      label: "导入外挂字幕",
      current: 0,
      total: 1,
      listener: listenToFfmpegTaskProgress(subtitleTaskId),
      on_cancel: async () => {
        await cancelFfmpegTask(subtitleTaskId);
        subtitleImportCancelled = true;
      },
    });
    try {
      const result = await invoke<AddExternalSubtitlesResult>("add_external_subtitles", {
        assetId: project.asset.id,
        paths,
        taskId: subtitleTaskId,
      });
      subtitleTracksAdded(result.tracks, result.cues);
      if (result.warnings.length > 0) {
        warningsAppended(result.warnings);
      }
      messagePublished("外挂字幕已导入");
      subtitleImportTask.update({ current: 1 });
      subtitleImportTask.remove();
    } catch (error) {
      if (subtitleImportCancelled) {
        messagePublished("外挂字幕导入已取消");
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      subtitleImportTask.fail("导入外挂字幕失败", errorMessage);
      messagePublished(errorMessage);
    }
  }

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.repeat) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "q" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        void exitApplication();
        return;
      }
      if (isBusy) {
        return;
      }
      if (key === "a" && event.target instanceof HTMLInputElement) {
        return;
      }
      let action: (() => void | Promise<void>) | undefined;
      if (key === "n" && !event.shiftKey && !event.altKey) action = newProject;
      if (key === "o" && !event.shiftKey && !event.altKey) action = openProject;
      if (key === "i" && !event.shiftKey && !event.altKey) action = openImportWorkspace;
      if (key === "a" && !event.shiftKey && !event.altKey && canSelectAllSubtitleCues) {
        action = selectAllSubtitleCues;
      }
      if (key === "a" && event.shiftKey && !event.altKey && canClearSubtitleCueSelection) {
        action = clearSubtitleCueSelection;
      }
      if (key === "w" && event.shiftKey && !event.altKey && hasProject) action = closeProject;
      if (key === "s" && !event.shiftKey && !event.altKey && hasProject) action = saveProject;
      if (key === "s" && event.shiftKey && !event.altKey && hasProject) {
        action = () => saveProjectAs(true);
      }
      if (key === "s" && !event.shiftKey && event.altKey && hasProject) {
        action = () => saveProjectAs(false);
      }
      if (!action) {
        return;
      }
      event.preventDefault();
      void action();
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  });

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

  const workspaceContent: Record<AppWorkspace, ReactNode> = {
    import: <ImportWorkspace onImportCompleted={() => setActiveWorkspace("edit")} />,
    edit: <DockLayout panels={dockPanels} initialLayout={initialDockLayout} />,
  };

  return (
    <div className="app-shell">
      <header className="application-menubar">
        <ApplicationMenu
          hasProject={hasProject}
          hasMedia={Boolean(project)}
          isDirty={projectDirty}
          isBusy={isBusy}
          onNewProject={newProject}
          onOpenProject={openProject}
          onCloseProject={closeProject}
          onSaveProject={saveProject}
          onSaveProjectAs={() => saveProjectAs(true)}
          onSaveProjectCopy={() => saveProjectAs(false)}
          onImportMedia={openImportWorkspace}
          onImportSubtitles={chooseExternalSubtitles}
          canSelectAllSubtitleCues={canSelectAllSubtitleCues}
          canClearSubtitleCueSelection={canClearSubtitleCueSelection}
          onSelectAllSubtitleCues={selectAllSubtitleCues}
          onClearSubtitleCueSelection={clearSubtitleCueSelection}
          onOpenPreferences={() => setPreferencesOpen(true)}
          onExit={exitApplication}
        />
      </header>

      <SecondaryTopbar
        projectFilePath={projectFilePath}
        hasProjectMedia={Boolean(project)}
        isProjectDirty={projectDirty}
        workspaces={appWorkspaces}
        activeWorkspace={activeWorkspace}
        isWorkspaceSwitchingDisabled={isBusy}
        onWorkspaceChange={setActiveWorkspace}
      />

      {workspaceContent[activeWorkspace]}

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
