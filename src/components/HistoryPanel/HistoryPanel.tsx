import {
  Captions,
  CircleCheck,
  CircleOff,
  Cloud,
  CloudOff,
  ClipboardPaste,
  Eye,
  EyeOff,
  FileInput,
  FileVideo,
  FolderOpen,
  Link2,
  ListChecks,
  ListRestart,
  Pencil,
  RefreshCw,
  SplitSquareVertical,
  Trash2,
  Unlink2,
} from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectHistoryCategory } from "../../projectHistory";
import { useAppStore } from "../../store";
import { ModalDialog } from "../ModalDialog";
import "./HistoryPanel.css";

interface HistoryPanelProps {
  disabled?: boolean;
  onNavigate: (cursor: number) => void | Promise<unknown>;
  onDelete: (cursor: number) => void | Promise<unknown>;
}

function historyOperationIcon(category: ProjectHistoryCategory) {
  switch (category) {
    case "project":
      return <FolderOpen />;
    case "import":
      return <FileInput />;
    case "paste":
      return <ClipboardPaste />;
    case "rename":
      return <Pencil />;
    case "enable":
      return <CircleCheck />;
    case "disable":
      return <CircleOff />;
    case "hide":
      return <EyeOff />;
    case "show":
      return <Eye />;
    case "online":
      return <Cloud />;
    case "offline":
      return <CloudOff />;
    case "relink":
      return <RefreshCw />;
    case "bind":
      return <Link2 />;
    case "unbind":
      return <Unlink2 />;
    case "delete":
      return <Trash2 />;
    case "demux":
      return <SplitSquareVertical />;
    case "subtitle":
      return <Captions />;
    case "selection":
      return <ListChecks />;
    case "proxy":
      return <FileVideo />;
    default:
      return <ListRestart />;
  }
}

export function HistoryPanel({ disabled = false, onNavigate, onDelete }: HistoryPanelProps) {
  const history = useAppStore((state) => state.projectHistory);
  const [deleteRequest, setDeleteRequest] = useState<{
    cursor: number;
    label: string;
    count: number;
  } | null>(null);
  const rows = history.active
    ? [
        {
          id: "project-history-base",
          label: history.baseLabel,
          category: "project" as const,
          cursor: 0,
        },
        ...history.entries.map((entry, index) => ({
          id: entry.id,
          label: entry.label,
          category: entry.category,
          cursor: index + 1,
        })),
      ]
    : [];

  return (
    <section className="history-panel" aria-label="项目历史记录">
      <div className="history-list-frame">
        {rows.length === 0 ? (
          <div className="history-empty">
            <ListRestart aria-hidden="true" />
            <strong>暂无项目历史</strong>
            <span>新建或打开项目后，文件编辑操作会显示在这里。</span>
          </div>
        ) : (
          <div className="history-list" role="listbox" aria-label="最近的项目操作">
            {rows.map((row) => {
              const isCurrent = row.cursor === history.cursor;
              const isFuture = row.cursor > history.cursor;
              return (
                <button
                  key={row.id}
                  type="button"
                  className={`history-row${isCurrent ? " current" : ""}${isFuture ? " future" : ""}`}
                  role="option"
                  aria-selected={isCurrent}
                  title={row.label}
                  disabled={disabled || isCurrent}
                  onClick={() => void onNavigate(row.cursor)}
                >
                  <span className="history-current-marker" aria-hidden="true" />
                  <span className="history-operation-icon" aria-hidden="true">
                    {historyOperationIcon(row.category)}
                  </span>
                  <span className="history-operation-label">{row.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <footer className="history-footer">
        <span>{history.active ? ` ${history.cursor} 次撤销` : "未打开项目"}</span>
        <button
          type="button"
          title="删除当前事件及后续历史"
          aria-label="删除当前事件及后续历史"
          disabled={disabled || history.cursor === 0}
          onClick={() => {
            const entry = history.entries[history.cursor - 1];
            if (!entry) {
              return;
            }
            setDeleteRequest({
              cursor: history.cursor,
              label: entry.label,
              count: history.entries.length - history.cursor + 1,
            });
          }}
        >
          <Trash2 aria-hidden="true" />
        </button>
      </footer>

      {deleteRequest &&
        createPortal(
          <ModalDialog
            title="删除历史记录"
            bodyClassName="history-delete-dialog-body"
            confirmLabel="删除"
            confirmDisabled={disabled}
            onCancel={() => setDeleteRequest(null)}
            onConfirm={() => {
              const cursor = deleteRequest.cursor;
              setDeleteRequest(null);
              void onDelete(cursor);
            }}
          >
            <div className="history-delete-dialog-message">
              <Trash2 aria-hidden="true" />
              <div>
                <strong>删除“{deleteRequest.label}”及后续历史记录？</strong>
                <span>
                  项目将回到上一个事件状态，并永久删除共 {deleteRequest.count} 条历史记录。
                  <br />
                  此操作无法撤销。
                </span>
              </div>
            </div>
          </ModalDialog>,
          document.querySelector(".app-shell") ?? document.body,
        )}
    </section>
  );
}
