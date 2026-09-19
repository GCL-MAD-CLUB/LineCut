import type { MediaBinItem } from "../../types";

export type MediaAutoBindType = "all" | "audio" | "subtitle";
export type MediaAutoBindPreset = "direct" | "virtual-copy";
export type MediaAutoBindPreference = "smart" | "name";

export interface MediaAutoBindingPair {
  itemId: string;
  videoId: string;
  score: number;
}

export type MediaAutoBindingProgress = (completed: number, total: number) => void;

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

interface MediaNameParts {
  raw: string;
  compact: string;
  tokens: Set<string>;
  numbers: string;
}

function nameParts(name: string): MediaNameParts {
  const raw = stem(name);
  const withoutAuxiliarySuffix = raw.replace(
    /(?:[\s._-]*(?:audio|sound|subtitle|subtitles|sub|dub|voice|chs|cht|sc|tc|eng|jpn|字幕|音频|音轨|配音))+$/giu,
    "",
  );
  const tokens = withoutAuxiliarySuffix.match(/[\p{L}\p{N}]+/gu) ?? [];
  const meaningful = tokens.filter((token) => !auxiliaryTokens.has(token));
  const compact = meaningful.join("");
  return {
    raw,
    compact,
    tokens: new Set(meaningful),
    numbers: (compact.match(/\d+/g) ?? []).join(":"),
  };
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

function preparedMediaNameMatchScore(left: MediaNameParts, right: MediaNameParts) {
  if (left.raw === right.raw) return 1;
  if (left.compact && left.compact === right.compact) return 0.98;
  let shared = 0;
  for (const token of left.tokens) {
    if (right.tokens.has(token)) shared += 1;
  }
  const union = left.tokens.size + right.tokens.size - shared;
  const tokenScore = union ? shared / union : 0;
  const containsScore =
    left.compact.length >= 3 &&
    right.compact.length >= 3 &&
    (left.compact.includes(right.compact) || right.compact.includes(left.compact))
      ? Math.min(left.compact.length, right.compact.length) /
        Math.max(left.compact.length, right.compact.length)
      : 0;
  const cheapScore = Math.max(tokenScore * 0.92, containsScore * 0.96);
  const numberCap =
    left.numbers && right.numbers && left.numbers !== right.numbers
      ? 0.55
      : Boolean(left.numbers) !== Boolean(right.numbers)
        ? 0.65
        : null;
  if (numberCap !== null && cheapScore >= numberCap) {
    return numberCap;
  }
  const baseScore = Math.max(editSimilarity(left.compact, right.compact), cheapScore);
  return numberCap === null ? baseScore : Math.min(baseScore, numberCap);
}

export function mediaNameMatchScore(leftName: string, rightName: string) {
  return preparedMediaNameMatchScore(nameParts(leftName), nameParts(rightName));
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
  onProgress?: MediaAutoBindingProgress,
): MediaAutoBindingPair[] {
  const videos = items.flatMap((item) => {
    const extension = item.path.split(/[\\/]/).pop()?.split(".").pop()?.toLocaleLowerCase() ?? "";
    return item.kind === "video" && !imageExtensions.has(extension)
      ? [{ item, name: nameParts(item.file_name) }]
      : [];
  });
  const candidates = items.filter((item) => supportsType(item, type));
  if (videos.length === 0 || candidates.length === 0) {
    onProgress?.(candidates.length, candidates.length);
    return [];
  }

  const bindings: MediaAutoBindingPair[] = [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const item = candidates[candidateIndex];
    const itemName = nameParts(item.file_name);
    let best:
      | (MediaAutoBindingPair & {
          nameScore: number;
        })
      | undefined;
    for (const video of videos) {
      const nameScore = preparedMediaNameMatchScore(itemName, video.name);
      const score =
        preference === "name"
          ? nameScore
          : nameScore * 0.8 + timeMatchScore(item, video.item) * 0.2;
      if (
        !best ||
        score > best.score ||
        (score === best.score && nameScore > best.nameScore) ||
        (score === best.score &&
          nameScore === best.nameScore &&
          video.item.id.localeCompare(best.videoId) < 0)
      ) {
        best = { itemId: item.id, videoId: video.item.id, nameScore, score };
      }
    }
    if (!best) continue;
    const accepted =
      preference === "name" ? best.nameScore >= 0.72 : best.nameScore >= 0.42 && best.score >= 0.5;
    if (accepted) {
      bindings.push({ itemId: best.itemId, videoId: best.videoId, score: best.score });
    }
    onProgress?.(candidateIndex + 1, candidates.length);
  }
  return bindings;
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
  onProgress?: MediaAutoBindingProgress,
) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const copies: MediaBinItem[] = [];
  const bindings = inferMediaAutoBindings(items, type, preference, onProgress).flatMap(
    (binding) => {
      const source = itemsById.get(binding.itemId);
      if (!source) return [];
      if (preset === "direct") return [binding];
      const copy = createVirtualBindingCopy(source);
      copies.push(copy);
      return [{ ...binding, itemId: copy.id }];
    },
  );
  return { bindings, copies };
}
