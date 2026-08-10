import { FolderOpen, X } from "lucide-react";
import { captureOperationError } from "../../errors";
import { runExportTask, useExportWorkspaceState } from "../../systems/ExportSystem";
import { persistExportState, useProjectPort } from "../../systems/ProjectSystem";
import { useTaskProgressStatus } from "../../systems/TaskSystem";

export function ExportActionBar() {
  const source = useExportWorkspaceState((state) => state.source);
  const selectedClipIds = useExportWorkspaceState((state) => state.selectedClipIds);
  const settings = useExportWorkspaceState((state) => state.settings);
  const status = useExportWorkspaceState((state) => state.status);
  const isExporting = useExportWorkspaceState((state) => state.isExporting);
  const setStatus = useExportWorkspaceState((state) => state.setStatus);
  const setResults = useExportWorkspaceState((state) => state.setResults);
  const { projectId, exportSettingsRecorded, messagePublished } = useProjectPort(
    ["projectId"],
    ["exportSettingsRecorded", "messagePublished"],
  );

  const { tasks } = useTaskProgressStatus("export.run");
  const runningTask = tasks[0];

  const selectedClips = (source?.clips ?? []).filter((clip) => selectedClipIds.has(clip.id));
  const canExport =
    selectedClips.length > 0 &&
    settings.outputDir.trim() !== "" &&
    settings.outputStem.trim() !== "" &&
    status !== "running" &&
    !isExporting;

  async function handleExport() {
    if (!canExport) {
      return;
    }
    setStatus("running");
    setResults(null);
    const outcome = await runExportTask({ clips: selectedClips, settings });
    if (outcome.status === "success") {
      exportSettingsRecorded(settings);
      if (projectId) {
        // The export already succeeded; failing to persist the settings for the
        // next "使用上次设置导出" must not break the current flow.
        void persistExportState(projectId, settings).catch((error) =>
          captureOperationError("project.exportState.save", error),
        );
      }
      setResults(outcome.result);
      setStatus("done");
    } else if (outcome.status === "cancelled") {
      messagePublished("导出已取消");
      setStatus("idle");
    } else if (outcome.status === "busy") {
      messagePublished("已有导出正在进行");
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
