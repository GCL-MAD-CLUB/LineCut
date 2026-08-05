import {
  PanelRegistry,
  type DockAreaId,
  type DockLayoutNode,
  type PanelManagerInitialState,
} from "./components/DockLayout";
import { historyPanelDefinition } from "./components/HistoryPanel";
import { mediaBinPanelDefinition, mediaBinPanelType } from "./components/MediaBin";
import { sourcePanelDefinition, sourcePanelType } from "./components/SourceMonitor";
import { storyboardPanelDefinition, storyboardPanelType } from "./components/StoryboardPanel";
import { subtitlePanelDefinition, subtitlePanelType } from "./components/SubtitlePanel";

export const appPanelRegistry = new PanelRegistry([
  sourcePanelDefinition,
  mediaBinPanelDefinition,
  subtitlePanelDefinition,
  storyboardPanelDefinition,
  historyPanelDefinition,
]);

export const initialAppPanelState: PanelManagerInitialState = {
  instances: [
    { id: "source", type: sourcePanelType, params: {} },
    { id: "media", type: mediaBinPanelType, params: { rootFolderId: null } },
    { id: "subtitles", type: subtitlePanelType, params: {} },
    { id: "storyboard", type: storyboardPanelType, params: {} },
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
      second: { type: "area", areaId: "middle" },
    },
    areas: {
      leftTop: { tabs: ["source"], activePanelId: "source" },
      leftBottom: { tabs: ["media"], activePanelId: "media" },
      middle: { tabs: ["subtitles", "storyboard"], activePanelId: "subtitles" },
    },
  },
  focusedPanelId: "source",
};

function dockAreaIds(node: DockLayoutNode): DockAreaId[] {
  if (node.type === "area") {
    return [node.areaId];
  }
  return [...dockAreaIds(node.first), ...dockAreaIds(node.second)];
}

function preferredAreaId(
  state: PanelManagerInitialState,
  anchorPanelId: string,
  fallbackAreaId: string,
) {
  const anchorArea = Object.entries(state.layout.areas).find(([, area]) =>
    area.tabs.includes(anchorPanelId),
  )?.[0];
  if (anchorArea) {
    return anchorArea;
  }
  if (state.layout.areas[fallbackAreaId]) {
    return fallbackAreaId;
  }
  return dockAreaIds(state.layout.root).find((areaId) => state.layout.areas[areaId]) ?? null;
}

function ensureDefaultPanelAfterAnchor(
  state: PanelManagerInitialState,
  panelId: string,
  anchorPanelId: string,
  fallbackAreaId: string,
) {
  const defaultInstance = initialAppPanelState.instances.find(
    (instance) => instance.id === panelId,
  );
  if (!defaultInstance) {
    return state;
  }

  const instances = state.instances.some((instance) => instance.id === panelId)
    ? state.instances
    : [...state.instances, defaultInstance];
  if (Object.values(state.layout.areas).some((area) => area.tabs.includes(panelId))) {
    return instances === state.instances ? state : { ...state, instances };
  }

  const areaId = preferredAreaId(state, anchorPanelId, fallbackAreaId);
  if (!areaId) {
    return instances === state.instances ? state : { ...state, instances };
  }

  const area = state.layout.areas[areaId] ?? { tabs: [], activePanelId: null };
  const tabs = area.tabs.filter((tabId) => tabId !== panelId);
  const anchorIndex = tabs.indexOf(anchorPanelId);
  tabs.splice(anchorIndex >= 0 ? anchorIndex + 1 : Math.min(1, tabs.length), 0, panelId);

  return {
    ...state,
    instances,
    layout: {
      ...state.layout,
      areas: {
        ...state.layout.areas,
        [areaId]: {
          tabs,
          activePanelId:
            area.activePanelId && tabs.includes(area.activePanelId)
              ? area.activePanelId
              : (tabs[0] ?? null),
        },
      },
    },
  };
}

export function withAppPanelDefaults(state: PanelManagerInitialState): PanelManagerInitialState {
  return ensureDefaultPanelAfterAnchor(state, "storyboard", "subtitles", "middle");
}

export function withoutUnavailableAppPanels(
  state: PanelManagerInitialState,
): PanelManagerInitialState {
  const instances = state.instances.filter((instance) => appPanelRegistry.get(instance.type));
  const instanceIds = new Set(instances.map((instance) => instance.id));
  const areas = Object.fromEntries(
    Object.entries(state.layout.areas).map(([areaId, area]) => {
      const tabs = area.tabs.filter((panelId) => instanceIds.has(panelId));
      return [
        areaId,
        {
          tabs,
          activePanelId:
            area.activePanelId && tabs.includes(area.activePanelId)
              ? area.activePanelId
              : (tabs[0] ?? null),
        },
      ];
    }),
  );
  return {
    instances,
    layout: { ...state.layout, areas },
    focusedPanelId:
      state.focusedPanelId && instanceIds.has(state.focusedPanelId)
        ? state.focusedPanelId
        : (instances[0]?.id ?? null),
  };
}
