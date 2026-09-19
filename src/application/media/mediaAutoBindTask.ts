import { clientError, invokeCommand, runOperation } from "../../errors";
import { cancelFfmpegTask, createFfmpegTaskId } from "../../platform/tauri/ffmpegProgress";
import type {
  MediaAutoBindPreference,
  MediaAutoBindPreset,
  MediaAutoBindType,
} from "./mediaAutoBinding";
import { getProjectExportContext, getProjectWorkspaceSnapshot } from "../../systems/ProjectSystem";
import { createTaskProgress } from "../../systems/TaskSystem";
import type { AddExternalSubtitlesResult, MediaAutoBindingBatch, UserNotice } from "../../types";
import type {
  MediaAutoBindingWorkerRequest,
  MediaAutoBindingWorkerResponse,
} from "./mediaAutoBindingWorker";

const MATCHING_PROGRESS_END = 30;
const BINDING_PROGRESS_END = 95;
const SUBTITLE_BIND_CONCURRENCY = 2;

interface MediaAutoBindActions {
  mediaAutoBindingsApplied: (batch: MediaAutoBindingBatch) => void;
  warningsAppended: (warnings: UserNotice[]) => void;
  messagePublished: (message: string) => void;
}

interface ScheduleMediaAutoBindingOptions {
  importedItemIds: string[];
  type: MediaAutoBindType;
  preset: MediaAutoBindPreset;
  preference: MediaAutoBindPreference;
  actions: MediaAutoBindActions;
}

function currentImportedItems(itemIds: readonly string[]) {
  const requested = new Set(itemIds);
  return getProjectWorkspaceSnapshot().media_bin.items.filter((item) => requested.has(item.id));
}

function startMatchingWorker(
  request: MediaAutoBindingWorkerRequest,
  onProgress: (completed: number, total: number) => void,
) {
  const worker = new Worker(new URL("./mediaAutoBindingWorker.ts", import.meta.url), {
    type: "module",
  });
  let settled = false;
  let settle: (value: MediaAutoBindingWorkerResponse & { kind: "result" }) => void;
  let reject: (error: Error) => void;
  const promise = new Promise<MediaAutoBindingWorkerResponse & { kind: "result" }>(
    (resolve, rejectPromise) => {
      settle = resolve;
      reject = rejectPromise;
    },
  );
  const finish = () => {
    if (settled) return false;
    settled = true;
    worker.terminate();
    return true;
  };
  worker.onmessage = ({ data }: MessageEvent<MediaAutoBindingWorkerResponse>) => {
    if (data.kind === "progress") {
      onProgress(data.completed, data.total);
      return;
    }
    if (!finish()) return;
    if (data.kind === "result") settle(data);
    else reject(clientError("UNEXPECTED_ERROR", `Auto-binding worker failed: ${data.message}`));
  };
  worker.onerror = (event) => {
    if (finish()) {
      reject(
        clientError(
          "UNEXPECTED_ERROR",
          `Auto-binding worker crashed: ${event.message || "unknown worker error"}`,
        ),
      );
    }
  };
  worker.postMessage(request);
  return {
    promise,
    cancel() {
      if (finish()) reject(clientError("BROWSER_ABORTED", "Automatic media binding was cancelled"));
    },
  };
}

async function runMediaAutoBinding({
  importedItemIds,
  type,
  preset,
  preference,
  actions,
}: ScheduleMediaAutoBindingOptions) {
  const projectId = getProjectExportContext().projectId;
  let cancelled = false;
  let matching: ReturnType<typeof startMatchingWorker> | undefined;
  const running = new Set<string>();
  const task = await createTaskProgress({
    operation: "media.bindSubtitles",
    label: "绑定媒体",
    current: 0,
    total: 100,
    blocking: false,
    on_cancel: async () => {
      cancelled = true;
      matching?.cancel();
      await Promise.allSettled([...running].map(cancelFfmpegTask));
    },
  });

  try {
    const importedItems = currentImportedItems(importedItemIds);
    matching = startMatchingWorker(
      { items: importedItems, type, preset, preference },
      (completed, total) => {
        task.update({
          current: total > 0 ? (completed / total) * MATCHING_PROGRESS_END : MATCHING_PROGRESS_END,
        });
      },
    );
    const { result: prepared } = await matching.promise;
    matching = undefined;
    if (cancelled || getProjectExportContext().projectId !== projectId) {
      task.remove();
      return;
    }
    task.update({ current: MATCHING_PROGRESS_END });

    if (prepared.bindings.length === 0) {
      task.remove();
      actions.messagePublished("自动绑定未找到足够接近的媒体组合");
      return;
    }

    const itemById = new Map(
      [...importedItems, ...prepared.copies].map((item) => [item.id, item] as const),
    );
    const audioBindings = prepared.bindings
      .filter((binding) => itemById.get(binding.itemId)?.kind === "audio")
      .map(({ itemId, videoId }) => ({ itemId, videoId }));
    const historyGroupId = `media-auto-bind:${crypto.randomUUID()}`;
    let boundCount = audioBindings.length;
    const copyById = new Map(prepared.copies.map((item) => [item.id, item] as const));
    const audioCopies = audioBindings.flatMap((binding) => {
      const copy = copyById.get(binding.itemId);
      return copy ? [copy] : [];
    });
    if (audioBindings.length > 0) {
      actions.mediaAutoBindingsApplied({
        copies: audioCopies,
        audioBindings,
        subtitleBindings: [],
        historyGroupId,
        historyLabel: `自动绑定 ${boundCount} 个媒体`,
      });
    }
    const subtitleJobs = prepared.bindings.flatMap((binding) => {
      const item = itemById.get(binding.itemId);
      const video = itemById.get(binding.videoId);
      return item?.kind === "subtitle" && item.path && video?.kind === "video"
        ? [
            {
              item,
              videoId: video.id,
              assetId: video.source_video_id ?? video.id,
              taskId: createFfmpegTaskId("media-auto-bind"),
            },
          ]
        : [];
    });
    const warnings: UserNotice[] = [];
    let failure: unknown;
    let cursor = 0;
    let completed = 0;

    async function consumeSubtitleJobs() {
      while (!cancelled && cursor < subtitleJobs.length) {
        const job = subtitleJobs[cursor++];
        if (getProjectExportContext().projectId !== projectId) return;
        running.add(job.taskId);
        try {
          task.update({
            label: `绑定媒体 ${completed + 1}/${subtitleJobs.length}`,
          });
          const result = await invokeCommand<AddExternalSubtitlesResult>("add_external_subtitles", {
            assetId: job.assetId,
            paths: [job.item.path],
            taskId: job.taskId,
          });
          if (getProjectExportContext().projectId === projectId) {
            const binding: MediaAutoBindingBatch["subtitleBindings"][number] = {
              videoId: job.videoId,
              itemIds: [job.item.id],
              tracks: result.tracks,
              cues: result.cues,
            };
            const copy = copyById.get(job.item.id);
            boundCount += binding.itemIds.length;
            actions.mediaAutoBindingsApplied({
              copies: copy ? [copy] : [],
              audioBindings: [],
              subtitleBindings: [binding],
              historyGroupId,
              historyLabel: `自动绑定 ${boundCount} 个媒体`,
            });
            warnings.push(...result.warnings);
          }
        } catch (error) {
          if (!cancelled) failure ??= error;
        } finally {
          running.delete(job.taskId);
          completed += 1;
          task.update({
            current:
              MATCHING_PROGRESS_END +
              (completed / Math.max(1, subtitleJobs.length)) *
                (BINDING_PROGRESS_END - MATCHING_PROGRESS_END),
          });
        }
      }
    }

    if (subtitleJobs.length > 0) {
      await Promise.all(
        Array.from(
          { length: Math.min(SUBTITLE_BIND_CONCURRENCY, subtitleJobs.length) },
          consumeSubtitleJobs,
        ),
      );
    }

    if (getProjectExportContext().projectId !== projectId) {
      task.remove();
      return;
    }
    if (warnings.length > 0) actions.warningsAppended(warnings);

    if (failure) task.fail(failure, { resourceKind: "subtitle" });
    else task.remove();
    if (!cancelled) actions.messagePublished(`已自动绑定 ${boundCount} 个媒体`);
  } catch (error) {
    if (!cancelled) task.fail(error);
  }
}

/**
 * Runs automatic binding after the import workspace switches away. Matching is
 * isolated in a Worker. Each completed binding is published while the
 * cancellable background task is still running.
 */
export function scheduleMediaAutoBinding(options: ScheduleMediaAutoBindingOptions) {
  return new Promise<void>((resolve) => {
    window.setTimeout(() => {
      void runOperation("media.bindSubtitles", () => runMediaAutoBinding(options)).finally(resolve);
    }, 0);
  });
}
