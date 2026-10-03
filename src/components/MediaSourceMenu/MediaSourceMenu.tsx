import { Fragment, useMemo, useState, type ReactNode } from "react";
import { mediaSourceTree, type MediaSourceNode } from "../../core/editor/mediaSourceTree";
import { PopupMenuSubmenu } from "../PopupMenu";
import type { MediaBinFolder, MediaBinItem } from "../../types";

interface MediaSourceMenuProps {
  folders: MediaBinFolder[];
  videos: MediaBinItem[];
  selectedVideoId?: string;
  selectedVideoIds?: string[];
  renderVideo: (
    item: MediaBinItem,
    open: boolean,
    onOpenChange: (open: boolean) => void,
  ) => ReactNode;
}

function nodeKey(node: MediaSourceNode) {
  return node.kind === "folder" ? `folder:${node.folder.id}` : `video:${node.item.id}`;
}

function MediaSourceMenuLevel({
  nodes,
  selectedFolderIds,
  renderVideo,
}: {
  nodes: MediaSourceNode[];
  selectedFolderIds: Set<string>;
  renderVideo: MediaSourceMenuProps["renderVideo"];
}) {
  // Keep one open sibling per level so descendants do not close their ancestor menus.
  const [openId, setOpenId] = useState<string | null>(null);
  return nodes.map((node) => {
    const key = nodeKey(node);
    const setOpen = (open: boolean) => setOpenId(open ? key : null);
    if (node.kind === "folder") {
      return (
        <PopupMenuSubmenu
          key={key}
          label={node.folder.name}
          title={node.folder.name}
          checked={selectedFolderIds.has(node.folder.id)}
          indicator="dot"
          menuClassName="media-source-menu"
          open={openId === key}
          onOpenChange={setOpen}
        >
          <MediaSourceMenuLevel
            nodes={node.children}
            selectedFolderIds={selectedFolderIds}
            renderVideo={renderVideo}
          />
        </PopupMenuSubmenu>
      );
    }
    // A Fragment keeps `role="menu"` children semantic; a wrapper element would break the ARIA contract.
    return <Fragment key={key}>{renderVideo(node.item, openId === key, setOpen)}</Fragment>;
  });
}

export function MediaSourceMenu({
  folders,
  videos,
  selectedVideoId,
  selectedVideoIds,
  renderVideo,
}: MediaSourceMenuProps) {
  const nodes = useMemo(() => mediaSourceTree(folders, videos), [folders, videos]);
  const selectedFolderIds = useMemo(() => {
    const folderIds = new Set<string>();
    const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
    for (const videoId of selectedVideoIds ?? [selectedVideoId]) {
      let folderId = videos.find((video) => video.id === videoId)?.bin_id;
      while (folderId && foldersById.has(folderId) && !folderIds.has(folderId)) {
        folderIds.add(folderId);
        folderId = foldersById.get(folderId)?.parent_id;
      }
    }
    return folderIds;
  }, [folders, videos, selectedVideoId, selectedVideoIds]);
  return (
    <MediaSourceMenuLevel
      nodes={nodes}
      selectedFolderIds={selectedFolderIds}
      renderVideo={renderVideo}
    />
  );
}
