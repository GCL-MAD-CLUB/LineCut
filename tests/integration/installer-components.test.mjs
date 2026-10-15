// Compile and run only the real resource-copy blocks in an isolated, silent fixture.
// This does not install LineCut or write its registry entries or shortcuts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "win32", "The NSIS component test requires Windows");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const target = join(root, "src-tauri", "target");
mkdirSync(target, { recursive: true });
const temporary = mkdtempSync(join(target, "installer-components-"));
const template = readFileSync(join(root, "src-tauri/windows/installer.nsi"), "utf8");
const compiler =
  process.env.NSIS_MAKENSIS ?? join(process.env.LOCALAPPDATA, "tauri/NSIS/makensis.exe");
const run = (program, args) => {
  const result = spawnSync(program, args, { encoding: "utf8", windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${program} failed:\n${result.stdout}\n${result.stderr}`);
};
const nsis = (value) => value.replaceAll("$", () => "$$").replaceAll('"', '$\\"');
const resourceNames = [
  "LICENSE",
  "transnetv2\\onnxruntime.dll",
  "semantic-search\\model_quantized.onnx",
  "semantic-search\\model_quantized.onnx_data",
  "semantic-search\\tokenizer.json",
  "semantic-search\\nested\\notice.txt",
];
const binaries = ["ffmpeg.exe", "ffprobe.exe"];

try {
  const fixture = join(temporary, "payload.txt");
  writeFileSync(fixture, "component-test-payload");
  const renderLoop = (source, name, values, render) =>
    source.replace(
      new RegExp(`\\{\\{#each ${name}\\}\\}([\\s\\S]*?)\\{\\{/each\\}\\}`, "u"),
      (_, body) => values.map((value) => render(body, value)).join("\n"),
    );
  let copyBlock = template.slice(
    template.indexOf("  ; Copy resources"),
    template.indexOf("  ; Create file associations"),
  );
  copyBlock = renderLoop(
    copyBlock,
    "resources_dirs",
    ["", "transnetv2", "semantic-search", "semantic-search\\nested"],
    (body, value) => body.replaceAll("{{this}}", value),
  );
  copyBlock = renderLoop(copyBlock, "resources", resourceNames, (body, value) =>
    body.replaceAll("{{this.[1]}}", value).replaceAll("{{no-escape @key}}", nsis(fixture)),
  );
  copyBlock = renderLoop(copyBlock, "binaries", binaries, (body, value) =>
    body.replaceAll("{{this}}", value).replaceAll("{{no-escape @key}}", nsis(fixture)),
  );
  assert(!copyBlock.includes("{{"), "All resource template values must be rendered");
  const executable = join(temporary, "components.exe");
  const script = join(temporary, "components.nsi");
  writeFileSync(
    script,
    `Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "${nsis(join(root, "src-tauri/windows/semantic-options.nsh"))}"
Name "LineCut component test"
OutFile "${nsis(executable)}"
RequestExecutionLevel user
SilentInstall silent
Var LineCutBundleFfmpeg
Function SkipIfPassive
  Abort
FunctionEnd
Function .onInit
  ${template.match(/StrCpy \$LineCutBundleSemantic 1/u)[0]}
  StrCpy $LineCutBundleFfmpeg 1
  \${GetOptions} $CMDLINE "/SEMANTIC=" $0
  \${IfNot} \${Errors}
    StrCpy $LineCutBundleSemantic $0
  \${EndIf}
  \${GetOptions} $CMDLINE "/FFMPEG=" $0
  \${IfNot} \${Errors}
    StrCpy $LineCutBundleFfmpeg $0
  \${EndIf}
FunctionEnd
Section
  SetOutPath $INSTDIR
${copyBlock}
SectionEnd
`,
    "utf8",
  );
  run(compiler, ["/V2", script]);
  const cases = [
    { name: "default", semantic: true, ffmpeg: true, args: [] },
    { name: "without-semantic", semantic: false, ffmpeg: true, args: ["/SEMANTIC=0"] },
    { name: "remove-old-model", semantic: false, ffmpeg: true, args: ["/SEMANTIC=0"], old: true },
    { name: "without-ffmpeg", semantic: true, ffmpeg: false, args: ["/FFMPEG=0"] },
  ];
  for (const entry of cases) {
    const install = join(temporary, entry.name);
    if (entry.old) {
      mkdirSync(join(install, "semantic-search"), { recursive: true });
      writeFileSync(join(install, "semantic-search/stale-model.bin"), "old-model");
    }
    run(executable, ["/S", ...entry.args, `/D=${install}`]);
    for (const name of resourceNames) {
      assert.equal(
        existsSync(join(install, name)),
        name.startsWith("semantic-search\\") ? entry.semantic : true,
        `${entry.name}: ${name}`,
      );
    }
    assert.equal(existsSync(join(install, "semantic-search")), entry.semantic, entry.name);
    for (const name of binaries) {
      assert.equal(existsSync(join(install, name)), entry.ffmpeg, `${entry.name}: ${name}`);
    }
    assert(!existsSync(join(install, "semantic-search/stale-model.bin")), "Old models removed");
  }
  console.log(
    "Passed: default inclusion, model omission, stale component removal, shared runtime preservation, independent FFmpeg choice",
  );
} finally {
  // Validate the absolute cleanup target before recursively removing this fixture.
  const withinTarget = relative(target, resolve(temporary));
  assert(withinTarget && !withinTarget.startsWith("..") && !isAbsolute(withinTarget));
  rmSync(temporary, { recursive: true, force: true });
}
