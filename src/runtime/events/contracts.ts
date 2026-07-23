export interface ApplicationEventMap {
  "media.import.requested": { paths?: string[]; folderId?: string };
  "edit.copy.requested": Record<string, never>;
  "edit.paste.requested": Record<string, never>;
  "edit.clear.requested": Record<string, never>;
  "edit.duplicate.requested": Record<string, never>;
  "edit.select-all.requested": Record<string, never>;
  "edit.clear-selection.requested": Record<string, never>;
  "playback.seek.requested": { timeUs: number; focusEndUs?: number; play?: boolean };
}

export type ApplicationEventType = keyof ApplicationEventMap;
