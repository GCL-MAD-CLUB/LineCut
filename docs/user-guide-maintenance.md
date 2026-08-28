# LineCut 用户指南维护说明

公开帮助中心的内容源位于 `docs/user-guide`。维护说明放在站点目录外，避免被 VitePress 当作用户文档发布。

## 本地命令

- `npm run docs:dev`：启动本地预览；
- `npm run docs:check`：检查页面结构、截图引用和占位说明；
- `npm run docs:build`：先执行检查，再生成发布文件；
- `npm run docs:preview`：预览已经生成的发布文件。

## 写作约定

- 一页只解决一个明确任务或解释一个独立功能；
- 使用界面中的实际中文名称，行为不确定时先回到 `src` 和 `src-tauri` 核实；
- 普通页面必须包含 `title`、`description`、一个一级标题，并加入 `.vitepress/config.ts` 的侧边栏；
- 用户指南只描述已发布行为，未来功能必须明确标注“尚未提供”；
- 截图使用 `<GuideImage>`，替代文本描述画面内容，不使用“截图占位”作为替代文本。

## 补充截图

每个待补截图引用目标 PNG，并在同目录放置同名 `.txt` 说明文件：

```text
Markdown：<GuideImage src="/images/export/overview.png" alt="导出工作区全景" />
说明文件：docs/user-guide/public/images/export/overview.txt
最终图片：docs/user-guide/public/images/export/overview.png
```

检索 `docs/user-guide/public/images` 下的 `.txt`，按其中要求制作 PNG。将 PNG 放到相同目录并删除对应 `.txt`，不要同时保留两者。`GuideImage` 会自动处理 GitHub Pages 的站点基址；图片不存在时，页面显示可读的“截图待补”卡片，而不是破图。

完成修改后运行 `npm run docs:build`。结构检查会拒绝无说明的图片引用、未被引用的资源、重复路径和失效的占位文件。

## GitHub Pages 发布

`.github/workflows/deploy-user-guide.yml` 在 `main` 分支的文档或依赖变化后构建并发布。首次启用时，在仓库的 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**。

项目站点默认根据仓库名计算基址。若使用自定义域名，在 GitHub Actions 仓库变量中把 `DOCS_BASE` 设为 `/`；部署到其他子路径时，将它设为类似 `/help/` 的值。
