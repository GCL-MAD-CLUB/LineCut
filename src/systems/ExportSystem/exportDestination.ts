import { invokeCommand } from "../../errors";
import type { ExportDestination, ExportSource } from "./exportTypes";

export function dirname(path: string) {
  return path.replace(/[\\/][^\\/]*$/, "") || path;
}

/** Resolves the target folder: `"source"` → the first clip's folder, the rest are well-known Windows folders; a failure degrades to `""` rather than a stale folder. */
export async function resolveExportDestinationDir(
  destination: ExportDestination,
  source: ExportSource | null,
): Promise<string> {
  switch (destination) {
    case "source": {
      const firstPath = source?.clips[0]?.sourcePath;
      return firstPath ? dirname(firstPath) : "";
    }
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
