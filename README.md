# LineCut · 字幕索引片段导出工具

[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8D8?logo=tauri)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite)](https://vitejs.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-2021-000000?logo=rust)](https://www.rust-lang.org)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

> 通过字幕台词快速定位、选取并导出视频片段的桌面端工具。

LineCut 是一款基于 **Tauri v2 + React + TypeScript + Rust** 构建的跨平台桌面应用。它能够读取视频的内嵌或外挂字幕，将字幕按时间轴展开为可检索、可勾选的列表，并一键把选中的台词片段导出为独立视频文件或合并为一个完整片段。

---

## ✨ 功能特性

- **多格式视频支持**：`MKV`、`MP4`、`MOV`、`WebM`、`AVI`、`TS`、`M2TS` 等常见容器。
- **灵活的字幕来源**：支持内嵌字幕流解析，也支持 `SRT`、`ASS`、`SSA`、`VTT` 等外挂字幕文件。
- **高效的字幕检索**：按关键词实时过滤台词，快速定位目标片段。
- **虚拟化长列表**：基于 `@tanstack/react-virtual` 渲染海量字幕轴，滚动流畅不卡顿。
- **多种导出模式**：
  - **极速拷贝**（`fast_copy`）：直接流拷贝，不重新编码，速度快、画质无损。
  - **精确重编码**（`precise_encode`）：重新编码，兼容性与时间精度更高。
- **灵活的导出布局**：
  - **独立片段**：每条选中的台词导出为一个视频文件。
  - **合并输出**：将多条片段按时间顺序合并为一个视频。
- **智能片段命名**：支持以源文件名、时间范围、台词内容等规则命名导出文件。
- **前后留白自定义**：可设置片头、片尾保留时长，以及相邻片段的合并间隙。
- **低分辨率代理预览**：可生成代理文件，在编辑时获得更流畅的预览体验。
- **外部 FFmpeg 配置**：支持自定义 `ffmpeg` / `ffprobe` 路径、缓存目录与默认导出目录。

---

## 🖥️ 运行环境

- Windows 10 / 11（64 位）
- macOS

---

<p align="center">
  
  Made with ❤️ by GCL MAD CLUB - [言ktdm](https://github.com/Inexplicable-YL)
  
  </p>
