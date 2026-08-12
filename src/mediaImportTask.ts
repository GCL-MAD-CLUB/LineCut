import { createTaskProgress } from "./systems/TaskSystem";
import { invokeCommand } from "./errors";
import type { OperationKey } from "./errors";
import { cancelFfmpegTask, createFfmpegTaskId, listenToFfmpegTaskProgress } from "./ffmpegProgress";
import type { ImportResult } from "./types";

export type MediaImportTaskOutcome =
  | { status: "success"; path: string; result: ImportResult }
  | { status: "cancelled"; path: string }
  | { status: "failed"; path: string };

interface RunMediaImportTaskOptions {
  path: string;
  operation: OperationKey;
  taskIdPrefix: string;
  assetId?: string;
  label?: string;
  onSuccess?: (result: ImportResult) => void;
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

export async function runMediaImportTask({
  path,
  operation,
  taskIdPrefix,
  assetId,
  label,
  onSuccess,
}: RunMediaImportTaskOptions): Promise<MediaImportTaskOutcome> {
  const taskId = createFfmpegTaskId(taskIdPrefix);
  let cancelled = false;
  const task = await createTaskProgress({
    operation,
    label: label ?? `导入 ${fileName(path)}`,
    current: 0,
    total: 1,
    listener: listenToFfmpegTaskProgress(taskId),
    on_cancel: async () => {
      cancelled = true;
      await cancelFfmpegTask(taskId);
    },
  });

  try {
    const result = await invokeCommand<ImportResult>("import_media", {
      path,
      taskId,
      assetId: assetId ?? null,
    });
    if (cancelled) {
      task.remove();
      return { status: "cancelled", path };
    }
    onSuccess?.(result);
    task.remove();
    return { status: "success", path, result };
  } catch (error) {
    if (cancelled) {
      task.remove();
      return { status: "cancelled", path };
    }
    task.fail(error, { displayName: fileName(path), resourceKind: "media" });
    return { status: "failed", path };
  }
}
