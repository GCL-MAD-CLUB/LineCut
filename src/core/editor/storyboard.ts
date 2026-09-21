import type { StoryboardShot } from "../../types";

export interface StoryboardGap {
  startFrame: number;
  endFrame: number; // Exclusive boundary.
}

export function storyboardGaps(shots: readonly StoryboardShot[], durationFrames: number) {
  const gaps: StoryboardGap[] = [];
  let coveredEnd = 0;
  for (const shot of [...shots].sort((a, b) => a.start_frame - b.start_frame)) {
    const start = Math.min(durationFrames, Math.max(0, shot.start_frame));
    if (start > coveredEnd) gaps.push({ startFrame: coveredEnd, endFrame: start });
    coveredEnd = Math.min(durationFrames, Math.max(coveredEnd, shot.end_frame + 1));
  }
  if (coveredEnd < durationFrames) {
    gaps.push({ startFrame: coveredEnd, endFrame: durationFrames });
  }
  return gaps;
}

// Only crossing the entrance during forward playback skips a gap. Starting or
// seeking inside it leaves that gap playable, including at its first frame.
export function crossedStoryboardGap(
  gaps: readonly StoryboardGap[],
  previousFrame: number,
  nextFrame: number,
) {
  return gaps.find((gap) => previousFrame < gap.startFrame && nextFrame >= gap.startFrame);
}

export function storyboardDefaultTitle(sequence: number) {
  const normalized = Number.isFinite(sequence) ? Math.max(1, Math.round(sequence)) : 1;
  const number = normalized < 10 ? String(normalized).padStart(2, "0") : String(normalized);
  return `分镜 ${number}`;
}

export function storyboardShotDefaultTitle(shot: Pick<StoryboardShot, "sequence">) {
  return storyboardDefaultTitle(shot.sequence);
}
