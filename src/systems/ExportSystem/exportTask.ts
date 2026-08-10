import { invokeCommand } from "../../errors";
import { normalizeError } from "../../errors/runtime";
import {
  cancelFfmpegTask,
  createFfmpegTaskId,
  listenToFfmpegTaskProgress,
} from "../../ffmpegProgress";
import { createTaskProgress } from "../TaskSystem";
import { applyImportedMediaResults, getProjectWorkspaceSnapshot } from "../ProjectSystem";
import { runMediaImportBatchTask } from "../../mediaImportTask";
import type {
  ExportClip,
  ExportOutput,
  ExportResult,
  ExportSettings,
  ExportSource,
} from "./exportTypes";
import { isAudioOnlyContainer } from "./exportTypes";
import { refreshExportClipAudioBindings } from "./exportResolvers";
import { resolveExportDestinationDir } from "./exportDestination";
import { computeExportFileNames } from "./exportRename";
import { exportWorkspaceStore } from "./exportWorkspaceState";
import {
  buildExportTargets,
  filterConflictingClips,
  findExistingTargets,
  resolveUniqueFileName,
  type ExportConflictAction,
} from "./exportConflict";
import { requestExportConflictAction } from "./exportConflictDialogState";

export type ExportTaskOutcome =
  | { status: "success"; result: ExportResult }
  | { status: "cancelled" }
  | { status: "failed" }
  | { status: "busy" };

function backendClip(clip: ExportClip, useProxy: boolean, outputName: string) {
  // Proxy generation preserves only `0:a:0`. Do not mix a proxy video with a
  // selected non-primary original track: reject the proxy for this clip so its
  // video and audio retain the same original timeline.
  const proxyCanSupplySelectedAudio = !(clip.audioSources ?? []).some(
    (source) => source.primary && source.audioTrackIndex !== 0,
  );
  const proxyPath = useProxy && proxyCanSupplySelectedAudio ? clip.proxyPath : null;
  const proxySelected = Boolean(proxyPath);
  return {
    id: clip.id,
    sourcePath: proxyPath ?? clip.sourcePath,
    audioSources: (clip.audioSources ?? []).map((source) =>
      // Once a proxy has been selected, every primary audio source is known to
      // be the proxy's first and only preserved audio stream.
      proxySelected && source.primary && source.audioTrackIndex === 0
        ? { sourcePath: proxyPath!, audioTrackIndex: 0 }
        : { sourcePath: source.sourcePath, audioTrackIndex: source.audioTrackIndex },
    ),
    label: clip.label,
    startUs: clip.startUs,
    endUs: clip.endUs,
    outputName,
  };
}

export interface RunExportTaskOptions {
  clips: ExportClip[];
  settings: ExportSettings;
  audioBindingsAlreadyRefreshed?: boolean;
}

function refreshCurrentAudioBindings(clips: ExportClip[]) {
  const workspace = getProjectWorkspaceSnapshot();
  const projects = Object.fromEntries(
    workspace.projects.map((project) => [project.asset.id, project]),
  );
  return refreshExportClipAudioBindings(
    clips,
    workspace.media_bin.items,
    projects,
    new Set(workspace.editor.detached_video_ids),
  );
}

async function importCompletedExportOutputs(outputs: ExportOutput[]) {
  const paths = outputs
    .filter((output) => output.status === "completed")
    .map((output) => output.path);
  await runMediaImportBatchTask({
    paths,
    operation: "media.import",
    taskIdPrefix: "export-import",
    label: `导入 ${paths.length} 个导出媒体`,
    onSuccess: applyImportedMediaResults,
  });
}

/** Fills fields absent from older project files and repairs invalid track/container combinations. */
export function normalizeExportSettings(settings: ExportSettings): ExportSettings {
  const audioOnlyContainer = isAudioOnlyContainer(settings.container);
  let includeVideo = audioOnlyContainer ? false : (settings.includeVideo ?? true);
  let includeAudio = audioOnlyContainer ? true : (settings.includeAudio ?? true);
  if (!includeVideo && !includeAudio) {
    includeVideo = true;
  }
  const audioCodec =
    settings.container === "mp3_audio"
      ? "mp3"
      : settings.container === "aac_audio"
        ? "aac"
        : settings.audioCodec;
  return {
    ...settings,
    destination: settings.destination ?? "specified",
    useSubfolder: settings.useSubfolder ?? false,
    subfolderName: settings.subfolderName ?? "",
    renameRule: settings.renameRule ?? "filename",
    customName: settings.customName ?? "",
    startNumber: settings.startNumber ?? 1,
    extensionCase: settings.extensionCase ?? "lower",
    existingFileMode: settings.existingFileMode ?? "ask",
    hardwareAcceleration: settings.hardwareAcceleration ?? "auto",
    includeVideo,
    includeAudio,
    audioCodec,
  };
}

/** Appends the configured subfolder to the base output dir; the base stays untouched in the workspace so the 文件夹 row shows the user's choice. */
export function composeExportOutputDir(settings: ExportSettings): string {
  const base = settings.outputDir.trim();
  const sub = settings.subfolderName.trim();
  if (!settings.useSubfolder || !sub) {
    return base;
  }
  return base ? `${base.replace(/[\\/]+$/, "")}\\${sub}` : sub;
}

/** Rejects a second export while one is in flight. */
function beginExport() {
  if (exportWorkspaceStore.getState().isExporting) {
    return false;
  }
  exportWorkspaceStore.getState().setExporting(true);
  return true;
}

function endExport() {
  exportWorkspaceStore.getState().setExporting(false);
}

/** Runs an ffmpeg export with topbar progress and cancellation wired to the backend task. */
export async function runExportTask({
  clips,
  settings,
  audioBindingsAlreadyRefreshed = false,
}: RunExportTaskOptions): Promise<ExportTaskOutcome> {
  if (!beginExport()) {
    return { status: "busy" };
  }
  try {
    const currentClips = audioBindingsAlreadyRefreshed ? clips : refreshCurrentAudioBindings(clips);
    const normalized = normalizeExportSettings(settings);
    const outputDir = composeExportOutputDir(normalized);

    const names = new Map(
      computeExportFileNames(currentClips, normalized).map((entry) => [
        entry.clipId,
        entry.fileName,
      ]),
    );

    let exportClips = currentClips;
    let resolvedExistingFileMode = normalized.existingFileMode;
    const targets = buildExportTargets(currentClips, outputDir, names, normalized.mode);
    const conflicts = await findExistingTargets(targets);
    if (conflicts.length > 0) {
      let action: ExportConflictAction;
      if (normalized.existingFileMode === "ask") {
        action = await requestExportConflictAction(conflicts);
      } else {
        action = normalized.existingFileMode;
      }
      if (action === "cancel") {
        return { status: "cancelled" };
      }
      resolvedExistingFileMode = action;
      if (action === "uniqueName") {
        const reserved = new Set(names.values());
        for (const conflict of conflicts) {
          const resolved = await resolveUniqueFileName(
            outputDir,
            conflict.fileName,
            reserved,
            normalized.startNumber,
          );
          if (resolved === null) {
            // No free -N name found; abort rather than silently overwrite.
            return { status: "cancelled" };
          }
          reserved.add(resolved);
          // Merge 模式的合并文件以 clips[0] 命名，改名即改合并输出名。
          const targetId = conflict.clipId ?? currentClips[0]?.id ?? null;
          if (targetId) {
            names.set(targetId, resolved);
          }
        }
      } else if (action === "skip") {
        if (normalized.mode === "merge") {
          // 合并只产一个文件，跳过它等于不导出。
          return { status: "cancelled" };
        }
        exportClips = filterConflictingClips(currentClips, conflicts);
        if (exportClips.length === 0) {
          return { status: "cancelled" };
        }
      }
    }

    const taskId = createFfmpegTaskId("export");
    let cancelled = false;
    const task = await createTaskProgress({
      operation: "export.run",
      label: `导出 ${exportClips.length} 个片段`,
      current: 0,
      total: 1,
      listener: listenToFfmpegTaskProgress(taskId),
      on_cancel: async () => {
        cancelled = true;
        try {
          await cancelFfmpegTask(taskId);
        } catch (error) {
          // The export finished between the cancel click and the backend call;
          // treat this as a successful cancel rather than a spurious error.
          if (!((error as { code?: string }).code === "TASK_NOT_RUNNING")) {
            throw normalizeError(error);
          }
        }
      },
    });

    try {
      const result = await invokeCommand<ExportResult>("export_clips", {
        clips: exportClips.map((clip) =>
          backendClip(clip, normalized.useProxy, names.get(clip.id) ?? ""),
        ),
        options: {
          ...normalized,
          outputDir,
          existingFileMode: resolvedExistingFileMode,
          // Merge 模式显式下发合并输出名，使前端冲突检查与落盘文件名一致。
          outputName:
            normalized.mode === "merge" ? (names.get(currentClips[0]?.id ?? "") ?? "") : "",
        },
        taskId,
      });
      if (cancelled) {
        task.remove();
        return { status: "cancelled" };
      }
      task.remove();
      if (normalized.importIntoProject) {
        await importCompletedExportOutputs(result.outputs);
      }
      return { status: "success", result };
    } catch (error) {
      if (cancelled) {
        task.remove();
        return { status: "cancelled" };
      }
      task.fail(error, { displayName: settings.outputStem, resourceKind: "media" });
      return { status: "failed" };
    }
  } finally {
    endExport();
  }
}

/** Runs an export immediately with the given source and settings, skipping the export workspace; used by the panel's "使用上次设置导出" quick action. */
export async function runQuickExport(
  source: ExportSource,
  settings: ExportSettings,
): Promise<ExportTaskOutcome> {
  // Bail before touching the workspace store so a quick export cannot clobber a
  // running export's source/status (which would hide its cancel button).
  if (exportWorkspaceStore.getState().isExporting) {
    return { status: "busy" };
  }
  const currentClips = refreshCurrentAudioBindings(source.clips);
  const currentSource = { ...source, clips: currentClips };
  const outputDir =
    settings.destination === "specified"
      ? settings.outputDir
      : await resolveExportDestinationDir(settings.destination, currentSource);
  const effectiveSettings = { ...settings, outputDir };
  exportWorkspaceStore.getState().setSource(currentSource);
  const outcome = await runExportTask({
    clips: currentClips,
    settings: effectiveSettings,
    audioBindingsAlreadyRefreshed: true,
  });
  if (outcome.status === "success") {
    const store = exportWorkspaceStore.getState();
    store.setResults(outcome.result);
    store.setStatus("done");
  }
  return outcome;
}
