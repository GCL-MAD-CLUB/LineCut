import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guideRoot = path.join(repositoryRoot, "docs", "user-guide");
const configPath = path.join(guideRoot, ".vitepress", "config.ts");
const errors = [];

async function listFiles(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.name === ".vitepress") return [];
      if (entry.isDirectory()) {
        return listFiles(entryPath, extension);
      }

      return !extension || path.extname(entry.name) === extension ? [entryPath] : [];
    }),
  );

  return files.flat().sort();
}

function relativeToGuide(filePath) {
  return path.relative(guideRoot, filePath).replaceAll(path.sep, "/");
}

function pageRoute(filePath) {
  const relativePath = relativeToGuide(filePath).replace(/\.md$/, "");
  return relativePath === "index" ? "/" : `/${relativePath}`;
}

function report(filePath, message) {
  errors.push(`${relativeToGuide(filePath)}: ${message}`);
}

const markdownFiles = await listFiles(guideRoot, ".md");

for (const filePath of markdownFiles) {
  const source = await readFile(filePath, "utf8");
  const route = pageRoute(filePath);
  const isHome = route === "/";
  const frontmatterMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

  if (!frontmatterMatch) {
    report(filePath, "缺少 YAML frontmatter");
  } else if (isHome) {
    if (!/^layout:\s*home\s*$/m.test(frontmatterMatch[1])) {
      report(filePath, "首页 frontmatter 必须声明 layout: home");
    }
  } else {
    const frontmatter = frontmatterMatch[1];
    const title = frontmatter.match(/^title:\s*(\S.+)$/m)?.[1];
    if (!title) {
      report(filePath, "frontmatter 缺少非空 title");
    }
    if (!/^description:\s*\S.+$/m.test(frontmatter)) {
      report(filePath, "frontmatter 缺少非空 description");
    }

    const heading = source.match(/^#\s+(\S.+)$/m)?.[1];
    if (title && heading && title !== heading) {
      report(filePath, `frontmatter title 与一级标题不一致：“${title}”/“${heading}”`);
    }
  }

  if (!isHome) {
    const headings = source.match(/^#\s+\S.+$/gm) ?? [];
    if (headings.length !== 1) {
      report(filePath, `应包含且仅包含一个一级标题，当前为 ${headings.length} 个`);
    }
  }

  if (/<GuideImage\b|screenshot-placeholder/u.test(source)) {
    report(filePath, "禁止截图占位组件；只引用已存在的真实图片");
  }
  for (const match of source.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/gu)) {
    const [, alt, image] = match;
    if (!alt.trim()) report(filePath, `图片缺少替代文本：${image}`);
    if (/^(?:https?:|data:)/u.test(image)) continue;
    const target = image.startsWith("/")
      ? path.join(guideRoot, "public", image)
      : path.resolve(path.dirname(filePath), image);
    try {
      if (!(await stat(target)).isFile()) throw new Error("Not an image file");
    } catch {
      report(filePath, `图片不存在：${image}`);
    }
  }
}

const config = await readFile(configPath, "utf8");
const sidebarRoutes = new Set(
  [...config.matchAll(/\blink:\s*["'](\/[^"']*)["']/g)].map((match) => match[1]),
);

for (const filePath of markdownFiles) {
  const route = pageRoute(filePath);
  if (!sidebarRoutes.has(route)) {
    report(filePath, `页面未加入 .vitepress/config.ts：${route}`);
  }
}

for (const route of sidebarRoutes) {
  const target = route === "/" ? "index.md" : `${route.slice(1)}.md`;
  if (!markdownFiles.some((filePath) => relativeToGuide(filePath) === target)) {
    errors.push(`.vitepress/config.ts: 链接没有对应页面：${route}`);
  }
}

if (errors.length > 0) {
  console.error(`用户指南检查失败（${errors.length} 项）：`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`用户指南检查通过：${markdownFiles.length} 个页面。`);
}
