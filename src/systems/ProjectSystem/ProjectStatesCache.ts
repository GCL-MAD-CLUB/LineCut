import { invokeCommand } from "../../errors";
import type { ProjectExportState, ProjectStateConfig } from "../../types";

/** In-memory mirror of the per-project state persisted in WorkspaceConfig.xml, keyed by project document id, so the project open flow can read recorded export settings synchronously. */
let states: Record<string, ProjectStateConfig> = {};
let loaded = false;

export function projectStatesLoaded() {
  return loaded;
}

export async function loadProjectStates() {
  states = await invokeCommand<Record<string, ProjectStateConfig>>("load_project_states");
  loaded = true;
  return states;
}

/** Synchronously reads the recorded export settings for a project id. */
export function readExportState(projectId: string | null): ProjectExportState | null {
  if (!projectId) {
    return null;
  }
  return states[projectId]?.exportState ?? null;
}

/** Persists a project's export settings both locally and to the global store; passing `null` clears the entry so empty state never lingers. */
export async function persistExportState(
  projectId: string,
  exportState: ProjectExportState | null,
): Promise<void> {
  await invokeCommand("save_project_state", { projectId, exportState });
  if (exportState) {
    states = { ...states, [projectId]: { exportState } };
  } else {
    const next = { ...states };
    delete next[projectId];
    states = next;
  }
}

/** Removes every per-project entry whose document id is not on the keep list, derived from the recently-opened projects list. */
export async function pruneProjectStates(keepProjectIds: string[]) {
  // Prune on the backend first, then rebuild the local cache from the current
  // map (not a pre-await snapshot) so a persist that finished while the backend
  // call was in flight survives whenever its id is still kept.
  await invokeCommand("prune_project_states", { keepProjectIds });
  const keep = new Set(keepProjectIds);
  const next: Record<string, ProjectStateConfig> = {};
  for (const [id, config] of Object.entries(states)) {
    if (keep.has(id)) {
      next[id] = config;
    }
  }
  states = next;
}
