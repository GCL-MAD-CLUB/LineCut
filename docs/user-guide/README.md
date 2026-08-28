# LineCut 用户指南源码

此目录是公开帮助中心的唯一内容源。运行 `npm run docs:dev` 可在本地预览，运行
`npm run docs:build` 可生成 GitHub Pages 工件。

## 写作约定

- 一页只解决一个明确任务或解释一个独立功能；不要把多个不相关的操作塞进同一篇文章。
- 使用用户界面中的实际中文名称。功能的行为不确定时，先回到 `src/` 和 `src-tauri/` 核实。
- 所有需要补图的位置使用 `.screenshot-placeholder`，并写清应截取的窗口、状态和重点。
- 新页面必须添加到 `.vitepress/config.ts` 的侧边栏，并至少链接到一篇相关页面。
- 用户指南描述已发布行为；未来功能应标注“尚未提供”，不能写成已可用。

## 补充截图

每个截图位置已经替换为 `<GuideImage>`，并引用形如 `/images/export/overview.png` 的目标路径。对应的文字说明位于 `public/images` 下相同目录、相同文件名的 `.txt` 文件，例如：

```text
Markdown：<GuideImage src="/images/export/overview.png" ... />
说明文件：docs/user-guide/public/images/export/overview.txt
最终图片：docs/user-guide/public/images/export/overview.png
```

补图时检索所有 `.txt` 文件，阅读其中的截屏要求；将准备好的 PNG 放到相同目录并使用相同文件名，再删除对应 `.txt`。`GuideImage` 会在发布时自动处理 GitHub Pages 的站点基址，因此不要改为本机绝对路径。完成一批图片后运行 `npm run docs:build` 验证。

## GitHub Pages 发布

`.github/workflows/deploy-user-guide.yml` 会在 `main` 分支的文档或依赖变更合并后构建并发布。
首次启用时，请在 GitHub 仓库的 **Settings → Pages → Build and deployment → Source** 中选择
**GitHub Actions**。默认地址为 `https://gcl-mad-club.github.io/LineCut/`。

若改用自定义域名，请在 Pages 设置中绑定域名，并在构建环境中把 `DOCS_BASE` 设为 `/`；保持
`/LineCut/` 会导致部署在根域名时的资源路径错误。
