import { TriangleAlert } from "lucide-react";
import { Component, useSyncExternalStore, type ErrorInfo, type ReactNode } from "react";
import { ModalDialog } from "../components/ModalDialog";
import {
  captureIncident,
  dismissIncident,
  getIncidentSnapshot,
  normalizeError,
  subscribeIncidents,
} from "./runtime";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const normalized = normalizeError(error);
    normalized.detail = `${normalized.detail}\n${info.componentStack ?? ""}`;
    captureIncident("runtime.render", normalized);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="fatal-error-fallback">
          <strong>应用界面暂时无法继续运行</strong>
          <span>请关闭错误提示后重新启动应用。</span>
        </main>
      );
    }
    return this.props.children;
  }
}

export function ErrorOutlet() {
  const { incidents } = useSyncExternalStore(
    subscribeIncidents,
    getIncidentSnapshot,
    getIncidentSnapshot,
  );
  const modal = incidents.find((incident) => incident.presentation === "modal");

  return modal ? (
    <ModalDialog
      title={modal.title}
      className="error-dialog"
      bodyClassName="error-dialog-body"
      onCancel={() => dismissIncident(modal.id)}
      onConfirm={() => dismissIncident(modal.id)}
      actions={
        <button
          type="button"
          className="modal-dialog-confirm"
          onClick={() => dismissIncident(modal.id)}
        >
          确定
        </button>
      }
    >
      <TriangleAlert className="error-dialog-icon" aria-hidden="true" />
      <div>
        <p>{modal.message}</p>
        <p>{`ERROR: ${modal.category.charAt(0).toUpperCase() + modal.category.slice(1)}Error`}</p>
      </div>
    </ModalDialog>
  ) : null;
}
