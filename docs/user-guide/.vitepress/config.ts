import { defineConfig } from "vitepress";

const repository = "GCL-MAD-CLUB/LineCut";

function normalizeBase(value: string | undefined) {
  const candidate = (value ?? "/").trim();

  if (!candidate || candidate === "/") {
    return "/";
  }

  return `/${candidate.replace(/^\/+|\/+$/g, "")}/`;
}

export default defineConfig({
  lang: "zh-CN",
  title: "LineCut 帮助中心",
  description: "从字幕出发，快速找到并整理视频内容。",
  base: normalizeBase(process.env.DOCS_BASE),
  cleanUrls: false,
  lastUpdated: true,
  head: [
    ["meta", { name: "theme-color", content: "#315efb" }],
    ["meta", { property: "og:locale", content: "zh_CN" }],
  ],
  themeConfig: {
    siteTitle: "LineCut 帮助中心",
    nav: [
      { text: "快速开始", link: "/getting-started/first-project" },
      { text: "工作流", link: "/workflows/find-dialogue" },
      { text: "功能参考", link: "/reference/supported-formats" },
      { text: "项目主页", link: `https://github.com/${repository}` },
    ],
    sidebar: [
      { text: "LineCut 帮助中心", items: [{ text: "概览", link: "/" }] },
      {
        text: "快速开始",
        collapsed: false,
        items: [
          { text: "系统要求", link: "/getting-started/system-requirements" },
          { text: "安装与首次启动", link: "/getting-started/install" },
          { text: "创建第一个项目", link: "/getting-started/first-project" },
          { text: "认识工作界面", link: "/getting-started/interface" },
        ],
      },
      {
        text: "核心工作流",
        collapsed: true,
        items: [
          { text: "通过字幕找到片段", link: "/workflows/find-dialogue" },
          { text: "整理分镜并建立关键字", link: "/workflows/organize-storyboard" },
          { text: "生成代理以流畅预览", link: "/workflows/create-proxy" },
          { text: "导出所选片段或成片", link: "/workflows/export-video" },
        ],
      },
      {
        text: "项目与工作区",
        collapsed: true,
        items: [
          { text: "创建和管理项目", link: "/projects/projects" },
          { text: "首选项", link: "/projects/preferences" },
          { text: "工作区、面板与任务", link: "/workspace/workspace" },
          { text: "键盘快捷键", link: "/workspace/shortcuts" },
        ],
      },
      {
        text: "媒体箱",
        collapsed: true,
        items: [
          { text: "导入和整理媒体", link: "/media/import-organize" },
          { text: "管理音频与字幕轨", link: "/media/tracks-binding" },
          { text: "管理离线媒体与代理", link: "/media/offline-proxies" },
        ],
      },
      {
        text: "源播放器",
        collapsed: true,
        items: [{ text: "使用源监视器", link: "/source/source-monitor" }],
      },
      {
        text: "字幕",
        collapsed: true,
        items: [{ text: "使用字幕", link: "/subtitles/subtitles" }],
      },
      {
        text: "分镜与关键字",
        collapsed: true,
        items: [
          { text: "使用分镜", link: "/storyboard/storyboards" },
          { text: "使用关键字", link: "/storyboard/use-keywords" },
        ],
      },
      {
        text: "导出",
        collapsed: true,
        items: [{ text: "导出媒体", link: "/export/exporting" }],
      },
      {
        text: "参考与排错",
        collapsed: true,
        items: [
          { text: "支持的媒体与输出格式", link: "/reference/supported-formats" },
          { text: "使用限制与数据说明", link: "/reference/limitations" },
          { text: "功能覆盖清单", link: "/coverage" },
          { text: "故障排查", link: "/troubleshooting/troubleshooting" },
          { text: "v0.3.0 更新说明", link: "/release-notes/v0.3" },
        ],
      },
    ],
    search: {
      provider: "local",
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: "搜索", buttonAriaLabel: "搜索帮助中心" },
              modal: {
                noResultsText: "没有找到相关内容",
                resetButtonTitle: "清除搜索",
                backButtonTitle: "关闭搜索",
                displayDetails: "显示详细列表",
                footer: {
                  selectText: "选择",
                  selectKeyAriaLabel: "回车",
                  navigateText: "切换",
                  navigateUpKeyAriaLabel: "向上箭头",
                  navigateDownKeyAriaLabel: "向下箭头",
                  closeText: "关闭",
                  closeKeyAriaLabel: "Esc",
                },
              },
            },
          },
        },
      },
    },
    outline: { level: [2, 3], label: "本页内容" },
    editLink: {
      pattern: `https://github.com/${repository}/edit/main/docs/user-guide/:path`,
      text: "在 GitHub 上修改此页",
    },
    lastUpdated: { text: "最后更新于" },
    docFooter: { prev: "上一篇", next: "下一篇" },
    footer: {
      message: "以 Apache-2.0 许可证发布。",
      copyright: "Copyright © GCL MAD CLUB",
    },
    socialLinks: [{ icon: "github", link: `https://github.com/${repository}` }],
  },
});
