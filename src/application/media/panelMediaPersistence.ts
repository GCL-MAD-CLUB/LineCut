import {
  panelMediaWorkspaces,
  readPanelMediaWorkspaces,
  type PanelMediaWorkspaceState,
  type PersistedPanelMediaWorkspaces,
} from "../../core/editor/panelSourceSelection";
import { useProjectPort } from "../../systems/ProjectSystem";
import { usePersistedProjectPanelState } from "./projectPanelPersistence";

export interface MediaPanelSourceSelection {
  videoId: string;
  trackId: string;
}

interface PersistedMediaPanelState {
  sources?: MediaPanelSourceSelection[];
  workspaceState?: PersistedPanelMediaWorkspaces;
  sourceDirection?: "ascending" | "descending";
  sourceWidth?: number;
}

interface PersistedMediaPanelStateOptions {
  selection: PanelMediaWorkspaceState & { projectId: string | null | undefined };
  sourceDirection: "ascending" | "descending";
  sourceWidth: number;
  onRestoreWorkspaces: (projectId: string, saved: PersistedPanelMediaWorkspaces) => void;
  onRestoreSources: (sources: MediaPanelSourceSelection[]) => void;
  onRestoreSourceDirection: (direction: "ascending" | "descending") => void;
  onRestoreSourceWidth: (width: number) => void;
}

const minimumSourceWidth = 38;
const maximumSourceWidth = 720;

function persistedSources(value: unknown): MediaPanelSourceSelection[] | null {
  if (!Array.isArray(value)) return null;
  const sources: MediaPanelSourceSelection[] = [];
  const seenVideoIds = new Set<string>();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.videoId !== "string" ||
      typeof entry.trackId !== "string"
    )
      continue;
    if (seenVideoIds.has(entry.videoId)) continue;
    seenVideoIds.add(entry.videoId);
    sources.push({ videoId: entry.videoId, trackId: entry.trackId });
  }
  return value.length === 0 ? [] : sources.length ? sources : null;
}

export function usePersistedMediaPanelState({
  selection,
  sourceDirection,
  sourceWidth,
  onRestoreWorkspaces,
  onRestoreSources,
  onRestoreSourceDirection,
  onRestoreSourceWidth,
}: PersistedMediaPanelStateOptions) {
  const { projectId } = useProjectPort(["projectId"], []);
  const snapshot: PersistedMediaPanelState | null =
    selection.projectId === projectId
      ? {
          sources: selection.sources.map((source) => ({ ...source })),
          workspaceState: {
            workspaceId: selection.workspaceId,
            workspaces: panelMediaWorkspaces(selection),
          },
          sourceDirection,
          sourceWidth,
        }
      : null;
  usePersistedProjectPanelState(snapshot, (saved, restoredProjectId) => {
    if (!saved || typeof saved !== "object") return;
    const workspaceState = readPanelMediaWorkspaces(saved.workspaceState);
    if (workspaceState) onRestoreWorkspaces(restoredProjectId, workspaceState);
    else {
      const sources = persistedSources(saved.sources);
      if (sources !== null) onRestoreSources(sources);
    }
    if (saved.sourceDirection === "ascending" || saved.sourceDirection === "descending") {
      onRestoreSourceDirection(saved.sourceDirection);
    }
    if (Number.isFinite(saved.sourceWidth)) {
      onRestoreSourceWidth(
        Math.min(maximumSourceWidth, Math.max(minimumSourceWidth, Math.round(saved.sourceWidth!))),
      );
    }
  });
}
