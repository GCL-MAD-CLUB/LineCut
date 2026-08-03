import type { StoryboardKeywordNode } from "../../types";

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

function keywordPathForId(
  keywordId: string,
  nodesById: ReadonlyMap<string, StoryboardKeywordNode>,
) {
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

function visibleKeywordIds(
  keywordIds: Iterable<string> | null | undefined,
  nodesById: ReadonlyMap<string, StoryboardKeywordNode>,
) {
  const activated = new Set(normalizeStoryboardKeywordIds(keywordIds ?? []));
  const hiddenAncestors = new Set<string>();
  for (const keywordId of activated) {
    const visited = new Set<string>();
    let parentId = nodesById.get(keywordId)?.parentId ?? null;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      if (activated.has(parentId)) {
        hiddenAncestors.add(parentId);
      }
      parentId = nodesById.get(parentId)?.parentId ?? null;
    }
  }
  return Array.from(activated).filter((keywordId) => !hiddenAncestors.has(keywordId));
}

export function formatStoryboardKeywords(
  keywordIds: Iterable<string> | null | undefined,
  keywordNodes: readonly StoryboardKeywordNode[],
) {
  const nodesById = new Map(keywordNodes.map((node) => [node.id, node]));
  return visibleKeywordIds(keywordIds, nodesById)
    .map((keywordId) => keywordPathForId(keywordId, nodesById)?.join("<") ?? "")
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
    const path = keywordPathForId(keywordId, nodesById);
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
