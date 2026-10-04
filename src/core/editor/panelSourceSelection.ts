export interface PanelSourceChoice {
  videoId: string;
  trackId: string;
}

export interface PanelMediaWorkspace {
  id: number;
  sources: PanelSourceChoice[];
  videoId: string;
  trackId: string;
  frame: number;
}

export interface PanelMediaWorkspaceState {
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
  };
  return [...state.workspaces.filter((workspace) => workspace.id !== current.id), current];
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
