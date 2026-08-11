export const EDIT_CAPABILITY_PROJECTION = "edit.capability";
export const EXPORT_CAPABILITY_PROJECTION = "export.capability";
export const MEDIA_SELECTION_CAPABILITY_PROJECTION = "media.selection.capability";
export const PLAYBACK_STATUS_PROJECTION = "playback.status";

export interface EditCapabilityProjection {
  active: boolean;
  selectedCount: number;
  visibleCount: number;
  capabilities: {
    copy: boolean;
    paste: boolean;
    clear: boolean;
    duplicate: boolean;
    selectAll: boolean;
    clearSelection: boolean;
  };
}

export interface ExportCapabilityProjection {
  active: boolean;
  selectedCount: number;
  capabilities: {
    configure: boolean;
    quick: boolean;
  };
}

export interface MediaSelectionCapabilityProjection {
  active: boolean;
  selectedCount: number;
  capabilities: {
    replaceMedia: boolean;
    linkMedia: boolean;
    makeOffline: boolean;
  };
}

export interface PlaybackStatusProjection {
  active: boolean;
  lastFocusedAt: number;
  currentFrame: number;
  isPlaying: boolean;
}
