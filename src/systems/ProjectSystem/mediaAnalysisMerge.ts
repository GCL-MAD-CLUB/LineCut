import type { Project } from "../../types";

/** Analysis owns newly discovered embedded tracks, never the user's edits or links. */
export function mergeMediaAnalysis(current: Project, analyzed: Project): Project {
  if (
    current.asset.path !== analyzed.asset.path ||
    current.asset.fingerprint !== analyzed.asset.fingerprint
  )
    return current;
  const additions = analyzed.tracks.filter(
    (track) =>
      track.source_type === "embedded" &&
      !current.tracks.some(
        (existing) =>
          existing.id === track.id ||
          (existing.source_type === "embedded" && existing.stream_index === track.stream_index),
      ),
  );
  const repairs = analyzed.tracks.filter(
    (track) =>
      track.source_type === "embedded" &&
      analyzed.cues[track.id] &&
      !current.cues[track.id] &&
      current.tracks.some((existing) => existing.id === track.id),
  );
  if (!additions.length && !repairs.length) return current;
  const cues = { ...current.cues };
  for (const track of [...additions, ...repairs])
    if (analyzed.cues[track.id]) cues[track.id] = analyzed.cues[track.id];
  return {
    ...current,
    tracks: [
      ...current.tracks.map((track) =>
        repairs.find((repair) => repair.id === track.id)
          ? { ...track, cue_count: analyzed.cues[track.id].length, warning: null }
          : track,
      ),
      ...additions,
    ],
    cues,
  };
}
