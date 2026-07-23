import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const providerManifest = resolve(root, "src-tauri", "thumbnail-provider", "Cargo.toml");
const targetDirectory = resolve(root, "src-tauri", "target");

if (process.platform !== "win32") {
  throw new Error("The LCP thumbnail provider is built only for Windows NSIS bundles.");
}

execFileSync(
  "cargo",
  ["build", "--manifest-path", providerManifest, "--release", "--target-dir", targetDirectory],
  { cwd: root, stdio: "inherit" },
);
