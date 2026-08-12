import { formatMonitorTime } from "../../time";
import {
  containerExtension,
  type ExportClip,
  type ExportExtensionCase,
  type ExportMode,
  type ExportRenameRule,
  type ExportSettings,
  type ExportSourceKind,
} from "./exportTypes";

type RenamePart = "label" | "label_keywords" | "time" | "filename" | "custom";

/** Splits a rule into its 1–2 component parts, in display order. */
const ruleParts: Record<ExportRenameRule, [RenamePart, RenamePart?]> = {
  label: ["label"],
  label_keywords: ["label", "label_keywords"],
  time: ["time"],
  time_label: ["time", "label"],
  filename: ["filename"],
  filename_label: ["filename", "label"],
  filename_time: ["filename", "time"],
  custom: ["custom"],
  custom_label: ["custom", "label"],
  custom_time: ["custom", "time"],
  custom_filename: ["custom", "filename"],
};

/**
 * Rename-rule options for the 重命名为 dropdown. Merge mode produces a single
 * file with no per-clip identity, so it gets a reduced set; individual mode
 * depends on the source kind (字幕/分镜/媒体库).
 */
export function exportRenameRuleOptions(
  mode: ExportMode,
  kind: ExportSourceKind,
): Array<readonly [ExportRenameRule, string]> {
  if (mode === "merge") {
    return [
      ["filename", "文件名"],
      ["custom", "自定名称"],
      ["custom_filename", "自定名称-文件名"],
    ];
  }
  switch (kind) {
    case "subtitle":
      return [
        ["label", "字幕"],
        ["time", "时间范围"],
        ["time_label", "时间范围-字幕"],
        ["filename", "文件名"],
        ["filename_label", "文件名-字幕"],
        ["filename_time", "文件名-时间范围"],
        ["custom", "自定名称"],
        ["custom_label", "自定名称-字幕"],
        ["custom_time", "自定名称-时间范围"],
      ];
    case "storyboard":
      return [
        ["label", "分镜"],
        ["label_keywords", "分镜-关键字"],
        ["time", "时间范围"],
        ["time_label", "时间范围-分镜"],
        ["filename", "文件名"],
        ["filename_label", "文件名-分镜"],
        ["filename_time", "文件名-时间范围"],
        ["custom", "自定名称"],
        ["custom_label", "自定名称-分镜"],
        ["custom_time", "自定名称-时间范围"],
      ];
    case "media-bin":
      return [
        ["filename", "文件名"],
        ["custom", "自定名称"],
        ["custom_filename", "自定名称-文件名"],
      ];
  }
}

export const exportExtensionCaseOptions: Array<readonly [ExportExtensionCase, string]> = [
  ["upper", "大写"],
  ["lower", "小写"],
];

/** True when a rule contains the 自定名称 segment (enables the 自定文本 input). */
export function renameRuleUsesCustom(rule: ExportRenameRule): boolean {
  return ruleParts[rule].some((part) => part === "custom");
}

const illegalFileNameChar = /[<>:"/\\|?*]/;

/** Replaces Windows-illegal filename characters with `_` and trims the result. */
export function sanitizeFileNameComponent(value: string): string {
  let result = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (illegalFileNameChar.test(ch) || code < 0x20 || code === 0x7f) {
      result += "_";
    } else {
      result += ch;
    }
  }
  return result.trim().replace(/[. ]+$/, "");
}

/**
 * The clip's time-range segment: the app's `HH:MM:SS:FF` timecode with colons
 * stripped, start–end joined by `-` (e.g. `00050920-00052819`). Windows
 * filenames cannot contain colons, and the frame part needs the source fps.
 */
export function formatClipTimeRange(clip: ExportClip): string {
  const frameRate = clip.sourceMedia?.frameRate ?? 24;
  const start = formatMonitorTime(clip.startUs, frameRate).replace(/:/g, "");
  const endUs = clip.endUs > 0 ? clip.endUs : clip.durationUs;
  const end = formatMonitorTime(endUs, frameRate).replace(/:/g, "");
  return `${start}-${end}`;
}

/** Resolves one segment of a rename rule for a clip. */
function segmentFor(clip: ExportClip, part: RenamePart, customName: string): string {
  switch (part) {
    case "label":
      return clip.label;
    case "label_keywords":
      // Keywords are comma-separated without spaces in filenames.
      return (clip.keywordText ?? "").replace(/,\s+/g, ",");
    case "time":
      return formatClipTimeRange(clip);
    case "filename":
      return clip.sourceName;
    case "custom":
      return customName;
  }
}

/** Builds a clip's base name (before disambiguation and extension) from the rule; empty segments are dropped, an all-empty result falls back to the label. */
export function computeClipBaseName(
  clip: ExportClip,
  rule: ExportRenameRule,
  customName: string,
): string {
  const [first, second] = ruleParts[rule];
  const parts = [segmentFor(clip, first, customName)];
  if (second) {
    parts.push(segmentFor(clip, second, customName));
  }
  const joined = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("-");
  return joined || clip.label.trim() || "导出";
}

/**
 * Disambiguates duplicate base names: the first occurrence keeps the bare name,
 * later ones get `-N` where N starts at `startNumber` and increments.
 *
 * Names are compared case-insensitively because NTFS file names are
 * case-insensitive: `Logo` and `logo` collide on disk, so they must be
 * disambiguated like exact duplicates.
 */
export function assignUniqueNames(bases: readonly string[], startNumber: number): string[] {
  const fold = (value: string) => value.toLowerCase();
  const countByBase = new Map<string, number>();
  for (const base of bases) {
    const key = fold(base);
    countByBase.set(key, (countByBase.get(key) ?? 0) + 1);
  }
  const emittedByBase = new Map<string, number>();
  return bases.map((base) => {
    const key = fold(base);
    const emitted = emittedByBase.get(key) ?? 0;
    emittedByBase.set(key, emitted + 1);
    if ((countByBase.get(key) ?? 1) <= 1 || emitted === 0) {
      return base;
    }
    return `${base}-${startNumber + emitted - 1}`;
  });
}

export interface ExportFileName {
  clipId: string;
  fileName: string;
}

/** Maximum output file-name length; mirrors the backend `safe_component` clamp. */
export const MAX_FILE_NAME_LENGTH = 120;

/**
 * Truncates a file name to `MAX_FILE_NAME_LENGTH` characters while preserving a
 * trailing extension (a `.` suffix of 2–10 chars). Mirrors the backend
 * `safe_component` clamp so the 示例 preview, the conflict probe, and the
 * on-disk name all agree.
 */
export function clampFileName(fileName: string): string {
  if (fileName.length <= MAX_FILE_NAME_LENGTH) {
    return fileName;
  }
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot) : "";
  if (ext.length >= 2 && ext.length <= 10) {
    const keep = MAX_FILE_NAME_LENGTH - ext.length;
    return `${fileName.slice(0, dot).slice(0, keep)}${ext}`;
  }
  return fileName.slice(0, MAX_FILE_NAME_LENGTH);
}

/**
 * Clamps a base name to `maxLength`, preserving a trailing `-N` disambiguation
 * suffix when one is present so truncation never collapses `base-1`/`base-2`
 * into the same name.
 */
function clampBaseName(name: string, maxLength: number): string {
  if (name.length <= maxLength) {
    return name;
  }
  const suffix = name.match(/-(0|[1-9]\d*)$/)?.[0];
  if (suffix) {
    return `${name.slice(0, maxLength - suffix.length)}${suffix}`;
  }
  return name.slice(0, maxLength);
}

/**
 * Computes the final output filename for every clip: rule base name +
 * disambiguation + extension (cased per `extensionCase`), clamped to the same
 * 120-char budget the backend applies. Used both for the 示例 preview and (sent
 * per-clip as `outputName`) for the actual export, so the preview always
 * matches what lands on disk.
 */
export function computeExportFileNames(
  clips: readonly ExportClip[],
  settings: Pick<
    ExportSettings,
    "renameRule" | "customName" | "startNumber" | "extensionCase" | "container"
  >,
): ExportFileName[] {
  const ext = containerExtension(settings.container);
  const casedExt = settings.extensionCase === "upper" ? ext.toUpperCase() : ext.toLowerCase();
  const extWithDot = `.${casedExt}`;
  const maxBaseLength = MAX_FILE_NAME_LENGTH - extWithDot.length;
  const bases = clips.map((clip) =>
    clampBaseName(
      sanitizeFileNameComponent(
        computeClipBaseName(clip, settings.renameRule, settings.customName),
      ),
      maxBaseLength,
    ),
  );
  const unique = assignUniqueNames(bases, Math.max(0, Math.floor(settings.startNumber)));
  const finalBases = unique.map((name) => clampBaseName(name, maxBaseLength));
  return clips.map((clip, index) => ({
    clipId: clip.id,
    fileName: `${finalBases[index]}${extWithDot}`,
  }));
}
