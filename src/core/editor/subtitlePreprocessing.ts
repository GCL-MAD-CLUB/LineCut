import type { Project, SubtitleCue } from "../../types";

interface ProcessedSubtitles {
  cues: SubtitleCue[];
  /** Only merged rows need an explicit mapping back to their original cues. */
  mergedCueIds: ReadonlyMap<string, readonly string[]>;
}

const cueCache = new WeakMap<readonly SubtitleCue[], ProcessedSubtitles>();
const projectCache = new WeakMap<Project, Project>();
const projectsCache = new WeakMap<Record<string, Project>, Record<string, Project>>();

/** A shared read view; parsed cues and source files are never changed. */
export function preprocessSubtitleCues(cues: SubtitleCue[]): ProcessedSubtitles {
  const cached = cueCache.get(cues);
  if (cached) return cached;

  const compare = (a: SubtitleCue, b: SubtitleCue) =>
    a.start_us - b.start_us || a.sequence - b.sequence;
  const ordered = cues.some((cue, index) => index > 0 && compare(cues[index - 1], cue) > 0)
    ? [...cues].sort(compare)
    : cues;
  const merged: SubtitleCue[] = [];
  const mergedCueIds = new Map<string, string[]>();
  for (const cue of ordered) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.track_id === cue.track_id &&
      previous.plain_text === cue.plain_text &&
      cue.start_us <= previous.end_us
    ) {
      merged[merged.length - 1] = { ...previous, end_us: Math.max(previous.end_us, cue.end_us) };
      const ids = mergedCueIds.get(previous.id) ?? [previous.id];
      ids.push(cue.id);
      mergedCueIds.set(previous.id, ids);
    } else {
      merged.push(cue);
    }
  }
  const result = { cues: mergedCueIds.size ? merged : ordered, mergedCueIds };
  cueCache.set(cues, result);
  // Every consumer can request the same view without sorting or merging again.
  cueCache.set(result.cues, result);
  return result;
}

/** Resolve displayed row IDs before applying an explicit edit to parsed data. */
export function subtitleSourceCueIds(cues: SubtitleCue[], cueIds: Iterable<string>) {
  const { mergedCueIds } = preprocessSubtitleCues(cues);
  return new Set(Array.from(cueIds).flatMap((id) => mergedCueIds.get(id) ?? [id]));
}

export function preprocessProjectSubtitles(project: Project): Project {
  const cached = projectCache.get(project);
  if (cached) return cached;
  let cues = project.cues;
  const tracks = project.tracks.map((track) => {
    const source = project.cues[track.id];
    if (track.kind !== "text" || !source) return track;
    const processed = preprocessSubtitleCues(source).cues;
    if (processed !== source) {
      if (cues === project.cues) cues = { ...cues };
      cues[track.id] = processed;
    }
    return track.cue_count === processed.length ? track : { ...track, cue_count: processed.length };
  });
  const result =
    cues !== project.cues || tracks.some((track, index) => track !== project.tracks[index])
      ? { ...project, cues, tracks }
      : project;
  projectCache.set(project, result);
  projectCache.set(result, result);
  return result;
}

export function preprocessProjectsSubtitles(projects: Record<string, Project>) {
  const cached = projectsCache.get(projects);
  if (cached) return cached;
  let result = projects;
  for (const [id, project] of Object.entries(projects)) {
    const processed = preprocessProjectSubtitles(project);
    if (processed !== project) {
      if (result === projects) result = { ...projects };
      result[id] = processed;
    }
  }
  projectsCache.set(projects, result);
  projectsCache.set(result, result);
  return result;
}
