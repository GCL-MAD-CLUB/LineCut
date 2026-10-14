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
  onHome: () => void;
  onWorkspaceChange: (workspace: WorkspaceId) => void;
}

export function WorkspaceSwitcher<WorkspaceId extends string>({
  workspaces,
  activeWorkspace,
  disabled = false,
  onWorkspaceChange,
  onHome,
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
      <span className="workspace-switcher-divider" aria-hidden="true" />
      <button
        type="button"
        className="workspace-home"
        onClick={onHome}
        aria-label="项目首页"
        title="项目首页"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2 1 13h3v9h6v-7h4v7h6v-9h3L12 2Z" />
        </svg>
      </button>
    </nav>
  );
}
