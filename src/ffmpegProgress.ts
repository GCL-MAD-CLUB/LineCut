import { listen } from "@tauri-apps/api/event";
import type { TaskProgressListener } from "./components/TaskProgress";
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
