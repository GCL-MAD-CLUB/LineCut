# 参与 Locution Pro 开发

小型修复可以直接提交 Pull Request。较大的功能、项目文件格式变化或依赖新模型、二进制的改动，先在 Issue 或 Discussions 中说明使用场景与设计。

## 开发环境

- Windows 10/11 x64、WebView2 和 Tauri 2 的 Windows 构建依赖。
- Node.js 与 Rust 版本分别以 `.node-version`、`rust-toolchain.toml` 为准；npm 版本见 `package.json`。
- FFmpeg/FFprobe 可放在 `PATH`；打包资源通过 `npm run prepare:ffmpeg` 准备。

```powershell
npm ci
npm run tauri dev
```

开发构建使用开发密钥。不要提交正式密钥、证书、用户媒体、私人 `.lcp` 文件或下载的构建资源。

## 目录与测试

- `src/` 保存应用代码，`src-tauri/` 保存 Rust 后端与缩略图 Provider。
- Rust 测试必须内联在被测实现文件的 `#[cfg(test)] mod tests { ... }` 中；禁止独立测试文件、外置测试模块和 Rust 集成测试目录。
- `tests/unit/*.test.mjs` 保存无需浏览器、媒体工具和模型的确定性测试，统一通过 `npm test` 执行，并纳入 CI。
- `tests/browser/*.test.mjs` 保存需要 Vite 与浏览器的手动测试；每个文件开头说明调用入口。
- `tests/integration/*.test.mjs` 保存依赖外部工具的手动测试；安装器资源测试通过 `npm run test:installer` 执行，需要 Windows 和 NSIS。
- `scripts/` 只保存构建、资源准备、发布和仓库检查命令，每个脚本必须有 `package.json` 入口；不放测试、实验探针或文档数据清单。
- 新增 `.mjs` 必须遵循上述位置。`npm run check:layout` 检查目录规则、失效脚本入口及所有 `.mjs` 的语法。

Rust 中依赖模型、GPU 或真实 FFmpeg 的手动验证必须标记 `#[ignore = "说明所需资源"]`。普通 CI 不执行真实媒体编码或模型性能测试。审查以代码、差异和针对性测试为主，不生成视频后再用外部软件做复杂测试。预览完成后关闭自己启动的服务，释放端口 1420。

## 提交前检查

```powershell
npm run check
npm run format:rust:check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/thumbnail-provider/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/thumbnail-provider/Cargo.toml --locked
```

前端与文档只格式化已修改文件：`npx prettier --write <files>`；Rust 使用 `npm run format:rust`。只有明确要格式化整个仓库时才运行 `npm run format`。`npm run format:check` 发现无关的既有问题时报告，不覆盖他人的改动。

前端边界由 `check:errors` 和 `check:architecture` 检查。调整 `.lcp` 内容模型必须保留兼容与迁移路径，并补充内联 Rust 测试；本机面板配置与项目内容分别维护。引入模型、运行库或可执行文件时固定来源与校验值，并更新 `THIRD_PARTY_NOTICES.md`。

## 文档维护

`docs/user-guide/` 只放面向用户的帮助；`docs/` 顶层保留架构、错误契约、媒体管线和发布流程。模块或资源自身的说明放在对应目录的 README 或 MODEL 文档中。不要提交开发进度、故障复盘、一次性性能快照、待办草稿或重复的功能计数清单；尚未实现的能力只在必要的用户限制中如实说明。

行为变更同步对应专题页，说明入口、条件、步骤、结果、禁用条件及持久化或恢复边界。历史版本说明保留原有语义。普通帮助页需要 frontmatter 中的 `title`、`description`、唯一的一级标题，以及 `.vitepress/config.ts` 中的导航入口。

截图只使用真实图片，以标准 Markdown 图片语法引用 `docs/user-guide/public/images/` 下的资源，并提供描述画面的替代文本。没有截图时保留完整的文字步骤，不提交截图待办 TXT、占位组件或虚构画面。

```powershell
npm run docs:check
npm run docs:build
```

`docs:check` 检查页面结构、导航和图片引用；VitePress 构建检查站内链接。预览使用 `docs:dev` 或 `docs:preview`。公开站点由 `.github/workflows/deploy-user-guide.yml` 部署；仓库 Pages 的 Source 选择 GitHub Actions，自定义基址使用仓库变量 `DOCS_BASE`。

长期维护文档：[系统架构](docs/system-architecture.md)、[错误系统](docs/error-system.md)、[媒体处理](docs/media-processing.md)、[项目文件](src-tauri/src/project_file/README.md)、[发布流程](docs/releasing.md)。

## 分支、提交与发布

从最新 `main` 创建主题分支，PR 聚焦一个主题并说明验证方式。提交信息沿用 Conventional Commits，例如 `fix(export): preserve audio channel layout`；通常使用 squash merge。

发布由维护者通过 `v<semver>` tag 触发。应用版本清单与 tag 必须一致，详细步骤见[发布流程](docs/releasing.md)。
