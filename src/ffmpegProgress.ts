import { listen } from "@tauri-apps/api/event";
import type { TaskProgressListener } from "./systems/TaskSystem";
import { clientError, invokeCommand } from "./errors";

interface FfmpegProgressPayload {
  task_id: string;
  progress: number;
}

function clampProgress(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}

export function createFfmpegTaskId(operation: string) {
  return `${operation}:${crypto.randomUUID()}`;
}

export async function cancelFfmpegTask(taskId: string) {
  const cancelled = await invokeCommand<boolean>("cancel_task", { taskId });
  if (!cancelled) {
    throw clientError("TASK_NOT_RUNNING", `Task is not running or has already finished: ${taskId}`);
  }
}

export function listenToFfmpegTaskProgress(taskId: string): TaskProgressListener {
  return async (publishUpdate) =>
    listen<FfmpegProgressPayload>("ffmpeg-progress", ({ payload }) => {
      if (payload.task_id === taskId) {
        publishUpdate({ current: clampProgress(payload.progress) });
      }
    });
}

/**
 * Aggregates several backend task streams into one task whose total is the
 * number of child tasks. Each child keeps its most recent progress so delayed
 * events cannot make the visible batch progress move backwards.
 */
export function listenToFfmpegTasksProgress(taskIds: readonly string[]): TaskProgressListener {
  const progressByTaskId = new Map(taskIds.map((taskId) => [taskId, 0]));
  return async (publishUpdate) =>
    listen<FfmpegProgressPayload>("ffmpeg-progress", ({ payload }) => {
      const previous = progressByTaskId.get(payload.task_id);
      if (previous === undefined) {
        return;
      }
      progressByTaskId.set(payload.task_id, Math.max(previous, clampProgress(payload.progress)));
      publishUpdate({
        current: Array.from(progressByTaskId.values()).reduce(
          (total, progress) => total + progress,
          0,
        ),
      });
    });
}
