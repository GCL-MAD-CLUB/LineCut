import { useSyncExternalStore } from "react";
import type { SemanticShot } from "./storyboardSemanticSearch";

const selections = new Map<string, readonly number[]>();
const listeners = new Set<() => void>();
const empty: readonly number[] = [];

function key(shot: SemanticShot) {
  return JSON.stringify([shot.assetId, shot.fingerprint, shot.startFrame, shot.endFrame]);
}

export function publishSelectedFrames(
  shots: readonly SemanticShot[],
  selected: readonly { id: string; frames: number[] }[],
) {
  const byId = new Map(selected.map((row) => [row.id, row.frames]));
  for (const shot of shots) {
    const frames = byId.get(shot.id);
    if (frames) selections.set(key(shot), frames);
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useStoryboardSelectedFrames(shot: SemanticShot | undefined) {
  const selectionKey = shot ? key(shot) : "";
  return useSyncExternalStore(subscribe, () => selections.get(selectionKey) ?? empty);
}
