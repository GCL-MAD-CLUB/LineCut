import { invokeCommand, runOperation } from "../../errors";
import { createFfmpegTaskId } from "../../platform/tauri/ffmpegProgress";
import type { ImportResult, MediaBinItem } from "../../types";
import { fileExtension, mediaKind, type ImportEntry } from "./importBrowserModel";

function subtitleItem(path: string): MediaBinItem {
  return {
    id: `external-subtitle:${crypto.randomUUID()}`,
    bin_id: null,
    kind: "subtitle",
    enabled: true,
    hidden: false,
    offline: false,
    path,
    file_name: path.split(/[\\/]/).pop() ?? path,
    duration_us: 0,
    start_time_us: 0,
    bound_to_video_id: null,
    source_video_id: null,
    stream_index: null,
    subtitle_track_id: null,
    codec: fileExtension(path),
    language: null,
    extracted: false,
    origin: "imported",
    color: "#893a04",
  };
}

/** Registration deliberately has no task-progress UI. The caller freezes the page. */
export async function registerImportSelection(
  entries: ImportEntry[],
  copy: { directory: string; verify: boolean } | null,
) {
  const results: ImportResult[] = [];
  const subtitles: MediaBinItem[] = [];
  const completed = new Set<string>();
  let cursor = 0;
  async function consume() {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      const outcome = await runOperation(
        "media.import",
        async () => {
          const path = copy
            ? await invokeCommand<string>("copy_import_media", {
                path: entry.path,
                directory: copy.directory,
                verify: copy.verify,
                taskId: createFfmpegTaskId("media-copy"),
              })
            : entry.path;
          if (mediaKind(path) === "subtitle") subtitles.push(subtitleItem(path));
          else
            results.push(
              await invokeCommand<ImportResult>("register_import_media", {
                path,
                taskId: createFfmpegTaskId("media-register"),
                assetId: null,
              }),
            );
          completed.add(entry.path);
        },
        { displayName: entry.name, resourceKind: "media" },
      );
      if (outcome.status === "cancelled") break;
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, entries.length) }, consume));
  return { results, subtitles, completed };
}
