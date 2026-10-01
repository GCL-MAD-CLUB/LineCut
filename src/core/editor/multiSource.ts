import type { StoryboardState, SubtitleState } from "../../types";

export interface PanelRowSource {
  context: string;
  name: string;
  assetId: string;
  fingerprint: string;
  videoPath: string;
  previewVideoPath: string;
  frameRate: number;
}

// These keys exist only in panel state. Persisted rows retain their original IDs.
const scopePrefix = "@sources:";
const rowPrefix = "@row:";
export function sourceScope(contexts: readonly string[]) {
  const unique = [...new Set(contexts)].sort();
  return unique.length === 1 ? unique[0] : scopePrefix + JSON.stringify(unique);
}
export function sourceContexts(scope: string): string[] {
  return scope.startsWith(scopePrefix)
    ? JSON.parse(scope.slice(scopePrefix.length))
    : scope
      ? [scope]
      : [];
}
export function sourceRowId(context: string, id: string) {
  return `${rowPrefix}${JSON.stringify([context, id])}`;
}
export function sourceRowParts(id: string): [string, string] | null {
  if (!id.startsWith(rowPrefix)) return null;
  try {
    const parts = JSON.parse(id.slice(rowPrefix.length));
    return Array.isArray(parts) &&
      parts.length === 2 &&
      parts.every((part) => typeof part === "string")
      ? [parts[0], parts[1]]
      : null;
  } catch {
    return null;
  }
}

export function emptyStoryboard(): StoryboardState {
  return {
    shots: [],
    shotStacks: [],
    keywordNodes: [],
    recentKeywordIds: [],
    keywordUsageCounters: { counts: {}, total: 0 },
    shotAnnotations: {},
  };
}

export function scopedSubtitles(
  subtitles: Record<string, SubtitleState>,
  scope: string,
): SubtitleState {
  const contexts = sourceContexts(scope);
  if (contexts.length === 1) return subtitles[contexts[0]] ?? { cueAnnotations: {} };
  return {
    cueAnnotations: Object.fromEntries(
      contexts.flatMap((context) =>
        Object.entries(subtitles[context]?.cueAnnotations ?? {}).map(([id, annotation]) => [
          sourceRowId(context, id),
          annotation,
        ]),
      ),
    ),
  };
}

export function updateScopedSubtitles(
  subtitles: Record<string, SubtitleState>,
  scope: string,
  recipe: (current: SubtitleState) => SubtitleState,
) {
  const current = scopedSubtitles(subtitles, scope);
  const next = recipe(current);
  if (next === current) return subtitles;
  const contexts = sourceContexts(scope);
  return {
    ...subtitles,
    ...Object.fromEntries(
      contexts.map((context) => [
        context,
        contexts.length === 1
          ? next
          : {
              cueAnnotations: Object.fromEntries(
                Object.entries(next.cueAnnotations).flatMap(([id, annotation]) => {
                  const parts = sourceRowParts(id);
                  return parts?.[0] === context ? [[parts[1], annotation]] : [];
                }),
              ),
            },
      ]),
    ),
  };
}

export function mapStoryboardRows(
  board: StoryboardState,
  mapId: (id: string) => string,
): StoryboardState {
  return {
    ...board,
    shots: board.shots.map((shot) => ({ ...shot, id: mapId(shot.id) })),
    deletedShots: board.deletedShots?.map((shot) => ({ ...shot, id: mapId(shot.id) })),
    shotStacks: board.shotStacks.map((stack) => ({
      id: mapId(stack.id),
      shotIds: stack.shotIds.map(mapId),
    })),
    shotAnnotations: Object.fromEntries(
      Object.entries(board.shotAnnotations).map(([id, annotation]) => [mapId(id), annotation]),
    ),
  };
}

/** Apply timeline edits independently; frame zero belongs to each source, not the combined list. */
export function transformStoryboardSources(
  current: StoryboardState,
  transform: (local: StoryboardState) => StoryboardState,
): StoryboardState {
  const sources = [
    ...new Set(
      [...current.shots, ...(current.deletedShots ?? [])].map(
        (shot) => sourceRowParts(shot.id)?.[0],
      ),
    ),
  ];
  if (sources.length <= 1) return transform(current);
  let changed = false;
  const locals = sources.map((source) => {
    const belongs = (id: string) => sourceRowParts(id)?.[0] === source;
    const local = {
      ...current,
      shots: current.shots.filter((shot) => belongs(shot.id)),
      deletedShots: current.deletedShots?.filter((shot) => belongs(shot.id)),
      shotStacks: current.shotStacks.filter((stack) => belongs(stack.id)),
      shotAnnotations: Object.fromEntries(
        Object.entries(current.shotAnnotations).filter(([id]) => belongs(id)),
      ),
    };
    const next = transform(local);
    changed ||= next !== local;
    return next;
  });
  return changed
    ? {
        ...current,
        shots: locals.flatMap((local) => local.shots),
        deletedShots: locals.flatMap((local) => local.deletedShots ?? []),
        shotStacks: locals.flatMap((local) => local.shotStacks),
        shotAnnotations: Object.assign({}, ...locals.map((local) => local.shotAnnotations)),
      }
    : current;
}

// A project-wide catalog is stored alongside storyboards so existing persistence and history
// round-trip it atomically. It never owns shots and cannot be selected as a media source.
export const projectKeywordContext = "@project-keywords";
export interface ScopedStoryboardState extends StoryboardState {
  libraryKeywordNodes: StoryboardState["keywordNodes"];
}

export function normalizedStoryboardKeywords(boards: Record<string, StoryboardState>) {
  const catalog = emptyStoryboard();
  const byPath = new Map<string, string>();
  const result: Record<string, StoryboardState> = {};
  const entries = Object.entries(boards).sort(([a], [b]) =>
    a === projectKeywordContext ? -1 : b === projectKeywordContext ? 1 : a.localeCompare(b),
  );
  for (const [context, board] of entries) {
    const nodes = new Map(board.keywordNodes.map((node) => [node.id, node]));
    const remap = new Map<string, string>();
    const visiting = new Set<string>();
    const resolve = (id: string): string | null => {
      if (remap.has(id)) return remap.get(id)!;
      const node = nodes.get(id);
      if (!node || visiting.has(id)) return null;
      visiting.add(id);
      const parentId = node.parentId ? resolve(node.parentId) : null;
      const key = JSON.stringify([parentId, node.name]);
      let canonical = byPath.get(key);
      if (!canonical) {
        canonical = catalog.keywordNodes.some((other) => other.id === id)
          ? `keyword:${JSON.stringify([context, id])}`
          : id;
        byPath.set(key, canonical);
        catalog.keywordNodes.push({ ...node, id: canonical, parentId });
      } else {
        const existing = catalog.keywordNodes.find((other) => other.id === canonical)!;
        existing.synonyms = [...new Set([...(existing.synonyms ?? []), ...(node.synonyms ?? [])])];
      }
      remap.set(id, canonical);
      visiting.delete(id);
      return canonical;
    };
    for (const node of board.keywordNodes) resolve(node.id);
    const ids = (values: readonly string[]) => [
      ...new Set(values.flatMap((id) => remap.get(id) ?? [])),
    ];
    const recent = ids(board.recentKeywordIds);
    catalog.recentKeywordIds = [...new Set([...catalog.recentKeywordIds, ...recent])];
    // Once a catalog exists its counters are authoritative, avoiding multiplication by media count.
    if (context === projectKeywordContext || !boards[projectKeywordContext]) {
      for (const [id, count] of Object.entries(board.keywordUsageCounters?.counts ?? {})) {
        const mapped = remap.get(id);
        if (mapped)
          catalog.keywordUsageCounters!.counts[mapped] =
            (catalog.keywordUsageCounters!.counts[mapped] ?? 0) + count;
      }
      catalog.keywordUsageCounters!.total += board.keywordUsageCounters?.total ?? 0;
    }
    result[context] = {
      ...board,
      keywordNodes: ids(board.keywordNodes.map((node) => node.id)).map((id) =>
        catalog.keywordNodes.find((node) => node.id === id)!,
      ),
      recentKeywordIds: context === projectKeywordContext ? recent : [],
      keywordUsageCounters:
        context === projectKeywordContext ? board.keywordUsageCounters : { counts: {}, total: 0 },
      shotAnnotations: Object.fromEntries(
        Object.entries(board.shotAnnotations).map(([id, annotation]) => [
          id,
          { ...annotation, keywordIds: ids(annotation.keywordIds ?? []) },
        ]),
      ),
    };
  }
  result[projectKeywordContext] = catalog;
  return result;
}

export function scopedStoryboard(
  boards: Record<string, StoryboardState>,
  scope: string,
): ScopedStoryboardState {
  const contexts = sourceContexts(scope);
  const normalized = normalizedStoryboardKeywords(boards);
  const catalog = normalized[projectKeywordContext];
  const selected = contexts.map((context) => normalized[context] ?? emptyStoryboard());
  const libraryIds = new Set(
    selected.flatMap((board) => board.keywordNodes.map((node) => node.id)),
  );
  const rows = selected.map((board, index) =>
    contexts.length > 1
      ? mapStoryboardRows(board, (id) => sourceRowId(contexts[index], id))
      : board,
  );
  return {
    ...catalog,
    libraryKeywordNodes: catalog.keywordNodes.filter((node) => libraryIds.has(node.id)),
    shots: rows.flatMap((board) => board.shots),
    deletedShots: rows.flatMap((board) => board.deletedShots ?? []),
    shotStacks: rows.flatMap((board) => board.shotStacks),
    shotAnnotations: Object.assign({}, ...rows.map((board) => board.shotAnnotations)),
  };
}

export function updateScopedStoryboard(
  boards: Record<string, StoryboardState>,
  scope: string,
  recipe: (current: StoryboardState) => StoryboardState,
) {
  const current = scopedStoryboard(boards, scope);
  const next = recipe(current);
  if (next === current) return boards;
  const normalized = normalizedStoryboardKeywords(boards);
  const contexts = sourceContexts(scope);
  const catalog = {
    ...emptyStoryboard(),
    keywordNodes: next.keywordNodes,
    recentKeywordIds: next.recentKeywordIds,
    keywordUsageCounters: next.keywordUsageCounters,
  };
  const allowed = new Set(next.keywordNodes.map((node) => node.id));
  const libraryIds = new Set(
    contexts.flatMap((context) => normalized[context]?.keywordNodes.map((node) => node.id) ?? []),
  );
  for (const node of (next as Partial<ScopedStoryboardState>).libraryKeywordNodes ?? [])
    libraryIds.add(node.id);
  const previousIds = new Set(current.keywordNodes.map((node) => node.id));
  for (const node of next.keywordNodes) {
    if (
      !previousIds.has(node.id) ||
      (next.keywordUsageCounters?.counts[node.id] ?? 0) >
        (current.keywordUsageCounters?.counts[node.id] ?? 0)
    )
      libraryIds.add(node.id);
  }
  for (const annotation of Object.values(next.shotAnnotations)) {
    for (const id of annotation.keywordIds ?? []) libraryIds.add(id);
  }
  const nodesById = new Map(next.keywordNodes.map((node) => [node.id, node]));
  for (const id of libraryIds) {
    const parent = nodesById.get(id)?.parentId;
    if (parent) libraryIds.add(parent);
  }
  const result: Record<string, StoryboardState> = Object.fromEntries(
    Object.entries(normalized).map(([context, board]) => [
      context,
      {
        ...board,
        keywordNodes: next.keywordNodes.filter((node) =>
          board.keywordNodes.some((old) => old.id === node.id),
        ),
        recentKeywordIds: [],
        keywordUsageCounters: { counts: {}, total: 0 },
        shotAnnotations: Object.fromEntries(
          Object.entries(board.shotAnnotations).map(([id, annotation]) => [
            id,
            { ...annotation, keywordIds: annotation.keywordIds?.filter((id) => allowed.has(id)) },
          ]),
        ),
      },
    ]),
  );
  for (const context of contexts) {
    const belongs = (id: string) => contexts.length === 1 || sourceRowParts(id)?.[0] === context;
    const board: StoryboardState = {
      keywordNodes: next.keywordNodes.filter((node) => libraryIds.has(node.id)),
      recentKeywordIds: [],
      keywordUsageCounters: { counts: {}, total: 0 },
      shots: next.shots.filter((shot) => belongs(shot.id)),
      deletedShots: next.deletedShots?.filter((shot) => belongs(shot.id)),
      shotStacks: next.shotStacks.filter((stack) => stack.shotIds.every(belongs)),
      shotAnnotations: Object.fromEntries(
        Object.entries(next.shotAnnotations).filter(([id]) => belongs(id)),
      ),
    };
    result[context] =
      contexts.length > 1 ? mapStoryboardRows(board, (id) => sourceRowParts(id)![1]) : board;
  }
  result[projectKeywordContext] = catalog;
  return result;
}

/** Stable source groups; equal display names still remain separate media groups. */
export function sortBySource<T>(
  rows: readonly T[],
  source: (row: T) => { name: string; context: string },
  direction: "ascending" | "descending",
) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const sign = direction === "ascending" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = source(a),
      right = source(b);
    return (
      sign * (collator.compare(left.name, right.name) || left.context.localeCompare(right.context))
    );
  });
}
