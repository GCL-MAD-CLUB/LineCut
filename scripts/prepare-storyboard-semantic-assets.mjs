import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "src-tauri/resources/storyboard-semantic");
const revision = "81f43e32cbf964b3c284da6cfd3be9fcba6d82ef";
const base = `https://huggingface.co/onnx-community/dinov3-vits16plus-pretrain-lvd1689m-ONNX/resolve/${revision}`;
const proxy =
  process.platform === "win32"
    ? execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$uri = [uri]'https://huggingface.co'; $proxy = [System.Net.WebRequest]::DefaultWebProxy.GetProxy($uri); if ($proxy.Authority -ne $uri.Authority) { $proxy.AbsoluteUri }",
        ],
        { encoding: "utf8", windowsHide: true },
      ).trim()
    : "";
mkdirSync(destination, { recursive: true });
for (const name of [
  "onnx/model.onnx",
  "onnx/model.onnx_data",
  "config.json",
  "preprocessor_config.json",
  "LICENSE.md",
]) {
  const target = join(destination, name.split("/").at(-1));
  // Pinned revision; avoid repeated large-file hashes on local startup/build.
  if (existsSync(target) && statSync(target).size > 0) continue;
  const temporary = `${target}.tmp`;
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(`Downloading DINOv3 asset: ${name}`);
      await promisify(execFile)(
        process.platform === "win32" ? "curl.exe" : "curl",
        [
          ...(proxy ? ["--proxy", proxy] : []),
          "--fail",
          "--location",
          "--silent",
          "--show-error",
          "--connect-timeout",
          "30",
          "--max-time",
          "600",
          "--output",
          temporary,
          name === "LICENSE.md"
            ? "https://raw.githubusercontent.com/facebookresearch/dinov3/main/LICENSE.md"
            : `${base}/${name}?download=true`,
        ],
        { windowsHide: true },
      );
      if (!statSync(temporary).size) throw new Error(`Empty asset: ${name}`);
      renameSync(temporary, target);
      break;
    } catch (error) {
      rmSync(temporary, { force: true });
      if (attempt === 4) throw error;
      console.warn(`Retry ${attempt}: ${error.message}`);
    }
  }
}
console.log("Storyboard DINOv3 assets are ready.");
