import type { UserNotice } from "../../types";

export type ExportSourceKind = "storyboard" | "subtitle" | "media-bin";

export type ExportClipThumbnailKind = "storyboard" | "subtitle" | "video";

/** Technical details of the source file behind an export clip, for the preview/media-info panel. */
export interface ExportSourceMedia {
  fileName: string;
  /** Container label derived from the file extension, e.g. "MP4". */
  container: string;
  videoCodec: string | null;
  audioCodec: string | null;
  /** Number of channels in the source audio stream (1=mono, 2=stereo, 6=5.1, ...). */
  audioChannels: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  /** Pixel aspect ratio of the video stream (1 means square pixels). */
  pixelAspectRatio: number | null;
  audioSampleRateHz: number | null;
  /** ffprobe channel layout of the audio stream, e.g. "stereo". */
  audioChannelLayout: string | null;
  fileSize: number;
  durationUs: number;
}

/** One audible source selected by the media bin's current audio binding state. */
export interface ExportClipAudioSource {
  sourcePath: string;
  /** Zero-based index among the file's audio streams (the FFmpeg `a:N` index). */
  audioTrackIndex: number;
  /** Lets proxy export replace only the video's own audio, not other streams from the source. */
  primary: boolean;
}

/** A single video segment to export, described by its source file and time range. */
export interface ExportClip {
  id: string;
  /** Media-bin video identity used to refresh bindings immediately before export. */
  videoId: string;
  sourcePath: string;
  /** The 字幕/分镜 component value: subtitle text, shot title, or media-bin name. */
  label: string;
  /** Media-bin display name of the source (may be a virtual rename). */
  sourceName: string;
  /** Storyboard shot keyword string (分镜-关键字); undefined for other sources. */
  keywordText?: string;
  startUs: number;
  /** End offset in the source file; <= 0 means "up to the end of the source". */
  endUs: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** All enabled, online audio tracks currently bound to this video. */
  audioSources: ExportClipAudioSource[];
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
  /** Proxy file for this clip's source, when one exists; used when 使用代理 is on. */
  proxyPath: string | null;
  /** Source file technical details, resolved from the project at build time. */
  sourceMedia?: ExportSourceMedia;
}

/** The set of clips an editor area handed to the export page. */
export interface ExportSource {
  kind: ExportSourceKind;
  title: string;
  clips: ExportClip[];
  assetId?: string;
}

export type ExportMode = "merge" | "individual";
export type ExportContainer =
  "mp4_h264" | "mp4_hevc" | "mov_prores" | "webm_vp9" | "mp3_audio" | "aac_audio";
/**
 * Where the exported files are written. Values below the dropdown divider map
 * to well-known Windows folders resolved by the backend `resolve_known_folder`
 * command.
 */
export type ExportDestination =
  "specified" | "source" | "desktop" | "documents" | "user" | "videos" | "pictures";
export type ExportResolution = "match_source" | "custom";
export type ExportQuality = "low" | "medium" | "high" | "very_high";
export type ExportEncoderSpeed = "fast" | "balanced" | "quality";
/** Auto uses a compatible GPU/iGPU encoder when FFmpeg and the driver expose one, then falls back to CPU. */
export type ExportHardwareAcceleration = "auto" | "software";
export type ExportAudioCodec = "aac" | "mp2" | "mp3" | "opus";
export type ExportAudioFormat = "aac" | "mpeg" | "opus";
export type ExportAudioChannels = "stereo" | "mono" | "5.1";

/**
 * Output filename rule for the 重命名规则 group. The rule is a 1–2 part
 * composition: `"label"` renders as 字幕/分镜 depending on the source kind,
 * `"time"` is the clip's time range, `"filename"` the media-bin display name,
 * `"custom"` the 自定文本, and `"label_keywords"` the storyboard keyword string.
 */
export type ExportRenameRule =
  | "label"
  | "label_keywords"
  | "time"
  | "time_label"
  | "filename"
  | "filename_label"
  | "filename_time"
  | "custom"
  | "custom_label"
  | "custom_time"
  | "custom_filename";

export type ExportExtensionCase = "upper" | "lower";

/** How an export handles an output file that already exists on disk. */
export type ExportExistingFileMode = "ask" | "uniqueName" | "overwrite" | "skip";

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
  hardwareAcceleration: ExportHardwareAcceleration;
  includeVideo: boolean;
  includeAudio: boolean;
  audioCodec: ExportAudioCodec;
  /** null means "match source". */
  audioSampleRateHz: number | null;
  audioChannels: ExportAudioChannels;
  audioBitrateKbps: number;
  /** Import the exported file(s) into the media bin after a successful export. */
  importIntoProject: boolean;
  /** Export from proxy files instead of the original sources when available. */
  useProxy: boolean;
  destination: ExportDestination;
  useSubfolder: boolean;
  /** Subfolder name used when `useSubfolder` is on; trimmed at export time. */
  subfolderName: string;
  /** Base target folder (before any subfolder is appended). */
  outputDir: string;
  outputStem: string;
  renameRule: ExportRenameRule;
  /** Custom name segment for the 自定名称/自定名称-* rules. */
  customName: string;
  /** First number used when duplicate filenames are disambiguated with -N. */
  startNumber: number;
  extensionCase: ExportExtensionCase;
  /** Explicit merged-output filename (with extension) for merge exports. */
  outputName: string;
  existingFileMode: ExportExistingFileMode;
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
  ["mp4_h264", "H.264"],
  ["mp4_hevc", "HEVC（H.265）"],
  ["mov_prores", "MOV（Apple ProRes）"],
  ["webm_vp9", "WebM（VP9）"],
  ["mp3_audio", "MP3"],
  ["aac_audio", "AAC 音频"],
];

/** File extension for an export container, used to build output filenames. */
export function containerExtension(
  container: ExportContainer,
): "mp4" | "mov" | "webm" | "mp3" | "aac" {
  switch (container) {
    case "mp4_h264":
    case "mp4_hevc":
      return "mp4";
    case "mov_prores":
      return "mov";
    case "webm_vp9":
      return "webm";
    case "mp3_audio":
      return "mp3";
    case "aac_audio":
      return "aac";
  }
}

/** Audio-only containers cannot carry a video stream. */
export function isAudioOnlyContainer(container: ExportContainer): boolean {
  return container === "mp3_audio" || container === "aac_audio";
}

/** Destination options for the 导出到 dropdown; the well-known Windows folders are rendered below a separator, apart from the file/source-based options. */
export const exportDestinationOptions: Array<readonly [ExportDestination, string]> = [
  ["specified", "指定文件夹"],
  ["source", "原始照片所在的文件夹"],
  ["desktop", "桌面"],
  ["documents", "“我的文档”文件夹"],
  ["user", "用户文件夹"],
  ["videos", "“我的视频”文件夹"],
  ["pictures", "“图片收藏”文件夹"],
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

export const exportHardwareAccelerationOptions: Array<
  readonly [ExportHardwareAcceleration, string]
> = [
  ["auto", "硬件加速"],
  ["software", "仅限软件"],
];

/** Audio formats each container can actually hold. */
export function exportAudioFormatOptions(
  container: ExportContainer,
): Array<readonly [ExportAudioFormat, string]> {
  if (container === "webm_vp9") {
    return [["opus", "Opus"]];
  }
  if (container === "mp3_audio") {
    return [["mpeg", "MPEG"]];
  }
  if (container === "aac_audio") {
    return [["aac", "AAC"]];
  }
  return [
    ["aac", "AAC"],
    ["mpeg", "MPEG"],
  ];
}

/** Maps a concrete audio codec back to the format family shown in the 音频格式 dropdown. */
export function audioFormatOfCodec(codec: ExportAudioCodec): ExportAudioFormat {
  switch (codec) {
    case "aac":
      return "aac";
    case "opus":
      return "opus";
    default:
      return "mpeg";
  }
}

/** Default codec when a format family is picked (MPEG defaults to Layer III). */
export function defaultAudioCodecForFormat(format: ExportAudioFormat): ExportAudioCodec {
  switch (format) {
    case "aac":
      return "aac";
    case "opus":
      return "opus";
    case "mpeg":
      return "mp3";
  }
}

/** MPEG audio layers the bundled ffmpeg can encode (no Layer I encoder exists). */
export const exportAudioLayerOptions: Array<readonly [ExportAudioCodec, string]> = [
  ["mp2", "MPEG-1, Layer II"],
  ["mp3", "MPEG-1, Layer III"],
];

/** Sample rates (Hz) each format family supports; "source" keeps the source rate. */
export function exportAudioSampleRateOptions(
  format: ExportAudioFormat,
): Array<readonly [string, string]> {
  const rates =
    format === "mpeg" ? [32000, 44100, 48000] : [16000, 22050, 24000, 32000, 44100, 48000];
  return [
    ["source", "匹配源"],
    ...rates.map((rate): [string, string] => [String(rate), `${rate} Hz`]),
  ];
}

/** Channel layouts the exporter can produce; Surround (5.1) is only offered when the source actually carries enough channels. */
export function exportAudioChannelOptions(
  sourceChannels: number | null,
): Array<readonly [ExportAudioChannels, string]> {
  const options: Array<readonly [ExportAudioChannels, string]> = [
    ["stereo", "立体声"],
    ["mono", "单声道"],
  ];
  if (sourceChannels !== null && sourceChannels >= 6) {
    options.push(["5.1", "5.1 声道"]);
  }
  return options;
}

export function exportAudioChannelLabel(channels: ExportAudioChannels): string {
  switch (channels) {
    case "stereo":
      return "立体声";
    case "mono":
      return "单声道";
    case "5.1":
      return "5.1 声道";
  }
}

/** Bitrate ladder values in [from, to] (kbps) stepping by `step`. */
function steppedBitrates(from: number, to: number, step: number): number[] {
  const values: number[] = [];
  for (let value = from; value <= to; value += step) {
    values.push(value);
  }
  return values;
}

/** AAC/Opus ladder: fine steps at low bitrates, coarser at high ones. */
const aacBitrateSegments = [
  [16, 32, 4],
  [32, 64, 8],
  [64, 128, 16],
  [128, 256, 32],
  [256, 512, 64],
] as const;

/** Audio bitrate (kbps) options per format family and concrete MPEG layer. */
export function exportAudioBitrateOptions(
  format: ExportAudioFormat,
  codec?: ExportAudioCodec,
): Array<readonly [string, string]> {
  const values =
    format === "mpeg"
      ? codec === "mp2"
        ? [128, 160, 192, 224, 256, 320, 384]
        : [128, 160, 192, 224, 256, 320]
      : [
          ...new Set(
            aacBitrateSegments.flatMap(([from, to, step]) => steppedBitrates(from, to, step)),
          ),
        ];
  return values.map((value) => [String(value), String(value)]);
}
