import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StateCreator, type StoreApi } from "zustand/vanilla";

const PanelInstanceContext = createContext<string | null>(null);
const PanelActiveContext = createContext(true);

interface PanelInstanceProviderProps {
  instanceId: string;
  active?: boolean;
  children: ReactNode;
}

interface PanelStateHook<State extends object> {
  <Selection>(selector: (state: State) => Selection): Selection;
  useInstance: <Selection>(instanceId: string, selector: (state: State) => Selection) => Selection;
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
    throw new Error("Panel instance ID must be used inside a DockLayout panel.");
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

  function usePanelInstanceState<Selection>(
    instanceId: string,
    selector: (state: State) => Selection,
  ) {
    return useStore(getStore(instanceId), selector);
  }

  return Object.assign(usePanelState, {
    useInstance: usePanelInstanceState,
  }) as PanelStateHook<State>;
}
