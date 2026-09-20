// Run with: node --experimental-strip-types scripts/test-playback-follow-scroll.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { playbackFollowScrollDuration } from "../src/components/playbackFollowScroll.ts";

test("short targets arrive before playback moves to the next item", () => {
  for (const frameRate of [24, 25, 30, 60]) {
    for (const frames of [1, 2, 3, 6, 12]) {
      const duration = playbackFollowScrollDuration(
        1500,
        400,
        100,
        100,
        100 + frames - 1,
        frameRate,
      );
      assert.ok(duration >= 0);
      assert.ok(duration < (frames / frameRate) * 1000);
      if (frames <= 2) assert.equal(duration, 0);
    }
  }
});

test("seeking near the end of a long target uses its remaining time", () => {
  assert.equal(playbackFollowScrollDuration(2000, 400, 199, 0, 200, 25), 0);
  assert.ok(playbackFollowScrollDuration(2000, 400, 195, 0, 200, 25) < 160);
});

test("long targets retain bounded smooth scrolling", () => {
  assert.equal(playbackFollowScrollDuration(400, 400, 0, 0, 500, 25), 480);
  assert.equal(playbackFollowScrollDuration(100000, 400, 0, 0, 500, 25), 900);
});

test("upcoming targets preserve gap scrolling without overrunning short targets", () => {
  assert.equal(playbackFollowScrollDuration(400, 400, 0, 100, 200, 25), 1200);
  assert.ok(playbackFollowScrollDuration(400, 400, 99, 100, 101, 25) < 40);
});
