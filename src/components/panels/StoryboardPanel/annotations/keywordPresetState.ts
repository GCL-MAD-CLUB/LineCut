import { formatStoryboardKeywordPath, parseStoryboardKeywordInput } from "./storyboardKeywords";
import { create } from "zustand";
import { useMemo } from "react";
import { readAppStorage } from "../../../../runtime/storage";
import {
  customKeywordSet,
  decodeKeywordPresets,
  defaultKeywordPresetId,
  keywordPresetNameError,
  keywordSlots,
  recentKeywordSet,
  restoreKeywordPresets,
  type KeywordPreset,
} from "../../../../core/editor/keywordPresets";

function normalizedKeywords(keywords: readonly string[]) {
  return keywordSlots(keywords).map((keyword) => {
    const result = parseStoryboardKeywordInput(keyword);
    return !result.error && result.paths.length === 1
      ? formatStoryboardKeywordPath(result.paths[0])
      : keyword;
  });
}

const storageKey = "locution-pro:keyword-presets";
function readPresets() {
  try {
    return decodeKeywordPresets(JSON.parse(readAppStorage(storageKey) ?? "null"));
  } catch {
    return decodeKeywordPresets(null);
  }
}

interface KeywordPresetState {
  presets: KeywordPreset[];
  selected: string;
  custom: string[] | null;
  select: (id: string) => void;
  save: (id: string, keywords: readonly string[]) => void;
  createPreset: (name: string, keywords: readonly string[]) => string | null;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  restore: () => void;
}

export const useKeywordPresetState = create<KeywordPresetState>((set, get) => ({
  ...readPresets(),
  custom: null,
  select: (id) =>
    set((state) =>
      id === recentKeywordSet || state.presets.some((preset) => preset.id === id)
        ? { selected: id, custom: null }
        : id === customKeywordSet && state.custom
          ? { selected: id }
          : {},
    ),
  save: (id, keywords) =>
    set((state) =>
      id === recentKeywordSet || id === customKeywordSet
        ? { selected: customKeywordSet, custom: normalizedKeywords(keywords) }
        : {
            presets: state.presets.map((preset) =>
              preset.id === id ? { ...preset, keywords: normalizedKeywords(keywords) } : preset,
            ),
          },
    ),
  createPreset: (name, keywords) => {
    if (keywordPresetNameError(name, get().presets)) return null;
    const id = `preset:${crypto.randomUUID()}`;
    set((state) => ({
      presets: [
        ...state.presets,
        { id, name: name.trim(), keywords: normalizedKeywords(keywords) },
      ],
      selected: id,
      custom: null,
    }));
    return id;
  },
  rename: (id, name) => {
    if (id !== defaultKeywordPresetId && !keywordPresetNameError(name, get().presets, id))
      set((state) => ({
        presets: state.presets.map((preset) =>
          preset.id === id ? { ...preset, name: name.trim() } : preset,
        ),
      }));
  },
  remove: (id) =>
    set((state) => {
      const preset = state.presets.find((preset) => preset.id === id);
      if (!preset || id === defaultKeywordPresetId) return {};
      return {
        presets: state.presets.filter((preset) => preset.id !== id),
        ...(state.selected === id
          ? { selected: customKeywordSet, custom: [...preset.keywords] }
          : {}),
      };
    }),
  restore: () => set((state) => ({ presets: restoreKeywordPresets(state.presets) })),
}));

useKeywordPresetState.subscribe((state) => {
  try {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        presets: state.presets,
        selected: state.selected === customKeywordSet ? recentKeywordSet : state.selected,
      }),
    );
  } catch {
    /* Keep the session usable when profile storage is unavailable. */
  }
});

export function useKeywordSet(recent: readonly string[]) {
  const state = useKeywordPresetState();
  const keywords = useMemo(
    () =>
      state.selected === recentKeywordSet
        ? keywordSlots(recent)
        : state.selected === customKeywordSet
          ? (state.custom ?? keywordSlots([]))
          : (state.presets.find((preset) => preset.id === state.selected)?.keywords ??
            keywordSlots([])),
    [recent, state.selected, state.custom, state.presets],
  );
  return { ...state, keywords };
}
