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
    timeout: 20000,
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
const compile = (name, body, silent = true) => {
  const executable = join(temporary, `${name}.exe`);
  const script = join(temporary, `${name}.nsi`);
  writeFileSync(
    script,
    `Unicode true\n!include "MUI2.nsh"\n!include "FileFunc.nsh"\nName "Identity fixture"\nOutFile "${nsis(executable)}"\nRequestExecutionLevel user\n${silent ? "SilentInstall silent" : ""}\n${body}`,
    "utf8",
  );
  run(compiler, ["/V2", "/INPUTCHARSET", "UTF8", script]);
  return executable;
};
const query = (key) =>
  spawnSync("reg.exe", ["query", `HKCU\\${registry}\\${key}`], { windowsHide: true }).status;

try {
  assert(!template.includes("UninstallLegacyInstallation"));
  assert(!template.includes("LEGACY_UNINSTKEY"));
  assert(!template.includes("com.linecut.desktop"));
  const providerId = template
    .match(/!define LCP_THUMBNAIL_PROVIDER_CLSID "\{([^}]+)\}"/u)[1]
    .replaceAll("-", "")
    .toLowerCase();
  const provider = readFileSync(join(root, "src-tauri/thumbnail-provider/src/lib.rs"), "utf8");
  assert(
    provider.includes(
      `0x${providerId.slice(0, 8)}_${providerId.slice(8, 12)}_${providerId.slice(12, 16)}_${providerId.slice(16, 20)}_${providerId.slice(20)}`,
    ),
  );
  assert.notEqual(
    providerId,
    "4f4c9cf564634df7a2b47c3b0cc7e67d",
    "The successor owns a separate COM class",
  );
  const isolatedIndependent = join(temporary, "independent-install.nsh");
  writeFileSync(
    isolatedIndependent,
    readFileSync(join(root, "src-tauri/windows/independent-install.nsh"), "utf8").replaceAll(
      "Software\\Classes\\",
      `${registry}\\Classes\\`,
    ),
  );
  const migration = compile(
    "mock migration",
    `Section
  FileOpen $0 "$EXEDIR\\migration-args.txt" w
  FileWrite $0 $CMDLINE
  FileClose $0
  \${GetOptions} $CMDLINE "--migration-progress" $1
  WriteINIStr $1 "Migration" "State" "complete"
SectionEnd`,
  );
  const cases = [
    { name: "fresh" },
    { name: "linecut-present", legacy: true },
    { name: "empty-linecut-directory", legacy: true, empty: true },
    { name: "linecut-program-only", legacy: true, empty: true, programOnly: true },
    { name: "locution-update", current: true },
    { name: "coexist", legacy: true, current: true },
    { name: "retained-data", legacy: true, data: true },
    { name: "retained-profile", legacy: true, profile: true },
    { name: "retained-registration", legacy: true, history: true },
    { name: "previous-shared-location", legacy: true, current: true, shared: true },
    { name: "reject-linecut-directory", legacy: true, unsafe: "root" },
    { name: "reject-nested-directory", legacy: true, unsafe: "nested" },
  ];
  for (const entry of cases) {
    const directory = join(temporary, entry.name);
    const old = join(directory, "LineCut");
    const current = join(directory, "application");
    const data = join(directory, "data");
    const oldData = join(data, "LineCut");
    if (entry.legacy) {
      mkdirSync(oldData, { recursive: true });
      if (!entry.empty) writeFileSync(join(oldData, "preferences.json"), "{}");
      if (entry.programOnly) writeFileSync(join(oldData, "linecut.exe"), "program only");
    }
    if (entry.data) {
      mkdirSync(join(data, "Locution Pro"), { recursive: true });
      writeFileSync(join(data, "Locution Pro", "retained"), "own data");
    }
    if (entry.profile) mkdirSync(join(data, "com.locutionpro.desktop"), { recursive: true });
    const logs = join(directory, "result");
    mkdirSync(old, { recursive: true });
    mkdirSync(current, { recursive: true });
    mkdirSync(logs);
    if (entry.legacy) {
      writeFileSync(join(old, "linecut.exe"), "LineCut executable");
      writeFileSync(join(old, "uninstall.exe"), "LineCut uninstaller");
      writeFileSync(join(old, "preferences.json"), "original preferences");
    }
    copyFileSync(migration, join(current, "locution-pro.exe"));
    const executable = compile(
      entry.name,
      `
!define UNINSTKEY "${registry}\\current-uninstall"
!define MANUPRODUCTKEY "${registry}\\locutionpro\\Locution Pro"
!define LOCUTION_MIGRATION_LOCAL_ROOT "${nsis(data)}"
!define LOCUTION_MIGRATION_ROAMING_ROOT "${nsis(data)}"
!define INSTALLMODE "currentUser"
!define MAINBINARYNAME "locution-pro"
!define PRODUCTNAME "Locution Pro"
!define MANUFACTURER "locutionpro"
!define VERSION "0.3.3"
!define ESTIMATEDSIZE 1
!define HOMEPAGE ""
Var PreviousUninstallKey
Var PreviousProductKey
Var PreviousInstallDir
Var PreviousMainBinaryName
Var LocutionProBundleSemantic
Var PassiveMode
!include "${nsis(isolatedIndependent)}"
!include "${nsis(join(root, "src-tauri/windows/migration-page.nsh"))}"
${["FindPreviousInstallation", "ReadPreviousInstallLocation", "RestorePreviousInstallLocation", "StripPathQuotes"].map(functionSource).join("\n")}
Section
  SetShellVarContext current
  DeleteRegKey HKCU "${registry}"
  StrCpy $LocutionProBundleSemantic 1
  ${entry.legacy ? `WriteRegStr SHCTX "${registry}\\linecut-uninstall" "UninstallString" '$\\"${nsis(old)}\\uninstall.exe$\\"'\nWriteRegStr SHCTX "${registry}\\linecut-uninstall" "InstallLocation" "${nsis(old)}"\nWriteRegDWORD SHCTX "${registry}\\linecut\\LineCut" "BundleSemanticSearch" 0\nWriteRegStr SHCTX "${registry}\\Classes\\.lcp" "" "LineCut.Project"\nWriteRegStr SHCTX "${registry}\\Classes\\.lcp\\OpenWithProgids" "LineCut.Project" ""\nWriteRegStr SHCTX "${registry}\\Classes\\LineCut.Project" "" "LineCut project"` : ""}
  ${entry.current ? `WriteRegStr SHCTX "\${UNINSTKEY}" "UninstallString" "current-uninstaller"\nWriteRegStr SHCTX "\${UNINSTKEY}" "InstallLocation" '$\\"${nsis(entry.shared ? old : current)}$\\"'\nWriteRegStr SHCTX "\${MANUPRODUCTKEY}" "" "${nsis(entry.shared ? old : current)}"\nWriteRegDWORD SHCTX "\${MANUPRODUCTKEY}" "BundleSemanticSearch" 0` : ""}
  ${entry.history ? `WriteRegDWORD SHCTX "\${MANUPRODUCTKEY}" "BundleSemanticSearch" 1` : ""}
  Call CaptureMigrationEligibility
  Call FindPreviousInstallation
  Call RestorePreviousInstallLocation
  FileOpen $5 "${nsis(join(logs, "location.txt"))}" w
  FileWrite $5 $INSTDIR
  FileClose $5
${componentChoice}
  ${entry.unsafe ? `StrCpy $INSTDIR "${nsis(entry.unsafe === "nested" ? join(old, "Locution Pro") : old)}"` : ""}
  Call EnsureIndependentInstallLocation
  Rename "$INSTDIR\\locution-pro.exe" "$INSTDIR\\worker.tmp"
  Call BeginMigrationSession
  Rename "$INSTDIR\\worker.tmp" "$INSTDIR\\locution-pro.exe"
  FileOpen $5 "$INSTDIR\\choice.txt" w
  FileWrite $5 $LocutionProBundleSemantic
  FileClose $5
${registration}
  !insertmacro LOCUTION_ASSOCIATE "lcp" "LocutionPro.Project" "Locution project" "own.ico" "Open" "own-command"
  ReadRegStr $0 SHCTX "${registry}\\Classes\\.lcp" ""
  FileOpen $5 "${nsis(join(logs, "association.txt"))}" w
  FileWrite $5 $0
  FileClose $5
  !insertmacro LOCUTION_UNASSOCIATE "lcp" "LocutionPro.Project"
  ReadRegStr $0 SHCTX "${registry}\\Classes\\.lcp" ""
  FileOpen $5 "${nsis(join(logs, "after-uninstall.txt"))}" w
  FileWrite $5 $0
  FileClose $5
  Call MigrateLegacyData
  FileOpen $5 "$INSTDIR\\complete.txt" w
  FileWrite $5 "Locution Pro"
  FileClose $5
SectionEnd`,
    );
    run(executable, ["/S", "/UPDATE", `/D=${current}`], entry.unsafe ? 2 : 0, true);
    assert.equal(
      readFileSync(join(logs, "location.txt"), "utf8"),
      current,
      `${entry.name}: independent installation path`,
    );
    if (entry.legacy) {
      assert.equal(readFileSync(join(old, "linecut.exe"), "utf8"), "LineCut executable");
      assert.equal(readFileSync(join(old, "uninstall.exe"), "utf8"), "LineCut uninstaller");
      assert.equal(readFileSync(join(old, "preferences.json"), "utf8"), "original preferences");
      assert.equal(query("linecut-uninstall"), 0, "LineCut uninstall registration is untouched");
      assert.equal(query("linecut\\LineCut"), 0, "LineCut configuration is untouched");
    }
    if (entry.unsafe) {
      assert(!existsSync(join(current, "complete.txt")));
      continue;
    }
    assert.equal(
      readFileSync(join(current, "choice.txt"), "utf8"),
      entry.current ? "0" : "1",
      "Only Locution Pro component choices are restored",
    );
    assert.equal(readFileSync(join(current, "complete.txt"), "utf8"), "Locution Pro");
    assert.equal(
      readFileSync(join(logs, "association.txt"), "utf8"),
      entry.legacy ? "LineCut.Project" : "LocutionPro.Project",
    );
    assert.equal(
      readFileSync(join(logs, "after-uninstall.txt"), "utf8"),
      entry.legacy ? "LineCut.Project" : "",
    );
    if (entry.legacy)
      assert.equal(
        query("Classes\\LineCut.Project"),
        0,
        "LineCut file association survives Locution Pro removal",
      );
    const shouldMigrate = Boolean(
      entry.legacy &&
      !entry.empty &&
      !entry.current &&
      !entry.data &&
      !entry.profile &&
      !entry.history,
    );
    assert.equal(
      existsSync(join(current, "migration-args.txt")),
      shouldMigrate,
      `${entry.name}: first-install gate`,
    );
    if (shouldMigrate) {
      const args = readFileSync(join(current, "migration-args.txt"), "utf8");
      assert(args.includes("--migration-progress"));
      assert(args.includes("--migration-session"));
      const token = readFileSync(
        join(data, "Locution Pro", ".locution-pro-install-session"),
        "utf16le",
      );
      assert.equal(token[0], "\ufeff");
      assert(
        args.includes(token.slice(1)),
        "The real NSIS session marker matches the worker argument",
      );
    }
  }
  // Run a minimal real wizard: the actual embedded migration page must advance
  // automatically in the same HWND, and must remain blocked on error/cancellation.
  assert(
    template.indexOf("!insertmacro MUI_PAGE_INSTFILES") <
      template.indexOf("Page custom MigrationPageCreate MigrationPageLeave"),
  );
  assert(
    template.indexOf("Page custom MigrationPageCreate MigrationPageLeave") <
      template.indexOf("!insertmacro MUI_PAGE_FINISH"),
  );
  assert(!template.includes("MUI_FINISHPAGE_NOAUTOCLOSE"));
  const observedMigrationPage = join(temporary, "observed-migration-page.nsh");
  writeFileSync(
    observedMigrationPage,
    readFileSync(join(root, "src-tauri/windows/migration-page.nsh"), "utf8").replace(
      "  ${NSD_CreateTimer} MigrationPoll 100",
      "  ${NSD_CreateTimer} MigrationPoll 100\n  ${NSD_CreateTimer} TestWatch 50",
    ),
  );
  for (const mode of ["complete", "error", "cancelled", "bad-exit"]) {
    const directory = join(temporary, `wizard-${mode}`);
    mkdirSync(directory);
    const worker = compile(
      `wizard-worker-${mode}`,
      `Section
  \${GetOptions} $CMDLINE "--migration-progress" $1
  \${GetOptions} $CMDLINE "--migration-cancel" $2
  WriteINIStr $1 "Migration" "State" "running"
  WriteINIStr $1 "Migration" "Phase" "Copying and verifying"
  WriteINIStr $1 "Migration" "Copied" "12 / 3.0 MiB"
  WriteINIStr $1 "Migration" "Verified" "7 / 2.0 MiB"
  StrCpy $3 0
  worker_wait:
    IfFileExists $2 worker_cancelled
    Sleep 25
    IntOp $3 $3 + 1
    IntCmp $3 12 worker_done worker_wait worker_done
  worker_cancelled:
    WriteINIStr $1 "Migration" "State" "cancelled"
    WriteINIStr $1 "Migration" "Error" "Cancelled"
    SetErrorLevel 2
    Quit
  worker_done:
  ${mode === "error" ? `IfFileExists "$EXEDIR\\retry-ready" worker_success\nWriteINIStr $1 "Migration" "State" "error"\nWriteINIStr $1 "Migration" "Error" "SHA-256 mismatch"\nSetErrorLevel 1\nQuit\nworker_success:` : ""}
  WriteINIStr $1 "Migration" "State" "complete"
  ${mode === "bad-exit" ? `IfFileExists "$EXEDIR\\retry-ready" worker_success\nSleep 300\nSetErrorLevel 1\nQuit\nworker_success:` : ""}
SectionEnd`,
    );
    copyFileSync(worker, join(directory, "locution-pro.exe"));
    const wizard = compile(
      `wizard-${mode}`,
      `
!define UNINSTKEY "${registry}\\wizard-uninstall"
!define MANUPRODUCTKEY "${registry}\\wizard-product"
!define INSTALLMODE "currentUser"
!define MAINBINARYNAME "locution-pro"
Var PassiveMode
Var TestStep
Var TestTicks
Var TestWindow
!include "${nsis(observedMigrationPage)}"
!insertmacro MUI_PAGE_INSTFILES
Page custom TestMigrationPage MigrationPageLeave
!define MUI_PAGE_CUSTOMFUNCTION_SHOW TestFinishPage
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"
Function TestMigrationPage
  \${If} $TestWindow != $HWNDPARENT
    SetErrorLevel 8
    Quit
  \${EndIf}
  Call MigrationPageCreate
  \${NSD_KillTimer} TestWatch
FunctionEnd
Function TestWatch
  IntOp $TestTicks $TestTicks + 1
  \${If} $TestTicks > 100
    Call CancelMigration
    SetErrorLevel 9
    Quit
  \${EndIf}
  ${mode === "cancelled" ? `\${If} $TestStep = 0\n\${AndIf} $MigrationProcess != 0\nStrCpy $TestStep 1\nSystem::Call 'user32::PostMessageW(p $MigrationActionButton, i \${BM_CLICK}, p0, p0)'\n\${EndIf}` : ""}
  ${mode !== "complete" ? `\${If} $MigrationProcess = 0\n\${AndIf} $MigrationState == "${mode === "cancelled" ? "cancelled" : "error"}"\n\${AndIf} $TestStep < 2\nSystem::Call 'user32::IsWindowEnabled(p $MigrationNextButton) i.r0'\n\${If} $0 != 0\nSetErrorLevel 3\nQuit\n\${EndIf}\n\${If} $MigrationComplete != 0\nSetErrorLevel 4\nQuit\n\${EndIf}\nFileOpen $0 "$INSTDIR\\retry-ready" w\nFileClose $0\nStrCpy $TestStep 2\nSystem::Call 'user32::PostMessageW(p $MigrationActionButton, i \${BM_CLICK}, p0, p0)'\n\${EndIf}` : ""}
FunctionEnd
Function TestFinishPage
  \${If} $MigrationComplete != 1
    SetErrorLevel 5
    Quit
  \${EndIf}
  \${If} $TestWindow != $HWNDPARENT
    SetErrorLevel 6
    Quit
  \${EndIf}
  ${mode !== "complete" ? `\${If} $TestStep != 2\nSetErrorLevel 7\nQuit\n\${EndIf}` : ""}
  FileOpen $0 "$INSTDIR\\auto-finished.txt" w
  FileWrite $0 "$HWNDPARENT"
  FileClose $0
  Quit
FunctionEnd
Section
  StrCpy $MigrationEligible 1
  StrCpy $TestWindow $HWNDPARENT
  SetAutoClose true
SectionEnd`,
      false,
    );
    run(wizard, [`/D=${directory}`], 0, true);
    assert(
      existsSync(join(directory, "auto-finished.txt")),
      `${mode}: automatic same-window completion`,
    );
  }
  console.log(
    "Passed: independent installs, LineCut preservation, file associations, embedded migration page, automatic page transitions, same HWND, failure/cancellation gates, retry, silent migration.",
  );
} finally {
  assert(/^Software\\LocutionProIdentityTests\\[a-f0-9-]+$/u.test(registry));
  spawnSync("reg.exe", ["delete", `HKCU\\${registry}`, "/f"], { windowsHide: true });
  const withinTarget = relative(target, resolve(temporary));
  assert(withinTarget && !withinTarget.startsWith("..") && !isAbsolute(withinTarget));
  rmSync(temporary, { recursive: true, force: true });
}
