import { Film } from "lucide-react";
import { formatDuration } from "../../time";
import { exportAudioChannelLabel } from "../../systems/ExportSystem";
import type { ExportClip, ExportSettings, ExportSourceMedia } from "../../systems/ExportSystem";
import type { MediaBinItem } from "../../types";

interface ExportMediaInfoProps {
  /** The clip currently previewed; its source media is shown under 来源. */
  clip: ExportClip | null;
  settings: ExportSettings;
  /** Total duration of all currently selected clips, in microseconds. */
  selectedDurationUs: number;
  /** Media bin items, used to show the source's media-bin name (post virtual rename). */
  mediaItems: MediaBinItem[];
}

const videoCodecLabels: Partial<Record<ExportSettings["container"], string>> = {
  mp4_h264: "H.264",
  mp4_hevc: "HEVC",
  mov_prores: "ProRes",
  webm_vp9: "VP9",
};

const audioCodecLabels: Record<ExportSettings["audioCodec"], string> = {
  aac: "AAC",
  mp2: "MP2",
  mp3: "MP3",
  opus: "Opus",
};

function formatFileSize(bytes: number) {
  if (bytes <= 0) {
    return "—";
  }
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const text = unitIndex === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${units[unitIndex]}`;
}

function formatFrameRate(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function channelLayoutLabel(layout: string | null) {
  switch (layout) {
    case "stereo":
      return "立体声";
    case "mono":
      return "单声道";
    case "5.1":
      return "5.1 声道";
    case "7.1":
      return "7.1 声道";
    default:
      return layout ?? "—";
  }
}

function formatKiloHz(hz: number) {
  return hz % 1000 === 0 ? `${hz / 1000} kHz` : `${(hz / 1000).toFixed(1)} kHz`;
}

const sourceVideoCodecLabels: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  vp9: "VP9",
  av1: "AV1",
  prores: "ProRes",
  mpeg2video: "MPEG-2",
  mpeg4: "MPEG-4",
};

const sourceAudioCodecLabels: Record<string, string> = {
  aac: "AAC",
  mp2: "MP2",
  mp3: "MP3",
  opus: "Opus",
  vorbis: "Vorbis",
  flac: "FLAC",
  ac3: "AC-3",
  eac3: "E-AC-3",
  dts: "DTS",
  pcm_s16le: "PCM",
  pcm_s24le: "PCM",
};

function sourceCodecLabel(codec: string | null, labels: Record<string, string>) {
  if (!codec) {
    return null;
  }
  return labels[codec] ?? codec.toLocaleUpperCase();
}

/** Video-quality summary shown on the output line; ProRes profiles mirror the encoder mapping. */
function outputQualityLabel(settings: ExportSettings) {
  if (settings.container === "mov_prores") {
    switch (settings.quality) {
      case "low":
        return "ProRes 422 Proxy";
      case "medium":
        return "ProRes 422";
      default:
        return "ProRes 422 HQ";
    }
  }
  const labels = { low: "低", medium: "中", high: "高", very_high: "最高" } as const;
  return `质量 ${labels[settings.quality]}`;
}

/**
 * Rough output-size estimate. The video encoders run in CRF mode (no target
 * bitrate), so this scales an empirical per-quality bitrate by pixels × fps;
 * ProRes uses its published per-profile bitrates instead.
 */
function estimateFileSizeBytes(
  settings: ExportSettings,
  sourceMedia: ExportSourceMedia | undefined,
  durationUs: number,
) {
  if (durationUs <= 0) {
    return null;
  }
  const width =
    settings.resolution === "custom" ? settings.customWidth : (sourceMedia?.width ?? 1920);
  const height =
    settings.resolution === "custom" ? settings.customHeight : (sourceMedia?.height ?? 1080);
  const fps = settings.frameRate ?? sourceMedia?.frameRate ?? 30;
  const scale = (width * height * fps) / (1920 * 1080 * 30);
  const h264Mbps = { low: 5, medium: 9, high: 14, very_high: 24 } as const;
  const proresMbps = { low: 45, medium: 147, high: 220, very_high: 220 } as const;
  const videoMbps = settings.includeVideo
    ? settings.container === "mov_prores"
      ? proresMbps[settings.quality] * scale
      : h264Mbps[settings.quality] * (settings.container === "mp4_h264" ? 1 : 0.6) * scale
    : 0;
  const audioMbps = settings.includeAudio ? settings.audioBitrateKbps / 1000 : 0;
  return ((videoMbps + audioMbps) * 1e6 * (durationUs / 1e6)) / 8;
}

function MediaRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="export-media-row">
      <dt className="export-media-label">{label}</dt>
      <dd className="export-media-value" title={title ?? value}>
        {value}
      </dd>
    </div>
  );
}

function SourceMediaSection({
  clip,
  mediaItems,
}: {
  clip: ExportClip | null;
  mediaItems: MediaBinItem[];
}) {
  const media = clip?.sourceMedia;
  if (!media) {
    return (
      <section className="export-media-block">
        <h3 className="export-media-heading">来源：</h3>
        <p className="export-media-empty">请先选择要预览的片段</p>
      </section>
    );
  }
  // Show the media-bin name (which may be a virtual rename) instead of the clip label.
  const mediaItem = mediaItems.find(
    (item) => item.kind === "video" && item.path === clip.sourcePath,
  );
  const mediaName = mediaItem?.file_name ?? media.fileName;
  const pixelAspect = media.pixelAspectRatio ? ` (${media.pixelAspectRatio.toFixed(1)})` : "";
  const videoCodec = sourceCodecLabel(media.videoCodec, sourceVideoCodecLabels);
  const audioCodec = sourceCodecLabel(media.audioCodec, sourceAudioCodecLabels);
  const video =
    media.width && media.height
      ? `${videoCodec ? `${videoCodec} | ` : ""}${media.width} × ${media.height}${pixelAspect} | ${
          media.frameRate ? `${formatFrameRate(media.frameRate)} fps` : "—"
        } | ${formatDuration(clip?.durationUs ?? media.durationUs)}`
      : "无视频";
  const audio = media.audioCodec
    ? `${audioCodec ? `${audioCodec} | ` : ""}${
        media.audioSampleRateHz ? `${media.audioSampleRateHz} Hz` : "—"
      } | ${channelLayoutLabel(media.audioChannelLayout)}`
    : "无音轨";
  return (
    <section className="export-media-block">
      <h3 className="export-media-heading">
        来源：
        <Film size={14} className="export-media-heading-icon" />
        <span className="export-media-heading-name" title={mediaName}>
          {mediaName}
        </span>
      </h3>
      <dl className="export-media-list">
        <MediaRow label="视频：" value={video} title={video} />
        <MediaRow label="音频：" value={audio} title={audio} />
      </dl>
    </section>
  );
}

interface ExportMediaSectionProps {
  settings: ExportSettings;
  sourceClip: ExportClip | null;
  selectedDurationUs: number;
}

function ExportMediaSection({ settings, sourceClip, selectedDurationUs }: ExportMediaSectionProps) {
  const sourceMedia = sourceClip?.sourceMedia;
  const resolution =
    settings.resolution === "custom"
      ? `${settings.customWidth} × ${settings.customHeight}`
      : sourceMedia?.width && sourceMedia?.height
        ? `${sourceMedia.width} × ${sourceMedia.height}`
        : "匹配源";
  const frameRate =
    settings.frameRate !== null
      ? `${formatFrameRate(settings.frameRate)} fps`
      : sourceMedia?.frameRate
        ? `${formatFrameRate(sourceMedia.frameRate)} fps`
        : "匹配源";
  // The export graph always normalizes to square pixels (setsar=1).
  const duration = formatDuration(selectedDurationUs);
  const speedLabels = { fast: "最快", balanced: "均衡", quality: "高质量" } as const;
  const speed =
    settings.container === "mov_prores" ? "" : ` | 速度 ${speedLabels[settings.encoderSpeed]}`;
  const video = settings.includeVideo
    ? `${videoCodecLabels[settings.container] ?? "—"} | ${resolution} (1.0) | ${frameRate} | ${duration} | ${outputQualityLabel(
        settings,
      )}${speed}`
    : "无视频";
  const audio = settings.includeAudio
    ? `${audioCodecLabels[settings.audioCodec]}, ${
        settings.audioSampleRateHz ? formatKiloHz(settings.audioSampleRateHz) : "匹配源"
      }, ${exportAudioChannelLabel(settings.audioChannels)}, ${settings.audioBitrateKbps} kbps`
    : "无音轨";
  const estimatedBytes = estimateFileSizeBytes(settings, sourceMedia, selectedDurationUs);
  const estimated = estimatedBytes === null ? "—" : `约 ${formatFileSize(estimatedBytes)}`;

  return (
    <section className="export-media-block">
      <h3 className="export-media-heading">输出</h3>
      <dl className="export-media-list">
        <MediaRow label="视频：" value={video} title={video} />
        <MediaRow label="音频：" value={audio} title={audio} />
        <MediaRow
          label="估计文件大小："
          value={estimated}
          title={
            settings.includeVideo
              ? "按选中片段总时长与经验码率粗估（CRF 模式无目标码率，仅供参考）"
              : "按选中片段总时长与音频比特率估算"
          }
        />
      </dl>
    </section>
  );
}

export function ExportMediaInfo({
  clip,
  settings,
  selectedDurationUs,
  mediaItems,
}: ExportMediaInfoProps) {
  return (
    <div className="export-media-info">
      <SourceMediaSection clip={clip} mediaItems={mediaItems} />
      <ExportMediaSection
        settings={settings}
        sourceClip={clip}
        selectedDurationUs={selectedDurationUs}
      />
    </div>
  );
}
