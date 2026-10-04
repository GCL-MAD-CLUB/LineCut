# 发布流程

LineCut 使用和 OpenAI Codex 相同的核心发布思路：源码版本先在受审查的提交中统一，发布工作流只接受 tag，先验证 tag 与清单一致，再构建并上传 GitHub Release。发布工作流不会在构建过程中回写版本文件。

## 一次性 GitHub 配置

1. 创建名为 `release` 的 Environment，并只允许受信任维护者部署。稳定版可启用 required reviewers。
2. 在该 Environment 中添加 `LINECUT_PROJECT_BUILD_SECRET_V1` Secret。
3. 启用 Private vulnerability reporting、Dependabot alerts 和 Dependabot security updates。
4. 为 `main` 创建 ruleset：要求 Pull Request、至少一次批准、对新提交撤销旧批准、要求 conversation resolution，并只要求 `CI required` 这个稳定门禁。
5. 建议只允许 squash merge，开启自动删除合并后的分支。

若配置 Windows 代码签名，证书及密码也应放在 `release` Environment，并按 Tauri 的 Windows signing 文档把签名变量接入工作流。未签名安装包会触发 Windows SmartScreen 警告。

## 准备版本

从最新 `main` 创建发布准备分支，然后运行：

```powershell
npm ci
npm run release:build -- 0.3.3
```

该命令会统一更新版本并在本地构建完整安装包，因此需要正式项目构建密钥和打包资源。也可以仅修改版本文件后运行 `npm run check:versions` 与常规 CI，再由云端完成正式构建。

合并版本 PR 后，在 `main` 对应提交创建并推送带 `v` 前缀的 tag：

```powershell
git tag -a v0.3.3 -m "LineCut 0.3.3"
git push origin v0.3.3
```

预发布版本遵循 SemVer，例如 `v0.3.3-alpha.1`。工作流会自动标记包含 `-` 的版本为 prerelease。

## 自动发布内容

`.github/workflows/release.yml` 将：

1. 验证 tag 格式以及所有版本字段；
2. 从固定 URL 下载 FFmpeg 8.0.1 并校验 SHA-256；
3. 准备 TransNetV2/ONNX Runtime 资源；
4. 构建缩略图 Provider 与 Tauri NSIS 安装包；
5. 创建 GitHub Release、生成 release notes 并上传安装包。

## 失败处理

- tag 校验失败：删除远端错误 tag，修正版本 PR 后重新创建；不要对同一 tag 强推不同源码。
- 构建失败：修复源码后发布新 tag；已公开的 tag 与安装包应保持不可变。
- Release 已创建但附件上传失败：可从同一 tag 手动重新运行工作流。`concurrency` 会阻止同一 release 并发构建。

## 0.3.3 文档与清单核对

发布准备分支为 `release/0.3.3`。发布前确认文档主页、README、CHANGELOG、导航和 `release-notes/v0.3.3.md` 对应当前实现，运行 `npm run docs:build`；历史版本页面保留，不将历史说明中的版本全量替换。尚未发布时，更新日志标为发布准备，不编造正式发布时间。

当前版本一致性检查覆盖 `package.json`、`package-lock.json` 顶层与根包字段、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 中 `linecut` 包，以及 `src-tauri/tauri.conf.json`。缩略图 Provider 的独立包版本不在这套应用版本检查中，不应把所有依赖版本改成 0.3.3。

`release:build` 会验证正式构建密钥、改写应用版本文件、格式化其 JSON 和主应用 Rust、检查版本、准备 FFmpeg 并调用 Tauri 构建；不是纯检查命令。只更新文档时不需要运行它。密钥可通过已授权的环境或本地私密配置提供，禁止写入文档或日志。TransNetV2 和 Provider 的打包准备以当前 Tauri 构建钩子及工作流为准。

GitHub 用户指南部署由 `main` 上工作流触发，发布分支本地修改不表示站点已经上线。确认文档构建产物后，按项目审查与合并流程发布；应用 tag 与文档部署分别核对。当前 V4 项目模型与本机来源工作区配置的迁移边界应随版本说明保留。
