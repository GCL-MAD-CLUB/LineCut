# 发布流程

本文面向发布维护者。发布版本以应用清单、对应 tag 和 GitHub Release 为准；编写文档不自动改变应用版本或发布状态。

## 准备发布环境

使用受保护的 release Environment，仅允许受信任维护者发布。配置 main 的 PR 审查与 CI required 门禁，启用私密漏洞报告和依赖安全更新。

正式构建使用 `LOCUTION_PRO_PROJECT_BUILD_SECRET_V1`，工作流仍支持旧名称 `LINECUT_PROJECT_BUILD_SECRET_V1`。名称迁移必须保留原值，禁止重新生成已有项目所需的密钥。具体读取优先级见[项目文件契约](../src-tauri/src/project_file/README.md)。

证书和密码保存在发布环境中，不写入源码、文档或日志。

## 统一版本与检查

从最新 main 创建发布准备分支。检查 package、锁文件、Cargo 主包和 Tauri 配置的应用版本一致；缩略图提供程序的独立版本不随主应用同步。

```powershell
npm ci
npm run check:versions
npm run check
```

准备正式 0.4.0 时，应在审查后的改动中统一相应版本；不能仅创建 tag 来绕过清单检查。需要本地统一版本并生成完整安装包时使用：

```powershell
npm run release:build -- 0.4.0
```

该命令会修改版本文件、检查密钥、格式化相关文件、准备 FFmpeg 并启动构建，不是只读检查。仅更新文档时不运行它。

安装器相关改动按需要手动执行 `npm run test:installer` 和 `npm run test:installer-identity`。真实模型、GPU 和媒体验证不进入普通 CI。

## 核对文档与资源

- README 只介绍产品，不添加版本徽章、更新段落或发布记录。
- 用户指南核对实际功能与操作，不写实现原理；语义检索为可选组件，画面工作流不依赖字幕。
- CHANGELOG 标明发布状态与兼容注意事项；未发布时不填写虚构发布日期。
- 资源、许可证与第三方声明和实际包内容一致。
- 运行 `npm run docs:build`，检查导航和链接。
- 保留旧项目读取兼容与正式密钥，说明重存后可能无法降级打开。

## 创建发布 tag

版本 PR 合并后，在对应 main 提交创建 tag。以下命令仅用于已准备好正式版本的提交：

```powershell
git tag -a v0.4.0 -m "Locution Pro 0.4.0"
git push origin v0.4.0
```

预发布 tag 应与清单完整一致，例如 `v0.4.0-preview`。包含连字符的 tag 由工作流标记为 prerelease。

## 自动发布内容

发布维护者使用自己的 GitHub 账号为 tag 创建 Release 草稿并填写发布说明。发布工作流先检查 tag 和版本清单，再准备媒体工具、模型与运行资源，构建缩略图提供程序和 Windows 安装包，将附件上传到 Release 草稿。FFmpeg 下载包会核对固定校验值，语义模型使用固定修订版本。

确认工作流成功、安装包附件完整、发布说明与兼容提示正确后，由发布维护者使用自己的账号发布草稿。正式版本设为最新版本，预发布版本保留 prerelease 标记。不要在附件上传完成前公开发布。

应用 tag 和文档站部署分别核对。文档站由 main 上的工作流部署；本地文件变化或构建成功不表示公开站点已经更新。

## 处理发布失败

tag 与清单不一致时，在发布前修正，不对已公开 tag 强推不同源码。构建代码需要变化时使用新 tag；附件上传失败可从同一提交重试对应工作流。

确认安装包、可选组件、升级路径和项目兼容性后，再对外发布。不要将维护用构建步骤加入用户安装指南。
