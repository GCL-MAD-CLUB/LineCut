// Run with: node --experimental-strip-types scripts/test-import-workspace.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  breadcrumbs,
  mediaKind,
  parentDirectory,
  pathKey,
} from "../src/components/ImportWorkspace/importBrowserModel.ts";
import { mergeMediaAnalysis } from "../src/systems/ProjectSystem/mediaAnalysisMerge.ts";
import {
  createVirtualBindingCopy,
  inferMediaAutoBindings,
  mediaNameMatchScore,
  prepareMediaAutoBindings,
} from "../src/mediaAutoBinding.ts";

// Resolve the dependency for Node's type-stripping runner without changing Vite imports.
const scannerSource = readFileSync(
  new URL("../src/components/ImportWorkspace/importFolderScan.ts", import.meta.url),
  "utf8",
).replace(
  '"./importBrowserModel"',
  JSON.stringify(
    new URL("../src/components/ImportWorkspace/importBrowserModel.ts", import.meta.url).href,
  ),
);
const scannerJs = ts.transpileModule(scannerSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { scanImportFolder, collectSelectionFiles } = await import(
  `data:text/javascript;base64,${Buffer.from(scannerJs).toString("base64")}`
);

const entry = (path, directory = false) => ({
  path,
  name: path.split("/").at(-1),
  is_directory: directory,
  is_hidden: false,
  size: 1,
  created_at: null,
});
const directory = (path, entries, canonical = path) => ({
  directory: path,
  canonical_path: canonical,
  parent: null,
  entries,
});

test("folder scanning reports increasing counts while recursively finding all supported media", async () => {
  const tree = {
    "D:/clips": directory("D:/clips", [
      entry("D:/clips/a.mp4"),
      entry("D:/clips/notes.txt"),
      entry("D:/clips/nested", true),
    ]),
    "D:/clips/nested": directory("D:/clips/nested", [
      entry("D:/clips/nested/b.wav"),
      entry("D:/clips/nested/c.ass"),
      entry("D:/clips/nested/deep", true),
    ]),
    "D:/clips/nested/deep": directory("D:/clips/nested/deep", [
      entry("D:/clips/nested/deep/d.PNG"),
    ]),
  };
  const counts = [];
  await scanImportFolder(
    "D:/clips",
    async (path) => tree[path],
    new AbortController().signal,
    (files) => counts.push(files.length),
  );
  assert.deepEqual(counts, [1, 3, 4]);
});

test("folder and individual-file selections deduplicate overlapping files and exclude imported media", () => {
  const a = entry("D:/clips/a.mp4");
  const b = entry("D:/clips/nested/b.wav");
  const c = entry("D:/clips/nested/c.ass");
  const items = [
    { entry: entry("D:/clips", true), files: [a, b, c] },
    { entry: entry("D:/clips/nested", true), files: [b, c] },
    { entry: a, files: [a] },
  ];
  assert.deepEqual(collectSelectionFiles(items, new Set([pathKey(c.path)])), [a, b]);
});

test("deselecting a folder stops traversal and ignores a late directory response", async () => {
  const controller = new AbortController();
  let updates = 0;
  let reads = 0;
  await scanImportFolder(
    "D:/clips",
    async () => {
      reads += 1;
      controller.abort();
      return directory("D:/clips", [entry("D:/clips/a.mp4"), entry("D:/clips/nested", true)]);
    },
    controller.signal,
    () => (updates += 1),
  );
  assert.equal(updates, 0);
  assert.equal(reads, 1);
});

test("canonical directory identities stop junction cycles", async () => {
  let reads = 0;
  let count = 0;
  await scanImportFolder(
    "D:/clips",
    async (path) => {
      reads += 1;
      assert.ok(reads <= 2, "junction cycle must terminate");
      return directory(path, [entry(`${path}/a.mp4`), entry(`${path}/loop`, true)], "D:/clips");
    },
    new AbortController().signal,
    (files) => (count = files.length),
  );
  assert.equal(count, 1);
  assert.equal(reads, 2);
});

test("unreadable nested folders are reported while readable siblings continue", async () => {
  const tree = {
    "D:/clips": directory("D:/clips", [
      entry("D:/clips/private", true),
      entry("D:/clips/good", true),
    ]),
    "D:/clips/good": directory("D:/clips/good", [entry("D:/clips/good/a.mp4")]),
  };
  let result;
  await scanImportFolder(
    "D:/clips",
    async (path) => tree[path] ?? null,
    new AbortController().signal,
    (files, unreadable) => (result = { files, unreadable }),
  );
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.unreadable, ["D:/clips/private"]);
});

test("Windows paths keep drive roots and deduplicate slash/case variants", () => {
  assert.equal(parentDirectory("D:\\clip.mp4"), "D:\\");
  assert.equal(parentDirectory("D:/Media/clip.mp4"), "D:/Media");
  assert.equal(pathKey("D:\\Media\\CLIP.mp4"), pathKey("d:/media/clip.mp4"));
  assert.equal(breadcrumbs("D:\\Media")[0].path, "D:\\");
});

test("POSIX paths retain case and absolute roots", () => {
  assert.notEqual(pathKey("/Media/Clip.mp4"), pathKey("/media/clip.mp4"));
  assert.equal(parentDirectory("/clip.mp4"), "/");
  assert.equal(breadcrumbs("/home/media")[1].path, "/home");
});

test("file filters preserve existing subtitle imports and recognize images", () => {
  assert.equal(mediaKind("movie.MKV"), "video");
  assert.equal(mediaKind("track.FLAC"), "audio");
  assert.equal(mediaKind("cover.PNG"), "image");
  assert.equal(mediaKind("captions.ASS"), "subtitle");
  assert.equal(mediaKind("notes.txt"), null);
});

const asset = { id: "video", path: "D:/clip.mp4", fingerprint: "original" };
const existing = { id: "edited", source_type: "embedded", stream_index: 2, offset_us: 12345 };
const external = { id: "external", source_type: "external", stream_index: null };
const newTrack = { id: "new", source_type: "embedded", stream_index: 3 };
const current = {
  asset,
  streams: [],
  tracks: [existing, external],
  cues: { edited: [{ id: "user-cue", plain_text: "edited text" }], external: [] },
  proxy_path: "D:/user-proxy.mp4",
};
const analyzed = {
  ...current,
  tracks: [{ ...existing, id: "background", offset_us: 0 }, newTrack],
  cues: { background: [{ plain_text: "original text" }], new: [{ id: "discovered" }] },
  proxy_path: null,
};

test("analysis adds new embedded tracks without overwriting edits, external subtitles or proxies", () => {
  const merged = mergeMediaAnalysis(current, analyzed);
  assert.deepEqual(merged.tracks, [existing, external, newTrack]);
  assert.equal(merged.cues.edited, current.cues.edited);
  assert.equal(merged.cues.external, current.cues.external);
  assert.equal(merged.cues.new, analyzed.cues.new);
  assert.equal(merged.proxy_path, current.proxy_path);
  assert.equal(current.tracks.length, 2);
});

test("analysis cannot apply to relinked or replaced media", () => {
  assert.equal(
    mergeMediaAnalysis(current, { ...analyzed, asset: { ...asset, path: "D:/other.mp4" } }),
    current,
  );
  assert.equal(
    mergeMediaAnalysis(current, { ...analyzed, asset: { ...asset, fingerprint: "changed" } }),
    current,
  );
});

test("repeated analysis results do not duplicate tracks or reset user cues", () => {
  const first = mergeMediaAnalysis(current, analyzed);
  assert.equal(mergeMediaAnalysis(first, analyzed), first);
});

const bindingItem = (id, kind, fileName, startTimeUs, durationUs) => ({
  id,
  bin_id: null,
  kind,
  enabled: true,
  hidden: false,
  offline: false,
  path: `D:/media/${fileName}`,
  file_name: fileName,
  duration_us: durationUs,
  start_time_us: startTimeUs,
  bound_to_video_id: null,
  source_video_id: null,
  stream_index: 0,
  subtitle_track_id: null,
  codec: null,
  language: null,
  extracted: false,
  origin: "imported",
  color: "#000",
});

test("auto binding treats common audio and subtitle suffixes as the same media name", () => {
  assert.ok(mediaNameMatchScore("Episode 01.mp4", "Episode 01_audio.wav") >= 0.98);
  assert.ok(mediaNameMatchScore("旅行-03.mkv", "旅行-03 字幕.ass") >= 0.98);
});

test("smart binding uses time to disambiguate equally named videos", () => {
  const early = bindingItem("video-a", "video", "camera.mp4", 0, 60_000_000);
  const late = bindingItem("video-b", "video", "camera.mov", 80_000_000, 40_000_000);
  const audio = bindingItem("audio", "audio", "camera_audio.wav", 79_000_000, 40_500_000);
  assert.deepEqual(
    inferMediaAutoBindings([early, late, audio], "all", "smart")[0].videoId,
    "video-b",
  );
  assert.deepEqual(
    inferMediaAutoBindings([early, late, audio], "all", "name")[0].videoId,
    "video-a",
  );
});

test("auto binding respects type filters and rejects unrelated names", () => {
  const video = bindingItem("video", "video", "scene-20.mp4", 0, 10_000_000);
  const audio = bindingItem("audio", "audio", "totally-different.wav", 0, 10_000_000);
  const subtitle = bindingItem("subtitle", "subtitle", "scene-20.ass", 0, 0);
  assert.deepEqual(inferMediaAutoBindings([video, audio, subtitle], "audio", "smart"), []);
  assert.deepEqual(
    inferMediaAutoBindings([video, audio, subtitle], "subtitle", "name").map((pair) => pair.itemId),
    ["subtitle"],
  );
});

test("auto binding does not cross episode numbers or use imported images as targets", () => {
  assert.ok(mediaNameMatchScore("episode-01.wav", "episode-02.mp4") < 0.72);
  const image = bindingItem("image", "video", "episode-01.png", 0, 10_000_000);
  const audio = bindingItem("audio", "audio", "episode-01.wav", 0, 10_000_000);
  assert.deepEqual(inferMediaAutoBindings([image, audio], "all", "smart"), []);
});

test("virtual binding copies preserve the source and start unbound", () => {
  const source = bindingItem("audio", "audio", "scene.wav", 0, 10_000_000);
  const copy = createVirtualBindingCopy(source);
  assert.match(copy.id, /^media-copy:/);
  assert.equal(copy.source_video_id, source.id);
  assert.equal(copy.bound_to_video_id, null);
  assert.equal(source.source_video_id, null);
  assert.equal(source.bound_to_video_id, null);
});

test("virtual-copy binding plans keep originals and bind only generated references", () => {
  const video = bindingItem("video", "video", "scene.mp4", 0, 10_000_000);
  const audio = bindingItem("audio", "audio", "scene_audio.wav", 0, 10_000_000);
  const prepared = prepareMediaAutoBindings([video, audio], "all", "virtual-copy", "smart");
  assert.equal(prepared.copies.length, 1);
  assert.equal(prepared.bindings[0].videoId, video.id);
  assert.equal(prepared.bindings[0].itemId, prepared.copies[0].id);
  assert.notEqual(prepared.bindings[0].itemId, audio.id);
  assert.equal(audio.bound_to_video_id, null);
});
