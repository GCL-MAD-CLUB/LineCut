// Run with: node --experimental-strip-types scripts/test-storyboard-cuts.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { frameToTimeUs } from "../src/core/editor/timeline.ts";
import {
  appendProjectHistoryEntry,
  applyProjectFileEvent,
  createProjectHistory,
  createProjectHistoryEntry,
} from "../src/systems/ProjectSystem/ProjectHistory.ts";

const source = readFileSync(
  new URL("../src/core/editor/storyboardCuts.ts", import.meta.url),
  "utf8",
).replace(
  '"./timeline"',
  JSON.stringify(new URL("../src/core/editor/timeline.ts", import.meta.url).href),
);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { splitStoryboardShot, moveStoryboardCuts, removeStoryboardCuts } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);

function storyboard(frameRate = 25) {
  return {
    shots: [0, 10, 20, 30].map((start, index) => ({
      id: `s${index}`,
      sequence: index + 1,
      start_frame: start,
      end_frame: start + 9,
      start_us: frameToTimeUs(start, frameRate),
      end_us: frameToTimeUs(start + (index === 3 ? 10 : 9), frameRate),
    })),
    shotStacks: [{ id: "s0", shotIds: ["s0", "s1"] }],
    keywordNodes: [],
    recentKeywordIds: [],
    shotAnnotations: {
      s0: {
        title: "A",
        rating: 2,
        retained: false,
        excluded: true,
        colorLabel: "red",
        customLabel: "warm",
        keywordIds: ["a"],
      },
      s1: {
        title: "B",
        rating: 5,
        retained: false,
        excluded: false,
        colorLabel: "blue",
        keywordIds: ["b", "a"],
      },
      s2: { title: "C", rating: 3, retained: true, keywordIds: ["c"] },
    },
  };
}

function assertRanges(state, frameRate = 25) {
  assert.equal(state.shots[0].start_frame, 0);
  assert.equal(state.shots.at(-1).end_frame, 39);
  for (const [index, shot] of state.shots.entries()) {
    assert.ok(shot.start_frame <= shot.end_frame, "every shot has at least one frame");
    assert.equal(shot.start_us, frameToTimeUs(shot.start_frame, frameRate));
    assert.equal(
      shot.end_us,
      frameToTimeUs(shot.end_frame + (index === state.shots.length - 1 ? 1 : 0), frameRate),
    );
    if (index > 0) assert.equal(state.shots[index - 1].end_frame + 1, shot.start_frame);
  }
}

test("splitting copies all annotations, preserves the first title, and extends its stack", () => {
  const original = storyboard();
  const before = structuredClone(original);
  const result = splitStoryboardShot(original, 5, 25, "new");
  assert.deepEqual(result.shotAnnotations.new, { ...original.shotAnnotations.s0, title: "A-1" });
  assert.deepEqual(result.shotAnnotations.s0, original.shotAnnotations.s0);
  assert.deepEqual(result.shotStacks[0].shotIds, ["s0", "new", "s1"]);
  assert.deepEqual(
    result.shots.map((shot) => shot.sequence),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(original, before, "history snapshots must remain immutable");
  assertRanges(result);
});

test("split accepts a final single frame and rejects existing cuts and out-of-range positions", () => {
  const original = storyboard();
  for (const frame of [-1, 0, 10, 20, 30, 40, 3.5, NaN]) {
    assert.equal(splitStoryboardShot(original, frame, 25, "new"), original);
  }
  assert.equal(splitStoryboardShot(original, 5, 25, "s0"), original);
  const result = splitStoryboardShot(original, 39, 25, "new");
  assert.equal(result.shots.at(-1).start_frame, 39);
  assert.equal(result.shots.at(-1).end_frame, 39);
  assert.equal(result.shotAnnotations.new.title, "分镜 4-1");
  assertRanges(result);
});

test("one cut stops one frame away from either neighbor", () => {
  const original = storyboard();
  const left = moveStoryboardCuts(original, new Set(["s1"]), -100, 25);
  const right = moveStoryboardCuts(original, new Set(["s1"]), 100, 25);
  assert.equal(left.shots[1].start_frame, 1);
  assert.equal(right.shots[1].start_frame, 19);
  assertRanges(left);
  assertRanges(right);
});

test("consecutive selected cuts keep their spacing and stop as one group", () => {
  const original = storyboard();
  const ids = new Set(["s1", "s2"]);
  for (const delta of [-100, -4, 0, 4, 100]) {
    const result = moveStoryboardCuts(original, ids, delta, 25);
    assert.equal(result.shots[2].start_frame - result.shots[1].start_frame, 10);
    assert.equal(result.shots[3].start_frame, 30);
    assertRanges(result);
  }
});

test("every subset of cuts obeys collisions, including nonconsecutive multi-selection", () => {
  const original = storyboard();
  for (let mask = 1; mask < 8; mask += 1) {
    const ids = new Set(["s1", "s2", "s3"].filter((_, index) => mask & (1 << index)));
    for (let delta = -45; delta <= 45; delta += 1) {
      const result = moveStoryboardCuts(original, ids, delta, 25);
      const shifts = result.shots
        .slice(1)
        .filter((shot) => ids.has(shot.id))
        .map(
          (shot) => shot.start_frame - original.shots.find((old) => old.id === shot.id).start_frame,
        );
      assert.equal(new Set(shifts).size, 1);
      for (const shot of result.shots.slice(1).filter((shot) => !ids.has(shot.id))) {
        assert.equal(
          shot.start_frame,
          original.shots.find((old) => old.id === shot.id).start_frame,
        );
      }
      assertRanges(result);
    }
  }
});

test("merging consecutive cuts combines titles and keywords, and takes max rating and flag", () => {
  const original = storyboard();
  const before = structuredClone(original);
  const result = removeStoryboardCuts(original, new Set(["s1", "s2"]));
  assert.equal(result.shots.length, 2);
  assert.deepEqual(result.shotAnnotations.s0, {
    title: "A-B-C",
    rating: 5,
    retained: true,
    excluded: false,
    colorLabel: "red",
    customLabel: "warm",
    keywordIds: ["a", "b", "c"],
  });
  assert.equal(result.shotAnnotations.s1, undefined);
  assert.equal(result.shotAnnotations.s2, undefined);
  assert.deepEqual(result.shotStacks, []);
  assert.deepEqual(original, before);
  assertRanges(result);
});

test("flag priority is retained > none > excluded, including missing annotations", () => {
  const flags = [
    { retained: false, excluded: true },
    { retained: false, excluded: false },
    { retained: true, excluded: false },
  ];
  for (let first = 0; first < 3; first += 1) {
    for (let second = 0; second < 3; second += 1) {
      const original = storyboard();
      original.shotAnnotations.s0 = { rating: 0, ...flags[first] };
      original.shotAnnotations.s1 = { rating: 0, ...flags[second] };
      const result = removeStoryboardCuts(original, new Set(["s1"])).shotAnnotations.s0;
      assert.equal(result.retained, flags[Math.max(first, second)].retained);
      assert.equal(result.excluded, flags[Math.max(first, second)].excluded);
    }
  }
  const original = storyboard();
  delete original.shotAnnotations.s1;
  assert.equal(removeStoryboardCuts(original, new Set(["s1"])).shotAnnotations.s0.excluded, false);
});

test("nonconsecutive removal creates separate merged shots and all cuts can be removed", () => {
  const original = storyboard();
  const result = removeStoryboardCuts(original, new Set(["s1", "s3"]));
  assert.deepEqual(
    result.shots.map((shot) => shot.id),
    ["s0", "s2"],
  );
  assert.equal(result.shotAnnotations.s0.title, "A-B");
  assert.equal(result.shotAnnotations.s2.title, "C-分镜 4");
  assertRanges(result);
  const all = removeStoryboardCuts(original, new Set(["s1", "s2", "s3"]));
  assert.equal(all.shots.length, 1);
  assertRanges(all);
  assert.equal(removeStoryboardCuts(original, new Set(["s0", "missing"])), original);
});

test("fractional frame rates preserve rounded microsecond boundaries", () => {
  const fps = 30000 / 1001;
  const original = storyboard(fps);
  const split = splitStoryboardShot(original, 15, fps, "new");
  const moved = moveStoryboardCuts(split, new Set(["new", "s2"]), 3, fps);
  assertRanges(split, fps);
  assertRanges(moved, fps);
  assertRanges(removeStoryboardCuts(moved, new Set(["new"])), fps);
});

test("a drag is a single undo step and split/merge history restores annotations and stacks", () => {
  const original = {
    projects: {},
    mediaFolders: [],
    mediaItems: [],
    activeVideoId: "video",
    activeTrackId: "",
    detachedVideoIds: new Set(),
    useProxy: false,
    subtitles: {},
    storyboards: { video: storyboard() },
  };
  let current = original;
  let history = createProjectHistory(true);
  for (const delta of [2, 3, -1]) {
    const next = {
      ...current,
      storyboards: {
        video: moveStoryboardCuts(current.storyboards.video, new Set(["s1"]), delta, 25),
      },
    };
    const entry = createProjectHistoryEntry("移动切点", "storyboard", current, next, "drag-1");
    assert.ok(entry);
    history = appendProjectHistoryEntry(history, entry);
    current = next;
  }
  assert.equal(history.entries.length, 1);
  assert.deepEqual(applyProjectFileEvent(current, history.entries[0].inverseEvent), original);
  assert.deepEqual(applyProjectFileEvent(original, history.entries[0].event), current);
  for (const changed of [
    splitStoryboardShot(original.storyboards.video, 5, 25, "new"),
    removeStoryboardCuts(original.storyboards.video, new Set(["s1", "s2"])),
  ]) {
    const next = { ...original, storyboards: { video: changed } };
    const entry = createProjectHistoryEntry("编辑切点", "storyboard", original, next);
    assert.ok(entry);
    assert.deepEqual(applyProjectFileEvent(next, entry.inverseEvent), original);
    assert.deepEqual(applyProjectFileEvent(original, entry.event), next);
  }
});
