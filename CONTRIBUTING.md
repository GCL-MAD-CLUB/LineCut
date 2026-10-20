# 参与 Locution Pro 开发

本指南面向维护者，以 0.4.0 产品基线为准。小型修复可直接提交 Pull Request；较大功能、项目格式或外部资源变化，应先说明使用场景与设计。

## 开发环境

使用 Windows 10 / 11 x64、WebView2 和 Tauri 的 Windows 构建依赖。Node.js 与 Rust 版本以 `.node-version`、`rust-toolchain.toml` 为准，npm 版本见 `package.json`。

```powershell
npm ci
npm run tauri dev
```

开发构建使用开发密钥。不要提交正式密钥、证书、用户媒体、私人项目或下载的构建资源。预览完成后关闭自己启动的服务，释放端口 1420。

## 代码与测试位置

- 应用代码位于 `src/`，原生代码与缩略图提供程序位于 `src-tauri/`。
- Rust 测试内联在被测实现文件的 `#[cfg(test)] mod tests` 中，禁止外置模块或独立测试目录。
- `tests/unit/` 保存不依赖浏览器、媒体工具或模型的确定性测试，通过 `npm test` 执行。
- `tests/browser/` 保存手动浏览器测试，`tests/integration/` 保存外部工具测试。
- `scripts/` 只放构建、资源准备、发布与仓库检查命令，每个脚本必须有 package 入口。

真实 FFmpeg 编码、媒体和模型 / GPU 测试不进入普通 CI；Rust 中标记为说明资源条件的忽略测试。审查以代码、差异与针对性测试为主，不生成视频后再使用外部软件做复杂测试。

## 格式与检查

前端与 Markdown 只格式化改动文件：`npx prettier --write <files>`。Rust 使用 `npm run format:rust`。不要批量重排无关文件；全仓格式检查发现既有问题时报告。

```powershell
npm run check
npm run format:rust:check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/thumbnail-provider/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/thumbnail-provider/Cargo.toml --locked
```

按改动选择适用检查。调整仓库工具或移动测试后必须执行 `npm run check:layout` 和 `npm test`。项目格式变更需保留旧格式读取与迁移，并添加有意义的内联测试。

## 文档写作边界

产品定位是媒体管理、画面检索、镜头整理和片段交付，字幕属于可选查找方式。不得重新将产品描述为依赖字幕的工具。

| 文档             | 读者与内容                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| README           | 只呈现产品价值、能力、开始使用与运行条件；不出现应用版本号、更新说明、变更日志、开发命令或架构 |
| docs/user-guide  | 按用户任务介绍入口、条件、步骤、结果和必要限制                                                 |
| CHANGELOG        | 产品变化、发布状态与升级注意事项                                                               |
| docs 顶层        | 系统、错误、媒体处理与发布的维护契约                                                           |
| 资源与模块说明   | 对应目录的维护要求、来源和技术约束                                                             |
| 许可与第三方声明 | 保留原始授权、署名和来源事实                                                                   |

README 与用户指南采用专业产品帮助的写法。即使项目开源，也不得在其中解释内部逻辑、模块划分、接口 / API、模型计算、代码流程、架构或持久化设计；不得以“方便用户理解”为理由引入实现说明。只说明对使用决策有影响的条件与结果。

新功能应整合到对应主题，不在文章末尾叠加版本补丁段落。历史信息集中在 CHANGELOG 与发布页面，不保留互相矛盾的旧帮助。删除失效说明、进度笔记、故障复盘、一次性性能数据与待办文档。

普通帮助页需提供 title、description、唯一一级标题，并加入 `.vitepress/config.ts`。截图只引用已存在的真实图片并填写替代文本，不使用占位组件或截图待办。

```powershell
npm run docs:check
npm run docs:build
```

检查覆盖页面、导航、图片和用户文档边界，构建检查站内链接。自动检查不能替代逐页编辑审查。文档站通过 main 的部署工作流发布，基址可用仓库变量 `DOCS_BASE` 设置；本地构建不代表已经上线。

## 维护契约与发布

跨组件变更遵守[系统契约](docs/system-architecture.md)和[错误契约](docs/error-system.md)，媒体变更参阅[媒体处理](docs/media-processing.md)，格式变更参阅[项目文件](src-tauri/src/project_file/README.md)。

引入第三方模型、二进制或代码时固定来源并更新[第三方声明](THIRD_PARTY_NOTICES.md)。保留许可原文，不用主应用版本替换依赖或协议版本。

从最新 main 创建主题分支，PR 说明问题、最终行为和实际验证。提交信息使用 Conventional Commits，通常 squash merge。版本准备、tag 与正式密钥要求见[发布流程](docs/releasing.md)。
