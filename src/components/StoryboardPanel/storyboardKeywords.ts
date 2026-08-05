import { createElement, type ReactNode } from "react";
import type {
  StoryboardKeywordNode,
  StoryboardKeywordUsageCounters,
  StoryboardShotAnnotation,
} from "../../types";

export interface StoryboardKeywordPath {
  names: string[];
}

export interface StoryboardKeywordParseResult {
  paths: StoryboardKeywordPath[];
  error: string | null;
}

interface ResolvedStoryboardKeywords {
  keywordNodes: StoryboardKeywordNode[];
  keywordIds: string[];
}

const keywordSeparators = [">", "<", "|"] as const;
const keywordNameFilter = /[,，<>|*]/g;
let fallbackKeywordId = 0;

/** Removes characters that are forbidden inside keyword names (list separators, path separators, and the partial-applicability marker). */
export function sanitizeStoryboardKeywordName(name: string) {
  return name.replace(keywordNameFilter, "").trim();
}

function keywordPathKey(names: readonly string[]) {
  return names.join("\u0000");
}

function splitKeywordValues(keywords: string | Iterable<string>) {
  const values = typeof keywords === "string" ? [keywords] : Array.from(keywords);
  return values.flatMap((value) => value.split(/[,，]/));
}

function parseKeywordValue(value: string): StoryboardKeywordParseResult {
  const trimmed = value.trim();
  if (!trimmed) {
    return { paths: [], error: null };
  }

  const separators = keywordSeparators.filter((separator) => trimmed.includes(separator));
  if (separators.length > 1) {
    return {
      paths: [],
      error: `关键字路径“${trimmed}”不能混用 >、<、| 分隔符`,
    };
  }

  const separator = separators[0];
  const names = (separator ? trimmed.split(separator) : [trimmed]).map((name) =>
    sanitizeStoryboardKeywordName(name),
  );
  if (names.some((name) => !name)) {
    return {
      paths: [],
      error: `关键字路径“${trimmed}”包含空的关键字名称`,
    };
  }

  return {
    paths: [{ names: separator === "<" ? names.reverse() : names }],
    error: null,
  };
}

export function parseStoryboardKeywordInput(
  keywords: string | Iterable<string>,
): StoryboardKeywordParseResult {
  const paths: StoryboardKeywordPath[] = [];
  const seen = new Set<string>();
  for (const value of splitKeywordValues(keywords)) {
    const result = parseKeywordValue(value);
    if (result.error) {
      return result;
    }
    for (const path of result.paths) {
      const key = keywordPathKey(path.names);
      if (!seen.has(key)) {
        seen.add(key);
        paths.push(path);
      }
    }
  }
  return { paths, error: null };
}

export function formatStoryboardKeywordPath(path: StoryboardKeywordPath) {
  return [...path.names].reverse().join("<");
}

export function formatParsedStoryboardKeywords(paths: readonly StoryboardKeywordPath[]) {
  return paths.map(formatStoryboardKeywordPath).sort().join(", ");
}

function nextKeywordId() {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) {
    return `keyword:${random}`;
  }
  fallbackKeywordId += 1;
  return `keyword:${Date.now()}:${fallbackKeywordId}`;
}

function siblingKey(parentId: string | null, name: string) {
  return `${parentId ?? ""}\u0000${name}`;
}

export function resolveStoryboardKeywordPaths(
  currentNodes: readonly StoryboardKeywordNode[],
  paths: readonly StoryboardKeywordPath[],
): ResolvedStoryboardKeywords {
  const keywordNodes = [...currentNodes];
  const nodesBySibling = new Map<string, StoryboardKeywordNode>();
  for (const node of keywordNodes) {
    const key = siblingKey(node.parentId ?? null, node.name);
    if (!nodesBySibling.has(key)) {
      nodesBySibling.set(key, node);
    }
  }

  const keywordIds: string[] = [];
  const activated = new Set<string>();
  for (const path of paths) {
    let parentId: string | null = null;
    for (const name of path.names) {
      const key = siblingKey(parentId, name);
      let node = nodesBySibling.get(key);
      if (!node) {
        node = { id: nextKeywordId(), name, parentId };
        keywordNodes.push(node);
        nodesBySibling.set(key, node);
      }
      parentId = node.id;
    }
    if (parentId && !activated.has(parentId)) {
      activated.add(parentId);
      keywordIds.push(parentId);
    }
  }
  return { keywordNodes, keywordIds };
}

export function normalizeStoryboardKeywordIds(keywordIds: Iterable<string>) {
  return Array.from(new Set(keywordIds));
}

interface EnsuredStoryboardKeywordNode {
  keywordNodes: StoryboardKeywordNode[];
  keywordId: string;
}

export function ensureStoryboardKeywordNode(
  currentNodes: StoryboardKeywordNode[],
  name: string,
  parentId: string | null,
  synonyms: readonly string[] = [],
): EnsuredStoryboardKeywordNode {
  const existing = currentNodes.find(
    (node) => (node.parentId ?? null) === parentId && node.name === name,
  );
  if (existing) {
    const currentSynonyms = existing.synonyms ?? [];
    const mergedSynonyms = Array.from(new Set([...currentSynonyms, ...synonyms]));
    if (mergedSynonyms.length === currentSynonyms.length) {
      return { keywordNodes: currentNodes, keywordId: existing.id };
    }
    return {
      keywordNodes: currentNodes.map((node) =>
        node.id === existing.id ? { ...node, synonyms: mergedSynonyms } : node,
      ),
      keywordId: existing.id,
    };
  }
  const node: StoryboardKeywordNode = {
    id: nextKeywordId(),
    name,
    parentId,
    ...(synonyms.length > 0 ? { synonyms: [...synonyms] } : {}),
  };
  return { keywordNodes: [...currentNodes, node], keywordId: node.id };
}

export function storyboardKeywordPathForId(
  keywordId: string,
  keywordNodes: readonly StoryboardKeywordNode[],
) {
  const nodesById = new Map(keywordNodes.map((node) => [node.id, node]));
  const names: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = keywordId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = nodesById.get(currentId);
    if (!node) {
      return null;
    }
    names.push(node.name);
    currentId = node.parentId ?? null;
  }
  return currentId ? null : names;
}

export function visibleStoryboardKeywordIds(
  keywordIds: Iterable<string> | null | undefined,
  _keywordNodes: readonly StoryboardKeywordNode[],
) {
  return normalizeStoryboardKeywordIds(keywordIds ?? []);
}

export function storyboardEffectiveKeywordIds(
  keywordIds: Iterable<string> | null | undefined,
  keywordNodes: readonly StoryboardKeywordNode[],
) {
  const nodesById = new Map(keywordNodes.map((node) => [node.id, node]));
  const effectiveIds = new Set<string>();
  for (const keywordId of normalizeStoryboardKeywordIds(keywordIds ?? [])) {
    const visited = new Set<string>();
    let currentId: string | null = keywordId;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const node = nodesById.get(currentId);
      if (!node) {
        break;
      }
      effectiveIds.add(currentId);
      currentId = node.parentId ?? null;
    }
  }
  return effectiveIds;
}

export function storyboardKeywordDescendantIds(
  keywordId: string,
  keywordNodes: readonly StoryboardKeywordNode[],
) {
  const childIdsByParent = new Map<string, string[]>();
  for (const node of keywordNodes) {
    if (!node.parentId) {
      continue;
    }
    const childIds = childIdsByParent.get(node.parentId) ?? [];
    childIds.push(node.id);
    childIdsByParent.set(node.parentId, childIds);
  }
  const descendantIds = new Set<string>([keywordId]);
  const pendingIds = [keywordId];
  while (pendingIds.length > 0) {
    const currentId = pendingIds.pop()!;
    for (const childId of childIdsByParent.get(currentId) ?? []) {
      if (!descendantIds.has(childId)) {
        descendantIds.add(childId);
        pendingIds.push(childId);
      }
    }
  }
  return descendantIds;
}

export function storyboardKeywordLabel(
  keywordId: string,
  keywordNodes: readonly StoryboardKeywordNode[],
) {
  return storyboardKeywordPathForId(keywordId, keywordNodes)?.join("<") ?? "";
}

export function expandedStoryboardKeywordText(
  keywordIds: Iterable<string> | null | undefined,
  keywordNodes: readonly StoryboardKeywordNode[],
) {
  const chains = normalizeStoryboardKeywordIds(keywordIds ?? [])
    .map((keywordId) => storyboardKeywordPathForId(keywordId, keywordNodes))
    .filter((path): path is string[] => path !== null);
  const entries = new Set<string>();
  for (const chain of chains) {
    const isAncestorOfAnother = chains.some(
      (otherChain) =>
        otherChain.length > chain.length &&
        chain.every((name, index) => otherChain[index] === name),
    );
    if (isAncestorOfAnother) {
      continue;
    }
    for (let start = 0; start < chain.length; start += 1) {
      entries.add(chain.slice(start).join("<"));
    }
  }
  return Array.from(entries)
    .sort((left, right) => left.localeCompare(right, "zh-CN"))
    .join(", ");
}

export function sanitizeStoryboardKeywordInput(value: string) {
  const values = splitKeywordValues(value);
  const sanitized: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const separators = keywordSeparators.filter((separator) => trimmed.includes(separator));
    if (separators.length === 0) {
      const name = sanitizeStoryboardKeywordName(trimmed);
      if (name) {
        sanitized.push(name);
      }
      continue;
    }
    const separator = separators[0];
    const names = trimmed
      .split(separator)
      .map((name) => sanitizeStoryboardKeywordName(name))
      .filter(Boolean);
    if (names.length > 0) {
      sanitized.push(names.join(separator));
    }
  }
  return sanitized.join(", ");
}

export function renderStoryboardKeywordLabel(label: string): ReactNode {
  if (!label.includes("<")) {
    return label;
  }
  const parts = label.split("<");
  return parts.map((part, index) =>
    createElement(
      "span",
      { key: index },
      part,
      index < parts.length - 1
        ? createElement("span", { key: "sep", className: "storyboard-keyword-separator" }, " < ")
        : null,
    ),
  );
}

export function storyboardKeywordUsageCounts(
  keywordNodes: readonly StoryboardKeywordNode[],
  shotAnnotations: Readonly<Record<string, StoryboardShotAnnotation>>,
  shotIds: Iterable<string> = Object.keys(shotAnnotations),
) {
  const usageCounts = new Map<string, number>();
  for (const shotId of shotIds) {
    const annotation = shotAnnotations[shotId];
    if (!annotation) {
      continue;
    }
    for (const keywordId of storyboardEffectiveKeywordIds(annotation.keywordIds, keywordNodes)) {
      usageCounts.set(keywordId, (usageCounts.get(keywordId) ?? 0) + 1);
    }
  }
  return usageCounts;
}

const keywordUsageCounterDecayThreshold = 100;

export function storyboardKeywordUsageCountersAfterUse(
  current: StoryboardKeywordUsageCounters | null | undefined,
  usedIds: Iterable<string>,
): StoryboardKeywordUsageCounters {
  const used = normalizeStoryboardKeywordIds(usedIds);
  if (used.length === 0) {
    return current ?? { counts: {}, total: 0 };
  }
  const counts = { ...(current?.counts ?? {}) };
  let total = current?.total ?? 0;
  for (const keywordId of used) {
    counts[keywordId] = (counts[keywordId] ?? 0) + 1;
    total += 1;
  }
  if (total >= keywordUsageCounterDecayThreshold) {
    for (const keywordId of Object.keys(counts)) {
      const halved = Math.floor(counts[keywordId] / 2);
      if (halved > 0) {
        counts[keywordId] = halved;
      } else {
        delete counts[keywordId];
      }
    }
    total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  }
  return { counts, total };
}

export function storyboardKeywordRealUsageCounts(
  shotAnnotations: Readonly<Record<string, StoryboardShotAnnotation>>,
  shotIds: Iterable<string> = Object.keys(shotAnnotations),
) {
  const usageCounts = new Map<string, number>();
  for (const shotId of shotIds) {
    const annotation = shotAnnotations[shotId];
    if (!annotation) {
      continue;
    }
    for (const keywordId of normalizeStoryboardKeywordIds(annotation.keywordIds ?? [])) {
      usageCounts.set(keywordId, (usageCounts.get(keywordId) ?? 0) + 1);
    }
  }
  return usageCounts;
}

function ascendingKeywordRanks(
  keywordIds: Iterable<string>,
  valueOf: (keywordId: string) => number,
) {
  const sorted = Array.from(keywordIds).sort((left, right) => {
    const valueDiff = valueOf(left) - valueOf(right);
    return valueDiff !== 0 ? valueDiff : left.localeCompare(right, "zh-CN");
  });
  const ranks = new Map<string, number>();
  let previousValue: number | null = null;
  let currentRank = 0;
  for (const [index, keywordId] of sorted.entries()) {
    const value = valueOf(keywordId);
    if (value !== previousValue) {
      previousValue = value;
      currentRank = index + 1;
    }
    ranks.set(keywordId, currentRank);
  }
  return ranks;
}

export function suggestedStoryboardKeywordIds(
  keywordUsageCounters: StoryboardKeywordUsageCounters | null | undefined,
  keywordNodes: readonly StoryboardKeywordNode[],
  shotAnnotations: Readonly<Record<string, StoryboardShotAnnotation>>,
  shotIds: Iterable<string> = Object.keys(shotAnnotations),
  excludedKeywordIds: ReadonlySet<string> = new Set(),
  limit = 18,
) {
  const validIds = new Set(keywordNodes.map((node) => node.id));
  const realUsageCounts = storyboardKeywordRealUsageCounts(shotAnnotations, shotIds);
  const counters = keywordUsageCounters?.counts ?? {};
  const counterOf = (keywordId: string) => counters[keywordId] ?? 0;
  const counterRanks = ascendingKeywordRanks(validIds, counterOf);
  const usageRanks = ascendingKeywordRanks(
    validIds,
    (keywordId) => realUsageCounts.get(keywordId) ?? 0,
  );
  return Array.from(validIds)
    .filter((keywordId) => !excludedKeywordIds.has(keywordId))
    .filter((keywordId) => counterOf(keywordId) > 0 || (realUsageCounts.get(keywordId) ?? 0) > 0)
    .sort((left, right) => {
      const leftScore = counterRanks.get(left)! * 2 + usageRanks.get(left)!;
      const rightScore = counterRanks.get(right)! * 2 + usageRanks.get(right)!;
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      const counterDiff = counterOf(right) - counterOf(left);
      if (counterDiff !== 0) {
        return counterDiff;
      }
      const usageDiff = (realUsageCounts.get(right) ?? 0) - (realUsageCounts.get(left) ?? 0);
      if (usageDiff !== 0) {
        return usageDiff;
      }
      return left.localeCompare(right, "zh-CN");
    })
    .slice(0, limit);
}

export function formatStoryboardKeywords(
  keywordIds: Iterable<string> | null | undefined,
  keywordNodes: readonly StoryboardKeywordNode[],
) {
  return visibleStoryboardKeywordIds(keywordIds, keywordNodes)
    .map((keywordId) => storyboardKeywordLabel(keywordId, keywordNodes))
    .filter(Boolean)
    .sort()
    .join(", ");
}

export function storyboardKeywordSearchValues(
  keywordIds: Iterable<string> | null | undefined,
  keywordNodes: readonly StoryboardKeywordNode[],
) {
  const nodesById = new Map(keywordNodes.map((node) => [node.id, node]));
  const values = new Set<string>();
  for (const keywordId of normalizeStoryboardKeywordIds(keywordIds ?? [])) {
    const path = storyboardKeywordPathForId(keywordId, keywordNodes);
    if (!path) {
      continue;
    }
    values.add(path.join("<"));
    for (const name of path) {
      values.add(name);
    }
    const visited = new Set<string>();
    let currentId: string | null = keywordId;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const node = nodesById.get(currentId);
      if (!node) {
        break;
      }
      for (const synonym of node.synonyms ?? []) {
        if (synonym) {
          values.add(synonym);
        }
      }
      currentId = node.parentId ?? null;
    }
  }
  return Array.from(values);
}
