import type { MediaBinFolder, MediaBinItem } from "../../types";

export type MediaSourceNode =
  | { kind: "folder"; folder: MediaBinFolder; children: MediaSourceNode[] }
  | { kind: "video"; item: MediaBinItem };

/**
 * Keep the media-bin hierarchy, pruning folders without selectable videos.
 *
 * Videos whose `bin_id` points at a folder outside `folders` fall back to the root, matching how
 * the media bin itself renders orphaned items.
 */
export function mediaSourceTree(
  folders: MediaBinFolder[],
  videos: MediaBinItem[],
): MediaSourceNode[] {
  const folderIds = new Set(folders.map((folder) => folder.id));
  const videosByParent = new Map<string | null, MediaBinItem[]>();
  for (const item of videos) {
    const parent = item.bin_id && folderIds.has(item.bin_id) ? item.bin_id : null;
    const siblings = videosByParent.get(parent);
    if (siblings) siblings.push(item);
    else videosByParent.set(parent, [item]);
  }

  const foldersByParent = new Map<string | null, MediaBinFolder[]>();
  for (const folder of folders) {
    const parent = folder.parent_id && folderIds.has(folder.parent_id) ? folder.parent_id : null;
    const siblings = foldersByParent.get(parent);
    if (siblings) siblings.push(folder);
    else foldersByParent.set(parent, [folder]);
  }

  const build = (parentId: string | null, ancestors: Set<string>): MediaSourceNode[] => {
    const nodes: MediaSourceNode[] = [];
    for (const folder of foldersByParent.get(parentId) ?? []) {
      if (ancestors.has(folder.id)) continue;
      const children = build(folder.id, new Set([...ancestors, folder.id]));
      if (children.length) nodes.push({ kind: "folder", folder, children });
    }
    for (const item of videosByParent.get(parentId) ?? []) {
      nodes.push({ kind: "video", item });
    }
    return nodes;
  };

  return build(null, new Set());
}
