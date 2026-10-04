---
layout: home

hero:
  name: LineCut
  text: 帮助中心
  tagline: 从字幕和画面出发，导入、查找、整理并导出视频内容。
  actions:
    - theme: brand
      text: 创建第一个项目
      link: /getting-started/first-project
    - theme: alt
      text: 查看 0.3.3 新增功能
      link: /release-notes/v0.3.3

features:
  - title: 导入和自动整理
    details: 浏览文件夹、预览和筛选媒体，导入时复制校验、创建媒体箱并自动绑定音频或字幕。
  - title: 查找和调整片段
    details: 跨多个来源搜索字幕和分镜，用高亮导航核对结果，并在时间线上精修分镜切点。
  - title: 导出和交付
    details: 选择片段，配置画面、音频、命名和冲突处理方式，再逐项或合并输出。
---

## 0.3.3 新增功能

0.3.3 提供统一的过滤/高亮搜索、匹配项导航、多来源字幕与分镜整理，以及可恢复的面板来源工作区。已有分镜重新识别时可以合并切点或覆盖结果；分镜导出范围可单独调整、撤销和重做。缩略图和分镜检测采用更有界的后台处理，缺失封面或内嵌字幕数据可自动补充分析。

[查看 LineCut 0.3.3 的完整新增功能和升级注意事项](/release-notes/v0.3.3)。

## 开始使用

- 第一次使用，请依次阅读[安装与首次启动](/getting-started/install)、[创建第一个项目](/getting-started/first-project)。
- 准备导入素材时，请看[导入和整理媒体](/media/import-organize)。
- 想先了解界面，请看[认识工作界面](/getting-started/interface)。

## 按任务学习

| 你想完成的任务             | 从这里开始                                             |
| -------------------------- | ------------------------------------------------------ |
| 从长视频中找到一句台词     | [通过字幕找到片段](/workflows/find-dialogue)           |
| 按画面内容整理素材         | [整理分镜并建立关键字](/workflows/organize-storyboard) |
| 预览字幕范围或调整镜头切点 | [使用源监视器](/source/source-monitor)                 |
| 改善高码率素材预览         | [生成代理以流畅预览](/workflows/create-proxy)          |
| 输出片段或合并成片         | [导出所选片段或成片](/workflows/export-video)          |

## 常用文章

- [创建和管理项目](/projects/projects)
- [管理音频与字幕轨](/media/tracks-binding)
- [使用字幕](/subtitles/subtitles)
- [使用分镜](/storyboard/storyboards)
- [支持的媒体与输出格式](/reference/supported-formats)

## 故障排查

导入、代理、预览或导出失败时，从[故障排查](/troubleshooting/troubleshooting)开始。页面按 FFmpeg、媒体离线、导入与导出、缓存和性能分类，并说明如何收集日志和最小复现信息。

## 本站的使用方式

左侧目录按“新增功能—开始使用—导入—预览—整理—导出—排错”的工作顺序组织；右上角搜索会在本机浏览器内检索整套指南。功能文章先说明结果和前置条件，再给出步骤、限制与关联任务。尚未补图的位置会显示**截图待补**卡片和应呈现的画面说明；它们不是程序中的按钮或提示。

> [!TIP]
> 本套用户指南对应 LineCut v0.3.3，并以该版本源码中已经实现的行为为准。若你的应用界面与本文不同，请先确认使用的版本，再参阅对应的更新说明。

## 反馈文档问题

如果文章缺少步骤、图示或与实际行为不符，可在页面底部通过“在 GitHub 上修改此页”提交修改建议，也可在项目的 Issues 中说明所用版本、操作步骤和截图。
