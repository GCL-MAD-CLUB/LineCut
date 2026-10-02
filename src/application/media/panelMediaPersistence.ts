import { useEffect, useRef, useState } from "react";
import { captureOperationError } from "../../errors";
import { isTauriRuntime } from "../../platform/tauri/runtime";
import { usePanelInstanceId } from "../../runtime/systems/PanelState";
import {
  persistProjectPanelState,
  projectStatesLoaded,
  readProjectPanelState,
  useProjectPort,
} from "../../systems/ProjectSystem";

export interface MediaPanelSourceSelection {
  videoId: string;
  trackId: string;
}

interface PersistedMediaPanelState {
  sources?: MediaPanelSourceSelection[];
  sourceDirection?: "ascending" | "descending";
  sourceWidth?: number;
}

interface PersistedMediaPanelStateOptions {
  sources: readonly MediaPanelSourceSelection[];
  sourceDirection: "ascending" | "descending";
  sourceWidth: number;
  onRestoreSources: (sources: MediaPanelSourceSelection[]) => void;
  onRestoreSourceDirection: (direction: "ascending" | "descending") => void;
  onRestoreSourceWidth: (width: number) => void;
}

const persistenceDelayMs = 250;
const minimumSourceWidth = 38;
const maximumSourceWidth = 720;

function persistedSources(value: unknown): MediaPanelSourceSelection[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const sources: MediaPanelSourceSelection[] = [];
  const seenVideoIds = new Set<string>();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as MediaPanelSourceSelection).videoId !== "string" ||
      typeof (entry as MediaPanelSourceSelection).trackId !== "string"
    ) {
      continue;
    }
    const videoId = (entry as MediaPanelSourceSelection).videoId;
    if (seenVideoIds.has(videoId)) {
      continue;
    }
    seenVideoIds.add(videoId);
    sources.push({ videoId, trackId: (entry as MediaPanelSourceSelection).trackId });
  }
  return sources.length ? sources : null;
}

export function usePersistedMediaPanelState({
  sources,
  sourceDirection,
  sourceWidth,
  onRestoreSources,
  onRestoreSourceDirection,
  onRestoreSourceWidth,
}: PersistedMediaPanelStateOptions) {
  const { projectId } = useProjectPort(["projectId"], []);
  const panelId = usePanelInstanceId();
  const [projectStatesReady, setProjectStatesReady] = useState(projectStatesLoaded);
  const restoredKeyRef = useRef<string | null>(null);
  const stateKey = projectId ? `${projectId}\u0000${panelId}` : null;
  const sourcesSignature = JSON.stringify(
    sources.map((source) => [source.videoId, source.trackId] as const),
  );

  useEffect(() => {
    if (projectStatesReady) {
      return;
    }
    const timer = window.setInterval(() => {
      if (projectStatesLoaded()) {
        setProjectStatesReady(true);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [projectStatesReady]);

  useEffect(() => {
    if (!projectId) {
      restoredKeyRef.current = null;
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectStatesReady || !stateKey || !projectId || restoredKeyRef.current === stateKey) {
      return;
    }
    restoredKeyRef.current = stateKey;
    const saved = readProjectPanelState<PersistedMediaPanelState>(projectId, panelId);
    if (!saved) {
      return;
    }
    const savedSources = persistedSources(saved.sources);
    if (savedSources) {
      onRestoreSources(savedSources);
    }
    if (saved.sourceDirection === "ascending" || saved.sourceDirection === "descending") {
      onRestoreSourceDirection(saved.sourceDirection);
    }
    if (Number.isFinite(saved.sourceWidth)) {
      onRestoreSourceWidth(
        Math.min(maximumSourceWidth, Math.max(minimumSourceWidth, Math.round(saved.sourceWidth!))),
      );
    }
  }, [
    onRestoreSourceDirection,
    onRestoreSourceWidth,
    onRestoreSources,
    panelId,
    projectId,
    projectStatesReady,
    stateKey,
  ]);

  useEffect(() => {
    if (
      !projectStatesReady ||
      !isTauriRuntime() ||
      !stateKey ||
      !projectId ||
      restoredKeyRef.current !== stateKey
    ) {
      return;
    }
    const snapshot: PersistedMediaPanelState = {
      sources: sources.map((source) => ({ videoId: source.videoId, trackId: source.trackId })),
      sourceDirection,
      sourceWidth,
    };
    const timer = window.setTimeout(() => {
      void persistProjectPanelState(projectId, panelId, snapshot).catch((error) =>
        captureOperationError("project.panelState.save", error),
      );
    }, persistenceDelayMs);
    return () => window.clearTimeout(timer);
  }, [
    panelId,
    projectId,
    projectStatesReady,
    sourceDirection,
    sourceWidth,
    sourcesSignature,
    stateKey,
  ]);
}
