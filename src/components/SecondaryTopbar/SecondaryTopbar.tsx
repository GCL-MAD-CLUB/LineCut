import { TaskProgress } from "../TaskProgress";
import { WorkspaceSwitcher, type WorkspaceDefinition } from "../WorkspaceSwitcher";
import "./SecondaryTopbar.css";

const appIconUrl = new URL("../../../src-tauri/icons/icon.ico", import.meta.url).href;

function projectName(path: string) {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  return fileName.replace(/\.lcp$/i, "");
}

interface SecondaryTopbarProps<WorkspaceId extends string> {
  projectFilePath: string | null;
  hasProjectMedia: boolean;
  isProjectDirty: boolean;
  workspaces: readonly WorkspaceDefinition<WorkspaceId>[];
  activeWorkspace: WorkspaceId;
  isWorkspaceSwitchingDisabled?: boolean;
  onWorkspaceChange: (workspace: WorkspaceId) => void;
}

export function SecondaryTopbar<WorkspaceId extends string>({
  projectFilePath,
  hasProjectMedia,
  isProjectDirty,
  workspaces,
  activeWorkspace,
  isWorkspaceSwitchingDisabled = false,
  onWorkspaceChange,
}: SecondaryTopbarProps<WorkspaceId>) {
  const projectLabel = projectFilePath
    ? projectName(projectFilePath)
    : hasProjectMedia
      ? "未命名项目"
      : "";

  return (
    <header className="secondary-topbar">
      <div className="secondary-topbar-left">
        <div className="secondary-topbar-brand">
          <img src={appIconUrl} alt="" className="secondary-topbar-icon" />
          <TaskProgress>
            <div className="secondary-topbar-brand-copy">
              <strong>LineCut</strong>
              <span>对白检索与片段导出</span>
            </div>
          </TaskProgress>
        </div>
      </div>

      <div className="secondary-topbar-project" title={projectFilePath ?? ""}>
        <span>{projectLabel}</span>
        {isProjectDirty && <span className="secondary-topbar-dirty-mark" title="有未保存的更改" />}
      </div>

      <WorkspaceSwitcher
        workspaces={workspaces}
        activeWorkspace={activeWorkspace}
        disabled={isWorkspaceSwitchingDisabled}
        onWorkspaceChange={onWorkspaceChange}
      />
    </header>
  );
}
