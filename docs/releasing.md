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
npm run release:build -- 0.3.0
```

该命令会统一更新版本并在本地构建完整安装包，因此需要正式项目构建密钥和打包资源。也可以仅修改版本文件后运行 `npm run check:versions` 与常规 CI，再由云端完成正式构建。

合并版本 PR 后，在 `main` 对应提交创建并推送带 `v` 前缀的 tag：

```powershell
git tag -a v0.3.0 -m "LineCut 0.3.0"
git push origin v0.3.0
```

预发布版本遵循 SemVer，例如 `v0.3.0-alpha.3`。工作流会自动标记包含 `-` 的版本为 prerelease。

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
