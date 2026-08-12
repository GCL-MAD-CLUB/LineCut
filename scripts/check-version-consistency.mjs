import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function readJson(path) {
  return JSON.parse(read(path));
}

function matchVersion(path, pattern) {
  const match = read(path).match(pattern);
  if (!match) {
    throw new Error(`Could not find a version in ${path}`);
  }
  return match[1];
}

const packageJson = readJson("package.json");
const versions = new Map([
  ["package.json", packageJson.version],
  ["package-lock.json", readJson("package-lock.json").version],
  ["package-lock.json root package", readJson("package-lock.json").packages?.[""]?.version],
  [
    "src-tauri/Cargo.toml",
    matchVersion("src-tauri/Cargo.toml", /^\[package\][\s\S]*?^version = "([^"]+)"/m),
  ],
  [
    "src-tauri/Cargo.lock",
    matchVersion(
      "src-tauri/Cargo.lock",
      /^\[\[package\]\]\r?\nname = "linecut"\r?\nversion = "([^"]+)"/m,
    ),
  ],
  ["src-tauri/tauri.conf.json", readJson("src-tauri/tauri.conf.json").version],
]);

const mismatches = [...versions].filter(([, version]) => version !== packageJson.version);
if (mismatches.length > 0) {
  const details = [...versions].map(([path, version]) => `- ${path}: ${version}`).join("\n");
  throw new Error(`Release versions are inconsistent:\n${details}`);
}

if (process.env.GITHUB_REF_TYPE === "tag") {
  const tag = process.env.GITHUB_REF_NAME ?? "";
  const tagVersion = tag.startsWith("v") ? tag.slice(1) : tag;
  if (tagVersion !== packageJson.version) {
    throw new Error(`Release tag ${tag} does not match manifest version ${packageJson.version}`);
  }
}

console.log(`All release manifests use version ${packageJson.version}`);
