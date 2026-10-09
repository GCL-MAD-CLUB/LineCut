# 组件系统通信架构

## 目标

LineCut 中的“组件”是一套自治系统，而不只是 UI。业务能力、私有状态、命令处理和对外投影都归组件目录所有。应用壳负责软件级工作流，组件之间不读取彼此的私有 store，也不保存彼此实例的引用。

通信统一分为两种：

- 事件用于表达“发生了什么”或“请求执行什么”，采用无目标广播。
- 状态投影用于表达“外部现在可以看到什么”，采用只读、版本化、按需订阅。

项目文件本身的持久化聚合由 `ProjectSystem` 负责；任务生命周期由 `TaskSystem` 负责。视觉组件直接按需订阅类型化项目端口、组件私有状态和运行时能力，不建立额外的 `use...System` 组合适配器。

## 分层

```text
视觉组件 TSX
  │ 直接按需订阅项目端口、私有状态和运行时能力
  ▼
组件系统
  ├─ 私有 store：组件内部事实、交互状态和业务规则
  ├─ ProjectSystem port：项目文档的查询和命令
  ├─ EventHub：广播请求/事实
  └─ StateHub：发布最小只读投影

软件系统
  ├─ ProjectSystem：项目文件聚合、历史记录、持久化状态
  └─ TaskSystem：长任务、进度、取消和失败生命周期
```

目录职责：

- `src/runtime/events`：事件契约、事件信封、广播和 React 订阅适配。
- `src/runtime/state`：投影契约、版本管理和 React 外部状态订阅。
- `src/runtime/systems`：稳定的系统身份。
- `src/systems/ProjectSystem`：项目聚合与历史；外部只能使用按需选择的类型化项目端口。
- `src/systems/TaskSystem`：软件级任务生命周期。
- `src/components/panels`：业务面板和导入、导出工作区；组件直接组合其需要的项目端口、私有状态和运行时能力，不得新增 `use...System` 聚合层。
- `src/components/common`：共享对话框、菜单、布局、搜索和控件；`utils` 保存共享交互辅助逻辑。
- 面板目录保留入口、主组件、样式和面板私有状态；文件较多时按职责拆入 `views`、`controls`、`browser`、`selection`、`preview`、`annotations`、`analysis` 等子目录。监视器的 `video`、`timeline`、`histogram` 和 `audio` 分别管理视频显示、时间轴、直方图和音频实现。

## EventHub：无目标广播

发布方只提供事件类型、业务载荷和来源身份，永远不指定接收方：

```ts
void publishEvent("playback.seek.requested", { timeUs, focusEndUs, play }, identity);
```

EventHub 为载荷生成不可变事件信封并放入顺序队列。每次发布都会遍历当时的全部订阅；订阅者先按事件类型选择，再在处理器内依据自己的私有状态判断是否处理：

```ts
useBroadcastEvent(identity, "playback.seek.requested", ({ payload }) => {
  if (!isPlaybackAuthority) {
    return "ignored";
  }
  seek(payload.timeUs);
  return "handled";
});
```

关键语义：

- 没有 `target`、`receiver`、`instanceId` 路由字段。
- 发布者不知道谁会处理，接收者也不需要被注册到发布者。
- 一个接收者返回 `handled` 不会消费或销毁事件；其他接收者仍会收到同一信封。
- 某个接收者失败不会中断其他接收者，失败进入投递报告并由统一错误系统记录。
- 信封和载荷在发布时深度冻结；事件日志仅保留最近的诊断快照。
- `correlationId`、`causationId` 和业务上下文属于追踪信息，不参与寻址。

事件契约只允许放“完成请求所需的业务数据”。如果某字段的目的只是选择某个面板实例，它不应出现在契约中。

## StateHub：只读投影

组件的完整状态永远不发布。组件系统只发布其他系统实际需要的最小视图：

```ts
usePublishProjection(EDIT_CAPABILITY_PROJECTION, identity, {
  active: isEditAuthority,
  selectedCount,
  visibleCount,
  capabilities,
});
```

每份投影由 `key + owner identity` 唯一标识，包含单调递增的 `revision`。投影值会被深度冻结；发布组件卸载时，React 适配器会自动删除其投影。

消费者按投影 key 订阅：

```ts
const editCapabilities = useProjections<EditCapabilityProjection>(EDIT_CAPABILITY_PROJECTION);
```

因此，消费者看不到发布者的私有 store、action 或内部数据结构，也不能反向修改状态。需要改变状态时必须广播事件，或调用软件系统明确暴露的命令端口。

当前公共投影：

- `edit.capability`：当前编辑权威、选择数量和菜单可用性。
- `playback.status`：播放面板活跃度、最近聚焦时间、当前帧和播放状态。

## 多面板仲裁

广播本身不选择实例。多实例面板通过相同、确定性的接收方规则各自过滤：

- 编辑命令：只有当前聚焦且处于活动页签的媒体箱或字幕面板处理。
- 播放跳转：优先活动播放面板，再比较最近聚焦时间，最后以稳定系统身份打破平局。

仲裁信息作为状态投影存在，所以菜单、快捷键和组件使用的是同一份可观察事实；发布方仍不持有目标面板 ID。

## 组件开发约束

新增或修改组件时：

1. 业务和私有状态放在组件目录。
2. 组件直接按需调用类型化项目端口、本组件私有状态和运行时能力；派生值留在组件内，不新增组合 Hook。
3. 用 `useProjectPort` 一次声明所需数据和命令，不直接导入 `ProjectState`。
4. 跨组件请求先在 `runtime/events/contracts.ts` 声明，再广播。
5. 跨组件读取先定义最小投影；不得导入另一个组件的私有 `*State`，也不得新增 `use...System` 组合层。
6. 不得重新引入 DOM `CustomEvent`、目标实例事件、消费式事件或旧的全局 store API。

`npm run check:architecture` 会检查这些边界，`npm run build` 默认先执行该检查。

## 已移除的旧入口

以下旧架构不再保留兼容层：

- `src/appEvents.ts`
- `src/store.ts`
- `src/projectHistory.ts`
- `src/panelState.tsx`
- `useAppStore`、`appStore`
- `emitAppEvent`、`useAppEvent`
- 带面板实例目标的事件载荷

不提供双写或桥接层，避免新旧通信模型长期并存。

## 0.3.3 的应用媒体层与多来源

本节以 `release/0.3.3` 为基准，补充前述组件边界在多来源界面中的具体落点。多来源是应用视图与编辑路由，不把各视频转换成一个共享媒体文件。

| 模块                                           | 职责与不变量                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `core/editor/textSearch.ts`                    | 纯文本匹配、高亮范围与循环索引；不读项目、DOM 或媒体文件               |
| `components/common/PanelSearch`                | 共享搜索 UI、模式/规则菜单、序号输入与键盘导航；业务选择仍交给调用面板 |
| `core/editor/panelSourceSelection.ts`          | 来源选择、工作区快照、有界历史与配置校验的纯逻辑                       |
| `application/media/panelMediaSources.ts`       | 组织可用来源、各面板来源工作区、预览联动与面板菜单                     |
| `application/media/panelMediaPersistence.ts`   | 恢复/保存来源工作区、来源列宽与方向                                    |
| `application/media/projectPanelPersistence.ts` | 按项目与面板恢复状态，延迟保存，切换时刷新待写快照                     |
| `core/editor/multiSource.ts`                   | 以来源上下文包装显示 ID，汇总视图并把编辑分发回原来源                  |
| `components/common/MediaSourceMenu`            | 按媒体箱树构造菜单，并标示后代是否包含选择                             |

显示行采用 `@row:` 编码来源上下文与本地 ID，组合作用域使用 `@sources:`。它们仅用于面板和多来源变换；持久化字幕/分镜仍使用原本 ID。即使两个视频有同一镜头编号，标注也不会按编号覆盖另一来源。来源作为第一排序键；每个来源内部继续应用该面板列排序。

分镜状态变换在来源内执行合并、删除与堆叠，不能生成跨视频镜头范围或堆叠成员。关键字目录按项目协调，直接赋值仍回写各视频的镜头标注。导出快照逐片段携带源路径、媒体信息、音频关系与时间范围，不以当前活动视频覆盖多来源片段。

## 来源工作区、播放投影与会话状态

每个字幕/分镜面板实例拥有多个来源工作区。手动来源变化由 `recordPanelSourceHistory` 记录，最多保留十步回退及当前位置；普通播放和行定位只更新当前快照。旧位置之后产生新来源编辑会截断前进路径，关闭工作区会移除该工作区历史。

`media.video.opened` 表达打开视频请求，媒体面板据此建立新的来源工作区。`playback.source-mode` 最小投影表达字幕/分镜模式、视频与帧位置；源监视器通过应用层读取它，不能直接导入字幕或分镜私有 store。只有一个可见媒体面板时视为来源控制者，多面板时使用实际聚焦规则，隐藏标签不凭标题变化接管播放。

面板标题是可观察 UI 状态，显示来源数量或单个文件名，不作为播放路由地址。字幕轨改变可通过项目事件附带的来源前后快照恢复对应面板选择；快照中的面板 ID 用于历史状态回放，不作为 EventHub 发布目标。

长期项目事实与临时视图必须区分。来源工作区按项目 ID 和面板实例保存在本机配置；搜索、过滤和选择按工作区/来源上下文保留会话，重新启动并不保证恢复。项目切换时先恢复目标配置再启用写入，避免把上一项目状态写入下一项目；同一配置键的写入按顺序串行，保存失败进入错误系统。

## 非阻塞任务调度与媒体分析

`TaskSystem` 的 `createTaskProgress` 立即注册 `queued` 任务，但 Promise 在授予执行槽后才返回句柄。调用方必须检查 `cancelled` 再启动后端，且只在底层实际完成或停止后调用 `remove` / `fail`。`blocking` 选项已经废弃，运行视图始终为非阻塞。

三个槽位只用于最多三项 `storyboard.detect` 并行；其他操作独占执行。调度按队列顺序扫描，遇到普通任务会停下，不能让后续检测越过该普通任务。取消排队任务使调用方拿到已取消句柄而不执行工作；取消运行任务由所有者清理，`cancelAllTaskProgress` 暂停补位并等待结束。

`application/media/mediaAnalysisTask.ts` 保持独立于导入页面生命周期的分析队列，等待前批和优先自动绑定结束，然后提交统一任务。媒体箱延迟一秒进行首次缺失检查，并以约一分钟周期重试；`find_media_needing_analysis` 检查磁盘上的视频封面和内嵌文本字幕完整性。缓存检查不复制大型字幕集合，已有轨道/条目优先复用，异步合并校验项目与素材版本。

封面读取不再顺带启动分析；视频封面生成统一进入分析队列。取消或切换项目后，只处理仍有效的目标，不能把后台结果提交给另一个项目。更具体的缩略图与检测并行实现见[分镜检测](./storyboard-event-detection.md)与[媒体管线](./media-processing.md)。

## 导出范围的独立历史

`ExportSystem/exportWorkspaceState.ts` 管理待导出片段及范围历史，`canEditExportClipRange` 只允许分镜来源。一次范围拖动以 `groupId` 合并为一个历史项；修改后更新片段时长和缩略图时间。它不调用项目分镜切点命令。

`App.tsx` 根据工作区路由撤销/重做：编辑区调用项目历史，导出区调用 `undoClipRange` / `redoClipRange`。刷新来源时按片段 ID 与 `sourcePath` 保留仍适用的范围并过滤历史；切换项目清空。任务提交时克隆来源与设置，后续 UI 范围变化不回写已排队任务，也不能撤销文件覆盖。

验证这些边界优先阅读源代码、纯逻辑测试和仓库门禁。用户操作清单由 `scripts/user-guide-operations.mjs` 维护；文档结构与链接由 `npm run docs:build` 验证。不要通过生成视频和复杂媒体软件流程代替代码级审查。
