import assert from "node:assert/strict";
import test from "node:test";
import { readAppStorage } from "../../src/runtime/storage.ts";

test("copied browser values are readable without runtime copying", () => {
  const values = new Map([["linecut:recent-project-paths", '["project.lcp"]']]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: () => assert.fail("Runtime reads must not migrate storage"),
  };
  assert.equal(readAppStorage("locution-pro:recent-project-paths", storage), '["project.lcp"]');
  assert.equal(values.has("locution-pro:recent-project-paths"), false);
  values.set("locution-pro:recent-project-paths", "[]");
  assert.equal(readAppStorage("locution-pro:recent-project-paths", storage), "[]");
  values.set("locution-pro:recent-project-paths", "");
  assert.equal(readAppStorage("locution-pro:recent-project-paths", storage), "");
  assert.equal(readAppStorage("locution-pro:missing", storage), null);
  assert.equal(readAppStorage("unrelated:recent-project-paths", storage), null);
});
