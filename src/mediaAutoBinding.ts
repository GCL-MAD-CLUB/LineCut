import type { MediaBinItem } from "./types";

export type MediaAutoBindType = "all" | "audio" | "subtitle";
export type MediaAutoBindPreset = "direct" | "virtual-copy";
export type MediaAutoBindPreference = "smart" | "name";

export interface MediaAutoBindingPair {
  itemId: string;
  videoId: string;
  score: number;
}

const auxiliaryTokens = new Set([
  "audio",
  "sound",
  "subtitle",
  "subtitles",
  "sub",
  "dub",
  "voice",
  "chs",
  "cht",
  "sc",
  "tc",
  "eng",
  "jpn",
  "字幕",
  "音频",
  "音轨",
  "配音",
]);
const imageExtensions = new Set(["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff", "gif"]);

function stem(name: string) {
  const fileName = name.split(/[\\/]/).pop() ?? name;
  const dot = fileName.lastIndexOf(".");
  return (dot > 0 ? fileName.slice(0, dot) : fileName).normalize("NFKC").toLocaleLowerCase();
}

function nameParts(name: string) {
  const raw = stem(name);
  const withoutAuxiliarySuffix = raw.replace(
    /(?:[\s._-]*(?:audio|sound|subtitle|subtitles|sub|dub|voice|chs|cht|sc|tc|eng|jpn|字幕|音频|音轨|配音))+$/giu,
    "",
  );
  const tokens = withoutAuxiliarySuffix.match(/[\p{L}\p{N}]+/gu) ?? [];
  const meaningful = tokens.filter((token) => !auxiliaryTokens.has(token));
  return { raw, compact: meaningful.join(""), tokens: meaningful };
}

function editSimilarity(left: string, right: string) {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

export function mediaNameMatchScore(leftName: string, rightName: string) {
  const left = nameParts(leftName);
  const right = nameParts(rightName);
  if (left.raw === right.raw) return 1;
  if (left.compact && left.compact === right.compact) return 0.98;
  const leftTokens = new Set(left.tokens);
  const rightTokens = new Set(right.tokens);
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const tokenScore = union ? shared / union : 0;
  const compactScore = editSimilarity(left.compact, right.compact);
  const containsScore =
    left.compact.length >= 3 &&
    right.compact.length >= 3 &&
    (left.compact.includes(right.compact) || right.compact.includes(left.compact))
      ? Math.min(left.compact.length, right.compact.length) /
        Math.max(left.compact.length, right.compact.length)
      : 0;
  const baseScore = Math.max(compactScore, tokenScore * 0.92, containsScore * 0.96);
  const leftNumbers = left.compact.match(/\d+/g) ?? [];
  const rightNumbers = right.compact.match(/\d+/g) ?? [];
  if (
    leftNumbers.length > 0 &&
    rightNumbers.length > 0 &&
    leftNumbers.join(":") !== rightNumbers.join(":")
  ) {
    return Math.min(baseScore, 0.55);
  }
  if ((leftNumbers.length === 0) !== (rightNumbers.length === 0)) {
    return Math.min(baseScore, 0.65);
  }
  return baseScore;
}

function timeMatchScore(item: MediaBinItem, video: MediaBinItem) {
  const startDelta = Math.abs(item.start_time_us - video.start_time_us);
  const startScore = Math.exp(-startDelta / 5_000_000);
  const longestDuration = Math.max(item.duration_us, video.duration_us);
  const durationScore =
    longestDuration > 0
      ? 1 - Math.min(1, Math.abs(item.duration_us - video.duration_us) / longestDuration)
      : 0;
  const hasStartEvidence = item.start_time_us !== 0 || video.start_time_us !== 0;
  const hasDurationEvidence = item.duration_us > 0 && video.duration_us > 0;
  if (!hasStartEvidence && !hasDurationEvidence) return 0;
  if (!hasStartEvidence) return durationScore;
  if (!hasDurationEvidence) return startScore;
  return startScore * 0.6 + durationScore * 0.4;
}

function supportsType(item: MediaBinItem, type: MediaAutoBindType) {
  return (
    item.kind !== "video" &&
    (type === "all" ? item.kind === "audio" || item.kind === "subtitle" : item.kind === type)
  );
}

export function inferMediaAutoBindings(
  items: readonly MediaBinItem[],
  type: MediaAutoBindType,
  preference: MediaAutoBindPreference,
): MediaAutoBindingPair[] {
  const videos = items.filter((item) => {
    const extension = item.path.split(/[\\/]/).pop()?.split(".").pop()?.toLocaleLowerCase() ?? "";
    return item.kind === "video" && !imageExtensions.has(extension);
  });
  if (videos.length === 0) return [];
  return items.flatMap((item) => {
    if (!supportsType(item, type)) return [];
    const ranked = videos
      .map((video) => {
        const nameScore = mediaNameMatchScore(item.file_name, video.file_name);
        const timeScore = timeMatchScore(item, video);
        return {
          itemId: item.id,
          videoId: video.id,
          nameScore,
          timeScore,
          score: preference === "name" ? nameScore : nameScore * 0.8 + timeScore * 0.2,
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.nameScore - left.nameScore ||
          left.videoId.localeCompare(right.videoId),
      );
    const best = ranked[0];
    if (!best) return [];
    const accepted =
      preference === "name" ? best.nameScore >= 0.72 : best.nameScore >= 0.42 && best.score >= 0.5;
    return accepted ? [{ itemId: best.itemId, videoId: best.videoId, score: best.score }] : [];
  });
}

export function createVirtualBindingCopy(item: MediaBinItem) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return {
    ...item,
    id: `media-copy:${random}`,
    source_video_id: item.source_video_id ?? (item.kind === "audio" ? item.id : null),
    bound_to_video_id: null,
  } satisfies MediaBinItem;
}

export function prepareMediaAutoBindings(
  items: readonly MediaBinItem[],
  type: MediaAutoBindType,
  preset: MediaAutoBindPreset,
  preference: MediaAutoBindPreference,
) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const copies: MediaBinItem[] = [];
  const bindings = inferMediaAutoBindings(items, type, preference).flatMap((binding) => {
    const source = itemsById.get(binding.itemId);
    if (!source) return [];
    if (preset === "direct") return [binding];
    const copy = createVirtualBindingCopy(source);
    copies.push(copy);
    return [{ ...binding, itemId: copy.id }];
  });
  return { bindings, copies };
}
