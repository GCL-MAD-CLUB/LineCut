import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guideRoot = path.join(repositoryRoot, "docs", "user-guide");
const imagesRoot = path.join(guideRoot, "public", "images");
const configPath = path.join(guideRoot, ".vitepress", "config.ts");
const errors = [];
const imageReferences = new Map();

async function listFiles(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

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

const markdownFiles = (await listFiles(guideRoot, ".md")).filter(
  (filePath) => !relativeToGuide(filePath).startsWith(".vitepress/"),
);

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

  if (source.includes("screenshot-placeholder")) {
    report(filePath, "仍在使用废弃的 screenshot-placeholder");
  }

  for (const match of source.matchAll(/<GuideImage\b([^>]*)\/?\s*>/g)) {
    const attributes = match[1];
    const src = attributes.match(/\bsrc="([^"]+)"/)?.[1];
    const alt = attributes.match(/\balt="([^"]+)"/)?.[1];

    if (!src) {
      report(filePath, "GuideImage 缺少 src");
      continue;
    }
    if (!/^\/images\/(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*\.png$/.test(src)) {
      report(filePath, `截图路径必须是小写 PNG 绝对站点路径：${src}`);
      continue;
    }
    if (!alt?.trim()) {
      report(filePath, `截图 ${src} 缺少可访问的 alt 文本`);
    } else if (alt.includes("截图占位")) {
      report(filePath, `截图 ${src} 的 alt 应描述画面，不应包含“截图占位”`);
    }
    if (imageReferences.has(src)) {
      report(filePath, `截图路径 ${src} 已被 ${imageReferences.get(src)} 引用`);
    } else {
      imageReferences.set(src, relativeToGuide(filePath));
    }
  }
}

const imageFiles = await listFiles(imagesRoot);
const managedAssets = new Map();

for (const filePath of imageFiles) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== ".png" && extension !== ".txt") {
    continue;
  }

  const relativePath = path.relative(imagesRoot, filePath).replaceAll(path.sep, "/");
  const imagePath = `/images/${relativePath.replace(/\.(?:png|txt)$/i, ".png")}`;
  const entry = managedAssets.get(imagePath) ?? {};
  entry[extension.slice(1)] = filePath;
  managedAssets.set(imagePath, entry);

  if (!imageReferences.has(imagePath)) {
    report(filePath, `资源未被任何 GuideImage 引用：${imagePath}`);
  }

  if (extension === ".txt") {
    const prompt = await readFile(filePath, "utf8");
    const firstLine = prompt.split(/\r?\n/, 1)[0];
    if (firstLine !== `目标图片路径：${imagePath}`) {
      report(filePath, `首行必须是“目标图片路径：${imagePath}”`);
    }
  }
}

for (const [imagePath, sourceFile] of imageReferences) {
  const assets = managedAssets.get(imagePath);
  if (!assets) {
    errors.push(`${sourceFile}: ${imagePath} 既没有 PNG，也没有同名 TXT 说明`);
  } else if (assets.png && assets.txt) {
    errors.push(`${sourceFile}: ${imagePath} 已有 PNG，应删除同名 TXT 说明`);
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
  const placeholders = [...managedAssets.values()].filter((asset) => asset.txt).length;
  const screenshots = [...managedAssets.values()].filter((asset) => asset.png).length;
  console.log(
    `用户指南检查通过：${markdownFiles.length} 个页面，${screenshots} 张截图，${placeholders} 个待补截图。`,
  );
}
