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
- `src/components/*`：组件直接组合其需要的项目端口、私有状态和运行时能力；不得新增 `use...System` 聚合层。

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
