import { createContext, useContext, type ReactNode } from "react";
import { definePanel } from "../DockLayout";
import { HistoryPanel } from "./HistoryPanel";

export const historyPanelType = "history";

interface HistoryPanelServices {
  disabled: boolean;
  navigate: (cursor: number) => void | Promise<unknown>;
  deleteEntry: (cursor: number) => void | Promise<unknown>;
}

const HistoryPanelServicesContext = createContext<HistoryPanelServices | null>(null);

export function HistoryPanelServicesProvider({
  services,
  children,
}: {
  services: HistoryPanelServices;
  children: ReactNode;
}) {
  return (
    <HistoryPanelServicesContext.Provider value={services}>
      {children}
    </HistoryPanelServicesContext.Provider>
  );
}

function ManagedHistoryPanel() {
  const services = useContext(HistoryPanelServicesContext);
  if (!services) {
    throw new Error("History panel services are not available.");
  }
  return (
    <HistoryPanel
      disabled={services.disabled}
      onNavigate={services.navigate}
      onDelete={services.deleteEntry}
    />
  );
}

export const historyPanelDefinition = definePanel({
  type: historyPanelType,
  Component: ManagedHistoryPanel,
  useTitle: () => "历史记录",
});
