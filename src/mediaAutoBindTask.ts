import { invokeCommand, runOperation } from "./errors";
import {
  cancelFfmpegTask,
  createFfmpegTaskId,
  listenToFfmpegTasksProgress,
} from "./ffmpegProgress";
import {
  prepareMediaAutoBindings,
  type MediaAutoBindPreference,
  type MediaAutoBindPreset,
  type MediaAutoBindType,
} from "./mediaAutoBinding";
import { getProjectExportContext, getProjectWorkspaceSnapshot } from "./systems/ProjectSystem";
import { createTaskProgress } from "./systems/TaskSystem";
import type {
  AddExternalSubtitlesResult,
  MediaBinItem,
  SubtitleCue,
  SubtitleTrack,
  UserNotice,
} from "./types";

interface MediaAutoBindActions {
  mediaItemsAdded: (items: MediaBinItem[], historyLabel?: string) => void;
  mediaItemsBound: (itemIds: string[], videoId: string) => void;
  subtitleTracksAddedToVideo: (
    videoId: string,
    tracks: SubtitleTrack[],
    cues: Record<string, SubtitleCue[]>,
    itemIds: string[],
  ) => void;
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

function groupBindingsByVideo(bindings: Array<{ itemId: string; videoId: string }>) {
  const grouped = new Map<string, string[]>();
  for (const binding of bindings) {
    const itemIds = grouped.get(binding.videoId) ?? [];
    itemIds.push(binding.itemId);
    grouped.set(binding.videoId, itemIds);
  }
  return grouped;
}

/**
 * Schedules automatic binding after the import workspace has switched away.
 * Fast audio bindings are applied immediately; external subtitle parsing stays
 * visible and cancellable without blocking editing.
 */
export function scheduleMediaAutoBinding({
  importedItemIds,
  type,
  preset,
  preference,
  actions,
}: ScheduleMediaAutoBindingOptions) {
  const projectId = getProjectExportContext().projectId;
  window.setTimeout(() => {
    if (getProjectExportContext().projectId !== projectId) return;
    const importedItems = currentImportedItems(importedItemIds);
    const prepared = prepareMediaAutoBindings(importedItems, type, preset, preference);
    if (prepared.bindings.length === 0) {
      actions.messagePublished("自动绑定未找到足够接近的媒体组合");
      return;
    }

    if (prepared.copies.length > 0) {
      actions.mediaItemsAdded(
        prepared.copies,
        `为自动绑定虚拟复制 ${prepared.copies.length} 个媒体`,
      );
    }

    const currentItems = getProjectWorkspaceSnapshot().media_bin.items;
    const currentById = new Map(currentItems.map((item) => [item.id, item]));
    const audioBindings = prepared.bindings.filter(
      (binding) => currentById.get(binding.itemId)?.kind === "audio",
    );
    for (const [videoId, itemIds] of groupBindingsByVideo(audioBindings)) {
      actions.mediaItemsBound(itemIds, videoId);
    }

    const subtitleBindings = prepared.bindings.filter(
      (binding) => currentById.get(binding.itemId)?.kind === "subtitle",
    );
    const subtitleGroups = [...groupBindingsByVideo(subtitleBindings)];
    if (subtitleGroups.length === 0) {
      actions.messagePublished(`已自动绑定 ${audioBindings.length} 个媒体`);
      return;
    }

    void runOperation("media.bindSubtitles", async () => {
      const taskIds = subtitleGroups.map(() => createFfmpegTaskId("media-auto-bind"));
      const running = new Set<string>();
      let cancelled = false;
      const task = await createTaskProgress({
        operation: "media.bindSubtitles",
        label: `自动绑定媒体 · ${prepared.bindings.length} 项`,
        current: 0,
        total: subtitleGroups.length,
        blocking: false,
        listener: listenToFfmpegTasksProgress(taskIds),
        on_cancel: async () => {
          cancelled = true;
          await Promise.allSettled([...running].map(cancelFfmpegTask));
        },
      });
      let failure: unknown;
      let boundSubtitleCount = 0;
      for (let index = 0; index < subtitleGroups.length && !cancelled; index += 1) {
        const [videoId, requestedItemIds] = subtitleGroups[index];
        if (getProjectExportContext().projectId !== projectId) break;
        const workspace = getProjectWorkspaceSnapshot();
        const video = workspace.media_bin.items.find(
          (item) => item.id === videoId && item.kind === "video",
        );
        const subtitles = requestedItemIds.flatMap((itemId) => {
          const item = workspace.media_bin.items.find(
            (candidate) => candidate.id === itemId && candidate.kind === "subtitle",
          );
          return item?.path ? [item] : [];
        });
        if (!video || subtitles.length === 0) continue;
        const taskId = taskIds[index];
        running.add(taskId);
        try {
          task.update({
            label: `自动绑定媒体 · ${index + 1}/${subtitleGroups.length} · ${video.file_name}`,
          });
          const result = await invokeCommand<AddExternalSubtitlesResult>("add_external_subtitles", {
            assetId: video.source_video_id ?? video.id,
            paths: subtitles.map((item) => item.path),
            taskId,
          });
          if (!cancelled && getProjectExportContext().projectId === projectId) {
            actions.subtitleTracksAddedToVideo(
              videoId,
              result.tracks,
              result.cues,
              subtitles.map((item) => item.id),
            );
            actions.warningsAppended(result.warnings);
            boundSubtitleCount += subtitles.length;
          }
        } catch (error) {
          if (!cancelled) failure ??= error;
        } finally {
          running.delete(taskId);
        }
        task.update({ current: index + 1 });
      }
      if (failure) task.fail(failure, { resourceKind: "subtitle" });
      else task.remove();
      if (!cancelled && getProjectExportContext().projectId === projectId) {
        actions.messagePublished(`已自动绑定 ${audioBindings.length + boundSubtitleCount} 个媒体`);
      }
    });
  }, 0);
}
