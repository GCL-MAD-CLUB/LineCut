import { invokeCommand } from "../../errors";
import {
  cancelFfmpegTask,
  createFfmpegTaskId,
  listenToFfmpegTaskProgress,
} from "../../ffmpegProgress";
import { createTaskProgress } from "../TaskSystem";
import type { ExportClip, ExportResult, ExportSettings, ExportSource } from "./exportTypes";
import { exportWorkspaceStore } from "./exportWorkspaceState";

export type ExportTaskOutcome =
  { status: "success"; result: ExportResult } | { status: "cancelled" } | { status: "failed" };

function backendClip(clip: ExportClip, useProxy: boolean) {
  return {
    id: clip.id,
    sourcePath: useProxy && clip.proxyPath ? clip.proxyPath : clip.sourcePath,
    label: clip.label,
    startUs: clip.startUs,
    endUs: clip.endUs,
  };
}

export interface RunExportTaskOptions {
  clips: ExportClip[];
  settings: ExportSettings;
}

/** Runs an ffmpeg export with topbar progress and cancellation wired to the backend task. */
export async function runExportTask({
  clips,
  settings,
}: RunExportTaskOptions): Promise<ExportTaskOutcome> {
  const taskId = createFfmpegTaskId("export");
  let cancelled = false;
  const task = await createTaskProgress({
    operation: "export.run",
    label: `导出 ${clips.length} 个片段`,
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
      clips: clips.map((clip) => backendClip(clip, settings.useProxy)),
      options: settings,
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
