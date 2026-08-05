import type { UserNotice } from "../../types";

export type ExportSourceKind = "storyboard" | "subtitle" | "media-bin";

export type ExportClipThumbnailKind = "storyboard" | "subtitle" | "video";

/** A single video segment to export, described by its source file and time range. */
export interface ExportClip {
  id: string;
  sourcePath: string;
  label: string;
  /** Start offset in the source file, in microseconds. */
  startUs: number;
  /** End offset in the source file; <= 0 means "up to the end of the source". */
  endUs: number;
  hasVideo: boolean;
  hasAudio: boolean;
  durationUs: number;
  videoStreamIndex: number | null;
  /** Optional hint used to render a clip thumbnail in the export page. */
  thumbnail?: {
    kind: ExportClipThumbnailKind;
    assetId: string;
    timeUs: number;
    /** Asset fingerprint so the thumbnail request can reuse the editor's cache. */
    fingerprint?: string;
  };
}

/** The set of clips an editor area handed to the export page. */
export interface ExportSource {
  kind: ExportSourceKind;
  title: string;
  clips: ExportClip[];
  assetId?: string;
}

export type ExportMode = "merge" | "individual";
export type ExportContainer = "mp4_h264" | "mp4_hevc" | "mov_prores" | "webm_vp9";
export type ExportResolution = "match_source" | "custom";
export type ExportQuality = "low" | "medium" | "high" | "very_high";
export type ExportEncoderSpeed = "fast" | "balanced" | "quality";

export interface ExportSettings {
  mode: ExportMode;
  container: ExportContainer;
  resolution: ExportResolution;
  customWidth: number;
  customHeight: number;
  /** null means "match source". */
  frameRate: number | null;
  quality: ExportQuality;
  encoderSpeed: ExportEncoderSpeed;
  includeAudio: boolean;
  audioBitrateKbps: number;
  outputDir: string;
  outputStem: string;
}

export interface ExportOutput {
  clipId: string | null;
  path: string;
  status: "completed" | "failed";
  error: string | null;
  durationUs: number;
}

export interface ExportResult {
  outputs: ExportOutput[];
  warnings: UserNotice[];
}

export const exportContainerOptions: Array<readonly [ExportContainer, string]> = [
  ["mp4_h264", "MP4（H.264）"],
  ["mp4_hevc", "MP4（HEVC / H.265）"],
  ["mov_prores", "MOV（Apple ProRes）"],
  ["webm_vp9", "WebM（VP9）"],
];

export const exportModeOptions: Array<readonly [ExportMode, string]> = [
  ["merge", "合并为一个视频"],
  ["individual", "单独导出每个片段"],
];

export const exportResolutionOptions: Array<readonly [ExportResolution, string]> = [
  ["match_source", "匹配源"],
  ["custom", "自定义分辨率"],
];

export const exportQualityOptions: Array<readonly [ExportQuality, string]> = [
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["very_high", "最高"],
];

export const exportEncoderSpeedOptions: Array<readonly [ExportEncoderSpeed, string]> = [
  ["fast", "最快"],
  ["balanced", "均衡"],
  ["quality", "高质量"],
];
