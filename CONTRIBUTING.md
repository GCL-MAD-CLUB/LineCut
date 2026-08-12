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

格式问题可以用 `npm run format` 修复。不要借机格式化或改写与当前变更无关的文件。
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

发布由维护者通过 `v<semver>` tag 触发。tag、`package.json`、两个 Cargo 清单/锁文件和 `tauri.conf.json` 的版本必须一致。详细流程见 `docs/releasing.md`。
