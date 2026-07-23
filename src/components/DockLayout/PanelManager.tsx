import { createContext, useContext, useRef, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { clientError } from "../../errors";
import { disposePanelInstanceState, usePanelInstanceId } from "../../runtime/systems/PanelState";
import type {
  DockAreaId,
  DockAreaState,
  DockDropPosition,
  DockLayoutNode,
  DockLayoutState,
  OpenPanelRequest,
  PanelInstance,
  PanelManagerInitialState,
} from "./types";

function normalizeArea(area: DockAreaState | undefined): DockAreaState {
  if (!area || area.tabs.length === 0) {
    return { tabs: area?.tabs ?? [], activePanelId: null };
  }
  return {
    tabs: area.tabs,
    activePanelId:
      area.activePanelId && area.tabs.includes(area.activePanelId)
        ? area.activePanelId
        : area.tabs[0],
  };
}

function dockAreaIds(node: DockLayoutNode): DockAreaId[] {
  if (node.type === "area") {
    return [node.areaId];
  }
  return [...dockAreaIds(node.first), ...dockAreaIds(node.second)];
}

function panelArea(layout: DockLayoutState, panelId: string) {
  return (
    dockAreaIds(layout.root).find((areaId) => layout.areas[areaId]?.tabs.includes(panelId)) ?? null
  );
}

interface DockAreaCenter {
  x: number;
  y: number;
}

function dockAreaCenters(node: DockLayoutNode) {
  const centers = new Map<DockAreaId, DockAreaCenter>();
  function visit(
    current: DockLayoutNode,
    left: number,
    top: number,
    width: number,
    height: number,
  ) {
    if (current.type === "area") {
      centers.set(current.areaId, { x: left + width / 2, y: top + height / 2 });
      return;
    }
    if (current.axis === "x") {
      const firstWidth = width * current.ratio;
      visit(current.first, left, top, firstWidth, height);
      visit(current.second, left + firstWidth, top, width - firstWidth, height);
      return;
    }
    const firstHeight = height * current.ratio;
    visit(current.first, left, top, width, firstHeight);
    visit(current.second, left, top + firstHeight, width, height - firstHeight);
  }
  visit(node, 0, 0, 1, 1);
  return centers;
}

function nearestAreaId(
  layout: DockLayoutState,
  target: DockAreaCenter | undefined,
): DockAreaId | null {
  if (!target) {
    return null;
  }
  const centers = dockAreaCenters(layout.root);
  let nearest: DockAreaId | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const areaId of dockAreaIds(layout.root)) {
    if (!layout.areas[areaId]) {
      continue;
    }
    const center = centers.get(areaId);
    if (!center) {
      continue;
    }
    const distance = (center.x - target.x) ** 2 + (center.y - target.y) ** 2;
    if (distance < nearestDistance) {
      nearest = areaId;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function nextUniqueId(prefix: string) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}:${random}`;
}

function replaceDockArea(
  node: DockLayoutNode,
  areaId: DockAreaId,
  replacement: DockLayoutNode,
): DockLayoutNode {
  if (node.type === "area") {
    return node.areaId === areaId ? replacement : node;
  }
  return {
    ...node,
    first: replaceDockArea(node.first, areaId, replacement),
    second: replaceDockArea(node.second, areaId, replacement),
  };
}

function updateDockSplit(node: DockLayoutNode, splitId: string, ratio: number): DockLayoutNode {
  if (node.type === "area") {
    return node;
  }
  if (node.id === splitId) {
    return { ...node, ratio };
  }
  return {
    ...node,
    first: updateDockSplit(node.first, splitId, ratio),
    second: updateDockSplit(node.second, splitId, ratio),
  };
}

function pruneEmptyDockAreas(layout: DockLayoutState, fallbackAreaId: DockAreaId): DockLayoutState {
  function prune(node: DockLayoutNode): DockLayoutNode | null {
    if (node.type === "area") {
      return normalizeArea(layout.areas[node.areaId]).tabs.length > 0 ? node : null;
    }
    const first = prune(node.first);
    const second = prune(node.second);
    if (!first) {
      return second;
    }
    if (!second) {
      return first;
    }
    return { ...node, first, second };
  }

  const root = prune(layout.root) ?? { type: "area", areaId: fallbackAreaId };
  const retainedAreaIds = new Set(dockAreaIds(root));
  const areas = Object.fromEntries(
    Array.from(retainedAreaIds, (areaId) => [areaId, normalizeArea(layout.areas[areaId])]),
  );
  return { root, areas };
}

function firstAvailableAreaId(layout: DockLayoutState) {
  return dockAreaIds(layout.root).find((areaId) => Boolean(layout.areas[areaId])) ?? null;
}

function focusedOrFirstAreaId(layout: DockLayoutState, focusedPanelId: string | null) {
  return (
    (focusedPanelId ? panelArea(layout, focusedPanelId) : null) ?? firstAvailableAreaId(layout)
  );
}

export interface PanelManagerState {
  instances: Record<string, PanelInstance>;
  layout: DockLayoutState;
  focusedPanelId: string | null;
  openPanel: <Params>(request: OpenPanelRequest<Params>) => string;
  activatePanel: (areaId: DockAreaId, panelId: string) => void;
  focusPanel: (panelId: string) => void;
  movePanel: (
    panelId: string,
    targetAreaId: DockAreaId,
    targetIndex?: number,
    position?: DockDropPosition,
  ) => void;
  resizeSplit: (splitId: string, ratio: number) => void;
  closePanel: (panelId: string) => void;
  closePanels: (areaId: DockAreaId, panelIds: Iterable<string>) => void;
}

function createPanelManagerStore(
  initialState: PanelManagerInitialState,
  defaultState: PanelManagerInitialState,
) {
  const defaultPanelAreas = new Map(
    defaultState.instances.flatMap((instance) => {
      const areaId = panelArea(defaultState.layout, instance.id);
      return areaId ? [[instance.id, areaId] as const] : [];
    }),
  );
  const defaultAreaCenters = dockAreaCenters(defaultState.layout.root);

  return createStore<PanelManagerState>()((set, get) => ({
    instances: Object.fromEntries(
      initialState.instances.map((instance) => [instance.id, instance]),
    ),
    layout: initialState.layout,
    focusedPanelId: initialState.focusedPanelId,

    openPanel: (request) => {
      const id = request.id ?? nextUniqueId(request.type);
      const existing = get().instances[id];
      if (existing) {
        const areaId = panelArea(get().layout, id);
        if (areaId) {
          get().activatePanel(areaId, id);
        }
        return id;
      }

      set((state) => {
        const sourceAreaId = request.placement?.sourcePanelId
          ? panelArea(state.layout, request.placement.sourcePanelId)
          : null;
        const requestedAreaId = request.placement?.areaId;
        const defaultAreaId = defaultPanelAreas.get(id) ?? requestedAreaId;
        const targetAreaId =
          (requestedAreaId && state.layout.areas[requestedAreaId] ? requestedAreaId : null) ??
          sourceAreaId ??
          (defaultAreaId && state.layout.areas[defaultAreaId] ? defaultAreaId : null) ??
          nearestAreaId(
            state.layout,
            defaultAreaId ? defaultAreaCenters.get(defaultAreaId) : undefined,
          ) ??
          focusedOrFirstAreaId(state.layout, state.focusedPanelId);
        if (!targetAreaId) {
          return state;
        }

        const areas = { ...state.layout.areas };
        for (const areaId of dockAreaIds(state.layout.root)) {
          const area = normalizeArea(areas[areaId]);
          const tabs = area.tabs.filter((panelId) => panelId !== id);
          areas[areaId] = normalizeArea({ tabs, activePanelId: area.activePanelId });
        }
        const targetArea = normalizeArea(areas[targetAreaId]);
        areas[targetAreaId] = {
          tabs: [...targetArea.tabs, id],
          activePanelId: id,
        };
        return {
          instances: {
            ...state.instances,
            [id]: { id, type: request.type, params: request.params },
          },
          layout: { ...state.layout, areas },
          focusedPanelId: id,
        };
      });
      return id;
    },

    activatePanel: (areaId, panelId) => {
      set((state) => {
        const area = state.layout.areas[areaId];
        if (!state.instances[panelId] || !area?.tabs.includes(panelId)) {
          return state;
        }
        return {
          layout: {
            ...state.layout,
            areas: {
              ...state.layout.areas,
              [areaId]: { ...area, activePanelId: panelId },
            },
          },
          focusedPanelId: panelId,
        };
      });
    },

    focusPanel: (panelId) => {
      if (get().instances[panelId]) {
        set({ focusedPanelId: panelId });
      }
    },

    movePanel: (panelId, requestedTargetAreaId, targetIndex, position = "self") => {
      set((state) => {
        if (!state.instances[panelId]) {
          return state;
        }
        const targetAreaId = state.layout.areas[requestedTargetAreaId]
          ? requestedTargetAreaId
          : focusedOrFirstAreaId(state.layout, state.focusedPanelId);
        if (!targetAreaId) {
          return state;
        }

        const areas = { ...state.layout.areas };
        for (const areaId of dockAreaIds(state.layout.root)) {
          const area = normalizeArea(areas[areaId]);
          const tabs = area.tabs.filter((tabPanelId) => tabPanelId !== panelId);
          areas[areaId] = normalizeArea({
            tabs,
            activePanelId: area.activePanelId === panelId ? (tabs[0] ?? null) : area.activePanelId,
          });
        }

        if (position === "self") {
          const targetArea = normalizeArea(areas[targetAreaId]);
          const insertionIndex = Math.min(
            Math.max(targetIndex ?? targetArea.tabs.length, 0),
            targetArea.tabs.length,
          );
          areas[targetAreaId] = {
            tabs: [
              ...targetArea.tabs.slice(0, insertionIndex),
              panelId,
              ...targetArea.tabs.slice(insertionIndex),
            ],
            activePanelId: panelId,
          };
          return {
            layout: pruneEmptyDockAreas({ ...state.layout, areas }, targetAreaId),
            focusedPanelId: panelId,
          };
        }

        const newAreaId = nextUniqueId("dock-area");
        const newAreaNode: DockLayoutNode = { type: "area", areaId: newAreaId };
        const targetAreaNode: DockLayoutNode = { type: "area", areaId: targetAreaId };
        const newAreaComesFirst = position === "left" || position === "up";
        const splitNode: DockLayoutNode = {
          type: "split",
          id: nextUniqueId("dock-split"),
          axis: position === "left" || position === "right" ? "x" : "y",
          ratio: 0.5,
          first: newAreaComesFirst ? newAreaNode : targetAreaNode,
          second: newAreaComesFirst ? targetAreaNode : newAreaNode,
        };
        areas[newAreaId] = { tabs: [panelId], activePanelId: panelId };
        const root = replaceDockArea(state.layout.root, targetAreaId, splitNode);
        return {
          layout: pruneEmptyDockAreas({ root, areas }, newAreaId),
          focusedPanelId: panelId,
        };
      });
    },

    resizeSplit: (splitId, ratio) => {
      set((state) => ({
        layout: {
          ...state.layout,
          root: updateDockSplit(state.layout.root, splitId, Math.min(Math.max(ratio, 0.05), 0.95)),
        },
      }));
    },

    closePanel: (panelId) => {
      const areaId = panelArea(get().layout, panelId);
      if (areaId) {
        get().closePanels(areaId, [panelId]);
      }
    },

    closePanels: (areaId, panelIds) => {
      const closedPanelIds = new Set(panelIds);
      const existingClosedPanelIds = Array.from(closedPanelIds).filter(
        (panelId) => get().instances[panelId],
      );
      if (existingClosedPanelIds.length === 0 || !get().layout.areas[areaId]) {
        return;
      }
      set((state) => {
        const area = normalizeArea(state.layout.areas[areaId]);
        const activeIndex = area.activePanelId ? area.tabs.indexOf(area.activePanelId) : 0;
        const areas = { ...state.layout.areas };
        for (const currentAreaId of dockAreaIds(state.layout.root)) {
          const currentArea = normalizeArea(areas[currentAreaId]);
          const tabs = currentArea.tabs.filter((panelId) => !closedPanelIds.has(panelId));
          const currentActiveIndex = currentArea.activePanelId
            ? currentArea.tabs.indexOf(currentArea.activePanelId)
            : 0;
          areas[currentAreaId] = {
            tabs,
            activePanelId:
              currentArea.activePanelId && closedPanelIds.has(currentArea.activePanelId)
                ? (tabs[Math.min(Math.max(currentActiveIndex, 0), tabs.length - 1)] ?? null)
                : currentArea.activePanelId,
          };
        }
        const targetTabs = areas[areaId]?.tabs ?? [];
        if (areas[areaId] && area.activePanelId && closedPanelIds.has(area.activePanelId)) {
          areas[areaId].activePanelId =
            targetTabs[Math.min(Math.max(activeIndex, 0), targetTabs.length - 1)] ?? null;
        }
        const instances = { ...state.instances };
        for (const panelId of existingClosedPanelIds) {
          delete instances[panelId];
        }
        const layout = pruneEmptyDockAreas({ ...state.layout, areas }, areaId);
        const focusedPanelId =
          state.focusedPanelId && closedPanelIds.has(state.focusedPanelId)
            ? (dockAreaIds(layout.root)
                .map((id) => normalizeArea(layout.areas[id]).activePanelId)
                .find(Boolean) ?? null)
            : state.focusedPanelId;
        return { instances, layout, focusedPanelId };
      });
      for (const panelId of existingClosedPanelIds) {
        disposePanelInstanceState(panelId);
      }
    },
  }));
}

const PanelManagerContext = createContext<StoreApi<PanelManagerState> | null>(null);

export function PanelManagerProvider({
  initialState,
  defaultState = initialState,
  children,
}: {
  initialState: PanelManagerInitialState;
  defaultState?: PanelManagerInitialState;
  children: ReactNode;
}) {
  const storeRef = useRef<StoreApi<PanelManagerState> | null>(null);
  if (!storeRef.current) {
    storeRef.current = createPanelManagerStore(initialState, defaultState);
  }
  return (
    <PanelManagerContext.Provider value={storeRef.current}>{children}</PanelManagerContext.Provider>
  );
}

export function usePanelManagerState<Selection>(selector: (state: PanelManagerState) => Selection) {
  const store = useContext(PanelManagerContext);
  if (!store) {
    throw clientError(
      "PANEL_MANAGER_CONTEXT_MISSING",
      "Panel manager was requested outside PanelManagerProvider",
    );
  }
  return useStore(store, selector);
}

export function useCurrentPanel() {
  const panelId = usePanelInstanceId();
  const instance = usePanelManagerState((state) => state.instances[panelId]);
  const openPanel = usePanelManagerState((state) => state.openPanel);
  const closePanel = usePanelManagerState((state) => state.closePanel);
  if (!instance) {
    throw clientError(
      "PANEL_INSTANCE_NOT_MANAGED",
      `Panel instance is not managed by PanelManager: ${panelId}`,
    );
  }
  return {
    instance,
    openPanel,
    close: () => closePanel(panelId),
  };
}

export { dockAreaIds, normalizeArea };
