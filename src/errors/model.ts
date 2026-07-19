/** Stable operation names accepted by the application error boundary. */
export type OperationKey =
  | "app.event"
  | "dragDrop.listen"
  | "dragDrop.region"
  | "export.clips"
  | "feedback.audio"
  | "media.bindSubtitles"
  | "media.closeBackend"
  | "media.demux"
  | "media.import"
  | "media.link"
  | "media.playback"
  | "media.relink"
  | "media.replace"
  | "media.revealProxy"
  | "preferences.load"
  | "preferences.update"
  | "project.autosave"
  | "project.close"
  | "project.history"
  | "project.launchPath"
  | "project.new"
  | "project.open"
  | "project.restoreBackend"
  | "project.save"
  | "project.sync"
  | "proxy.generate"
  | "runtime.render"
  | "runtime.unhandled"
  | "storage.recentPaths"
  | "task.cancel"
  | "task.listener"
  | "thumbnail.subtitle.cache.read"
  | "thumbnail.subtitle.cache.write"
  | "thumbnail.subtitle.generate"
  | "thumbnail.video"
  | "window.closeListener"
  | "window.title"
  | "workspace.load"
  | "workspace.save";

export const ERROR_CATEGORIES = [
  "cancelled",
  "validation",
  "resource",
  "state",
  "io",
  "format",
  "security",
  "externalTool",
  "media",
  "platform",
  "runtime",
  "unsupported",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export type IncidentPresentation = "modal" | "silent";

export interface PublicContext {
  displayName?: string;
  count?: number;
  resourceKind?: "project" | "media" | "subtitle" | "proxy" | "preferences";
}

export interface PublicCommandError {
  errorId: string;
  code: string;
  category: ErrorCategory;
  retryable: boolean;
}

export interface NormalizedError extends PublicCommandError {
  detail: string;
}

export interface Incident {
  id: string;
  errorId: string;
  operation: OperationKey;
  code: string;
  category: ErrorCategory;
  presentation: Exclude<IncidentPresentation, "silent">;
  title: string;
  message: string;
  retryable: boolean;
  createdAt: number;
}

export type OperationOutcome<T> =
  | { status: "success"; value: T }
  | { status: "cancelled" }
  | { status: "failed"; error: NormalizedError };

// Client failures mirror Rust's closed ErrorCode catalog.
const clientErrorDefinitions = {
  BROWSER_ABORTED: { category: "cancelled", retryable: false },
  UNEXPECTED_ERROR: { category: "runtime", retryable: true },
  TASK_NOT_RUNNING: { category: "state", retryable: false },
  SUBTITLE_THUMBNAIL_REQUEST_CANCELLED: { category: "cancelled", retryable: false },
  SUBTITLE_THUMBNAIL_BROWSER_UNAVAILABLE: { category: "unsupported", retryable: false },
  VIDEO_FRAME_DECODE_FAILED: { category: "media", retryable: true },
  VIDEO_FRAME_DECODE_TIMEOUT: { category: "media", retryable: true },
  SUBTITLE_THUMBNAIL_ENCODE_FAILED: { category: "runtime", retryable: true },
  VIDEO_FRAME_DIMENSIONS_INVALID: { category: "media", retryable: false },
  SUBTITLE_THUMBNAIL_CANVAS_UNAVAILABLE: { category: "platform", retryable: false },
  PANEL_INSTANCE_CONTEXT_MISSING: { category: "state", retryable: false },
  PANEL_STATE_CONTEXT_MISSING: { category: "state", retryable: false },
  HISTORY_PANEL_SERVICES_UNAVAILABLE: { category: "state", retryable: false },
  PANEL_MANAGER_CONTEXT_MISSING: { category: "state", retryable: false },
  PANEL_INSTANCE_NOT_MANAGED: { category: "state", retryable: false },
  PANEL_TYPE_DUPLICATE: { category: "validation", retryable: false },
  PANEL_REGISTRY_CONTEXT_MISSING: { category: "state", retryable: false },
  POPUP_MENU_VALUE_DUPLICATE: { category: "validation", retryable: false },
  POPUP_MENU_GROUP_CONTEXT_MISSING: { category: "state", retryable: false },
  EXPORT_VIRTUAL_MEDIA_SOURCE_MISSING: { category: "resource", retryable: false },
  EXPORT_BOUND_MEDIA_PATH_MISSING: { category: "resource", retryable: false },
} as const satisfies Record<string, { category: ErrorCategory; retryable: boolean }>;

export type ClientErrorCode = keyof typeof clientErrorDefinitions;

function frontendErrorId() {
  return `FE-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
}

class ClientError extends Error implements NormalizedError {
  readonly errorId: string;
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly detail: string;

  constructor(code: ClientErrorCode, detail: string) {
    super(detail);
    const definition = clientErrorDefinitions[code];
    this.name = "ClientError";
    this.errorId = frontendErrorId();
    this.code = code;
    this.category = definition.category;
    this.retryable = definition.retryable;
    this.detail = this.stack || detail;
  }
}

export function clientError(code: ClientErrorCode, detail: string) {
  return new ClientError(code, detail);
}
