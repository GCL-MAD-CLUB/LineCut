import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyStoryboard,
  normalizedStoryboardKeywords,
  projectKeywordContext,
  scopedStoryboard,
  scopedSubtitles,
  sortBySource,
  nextSourceSortDirection,
  sourceContexts,
  sourceRowId,
  sourceRowParts,
  sourceScope,
  updateScopedStoryboard,
  updateScopedSubtitles,
} from "../src/core/editor/multiSource.ts";

function board(keywordId, name) {
  return {
    ...emptyStoryboard(),
    shots: [1, 2].map((sequence) => ({
      id: `shot-${sequence}`,
      sequence,
      start_frame: (sequence - 1) * 24,
      end_frame: sequence * 24 - 1,
      start_us: (sequence - 1) * 1_000_000,
      end_us: sequence * 1_000_000 - 1,
    })),
    keywordNodes: [{ id: keywordId, name, parentId: null }],
    recentKeywordIds: [keywordId],
    keywordUsageCounters: { counts: { [keywordId]: 2 }, total: 2 },
    shotAnnotations: { "shot-1": { rating: 1, retained: false, keywordIds: [keywordId] } },
  };
}

test("scope and row identities are unambiguous and independent of selection order", () => {
  assert.equal(sourceScope(["b", "a", "a"]), sourceScope(["a", "b"]));
  assert.equal(sourceScope(["a"]), "a");
  assert.deepEqual(sourceContexts(sourceScope([])), []);
  const parts = ['video:asset:"fingerprint"', 'cue:["x"]'];
  assert.deepEqual(sourceRowParts(sourceRowId(...parts)), parts);
  assert.equal(sourceRowParts("shot-1"), null);
  assert.equal(sourceRowParts(JSON.stringify(parts)), null);
});

test("duplicate subtitle IDs cannot overwrite another source and survive leaving multi-select", () => {
  const original = {
    a: { cueAnnotations: { cue: { rating: 1, retained: false } } },
    b: { cueAnnotations: { cue: { rating: 2, retained: false } } },
  };
  const scope = sourceScope(["a", "b"]);
  const key = sourceRowId("b", "cue");
  const next = updateScopedSubtitles(original, scope, (state) => ({
    cueAnnotations: { ...state.cueAnnotations, [key]: { ...state.cueAnnotations[key], rating: 5 } },
  }));
  assert.equal(scopedSubtitles(next, "a").cueAnnotations.cue.rating, 1);
  assert.equal(scopedSubtitles(next, "b").cueAnnotations.cue.rating, 5);
  assert.equal(original.b.cueAnnotations.cue.rating, 2);
  assert.equal(
    updateScopedSubtitles(original, scope, (state) => state),
    original,
  );
});

test("source is the primary sort key, with stable secondary ordering and distinct same-name media", () => {
  const rows = [
    { name: "clip 10", context: "b", secondary: 1 },
    { name: "clip 2", context: "a", secondary: 1 },
    { name: "clip 2", context: "c", secondary: 1 },
    { name: "clip 2", context: "a", secondary: 2 },
  ];
  assert.deepEqual(
    sortBySource(rows, (row) => row, "ascending").map((row) => [row.context, row.secondary]),
    [
      ["a", 1],
      ["a", 2],
      ["c", 1],
      ["b", 1],
    ],
  );
  assert.deepEqual(
    sortBySource(rows, (row) => row, "descending").map((row) => [row.context, row.secondary]),
    [
      ["b", 1],
      ["c", 1],
      ["a", 1],
      ["a", 2],
    ],
  );
});

test("disabled source sorting preserves global secondary order without reading sources", () => {
  const rows = [
    { context: "b", score: 0.9 },
    { context: "a", score: 0.8 },
    { context: "b", score: 0.7 },
    { context: "a", score: 0.6 },
  ];
  const sorted = sortBySource(
    rows,
    () => {
      throw new Error("Source must not participate");
    },
    "none",
  );
  assert.deepEqual(sorted, rows);
  assert.deepEqual(
    rows.map((row) => row.score),
    [0.9, 0.8, 0.7, 0.6],
  );
  assert.equal(nextSourceSortDirection("ascending"), "descending");
  assert.equal(nextSourceSortDirection("descending"), "none");
  assert.equal(nextSourceSortDirection("none"), "ascending");
});

test("separate keyword lists merge for selected media and persist without importing unrelated lists", () => {
  const original = {
    a: board("indoor", "室内"),
    b: board("outdoor", "室外"),
    c: board("other", "其他"),
  };
  assert.deepEqual(
    scopedStoryboard(original, "a").libraryKeywordNodes.map((node) => node.name),
    ["室内"],
  );
  const scope = sourceScope(["a", "b"]);
  const combined = scopedStoryboard(original, scope);
  assert.equal(new Set(combined.shots.map((shot) => shot.id)).size, 4);
  assert.deepEqual(
    combined.libraryKeywordNodes.map((node) => node.name),
    ["室内", "室外"],
  );
  const next = updateScopedStoryboard(original, scope, (current) => ({ ...current }));
  for (const context of ["a", "b"]) {
    assert.deepEqual(
      scopedStoryboard(next, context).libraryKeywordNodes.map((node) => node.name),
      ["室内", "室外"],
    );
    assert.deepEqual(
      next[context].shots.map((shot) => shot.id),
      ["shot-1", "shot-2"],
    );
  }
  assert.deepEqual(
    scopedStoryboard(next, "c").libraryKeywordNodes.map((node) => node.name),
    ["其他"],
  );
  assert.deepEqual(
    scopedStoryboard(next, "b").recentKeywordIds,
    scopedStoryboard(next, "c").recentKeywordIds,
  );
  assert.equal(next[projectKeywordContext].keywordUsageCounters.total, 6);
  const saved = JSON.parse(JSON.stringify(next));
  assert.deepEqual(scopedStoryboard(saved, "a"), scopedStoryboard(next, "a"));
  assert.equal(
    normalizedStoryboardKeywords(next)[projectKeywordContext].keywordUsageCounters.total,
    6,
  );
});

test("legacy same-path keywords merge IDs, annotations, synonyms, and counters", () => {
  const a = board("child-a", "人");
  const b = board("child-b", "人");
  a.keywordNodes = [
    { id: "parent-a", name: "场景", parentId: null },
    { id: "child-a", name: "人", parentId: "parent-a", synonyms: ["人物"] },
  ];
  b.keywordNodes = [
    { id: "child-b", name: "人", parentId: "parent-b", synonyms: ["角色"] },
    { id: "parent-b", name: "场景", parentId: null },
  ];
  const before = JSON.stringify({ a, b });
  const normalized = normalizedStoryboardKeywords({ a, b });
  assert.equal(normalized[projectKeywordContext].keywordNodes.length, 2);
  assert.deepEqual(normalized.b.shotAnnotations["shot-1"].keywordIds, ["child-a"]);
  assert.deepEqual(normalized[projectKeywordContext].keywordNodes[1].synonyms, ["人物", "角色"]);
  assert.equal(normalized[projectKeywordContext].keywordUsageCounters.counts["child-a"], 4);
  assert.deepEqual(normalized.a.recentKeywordIds, []);
  assert.equal(normalized.a.keywordUsageCounters.total, 0);
  assert.equal(JSON.stringify({ a, b }), before);
});

test("project recent usage counts once across a batch and importing a recent keyword adds its parents", () => {
  const original = { a: board("indoor", "室内"), b: board("outdoor", "室外") };
  original.b.keywordNodes.unshift({ id: "scene", name: "场景", parentId: null });
  original.b.keywordNodes[1].parentId = "scene";
  const next = updateScopedStoryboard(original, "a", (current) => ({
    ...current,
    recentKeywordIds: ["outdoor", "indoor"],
    keywordUsageCounters: {
      counts: { ...current.keywordUsageCounters.counts, outdoor: 3 },
      total: 5,
    },
    shotAnnotations: {
      ...current.shotAnnotations,
      "shot-2": { rating: 0, retained: false, keywordIds: ["outdoor"] },
    },
  }));
  assert.equal(scopedStoryboard(next, "b").recentKeywordIds[0], "outdoor");
  assert.equal(scopedStoryboard(next, "b").keywordUsageCounters.total, 5);
  assert.deepEqual(
    new Set(next.a.keywordNodes.map((node) => node.id)),
    new Set(["indoor", "scene", "outdoor"]),
  );
});

test("batch annotations and deletions route only to their original source", () => {
  const original = { a: board("a-key", "A"), b: board("b-key", "B") };
  const scope = sourceScope(["a", "b"]);
  const target = sourceRowId("b", "shot-1");
  const next = updateScopedStoryboard(original, scope, (current) => ({
    ...current,
    shots: current.shots.filter((shot) => shot.id !== target),
    deletedShots: current.shots.filter((shot) => shot.id === target),
    shotAnnotations: {
      ...current.shotAnnotations,
      [sourceRowId("a", "shot-2")]: { rating: 5, retained: true },
    },
  }));
  assert.equal(next.a.shots.length, 2);
  assert.equal(next.b.shots.length, 1);
  assert.deepEqual(
    next.b.deletedShots.map((shot) => shot.id),
    ["shot-1"],
  );
  assert.equal(next.a.shotAnnotations["shot-2"].rating, 5);
  assert.equal(next.b.shotAnnotations["shot-2"], undefined);
  assert.equal(
    updateScopedStoryboard(original, scope, (state) => state),
    original,
  );
});

test("keyword deletion updates the project catalog and every existing reference", () => {
  const original = { a: board("shared-a", "共同"), b: board("shared-b", "共同") };
  const next = updateScopedStoryboard(original, "a", (current) => ({
    ...current,
    keywordNodes: [],
    recentKeywordIds: [],
    keywordUsageCounters: { counts: {}, total: 0 },
    shotAnnotations: { "shot-1": { rating: 1, retained: false, keywordIds: [] } },
  }));
  assert.deepEqual(next.b.shotAnnotations["shot-1"].keywordIds, []);
  assert.deepEqual(scopedStoryboard(next, "b").keywordNodes, []);
});
