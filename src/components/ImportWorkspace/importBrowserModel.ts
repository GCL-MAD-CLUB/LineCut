export type ImportMediaKind = "video" | "audio" | "image" | "subtitle";
export type ImportFilter = "all" | ImportMediaKind;
export interface ImportEntry {
  path: string;
  name: string;
  is_directory: boolean;
  is_hidden: boolean;
  size: number;
  created_at: number | null;
}
export interface ImportLocation {
  path: string;
  name: string;
  kind: string;
}
export interface ImportDirectory {
  directory: string;
  canonical_path?: string;
  parent: string | null;
  entries: ImportEntry[];
}
export interface ImportMetadata {
  duration_us: number;
  width: number | null;
  height: number | null;
  frame_rate: string | null;
  codec: string | null;
}
export interface ImportSettings {
  newBin: boolean;
  binName: string;
  copy: boolean;
  verify: boolean;
  destination: "project" | "custom";
  customDirectory: string;
  autoBind: boolean;
  autoBindType: "all" | "audio" | "subtitle";
  autoBindPreset: "direct" | "virtual-copy";
  autoBindPreference: "smart" | "name";
}
const extensions: Record<ImportMediaKind, string[]> = {
  video: ["mkv", "mp4", "mov", "webm", "avi", "ts", "m2ts", "mts", "mpeg", "mpg", "m4v"],
  audio: ["wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "wma", "aiff"],
  image: ["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff", "gif"],
  subtitle: ["srt", "ass", "ssa", "vtt", "webvtt"],
};
export function pathKey(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(path) || path.startsWith("\\\\") ? normalized.toLowerCase() : normalized;
}
export function fileExtension(path: string) {
  return path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
}
export function mediaKind(path: string): ImportMediaKind | null {
  const ext = fileExtension(path);
  return (
    (Object.keys(extensions) as ImportMediaKind[]).find((kind) => extensions[kind].includes(ext)) ??
    null
  );
}
export function breadcrumbs(path: string) {
  const separator = path.includes("\\") ? "\\" : "/";
  const prefix = path.startsWith("\\\\") ? "\\\\" : path.startsWith("/") ? "/" : "";
  const parts = path.split(/[\\/]/).filter(Boolean);
  const result = parts.map((name, index) => ({
    name,
    path:
      prefix +
      parts.slice(0, index + 1).join(separator) +
      (index === 0 && /^[a-z]:$/i.test(name) ? separator : ""),
  }));
  if (prefix === "/") result.unshift({ name: "/", path: "/" });
  return result;
}
export function parentDirectory(path: string) {
  return breadcrumbs(path).at(-2)?.path ?? "";
}
export function formatDuration(microseconds: number) {
  if (!microseconds) return "—";
  const seconds = Math.floor(microseconds / 1_000_000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
export function formatFrameRate(rate: string | null | undefined) {
  if (!rate) return "—";
  const [numerator, denominator = "1"] = rate.split("/");
  const value = Number(numerator) / Number(denominator);
  return Number.isFinite(value) && value > 0 ? value.toFixed(2) : "—";
}
