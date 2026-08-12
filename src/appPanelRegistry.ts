import { PanelRegistry, type PanelManagerInitialState } from "./components/DockLayout";
import { exportPanelDefinition, exportPanelType } from "./components/ExportPanel";
import { historyPanelDefinition, historyPanelType } from "./components/HistoryPanel";
import { mediaBinPanelDefinition, mediaBinPanelType } from "./components/MediaBin";
import { sourcePanelDefinition, sourcePanelType } from "./components/SourceMonitor";
import { subtitlePanelDefinition, subtitlePanelType } from "./components/SubtitlePanel";

export const appPanelRegistry = new PanelRegistry([
  sourcePanelDefinition,
  mediaBinPanelDefinition,
  exportPanelDefinition,
  subtitlePanelDefinition,
  historyPanelDefinition,
]);

export const initialAppPanelState: PanelManagerInitialState = {
  instances: [
    { id: "source", type: sourcePanelType, params: {} },
    { id: "media", type: mediaBinPanelType, params: { rootFolderId: null } },
    { id: "export", type: exportPanelType, params: {} },
    { id: "subtitles", type: subtitlePanelType, params: {} },
    { id: "history", type: historyPanelType, params: {} },
  ],
  layout: {
    root: {
      type: "split",
      id: "initial-columns",
      axis: "x",
      ratio: 1 / 3,
      first: {
        type: "split",
        id: "initial-left-rows",
        axis: "y",
        ratio: 0.48,
        first: { type: "area", areaId: "leftTop" },
        second: { type: "area", areaId: "leftBottom" },
      },
      second: {
        type: "split",
        id: "initial-right-columns",
        axis: "x",
        ratio: 0.5,
        first: { type: "area", areaId: "middle" },
        second: { type: "area", areaId: "right" },
      },
    },
    areas: {
      leftTop: { tabs: ["source"], activePanelId: "source" },
      leftBottom: { tabs: ["media"], activePanelId: "media" },
      middle: { tabs: ["subtitles"], activePanelId: "subtitles" },
      right: { tabs: ["export", "history"], activePanelId: "export" },
    },
  },
  focusedPanelId: "source",
};
