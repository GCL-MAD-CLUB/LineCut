export const EDIT_CAPABILITY_PROJECTION = "edit.capability";
export const EXPORT_CAPABILITY_PROJECTION = "export.capability";
export const MEDIA_SELECTION_CAPABILITY_PROJECTION = "media.selection.capability";
export const PLAYBACK_STATUS_PROJECTION = "playback.status";
export const PLAYBACK_HISTOGRAM_DEMAND_PROJECTION = "playback.histogram-demand";
export const PLAYBACK_SOURCE_MODE_PROJECTION = "playback.source-mode";
export const PANEL_TITLE_PROJECTION = "panel.title";

export interface PanelTitleProjection {
  title: string;
}

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
  histogram?: import("../../core/editor/frameHistogram").FrameHistogram | null;
  active: boolean;
  lastFocusedAt: number;
  currentFrame: number;
  isPlaying: boolean;
  videoId: string;
  sourcePanelId: string | null;
}

export interface PlaybackHistogramDemandProjection {
  enabled: boolean;
}

export interface PlaybackSourceModeProjection {
  mode: "subtitles" | "storyboard";
  videoId: string;
  frame: number;
}
