import { Fragment, useMemo, useState, type ReactNode } from "react";
import { mediaSourceTree, type MediaSourceNode } from "../../core/editor/mediaSourceTree";
import { PopupMenuSubmenu } from "../PopupMenu";
import type { MediaBinFolder, MediaBinItem } from "../../types";

interface MediaSourceMenuProps {
  folders: MediaBinFolder[];
  videos: MediaBinItem[];
  renderVideo: (
    item: MediaBinItem,
    open: boolean,
    onOpenChange: (open: boolean) => void,
  ) => ReactNode;
}

type OpenChange = (id: string, open: boolean) => void;

function nodeKey(node: MediaSourceNode) {
  return node.kind === "folder" ? `folder:${node.folder.id}` : `video:${node.item.id}`;
}

function MediaSourceMenuLevel({
  nodes,
  openId,
  onOpenChange,
  renderVideo,
}: {
  nodes: MediaSourceNode[];
  openId: string | null;
  onOpenChange: OpenChange;
  renderVideo: MediaSourceMenuProps["renderVideo"];
}) {
  return nodes.map((node) => {
    const key = nodeKey(node);
    const setOpen = (open: boolean) => onOpenChange(key, open);
    if (node.kind === "folder") {
      return (
        <PopupMenuSubmenu
          key={key}
          label={node.folder.name}
          open={openId === key}
          onOpenChange={setOpen}
        >
          <MediaSourceMenuLevel
            nodes={node.children}
            openId={openId}
            onOpenChange={onOpenChange}
            renderVideo={renderVideo}
          />
        </PopupMenuSubmenu>
      );
    }
    // A Fragment keeps `role="menu"` children semantic; a wrapper element would break the ARIA contract.
    return <Fragment key={key}>{renderVideo(node.item, openId === key, setOpen)}</Fragment>;
  });
}

export function MediaSourceMenu({ folders, videos, renderVideo }: MediaSourceMenuProps) {
  const nodes = useMemo(() => mediaSourceTree(folders, videos), [folders, videos]);
  // One open submenu for the whole tree, so nesting depth cannot leave two open at once.
  const [openId, setOpenId] = useState<string | null>(null);
  const onOpenChange: OpenChange = (id, open) => setOpenId(open ? id : null);
  return (
    <MediaSourceMenuLevel
      nodes={nodes}
      openId={openId}
      onOpenChange={onOpenChange}
      renderVideo={renderVideo}
    />
  );
}
