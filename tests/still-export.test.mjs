import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function loadModule(path, imports) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  runInNewContext(compiled, { exports, require: (path) => imports[path] });
  return exports;
}

const cuts = loadModule("../src/core/editor/storyboardCuts.ts", {
  "./storyboard": loadModule("../src/core/editor/storyboard.ts", {}),
  "./timeline": { frameToTimeUs: (frame, rate) => Math.round((frame / rate) * 1_000_000) },
});

test("toolbar and timeline cuts reject endpoints, existing cuts and deleted gaps", () => {
  const empty = { shots: [], deletedShots: [], shotAnnotations: {}, shotStacks: [] };
  for (const frame of [0, 100, 101, -1, 1.5])
    assert.equal(cuts.canAddStoryboardCut(empty, frame, 100), false);
  assert.equal(cuts.canAddStoryboardCut(undefined, 1, 100), true);
  assert.equal(cuts.canAddStoryboardCut(empty, 99, 100), true);
  const split = cuts.splitStoryboardShot(empty, 40, 25, "new", 100, 4_000_000);
  assert.equal(split.shots.length, 2);
  assert.equal(split.shots[1].start_frame, 40);
  assert.equal(cuts.canAddStoryboardCut(split, 40, 100), false);
  assert.equal(cuts.canAddStoryboardCut(split, 41, 100), true);
  const deleted = { ...split, shots: [split.shots[0]], deletedShots: [split.shots[1]] };
  assert.equal(cuts.canAddStoryboardCut(deleted, 60, 100), false);
  assert.equal(cuts.canAddStoryboardCut({ ...empty, deletedShots: split.shots }, 60, 100), false);
});

function taskHarness({
  switchDuringExport = false,
  switchDuringImport = false,
  failure = false,
  unsaved = false,
} = {}) {
  const calls = [];
  let projectId = unsaved ? null : "project-a";
  const task = {
    cancelled: false,
    update: () => calls.push("update"),
    remove: () => calls.push("remove"),
    fail: () => calls.push("failed"),
  };
  const module = loadModule("../src/application/media/stillExportTask.ts", {
    "../../errors": {
      invokeCommand: async (command, args) => {
        calls.push({ command, args });
        if (failure) throw new Error("offline original");
        if (switchDuringExport) projectId = "project-b";
        return "/output/still.png";
      },
    },
    "../../errors/runtime": { normalizeError: (error) => error },
    "../../platform/tauri/ffmpegProgress": {
      cancelFfmpegTask: async () => {},
      createFfmpegTaskId: () => "still-task",
      listenToFfmpegTaskProgress: () => () => {},
    },
    "../../systems/ProjectSystem": {
      getProjectExportContext: () => ({ projectId }),
      getProjectWorkspaceSnapshot: () => ({
        projects: projectId === "project-b" ? [] : [{ asset: { id: "original-asset" } }],
      }),
      applyImportedMediaResult: () => calls.push("applied"),
    },
    "../../systems/TaskSystem": { createTaskProgress: async () => task },
    "./mediaImportTask": {
      runMediaImportTask: async ({ path, onSuccess }) => {
        calls.push({ importPath: path });
        if (switchDuringImport) projectId = "project-b";
        onSuccess({});
      },
    },
  });
  const request = {
    assetId: "original-asset",
    mediaName: "renamed.mov",
    frame: 254,
    frameRate: 25,
    timecode: "00_00_10_04",
    projectId,
    proxyPath: "/proxy/low-resolution.mp4",
  };
  const settings = {
    name: "renamed.mov.00_00_10_04.Still001",
    automaticName: true,
    directory: "/output",
    format: "png",
    importIntoProject: true,
  };
  return { calls, run: () => module.runStillExportTask(request, settings) };
}

test("still export snapshots frame and media-bin name, exports original asset and imports output", async () => {
  const harness = taskHarness();
  await harness.run();
  const command = harness.calls[0];
  assert.equal(command.command, "export_still_frame");
  assert.equal(command.args.assetId, "original-asset");
  assert.equal(command.args.options.mediaName, "renamed.mov");
  assert.equal(command.args.options.frame, 254);
  assert.equal(command.args.options.timecode, "00_00_10_04");
  assert.equal("proxyPath" in command.args.options, false);
  assert.ok(harness.calls.some((call) => call.importPath === "/output/still.png"));
  assert.ok(harness.calls.includes("applied"));
});

test("switching projects before or during import never adds a still to another project", async () => {
  for (const options of [
    { switchDuringExport: true },
    { switchDuringImport: true },
    { unsaved: true, switchDuringExport: true },
    { unsaved: true, switchDuringImport: true },
  ]) {
    const harness = taskHarness(options);
    await harness.run();
    assert.equal(harness.calls.includes("applied"), false);
  }
});

test("an unsaved media-import session can import its exported frame", async () => {
  const harness = taskHarness({ unsaved: true });
  await harness.run();
  assert.ok(harness.calls.includes("applied"));
});

test("failed original-frame export reports failure and never starts import", async () => {
  const harness = taskHarness({ failure: true });
  await harness.run();
  assert.ok(harness.calls.includes("failed"));
  assert.equal(
    harness.calls.some((call) => call.importPath),
    false,
  );
});
