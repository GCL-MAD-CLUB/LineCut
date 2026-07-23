import { useShallow } from "zustand/shallow";
import { useProjectPort } from "../../systems/ProjectSystem";
import { definePanel, type PanelMenuEntryDefinition } from "../DockLayout";
import { MediaBin } from "./MediaBin";
import { useMediaBinState } from "./mediaBinState";
import { mediaBinPanelType, type MediaBinPanelParams } from "./panelTypes";

export { mediaBinPanelType, type MediaBinPanelParams } from "./panelTypes";

function ManagedMediaBin({ params }: { params: MediaBinPanelParams }) {
  return <MediaBin rootFolderId={params.rootFolderId} />;
}

function projectMediaTitle(projectFilePath: string | null) {
  return `项目：${
    projectFilePath
      ?.split(/[\\/]/)
      .pop()
      ?.replace(/\.lcp$/i, "") ?? "未命名项目"
  }`;
}

export const mediaBinPanelDefinition = definePanel<MediaBinPanelParams>({
  type: mediaBinPanelType,
  Component: ManagedMediaBin,
  useTitle: ({ rootFolderId }) => {
    const { projectFilePath, mediaFolders } = useProjectPort(
      ["projectFilePath", "mediaFolders"],
      [],
    );
    const folderName = mediaFolders.find((folder) => folder.id === rootFolderId)?.name;
    return rootFolderId ? `媒体箱：${folderName ?? "已删除"}` : projectMediaTitle(projectFilePath);
  },
  useAvailable: ({ rootFolderId }) => {
    const { mediaFolders } = useProjectPort(["mediaFolders"], []);
    return rootFolderId === null || mediaFolders.some((folder) => folder.id === rootFolderId);
  },
  useMenuItems: () => {
    const { viewMode, showHidden, setViewMode, setShowHidden } = useMediaBinState(
      useShallow((state) => ({
        viewMode: state.viewMode,
        showHidden: state.showHidden,
        setViewMode: state.setViewMode,
        setShowHidden: state.setShowHidden,
      })),
    );
    return [
      {
        type: "selection",
        id: "media-bin-view-mode",
        defaultValue: viewMode,
        items: [
          {
            id: "list",
            label: "列表视图",
            onSelect: () => setViewMode("list"),
          },
          {
            id: "grid",
            label: "图标视图",
            onSelect: () => setViewMode("grid"),
          },
        ],
      },
      { type: "separator", id: "media-bin-view-separator" },
      {
        id: "media-bin-show-hidden",
        label: "查看隐藏内容",
        checked: showHidden,
        onSelect: () => setShowHidden(!showHidden),
      },
    ] satisfies PanelMenuEntryDefinition[];
  },
});
