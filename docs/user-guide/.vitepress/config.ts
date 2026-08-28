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
          { text: "新建、打开、保存和关闭项目", link: "/projects/create-open-save" },
          { text: "最近项目、还原与自动备份", link: "/projects/recent-restore-autosave" },
          { text: "项目文件与素材位置", link: "/projects/project-files-media" },
          { text: "历史记录、撤销与分支", link: "/projects/history" },
          { text: "首选项", link: "/projects/preferences" },
          { text: "面板、停靠与工作区布局", link: "/workspace/panels" },
          { text: "键盘快捷键", link: "/workspace/shortcuts" },
          { text: "应用菜单参考", link: "/workspace/application-menu" },
          { text: "任务进度与取消", link: "/workspace/tasks" },
        ],
      },
      {
        text: "媒体箱",
        collapsed: true,
        items: [
          { text: "导入媒体", link: "/media/import" },
          { text: "媒体箱、文件夹与视图", link: "/media/bins" },
          { text: "管理媒体条目", link: "/media/manage-media" },
          { text: "绑定音频和字幕到视频", link: "/media/bind" },
          { text: "分解内嵌音轨和字幕流", link: "/media/embedded-tracks" },
          { text: "脱机、替换和重新链接", link: "/media/offline-relink" },
          { text: "创建、连接和分离代理", link: "/media/proxies" },
        ],
      },
      {
        text: "源播放器",
        collapsed: true,
        items: [
          { text: "预览、播放与逐帧控制", link: "/source/preview-playback" },
          { text: "时间线、缩放与时间码", link: "/source/timeline" },
        ],
      },
      {
        text: "字幕",
        collapsed: true,
        items: [
          { text: "字幕轨与字幕显示", link: "/subtitles/tracks" },
          { text: "搜索、过滤和排序字幕", link: "/subtitles/search-filter" },
          { text: "星级、旗标和色标", link: "/subtitles/annotations" },
          { text: "喷涂工具批量标注", link: "/subtitles/spray" },
          { text: "选择字幕并导出", link: "/subtitles/selection-export" },
        ],
      },
      {
        text: "分镜与关键字",
        collapsed: true,
        items: [
          { text: "检测镜头切点", link: "/storyboard/detection" },
          { text: "列表、图标与选择分镜", link: "/storyboard/views-selection" },
          { text: "标记分镜", link: "/storyboard/annotations" },
          { text: "堆叠、展开和拆分分镜", link: "/storyboard/stacks" },
          { text: "关键字系统概览", link: "/storyboard/keywords" },
          { text: "创建和管理关键字树", link: "/storyboard/keyword-management" },
        ],
      },
      {
        text: "导出",
        collapsed: true,
        items: [
          { text: "导出工作区概览", link: "/export/overview" },
          { text: "输出位置、模式和来源", link: "/export/output" },
          { text: "视频设置", link: "/export/video" },
          { text: "音频设置", link: "/export/audio" },
          { text: "命名规则", link: "/export/naming" },
          { text: "同名文件与导出队列", link: "/export/conflicts" },
        ],
      },
      {
        text: "参考与排错",
        collapsed: true,
        items: [
          { text: "支持的媒体与输出格式", link: "/reference/supported-formats" },
          { text: "使用限制与数据说明", link: "/reference/limitations" },
          { text: "功能覆盖清单", link: "/coverage" },
          { text: "FFmpeg、ffprobe 与工具路径", link: "/troubleshooting/ffmpeg" },
          { text: "素材脱机、无法预览或无字幕", link: "/troubleshooting/media" },
          { text: "导入、分析和导出失败", link: "/troubleshooting/import-export" },
          { text: "性能、缓存与代理", link: "/troubleshooting/performance" },
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
