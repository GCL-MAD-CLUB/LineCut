import { createHash } from "node:crypto";
import {
  createReadStream,
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

const execFileAsync = promisify(execFile);
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

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function matches(path, checksums) {
  if (!existsSync(path)) return false;
  return checksums.includes(await digest(path));
}

async function ensureAsset({ directory, name, checksum, acceptedChecksums = [], url, label }) {
  const target = join(directory, name.split("/").at(-1));
  if (await matches(target, [checksum, ...acceptedChecksums])) return;
  if (existsSync(target)) {
    console.warn(`Checksum mismatch for existing ${label} asset: ${name}; re-downloading.`);
  }
  const temporary = `${target}.tmp`;
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(`Downloading ${label} asset: ${name}`);
      await execFileAsync(
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
          url,
        ],
        { windowsHide: true },
      );
      if (!statSync(temporary).size) throw new Error(`Empty ${label} asset: ${name}`);
      const actual = await digest(temporary);
      if (actual !== checksum) {
        throw new Error(`Checksum mismatch for ${name}: expected ${checksum}, got ${actual}`);
      }
      renameSync(temporary, target);
      return;
    } catch (error) {
      rmSync(temporary, { force: true });
      if (attempt === 4) throw error;
      console.warn(`Retry ${attempt}: ${error.message}`);
    }
  }
}

const dinov3GraphChecksum = "502d9fbf929a93b1f159ea591d4b3bc9658c48cbcc08e815e5c05482ddae2d03";
const dinov3PreparedGraphChecksum =
  "e9c1b42bb03898def15a3e5939f330c85459558fbc8ed8fe413e7a9afa42d2a9";
const dinov3Files = [
  {
    name: "onnx/model.onnx",
    checksum: dinov3GraphChecksum,
    // The DirectML patch below rewrites twelve allowzero bytes in place.
    acceptedChecksums: [dinov3PreparedGraphChecksum],
  },
  {
    name: "onnx/model.onnx_data",
    checksum: "4fd5bef09ca07530a4b7af9c55e615cd667f103ccb6ea505962428fed73e0e5a",
  },
  {
    name: "config.json",
    checksum: "614afdde713e969b22ed89c84c495da60c6a69be0e16ac46d51414858fcc8a45",
  },
  {
    name: "preprocessor_config.json",
    checksum: "960c41d1f3a7778b936365769a2d90550b318a6c0a53a0296957adacfe5e0dd7",
  },
  {
    name: "LICENSE.md",
    // The license text lives on a moving branch; the digest pins the reviewed copy.
    checksum: "25d122eb8f5b880fd23c736fb6ea8018ee45c12237e00b8a86d14c653904999e",
    url: "https://raw.githubusercontent.com/facebookresearch/dinov3/main/LICENSE.md",
  },
];

mkdirSync(destination, { recursive: true });
for (const { name, checksum, acceptedChecksums, url } of dinov3Files) {
  await ensureAsset({
    directory: destination,
    name,
    checksum,
    acceptedChecksums,
    url: url ?? `${base}/${name}?download=true`,
    label: "DINOv3",
  });
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
const preparedGraphChecksum = await digest(modelPath);
if (preparedGraphChecksum !== dinov3PreparedGraphChecksum) {
  throw new Error(
    `Prepared DINOv3 graph checksum mismatch: expected ${dinov3PreparedGraphChecksum}, got ${preparedGraphChecksum}. Update the pinned revision and checksums together.`,
  );
}
console.log("Storyboard DINOv3 assets are ready.");

const siglipDirectory = join(destination, "siglip2");
const siglipRevision = "d1114256522a37ffa257a0a58017348ab0058db2";
const siglipBase = `https://huggingface.co/onnx-community/siglip2-base-patch16-256-ONNX/resolve/${siglipRevision}`;
const siglipFiles = [
  {
    name: "onnx/vision_model_fp16.onnx",
    checksum: "fe9ad8020a6d3d98d394c9be8f07064066135fc2f87ec11692de0b677c0ac4db",
  },
  {
    name: "onnx/text_model_int8.onnx",
    checksum: "6f59b39d880c413042314b79302b74d0dd93b273caf8fbfdb1eb2df61a7fefd4",
  },
  {
    name: "tokenizer.json",
    checksum: "cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322",
  },
  {
    name: "tokenizer_config.json",
    checksum: "7c3a247599e741bceba1a3fe0285aea88d1044dc1fad2caa1e48cdd9fd25f630",
  },
  {
    name: "preprocessor_config.json",
    checksum: "d14ba2ee3fd816f3de8abaddc31953565128eaf37c73ad4bed32101a98465aff",
  },
  {
    name: "config.json",
    checksum: "795a8e216ebb51ad5043e128e557c45279b686bd672221fbe01279a7b8cb79c9",
  },
];

mkdirSync(siglipDirectory, { recursive: true });
for (const { name, checksum } of siglipFiles) {
  await ensureAsset({
    directory: siglipDirectory,
    name,
    checksum,
    url: `${siglipBase}/${name}?download=true`,
    label: "SigLIP2",
  });
}
console.log("Storyboard SigLIP2 assets are ready.");
