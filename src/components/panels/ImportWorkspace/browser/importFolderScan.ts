import { mediaKind, pathKey, type ImportDirectory, type ImportEntry } from "./importBrowserModel";

export interface ImportSelectionItem {
  entry: ImportEntry;
  files: ImportEntry[];
  scanning: boolean;
  unreadable: string[];
}

/** Walk directory listings only: probing video/subtitle contents belongs to analysis. */
export async function scanImportFolder(
  root: string,
  readDirectory: (path: string) => Promise<ImportDirectory | null>,
  signal: AbortSignal,
  onProgress: (files: ImportEntry[], unreadable: string[]) => void,
) {
  const directories = [root];
  const queued = new Set([pathKey(root)]);
  const visited = new Set<string>();
  const files = new Map<string, ImportEntry>();
  const unreadable: string[] = [];
  for (let cursor = 0; cursor < directories.length && !signal.aborted; cursor += 1) {
    const path = directories[cursor];
    const listing = await readDirectory(path);
    if (signal.aborted) return;
    if (!listing) {
      unreadable.push(path);
    } else {
      // Canonical identities prevent junctions / symbolic links from forming cycles.
      const identity = pathKey(listing.canonical_path ?? listing.directory);
      if (visited.has(identity)) continue;
      visited.add(identity);
      for (const entry of listing.entries) {
        const key = pathKey(entry.path);
        if (entry.is_directory) {
          if (!queued.has(key)) {
            queued.add(key);
            directories.push(entry.path);
          }
        } else if (mediaKind(entry.path)) files.set(key, entry);
      }
    }
    onProgress([...files.values()], [...unreadable]);
    // Yield between directories even when listings come from a fast local cache.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

export function collectSelectionFiles(items: ImportSelectionItem[], imported: Set<string>) {
  const files = new Map<string, ImportEntry>();
  for (const item of items)
    for (const entry of item.files) {
      const key = pathKey(entry.path);
      if (!imported.has(key)) files.set(key, entry);
    }
  return [...files.values()];
}
