import { FolderOpen, X } from "lucide-react";
import { runMediaImportTask } from "../../mediaImportTask";
import {
  runExportTask,
  useExportWorkspaceState,
  type ExportOutput,
} from "../../systems/ExportSystem";
import { useProjectPort } from "../../systems/ProjectSystem";
import { useTaskProgressStatus } from "../../systems/TaskSystem";

export function ExportActionBar() {
  const source = useExportWorkspaceState((state) => state.source);
  const selectedClipIds = useExportWorkspaceState((state) => state.selectedClipIds);
  const settings = useExportWorkspaceState((state) => state.settings);
  const status = useExportWorkspaceState((state) => state.status);
  const setStatus = useExportWorkspaceState((state) => state.setStatus);
  const setResults = useExportWorkspaceState((state) => state.setResults);
  const { exportSettingsRecorded, mediaProjectsAdded, warningsAppended, messagePublished } =
    useProjectPort([], [
      "exportSettingsRecorded",
      "mediaProjectsAdded",
      "warningsAppended",
      "messagePublished",
    ]);

  const { tasks } = useTaskProgressStatus("export.run");
  const runningTask = tasks[0];

  const selectedClips = (source?.clips ?? []).filter((clip) => selectedClipIds.has(clip.id));
  const canExport =
    selectedClips.length > 0 &&
    settings.outputDir.trim() !== "" &&
    settings.outputStem.trim() !== "" &&
    status !== "running";

  /** 导入项目中开启时，把导出成功的产物逐个登记进媒体箱。 */
  async function importOutputsIntoProject(outputs: ExportOutput[]) {
    for (const output of outputs) {
      if (output.status !== "completed") {
        continue;
      }
      await runMediaImportTask({
        path: output.path,
        operation: "media.import",
        taskIdPrefix: "export-import",
        onSuccess: (result) => {
          mediaProjectsAdded([result.project]);
          if (result.warnings.length > 0) {
            warningsAppended(result.warnings);
          }
        },
      });
    }
  }

  async function handleExport() {
    if (!canExport) {
      return;
    }
    setStatus("running");
    setResults(null);
    const outcome = await runExportTask({ clips: selectedClips, settings });
    if (outcome.status === "success") {
      exportSettingsRecorded(settings);
      if (settings.importIntoProject) {
        await importOutputsIntoProject(outcome.result.outputs);
      }
      setResults(outcome.result);
      setStatus("done");
    } else if (outcome.status === "cancelled") {
      messagePublished("导出已取消");
      setStatus("idle");
    } else {
      setStatus("idle");
    }
  }

  return (
    <footer className="export-action-bar">
      <div className="export-action-row">
        {status === "running" ? (
          <button
            type="button"
            className="toolbar-button"
            onClick={() => void runningTask?.cancel()}
            disabled={!runningTask}
            title="取消导出"
          >
            <X size={14} />
            取消
          </button>
        ) : (
          <button
            type="button"
            className="accent-button"
            onClick={() => void handleExport()}
            disabled={!canExport}
            title={selectedClips.length === 0 ? "请先勾选要导出的片段" : "开始导出"}
          >
            <FolderOpen size={14} />
            导出
          </button>
        )}
      </div>
    </footer>
  );
}
