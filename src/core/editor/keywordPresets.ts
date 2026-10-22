export const recentKeywordSet = "recent";
export const customKeywordSet = "custom";
export const defaultKeywordPresetId = "builtin:shot-size";

export interface KeywordPreset {
  id: string;
  name: string;
  keywords: string[];
}

export function keywordSlots(keywords: readonly string[]) {
  return Array.from({ length: 9 }, (_, index) => keywords[index]?.trim() ?? "");
}

export function defaultKeywordPresets(): KeywordPreset[] {
  return [
    {
      id: defaultKeywordPresetId,
      name: "景别",
      keywords: keywordSlots(["特写", "近景", "中景", "远景", "空镜"]),
    },
  ];
}

export function restoreKeywordPresets(presets: readonly KeywordPreset[]) {
  return [
    ...defaultKeywordPresets(),
    ...presets.filter((preset) => preset.id !== defaultKeywordPresetId),
  ];
}

export function keywordPresetNameError(
  name: string,
  presets: readonly KeywordPreset[],
  exceptId?: string,
) {
  if (!name.trim()) return "请输入预设名称。";
  if (
    ["自定", "最近使用过的关键字"].includes(name.trim()) ||
    presets.some((preset) => preset.id !== exceptId && preset.name === name.trim())
  )
    return "名称已被使用。";
  return null;
}

export function decodeKeywordPresets(value: unknown): {
  presets: KeywordPreset[];
  selected: string;
} {
  const defaults = { presets: defaultKeywordPresets(), selected: recentKeywordSet };
  if (!value || typeof value !== "object") return defaults;
  const data = value as { presets?: unknown; selected?: unknown };
  if (!Array.isArray(data.presets)) return defaults;
  const presets: KeywordPreset[] = [];
  for (const item of data.presets) {
    if (
      !item ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      !Array.isArray(item.keywords) ||
      !item.keywords.every((keyword: unknown) => typeof keyword === "string")
    )
      continue;
    if (
      presets.some((preset) => preset.id === item.id) ||
      [recentKeywordSet, customKeywordSet].includes(item.id) ||
      keywordPresetNameError(item.name, presets)
    )
      continue;
    presets.push({ id: item.id, name: item.name.trim(), keywords: keywordSlots(item.keywords) });
  }
  if (!presets.some((preset) => preset.id === defaultKeywordPresetId))
    presets.unshift(...defaultKeywordPresets());
  return {
    presets,
    selected: presets.some((preset) => preset.id === data.selected)
      ? (data.selected as string)
      : recentKeywordSet,
  };
}
