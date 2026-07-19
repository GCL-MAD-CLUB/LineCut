import { createContext, useContext, useRef, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { disposePanelInstanceState, usePanelInstanceId } from "../../panelState";
import { clientError } from "../../errors";
import type {
  DockAreaId,
  DockAreaState,
  DockLayoutState,
  OpenPanelRequest,
  PanelInstance,
  PanelManagerInitialState,
} from "./types";

const dockAreaOrder: DockAreaId[] = ["leftTop", "leftBottom", "right"];

function normalizeArea(area: DockAreaState): DockAreaState {
  if (area.tabs.length === 0) {
    return { tabs: area.tabs, activePanelId: null };
  }
  return {
    tabs: area.tabs,
    activePanelId:
      area.activePanelId && area.tabs.includes(area.activePanelId)
        ? area.activePanelId
        : area.tabs[0],
  };
}

function panelArea(layout: DockLayoutState, panelId: string) {
  return dockAreaOrder.find((areaId) => layout.areas[areaId].tabs.includes(panelId)) ?? null;
}

function nextPanelInstanceId(type: string) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${type}:${random}`;
}

export interface PanelManagerState {
  instances: Record<string, PanelInstance>;
  layout: DockLayoutState;
  focusedPanelId: string | null;
  openPanel: <Params>(request: OpenPanelRequest<Params>) => string;
  activatePanel: (areaId: DockAreaId, panelId: string) => void;
  focusPanel: (panelId: string) => void;
  movePanel: (panelId: string, targetAreaId: DockAreaId, targetIndex?: number) => void;
  closePanel: (panelId: string) => void;
  closePanels: (areaId: DockAreaId, panelIds: Iterable<string>) => void;
}

function createPanelManagerStore(initialState: PanelManagerInitialState) {
  return createStore<PanelManagerState>()((set, get) => ({
    instances: Object.fromEntries(
      initialState.instances.map((instance) => [instance.id, instance]),
    ),
    layout: initialState.layout,
    focusedPanelId: initialState.focusedPanelId,

    openPanel: (request) => {
      const id = request.id ?? nextPanelInstanceId(request.type);
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
        const targetAreaId = request.placement?.areaId ?? sourceAreaId ?? "leftBottom";
        const areas = { ...state.layout.areas };
        for (const areaId of dockAreaOrder) {
          const area = areas[areaId];
          const tabs = area.tabs.filter((panelId) => panelId !== id);
          areas[areaId] = normalizeArea({ tabs, activePanelId: area.activePanelId });
        }
        areas[targetAreaId] = {
          tabs: [...areas[targetAreaId].tabs, id],
          activePanelId: id,
        };
        return {
          instances: {
            ...state.instances,
            [id]: { id, type: request.type, params: request.params },
          },
          layout: { areas },
          focusedPanelId: id,
        };
      });
      return id;
    },

    activatePanel: (areaId, panelId) => {
      set((state) => {
        if (!state.instances[panelId] || !state.layout.areas[areaId].tabs.includes(panelId)) {
          return state;
        }
        return {
          layout: {
            areas: {
              ...state.layout.areas,
              [areaId]: { ...state.layout.areas[areaId], activePanelId: panelId },
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

    movePanel: (panelId, targetAreaId, targetIndex) => {
      set((state) => {
        if (!state.instances[panelId]) {
          return state;
        }
        const areas = { ...state.layout.areas };
        for (const areaId of dockAreaOrder) {
          const area = areas[areaId];
          const tabs = area.tabs.filter((tabPanelId) => tabPanelId !== panelId);
          areas[areaId] = normalizeArea({
            tabs,
            activePanelId: area.activePanelId === panelId ? (tabs[0] ?? null) : area.activePanelId,
          });
        }
        const targetTabs = areas[targetAreaId].tabs;
        const insertionIndex = Math.min(
          Math.max(targetIndex ?? targetTabs.length, 0),
          targetTabs.length,
        );
        areas[targetAreaId] = {
          tabs: [
            ...targetTabs.slice(0, insertionIndex),
            panelId,
            ...targetTabs.slice(insertionIndex),
          ],
          activePanelId: panelId,
        };
        return { layout: { areas }, focusedPanelId: panelId };
      });
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
      if (existingClosedPanelIds.length === 0) {
        return;
      }
      set((state) => {
        const area = normalizeArea(state.layout.areas[areaId]);
        const activeIndex = area.activePanelId ? area.tabs.indexOf(area.activePanelId) : 0;
        const areas = { ...state.layout.areas };
        for (const currentAreaId of dockAreaOrder) {
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
        const targetTabs = areas[areaId].tabs;
        if (area.activePanelId && closedPanelIds.has(area.activePanelId)) {
          areas[areaId].activePanelId =
            targetTabs[Math.min(Math.max(activeIndex, 0), targetTabs.length - 1)] ?? null;
        }
        const instances = { ...state.instances };
        for (const panelId of existingClosedPanelIds) {
          delete instances[panelId];
        }
        const focusedPanelId =
          state.focusedPanelId && closedPanelIds.has(state.focusedPanelId)
            ? (areas[areaId].activePanelId ??
              dockAreaOrder.map((id) => areas[id].activePanelId).find(Boolean) ??
              null)
            : state.focusedPanelId;
        return { instances, layout: { areas }, focusedPanelId };
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
  children,
}: {
  initialState: PanelManagerInitialState;
  children: ReactNode;
}) {
  const storeRef = useRef<StoreApi<PanelManagerState> | null>(null);
  if (!storeRef.current) {
    storeRef.current = createPanelManagerStore(initialState);
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

export { dockAreaOrder, normalizeArea };
