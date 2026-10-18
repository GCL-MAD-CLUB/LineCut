import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Inspect authored files, including untracked additions, without walking build outputs.
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter((file) => file && existsSync(resolve(root, file)));
const failures = [];
const fail = (file, message) => failures.push(`${file}: ${message}`);
const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;
const entryPoints = new Set();

for (const [name, command] of Object.entries(scripts)) {
  for (const [entry] of command.matchAll(/\b(?:scripts|tests)\/[\w./-]+\.mjs\b/gu)) {
    entryPoints.add(entry);
    if (!files.includes(entry)) fail("package.json", `${name} references missing ${entry}`);
  }
}

for (const file of files) {
  const source = () => readFileSync(resolve(root, file), "utf8");
  if (file.endsWith(".rs")) {
    if (
      /(?:^|\/)tests?(?:\/|\.rs$)|(?:^|\/)(?:test[_.-][^/]+|[^/]+[_.-]tests?)\.rs$/u.test(file) ||
      /#!\[cfg\([^\]]*\btest\b[^\]]*\)\]/u.test(source())
    ) {
      fail(file, "Rust tests must be inline #[cfg(test)] modules in their implementation file");
    }
    if (
      /\bmod\s+tests?\s*;/u.test(source()) ||
      /#\[cfg\([^\]]*\btest\b[^\]]*\)\]\s*(?:#\[[^\n]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*;/u.test(
        source(),
      )
    ) {
      fail(file, "external Rust test modules are forbidden; use mod tests { ... }");
    }
  }
  if (file.startsWith("docs/user-guide/public/images/") && file.endsWith(".txt")) {
    fail(file, "publish real documentation assets, not screenshot TODO files");
  }
  if (file.startsWith("scripts/")) {
    if (!/^scripts\/(?:check-[\w-]+|build-[\w-]+|prepare-[\w-]+|release)\.mjs$/u.test(file)) {
      fail(
        file,
        "scripts/ is reserved for build, asset preparation, release and repository checks",
      );
    }
    if (!entryPoints.has(file))
      fail(file, "maintenance scripts must have a package.json entry point");
    if (
      /\b(?:from\s*|import\s*\(|require\s*\()\s*["'](?:node:)?(?:test|assert)(?:[/'"])/u.test(
        source(),
      )
    ) {
      fail(file, "test code belongs in tests/, not scripts/");
    }
  }
  if (file.endsWith(".mjs")) {
    if (
      !file.startsWith("scripts/") &&
      !/^tests\/(?:unit|browser|integration)\/[\w-]+\.test\.mjs$/u.test(file)
    ) {
      fail(file, "MJS files must be maintenance scripts or tests in a designated test directory");
    }
    try {
      execFileSync(process.execPath, ["--check", resolve(root, file)], {
        encoding: "utf8",
        stdio: "pipe",
        windowsHide: true,
      });
    } catch (error) {
      fail(file, error.stderr?.trim() || error.message);
    }
  }
}

if (failures.length) {
  console.error(
    `Repository layout check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
  );
  process.exitCode = 1;
} else {
  console.log("Repository layout and MJS syntax checks passed.");
}
