---
title: 安装与首次启动
description: 安装 LineCut、选择 FFmpeg 方案，并确认首次启动状态。
---

# 安装与首次启动

## 安装 LineCut

1. 打开 LineCut 的 GitHub Releases 页面，下载与 Windows 对应的安装程序。
2. 运行安装程序并按屏幕提示完成安装。
3. 安装程序询问 FFmpeg 方案时，首次使用建议选择**内置 FFmpeg**。它用于探测媒体、导入字幕、生成代理和导出。
4. 从开始菜单或桌面快捷方式启动 LineCut。

如果已安装并维护了自己的 FFmpeg，也可以不安装内置版本，随后在 **编辑 → 首选项** 中填写 `FFmpeg` 与 `ffprobe` 的可执行文件路径。具体排查方式见[FFmpeg、ffprobe 与工具路径](/troubleshooting/troubleshooting)。

<GuideImage src="/images/getting-started/install.png" alt="安装程序的 FFmpeg 选择页" />

## 首次启动后应看到什么

应用会显示菜单栏、工作区切换器和四个默认面板：**源播放器**、**媒体箱**、**字幕**、**分镜**。没有项目时，播放器和内容面板会显示空状态；这是正常现象。

默认工作区包含“导入、编辑、导出”三个入口。它们不创建不同的项目，而是切换你在当前项目中完成任务的工作界面。

<GuideImage src="/images/getting-started/install-2.png" alt="首次启动的空工作区" />

## 首次检查清单

- 在 **编辑 → 首选项** 中确认缓存路径有足够空间。
- 若未安装内置 FFmpeg，确认 `FFmpeg`、`ffprobe` 路径可用。
- 在 **文件 → 新建项目** 创建项目，或在 **文件 → 打开项目** 打开已有 `.lcp` 项目。
- 导入一段带字幕的视频，或分别导入视频和字幕文件。

> [!TIP]
> 浏览器预览只能展示界面，不能选择本地文件、保存首选项、导入本地媒体或生成代理。上述操作必须在安装后的 Tauri 桌面应用中完成。

继续阅读[创建第一个项目](/getting-started/first-project)。
