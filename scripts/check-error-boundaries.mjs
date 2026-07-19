import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";

const root = process.cwd();
const failures = [];

function filesUnder(directory, extensions) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path, extensions);
    return extensions.has(extname(entry.name)) ? [path] : [];
  });
}

function fail(path, rule) {
  failures.push(`${relative(root, path)}: ${rule}`);
}

function scriptKind(path) {
  return extname(path) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function namedImportBindings(sourceFile, modulePredicate, importedName) {
  const bindings = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !modulePredicate(statement.moduleSpecifier.text) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === importedName) {
        bindings.add(element.name.text);
      }
    }
  }
  return bindings;
}

function namespaceImportBindings(sourceFile, moduleName) {
  const bindings = new Set();
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === moduleName &&
      statement.importClause?.namedBindings &&
      ts.isNamespaceImport(statement.importClause.namedBindings)
    ) {
      bindings.add(statement.importClause.namedBindings.name.text);
    }
  }
  return bindings;
}

function isPromiseAggregator(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Promise" &&
    ["all", "allSettled", "any", "race"].includes(node.expression.name.text)
  );
}

function backgroundResultIsConsumed(call) {
  for (let node = call.parent; node; node = node.parent) {
    if (ts.isAwaitExpression(node) || isPromiseAggregator(node)) {
      return true;
    }
  }
  return false;
}

function tauriCommands(source) {
  const commands = [];
  for (const attribute of source.matchAll(/#\[tauri::command\]/gu)) {
    const remaining = source.slice(attribute.index + attribute[0].length);
    const functionMatch = remaining.match(
      /\b(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/u,
    );
    if (!functionMatch || functionMatch.index === undefined) {
      continue;
    }
    const signatureStart = attribute.index + attribute[0].length + functionMatch.index;
    const bodyStart = source.indexOf("{", signatureStart);
    if (bodyStart < 0) {
      continue;
    }
    commands.push({
      name: functionMatch[1],
      signature: source.slice(signatureStart, bodyStart),
    });
  }
  return commands;
}

const cjkPattern = /[\u3400-\u9fff\uf900-\ufaff]/u;
function callsOf(source, name) {
  const calls = [];
  let cursor = 0;
  while ((cursor = source.indexOf(name, cursor)) >= 0) {
    const start = cursor;
    cursor += name.length;
    if (/[$\w]/u.test(source[start - 1] ?? "") || /[$\w]/u.test(source[cursor] ?? "")) {
      continue;
    }
    let open = cursor;
    while (/\s/u.test(source[open] ?? "")) open += 1;
    if (
      source[open] !== "(" ||
      /\b(?:fn|function)\s*$/u.test(source.slice(Math.max(0, start - 24), start))
    ) {
      continue;
    }

    let depth = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockCommentDepth = 0;
    for (let index = open; index < source.length; index += 1) {
      const character = source[index];
      const next = source[index + 1];
      if (lineComment) {
        if (character === "\n") lineComment = false;
        continue;
      }
      if (blockCommentDepth > 0) {
        if (character === "/" && next === "*") {
          blockCommentDepth += 1;
          index += 1;
        } else if (character === "*" && next === "/") {
          blockCommentDepth -= 1;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }
      if (character === "/" && next === "/") {
        lineComment = true;
        index += 1;
      } else if (character === "/" && next === "*") {
        blockCommentDepth = 1;
        index += 1;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          calls.push({
            index: start,
            arguments: source.slice(open + 1, index),
            text: source.slice(start, index + 1),
          });
          cursor = index + 1;
          break;
        }
      }
    }
  }
  return calls;
}

const frontendFiles = filesUnder(join(root, "src"), new Set([".ts", ".tsx"]));
for (const path of frontendFiles) {
  const source = readFileSync(path, "utf8");
  const normalizedPath = relative(root, path).replaceAll("\\", "/");
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const directInvokeBindings = namedImportBindings(
    sourceFile,
    (moduleName) => moduleName === "@tauri-apps/api/core",
    "invoke",
  );
  const tauriCoreNamespaces = namespaceImportBindings(sourceFile, "@tauri-apps/api/core");
  const backgroundOperationBindings = namedImportBindings(
    sourceFile,
    (moduleName) => /(?:^|\/)errors(?:\/index)?$/u.test(moduleName),
    "runBackgroundOperation",
  );
  let directInvokeReported = false;
  let consumedBackgroundReported = false;
  const visitFrontendNode = (node) => {
    if (ts.isCallExpression(node)) {
      const directInvoke =
        (ts.isIdentifier(node.expression) && directInvokeBindings.has(node.expression.text)) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "invoke" &&
          ts.isIdentifier(node.expression.expression) &&
          tauriCoreNamespaces.has(node.expression.expression.text));
      if (directInvoke && normalizedPath !== "src/errors/runtime.ts" && !directInvokeReported) {
        directInvokeReported = true;
        fail(path, "Tauri invoke must go through invokeCommand");
      }
      if (
        ts.isIdentifier(node.expression) &&
        backgroundOperationBindings.has(node.expression.text) &&
        backgroundResultIsConsumed(node) &&
        !consumedBackgroundReported
      ) {
        consumedBackgroundReported = true;
        fail(
          path,
          "runBackgroundOperation is fire-and-forget and must not be awaited or aggregated",
        );
      }
    }
    ts.forEachChild(node, visitFrontendNode);
  };
  visitFrontendNode(sourceFile);
  if (/\b(?:publishError|reportError)\b/.test(source)) {
    fail(path, "legacy error publication is forbidden");
  }
  if (/console\.(?:error|warn)\s*\(/.test(source)) {
    fail(path, "diagnostics must go through IncidentCenter/native logging");
  }
  if (/warnings\s*:\s*string\[\]/.test(source)) {
    fail(path, "public warnings must use UserNotice");
  }
  if (/\bnew\s+(?:Error|DOMException)\s*\(/u.test(source)) {
    fail(path, "frontend errors must be created with clientError(code, English detail)");
  }
  if (/\bthrow\s+(?!clientError\s*\(|normalizeError\s*\()/u.test(source)) {
    fail(path, "frontend throw sites must throw clientError or a normalized boundary error");
  }
  if (normalizedPath !== "src/errors/model.ts" && /\bnew\s+ClientError\s*\(/u.test(source)) {
    fail(path, "ClientError construction must go through clientError");
  }
  for (const call of callsOf(source, "clientError")) {
    if (!/^\s*["'][A-Z][A-Z0-9_]*["']\s*,/u.test(call.arguments)) {
      fail(path, "clientError requires a stable literal code from the typed catalog");
      break;
    }
    if (cjkPattern.test(call.text)) {
      fail(path, "clientError diagnostic text must be authored in English");
      break;
    }
  }
}

const rustFiles = filesUnder(join(root, "src-tauri", "src"), new Set([".rs"]));
const infallibleCommandAllowlist = new Set(["path_is_file", "record_frontend_incident"]);
for (const path of rustFiles) {
  const source = readFileSync(path, "utf8");
  const normalizedPath = relative(root, path).replaceAll("\\", "/");
  for (const command of tauriCommands(source)) {
    if (infallibleCommandAllowlist.has(command.name)) {
      if (/->\s*CommandResult\s*</u.test(command.signature)) {
        fail(path, `${command.name} no longer needs its infallible-command allowlist entry`);
        break;
      }
      continue;
    }
    if (!/->\s*CommandResult\s*</u.test(command.signature)) {
      fail(path, `Tauri command ${command.name} must return CommandResult`);
      break;
    }
  }
  if (
    /->\s*Result\s*<[^{};]*,\s*String\s*>/u.test(source) ||
    /Ok\s*::<[^>]*,\s*String\s*>/u.test(source)
  ) {
    fail(path, "stringly typed Rust errors are forbidden; use AppResult and ErrorCode");
  }
  if (/\b(?:classify_error|classifyError)\b/u.test(source)) {
    fail(path, "error classification must be declared at the source, never inferred from text");
  }
  if (/\bErr\s*\(\s*(?:format!\s*\(|String::from\s*\(|["'])/u.test(source)) {
    fail(path, "Rust error sites must construct app_error with an explicit ErrorCode");
  }
  if (/impl\s+From\s*<\s*(?:String|&str)\s*>\s+for\s+AppError/u.test(source)) {
    fail(path, "AppError must not accept unclassified string conversions");
  }
  if (normalizedPath !== "src-tauri/src/error.rs" && /AppError\s*::\s*new\s*\(/u.test(source)) {
    fail(path, "AppError construction must go through app_error(ErrorCode, detail)");
  }
  for (const call of callsOf(source, "app_error")) {
    if (!/^\s*ErrorCode::[A-Z][A-Za-z0-9]*\s*,/u.test(call.arguments)) {
      fail(path, "app_error requires an explicit ErrorCode as its first argument");
      break;
    }
    if (cjkPattern.test(call.text)) {
      fail(path, "native diagnostic text must be authored in English");
      break;
    }
  }
}

const nativeErrorPath = join(root, "src-tauri", "src", "error.rs");
const nativeErrorSource = readFileSync(nativeErrorPath, "utf8");
const nativeCategories = new Set(
  [...nativeErrorSource.matchAll(/Self::[A-Z][A-Za-z0-9]*\s*=>\s*"([A-Za-z]+)"/gu)].map(
    (match) => match[1],
  ),
);
const frontendTypesPath = join(root, "src", "errors", "model.ts");
const frontendTypesSource = readFileSync(frontendTypesPath, "utf8");
const categoryArray = frontendTypesSource.match(
  /export const ERROR_CATEGORIES\s*=\s*\[([\s\S]*?)\]\s*as const/u,
);
const frontendCategories = new Set(
  [...(categoryArray?.[1] ?? "").matchAll(/["']([A-Za-z]+)["']/gu)].map((match) => match[1]),
);
if (
  nativeCategories.size === 0 ||
  frontendCategories.size === 0 ||
  [...nativeCategories].some((category) => !frontendCategories.has(category)) ||
  [...frontendCategories].some((category) => !nativeCategories.has(category))
) {
  fail(frontendTypesPath, "frontend and native error category catalogs must match exactly");
}

const codeCatalog = nativeErrorSource.match(/define_error_codes!\s*\{([\s\S]*?)\n\}/u)?.[1] ?? "";
const publicCodes = [
  ...codeCatalog.matchAll(
    /^\s*[A-Z][A-Za-z0-9]*\s*=>\s*\("([A-Z][A-Z0-9_]*)",\s*[A-Z][A-Za-z0-9]*,\s*(?:true|false)\),?\s*$/gmu,
  ),
].map((match) => match[1]);
const catalogEntries = codeCatalog.split("\n").filter((line) => line.trim()).length;
if (publicCodes.length !== catalogEntries) {
  fail(
    nativeErrorPath,
    "every ErrorCode catalog entry must declare a stable name, category, and retryability",
  );
}
if (new Set(publicCodes).size !== publicCodes.length) {
  fail(nativeErrorPath, "public native error codes must be unique");
}

if (failures.length > 0) {
  console.error(`Error-boundary check failed:\n${failures.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
}

console.log("Error-boundary check passed.");
