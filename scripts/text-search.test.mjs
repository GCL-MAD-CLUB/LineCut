import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canHighlightSearchRule,
  matchesTextSearch,
  textSearchRanges,
  nextSearchMatchIndex,
} from "../src/core/editor/textSearch.ts";

test("search rules distinguish any, all, whole words and negative matches", () => {
  assert.equal(matchesTextSearch(["Hello world"], "hello missing", "contains"), true);
  assert.equal(matchesTextSearch(["Hello world"], "hello missing", "containsAll"), false);
  assert.equal(matchesTextSearch(["Hello", "WORLD"], "hello world", "containsAll"), true);
  assert.equal(matchesTextSearch(["catalog cat"], "cat", "containsWords"), true);
  assert.equal(matchesTextSearch(["catalog"], "cat", "containsWords"), false);
  assert.equal(matchesTextSearch(["字幕测试"], "字幕", "contains"), true);
  assert.equal(matchesTextSearch(["Hello world"], "bye", "doesNotContain"), true);
  assert.equal(matchesTextSearch(["hello", "world"], "WORLD", "endsWith"), true);
  assert.equal(matchesTextSearch(["hello", "world"], "wor", "startsWith"), true);
  assert.equal(matchesTextSearch(["", "  "], "ignored", "isEmpty"), true);
  assert.equal(matchesTextSearch(["hello"], "", "isNotEmpty"), true);
});

test("highlight ranges preserve text offsets, repeated matches and literal punctuation", () => {
  assert.deepEqual(textSearchRanges("😀Hello HELLO", "hello", "contains"), [
    { start: 2, end: 7 },
    { start: 8, end: 13 },
  ]);
  assert.deepEqual(textSearchRanges("catalog cat", "cat", "containsWords"), [
    { start: 8, end: 11 },
  ]);
  assert.deepEqual(textSearchRanges("banana", "ban banana", "contains"), [{ start: 0, end: 6 }]);
  assert.deepEqual(textSearchRanges("a+b a+b", "a+b", "startsWith"), [{ start: 0, end: 3 }]);
  assert.deepEqual(textSearchRanges("a+b a+b", "a+b", "endsWith"), [{ start: 4, end: 7 }]);
  assert.deepEqual(textSearchRanges("字幕测试字幕", "字幕", "contains"), [
    { start: 0, end: 2 },
    { start: 4, end: 6 },
  ]);
  assert.deepEqual(textSearchRanges("hello", "  ", "contains"), []);
});

test("keyword prefix and suffix highlights use individual field boundaries", () => {
  const text = "catalog, cat, Hello<world";
  const fields = [/[^,]+/g, /[^,<]+/g].flatMap((pattern) =>
    Array.from(text.matchAll(pattern), (match) => ({
      start: match.index,
      end: match.index + match[0].length,
    })),
  );
  assert.deepEqual(textSearchRanges(text, "cat", "endsWith", fields), [{ start: 9, end: 12 }]);
  assert.deepEqual(textSearchRanges(text, "wor", "startsWith", fields), [{ start: 20, end: 23 }]);
});

test("only positive rules allow highlights", () => {
  for (const rule of ["contains", "containsAll", "containsWords", "startsWith", "endsWith"])
    assert.equal(canHighlightSearchRule(rule), true);
  for (const rule of ["doesNotContain", "isEmpty", "isNotEmpty"]) {
    assert.equal(canHighlightSearchRule(rule), false);
    assert.deepEqual(textSearchRanges("hello", "hello", rule), []);
  }
});

test("result navigation skips nonmatches and wraps in either direction", () => {
  assert.equal(nextSearchMatchIndex([], 0, 1), -1);
  assert.equal(nextSearchMatchIndex([1, 4, 7], -1, 1), 1);
  assert.equal(nextSearchMatchIndex([1, 4, 7], -1, -1), 7);
  assert.equal(nextSearchMatchIndex([1, 4, 7], 2, 1), 4);
  assert.equal(nextSearchMatchIndex([1, 4, 7], 2, -1), 1);
  assert.equal(nextSearchMatchIndex([1, 4, 7], 7, 1), 1);
  assert.equal(nextSearchMatchIndex([1, 4, 7], 1, -1), 7);
  assert.equal(nextSearchMatchIndex([4], 4, 1), 4);
});
