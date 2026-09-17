import { invokeCommand, runOperation } from "../../errors";
import { isTauriRuntime } from "../../tauriRuntime";
import type { ImportMetadata } from "./importBrowserModel";

let active = 0;
const waiting: Array<() => void> = [];
export async function queuePreview<T>(action: () => Promise<T>) {
  if (active >= 3) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await action();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}
const metadataCache = new Map<string, Promise<ImportMetadata | null>>();
const coverCache = new Map<string, Promise<string>>();
export function importMetadata(path: string) {
  let result = metadataCache.get(path);
  if (!result) {
    result = queuePreview(async () => {
      if (!isTauriRuntime()) return null;
      const outcome = await runOperation("thumbnail.video", () =>
        invokeCommand<ImportMetadata>("probe_import_preview", { path }),
      );
      return outcome.status === "success" ? outcome.value : null;
    });
    if (metadataCache.size >= 512) metadataCache.delete(metadataCache.keys().next().value!);
    metadataCache.set(path, result);
  }
  return result;
}
export async function importFrame(path: string, timeUs: number) {
  if (!isTauriRuntime()) return "";
  const outcome = await runOperation("thumbnail.video", () =>
    invokeCommand<number[]>("media_browser_frame", { path, timeUs }),
  );
  if (outcome.status !== "success") return "";
  const bytes = outcome.value;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.slice(offset, offset + 8192));
  return `data:image/jpeg;base64,${btoa(binary)}`;
}
export function importCover(path: string) {
  let result = coverCache.get(path);
  if (!result) {
    result = queuePreview(() => importFrame(path, 0));
    if (coverCache.size >= 128) coverCache.delete(coverCache.keys().next().value!);
    coverCache.set(path, result);
  }
  return result;
}
