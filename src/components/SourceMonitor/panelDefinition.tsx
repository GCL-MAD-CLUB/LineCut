import { useShallow } from "zustand/shallow";
import { isMediaItemEnabled, useProjectPort } from "../../systems/ProjectSystem";
import { definePanel, type PanelMenuEntryDefinition } from "../DockLayout";
import { SourceMonitor } from "./SourceMonitor";
import { useSourceMonitorState } from "./sourceMonitorState";

export const sourcePanelType = "source";

export const sourcePanelDefinition = definePanel({
  type: sourcePanelType,
  Component: SourceMonitor,
  useTitle: () => {
    const { project } = useProjectPort(["project"], []);
    return `源：${project?.asset.file_name ?? "（无剪辑）"}`;
  },
  useMenuItems: () => {
    const { activeVideoId, mediaItems, activeVideoChanged, sourcePreviewCleared } = useProjectPort(
      ["activeVideoId", "mediaItems"],
      ["activeVideoChanged", "sourcePreviewCleared"],
    );
    const { playbackHistoryVideoIds, playedVideoRemoved, playbackHistoryCleared } =
      useSourceMonitorState(
        useShallow((state) => ({
          playbackHistoryVideoIds: state.playbackHistoryVideoIds,
          playedVideoRemoved: state.playedVideoRemoved,
          playbackHistoryCleared: state.playbackHistoryCleared,
        })),
      );
    const historyItems = playbackHistoryVideoIds.flatMap((videoId) => {
      const item = mediaItems.find(
        (candidate) =>
          candidate.id === videoId && candidate.kind === "video" && isMediaItemEnabled(candidate),
      );
      return item ? [item] : [];
    });
    const defaultValue = historyItems.some((item) => item.id === activeVideoId)
      ? activeVideoId
      : (historyItems.at(-1)?.id ?? "source-empty");
    const hasPlaybackHistory = historyItems.length > 0;

    const closeCurrentPlayback = () => {
      if (!activeVideoId) {
        return;
      }
      const previousItem = historyItems.filter((item) => item.id !== activeVideoId).at(-1);
      playedVideoRemoved(activeVideoId);
      if (previousItem) {
        activeVideoChanged(previousItem.id);
      } else {
        sourcePreviewCleared();
      }
    };

    const closeAllPlayback = () => {
      playbackHistoryCleared();
      sourcePreviewCleared();
    };

    return [
      {
        id: "source-close-playback",
        label: "关闭",
        disabled: !hasPlaybackHistory,
        onSelect: closeCurrentPlayback,
      },
      {
        id: "source-close-all-playback",
        label: "关闭全部",
        disabled: !hasPlaybackHistory,
        onSelect: closeAllPlayback,
      },
      { type: "separator", id: "source-playback-history-top-separator" },
      {
        type: "selection",
        id: "source-playback-history",
        defaultValue,
        items:
          historyItems.length > 0
            ? historyItems.map((item) => ({
                id: item.id,
                label: `源：${item.file_name}`,
                onSelect: () => activeVideoChanged(item.id),
              }))
            : [
                {
                  id: "source-empty",
                  label: "源：（无剪辑）",
                  onSelect: () => undefined,
                },
              ],
      },
    ] satisfies PanelMenuEntryDefinition[];
  },
});
