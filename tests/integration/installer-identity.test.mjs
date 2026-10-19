// Manual NSIS fixtures using mock programs, temporary files and isolated HKCU keys only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "win32");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const target = join(root, "src-tauri/target");
mkdirSync(target, { recursive: true });
const temporary = mkdtempSync(join(target, "installer identity "));
const registry = `Software\\LocutionProIdentityTests\\${randomUUID()}`;
const template = readFileSync(join(root, "src-tauri/windows/installer.nsi"), "utf8");
const compiler =
  process.env.NSIS_MAKENSIS ?? join(process.env.LOCALAPPDATA, "tauri/NSIS/makensis.exe");
const nsis = (value) => value.replaceAll("$", () => "$$").replaceAll('"', '$\\"');
const run = (program, args, expected = 0, verbatim = false) => {
  // NSIS requires /D= to be the final unquoted argument, even for paths with spaces.
  const result = spawnSync(program, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(verbatim ? { windowsVerbatimArguments: true, argv0: `"${program}"` } : {}),
  });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${program}: ${result.stdout}\n${result.stderr}`);
};
const functionSource = (name) =>
  template.match(new RegExp(`Function ${name}\\r?\\n[\\s\\S]*?FunctionEnd`, "u"))[0];
const componentChoice = template.slice(
  template.indexOf("  ; Restore the component choice"),
  template.indexOf("FunctionEnd", template.indexOf("  ; Restore the component choice")),
);
const registration = template.slice(
  template.indexOf("  ; Save $INSTDIR in registry"),
  template.indexOf("  ; Create start menu shortcut"),
);
const compile = (name, body) => {
  const executable = join(temporary, `${name}.exe`);
  const script = join(temporary, `${name}.nsi`);
  writeFileSync(
    script,
    `Unicode true\n!include "MUI2.nsh"\n!include "FileFunc.nsh"\nName "Identity fixture"\nOutFile "${nsis(executable)}"\nRequestExecutionLevel user\nSilentInstall silent\n${body}`,
    "utf8",
  );
  run(compiler, ["/V2", "/INPUTCHARSET", "UTF8", script]);
  return executable;
};
const query = (key) =>
  spawnSync("reg.exe", ["query", `HKCU\\${registry}\\${key}`], { windowsHide: true }).status;

try {
  const uninstaller = compile(
    "mock uninstall",
    `Section
  \${GetOptions} $CMDLINE "_?=" $R0
  FileOpen $0 "$R0\\uninstall-args.txt" w
  FileWrite $0 $CMDLINE
  FileClose $0
  \${GetOptions} $CMDLINE "/FAIL" $1
  \${IfNot} \${Errors}
    SetErrorLevel 1
    Quit
  \${EndIf}
  \${GetOptions} $CMDLINE "/KEEP" $1
  \${If} \${Errors}
    Delete "$R0\\linecut.exe"
  \${EndIf}
SectionEnd`,
  );
  const migration = compile(
    "mock migration",
    `Section
  FileOpen $0 "$EXEDIR\\migration-args.txt" w
  FileWrite $0 $CMDLINE
  FileClose $0
SectionEnd`,
  );
  // Retain the production publisher definition, only relocating its root to the test namespace.
  const legacyProductDefine = template
    .match(/^!define LEGACY_MANUPRODUCTKEY .+$/mu)[0]
    .replace("Software\\", `${registry}\\`);
  const cases = [
    { name: "fresh" },
    { name: "legacy-equal-version", legacy: true },
    { name: "current", current: true },
    { name: "both-update", legacy: true, current: true },
    { name: "missing-product-key", legacy: true, noProduct: true },
    { name: "uninstall-path-fallback", legacy: true, noProduct: true, noLocation: true },
    { name: "orphan-product-key", legacy: true, noUninstall: true },
    { name: "uninstaller-failure", legacy: true, fail: "/FAIL" },
    { name: "uninstaller-keeps-binary", legacy: true, fail: "/KEEP" },
  ];
  for (const entry of cases) {
    const directory = join(temporary, entry.name);
    const old = join(directory, "old LineCut");
    const current = join(directory, "new Locution Pro");
    mkdirSync(old, { recursive: true });
    mkdirSync(current, { recursive: true });
    if (entry.legacy) {
      copyFileSync(uninstaller, join(old, "uninstall.exe"));
      writeFileSync(join(old, "linecut.exe"), "old executable");
      writeFileSync(join(old, "preferences.json"), "preserve old settings");
    }
    copyFileSync(migration, join(current, "locution-pro.exe"));
    const seedLegacy = entry.legacy
      ? `
  ${entry.noProduct ? "" : `WriteRegStr SHCTX "${registry}\\linecut\\LineCut" "" "${nsis(old)}"\nWriteRegDWORD SHCTX "${registry}\\linecut\\LineCut" "BundleSemanticSearch" 0`}
  ${entry.noUninstall ? "" : `WriteRegStr SHCTX "\${LEGACY_UNINSTKEY}" "UninstallString" '$\\"${nsis(old)}\\uninstall.exe$\\"${entry.fail ? ` ${entry.fail}` : ""}'`}
  ${entry.noLocation || entry.noUninstall ? "" : `WriteRegStr SHCTX "\${LEGACY_UNINSTKEY}" "InstallLocation" '$\\"${nsis(old)}$\\"'`}
  ${entry.noUninstall ? "" : `WriteRegStr SHCTX "\${LEGACY_UNINSTKEY}" "MainBinaryName" "linecut.exe"\nWriteRegStr SHCTX "\${LEGACY_UNINSTKEY}" "DisplayVersion" "0.3.3"`}
`
      : "";
    const executable = compile(
      entry.name,
      `
!define UNINSTKEY "${registry}\\current-uninstall"
!define MANUPRODUCTKEY "${registry}\\locutionpro\\Locution Pro"
!define LEGACY_UNINSTKEY "${registry}\\legacy-uninstall"
!define LEGACY_PRODUCTNAME "LineCut"
${legacyProductDefine}
!define INSTALLMODE "currentUser"
!define MAINBINARYNAME "locution-pro"
!define PRODUCTNAME "Locution Pro"
!define MANUFACTURER "locutionpro"
!define VERSION "0.3.3"
!define ESTIMATEDSIZE 1
!define HOMEPAGE ""
!macro CheckIfAppIsRunning BINARY NAME
!macroend
Var PreviousUninstallKey
Var PreviousProductKey
Var PreviousInstallDir
Var PreviousMainBinaryName
Var LegacyInstallDir
Var LegacyUninstallCommand
Var LegacyMainBinaryName
Var OldMainBinaryName
Var LocutionProBundleSemantic
Var SavedTarget
${[
  "FindPreviousInstallation",
  "ReadPreviousInstallLocation",
  "RestorePreviousInstallLocation",
  "StripPathQuotes",
  "FindLegacyInstallation",
  "UninstallLegacyInstallation",
  "MigrateLegacyData",
]
  .map(functionSource)
  .join("\n")
  .replaceAll("$LOCALAPPDATA\\LineCut", nsis(join(directory, "default LineCut")))}
Function RenameExistingProductShortcuts
FunctionEnd
Section
  SetShellVarContext current
  DeleteRegKey HKCU "${registry}"
  StrCpy $SavedTarget $INSTDIR
  StrCpy $LocutionProBundleSemantic 1
${seedLegacy}
  ${entry.current ? `WriteRegStr SHCTX "\${UNINSTKEY}" "UninstallString" "current-uninstaller"\nWriteRegStr SHCTX "\${UNINSTKEY}" "InstallLocation" "$INSTDIR"\nWriteRegStr SHCTX "\${MANUPRODUCTKEY}" "" "$INSTDIR"\nWriteRegDWORD SHCTX "\${MANUPRODUCTKEY}" "BundleSemanticSearch" 1` : ""}
  Call FindPreviousInstallation
  Call RestorePreviousInstallLocation
  FileOpen $5 "$SavedTarget\\resolved.txt" w
  FileWrite $5 $PreviousInstallDir
  FileClose $5
  StrCpy $INSTDIR $SavedTarget
${componentChoice}
  FileOpen $5 "$INSTDIR\\choice.txt" w
  FileWrite $5 $LocutionProBundleSemantic
  FileClose $5
  Call UninstallLegacyInstallation
${registration}
  Call MigrateLegacyData
  FileOpen $5 "$INSTDIR\\complete.txt" w
  FileWrite $5 "Locution Pro"
  FileClose $5
SectionEnd`,
    );
    run(executable, ["/S", "/UPDATE", `/D=${current}`], entry.fail ? 2 : 0, true);
    if (entry.legacy) {
      const args = readFileSync(join(old, "uninstall-args.txt"), "utf8");
      assert(args.includes("/S /UPDATE"), `${entry.name}: no hidden wizard or data deletion`);
      assert(args.endsWith(`_?=${old}`), `${entry.name}: full path including spaces`);
      assert.equal(readFileSync(join(old, "preferences.json"), "utf8"), "preserve old settings");
      assert.equal(existsSync(join(old, "linecut.exe")), !!entry.fail, entry.name);
    }
    if (entry.fail) {
      assert.equal(query("legacy-uninstall"), 0, "Uninstall failure retains registration");
      assert(!existsSync(join(current, "complete.txt")));
      assert(!existsSync(join(current, "migration-args.txt")));
      continue;
    }
    assert.equal(query("legacy-uninstall"), 1, `${entry.name}: legacy registration removed`);
    assert.equal(query("linecut\\LineCut"), 1, `${entry.name}: old publisher key removed`);
    assert(
      existsSync(join(current, "complete.txt")),
      JSON.stringify(readdirSync(directory, { recursive: true })),
    );
    assert.equal(readFileSync(join(current, "complete.txt"), "utf8"), "Locution Pro");
    assert(
      readFileSync(join(current, "migration-args.txt"), "utf8").endsWith(
        "--migrate-legacy-data --migration-silent",
      ),
    );
    if (entry.name === "legacy-equal-version") {
      assert.equal(readFileSync(join(current, "resolved.txt"), "utf8"), old);
      assert.equal(readFileSync(join(current, "choice.txt"), "utf8"), "0");
    }
    if (entry.current) assert.equal(readFileSync(join(current, "choice.txt"), "utf8"), "1");
  }
  console.log(
    "Passed: old/new publishers, equal-version/update uninstall, quoted path fallbacks, orphan recovery, failure retention, component choices, installer migration invocation.",
  );
} finally {
  assert(/^Software\\LocutionProIdentityTests\\[a-f0-9-]+$/u.test(registry));
  spawnSync("reg.exe", ["delete", `HKCU\\${registry}`, "/f"], { windowsHide: true });
  const withinTarget = relative(target, resolve(temporary));
  assert(withinTarget && !withinTarget.startsWith("..") && !isAbsolute(withinTarget));
  rmSync(temporary, { recursive: true, force: true });
}
