import { createTaskProgress } from "./systems/TaskSystem";
import { clientError, invokeCommand } from "./errors";
import type { OperationKey } from "./errors";
import {
  cancelFfmpegTask,
  createFfmpegTaskId,
  listenToFfmpegTaskProgress,
  listenToFfmpegTasksProgress,
} from "./ffmpegProgress";
import type { ImportResult } from "./types";

export type MediaImportTaskOutcome =
  | { status: "success"; path: string; result: ImportResult }
  | { status: "cancelled"; path: string }
  | { status: "failed"; path: string };

export type MediaImportBatchTaskOutcome =
  | { status: "success"; results: ImportResult[] }
  | { status: "partial"; results: ImportResult[]; failedPaths: string[] }
  | { status: "cancelled"; results: ImportResult[] };

const MEDIA_IMPORT_BATCH_WORKER_COUNT = 3;

interface RunMediaImportTaskOptions {
  path: string;
  operation: OperationKey;
  taskIdPrefix: string;
  assetId?: string;
  label?: string;
  onSuccess?: (result: ImportResult) => void;
}

interface RunMediaImportBatchTaskOptions {
  paths: string[];
  operation: OperationKey;
  taskIdPrefix: string;
  label?: string;
  onSuccess?: (results: ImportResult[]) => void;
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function uniquePaths(paths: string[]) {
  const pathsByKey = new Map<string, string>();
  for (const rawPath of paths) {
    const path = rawPath.trim();
    const key = path.toLowerCase();
    if (path && !pathsByKey.has(key)) {
      pathsByKey.set(key, path);
    }
  }
  return Array.from(pathsByKey.values());
}

function isTaskNotRunning(error: unknown) {
  return (error as { code?: string } | null)?.code === "TASK_NOT_RUNNING";
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

/**
 * Imports media through a bounded, competing-consumer queue while exposing one
 * aggregate, cancellable progress task. Successful results are supplied
 * together so the caller can commit them as one project-history operation.
 */
export async function runMediaImportBatchTask({
  paths,
  operation,
  taskIdPrefix,
  label,
  onSuccess,
}: RunMediaImportBatchTaskOptions): Promise<MediaImportBatchTaskOutcome> {
  const batchPaths = uniquePaths(paths);
  if (batchPaths.length === 0) {
    return { status: "success", results: [] };
  }

  const taskIds = batchPaths.map(() => createFfmpegTaskId(taskIdPrefix));
  let cancelled = false;
  const task = await createTaskProgress({
    operation,
    label: label ?? `导入 ${batchPaths.length} 个媒体`,
    current: 0,
    total: batchPaths.length,
    listener: listenToFfmpegTasksProgress(taskIds),
    on_cancel: async () => {
      cancelled = true;
      const cancellations = await Promise.allSettled(
        taskIds.map((taskId) => cancelFfmpegTask(taskId)),
      );
      const unexpectedFailure = cancellations.find(
        (result) => result.status === "rejected" && !isTaskNotRunning(result.reason),
      );
      if (unexpectedFailure?.status === "rejected") {
        throw clientError(
          "UNEXPECTED_ERROR",
          `Failed to cancel a media import in the batch: ${String(unexpectedFailure.reason)}`,
        );
      }
    },
  });

  const settled: Array<PromiseSettledResult<ImportResult> | undefined> = Array(batchPaths.length);
  let nextJobIndex = 0;
  const consumeImportQueue = async () => {
    while (!cancelled) {
      const index = nextJobIndex;
      nextJobIndex += 1;
      if (index >= batchPaths.length) {
        return;
      }

      try {
        const result = await invokeCommand<ImportResult>("import_media", {
          path: batchPaths[index],
          taskId: taskIds[index],
          assetId: null,
        });
        settled[index] = { status: "fulfilled", value: result };
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MEDIA_IMPORT_BATCH_WORKER_COUNT, batchPaths.length) }, () =>
      consumeImportQueue(),
    ),
  );
  const results = settled.flatMap((result) => {
    if (result?.status !== "fulfilled") {
      return [];
    }
    return [result.value];
  });
  const failedPaths = settled.flatMap((result, index) => {
    if (result?.status !== "rejected") {
      return [];
    }
    return [batchPaths[index]];
  });

  if (cancelled) {
    task.remove();
    return { status: "cancelled", results };
  }

  onSuccess?.(results);
  if (failedPaths.length === 0) {
    task.update({ current: batchPaths.length });
    task.remove();
    return { status: "success", results };
  }

  const firstFailure = settled.find(
    (result): result is PromiseRejectedResult => result?.status === "rejected",
  );
  task.fail(
    firstFailure?.reason ?? clientError("UNEXPECTED_ERROR", "One or more media imports failed"),
    {
      displayName: `${failedPaths.length} 个媒体`,
      count: failedPaths.length,
      resourceKind: "media",
    },
  );
  return { status: "partial", results, failedPaths };
}
