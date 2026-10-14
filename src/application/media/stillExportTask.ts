import { invokeCommand } from "../../errors";
import { normalizeError } from "../../errors/runtime";
import {
  cancelFfmpegTask,
  createFfmpegTaskId,
  listenToFfmpegTaskProgress,
} from "../../platform/tauri/ffmpegProgress";
import {
  applyImportedMediaResult,
  getProjectExportContext,
  getProjectWorkspaceSnapshot,
} from "../../systems/ProjectSystem";
import { createTaskProgress } from "../../systems/TaskSystem";
import { runMediaImportTask } from "./mediaImportTask";

export const stillFormats = [
  ["bmp", "BMP"],
  ["dpx", "DPX"],
  ["gif", "GIF"],
  ["jpeg", "JPEG"],
  ["openexr", "OpenEXR"],
  ["png", "PNG"],
  ["targa", "Targa"],
  ["tiff", "TIFF"],
] as const;

export type StillFormat = (typeof stillFormats)[number][0];

export interface StillExportRequest {
  assetId: string;
  mediaName: string;
  frame: number;
  frameRate: number;
  timecode: string;
  projectId: string | null;
}

export interface StillExportSettings {
  name: string;
  automaticName: boolean;
  directory: string;
  format: StillFormat;
  importIntoProject: boolean;
}

function ownsImportDestination(request: StillExportRequest) {
  if (request.projectId !== null) {
    return getProjectExportContext().projectId === request.projectId;
  }
  // A session populated by importing media can lack a document id until its
  // first save. Its imported asset id remains unique across document switches.
  return getProjectWorkspaceSnapshot().projects.some(
    (project) => project.asset.id === request.assetId,
  );
}

export async function runStillExportTask(
  request: StillExportRequest,
  settings: StillExportSettings,
) {
  const taskId = createFfmpegTaskId("still-export");
  let cancelled = false;
  const task = await createTaskProgress({
    operation: "export.run",
    label: `导出帧 ${settings.name}`,
    current: 0,
    total: 1,
    blocking: false,
    listener: listenToFfmpegTaskProgress(taskId),
    on_cancel: async () => {
      cancelled = true;
      try {
        await cancelFfmpegTask(taskId);
      } catch (error) {
        if ((error as { code?: string }).code !== "TASK_NOT_RUNNING") {
          throw normalizeError(error);
        }
      }
    },
  });
  if (task.cancelled) {
    task.remove();
    return;
  }
  let path: string;
  try {
    path = await invokeCommand<string>("export_still_frame", {
      assetId: request.assetId,
      taskId,
      options: {
        mediaName: request.mediaName,
        timecode: request.timecode,
        frame: request.frame,
        frameRate: request.frameRate,
        name: settings.name,
        automaticName: settings.automaticName,
        directory: settings.directory,
        format: settings.format,
      },
    });
    task.update({ current: 1 });
    task.remove();
  } catch (error) {
    if (cancelled) task.remove();
    else task.fail(error, { displayName: request.mediaName, resourceKind: "media" });
    return;
  }
  if (!cancelled && settings.importIntoProject && ownsImportDestination(request)) {
    await runMediaImportTask({
      path,
      operation: "export.run",
      taskIdPrefix: "still-import",
      onSuccess: (result) => {
        if (ownsImportDestination(request)) {
          applyImportedMediaResult(result);
        }
      },
    });
  }
}
