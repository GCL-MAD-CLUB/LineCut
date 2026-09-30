import { useSyncExternalStore } from "react";
import { clientError, invokeCommand, runOperation } from "../../errors";
import {
  cancelFfmpegTask,
  createFfmpegTaskId,
  listenToFfmpegTasksProgress,
} from "../../platform/tauri/ffmpegProgress";
import {
  applyAnalyzedMediaResult,
  getProjectExportContext,
  getProjectWorkspaceSnapshot,
} from "../../systems/ProjectSystem";
import { createTaskProgress } from "../../systems/TaskSystem";
import type { ImportResult } from "../../types";

const pending = new Set<string>();
let analysisQueue = Promise.resolve();
const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useMediaCoverDeferred(assetId: string) {
  return useSyncExternalStore(subscribe, () => pending.has(assetId));
}

/** This queue lives outside the import workspace and survives its unmount. */
export function scheduleMediaAnalysis(results: ImportResult[], startAfter = Promise.resolve()) {
  const jobs = results.filter((result) => !pending.has(result.project.asset.id));
  if (!jobs.length) return;
  const projectId = getProjectExportContext().projectId;
  const previousBatch = analysisQueue;
  let finishBatch!: () => void;
  analysisQueue = new Promise<void>((resolve) => {
    finishBatch = resolve;
  });
  jobs.forEach((job) => {
    pending.add(job.project.asset.id);
  });
  notify();
  // Let the workspace switch paint, then wait for higher-priority automatic binding.
  window.setTimeout(() => {
    void runOperation("media.analyze", async () => {
      await previousBatch;
      await startAfter;
      if (getProjectExportContext().projectId !== projectId) return;
      const taskIds = jobs.map(() => createFfmpegTaskId("media-analysis"));
      const running = new Set<string>();
      let cancelled = false;
      const task = await createTaskProgress({
        operation: "media.analyze",
        label: `正在分析 ${jobs.length} 项媒体...`,
        current: 0,
        total: jobs.length,
        blocking: false,
        listener: listenToFfmpegTasksProgress(taskIds),
        on_cancel: async () => {
          cancelled = true;
          const outcomes = await Promise.allSettled([...running].map(cancelFfmpegTask));
          const failure = outcomes.find(
            (result) =>
              result.status === "rejected" &&
              (result.reason as { code?: string })?.code !== "TASK_NOT_RUNNING",
          );
          if (failure?.status === "rejected")
            throw clientError(
              "UNEXPECTED_ERROR",
              `Media analysis cancellation failed: ${String(failure.reason)}`,
            );
        },
      });
      cancelled ||= task.cancelled;
      let failure: unknown;
      try {
        // Limit heavy subtitle/cover work to one media at a time to keep editing responsive.
        for (let index = 0; index < jobs.length && !cancelled; index += 1) {
          const job = jobs[index];
          const id = job.project.asset.id;
          if (getProjectExportContext().projectId !== projectId) break;
          if (!getProjectWorkspaceSnapshot().media_bin.items.some((item) => item.id === id))
            continue;
          const taskId = taskIds[index];
          running.add(taskId);
          try {
            const result = await invokeCommand<ImportResult>("analyze_imported_media", {
              assetId: id,
              taskId,
            });
            if (!cancelled) {
              applyAnalyzedMediaResult(result, projectId);
            }
          } catch (error) {
            if (!cancelled) {
              failure ??= error;
              applyAnalyzedMediaResult(
                {
                  project: job.project,
                  warnings: [
                    {
                      code: "MEDIA_ANALYSIS_FAILED",
                      severity: "warning",
                      message: `媒体分析未完成：${job.project.asset.file_name}`,
                    },
                  ],
                },
                projectId,
              );
            }
          } finally {
            running.delete(taskId);
            pending.delete(id);
            notify();
          }
          task.update({ current: index + 1 });
        }
        if (failure) task.fail(failure);
        else task.remove();
      } finally {
        jobs.forEach((job) => pending.delete(job.project.asset.id));
        notify();
      }
    }).finally(() => {
      finishBatch();
      jobs.forEach((job) => pending.delete(job.project.asset.id));
      notify();
    });
  }, 0);
}
