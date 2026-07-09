import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StateCreator, type StoreApi } from "zustand/vanilla";

const PanelInstanceContext = createContext<string | null>(null);

interface PanelInstanceProviderProps {
  instanceId: string;
  children: ReactNode;
}

export function PanelInstanceProvider({ instanceId, children }: PanelInstanceProviderProps) {
  return (
    <PanelInstanceContext.Provider value={instanceId}>{children}</PanelInstanceContext.Provider>
  );
}

export function createPanelState<State extends object>(
  initializer: (instanceId: string) => StateCreator<State, [], []>,
) {
  const stores = new Map<string, StoreApi<State>>();

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
      throw new Error("Panel state must be used inside a DockLayout panel.");
    }
    return useStore(getStore(instanceId), selector);
  }

  return usePanelState;
}
