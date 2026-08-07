import { invokeCommand } from "../../errors";
import type { ExportDestination, ExportSource } from "./exportTypes";

/** Parent directory of a file path, or the path itself when it has none. */
export function dirname(path: string) {
  return path.replace(/[\\/][^\\/]*$/, "") || path;
}

/**
 * Resolves the concrete target folder for a destination category.
 *
 * - `"source"` uses the folder containing the first clip's source file.
 * - `"choose_later"` is a preset-only placeholder; no path is resolved yet.
 * - The remaining values are well-known Windows folders resolved by the
 *   backend. A resolution failure degrades to `""` (export stays disabled),
 *   rather than silently writing to a stale folder.
 */
export async function resolveExportDestinationDir(
  destination: ExportDestination,
  source: ExportSource | null,
): Promise<string> {
  switch (destination) {
    case "source": {
      const firstPath = source?.clips[0]?.sourcePath;
      return firstPath ? dirname(firstPath) : "";
    }
    case "choose_later":
      return "";
    case "desktop":
    case "documents":
    case "user":
    case "videos":
    case "pictures":
      try {
        return await invokeCommand<string>("resolve_known_folder", { kind: destination });
      } catch {
        return "";
      }
    default:
      return "";
  }
}
