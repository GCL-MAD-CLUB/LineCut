import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TaskProgressListener } from "./components/TaskProgress";

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
  const cancelled = await invoke<boolean>("cancel_task", { taskId });
  if (!cancelled) {
    throw new Error("任务尚未启动或已经结束");
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
