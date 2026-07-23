export const EDIT_CAPABILITY_PROJECTION = "edit.capability";
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

export interface PlaybackStatusProjection {
  active: boolean;
  lastFocusedAt: number;
  currentFrame: number;
  isPlaying: boolean;
}
