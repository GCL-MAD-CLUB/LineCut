export interface PanelSourceChoice {
  videoId: string;
  trackId: string;
}

export interface PanelSourceSnapshot {
  sources: PanelSourceChoice[];
  videoId: string;
  trackId: string;
  frame: number;
}

export interface PanelSourceHistory {
  sourceHistory: PanelSourceSnapshot[];
  sourceHistoryIndex: number;
}

export interface PanelMediaWorkspace extends PanelSourceSnapshot, PanelSourceHistory {
  id: number;
}

export interface PanelMediaWorkspaceState extends PanelSourceHistory {
  workspaceId: number | null;
  nextWorkspaceId: number;
  workspaces: PanelMediaWorkspace[];
  sources: PanelSourceChoice[];
  videoId: string | null;
  trackId: string;
  frame: number;
}

/** The current entry always reflects manual source changes and the latest playhead. */
export function panelMediaWorkspaces(state: PanelMediaWorkspaceState): PanelMediaWorkspace[] {
  if (state.workspaceId === null) return state.workspaces;
  const current = {
    id: state.workspaceId,
    sources: state.sources,
    videoId: state.videoId ?? "",
    trackId: state.trackId,
    frame: state.frame,
    sourceHistory: state.sourceHistory,
    sourceHistoryIndex: state.sourceHistoryIndex,
  };
  return [...state.workspaces.filter((workspace) => workspace.id !== current.id), current];
}

export const maximumSourceHistorySteps = 10;

export function panelSourceSnapshot(state: {
  sources: PanelSourceChoice[];
  videoId: string | null;
  trackId: string;
  frame: number;
}): PanelSourceSnapshot {
  return {
    sources: state.sources.map((source) => ({ ...source })),
    videoId: state.videoId ?? "",
    trackId: state.trackId,
    frame: state.frame,
  };
}

/** Manual edits truncate the forward branch; playback and row focus do not add steps. */
export function recordPanelSourceHistory(
  current: PanelMediaWorkspaceState,
  next: PanelSourceSnapshot,
): PanelSourceHistory {
  if (JSON.stringify(current.sources) === JSON.stringify(next.sources)) {
    return { sourceHistory: current.sourceHistory, sourceHistoryIndex: current.sourceHistoryIndex };
  }
  const previous = panelSourceSnapshot(current);
  const sourceHistory = current.sourceHistory.length
    ? current.sourceHistory.slice(0, current.sourceHistoryIndex + 1)
    : [previous];
  sourceHistory[sourceHistory.length - 1] = previous;
  sourceHistory.push(panelSourceSnapshot(next));
  const bounded = sourceHistory.slice(-(maximumSourceHistorySteps + 1));
  return { sourceHistory: bounded, sourceHistoryIndex: bounded.length - 1 };
}

export interface PersistedPanelMediaWorkspaces {
  workspaceId: number | null;
  workspaces: PanelMediaWorkspace[];
}

function readSourceSnapshot(value: unknown): PanelSourceSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<PanelSourceSnapshot>;
  if (
    !Array.isArray(entry.sources) ||
    typeof entry.videoId !== "string" ||
    typeof entry.trackId !== "string"
  )
    return null;
  const sources: PanelSourceChoice[] = [];
  const seen = new Set<string>();
  for (const source of entry.sources) {
    if (!source || typeof source.videoId !== "string" || typeof source.trackId !== "string")
      return null;
    if (!seen.has(source.videoId)) {
      sources.push({ videoId: source.videoId, trackId: source.trackId });
      seen.add(source.videoId);
    }
  }
  const active = sources.find((source) => source.videoId === entry.videoId) ?? sources[0];
  return {
    sources,
    videoId: active?.videoId ?? "",
    trackId: active?.trackId ?? "",
    frame: Number.isFinite(entry.frame) ? Math.max(0, Math.round(entry.frame!)) : 0,
  };
}

/** Reject malformed configuration while accepting entries written before path history existed. */
export function readPanelMediaWorkspaces(value: unknown): PersistedPanelMediaWorkspaces | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as Partial<PersistedPanelMediaWorkspaces>;
  if (!Array.isArray(saved.workspaces)) return null;
  const workspaces: PanelMediaWorkspace[] = [];
  const ids = new Set<number>();
  for (const entry of saved.workspaces) {
    const snapshot = readSourceSnapshot(entry);
    if (!snapshot || !Number.isSafeInteger(entry.id) || entry.id < 1 || ids.has(entry.id)) continue;
    ids.add(entry.id);
    const history = Array.isArray(entry.sourceHistory)
      ? entry.sourceHistory
          .map(readSourceSnapshot)
          .filter((step): step is PanelSourceSnapshot => step !== null)
      : [];
    const index = Number.isInteger(entry.sourceHistoryIndex)
      ? Math.max(0, Math.min(history.length - 1, entry.sourceHistoryIndex))
      : history.length - 1;
    const start = Math.max(0, index - maximumSourceHistorySteps);
    const sourceHistory = history.length
      ? history.slice(start, start + maximumSourceHistorySteps + 1)
      : [snapshot];
    const sourceHistoryIndex = history.length ? index - start : 0;
    sourceHistory[sourceHistoryIndex] = snapshot;
    workspaces.push({ ...snapshot, id: entry.id, sourceHistory, sourceHistoryIndex });
  }
  return {
    workspaces,
    workspaceId:
      saved.workspaceId === null
        ? null
        : (workspaces.find((entry) => entry.id === saved.workspaceId)?.id ??
          workspaces.at(-1)?.id ??
          null),
  };
}

export function panelSourceTitle(label: string, sources: readonly { name: string }[]) {
  return sources.length > 1
    ? `${label}\n\n${sources.map((source) => source.name).join("\n")}`
    : label;
}

interface AvailablePanelSource {
  videoId: string;
  tracks: readonly { id: string }[];
}

export function mediaPanelTitle(
  kind: "subtitles" | "storyboard",
  sources: readonly { name: string; trackId: string }[],
) {
  const label = kind === "subtitles" ? "字幕" : "分镜";
  if (sources.length > 1) return `${label}：${sources.length} 个来源`;
  const source = sources[0];
  if (!source) return `${label}：（未选择）`;
  return `${label}：${source.name}${kind === "subtitles" && !source.trackId ? "（无字幕）" : ""}`;
}

/**
 * An unbound video stays selected; its first visible track becomes selected when bound.
 * Resolve availability without replacing the requested choices, so undo can restore them.
 */
export function resolvePanelSourceChoices(
  requested: readonly PanelSourceChoice[],
  available: readonly AvailablePanelSource[],
): PanelSourceChoice[] {
  const byVideo = new Map(available.map((source) => [source.videoId, source]));
  return requested.flatMap((choice) => {
    const source = byVideo.get(choice.videoId);
    if (!source) return [];
    return [
      {
        videoId: choice.videoId,
        trackId:
          source.tracks.find((track) => track.id === choice.trackId)?.id ??
          source.tracks[0]?.id ??
          "",
      },
    ];
  });
}

/** Clicking a video or its selected track removes it, including the last source. */
export function togglePanelSourceChoice(
  current: readonly PanelSourceChoice[],
  choice: PanelSourceChoice,
  selectTrack: boolean,
): PanelSourceChoice[] {
  const existing = current.find((source) => source.videoId === choice.videoId);
  if (!existing) return [...current, choice];
  if (selectTrack && existing.trackId !== choice.trackId) {
    return current.map((source) => (source.videoId === choice.videoId ? choice : source));
  }
  return current.filter((source) => source.videoId !== choice.videoId);
}

/** Render the destination session immediately, before the store's context effect runs. */
export function panelSessionForContext<Session>(
  currentContext: string,
  nextContext: string,
  current: Session,
  sessions: Record<string, Session>,
  defaults: () => Session,
): Session {
  return currentContext === nextContext ? current : (sessions[nextContext] ?? defaults());
}
