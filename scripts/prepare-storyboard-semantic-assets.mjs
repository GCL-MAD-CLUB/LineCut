import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
// ORT 1.24 DirectML's ReshapeHelper skips -1 inference when allowzero=1.
// The twelve attention output reshapes use [batch, tokens, -1], where batch
// and tokens are positive. allowzero=0 is therefore exactly equivalent.
// Patch only these pinned nodes; retain all protobuf fields and external weights.
// A wire reader avoids adding Python/ONNX as an installer/build prerequisite.
function fields(buffer) {
  let offset = 0;
  function varint() {
    let value = 0;
    for (let shift = 0; shift < 49 && offset < buffer.length; shift += 7) {
      const byte = buffer[offset++];
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128) && Number.isSafeInteger(value)) return value;
    }
    throw new Error("Invalid DINOv3 protobuf varint");
  }
  const result = [];
  while (offset < buffer.length) {
    const tag = varint();
    const wire = tag % 8;
    const number = Math.floor(tag / 8);
    let start = offset;
    let value;
    if (wire === 0) value = varint();
    else if (wire === 1) offset += 8;
    else if (wire === 2) {
      const size = varint();
      start = offset;
      offset += size;
    } else if (wire === 5) offset += 4;
    else throw new Error(`Unsupported DINOv3 protobuf wire type ${wire}`);
    if (!number || offset > buffer.length) throw new Error("Truncated DINOv3 protobuf field");
    result.push({ number, wire, value, data: buffer.subarray(start, offset) });
  }
  return result;
}

const modelPath = join(destination, "model.onnx");
const graphBytes = readFileSync(modelPath);
const graph = fields(graphBytes).find((field) => field.number === 7 && field.wire === 2);
if (!graph) throw new Error("DINOv3 graph is missing");
const expected = new Set(Array.from({ length: 12 }, (_, i) => `node_view_${8 + 4 * i}`));
let patched = 0;
for (const node of fields(graph.data).filter((field) => field.number === 1)) {
  const attributes = fields(node.data);
  const name = attributes.find((field) => field.number === 3)?.data.toString();
  if (!expected.has(name)) continue;
  const op = attributes.find((field) => field.number === 4)?.data.toString();
  const inputs = attributes.filter((field) => field.number === 1);
  if (op !== "Reshape" || inputs[1]?.data.toString() !== "val_211")
    throw new Error(`Unexpected pinned DINOv3 node: ${name}`);
  const allowzero = attributes
    .filter((field) => field.number === 5)
    .map((field) => fields(field.data))
    .find((attribute) =>
      attribute.some((field) => field.number === 1 && field.data.toString() === "allowzero"),
    )
    ?.find((field) => field.number === 3 && field.wire === 0);
  if (!allowzero || allowzero.data.length !== 1 || ![0, 1].includes(allowzero.value))
    throw new Error(`Unexpected DINOv3 allowzero attribute: ${name}`);
  if (allowzero.value === 1) {
    allowzero.data[0] = 0;
    patched++;
  }
  expected.delete(name);
}
if (expected.size) throw new Error(`Missing DINOv3 attention nodes: ${[...expected]}`);
if (patched) {
  const temporary = `${modelPath}.tmp`;
  writeFileSync(temporary, graphBytes);
  renameSync(temporary, modelPath);
  console.log(`Applied DirectML compatibility to ${patched} DINOv3 attention reshapes.`);
}
console.log("Storyboard DINOv3 assets are ready.");

const siglipDirectory = join(destination, "siglip2");
const siglipRevision = "d1114256522a37ffa257a0a58017348ab0058db2";
const siglipBase = `https://huggingface.co/onnx-community/siglip2-base-patch16-256-ONNX/resolve/${siglipRevision}`;
mkdirSync(siglipDirectory, { recursive: true });
for (const name of [
  "onnx/vision_model_fp16.onnx",
  "onnx/text_model_int8.onnx",
  "tokenizer.json",
  "tokenizer_config.json",
  "preprocessor_config.json",
  "config.json",
]) {
  const target = join(siglipDirectory, name.split("/").at(-1));
  if (existsSync(target) && statSync(target).size > 0) continue;
  const temporary = `${target}.tmp`;
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(`Downloading SigLIP2 asset: ${name}`);
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
          `${siglipBase}/${name}?download=true`,
        ],
        { windowsHide: true },
      );
      if (!statSync(temporary).size) throw new Error(`Empty SigLIP2 asset: ${name}`);
      renameSync(temporary, target);
      break;
    } catch (error) {
      rmSync(temporary, { force: true });
      if (attempt === 4) throw error;
      console.warn(`Retry ${attempt}: ${error.message}`);
    }
  }
}
console.log("Storyboard SigLIP2 assets are ready.");
