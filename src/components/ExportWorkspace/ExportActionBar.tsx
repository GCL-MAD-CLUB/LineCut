import { FolderOpen } from "lucide-react";
import { captureOperationError } from "../../errors";
import {
  enqueueExportTask,
  exportWorkspaceStore,
  useExportWorkspaceState,
} from "../../systems/ExportSystem";
import {
  getProjectExportContext,
  persistExportState,
  useProjectPort,
} from "../../systems/ProjectSystem";

export function ExportActionBar() {
  const source = useExportWorkspaceState((state) => state.source);
  const selectedClipIds = useExportWorkspaceState((state) => state.selectedClipIds);
  const settings = useExportWorkspaceState((state) => state.settings);
  const setStatus = useExportWorkspaceState((state) => state.setStatus);
  const setResults = useExportWorkspaceState((state) => state.setResults);
  const { projectId, exportSettingsRecorded, messagePublished } = useProjectPort(
    ["projectId"],
    ["exportSettingsRecorded", "messagePublished"],
  );

  const selectedClips = (source?.clips ?? []).filter((clip) => selectedClipIds.has(clip.id));
  const canExport =
    selectedClips.length > 0 &&
    settings.outputDir.trim() !== "" &&
    settings.outputStem.trim() !== "";

  function handleExport() {
    if (!canExport || !source) {
      return;
    }
    setResults(null);
    setStatus("idle");
    const capturedSource = source;
    const capturedSettings = { ...settings };
    const submission = enqueueExportTask({
      clips: selectedClips,
      settings: capturedSettings,
      source: { ...source, clips: selectedClips },
      projectId,
    });
    messagePublished(
      submission.queuePosition === 1
        ? "已开始导出"
        : `已加入导出队列，前面有 ${submission.queuePosition - 1} 个任务`,
    );
    void submission.completion.then((outcome) => {
      const stillShowingSource = exportWorkspaceStore.getState().source === capturedSource;
      if (outcome.status === "success") {
        if (getProjectExportContext().projectId === projectId) {
          exportSettingsRecorded(capturedSettings);
        }
        if (projectId) {
          // The export already succeeded; failing to persist the settings for
          // the next quick export must not break the completed task.
          void persistExportState(projectId, capturedSettings).catch((error) =>
            captureOperationError("project.exportState.save", error),
          );
        }
        if (stillShowingSource) {
          setResults(outcome.result);
          setStatus("done");
        }
      } else if (stillShowingSource) {
        if (outcome.status === "cancelled") {
          messagePublished("导出已取消");
        }
        setStatus("idle");
      }
    });
  }

  return (
    <footer className="export-action-bar">
      <div className="export-action-row">
        <button
          type="button"
          className="accent-button"
          onClick={handleExport}
          disabled={!canExport}
          title={selectedClips.length === 0 ? "请先勾选要导出的片段" : "加入导出队列"}
        >
          <FolderOpen size={14} />
          导出
        </button>
      </div>
    </footer>
  );
}
