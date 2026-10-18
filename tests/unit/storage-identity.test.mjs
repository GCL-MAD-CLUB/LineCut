import assert from "node:assert/strict";
import test from "node:test";
import { readAppStorage } from "../../src/runtime/storage.ts";

test("new storage keys inherit old values once and preserve current values including empty strings", () => {
  const values = new Map([["linecut:recent-project-paths", '["project.lcp"]']]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(readAppStorage("locution-pro:recent-project-paths", storage), '["project.lcp"]');
  assert.equal(values.get("locution-pro:recent-project-paths"), '["project.lcp"]');
  values.set("linecut:recent-project-paths", "stale");
  assert.equal(readAppStorage("locution-pro:recent-project-paths", storage), '["project.lcp"]');
  values.set("locution-pro:recent-project-paths", "");
  assert.equal(readAppStorage("locution-pro:recent-project-paths", storage), "");
});

test("a failed browser storage migration retains the old value and retries later", () => {
  const values = new Map([["linecut:export-dir", "D:/exports"]]);
  let full = true;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (full) throw new Error("quota");
      values.set(key, value);
    },
  };
  assert.equal(readAppStorage("locution-pro:export-dir", storage), "D:/exports");
  assert.equal(values.has("locution-pro:export-dir"), false);
  full = false;
  assert.equal(readAppStorage("locution-pro:export-dir", storage), "D:/exports");
  assert.equal(values.get("locution-pro:export-dir"), "D:/exports");
  assert.equal(readAppStorage("locution-pro:missing", storage), null);
  assert.equal(readAppStorage("unrelated:export-dir", storage), null);
});
