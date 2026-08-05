import { FolderOpen, Loader2, X } from "lucide-react";
import { captureOperationError, invokeCommand } from "../../errors";
import {
  runExportTask,
  useExportWorkspaceState,
  type ExportResult,
} from "../../systems/ExportSystem";
import { useProjectPort } from "../../systems/ProjectSystem";
import { useTaskProgressStatus } from "../../systems/TaskSystem";

function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

async function revealInFileManager(path: string) {
  try {
    await invokeCommand("reveal_in_file_manager", { path });
  } catch (error) {
    captureOperationError("export.reveal", error);
  }
}

export function ExportActionBar() {
  const source = useExportWorkspaceState((state) => state.source);
  const selectedClipIds = useExportWorkspaceState((state) => state.selectedClipIds);
  const settings = useExportWorkspaceState((state) => state.settings);
  const results = useExportWorkspaceState((state) => state.results);
  const status = useExportWorkspaceState((state) => state.status);
  const setStatus = useExportWorkspaceState((state) => state.setStatus);
  const setResults = useExportWorkspaceState((state) => state.setResults);
  const exportSettingsRecorded = useProjectPort(
    [],
    ["exportSettingsRecorded"],
  ).exportSettingsRecorded;

  const { tasks } = useTaskProgressStatus("export.run");
  const runningTask = tasks[0];

  const selectedClips = (source?.clips ?? []).filter((clip) => selectedClipIds.has(clip.id));
  const canExport =
    selectedClips.length > 0 &&
    settings.outputDir.trim() !== "" &&
    settings.outputStem.trim() !== "" &&
    status !== "running";

  async function handleExport() {
    if (!canExport) {
      return;
    }
    setStatus("running");
    setResults(null);
    const outcome = await runExportTask({ clips: selectedClips, settings });
    if (outcome.status === "success") {
      exportSettingsRecorded(settings);
      setResults(outcome.result);
      setStatus("done");
    } else {
      setStatus("idle");
    }
  }

  return (
    <footer className="export-action-bar">
      {runningTask && (
        <div className="export-progress">
          <span className="export-progress-label">
            <Loader2 className="spin" size={14} />
            {runningTask.label} {Math.round(runningTask.percent)}%
          </span>
          <div className="export-progress-track">
            <div className="export-progress-fill" style={{ width: `${runningTask.percent}%` }} />
          </div>
        </div>
      )}

      <div className="export-action-row">
        <span className="export-action-summary">
          {status === "running" ? "正在导出…" : `将导出 ${selectedClips.length} 个片段`}
        </span>
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

      {results && <ExportResults results={results} />}
    </footer>
  );
}

function ExportResults({ results }: { results: ExportResult }) {
  const completed = results.outputs.filter((output) => output.status === "completed");
  const failed = results.outputs.filter((output) => output.status === "failed");

  return (
    <div className="export-results">
      <div className="export-results-summary">
        <span>
          完成：{completed.length} 个成功
          {failed.length > 0 && (
            <span className="export-results-failed">，{failed.length} 个失败</span>
          )}
        </span>
      </div>
      <ul className="export-results-list">
        {results.outputs.map((output, index) => (
          <li
            key={`${output.path}:${index}`}
            className={output.status === "failed" ? "is-failed" : ""}
          >
            <span className="export-result-path" title={output.path}>
              {basename(output.path)}
            </span>
            {output.error && <span className="export-result-error">{output.error}</span>}
            {output.status === "completed" && (
              <button
                type="button"
                className="tool-button"
                onClick={() => void revealInFileManager(output.path)}
                title="在资源管理器中显示"
                aria-label="在资源管理器中显示"
              >
                <FolderOpen size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {results.warnings.length > 0 && (
        <div className="export-results-warnings">
          {results.warnings.map((warning, index) => (
            <div key={`${warning.code}:${index}`}>{warning.message}</div>
          ))}
        </div>
      )}
    </div>
  );
}
