import { createPortal } from "react-dom";
import { resolveExportConflict, useExportConflictDialog } from "../../systems/ExportSystem";
import { ModalDialog } from "../ModalDialog";
import "./ExportConflictDialog.css";

/**
 * Confirms how to handle output files that already exist before an export runs.
 * Driven by the dialog store (`requestExportConflictAction`); every button
 * resolves the single pending action, which applies to all conflicting files.
 */
export function ExportConflictDialog() {
  const pending = useExportConflictDialog((state) => state.pending);
  if (!pending) {
    return null;
  }
  return createPortal(
    <ModalDialog
      title="导出文件已存在"
      className="export-conflict-dialog"
      bodyClassName="export-conflict-dialog-body"
      onCancel={() => resolveExportConflict("cancel")}
      onConfirm={() => resolveExportConflict("overwrite")}
      actions={
        <>
          <button
            type="button"
            className="modal-dialog-cancel"
            onClick={() => resolveExportConflict("cancel")}
          >
            取消
          </button>
          <button
            type="button"
            className="modal-dialog-cancel"
            onClick={() => resolveExportConflict("skip")}
          >
            跳过
          </button>
          <button
            type="button"
            className="modal-dialog-cancel"
            onClick={() => resolveExportConflict("uniqueName")}
          >
            使用唯一名称
          </button>
          <button
            type="button"
            className="modal-dialog-confirm"
            onClick={() => resolveExportConflict("overwrite")}
          >
            覆盖
          </button>
        </>
      }
    >
      <p className="export-conflict-dialog-intro">
        以下目标文件已存在，请选择要执行的操作（将应用到所有冲突文件）：
      </p>
      <div className="export-conflict-dialog-list-frame">
        <div className="export-conflict-dialog-list-scroll">
          <div className="export-conflict-dialog-list">
            {pending.conflicts.map((conflict, index) => (
              <div
                className="export-conflict-dialog-row"
                key={conflict.clipId ?? `merge-${index}`}
              >
                <span className="export-conflict-dialog-name" title={conflict.path}>
                  {conflict.fileName}
                </span>
                <span className="export-conflict-dialog-path" title={conflict.path}>
                  {conflict.path}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </ModalDialog>,
    document.querySelector(".app-shell") ?? document.body,
  );
}
