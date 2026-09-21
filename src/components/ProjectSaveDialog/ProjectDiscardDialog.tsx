import { useEffect } from "react";
import { ModalDialog } from "../ModalDialog";
import "./ProjectSaveDialog.css";

interface ProjectDiscardDialogProps {
  message: string;
  saving: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

export function ProjectDiscardDialog({
  message,
  saving,
  onCancel,
  onDiscard,
  onSave,
}: ProjectDiscardDialogProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        saving ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      const key = event.key.toLocaleLowerCase();
      if (key !== "s" && key !== "d") return;
      event.preventDefault();
      event.stopPropagation();
      if (key === "s") onSave();
      else onDiscard();
    }
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onDiscard, onSave, saving]);

  return (
    <ModalDialog
      title=""
      className="project-save-dialog"
      bodyClassName="project-save-dialog-body"
      onCancel={saving ? () => undefined : onCancel}
      onConfirm={onSave}
      actions={
        <>
          <button
            type="button"
            className="modal-dialog-confirm"
            autoFocus
            disabled={saving}
            onClick={onSave}
          >
            {saving ? "正在存储..." : "存储(S)"}
          </button>
          <button
            type="button"
            className="modal-dialog-cancel"
            disabled={saving}
            onClick={onDiscard}
          >
            不保存(D)
          </button>
          <button
            type="button"
            className="modal-dialog-cancel"
            disabled={saving}
            onClick={onCancel}
          >
            取消
          </button>
        </>
      }
    >
      <h3 className="project-save-dialog-title">尚未保存的更改</h3>
      <div className="project-save-dialog-divider" />
      <p className="project-save-dialog-message">{message}</p>
    </ModalDialog>
  );
}
