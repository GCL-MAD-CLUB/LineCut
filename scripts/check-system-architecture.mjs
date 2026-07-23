import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const root = process.cwd();
const sourceRoot = join(root, "src");
const componentsRoot = join(sourceRoot, "components");
const failures = [];

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return [".ts", ".tsx"].includes(extname(path)) ? [path] : [];
  });
}

function fail(path, message) {
  failures.push(`${relative(root, path)}: ${message}`);
}

function sourceFile(path) {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    extname(path) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function componentOwner(path) {
  const relativePath = relative(componentsRoot, path);
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    return undefined;
  }
  return relativePath.split(sep)[0];
}

function importedComponentOwner(path, specifier) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const target = resolve(dirname(path), specifier);
  const relativePath = relative(componentsRoot, target);
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    return undefined;
  }
  return {
    owner: relativePath.split(sep)[0],
    leaf: basename(target),
  };
}

const legacyFiles = [
  "src/appEvents.ts",
  "src/store.ts",
  "src/projectHistory.ts",
  "src/panelState.tsx",
];
for (const legacyFile of legacyFiles) {
  const path = join(root, legacyFile);
  if (existsSync(path)) {
    fail(path, "legacy communication module must not be restored");
  }
}

for (const path of sourceFiles(sourceRoot)) {
  const source = readFileSync(path, "utf8");
  const parsed = sourceFile(path);
  const owner = componentOwner(path);

  if (/\b(?:emitAppEvent|useAppEvent|useAppStore|appStore)\b/u.test(source)) {
    fail(path, "legacy event/store API is forbidden");
  }
  if (/\buse[A-Za-z0-9]*System\b/u.test(source)) {
    fail(path, "component system-composition hooks are forbidden; use lower-level APIs directly");
  }
  if (owner && /System\.(?:ts|tsx)$/u.test(basename(path))) {
    fail(
      path,
      "component system-composition modules are forbidden; compose lower-level APIs directly",
    );
  }
  if (/\bnew\s+CustomEvent\s*</u.test(source) || /\bdispatchEvent\s*\(/u.test(source)) {
    fail(path, "application communication must use EventHub, not DOM events");
  }

  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (/(?:^|\/)(?:store|appEvents|projectHistory)$/u.test(specifier)) {
      fail(path, `legacy module import is forbidden: ${specifier}`);
    }
    if (specifier.includes("ProjectSystem/ProjectState")) {
      fail(path, "ProjectSystem state is private; use the typed project port");
    }

    const imported = importedComponentOwner(path, specifier);
    if (owner && imported && owner !== imported.owner && /(?:State|System)$/u.test(imported.leaf)) {
      fail(
        path,
        `component-private module ${specifier} crosses from ${owner} to ${imported.owner}`,
      );
    }
  }
}

const forbiddenRoutingFields =
  /^(?:target|targetId|targetSystem|targetInstanceId|receiver|receiverId|recipient|destination|consume|consumed)$/u;
const eventContractPath = join(sourceRoot, "runtime", "events", "contracts.ts");
for (const path of [eventContractPath, join(sourceRoot, "runtime", "events", "EventHub.ts")]) {
  const parsed = sourceFile(path);
  function visit(node) {
    if (
      (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) &&
      node.name &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      (forbiddenRoutingFields.test(node.name.text) ||
        (path === eventContractPath && node.name.text === "instanceId"))
    ) {
      fail(path, `event routing field "${node.name.text}" violates broadcast semantics`);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
}

if (failures.length > 0) {
  console.error("System architecture check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("System architecture check passed.");
}
