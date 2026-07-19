import { createContext, useContext, type ReactNode } from "react";
import { definePanel } from "../DockLayout";
import { HistoryPanel } from "./HistoryPanel";
import { clientError } from "../../errors";

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
    throw clientError(
      "HISTORY_PANEL_SERVICES_UNAVAILABLE",
      "History panel services were requested outside their provider",
    );
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
