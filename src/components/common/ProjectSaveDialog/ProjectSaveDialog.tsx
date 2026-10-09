import { useEffect } from "react";
import { ModalDialog } from "../ModalDialog";
import "./ProjectSaveDialog.css";

interface ProjectSaveDialogProps {
  projectName: string;
  saving: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

export function ProjectSaveDialog({
  projectName,
  saving,
  onCancel,
  onDiscard,
  onSave,
}: ProjectSaveDialogProps) {
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
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
      if (key !== "s" && key !== "d") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (key === "s") {
        onSave();
      } else {
        onDiscard();
      }
    };

    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [onDiscard, onSave, saving]);

  return (
    <ModalDialog
      title=""
      className="project-save-dialog"
      bodyClassName="project-save-dialog-body"
      onCancel={onCancel}
      onConfirm={onSave}
      actions={
        <>
          <button
            type="button"
            className="modal-dialog-confirm"
            onClick={onSave}
            disabled={saving}
            autoFocus
          >
            {saving ? "正在存储..." : "存储(S)"}
          </button>
          <button
            type="button"
            className="modal-dialog-cancel"
            onClick={onDiscard}
            disabled={saving}
          >
            不保存(D)
          </button>
          <button
            type="button"
            className="modal-dialog-cancel"
            onClick={onCancel}
            disabled={saving}
          >
            取消
          </button>
        </>
      }
    >
      <h3 className="project-save-dialog-title">保存项目</h3>
      <div className="project-save-dialog-divider" />
      <p className="project-save-dialog-message">
        在关闭之前保存更改到 <strong title={projectName}>“{projectName}”</strong> 吗？
      </p>
    </ModalDialog>
  );
}
