import type { Project, StoryboardDetectionResult, StoryboardState } from "../../types";
import { storyboardShotDefaultTitle } from "./storyboard";
import { mergeDetectedStoryboardShots } from "./storyboardCuts";

export type StoryboardDetectionMode = "merge" | "overwrite";

/**
 * Identity of a detected storyboard: the video plus the exact asset revision it was analyzed at.
 * Every producer and consumer of a storyboard must build this string the same way, because the
 * detection pipeline matches results against it by exact equality.
 */
export function storyboardVideoContext(videoId: string, project: Project | null | undefined) {
  return `${videoId}:${project?.asset.id ?? ""}:${project?.asset.fingerprint ?? ""}`;
}

/** Whether a storyboard already holds anything a re-detection could destroy. */
export function hasStoryboardShots(storyboard: StoryboardState | undefined) {
  return Boolean(storyboard && (storyboard.shots.length || storyboard.deletedShots?.length));
}

/** Only edits that detection can replace require renewed consent, not shared catalog updates. */
export function storyboardDetectionEditSignature(storyboard: StoryboardState | undefined) {
  return JSON.stringify(
    {
      shots: storyboard?.shots ?? [],
      deletedShots: storyboard?.deletedShots ?? [],
      shotStacks: storyboard?.shotStacks ?? [],
      shotAnnotations: storyboard?.shotAnnotations ?? {},
    },
    (_, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
          )
        : value,
  );
}

export function detectedStoryboard(
  current: StoryboardState,
  result: StoryboardDetectionResult,
  mode: StoryboardDetectionMode,
): StoryboardState {
  if (mode === "merge" && hasStoryboardShots(current))
    return mergeDetectedStoryboardShots(current, result.shots, result.frame_rate);
  return {
    ...current,
    shots: result.shots,
    deletedShots: [],
    shotStacks: [],
    shotAnnotations: Object.fromEntries(
      result.shots.map((shot) => [
        shot.id,
        { rating: 0, retained: false, title: storyboardShotDefaultTitle(shot) },
      ]),
    ),
  };
}
