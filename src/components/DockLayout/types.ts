import type { ComponentType, ReactNode } from "react";

export type DockAreaId = "leftTop" | "leftBottom" | "right";
export type PanelInstanceId = string;
export type PanelTypeId = string;

export interface DockAreaState {
  tabs: PanelInstanceId[];
  activePanelId: PanelInstanceId | null;
}

export interface DockLayoutState {
  areas: Record<DockAreaId, DockAreaState>;
}

export interface PanelInstance<Params = unknown> {
  id: PanelInstanceId;
  type: PanelTypeId;
  params: Params;
}

export interface PanelManagerInitialState {
  instances: PanelInstance[];
  layout: DockLayoutState;
  focusedPanelId: PanelInstanceId | null;
}

export interface PanelPlacement {
  areaId?: DockAreaId;
  sourcePanelId?: PanelInstanceId;
}

export interface OpenPanelRequest<Params = unknown> {
  type: PanelTypeId;
  params: Params;
  id?: PanelInstanceId;
  placement?: PanelPlacement;
}

export interface PanelComponentProps<Params> {
  params: Params;
}

export interface PanelMenuItemDefinition {
  type?: "item";
  id: string;
  label: ReactNode;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  title?: string;
  onSelect: () => void | Promise<void>;
}

export interface PanelMenuSeparatorDefinition {
  type: "separator";
  id: string;
}

export interface PanelMenuSelectionItemDefinition {
  id: string;
  label: ReactNode;
  shortcut?: string;
  mnemonic?: string;
  disabled?: boolean;
  title?: string;
  onSelect: () => void | Promise<void>;
}

export interface PanelMenuSelectionGroupDefinition {
  type: "selection";
  id: string;
  defaultValue?: string;
  items: PanelMenuSelectionItemDefinition[];
}

export interface PanelMenuSubmenuDefinition {
  type: "submenu";
  id: string;
  label: ReactNode;
  disabled?: boolean;
  items: PanelMenuEntryDefinition[];
}

export type PanelMenuEntryDefinition =
  | PanelMenuItemDefinition
  | PanelMenuSeparatorDefinition
  | PanelMenuSelectionGroupDefinition
  | PanelMenuSubmenuDefinition;

export interface PanelDefinition<Params = unknown> {
  type: PanelTypeId;
  Component: ComponentType<PanelComponentProps<Params>>;
  /** Reactive panel title hook. It runs in the current panel instance context. */
  useTitle: (params: Params) => string;
  useActions?: (params: Params) => ReactNode;
  /**
   * Panel-owned entries appended below the built-in three-line menu commands.
   * This hook runs in the current panel instance context, so panel-local state is available.
   */
  useMenuItems?: (params: Params) => PanelMenuEntryDefinition[];
  useAvailable?: (params: Params) => boolean;
}

export type AnyPanelDefinition = PanelDefinition<any>;

export function definePanel<Params>(definition: PanelDefinition<Params>) {
  return definition;
}
