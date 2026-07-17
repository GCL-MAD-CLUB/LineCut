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
    areas: {
      leftTop: { tabs: ["source"], activePanelId: "source" },
      leftBottom: { tabs: ["media", "export"], activePanelId: "media" },
      right: { tabs: ["subtitles", "history"], activePanelId: "subtitles" },
    },
  },
  focusedPanelId: "source",
};
