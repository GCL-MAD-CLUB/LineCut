import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { appPanelRegistry, initialAppPanelState } from "./appPanelRegistry";
import { emitAppEvent, useAppEvent } from "./appEvents";
import { ApplicationMenu, type ApplicationMenuModel } from "./components/ApplicationMenu";
import {
  DockLayout,
  PanelManagerProvider,
  PanelRegistryProvider,
  usePanelManagerState,
  type DockAreaId,
  type OpenPanelRequest,
} from "./components/DockLayout";
import { exportPanelType } from "./components/ExportPanel";
import { HistoryPanelServicesProvider, historyPanelType } from "./components/HistoryPanel";
import { ImportWorkspace } from "./components/ImportWorkspace";
import {
  useMediaBinClipboardItemCount,
  useMediaBinState,
} from "./components/MediaBin/mediaBinState";
import { mediaBinPanelType, type MediaBinPanelParams } from "./components/MediaBin";
import { PreferencesDialog } from "./components/PreferencesDialog";
import { ProxyCreationDialog } from "./components/ProxyCreationDialog";
import { SecondaryTopbar } from "./components/SecondaryTopbar";
import { sourcePanelType } from "./components/SourceMonitor";
import { subtitlePanelType } from "./components/SubtitlePanel";
import { cancelAllTaskProgress, getTaskProgressStatus } from "./components/TaskProgress";
import { runMediaImportTask } from "./mediaImportTask";
import {
  captureOperationError,
  invokeCommand,
  runBackgroundOperation,
  runOperation,
  type OperationKey,
} from "./errors";
import { getProjectWorkspaceSnapshot, subtitleTrackCues, useAppStore } from "./store";
import { isTauriRuntime } from "./tauriRuntime";
import type { MediaBinFolder, MediaBinItem, OpenProjectResult, Preferences } from "./types";

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

const mediaFilters = [
  {
    name: "媒体文件",
    extensions: [
      "mkv",
      "mp4",
      "mov",
      "webm",
      "avi",
      "ts",
      "m2ts",
      "mpeg",
      "mpg",
      "wav",
      "mp3",
      "m4a",
      "aac",
      "flac",
      "ogg",
      "opus",
      "wma",
      "srt",
      "ass",
      "ssa",
      "vtt",
      "webvtt",
    ],
  },
];

const subtitleExtensions = new Set(subtitleFilters[0].extensions);
const recentMediaStorageKey = "linecut:recent-media-paths";
const recentProjectStorageKey = "linecut:recent-project-paths";
const recentPathsLimit = 10;
const warningDisplayDurationMs = 5000;

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function orderedMediaFolders(mediaFolders: MediaBinFolder[]) {
  const foldersByParent = new Map<string | null, MediaBinFolder[]>();
  for (const folder of mediaFolders) {
    const siblings = foldersByParent.get(folder.parent_id) ?? [];
    siblings.push(folder);
    foldersByParent.set(folder.parent_id, siblings);
  }
  const result: Array<{ folder: MediaBinFolder; depth: number }> = [];
  const visited = new Set<string>();
  const appendChildren = (parentId: string | null, depth: number) => {
    for (const folder of foldersByParent.get(parentId) ?? []) {
      if (visited.has(folder.id)) {
        continue;
      }
      visited.add(folder.id);
      result.push({ folder, depth });
      appendChildren(folder.id, depth + 1);
    }
  };
  appendChildren(null, 0);
  for (const folder of mediaFolders) {
    if (!visited.has(folder.id)) {
      visited.add(folder.id);
      result.push({ folder, depth: 0 });
      appendChildren(folder.id, 1);
    }
  }
  return result;
}

function fileExtension(path: string) {
  return fileName(path).split(".").pop()?.toLocaleLowerCase() ?? "";
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return (
    element?.tagName === "INPUT" ||
    element?.tagName === "TEXTAREA" ||
    element?.tagName === "SELECT" ||
    Boolean(element?.isContentEditable)
  );
}

function readRecentPaths(storageKey: string) {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) {
      return [];
    }
    const paths = JSON.parse(stored);
    return Array.isArray(paths)
      ? paths.filter((path): path is string => typeof path === "string").slice(0, recentPathsLimit)
      : [];
  } catch (error) {
    captureOperationError("storage.recentPaths", error);
    return [];
  }
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
    codec: fileExtension(path) || "subtitle",
    language: null,
    extracted: false,
    origin: "imported",
    color: "#893a04",
  };
}

const appWorkspaces = [
  { id: "import", label: "导入" },
  { id: "edit", label: "编辑" },
] as const;

type AppWorkspace = (typeof appWorkspaces)[number]["id"];

function AppContent() {
  const [activeWorkspace, setActiveWorkspace] = useState<AppWorkspace>("edit");
  const focusedPanelId = usePanelManagerState((state) => state.focusedPanelId);
  const panelInstances = usePanelManagerState((state) => state.instances);
  const openPanel = usePanelManagerState((state) => state.openPanel);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [historyNavigating, setHistoryNavigating] = useState(false);
  const [recentMediaPaths, setRecentMediaPaths] = useState(() =>
    readRecentPaths(recentMediaStorageKey),
  );
  const [recentProjectPaths, setRecentProjectPaths] = useState(() =>
    readRecentPaths(recentProjectStorageKey),
  );
  const closingWindowRef = useRef(false);

  const project = useAppStore((state) => state.project);
  const projects = useAppStore((state) => state.projects);
  const mediaFolders = useAppStore((state) => state.mediaFolders);
  const mediaItems = useAppStore((state) => state.mediaItems);
  const activeVideoId = useAppStore((state) => state.activeVideoId);
  const projectFilePath = useAppStore((state) => state.projectFilePath);
  const projectDirty = useAppStore((state) => state.projectDirty);
  const autoSaveIntervalMinutes = useAppStore(
    (state) => state.preferences.auto_save_interval_minutes,
  );
  const activeTrackId = useAppStore((state) => state.activeTrackId);
  const selectedCueCount = useAppStore((state) => state.selectedCueIds.size);
  const message = useAppStore((state) => state.message);
  const warnings = useAppStore((state) => state.warnings);
  const exportResult = useAppStore((state) => state.exportResult);
  const isMediaBinReadOnly = useAppStore((state) => state.mediaBinReadOnly);
  const projectHistory = useAppStore((state) => state.projectHistory);
  const focusedPanel = focusedPanelId ? panelInstances[focusedPanelId] : undefined;
  const focusedMediaPanelId = focusedPanel?.type === mediaBinPanelType ? focusedPanel.id : "media";
  const selectedMediaItemCount = useMediaBinState.useInstance(
    focusedMediaPanelId,
    (state) => state.selectedIds.size,
  );
  const mediaClipboardItemCount = useMediaBinClipboardItemCount();
  const visibleMediaItemCount = useMediaBinState.useInstance(
    focusedMediaPanelId,
    (state) => state.visibleItemCount,
  );
  const projectOpened = useAppStore((state) => state.actions.projectOpened);
  const projectCreated = useAppStore((state) => state.actions.projectCreated);
  const projectSaved = useAppStore((state) => state.actions.projectSaved);
  const projectClosed = useAppStore((state) => state.actions.projectClosed);
  const mediaProjectsAdded = useAppStore((state) => state.actions.mediaProjectsAdded);
  const mediaItemsAdded = useAppStore((state) => state.actions.mediaItemsAdded);
  const mediaItemsMovedToFolder = useAppStore((state) => state.actions.mediaItemsMovedToFolder);
  const preferencesLoaded = useAppStore((state) => state.actions.preferencesLoaded);
  const messagePublished = useAppStore((state) => state.actions.messagePublished);
  const warningsReplaced = useAppStore((state) => state.actions.warningsReplaced);
  const warningsAppended = useAppStore((state) => state.actions.warningsAppended);
  const exportResultChanged = useAppStore((state) => state.actions.exportResultChanged);
  const projectHistoryJumped = useAppStore((state) => state.actions.projectHistoryJumped);
  const projectHistoryFutureDiscarded = useAppStore(
    (state) => state.actions.projectHistoryFutureDiscarded,
  );
  const autoSaveProjectName = projectFilePath
    ? fileName(projectFilePath).replace(/\.lcp$/i, "")
    : (project?.asset.file_name ?? mediaItems[0]?.file_name)?.replace(/\.[^.]+$/, "") ||
      "未命名项目";
  const autoSaveProjectNameRef = useRef(autoSaveProjectName);
  autoSaveProjectNameRef.current = autoSaveProjectName;
  const { tasks: runningTasks } = getTaskProgressStatus();
  const isBusy = runningTasks.length > 0 || historyNavigating;
  const hasProject = Boolean(projectFilePath || mediaItems.length > 0 || mediaFolders.length > 0);
  const canUndo = projectHistory.active && projectHistory.cursor > 0;
  const canRedo = projectHistory.active && projectHistory.cursor < projectHistory.entries.length;
  const activeTrackCues = useMemo(
    () =>
      activeTrackId
        ? subtitleTrackCues(project, projects, mediaItems, activeVideoId, activeTrackId)
        : [],
    [activeTrackId, activeVideoId, mediaItems, project, projects],
  );
  const editScope = activeWorkspace === "edit" ? focusedPanel : undefined;
  const mediaEditScopeActive = editScope?.type === mediaBinPanelType;
  const focusedMediaFolderId = mediaEditScopeActive
    ? (editScope.params as MediaBinPanelParams).rootFolderId
    : null;
  const subtitleEditScopeActive = editScope?.type === subtitlePanelType;
  const canCopy = mediaEditScopeActive && selectedMediaItemCount > 0;
  const canPaste = mediaEditScopeActive && !isMediaBinReadOnly && mediaClipboardItemCount > 0;
  const canClear = mediaEditScopeActive && !isMediaBinReadOnly && selectedMediaItemCount > 0;
  const canDuplicate = canClear;
  const canSelectAll = mediaEditScopeActive
    ? visibleMediaItemCount > 0
    : subtitleEditScopeActive && activeTrackCues.length > 0;
  const canClearSelection = mediaEditScopeActive
    ? selectedMediaItemCount > 0
    : subtitleEditScopeActive && selectedCueCount > 0;
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
    if (warnings.length === 0) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      warningsReplaced([]);
    }, warningDisplayDurationMs);

    return () => window.clearTimeout(timeoutId);
  }, [warnings, warningsReplaced]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    void runOperation("preferences.load", () => invokeCommand("take_preferences_startup_error"));
    void runOperation("preferences.load", () => invokeCommand<Preferences>("get_preferences")).then(
      (outcome) => {
        if (outcome.status === "success") {
          preferencesLoaded(outcome.value);
        }
      },
    );
  }, []);

  useEffect(() => {
    if (!isTauriRuntime() || !hasProject) {
      return;
    }

    let snapshotRunning = false;
    const timer = window.setInterval(() => {
      if (snapshotRunning) {
        return;
      }
      snapshotRunning = true;
      void runOperation("project.autosave", () =>
        invokeCommand<string | null>("auto_save_project_snapshot", {
          projectName: autoSaveProjectNameRef.current,
          workspace: getProjectWorkspaceSnapshot(),
        }),
      ).finally(() => {
        snapshotRunning = false;
      });
    }, autoSaveIntervalMinutes * 60_000);

    return () => window.clearInterval(timer);
  }, [autoSaveIntervalMinutes, hasProject]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    void runOperation("project.launchPath", () =>
      invokeCommand<string | null>("take_launch_project_path"),
    ).then((outcome) => {
      if (outcome.status === "success" && outcome.value) {
        return openProject(outcome.value);
      }
    });
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(recentMediaStorageKey, JSON.stringify(recentMediaPaths));
    } catch (error) {
      captureOperationError("storage.recentPaths", error);
      // Recent imports are a convenience feature; importing itself must still work.
    }
  }, [recentMediaPaths]);

  useEffect(() => {
    try {
      window.localStorage.setItem(recentProjectStorageKey, JSON.stringify(recentProjectPaths));
    } catch (error) {
      captureOperationError("storage.recentPaths", error);
      // Recent projects are a convenience feature; opening and saving must still work.
    }
  }, [recentProjectPaths]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    const projectTitle = projectFilePath ?? (project ? "未命名项目" : "");
    const title = ` LineCut${projectTitle ? ` - ${projectTitle}${projectDirty ? " *" : ""}` : ""}`;
    runBackgroundOperation("window.title", () => getCurrentWindow().setTitle(title));
  }, [project, projectDirty, projectFilePath]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let unlistenCloseRequested: (() => void) | undefined;

    const currentWindow = getCurrentWindow();
    runBackgroundOperation("window.closeListener", async () => {
      const unlisten = await currentWindow.onCloseRequested((event) => {
        void runOperation("project.close", async () => {
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
        });
      });
      if (disposed) {
        unlisten();
      } else {
        unlistenCloseRequested = unlisten;
      }
    });

    return () => {
      disposed = true;
      unlistenCloseRequested?.();
    };
  }, [projectDirty]);

  async function confirmDiscardChanges(operation: OperationKey, message: string) {
    if (!projectDirty) {
      return true;
    }
    const outcome = await runOperation(operation, async () => {
      if (!isTauriRuntime()) {
        return window.confirm(message);
      }
      return confirm(message, {
        title: "LineCut",
        kind: "warning",
        okLabel: "不保存",
        cancelLabel: "取消",
      });
    });
    return outcome.status === "success" && outcome.value;
  }

  async function removeBackendProject(assetId?: string) {
    if (!isTauriRuntime()) {
      return;
    }
    const assetIds = assetId
      ? [assetId]
      : mediaItems
          .filter((item) => item.origin === "imported" && item.kind !== "subtitle")
          .map((item) => item.id);
    await Promise.all(assetIds.map((id) => invokeCommand("close_project", { assetId: id })));
  }

  async function exitApplication() {
    if (!isTauriRuntime()) {
      window.close();
      return;
    }
    await runOperation("project.close", () => getCurrentWindow().close());
  }

  async function newProject() {
    if (!isTauriRuntime()) {
      messagePublished("请在 Tauri 桌面窗口中新建项目。");
      return;
    }
    if (
      !(await confirmDiscardChanges("project.new", "当前项目有尚未保存的更改，仍要新建项目吗？"))
    ) {
      return;
    }

    const outcome = await runOperation("project.new", async () => {
      await removeBackendProject();
      projectCreated();
      setActiveWorkspace("import");
    });
    if (outcome.status === "success") {
      messagePublished("已新建项目");
    }
  }

  function rememberRecentProject(path: string) {
    setRecentProjectPaths((current) =>
      Array.from(new Set([path, ...current])).slice(0, recentPathsLimit),
    );
  }

  function forgetRecentProject(path: string) {
    setRecentProjectPaths((current) => current.filter((currentPath) => currentPath !== path));
  }

  async function openProject(pathToOpen?: string) {
    if (!isTauriRuntime()) {
      messagePublished("请在 Tauri 桌面窗口中打开项目。");
      return;
    }
    if (
      !(await confirmDiscardChanges(
        "project.open",
        "当前项目有尚未保存的更改，仍要打开其他项目吗？",
      ))
    ) {
      return;
    }
    const pickOutcome = pathToOpen
      ? null
      : await runOperation("project.open", () =>
          open({
            multiple: false,
            title: "打开 LineCut 项目",
            filters: projectFilters,
          }),
        );
    if (pickOutcome && pickOutcome.status !== "success") {
      return;
    }
    const picked = pathToOpen ?? (pickOutcome?.status === "success" ? pickOutcome.value : null);
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) {
      return;
    }

    const outcome = await runOperation(
      "project.open",
      () => invokeCommand<OpenProjectResult>("open_project_file", { path }),
      { displayName: fileName(path), resourceKind: "project" },
    );
    if (outcome.status === "success") {
      const result = outcome.value;
      projectOpened(result.workspace, result.path);
      warningsReplaced(result.warnings);
      rememberRecentProject(result.path);
      messagePublished(`已打开项目 ${fileName(result.path)}`);
    } else if (outcome.status === "failed") {
      if (pathToOpen) {
        forgetRecentProject(pathToOpen);
      }
    }
  }

  async function closeProject() {
    if (!(await confirmDiscardChanges("project.close", "当前项目有尚未保存的更改，仍要关闭吗？"))) {
      return;
    }
    const outcome = await runOperation("project.close", async () => {
      await removeBackendProject();
      projectClosed();
    });
    if (outcome.status === "success") {
      messagePublished("项目已关闭");
    }
  }

  async function writeProject(path: string, makeCurrent: boolean) {
    const savedPath = await invokeCommand<string>("save_project_file", {
      path,
      workspace: getProjectWorkspaceSnapshot(),
    });
    if (makeCurrent) {
      projectSaved(savedPath);
      messagePublished(`项目已保存到 ${fileName(savedPath)}`);
    } else {
      messagePublished(`项目副本已保存到 ${fileName(savedPath)}`);
    }
    rememberRecentProject(savedPath);
  }

  function suggestedProjectName() {
    if (projectFilePath) {
      return projectFilePath;
    }
    const mediaName =
      (project?.asset.file_name ?? mediaItems[0]?.file_name)?.replace(/\.[^.]+$/, "") ||
      "未命名项目";
    return `${mediaName}.lcp`;
  }

  async function saveProjectAs(makeCurrent = true) {
    if (!isTauriRuntime()) {
      messagePublished("请在 Tauri 桌面窗口中保存项目。");
      return;
    }
    const pickOutcome = await runOperation("project.save", () =>
      save({
        title: makeCurrent ? "项目另存为" : "保存项目副本",
        defaultPath: suggestedProjectName(),
        filters: projectFilters,
      }),
    );
    if (pickOutcome.status !== "success" || !pickOutcome.value) {
      return;
    }
    const picked = pickOutcome.value;
    await runOperation("project.save", () => writeProject(picked, makeCurrent), {
      displayName: fileName(picked),
      resourceKind: "project",
    });
  }

  async function saveProject() {
    if (!projectFilePath) {
      await saveProjectAs(true);
      return;
    }
    await runOperation("project.save", () => writeProject(projectFilePath, true), {
      displayName: fileName(projectFilePath),
      resourceKind: "project",
    });
  }

  function copyInEditScope() {
    if (mediaEditScopeActive) {
      emitAppEvent("media:copy", { instanceId: focusedMediaPanelId });
    }
  }

  function pasteInEditScope() {
    if (mediaEditScopeActive) {
      emitAppEvent("media:paste", { instanceId: focusedMediaPanelId });
    }
  }

  function clearInEditScope() {
    if (mediaEditScopeActive) {
      emitAppEvent("media:clear", { instanceId: focusedMediaPanelId });
    }
  }

  function duplicateInEditScope() {
    if (mediaEditScopeActive) {
      emitAppEvent("media:duplicate", { instanceId: focusedMediaPanelId });
    }
  }

  function selectAllInEditScope() {
    if (mediaEditScopeActive) {
      emitAppEvent("media:select-all", { instanceId: focusedMediaPanelId });
    } else if (subtitleEditScopeActive) {
      emitAppEvent("subtitle:select-all");
    }
  }

  function clearSelectionInEditScope() {
    if (mediaEditScopeActive) {
      emitAppEvent("media:clear-selection", { instanceId: focusedMediaPanelId });
    } else if (subtitleEditScopeActive) {
      emitAppEvent("subtitle:clear-selection");
    }
  }

  function rememberImportedMedia(paths: string[]) {
    if (paths.length === 0) {
      return;
    }
    setRecentMediaPaths((current) =>
      Array.from(new Set([...paths, ...current])).slice(0, recentPathsLimit),
    );
  }

  async function importMedia(pathsToImport?: string[], folderId: string | null = null) {
    if (isMediaBinReadOnly || isBusy) {
      return;
    }
    if (!isTauriRuntime()) {
      messagePublished("请在 Tauri 桌面窗口中导入本地媒体。");
      return;
    }
    const pickOutcome = pathsToImport
      ? null
      : await runOperation("media.import", () =>
          open({ multiple: true, title: "导入媒体", filters: mediaFilters }),
        );
    if (pickOutcome && pickOutcome.status !== "success") {
      return;
    }
    const picked = pathsToImport ?? (pickOutcome?.status === "success" ? pickOutcome.value : null);
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) {
      return;
    }

    const subtitlePaths = paths.filter((path) => subtitleExtensions.has(fileExtension(path)));
    const probePaths = paths.filter((path) => !subtitleExtensions.has(fileExtension(path)));
    exportResultChanged(null);
    if (subtitlePaths.length > 0) {
      const subtitleItems = subtitlePaths.map(standaloneSubtitleItem);
      mediaItemsAdded(subtitleItems);
      if (folderId) {
        mediaItemsMovedToFolder(
          subtitleItems.map((item) => item.id),
          folderId,
        );
      }
      rememberImportedMedia(subtitlePaths);
    }

    const outcomes = await Promise.all(
      probePaths.map((path) =>
        runMediaImportTask({
          path,
          operation: "media.import",
          taskIdPrefix: "media-import",
          onSuccess: (result) => {
            mediaProjectsAdded([result.project]);
            if (folderId) {
              mediaItemsMovedToFolder([result.project.asset.id], folderId);
            }
            warningsAppended(result.warnings);
            rememberImportedMedia([result.project.asset.path]);
          },
        }),
      ),
    );
    const loaded = outcomes.flatMap((outcome) =>
      outcome.status === "success" ? [outcome.result] : [],
    );
    const cancelledCount = outcomes.filter((outcome) => outcome.status === "cancelled").length;

    const importedCount = loaded.length + subtitlePaths.length;
    const resultParts = [
      importedCount > 0 ? `已导入 ${importedCount} 个媒体` : "未导入任何媒体",
      ...(cancelledCount > 0 ? [`${cancelledCount} 个已取消`] : []),
    ];
    messagePublished(resultParts.join("，"));
  }

  async function navigateProjectHistory(targetCursor: number): Promise<boolean> {
    if (isBusy) {
      return false;
    }
    const previousCursor = projectHistory.cursor;
    setHistoryNavigating(true);
    const changed = projectHistoryJumped(targetCursor);
    if (!changed) {
      setHistoryNavigating(false);
      return false;
    }

    const outcome = await runOperation("project.history", async () => {
      if (isTauriRuntime()) {
        await invokeCommand("sync_project_workspace", {
          workspace: getProjectWorkspaceSnapshot(),
        });
      }
    });
    if (outcome.status === "success") {
      const target = Math.max(0, Math.min(targetCursor, projectHistory.entries.length));
      if (Math.abs(target - previousCursor) > 1) {
        messagePublished("已跳转到所选历史记录");
      } else if (target < previousCursor) {
        messagePublished("已撤销上一步项目操作");
      } else {
        messagePublished("已重做下一步项目操作");
      }
      setHistoryNavigating(false);
      return true;
    } else {
      projectHistoryJumped(previousCursor);
      setHistoryNavigating(false);
      return false;
    }
  }

  async function undoProjectOperation() {
    await navigateProjectHistory(projectHistory.cursor - 1);
  }

  async function redoProjectOperation() {
    await navigateProjectHistory(projectHistory.cursor + 1);
  }

  async function deleteCurrentHistoryBranch(selectedCursor: number) {
    if (isBusy || selectedCursor <= 0 || selectedCursor > projectHistory.entries.length) {
      return;
    }
    const removedCount = projectHistory.entries.length - selectedCursor + 1;
    if (!(await navigateProjectHistory(selectedCursor - 1))) {
      return;
    }
    projectHistoryFutureDiscarded();
    messagePublished(`已删除当前事件及其后的 ${removedCount} 条历史记录`);
  }

  useAppEvent("media:import", ({ paths, folderId }) => importMedia(paths, folderId ?? null));

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }
      const primaryModifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (!primaryModifier) {
        if (
          !event.altKey &&
          !event.shiftKey &&
          !isEditableKeyboardTarget(event.target) &&
          (event.key === "Backspace" || event.key === "Delete")
        ) {
          if (activeWorkspace === "edit") {
            event.preventDefault();
          }
          if (!isBusy && canClear) {
            clearInEditScope();
          }
        }
        return;
      }

      if (key === "q" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        void exitApplication();
        return;
      }
      if (key === "z" && !event.altKey && !isEditableKeyboardTarget(event.target)) {
        if (isBusy) {
          return;
        }
        const action = event.shiftKey
          ? canRedo
            ? redoProjectOperation
            : undefined
          : canUndo
            ? undoProjectOperation
            : undefined;
        if (action) {
          event.preventDefault();
          void action();
        }
        return;
      }
      if (!event.altKey && !isEditableKeyboardTarget(event.target)) {
        if (key === "c" && !event.shiftKey) {
          event.preventDefault();
          if (!isBusy && canCopy) copyInEditScope();
          return;
        }
        if (key === "v" && !event.shiftKey) {
          event.preventDefault();
          if (!isBusy && canPaste) pasteInEditScope();
          return;
        }
        if (key === "a") {
          event.preventDefault();
          if (isBusy) {
            return;
          }
          if (event.shiftKey) {
            if (canClearSelection) clearSelectionInEditScope();
          } else if (canSelectAll) {
            selectAllInEditScope();
          }
          return;
        }
      }
      if (isBusy) {
        return;
      }
      let action: (() => void | Promise<void>) | undefined;
      if (key === "n" && !event.shiftKey && !event.altKey) action = newProject;
      if (key === "o" && !event.shiftKey && !event.altKey) action = openProject;
      if (key === "i" && !event.shiftKey && !event.altKey) {
        action = () => importMedia(undefined, focusedMediaFolderId);
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

  const workspaceContent: Record<AppWorkspace, ReactNode> = {
    import: <ImportWorkspace onImportCompleted={() => setActiveWorkspace("edit")} />,
    edit: <DockLayout />,
  };

  function showPanel<Params>(request: OpenPanelRequest<Params>) {
    setActiveWorkspace("edit");
    openPanel(request);
  }

  function showSingletonPanel<Params>(
    id: string,
    type: string,
    params: Params,
    areaId: DockAreaId,
  ) {
    showPanel({ id, type, params, placement: { areaId } });
  }

  const mediaPanelIdsByFolder = new Map<string | null, string[]>();
  for (const instance of Object.values(panelInstances)) {
    if (instance.type !== mediaBinPanelType) {
      continue;
    }
    const { rootFolderId } = instance.params as MediaBinPanelParams;
    const panelIds = mediaPanelIdsByFolder.get(rootFolderId) ?? [];
    panelIds.push(instance.id);
    mediaPanelIdsByFolder.set(rootFolderId, panelIds);
  }

  function showMediaPanel(rootFolderId: string | null) {
    const existingPanelId = mediaPanelIdsByFolder.get(rootFolderId)?.at(-1);
    showPanel({
      id: existingPanelId ?? (rootFolderId === null ? "media" : `window-media-bin:${rootFolderId}`),
      type: mediaBinPanelType,
      params: { rootFolderId },
      placement: { areaId: "leftBottom" },
    });
  }

  const projectPanelName = projectFilePath
    ? fileName(projectFilePath).replace(/\.lcp$/i, "")
    : "未命名项目";
  const projectWindowItems = [
    {
      id: "media",
      label: `项目：${projectPanelName}`,
      checked: (mediaPanelIdsByFolder.get(null)?.length ?? 0) > 0,
      enabled: true,
      execute: () => showMediaPanel(null),
    },
    ...orderedMediaFolders(mediaFolders).map(({ folder, depth }) => ({
      id: `media-folder:${folder.id}`,
      label: `${"　".repeat(depth)}媒体箱：${folder.name}`,
      checked: (mediaPanelIdsByFolder.get(folder.id)?.length ?? 0) > 0,
      enabled: true,
      execute: () => showMediaPanel(folder.id),
    })),
  ];

  const applicationMenuModel: ApplicationMenuModel = {
    file: {
      newProject: { enabled: !isBusy, execute: newProject },
      openProject: { enabled: !isBusy, execute: openProject },
      recentProjects: {
        enabled: recentProjectPaths.length > 0 && !isBusy,
        items: recentProjectPaths.map((path) => ({
          id: path,
          label: fileName(path),
          title: path,
          execute: () => openProject(path),
        })),
      },
      closeProject: { enabled: hasProject && !isBusy, execute: closeProject },
      saveProject: {
        enabled: hasProject && projectDirty && !isBusy,
        execute: saveProject,
      },
      saveProjectAs: {
        enabled: hasProject && !isBusy,
        execute: () => saveProjectAs(true),
      },
      saveProjectCopy: {
        enabled: hasProject && !isBusy,
        execute: () => saveProjectAs(false),
      },
      importMedia: {
        enabled: !isMediaBinReadOnly && !isBusy,
        execute: () => importMedia(undefined, focusedMediaFolderId),
      },
      recentMedia: {
        enabled: recentMediaPaths.length > 0 && !isMediaBinReadOnly && !isBusy,
        items: recentMediaPaths.map((path) => ({
          id: path,
          label: fileName(path),
          title: path,
          execute: () => importMedia([path], focusedMediaFolderId),
        })),
      },
      exit: { enabled: true, execute: exitApplication },
    },
    edit: {
      undo: { enabled: canUndo && !isBusy, execute: undoProjectOperation },
      redo: { enabled: canRedo && !isBusy, execute: redoProjectOperation },
      copy: { enabled: canCopy && !isBusy, execute: copyInEditScope },
      paste: { enabled: canPaste && !isBusy, execute: pasteInEditScope },
      clear: { enabled: canClear && !isBusy, execute: clearInEditScope },
      duplicate: { enabled: canDuplicate && !isBusy, execute: duplicateInEditScope },
      selectAll: { enabled: canSelectAll && !isBusy, execute: selectAllInEditScope },
      clearSelection: {
        enabled: canClearSelection && !isBusy,
        execute: clearSelectionInEditScope,
      },
      preferences: {
        enabled: !isBusy,
        execute: () => setPreferencesOpen(true),
      },
    },
    window: {
      source: {
        id: "source",
        label: "源播放器",
        checked: Boolean(panelInstances.source),
        enabled: true,
        execute: () => showSingletonPanel("source", sourcePanelType, {}, "leftTop"),
      },
      project: {
        enabled: projectWindowItems.length > 0,
        items: projectWindowItems,
      },
      export: {
        id: "export",
        label: "导出设置",
        checked: Boolean(panelInstances.export),
        enabled: true,
        execute: () => showSingletonPanel("export", exportPanelType, {}, "leftBottom"),
      },
      subtitles: {
        id: "subtitles",
        label: "字幕轨",
        checked: Boolean(panelInstances.subtitles),
        enabled: true,
        execute: () => showSingletonPanel("subtitles", subtitlePanelType, {}, "right"),
      },
      history: {
        id: "history",
        label: "历史记录",
        checked: Boolean(panelInstances.history),
        enabled: true,
        execute: () => showSingletonPanel("history", historyPanelType, {}, "right"),
      },
    },
  };

  return (
    <HistoryPanelServicesProvider
      services={{
        disabled: isBusy,
        navigate: navigateProjectHistory,
        deleteEntry: deleteCurrentHistoryBranch,
      }}
    >
      <div className="app-shell">
        <header className="application-menubar">
          <ApplicationMenu model={applicationMenuModel} />
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
          {exportResult && <span>导出结果已生成</span>}
        </footer>

        {(warnings.length > 0 || exportResult) && (
          <aside className="event-drawer">
            {warnings.map((warning) => (
              <div key={`${warning.code}:${warning.message}`} className="event warning">
                {warning.message}
              </div>
            ))}
            {exportResult?.log.map((item) => (
              <div key={`${item.code}:${item.message}`} className="event">
                {item.message}
              </div>
            ))}
          </aside>
        )}

        <ProxyCreationDialog />
        <PreferencesDialog open={preferencesOpen} onClose={() => setPreferencesOpen(false)} />
      </div>
    </HistoryPanelServicesProvider>
  );
}

export default function App() {
  return (
    <PanelRegistryProvider registry={appPanelRegistry}>
      <PanelManagerProvider initialState={initialAppPanelState}>
        <AppContent />
      </PanelManagerProvider>
    </PanelRegistryProvider>
  );
}
