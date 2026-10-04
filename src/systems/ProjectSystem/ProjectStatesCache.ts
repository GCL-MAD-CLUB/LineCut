import { invokeCommand } from "../../errors";
import type { ProjectExportState, ProjectStateConfig } from "../../types";

/** In-memory mirror of the per-project state persisted in WorkspaceConfig.xml, keyed by project document id, so the project open flow can read recorded export settings synchronously. */
let states: Record<string, ProjectStateConfig> = {};
let loaded = false;
const panelStateWrites = new Map<string, Promise<void>>();

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

export function readProjectPanelState<State>(
  projectId: string | null,
  panelId: string,
): State | null {
  if (!projectId) {
    return null;
  }
  return (states[projectId]?.panelStates?.[panelId] as State | undefined) ?? null;
}

/** Persists a project's export settings both locally and to the global store; passing `null` clears the entry so empty state never lingers. */
export async function persistExportState(
  projectId: string,
  exportState: ProjectExportState | null,
): Promise<void> {
  await invokeCommand("save_project_state", { projectId, exportState });
  if (exportState) {
    states = {
      ...states,
      [projectId]: { ...(states[projectId] ?? {}), exportState },
    };
  } else {
    const next = { ...states };
    const current = next[projectId];
    if (current && Object.keys(current.panelStates ?? {}).length > 0) {
      next[projectId] = { ...current, exportState: null };
    } else {
      delete next[projectId];
    }
    states = next;
  }
}

export async function persistProjectPanelState(
  projectId: string,
  panelId: string,
  panelState: unknown | null,
): Promise<void> {
  const current = states[projectId] ?? { exportState: null, panelStates: {} };
  const panelStates = { ...(current.panelStates ?? {}) };
  if (panelState === null) {
    delete panelStates[panelId];
  } else {
    panelStates[panelId] = panelState;
  }
  const next = { ...states };
  if (!current.exportState && Object.keys(panelStates).length === 0) {
    delete next[projectId];
  } else {
    next[projectId] = { ...current, panelStates };
  }
  states = next;
  // Keep the latest UI state available during rapid project switches, and preserve write order.
  const key = JSON.stringify([projectId, panelId]);
  const previous = panelStateWrites.get(key) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      await invokeCommand("save_project_panel_state", { projectId, panelId, panelState });
    });
  panelStateWrites.set(key, write);
  try {
    await write;
  } finally {
    if (panelStateWrites.get(key) === write) panelStateWrites.delete(key);
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
