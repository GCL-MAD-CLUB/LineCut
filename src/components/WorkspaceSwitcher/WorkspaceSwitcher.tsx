import { Fragment } from "react";
import "./WorkspaceSwitcher.css";

export interface WorkspaceDefinition<WorkspaceId extends string> {
  id: WorkspaceId;
  label: string;
}

interface WorkspaceSwitcherProps<WorkspaceId extends string> {
  workspaces: readonly WorkspaceDefinition<WorkspaceId>[];
  activeWorkspace: WorkspaceId;
  disabled?: boolean;
  onWorkspaceChange: (workspace: WorkspaceId) => void;
}

export function WorkspaceSwitcher<WorkspaceId extends string>({
  workspaces,
  activeWorkspace,
  disabled = false,
  onWorkspaceChange,
}: WorkspaceSwitcherProps<WorkspaceId>) {
  return (
    <nav className="workspace-switcher" aria-label="工作区">
      {workspaces.map((workspace, index) => (
        <Fragment key={workspace.id}>
          {index > 0 && <span className="workspace-switcher-divider" aria-hidden="true" />}
          <button
            type="button"
            className={activeWorkspace === workspace.id ? "active" : ""}
            aria-current={activeWorkspace === workspace.id ? "page" : undefined}
            onClick={() => onWorkspaceChange(workspace.id)}
            disabled={disabled}
          >
            {workspace.label}
          </button>
        </Fragment>
      ))}
    </nav>
  );
}
