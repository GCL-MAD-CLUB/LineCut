import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fitStoryboardGrid,
  storyboardGridHitIndices,
  storyboardGridRenderRange,
  storyboardGridScrollOffset,
} from "../../src/core/editor/storyboardGrid.ts";

test("direct grid fitting preserves the existing icon sizes and column thresholds", () => {
  function previousLayout(count, width, target) {
    for (let columns = count; columns >= 1; columns -= 1) {
      const minimum = ((target - 1) * (columns - 1)) / columns;
      const fitted = width / columns;
      if (fitted >= minimum) return { columns, cardWidth: Math.min(target, fitted) };
    }
  }
  for (const count of [1, 2, 7, 100, 10_000]) {
    for (const target of [200, 260, 320]) {
      for (const width of [1, 120, 199, 200, 398, 599, 600, 1024, 1387.5]) {
        assert.deepEqual(
          fitStoryboardGrid(count, width, target),
          previousLayout(count, width, target),
        );
      }
    }
  }
});

test("100,000 shots render only visible rows and two rows of overscan on each side", () => {
  const range = storyboardGridRenderRange(100_000, 5, { startIndex: 50_000, endIndex: 50_019 });
  assert.deepEqual(range, { startIndex: 49_990, endIndex: 50_030 });
  assert.equal(range.endIndex - range.startIndex, 40);
  assert.equal(range.startIndex % 5, 0);
  // Full scroll height and the first rendered row retain their original coordinates.
  const cardWidth = 200;
  const fullHeight = Math.ceil(100_000 / 5) * cardWidth;
  const paddingTop = (range.startIndex / 5) * cardWidth;
  assert.equal(fullHeight, 4_000_000);
  assert.equal(paddingTop + (10 / 5) * cardWidth, (50_000 / 5) * cardWidth);
});

test("render ranges stay valid at initial mount, the final partial row, and after filtering", () => {
  assert.deepEqual(storyboardGridRenderRange(0, 5, { startIndex: -1, endIndex: -1 }), {
    startIndex: 0,
    endIndex: 0,
  });
  assert.deepEqual(storyboardGridRenderRange(100_000, 5, { startIndex: -1, endIndex: -1 }), {
    startIndex: 0,
    endIndex: 15,
  });
  assert.deepEqual(storyboardGridRenderRange(23, 5, { startIndex: 20, endIndex: 22 }), {
    startIndex: 10,
    endIndex: 23,
  });
  assert.deepEqual(storyboardGridRenderRange(7, 5, { startIndex: 50_000, endIndex: 50_019 }), {
    startIndex: 0,
    endIndex: 7,
  });
});

test("search, keyboard navigation, and playback can scroll to unmounted shots", () => {
  const layout = { columns: 5, cardWidth: 200 };
  assert.equal(storyboardGridScrollOffset(50_000, layout, 0, 800, "center"), 1_999_700);
  assert.equal(storyboardGridScrollOffset(50_000, layout, 0, 800, "nearest"), 1_999_400);
  assert.equal(storyboardGridScrollOffset(0, layout, 2_000_000, 800, "center"), 0);
  assert.equal(storyboardGridScrollOffset(10, layout, 300, 800, "nearest"), 300);
  assert.equal(storyboardGridScrollOffset(50, layout, 3000, 800, "nearest"), 2000);
  assert.equal(storyboardGridScrollOffset(10, layout, 0, 100, "nearest"), 400);
});

test("grid marquee hits match card rectangles, including unmounted and partial rows", () => {
  const count = 103;
  const layout = { columns: 5, cardWidth: 200 };
  const rectangles = [
    { left: 210, right: 790, top: 3210, bottom: 3790 },
    { left: 0, right: 200, top: 200, bottom: 400 },
    { left: -100, right: 1200, top: -100, bottom: 4500 },
    { left: 610, right: 990, top: 4010, bottom: 4190 },
    { left: 1100, right: 1200, top: 0, bottom: 200 },
    { left: 0, right: 200, top: 4300, bottom: 4500 },
  ];
  for (const rect of rectangles) {
    const expected = Array.from({ length: count }, (_, index) => index).filter((index) => {
      const left = (index % layout.columns) * layout.cardWidth;
      const top = Math.floor(index / layout.columns) * layout.cardWidth;
      return (
        left + layout.cardWidth >= rect.left &&
        left <= rect.right &&
        top + layout.cardWidth >= rect.top &&
        top <= rect.bottom
      );
    });
    assert.deepEqual(storyboardGridHitIndices(count, layout, rect), expected);
  }
  assert.deepEqual(storyboardGridHitIndices(0, layout, rectangles[0]), []);
});
