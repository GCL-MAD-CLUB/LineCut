// Manual Windows/NSIS fixture: npm run test:installer-identity.
// Uses only temporary HKCU registry keys and files; never installs the app or runs its uninstaller.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "win32", "The installer identity test requires Windows");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const target = join(root, "src-tauri/target");
mkdirSync(target, { recursive: true });
const temporary = mkdtempSync(join(target, "installer-identity-"));
const registry = `Software\\LocutionProIdentityTests\\${randomUUID()}`;
const template = readFileSync(join(root, "src-tauri/windows/installer.nsi"), "utf8");
const compiler =
  process.env.NSIS_MAKENSIS ?? join(process.env.LOCALAPPDATA, "tauri/NSIS/makensis.exe");
const nsis = (value) => value.replaceAll("$", () => "$$").replaceAll('"', '$\\"');
const run = (program, args) => {
  const result = spawnSync(program, args, { encoding: "utf8", windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
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

try {
  for (const mode of ["fresh", "legacy", "current", "both"]) {
    const directory = join(temporary, mode);
    mkdirSync(directory);
    const executable = join(directory, "fixture.exe");
    const script = join(directory, "fixture.nsi");
    const payload = join(directory, "payload");
    const legacy = ["legacy", "both"].includes(mode);
    const current = ["current", "both"].includes(mode);
    const seed = (uninstall, product, binary, semantic) => `
  WriteRegStr SHCTX "\${${uninstall}}" "UninstallString" "fixture-uninstaller"
  WriteRegStr SHCTX "\${${uninstall}}" "InstallLocation" "$INSTDIR"
  WriteRegStr SHCTX "\${${uninstall}}" "MainBinaryName" "${binary}.exe"
  WriteRegStr SHCTX "\${${product}}" "" "$INSTDIR"
  WriteRegDWORD SHCTX "\${${product}}" "BundleSemanticSearch" ${semantic}
`;
    writeFileSync(
      script,
      `Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!define UNINSTKEY "${registry}\\current-uninstall"
!define MANUPRODUCTKEY "${registry}\\current-product"
!define LEGACY_UNINSTKEY "${registry}\\legacy-uninstall"
!define LEGACY_MANUPRODUCTKEY "${registry}\\legacy-product"
!define INSTALLMODE "currentUser"
!define MAINBINARYNAME "locution-pro"
!define PRODUCTNAME "Locution Pro"
!define MANUFACTURER "Fixture"
!define VERSION "0.3.3"
!define ESTIMATEDSIZE 1
!define HOMEPAGE ""
Name "Locution Pro identity fixture"
OutFile "${nsis(executable)}"
RequestExecutionLevel user
SilentInstall silent
Var PreviousUninstallKey
Var PreviousProductKey
Var OldMainBinaryName
Var LocutionProBundleSemantic
${functionSource("FindPreviousInstallation")}
${functionSource("RestorePreviousInstallLocation")}
Function RenameExistingProductShortcuts
FunctionEnd
Section
  SetShellVarContext current
  StrCpy $LocutionProBundleSemantic 1
  CreateDirectory $INSTDIR
  ${legacy ? seed("LEGACY_UNINSTKEY", "LEGACY_MANUPRODUCTKEY", "linecut", 0) : ""}
  ${current ? seed("UNINSTKEY", "MANUPRODUCTKEY", "locution-pro", 1) : ""}
  Call FindPreviousInstallation
  Call RestorePreviousInstallLocation
${componentChoice}
  FileOpen $5 "$INSTDIR\\choice.txt" w
  FileWrite $5 $LocutionProBundleSemantic
  FileClose $5
${registration}
  ReadRegStr $0 SHCTX "\${UNINSTKEY}" "DisplayName"
  FileOpen $5 "$INSTDIR\\name.txt" w
  FileWrite $5 $0
  FileClose $5
  ReadRegStr $0 SHCTX "\${LEGACY_UNINSTKEY}" "UninstallString"
  FileOpen $5 "$INSTDIR\\legacy.txt" w
  FileWrite $5 $0
  FileClose $5
  DeleteRegKey HKCU "${registry}"
SectionEnd
`,
      "utf8",
    );
    run(compiler, ["/V2", script]);
    run(executable, ["/S", `/D=${payload}`]);
    assert.equal(
      readFileSync(join(payload, "choice.txt"), "utf8"),
      mode === "legacy" ? "0" : "1",
      mode,
    );
    assert.equal(readFileSync(join(payload, "name.txt"), "utf8"), "Locution Pro", mode);
    if (mode === "legacy") assert.equal(readFileSync(join(payload, "legacy.txt"), "utf8"), "");
  }
  console.log(
    "Passed: fresh registration, legacy upgrade/cleanup, retained component choice, current registration precedence.",
  );
} finally {
  assert(/^Software\\LocutionProIdentityTests\\[a-f0-9-]+$/u.test(registry));
  spawnSync("reg.exe", ["delete", `HKCU\\${registry}`, "/f"], { windowsHide: true });
  const withinTarget = relative(target, resolve(temporary));
  assert(withinTarget && !withinTarget.startsWith("..") && !isAbsolute(withinTarget));
  rmSync(temporary, { recursive: true, force: true });
}
