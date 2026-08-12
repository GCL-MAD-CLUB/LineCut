import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import https from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "8.0.1";
const archiveName = `ffmpeg-${version}-essentials_build.zip`;
const archiveUrl = `https://github.com/GyanD/codexffmpeg/releases/download/${version}/${archiveName}`;
const archiveSha256 = "e2aaeaa0fdbc397d4794828086424d4aaa2102cef1fb6874f6ffd29c0b88b673";
const maxDownloadAttempts = 4;
const requestIdleTimeoutMilliseconds = 60_000;
const downloadTimeoutMilliseconds = 15 * 60_000;
const expectedArchiveSha256 = process.env.LINECUT_FFMPEG_ARCHIVE_SHA256 ?? archiveSha256;
const cacheDir = resolve(
  process.env.LINECUT_FFMPEG_CACHE_DIR ?? join(root, ".cache", "ffmpeg-assets", version),
);
const archivePath = join(cacheDir, archiveName);
const extractDir = join(cacheDir, "extract");
const outputDir = resolve(process.env.LINECUT_FFMPEG_OUTPUT_DIR ?? join(root, "src-tauri", "bin"));
const outputs = {
  "ffmpeg.exe": join(outputDir, "ffmpeg-x86_64-pc-windows-msvc.exe"),
  "ffprobe.exe": join(outputDir, "ffprobe-x86_64-pc-windows-msvc.exe"),
};

function download(url, outputPath, redirects = 0) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let request;
    let responseStream;
    let outputStream;
    let timeout;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rmSync(outputPath, { force: true });
      rejectPromise(error);
    };
    timeout = setTimeout(() => {
      const error = new Error(`Download timed out after ${downloadTimeoutMilliseconds}ms: ${url}`);
      request?.destroy(error);
      responseStream?.destroy(error);
      outputStream?.destroy(error);
      rejectOnce(error);
    }, downloadTimeoutMilliseconds);
    request = https.get(url, { headers: { "User-Agent": "LineCut-build" } }, (response) => {
      responseStream = response;
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirects >= 8) {
          rejectOnce(new Error(`Too many redirects while downloading ${url}`));
          return;
        }
        download(new URL(location, url).toString(), outputPath, redirects + 1).then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolvePromise();
        }, rejectOnce);
        return;
      }
      if (status !== 200) {
        response.resume();
        rejectOnce(new Error(`Download failed for ${url}: HTTP ${status}`));
        return;
      }
      outputStream = createWriteStream(outputPath);
      response.pipe(outputStream);
      outputStream.on("finish", () => {
        outputStream.close(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolvePromise();
        });
      });
      outputStream.on("error", rejectOnce);
      response.on("aborted", () => rejectOnce(new Error(`Download aborted: ${url}`)));
      response.on("error", rejectOnce);
    });
    request.setTimeout(requestIdleTimeoutMilliseconds, () =>
      request.destroy(
        new Error(`Download received no data for ${requestIdleTimeoutMilliseconds}ms: ${url}`),
      ),
    );
    request.on("error", rejectOnce);
  });
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
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
      const delayMilliseconds = 1500 * attempt;
      console.warn(`Download attempt ${attempt} failed; retrying in ${delayMilliseconds}ms`);
      await wait(delayMilliseconds);
    }
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function findFile(directory, name) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    } else if (entry.name === name) {
      return path;
    }
  }
  return undefined;
}

async function main() {
  if (Object.values(outputs).every(existsSync)) {
    console.log("FFmpeg bundle assets are already present");
    return;
  }

  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  if (!existsSync(archivePath)) {
    await downloadWithRetry(archiveUrl, archivePath);
  }

  const actualSha256 = sha256(archivePath);
  if (actualSha256 !== expectedArchiveSha256) {
    rmSync(archivePath, { force: true });
    throw new Error(`FFmpeg archive checksum mismatch: ${actualSha256}`);
  }

  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["-xf", archivePath, "-C", extractDir], { stdio: "inherit" });

  for (const [name, outputPath] of Object.entries(outputs)) {
    const source = findFile(extractDir, name);
    if (!source) {
      throw new Error(`${name} was not found in ${archiveName}`);
    }
    copyFileSync(source, outputPath);
  }

  console.log(`Prepared FFmpeg ${version} bundle assets in ${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
