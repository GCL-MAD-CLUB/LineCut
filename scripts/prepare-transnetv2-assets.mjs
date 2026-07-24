import { createWriteStream, existsSync, mkdirSync, rmSync, copyFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import https from "node:https";
import http from "node:http";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, ".cache", "transnetv2-assets");
const resourcesDir = join(root, "src-tauri", "resources", "transnetv2");
const extractDir = join(cacheDir, "extract");

const onnxRuntimeVersion = "1.20.1";
const directMlVersion = "1.15.2";
const maxDownloadAttempts = 4;
const requestTimeoutMs = 60_000;

const downloads = {
  model: {
    url: "https://huggingface.co/elya5/transnetv2/resolve/main/transnetv2.onnx",
    path: join(resourcesDir, "transnetv2.onnx"),
  },
  onnxRuntime: {
    url: `https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.directml/${onnxRuntimeVersion}/microsoft.ml.onnxruntime.directml.${onnxRuntimeVersion}.nupkg`,
    path: join(cacheDir, `microsoft.ml.onnxruntime.directml.${onnxRuntimeVersion}.nupkg`),
  },
  directMl: {
    url: `https://api.nuget.org/v3-flatcontainer/microsoft.ai.directml/${directMlVersion}/microsoft.ai.directml.${directMlVersion}.nupkg`,
    path: join(cacheDir, `microsoft.ai.directml.${directMlVersion}.nupkg`),
  },
};

const localModelCandidates = [
  process.env.TRANSNETV2_ONNX_PATH,
  join(cacheDir, "transnetv2.onnx"),
  process.env.TEMP
    ? join(process.env.TEMP, "linecut-transnet-check", "transnetv2.onnx")
    : undefined,
].filter(Boolean);

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function download(url, outputPath, redirects = 0) {
  if (existsSync(outputPath)) {
    return Promise.resolve();
  }
  ensureDirectory(dirname(outputPath));
  const client = url.startsWith("https:") ? https : http;
  return new Promise((resolvePromise, rejectPromise) => {
    const request = client.get(url, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirects >= 8) {
          rejectPromise(new Error(`Too many redirects while downloading ${url}`));
          return;
        }
        const redirected = new URL(location, url).toString();
        download(redirected, outputPath, redirects + 1).then(resolvePromise, rejectPromise);
        return;
      }
      if (status !== 200) {
        response.resume();
        rejectPromise(new Error(`Download failed for ${url}: HTTP ${status}`));
        return;
      }
      const file = createWriteStream(outputPath);
      response.pipe(file);
      file.on("finish", () => file.close(resolvePromise));
      file.on("error", (error) => {
        rmSync(outputPath, { force: true });
        rejectPromise(error);
      });
    });
    request.setTimeout(requestTimeoutMs, () => {
      request.destroy(new Error(`Download timed out after ${requestTimeoutMs}ms: ${url}`));
    });
    request.on("error", (error) => {
      rmSync(outputPath, { force: true });
      rejectPromise(error);
    });
  });
}

async function downloadWithRetry(url, outputPath) {
  for (let attempt = 1; attempt <= maxDownloadAttempts; attempt += 1) {
    try {
      await download(url, outputPath);
      return;
    } catch (error) {
      rmSync(outputPath, { force: true });
      if (attempt === maxDownloadAttempts) {
        throw error;
      }
      const delayMs = 1500 * attempt;
      console.warn(`Download attempt ${attempt} failed for ${url}; retrying in ${delayMs}ms`);
      await wait(delayMs);
    }
  }
}

function extractNuget(name, archivePath) {
  const target = join(extractDir, name);
  rmSync(target, { recursive: true, force: true });
  ensureDirectory(target);
  execFileSync("tar", ["-xf", archivePath, "-C", target], { cwd: root, stdio: "inherit" });
  return target;
}

function copyIfPresent(source, destination) {
  if (!existsSync(source)) {
    return false;
  }
  copyFileSync(source, destination);
  return true;
}

function copyRequired(source, destination) {
  if (!copyIfPresent(source, destination)) {
    throw new Error(`Required TransNetV2 asset was not found: ${source}`);
  }
}

function isNonEmptyFile(path) {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function copyFirstPresent(sources, destination) {
  if (isNonEmptyFile(destination)) {
    return true;
  }
  for (const source of sources) {
    if (!source || !isNonEmptyFile(source)) {
      continue;
    }
    if (resolve(source) === resolve(destination)) {
      return true;
    }
    ensureDirectory(dirname(destination));
    copyFileSync(source, destination);
    console.log(`Reused local TransNetV2 model from ${source}`);
    return true;
  }
  return false;
}

async function prepareModel() {
  if (copyFirstPresent(localModelCandidates, downloads.model.path)) {
    return;
  }
  await downloadWithRetry(downloads.model.url, downloads.model.path);
}

function prepareOnnxRuntime(extracted) {
  copyRequired(
    join(extracted, "runtimes", "win-x64", "native", "onnxruntime.dll"),
    join(resourcesDir, "onnxruntime.dll"),
  );
  copyIfPresent(join(extracted, "LICENSE"), join(resourcesDir, "onnxruntime-LICENSE"));
  copyIfPresent(
    join(extracted, "ThirdPartyNotices.txt"),
    join(resourcesDir, "onnxruntime-ThirdPartyNotices.txt"),
  );
}

function prepareDirectMl(extracted) {
  copyRequired(
    join(extracted, "bin", "x64-win", "DirectML.dll"),
    join(resourcesDir, "DirectML.dll"),
  );
  copyIfPresent(join(extracted, "LICENSE.txt"), join(resourcesDir, "directml-LICENSE.txt"));
  copyIfPresent(
    join(extracted, "LICENSE-CODE.txt"),
    join(resourcesDir, "directml-LICENSE-CODE.txt"),
  );
  copyIfPresent(
    join(extracted, "ThirdPartyNotices.txt"),
    join(resourcesDir, "directml-ThirdPartyNotices.txt"),
  );
}

async function main() {
  ensureDirectory(cacheDir);
  ensureDirectory(resourcesDir);
  await prepareModel();
  await downloadWithRetry(downloads.onnxRuntime.url, downloads.onnxRuntime.path);
  await downloadWithRetry(downloads.directMl.url, downloads.directMl.path);

  const onnxRuntimeExtracted = extractNuget("onnxruntime-directml", downloads.onnxRuntime.path);
  const directMlExtracted = extractNuget("directml", downloads.directMl.path);
  prepareOnnxRuntime(onnxRuntimeExtracted);
  prepareDirectMl(directMlExtracted);

  for (const file of ["transnetv2.onnx", "onnxruntime.dll", "DirectML.dll"]) {
    const path = join(resourcesDir, file);
    if (!existsSync(path)) {
      throw new Error(`Missing prepared asset: ${path}`);
    }
  }
  console.log(`TransNetV2 assets are ready in ${resourcesDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
