import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

function fixture(t, additions = {}, extraScripts = {}) {
  const root = mkdtempSync(join(tmpdir(), "linecut-layout-"));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert(basename(root).startsWith("linecut-layout-"));
    rmSync(root, { recursive: true, force: true });
  });
  const files = {
    "package.json": JSON.stringify({
      scripts: { "check:layout": "node scripts/check-repository-layout.mjs", ...extraScripts },
    }),
    ".gitignore": "target/\n",
    "src-tauri/src/lib.rs": "fn value() {}\n#[cfg(test)] mod tests { #[test] fn check() {} }",
    // Ignored build output must not be subject to authored-file rules.
    "target/generated_tests.rs": "mod tests;",
    ...additions,
  };
  for (const [name, source] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(
    new URL("../../scripts/check-repository-layout.mjs", import.meta.url),
    join(root, "scripts/check-repository-layout.mjs"),
  );
  execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  const result = spawnSync(process.execPath, ["scripts/check-repository-layout.mjs"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.ifError(result.error);
  return result;
}

test("layout check accepts inline Rust tests and ignores generated build output", (t) => {
  const result = fixture(t);
  assert.equal(result.status, 0, result.stderr);
});

for (const name of [
  "src-tauri/tests/contract.rs",
  "src-tauri/src/onnx_tests.rs",
  "src-tauri/src/test_onnx.rs",
]) {
  test(`layout check rejects standalone Rust test file ${name}`, (t) => {
    const result = fixture(t, { [name]: "#[test] fn check() {}" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Rust tests must be inline/);
  });
}

test("layout check rejects arbitrarily named external Rust test modules", (t) => {
  const result = fixture(t, {
    "src-tauri/src/lib.rs": '#[cfg(all(test, windows))]\n#[path = "checks.rs"]\nmod checks;',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /external Rust test modules/);
});

test("layout check rejects a test harness disguised as a maintenance command", (t) => {
  const result = fixture(
    t,
    { "scripts/check-fixture.mjs": 'import { test } from "node:test";' },
    { fixture: "node scripts/check-fixture.mjs" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /test code belongs in tests/);
});

test("layout check rejects dangling npm entries and orphan maintenance scripts", (t) => {
  const result = fixture(
    t,
    { "scripts/check-orphan.mjs": "export {};" },
    { missing: "node scripts/missing.mjs" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /references missing scripts\/missing.mjs/);
  assert.match(result.stderr, /maintenance scripts must have a package.json entry point/);
});

test("layout check rejects misplaced MJS and invalid syntax without executing it", (t) => {
  const result = fixture(t, {
    "experiment.mjs": 'throw new Error("must not execute");',
    "tests/unit/broken.test.mjs": "export const = ;",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MJS files must be maintenance scripts or tests/);
  assert.match(result.stderr, /SyntaxError/);
  assert.doesNotMatch(result.stderr, /Error: must not execute/);
});

test("layout check rejects screenshot TODO files in published documentation assets", (t) => {
  const result = fixture(t, { "docs/user-guide/public/images/example.txt": "TODO screenshot" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not screenshot TODO files/);
});
