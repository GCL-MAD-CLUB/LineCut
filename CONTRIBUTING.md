# 参与 LineCut 开发

感谢你愿意改进 LineCut。小型修复可以直接提交 Pull Request；较大的功能、项目文件格式变化或依赖新模型/二进制的改动，请先在 Discussions 或 Issue 中说明使用场景和设计方向。

## 开发环境

- Windows 10/11 x64
- Node.js 22.18.0（仓库的 `.node-version`）
- npm 11
- Rust 1.96.0（`rust-toolchain.toml` 会由 rustup 自动选择）
- WebView2 与 Tauri 2 的 Windows 构建依赖
- FFmpeg/FFprobe；开发时可以放在 `PATH`，打包时运行 `npm run prepare:ffmpeg`

```powershell
npm ci
npm run tauri dev
```

`npm run tauri dev` 使用开发构建密钥。请勿索取或提交正式发布密钥。

## 提交前检查

```powershell
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo fmt --manifest-path src-tauri/thumbnail-provider/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/thumbnail-provider/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/thumbnail-provider/Cargo.toml --locked
```

前端与文档变更用 `npx prettier --write <已修改文件>`，Rust 变更用 `npm run format:rust`。仅在明确要格式化整个仓库时运行 `npm run format`；`npm run format:check` 若发现既有问题，应报告，不要改写无关文件。
仓库暂时在 `.prettierignore` 末尾记录少量既有格式债务；清理其中条目时应使用独立的纯格式化 PR。

## 项目约束

- 前端错误处理与系统边界由 `npm run check:errors`、`npm run check:architecture` 检查；相关设计见 `docs/`。
- `.lcp` 是持久化格式。调整模型时必须保留迁移/兼容路径，并补充 Rust 测试。
- 不要提交 `src-tauri/bin/`、证书、发布密钥、用户媒体或私人 `.lcp` 文件。
- 引入模型、运行库或可执行文件时，固定来源与校验值，并同步更新 `THIRD_PARTY_NOTICES.md`。
- PR 应聚焦一个主题，说明验证方式；UI 变化请提供截图或短视频。

## 分支与提交

从最新 `main` 创建简短的主题分支。提交信息建议采用项目已有的 Conventional Commits 风格，例如：

```text
feat(storyboard): add shot grouping
fix(export): preserve audio channel layout
docs: explain release workflow
```

维护者通常使用 squash merge，以便 `main` 保持一项功能一个提交。

## 发布

发布由维护者通过 `v<semver>` tag 触发。tag、`package.json`、主应用 Cargo 清单/锁文件和 `tauri.conf.json` 的版本必须一致。详细流程见 `docs/releasing.md`。

## 0.3.3 文档与代码审查基准

当前文档以 `release/0.3.3` 为基准；变更行为时需同步专题页、操作清单、覆盖统计和相关截图说明。写清入口、前置条件、禁用条件、步骤、结果、持久化位置与恢复方式，不用提交标题代替操作说明。历史版本说明保留原发布语义，新增当前版本链接，不能全局替换历史版本号。

修改文档后运行 `npm run docs:check` 和 `npm run docs:build`。新增用户操作登记到 `scripts/user-guide-operations.mjs` 并关联真实源码与正文证据；格式只处理变化的 Markdown、站点配置和清单文件。来源工作区、本机配置与 `.lcp` 内容模型分别描述，当前 V4 不因 UI 多来源而升级。

审查优先阅读代码、差异和针对性测试。不得生成视频后使用外部软件进行复杂测试；UI 说明可提供真实界面截图，尚无截图时遵循维护说明添加同名 TXT，并明确待补，不伪造已验证画面。架构与媒体管线见 [系统架构](docs/system-architecture.md)、[媒体处理](docs/media-processing.md)和[文档维护](docs/user-guide-maintenance.md)。
