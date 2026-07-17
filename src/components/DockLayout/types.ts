import type { ReactNode } from "react";

export type DockAreaId = "leftTop" | "leftBottom" | "right";

export interface DockAreaState<PanelId extends string> {
  tabs: PanelId[];
  activePanelId: PanelId | null;
}

export interface DockLayoutState<PanelId extends string> {
  areas: Record<DockAreaId, DockAreaState<PanelId>>;
}

export interface DockPanelDefinition<PanelId extends string> {
  id: PanelId;
  title: string;
  actions?: ReactNode;
  render: () => ReactNode;
}

export interface DockPanelOpenRequest<PanelId extends string> {
  panelId: PanelId;
  sourcePanelId: PanelId;
}
