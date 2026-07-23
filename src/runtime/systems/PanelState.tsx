import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StateCreator, type StoreApi } from "zustand/vanilla";
import { clientError } from "../../errors";

const PanelInstanceContext = createContext<string | null>(null);
const PanelActiveContext = createContext(true);

interface PanelInstanceProviderProps {
  instanceId: string;
  active?: boolean;
  children: ReactNode;
}

interface PanelStateHook<State extends object> {
  <Selection>(selector: (state: State) => Selection): Selection;
}

const panelStateDisposers = new Set<(instanceId: string) => void>();

export function disposePanelInstanceState(instanceId: string) {
  for (const dispose of panelStateDisposers) {
    dispose(instanceId);
  }
}

export function PanelInstanceProvider({
  instanceId,
  active = true,
  children,
}: PanelInstanceProviderProps) {
  return (
    <PanelInstanceContext.Provider value={instanceId}>
      <PanelActiveContext.Provider value={active}>{children}</PanelActiveContext.Provider>
    </PanelInstanceContext.Provider>
  );
}

export function usePanelInstanceId() {
  const instanceId = useContext(PanelInstanceContext);
  if (!instanceId) {
    throw clientError(
      "PANEL_INSTANCE_CONTEXT_MISSING",
      "Panel instance identifier was requested outside a DockLayout panel",
    );
  }
  return instanceId;
}

export function usePanelActive() {
  return useContext(PanelActiveContext);
}

export function createPanelState<State extends object>(
  initializer: (instanceId: string) => StateCreator<State, [], []>,
) {
  const stores = new Map<string, StoreApi<State>>();
  panelStateDisposers.add((instanceId) => stores.delete(instanceId));

  function getStore(instanceId: string) {
    let store = stores.get(instanceId);
    if (!store) {
      store = createStore<State>()(initializer(instanceId));
      stores.set(instanceId, store);
    }
    return store;
  }

  function usePanelState<Selection>(selector: (state: State) => Selection) {
    const instanceId = useContext(PanelInstanceContext);
    if (!instanceId) {
      throw clientError(
        "PANEL_STATE_CONTEXT_MISSING",
        "Panel state was requested outside a DockLayout panel",
      );
    }
    return useStore(getStore(instanceId), selector);
  }

  return usePanelState as PanelStateHook<State>;
}
