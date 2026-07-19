import { invoke } from "@tauri-apps/api/core";
import { clientError, ERROR_CATEGORIES } from "./model";
import type {
  ErrorCategory,
  Incident,
  IncidentPresentation,
  NormalizedError,
  OperationKey,
  OperationOutcome,
  PublicCommandError,
  PublicContext,
} from "./model";

const errorCategorySet = new Set<string>(ERROR_CATEGORIES);

function errorCategory(value: unknown): ErrorCategory {
  return typeof value === "string" && errorCategorySet.has(value)
    ? (value as ErrorCategory)
    : "runtime";
}

function normalizedError(error: unknown): NormalizedError | null {
  if (
    typeof error !== "object" ||
    error === null ||
    typeof (error as Partial<NormalizedError>).errorId !== "string" ||
    typeof (error as Partial<NormalizedError>).code !== "string" ||
    typeof (error as Partial<NormalizedError>).detail !== "string"
  ) {
    return null;
  }
  const value = error as Partial<NormalizedError>;
  return {
    errorId: value.errorId!,
    code: value.code!,
    category: errorCategory(value.category),
    retryable: value.retryable === true,
    detail: value.detail!,
  };
}

function serializedError(error: unknown): Partial<PublicCommandError> | null {
  if (typeof error === "object" && error !== null) {
    return error as Partial<PublicCommandError>;
  }
  if (typeof error !== "string" || !error.trim().startsWith("{")) {
    return null;
  }
  try {
    return JSON.parse(error) as Partial<PublicCommandError>;
  } catch {
    return null;
  }
}

function diagnosticDetail(error: unknown) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function normalizeError(error: unknown): NormalizedError {
  const normalized = normalizedError(error);
  if (normalized) {
    return normalized;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return clientError("BROWSER_ABORTED", diagnosticDetail(error));
  }
  const serialized = serializedError(error);
  const fallback = clientError("UNEXPECTED_ERROR", diagnosticDetail(error));
  return {
    errorId:
      typeof serialized?.errorId === "string" && serialized.errorId
        ? serialized.errorId
        : fallback.errorId,
    code: typeof serialized?.code === "string" && serialized.code ? serialized.code : fallback.code,
    category: errorCategory(serialized?.category),
    retryable:
      typeof serialized?.retryable === "boolean" ? serialized.retryable : fallback.retryable,
    detail: fallback.detail,
  };
}

export async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalizeError(error);
  }
}

export function recordFrontendIncident(incident: {
  errorId: string;
  operation: string;
  code: string;
  category: ErrorCategory;
  detail: string;
  occurrences: number;
  lastSeenAtMs: number;
}) {
  void invoke("record_frontend_incident", { incident }).catch(() => undefined);
}

const incidentLogWindowMs = 30_000;

interface IncidentLogWindow {
  latestError: NormalizedError;
  suppressedCount: number;
  lastSeenAtMs: number;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

const incidentLogWindows = new Map<string, IncidentLogWindow>();

function writeFrontendIncident(
  operation: OperationKey,
  error: NormalizedError,
  occurrences: number,
  lastSeenAtMs: number,
) {
  recordFrontendIncident({
    errorId: error.errorId,
    operation,
    code: error.code,
    category: error.category,
    detail: error.detail,
    occurrences,
    lastSeenAtMs,
  });
}

function recordFrontendIncidentRateLimited(operation: OperationKey, error: NormalizedError) {
  const key = `${operation}:${error.code}`;
  const now = Date.now();
  const activeWindow = incidentLogWindows.get(key);
  if (activeWindow) {
    activeWindow.latestError = error;
    activeWindow.suppressedCount += 1;
    activeWindow.lastSeenAtMs = now;
    return;
  }

  const window: IncidentLogWindow = {
    latestError: error,
    suppressedCount: 0,
    lastSeenAtMs: now,
    timer: globalThis.setTimeout(() => {
      const completedWindow = incidentLogWindows.get(key);
      if (!completedWindow) {
        return;
      }
      incidentLogWindows.delete(key);
      if (completedWindow.suppressedCount > 0) {
        writeFrontendIncident(
          operation,
          completedWindow.latestError,
          completedWindow.suppressedCount,
          completedWindow.lastSeenAtMs,
        );
      }
    }, incidentLogWindowMs),
  };
  incidentLogWindows.set(key, window);
  writeFrontendIncident(operation, error, 1, now);
}

const categoryMessages = {
  cancelled: "操作已取消。",
  validation: "输入或设置不符合要求，请检查后重试。",
  resource: "所需文件或资源当前不可用，请确认后重试。",
  state: "当前状态无法完成此操作，请稍后重试。",
  io: "文件读取或写入失败，请检查文件位置和访问权限后重试。",
  format: "文件内容或格式无法识别，请检查文件后重试。",
  security: "无法验证文件的安全信息，请确认文件来源后重试。",
  externalTool: "媒体处理组件未能完成操作，请稍后重试。",
  media: "媒体内容无法处理，请检查文件是否有效后重试。",
  platform: "系统未能完成此操作，请稍后重试。",
  runtime: "应用暂时无法完成此操作，请重试；若问题持续，请重新启动应用。",
  unsupported: "当前版本暂不支持此内容或操作。",
} satisfies Record<ErrorCategory, string>;

interface OperationPolicy {
  presentation: IncidentPresentation;
  title: (context: PublicContext) => string;
}

const namedTitle = (fallback: string) => (context: PublicContext) =>
  context.displayName ? `${fallback}：${context.displayName}` : fallback;

const silent = (title: string): OperationPolicy => ({
  presentation: "silent",
  title: () => title,
});

const modal = (title: string): OperationPolicy => ({
  presentation: "modal",
  title: namedTitle(title),
});

const operationPolicies = {
  "app.event": modal("操作失败"),
  "dragDrop.listen": silent("文件拖放监听失败"),
  "dragDrop.region": silent("文件拖放区域更新失败"),
  "export.clips": modal("导出失败"),
  "feedback.audio": silent("警告音效播放失败"),
  "media.bindSubtitles": modal("字幕绑定失败"),
  "media.closeBackend": modal("关闭后台媒体失败"),
  "media.demux": modal("分解媒体失败"),
  "media.import": modal("导入媒体失败"),
  "media.link": modal("连接媒体失败"),
  "media.playback": silent("媒体播放失败"),
  "media.relink": modal("重新链接媒体失败"),
  "media.replace": modal("替换媒体失败"),
  "media.revealProxy": modal("无法显示代理文件"),
  "preferences.load": modal("无法加载首选项"),
  "preferences.update": modal("无法保存首选项"),
  "project.autosave": modal("自动备份失败"),
  "project.close": modal("无法关闭项目"),
  "project.history": modal("无法完成历史操作"),
  "project.launchPath": modal("无法打开启动项目"),
  "project.new": modal("无法新建项目"),
  "project.open": modal("无法打开项目"),
  "project.restoreBackend": modal("恢复后台项目状态失败"),
  "project.save": modal("无法保存项目"),
  "project.sync": modal("无法同步项目状态"),
  "proxy.generate": modal("生成代理失败"),
  "runtime.render": modal("应用界面发生错误"),
  "runtime.unhandled": modal("应用发生未处理错误"),
  "storage.recentPaths": silent("最近记录更新失败"),
  "task.cancel": modal("取消任务失败"),
  "task.listener": modal("任务监听失败"),
  "thumbnail.subtitle.cache.read": silent("读取字幕缩略图缓存失败"),
  "thumbnail.subtitle.cache.write": silent("写入字幕缩略图缓存失败"),
  "thumbnail.subtitle.generate": silent("生成字幕缩略图失败"),
  "thumbnail.video": silent("生成视频封面失败"),
  "window.closeListener": modal("窗口关闭监听失败"),
  "window.title": silent("更新窗口标题失败"),
  "workspace.load": silent("加载工作区布局失败"),
  "workspace.save": silent("保存工作区布局失败"),
} satisfies Record<OperationKey, OperationPolicy>;

interface IncidentSnapshot {
  incidents: Incident[];
}

const listeners = new Set<() => void>();
let snapshot: IncidentSnapshot = { incidents: [] };

function publish(next: IncidentSnapshot) {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeIncidents(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getIncidentSnapshot() {
  return snapshot;
}

export function dismissIncident(id: string) {
  publish({ incidents: snapshot.incidents.filter((incident) => incident.id !== id) });
}

export function captureIncident(
  operation: OperationKey,
  error: NormalizedError,
  context: PublicContext = {},
) {
  if (error.category === "cancelled") {
    return;
  }

  recordFrontendIncidentRateLimited(operation, error);

  const policy = operationPolicies[operation];
  if (policy.presentation === "silent") {
    return;
  }

  const title = policy.title(context);
  const duplicate = snapshot.incidents.find(
    (incident) =>
      incident.operation === operation && incident.code === error.code && incident.title === title,
  );
  if (duplicate) {
    return;
  }

  const incident: Incident = {
    id: `${error.errorId}:${operation}`,
    errorId: error.errorId,
    operation,
    code: error.code,
    category: error.category,
    presentation: policy.presentation,
    title,
    message: categoryMessages[error.category],
    retryable: error.retryable,
    createdAt: Date.now(),
  };
  publish({ incidents: [...snapshot.incidents, incident] });
}

export function captureOperationError(
  operation: OperationKey,
  error: unknown,
  context: PublicContext = {},
) {
  const normalized = normalizeError(error);
  captureIncident(operation, normalized, context);
  return normalized;
}

export async function runOperation<T>(
  operation: OperationKey,
  action: () => Promise<T>,
  context: PublicContext = {},
): Promise<OperationOutcome<T>> {
  try {
    return { status: "success", value: await action() };
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.category === "cancelled") {
      return { status: "cancelled" };
    }
    captureIncident(operation, normalized, context);
    return { status: "failed", error: normalized };
  }
}

export function runBackgroundOperation(
  operation: OperationKey,
  action: () => Promise<unknown>,
  context: PublicContext = {},
) {
  void runOperation(operation, action, context);
}

export function installGlobalErrorHandlers() {
  const handleError = (event: ErrorEvent) => {
    captureOperationError("runtime.unhandled", event.error ?? event.message);
  };
  const handleRejection = (event: PromiseRejectionEvent) => {
    event.preventDefault();
    captureOperationError("runtime.unhandled", event.reason);
  };
  window.addEventListener("error", handleError);
  window.addEventListener("unhandledrejection", handleRejection);
}
