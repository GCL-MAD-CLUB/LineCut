import type { ExportSource } from "../../systems/ExportSystem/exportTypes";

export interface ApplicationEventMap {
  "media.import.requested": { paths?: string[]; folderId?: string };
  "export.requested": { source: ExportSource };
  "export.configure-selection.requested": Record<string, never>;
  "export.quick-selection.requested": Record<string, never>;
  "edit.copy.requested": Record<string, never>;
  "edit.paste.requested": Record<string, never>;
  "edit.clear.requested": Record<string, never>;
  "edit.duplicate.requested": Record<string, never>;
  "edit.select-all.requested": Record<string, never>;
  "edit.clear-selection.requested": Record<string, never>;
  "playback.seek.requested": { timeUs: number; focusEndUs?: number; play?: boolean };
}

export type ApplicationEventType = keyof ApplicationEventMap;
