import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invokeCommand, runOperation } from "../../errors";
import {
  cancelFfmpegTask,
  createFfmpegTaskId,
  listenToFfmpegTaskProgress,
} from "../../platform/tauri/ffmpegProgress";
import { isTauriRuntime } from "../../platform/tauri/runtime";
import { eventSource } from "../../runtime/events/EventHub";
import { publishEvent } from "../../runtime/events/react";
import {
  getProjectExportContext,
  getProjectWorkspaceSnapshot,
  isMediaItemEnabled,
  isMediaItemOffline,
  mediaItemProject,
  useProjectPort,
} from "../../systems/ProjectSystem";
import { createTaskProgress, useTaskProgressStatus } from "../../systems/TaskSystem";
import {
  detectedStoryboard,
  hasStoryboardShots,
  storyboardVideoContext,
  storyboardDetectionEditSignature,
  type StoryboardDetectionMode,
} from "../../core/editor/storyboardDetection";
import type {
  MediaBinItem,
  Project,
  StoryboardDetectionResult,
  StoryboardState,
} from "../../types";
import { ModalDialog } from "../ModalDialog";

const pending = new Set<string>();
const detectionEventSource = eventSource("storyboard-detection");

/**
 * Whether an automated cut detection can run for this video.
 *
 * Deliberately stricter than the panel pickers: detection re-reads the original file through
 * ffmpeg, so a video that is offline stays undetectable even when a proxy makes it playable.
 * Pickers must apply this predicate to the videos they offer, or they will present entries that
 * cannot act.
 */
export function canDetectStoryboard(item: MediaBinItem, project: Project | undefined) {
  return (
    isTauriRuntime() &&
    item.kind === "video" &&
    isMediaItemEnabled(item) &&
    !isMediaItemOffline(item) &&
    Boolean(project && project.asset.video_stream_index != null)
  );
}

interface StoryboardDetectionOptions {
  item: MediaBinItem;
  project: Project;
  mode: StoryboardDetectionMode;
  updateStoryboard: (
    context: string,
    label: string,
    recipe: (current: StoryboardState) => StoryboardState,
  ) => void;
  onlyMissing?: boolean;
  confirmConflict?: (
    videoId: string,
    signal: AbortSignal,
  ) => Promise<StoryboardDetectionMode | null>;
}

/** Submit every entry point to the existing task queue, independently of panel lifetime. */
export async function detectStoryboardVideo({
  item,
  project,
  mode,
  updateStoryboard,
  onlyMissing = false,
  confirmConflict,
}: StoryboardDetectionOptions) {
  if (!canDetectStoryboard(item, project)) return;
  const projectId = getProjectExportContext().projectId;
  const context = storyboardVideoContext(item.id, project);
  const key = JSON.stringify([projectId, context]);
  if (pending.has(key)) return;
  pending.add(key);
  const taskId = createFfmpegTaskId("storyboard-detect");
  const controller = new AbortController();
  const storyboardAtStart = storyboardDetectionEditSignature(
    getProjectWorkspaceSnapshot().storyboards?.[context],
  );
  let cancelled = false;
  const currentTarget = () => {
    if (getProjectExportContext().projectId !== projectId) return false;
    const workspace = getProjectWorkspaceSnapshot();
    const currentItem = workspace.media_bin.items.find((candidate) => candidate.id === item.id);
    const projects = Object.fromEntries(
      workspace.projects.map((candidate) => [candidate.asset.id, candidate]),
    );
    const currentProject =
      currentItem && mediaItemProject(currentItem, projects, workspace.media_bin.items);
    return Boolean(
      currentItem &&
      canDetectStoryboard(currentItem, currentProject) &&
      currentProject &&
      storyboardVideoContext(item.id, currentProject) === context,
    );
  };
  try {
    const task = await createTaskProgress({
      operation: "storyboard.detect",
      resourceKey: context,
      label: `分镜识别 ${item.file_name}`,
      current: 0,
      total: 1,
      listener: listenToFfmpegTaskProgress(taskId),
      on_cancel: async () => {
        cancelled = true;
        controller.abort();
        await cancelFfmpegTask(taskId);
      },
    });
    try {
      if (
        task.cancelled ||
        cancelled ||
        !currentTarget() ||
        (onlyMissing && hasStoryboardShots(getProjectWorkspaceSnapshot().storyboards?.[context]))
      ) {
        task.remove();
        return;
      }
      const result = await invokeCommand<StoryboardDetectionResult>("detect_storyboard_shots", {
        assetId: project.asset.id,
        taskId,
      });
      if (!cancelled && !task.cancelled && currentTarget()) {
        if (
          storyboardDetectionEditSignature(getProjectWorkspaceSnapshot().storyboards?.[context]) !==
          storyboardAtStart
        ) {
          // Native work has finished. A confirmation must not hold up the global task queue.
          task.remove();
          const confirmedMode = await confirmConflict?.(item.id, controller.signal);
          if (!confirmedMode || cancelled || task.cancelled || !currentTarget()) {
            task.remove();
            return;
          }
          mode = confirmedMode;
        }
        let firstShotId: string | undefined;
        updateStoryboard(context, mode === "merge" ? "合并分镜切点" : "生成分镜", (current) => {
          const next = detectedStoryboard(current, result, mode);
          firstShotId = next.shots[0]?.id;
          return next;
        });
        await publishEvent(
          "storyboard.detection.completed",
          { videoContext: context, firstShotId },
          detectionEventSource,
        );
      }
      task.remove();
    } catch (error) {
      if (cancelled || task.cancelled) task.remove();
      else task.fail(error, { displayName: item.file_name, resourceKind: "media" });
    }
  } finally {
    pending.delete(key);
  }
}

export function useStoryboardDetection() {
  const { projects, mediaItems, storyboards, projectId, storyboardUpdated } = useProjectPort(
    ["projects", "mediaItems", "storyboards", "projectId"],
    ["storyboardUpdated"],
  );
  const { tasks } = useTaskProgressStatus("storyboard.detect");
  const [conflicts, setConflicts] = useState<
    {
      videoIds: string[];
      confirm: (mode: StoryboardDetectionMode | null) => void;
    }[]
  >([]);
  const conflictResolversRef = useRef(new Set<(mode: StoryboardDetectionMode | null) => void>());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    setConflicts([]);
    return () => {
      mountedRef.current = false;
      for (const resolve of conflictResolversRef.current) resolve(null);
      conflictResolversRef.current.clear();
    };
  }, [projectId]);
  const confirmConflict = useCallback((videoId: string, signal: AbortSignal) => {
    if (!mountedRef.current || signal.aborted) return Promise.resolve(null);
    return new Promise<StoryboardDetectionMode | null>((resolve) => {
      const confirm = (mode: StoryboardDetectionMode | null) => {
        conflictResolversRef.current.delete(confirm);
        signal.removeEventListener("abort", cancel);
        resolve(mode);
      };
      const cancel = () => {
        confirm(null);
        setConflicts((current) => current.filter((conflict) => conflict.confirm !== confirm));
      };
      signal.addEventListener("abort", cancel, { once: true });
      conflictResolversRef.current.add(confirm);
      setConflicts((current) => [...current, { videoIds: [videoId], confirm }]);
    });
  }, []);
  useEffect(() => {
    const expired = new Set(
      conflicts.filter(
        (conflict) =>
          !conflict.videoIds.some((videoId) => {
            const item = mediaItems.find((candidate) => candidate.id === videoId);
            const project = item && mediaItemProject(item, projects, mediaItems);
            return item && canDetectStoryboard(item, project);
          }),
      ),
    );
    if (!expired.size) return;
    for (const conflict of expired) conflict.confirm(null);
    setConflicts((current) => current.filter((conflict) => !expired.has(conflict)));
  }, [conflicts, mediaItems, projects]);
  const eligibleVideos = useCallback(
    (videoIds: string[]) =>
      videoIds.flatMap((videoId) => {
        const item = mediaItems.find((candidate) => candidate.id === videoId);
        if (!item) return [];
        const project = mediaItemProject(item, projects, mediaItems);
        if (!project || !canDetectStoryboard(item, project)) return [];
        const context = storyboardVideoContext(item.id, project);
        return pending.has(JSON.stringify([projectId, context])) ||
          tasks.some((task) => task.resourceKey === context)
          ? []
          : [{ item, project, context }];
      }),
    [mediaItems, projects, projectId, tasks],
  );
  const start = useCallback(
    (videoIds: string[], mode: StoryboardDetectionMode, onlyMissing = false) => {
      for (const video of eligibleVideos(videoIds)) {
        void runOperation(
          "storyboard.detect",
          () =>
            detectStoryboardVideo({
              ...video,
              mode,
              onlyMissing,
              confirmConflict,
              updateStoryboard: storyboardUpdated,
            }),
          { displayName: video.item.file_name, resourceKind: "media" },
        );
      }
    },
    [eligibleVideos, storyboardUpdated, confirmConflict],
  );
  const requestDetection = useCallback(
    (videoIds: string[], onlyMissing = false) => {
      const videos = eligibleVideos(videoIds).filter(
        (video) => !onlyMissing || !hasStoryboardShots(storyboards[video.context]),
      );
      if (!videos.length) return;
      const ids = videos.map((video) => video.item.id);
      // Any existing shot is at risk: overwriting resets annotations and drops deleted shots.
      if (!onlyMissing && videos.some((video) => hasStoryboardShots(storyboards[video.context]))) {
        setConflicts((current) => [
          ...current,
          {
            videoIds: ids,
            confirm: (mode) => {
              if (mode) start(ids, mode);
            },
          },
        ]);
        return;
      }
      start(ids, "overwrite", onlyMissing);
    },
    [eligibleVideos, start, storyboards],
  );
  const canRequestDetection = useCallback(
    (videoIds: string[]) => eligibleVideos(videoIds).length > 0,
    [eligibleVideos],
  );
  const conflictVideoIds = conflicts[0]?.videoIds ?? [];
  function confirm(mode: StoryboardDetectionMode | null) {
    const conflict = conflicts[0];
    setConflicts((current) => current.slice(1));
    conflict?.confirm(mode);
  }
  const detectionDialog =
    conflictVideoIds.length > 0 &&
    createPortal(
      <ModalDialog
        title=""
        className="storyboard-detection-conflict-dialog"
        onCancel={() => confirm(null)}
        onConfirm={() => confirm("merge")}
        actions={
          <>
            <button
              type="button"
              className="modal-dialog-confirm"
              autoFocus
              onClick={() => confirm("merge")}
            >
              合并
            </button>
            <button
              type="button"
              className="modal-dialog-cancel"
              onClick={() => confirm("overwrite")}
            >
              覆盖
            </button>
            <button type="button" className="modal-dialog-cancel" onClick={() => confirm(null)}>
              取消
            </button>
          </>
        }
      >
        <h3 className="storyboard-detection-conflict-title">
          {conflictVideoIds.length > 1 ? "所选视频已有分镜切分" : "当前视频已有分镜切分"}
        </h3>
        <div className="storyboard-detection-conflict-divider" />
        <p className="storyboard-detection-conflict-message">
          请选择合并自动识别到的切点，或覆盖当前切分。
        </p>
      </ModalDialog>,
      document.body,
    );
  return { requestDetection, canRequestDetection, detectionDialog, detectionTasks: tasks };
}
