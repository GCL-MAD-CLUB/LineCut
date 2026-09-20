import type { StoryboardShot, StoryboardShotAnnotation, StoryboardState } from "../../types";
import { storyboardDefaultTitle, storyboardShotDefaultTitle } from "./storyboard";
import { frameToTimeUs } from "./timeline";

function shotTitle(shot: StoryboardShot, storyboard: StoryboardState) {
  return storyboard.shotAnnotations[shot.id]?.title || storyboardShotDefaultTitle(shot);
}

function uniqueDefaultTitle(storyboard: StoryboardState, initialSequence: number) {
  const existingTitles = new Set(
    storyboard.shots.map((shot) => shotTitle(shot, storyboard).trim()),
  );
  let sequence = Math.max(1, Math.round(initialSequence));
  let title = storyboardDefaultTitle(sequence);
  while (existingTitles.has(title)) {
    sequence += 1;
    title = storyboardDefaultTitle(sequence);
  }
  return title;
}

function annotation(storyboard: StoryboardState, shot: StoryboardShot): StoryboardShotAnnotation {
  const current = storyboard.shotAnnotations[shot.id];
  return { ...current, rating: current?.rating ?? 0, retained: current?.retained ?? false };
}

export function splitStoryboardShot(
  storyboard: StoryboardState,
  frame: number,
  frameRate: number,
  newShotId: string,
  durationFrames?: number,
  durationUs?: number,
): StoryboardState {
  if (!Number.isInteger(frame) || storyboard.shots.some((shot) => shot.id === newShotId)) {
    return storyboard;
  }
  const normalizedDurationFrames = Math.max(0, Math.round(durationFrames ?? 0));
  const sourceStoryboard =
    storyboard.shots.length === 0 && frame > 0 && frame < normalizedDurationFrames
      ? {
          ...storyboard,
          shots: [
            {
              id: `${newShotId}:initial`,
              sequence: 1,
              start_frame: 0,
              end_frame: normalizedDurationFrames - 1,
              start_us: 0,
              end_us:
                durationUs !== undefined && Number.isFinite(durationUs)
                  ? Math.max(0, Math.round(durationUs))
                  : frameToTimeUs(normalizedDurationFrames, frameRate),
            },
          ],
        }
      : storyboard;
  const index = sourceStoryboard.shots.findIndex(
    (shot) => frame > shot.start_frame && frame <= shot.end_frame,
  );
  if (index < 0) return storyboard;
  const original = sourceStoryboard.shots[index];
  const title = shotTitle(original, sourceStoryboard);
  const newTitle =
    index === sourceStoryboard.shots.length - 1
      ? uniqueDefaultTitle(sourceStoryboard, index + 2)
      : `${title}-1`;
  const shots = sourceStoryboard.shots.flatMap((shot, shotIndex) =>
    shotIndex === index
      ? [
          { ...shot, end_frame: frame - 1, end_us: frameToTimeUs(frame - 1, frameRate) },
          { ...shot, id: newShotId, start_frame: frame, start_us: frameToTimeUs(frame, frameRate) },
        ]
      : [shot],
  );
  return {
    ...sourceStoryboard,
    shots: shots.map((shot, shotIndex) => ({ ...shot, sequence: shotIndex + 1 })),
    shotAnnotations: {
      ...sourceStoryboard.shotAnnotations,
      [original.id]: { ...annotation(sourceStoryboard, original), title },
      [newShotId]: { ...annotation(sourceStoryboard, original), title: newTitle },
    },
    shotStacks: sourceStoryboard.shotStacks.map((stack) => ({
      ...stack,
      shotIds: stack.shotIds.flatMap((id) => (id === original.id ? [id, newShotId] : [id])),
    })),
  };
}

export function mergeDetectedStoryboardShots(
  storyboard: StoryboardState,
  detectedShots: readonly StoryboardShot[],
  frameRate: number,
) {
  let merged = storyboard;
  for (const detectedShot of detectedShots.slice(1)) {
    if (merged.shots.some((shot) => shot.start_frame === detectedShot.start_frame)) {
      continue;
    }
    let shotId = detectedShot.id;
    let duplicateIndex = 1;
    while (merged.shots.some((shot) => shot.id === shotId)) {
      shotId = `${detectedShot.id}:merged:${duplicateIndex}`;
      duplicateIndex += 1;
    }
    merged = splitStoryboardShot(merged, detectedShot.start_frame, frameRate, shotId);
  }
  return merged;
}

// A cut is identified by the shot on its right. All frame ranges are inclusive.
export function storyboardCutDeltaBounds(
  shots: readonly StoryboardShot[],
  cutIds: ReadonlySet<string>,
) {
  let min = -Infinity;
  let max = Infinity;
  for (let index = 1; index < shots.length; index += 1) {
    const shot = shots[index];
    if (!cutIds.has(shot.id)) continue;
    const previous = shots[index - 1];
    if (index === 1 || !cutIds.has(previous.id)) {
      min = Math.max(min, previous.start_frame + 1 - shot.start_frame);
    }
    const next = shots[index + 1];
    if (!next || !cutIds.has(next.id)) {
      max = Math.min(max, shot.end_frame - shot.start_frame);
    }
  }
  return { min, max };
}

export function moveStoryboardCuts(
  storyboard: StoryboardState,
  cutIds: ReadonlySet<string>,
  requestedDelta: number,
  frameRate: number,
): StoryboardState {
  if (!Number.isFinite(requestedDelta)) return storyboard;
  const { min, max } = storyboardCutDeltaBounds(storyboard.shots, cutIds);
  const delta = Math.max(min, Math.min(max, Math.round(requestedDelta)));
  if (delta === 0) return storyboard;
  let changed = false;
  const shots = storyboard.shots.map((shot, index, all) => {
    const moveStart = index > 0 && cutIds.has(shot.id);
    const next = all[index + 1];
    const moveEnd = next && cutIds.has(next.id);
    if (!moveStart && !moveEnd) return shot;
    changed = true;
    const start = moveStart ? shot.start_frame + delta : shot.start_frame;
    const end = moveEnd ? next.start_frame + delta - 1 : shot.end_frame;
    return {
      ...shot,
      start_frame: start,
      start_us: moveStart ? frameToTimeUs(start, frameRate) : shot.start_us,
      end_frame: end,
      end_us: moveEnd ? frameToTimeUs(end, frameRate) : shot.end_us,
    };
  });
  return changed ? { ...storyboard, shots } : storyboard;
}

export function removeStoryboardCuts(
  storyboard: StoryboardState,
  cutIds: ReadonlySet<string>,
): StoryboardState {
  const groups: StoryboardShot[][] = [];
  for (const shot of storyboard.shots) {
    if (groups.length > 0 && cutIds.has(shot.id)) groups[groups.length - 1].push(shot);
    else groups.push([shot]);
  }
  if (groups.length === storyboard.shots.length) return storyboard;
  const shotAnnotations = { ...storyboard.shotAnnotations };
  const shots = groups.map((group, index) => {
    const first = group[0];
    const last = group[group.length - 1];
    if (group.length > 1) {
      const annotations = group.map((shot) => annotation(storyboard, shot));
      const retained = annotations.some((item) => item.retained);
      shotAnnotations[first.id] = {
        ...annotations[0],
        title: group.map((shot) => shotTitle(shot, storyboard)).join("-"),
        rating: Math.max(...annotations.map((item) => item.rating)),
        retained,
        excluded: !retained && annotations.every((item) => item.excluded),
        keywordIds: [...new Set(annotations.flatMap((item) => item.keywordIds ?? []))],
      };
      for (const shot of group.slice(1)) delete shotAnnotations[shot.id];
    }
    return { ...first, sequence: index + 1, end_frame: last.end_frame, end_us: last.end_us };
  });
  const remainingIds = new Set(shots.map((shot) => shot.id));
  return {
    ...storyboard,
    shots,
    shotAnnotations,
    shotStacks: storyboard.shotStacks.flatMap((stack) => {
      const shotIds = stack.shotIds.filter((id) => remainingIds.has(id));
      return shotIds.length > 1 ? [{ ...stack, id: shotIds[0], shotIds }] : [];
    }),
  };
}
