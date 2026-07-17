import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localReleaseSecret = join(root, "src-tauri", ".linecut-project-build-secret-v1.local");
const prettierCli = join(root, "node_modules", "prettier", "bin", "prettier.cjs");
const tauriCli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const args = process.argv.slice(2);
const [version] = args;

if (!version || args.length !== 1) {
  throw new Error("Usage: npm run release:build -- <semver>");
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid semantic version: ${version}`);
}

if (!process.env.LINECUT_PROJECT_BUILD_SECRET_V1 && !existsSync(localReleaseSecret)) {
  throw new Error(
    "Official release key is missing. Set LINECUT_PROJECT_BUILD_SECRET_V1 or restore src-tauri/.linecut-project-build-secret-v1.local.",
  );
}

function read(path) {
  return readFileSync(path, "utf8");
}

function write(path, contents) {
  writeFileSync(path, contents, "utf8");
}

function replaceVersion(path, pattern) {
  const contents = read(path);
  if (!pattern.test(contents)) {
    throw new Error(`Could not find the package version in ${path}`);
  }
  write(path, contents.replace(pattern, `$1"${version}"`));
}

function updateJsonVersion(path) {
  const document = JSON.parse(read(path));
  document.version = version;
  if (document.packages?.[""]) {
    document.packages[""].version = version;
  }
  write(path, `${JSON.stringify(document, null, 2)}\n`);
}

function run(command, commandArgs) {
  execFileSync(command, commandArgs, { cwd: root, stdio: "inherit" });
}

updateJsonVersion(join(root, "package.json"));
updateJsonVersion(join(root, "package-lock.json"));
replaceVersion(join(root, "src-tauri", "Cargo.toml"), /(^\[package\][\s\S]*?^version = )"[^"]+"/m);
replaceVersion(
  join(root, "src-tauri", "Cargo.lock"),
  /(^\[\[package\]\]\r?\nname = "linecut"\r?\nversion = )"[^"]+"/m,
);
updateJsonVersion(join(root, "src-tauri", "tauri.conf.json"));

run(process.execPath, [
  prettierCli,
  "--write",
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
]);
run("cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml"]);
run(process.execPath, [tauriCli, "build"]);

const installer = join(
  root,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  `LineCut_${version}_x64-setup.exe`,
);
if (!existsSync(installer)) {
  throw new Error(`Build completed without the expected installer: ${installer}`);
}

console.log(`Release installer created: ${installer}`);
