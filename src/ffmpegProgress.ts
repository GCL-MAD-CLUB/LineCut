import { listen } from "@tauri-apps/api/event";

interface FfmpegProgressPayload {
  task_id: string;
  progress: number;
}

interface ProgressTarget {
  update: (update: { current: number }) => void;
}

function clampProgress(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}

export async function listenToFfmpegTaskProgress(taskId: string, target: ProgressTarget) {
  try {
    return await listen<FfmpegProgressPayload>("ffmpeg-progress", ({ payload }) => {
      if (payload.task_id !== taskId) {
        return;
      }
      target.update({ current: clampProgress(payload.progress) });
    });
  } catch {
    return () => undefined;
  }
}
