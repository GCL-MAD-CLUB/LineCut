import { invokeCommand } from "../../errors";
import {
  cancelFfmpegTask,
  createFfmpegTaskId,
  listenToFfmpegTaskProgress,
} from "../../ffmpegProgress";
import { createTaskProgress } from "../TaskSystem";
import type { ExportClip, ExportResult, ExportSettings, ExportSource } from "./exportTypes";
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
  { status: "success"; result: ExportResult } | { status: "cancelled" } | { status: "failed" };

function backendClip(clip: ExportClip, useProxy: boolean, outputName: string) {
  return {
    id: clip.id,
    sourcePath: useProxy && clip.proxyPath ? clip.proxyPath : clip.sourcePath,
    label: clip.label,
    startUs: clip.startUs,
    endUs: clip.endUs,
    outputName,
  };
}

export interface RunExportTaskOptions {
  clips: ExportClip[];
  settings: ExportSettings;
}

/**
 * Old project files recorded `export_state` before the destination/subfolder
 * fields existed; filling them in here keeps quick-export and the workspace on
 * the same defaults without touching recorded history.
 */
export function normalizeExportSettings(settings: ExportSettings): ExportSettings {
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
  };
}

/**
 * Appends the configured subfolder to the base output directory. The base is
 * left untouched in the workspace so the 文件夹 row shows the user's choice;
 * the composed path is what the backend writes into.
 */
export function composeExportOutputDir(settings: ExportSettings): string {
  const base = settings.outputDir.trim();
  const sub = settings.subfolderName.trim();
  if (!settings.useSubfolder || !sub) {
    return base;
  }
  return base ? `${base.replace(/[\\/]+$/, "")}\\${sub}` : sub;
}

/** Runs an ffmpeg export with topbar progress and cancellation wired to the backend task. */
export async function runExportTask({
  clips,
  settings,
}: RunExportTaskOptions): Promise<ExportTaskOutcome> {
  const normalized = normalizeExportSettings(settings);
  const outputDir = composeExportOutputDir(normalized);

  const names = new Map(
    computeExportFileNames(clips, normalized).map((entry) => [entry.clipId, entry.fileName]),
  );

  // ---- 现有文件冲突处理（纯前端；后端 ffmpeg 始终带 -y）----
  let exportClips = clips;
  const targets = buildExportTargets(clips, outputDir, names, normalized.mode);
  const conflicts = await findExistingTargets(targets);
  if (conflicts.length > 0) {
    let action: ExportConflictAction;
    if (normalized.existingFileMode === "ask") {
      action = await requestExportConflictAction(conflicts);
    } else {
      // uniqueName / overwrite / skip are all valid conflict actions.
      action = normalized.existingFileMode;
    }
    if (action === "cancel") {
      return { status: "cancelled" };
    }
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
        // Merge：合并文件以 clips[0] 命名，改它的名字即改合并输出名
        //（后端 export.rs:729 优先取 options.output_name）。
        const targetId = conflict.clipId ?? clips[0]?.id ?? null;
        if (targetId) {
          names.set(targetId, resolved);
        }
      }
    } else if (action === "skip") {
      if (normalized.mode === "merge") {
        // 合并只产一个文件，跳过它等于不导出。
        return { status: "cancelled" };
      }
      exportClips = filterConflictingClips(clips, conflicts);
      if (exportClips.length === 0) {
        return { status: "cancelled" };
      }
    }
    // action === "overwrite"：无操作，ffmpeg -y 静默覆盖（现状）。
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
      await cancelFfmpegTask(taskId);
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
        // Merge 模式：显式下发合并输出名，后端据此命名（而非 probed[0]），
        // 让前端冲突检查与落盘文件名一致。
        outputName: normalized.mode === "merge" ? (names.get(clips[0]?.id ?? "") ?? "") : "",
      },
      taskId,
    });
    if (cancelled) {
      task.remove();
      return { status: "cancelled" };
    }
    task.remove();
    return { status: "success", result };
  } catch (error) {
    if (cancelled) {
      task.remove();
      return { status: "cancelled" };
    }
    task.fail(error, { displayName: settings.outputStem, resourceKind: "media" });
    return { status: "failed" };
  }
}

/**
 * Runs an export immediately with the given source and settings, skipping the
 * export workspace. Used by the panel's "使用上次设置导出" quick action. The
 * result is stored so the export workspace can show it if opened later.
 */
export async function runQuickExport(
  source: ExportSource,
  settings: ExportSettings,
): Promise<ExportTaskOutcome> {
  exportWorkspaceStore.getState().setSource(source);
  const outcome = await runExportTask({ clips: source.clips, settings });
  if (outcome.status === "success") {
    const store = exportWorkspaceStore.getState();
    store.setResults(outcome.result);
    store.setStatus("done");
  }
  return outcome;
}
