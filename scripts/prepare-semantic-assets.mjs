import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "src-tauri/resources/semantic-search");
const cache = join(root, ".cache/semantic-assets");
const revision = "ac5d898c8d382b17167c33e5c8af644a3519b47d";
const base = `https://huggingface.co/jinaai/jina-embeddings-v5-text-nano-retrieval/resolve/${revision}`;
const files = [
  ["onnx/model_quantized.onnx", "ac93a7417c216e5076e37da2b3599f7ef16513934098a477680440c09f735a08"],
  [
    "onnx/model_quantized.onnx_data",
    "ee7870eb143a7353be08b33f79992a51de3e32b41f684ccd82953a710c2f2f9c",
  ],
  ["tokenizer.json", "98d4a1d32152d6cedf85b5e88f3b205106dca1fe72aaab34e0ac13c238421069"],
  ["README.md", null],
  ["LICENSE.txt", null, "https://creativecommons.org/licenses/by-nc/4.0/legalcode.txt"],
];
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
mkdirSync(destination, { recursive: true });
mkdirSync(cache, { recursive: true });
// Node does not automatically use Windows' system proxy, unlike the desktop app.
const systemProxy =
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
for (const [name, checksum, sourceUrl] of files) {
  const target = join(destination, name.split("/").at(-1));
  if (existsSync(target) && (!checksum || (await digest(target)) === checksum)) continue;
  const temporary = join(cache, `${name.split("/").at(-1)}.tmp`);
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(`Downloading semantic search asset: ${name}`);
      if (systemProxy) {
        await promisify(execFile)(
          "curl.exe",
          [
            "--proxy",
            systemProxy,
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
            sourceUrl ?? `${base}/${name}?download=true`,
          ],
          { windowsHide: true },
        );
      } else {
        const response = await fetch(sourceUrl ?? `${base}/${name}?download=true`, {
          signal: AbortSignal.timeout(600_000),
        });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${name}`);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      }
      if (checksum && (await digest(temporary)) !== checksum)
        throw new Error(`Checksum mismatch: ${name}`);
      renameSync(temporary, target);
      break;
    } catch (error) {
      rmSync(temporary, { force: true });
      if (attempt === 4) throw error;
      console.warn(`Retry ${attempt}: ${error.message}`);
    }
  }
}
console.log("Semantic search INT8 assets are ready.");
