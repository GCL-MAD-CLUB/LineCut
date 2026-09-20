import type { StoryboardShot } from "../../types";

export function storyboardDefaultTitle(sequence: number) {
  const normalized = Number.isFinite(sequence) ? Math.max(1, Math.round(sequence)) : 1;
  const number = normalized < 10 ? String(normalized).padStart(2, "0") : String(normalized);
  return `分镜 ${number}`;
}

export function storyboardShotDefaultTitle(shot: Pick<StoryboardShot, "sequence">) {
  return storyboardDefaultTitle(shot.sequence);
}
