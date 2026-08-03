import { createElement, type ReactNode } from "react";
import type { StoryboardKeywordNode, StoryboardShotAnnotation } from "../../types";

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
let fallbackKeywordId = 0;

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
  const names = (separator ? trimmed.split(separator) : [trimmed]).map((name) => name.trim());
  if (names.some((name) => !name)) {
    return {
      paths: [],
      error: `关键字路径“${trimmed}”包含空的关键字名称`,
    };
  }
  if (names.some((name) => /[<>|]/.test(name))) {
    return {
      paths: [],
      error: "关键字名称不能包含 >、<、|",
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
      const name = trimmed.replace(/[<>|]/g, "").trim();
      if (name) {
        sanitized.push(name);
      }
      continue;
    }
    const separator = separators[0];
    const names = trimmed
      .split(separator)
      .map((name) => name.replace(/[<>|]/g, "").trim())
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

export function suggestedStoryboardKeywordIds(
  recentKeywordIds: readonly string[],
  keywordNodes: readonly StoryboardKeywordNode[],
  shotAnnotations: Readonly<Record<string, StoryboardShotAnnotation>>,
  shotIds: Iterable<string> = Object.keys(shotAnnotations),
  limit = 18,
) {
  const validIds = new Set(keywordNodes.map((node) => node.id));
  const candidates = Array.from(new Set(recentKeywordIds))
    .filter((keywordId) => validIds.has(keywordId))
    .slice(0, limit);
  const recentRank = new Map(candidates.map((keywordId, index) => [keywordId, index + 1]));
  const usageCounts = storyboardKeywordUsageCounts(keywordNodes, shotAnnotations, shotIds);
  const byUsage = [...candidates].sort(
    (left, right) =>
      (usageCounts.get(right) ?? 0) - (usageCounts.get(left) ?? 0) ||
      candidates.indexOf(left) - candidates.indexOf(right),
  );
  const usageRank = new Map<string, number>();
  let previousCount: number | null = null;
  for (const [index, keywordId] of byUsage.entries()) {
    const count = usageCounts.get(keywordId) ?? 0;
    if (count !== previousCount) {
      previousCount = count;
      usageRank.set(keywordId, index + 1);
    } else {
      usageRank.set(keywordId, usageRank.get(byUsage[index - 1])!);
    }
  }
  return [...candidates].sort((left, right) => {
    const leftRecentRank = recentRank.get(left)!;
    const rightRecentRank = recentRank.get(right)!;
    const leftAverageRank = ((usageRank.get(left) ?? limit) + leftRecentRank) / 2;
    const rightAverageRank = ((usageRank.get(right) ?? limit) + rightRecentRank) / 2;
    return leftAverageRank - rightAverageRank || leftRecentRank - rightRecentRank;
  });
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
  }
  return Array.from(values);
}
