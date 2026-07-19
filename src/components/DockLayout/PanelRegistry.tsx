import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { PanelInstanceProvider } from "../../panelState";
import { clientError } from "../../errors";
import {
  PopupMenuItem,
  PopupMenuSelectionGroup,
  PopupMenuSelectionItem,
  PopupMenuSeparator,
  PopupMenuSubmenu,
} from "../PopupMenu";
import { usePanelManagerState } from "./PanelManager";
import type {
  AnyPanelDefinition,
  PanelDefinition,
  PanelInstance,
  PanelMenuEntryDefinition,
} from "./types";

function emptyActions() {
  return null;
}

function emptyMenuItems() {
  return [];
}

function alwaysAvailable() {
  return true;
}

interface RegisteredPanelDefinition extends AnyPanelDefinition {
  useActions: NonNullable<AnyPanelDefinition["useActions"]>;
  useMenuItems: NonNullable<AnyPanelDefinition["useMenuItems"]>;
  useAvailable: NonNullable<AnyPanelDefinition["useAvailable"]>;
}

export class PanelRegistry {
  private readonly definitions = new Map<string, RegisteredPanelDefinition>();

  constructor(definitions: readonly AnyPanelDefinition[]) {
    for (const definition of definitions) {
      if (this.definitions.has(definition.type)) {
        throw clientError(
          "PANEL_TYPE_DUPLICATE",
          `Panel type is already registered: ${definition.type}`,
        );
      }
      this.definitions.set(definition.type, {
        ...definition,
        useActions: definition.useActions ?? emptyActions,
        useMenuItems: definition.useMenuItems ?? emptyMenuItems,
        useAvailable: definition.useAvailable ?? alwaysAvailable,
      });
    }
  }

  get(type: string) {
    return this.definitions.get(type);
  }
}

const PanelRegistryContext = createContext<PanelRegistry | null>(null);

export function PanelRegistryProvider({
  registry,
  children,
}: {
  registry: PanelRegistry;
  children: ReactNode;
}) {
  return <PanelRegistryContext.Provider value={registry}>{children}</PanelRegistryContext.Provider>;
}

export function usePanelRegistry() {
  const registry = useContext(PanelRegistryContext);
  if (!registry) {
    throw clientError(
      "PANEL_REGISTRY_CONTEXT_MISSING",
      "Panel registry was requested outside PanelRegistryProvider",
    );
  }
  return registry;
}

function useRegisteredPanel(instanceId: string) {
  const registry = usePanelRegistry();
  const instance = usePanelManagerState((state) => state.instances[instanceId]);
  const definition = instance ? registry.get(instance.type) : undefined;
  return { definition, instance };
}

interface PanelDefinitionBoundaryProps {
  definition: RegisteredPanelDefinition;
  instance: PanelInstance;
  active: boolean;
}

function PanelDefinitionBoundary({ definition, instance, active }: PanelDefinitionBoundaryProps) {
  const closePanel = usePanelManagerState((state) => state.closePanel);
  const available = definition.useAvailable(instance.params);
  const Component = definition.Component;

  useEffect(() => {
    if (!available) {
      closePanel(instance.id);
    }
  }, [available, closePanel, instance.id]);

  if (!available) {
    return null;
  }

  return (
    <PanelInstanceProvider instanceId={instance.id} active={active}>
      <Component params={instance.params} />
    </PanelInstanceProvider>
  );
}

export function PanelHost({ instanceId, active }: { instanceId: string; active: boolean }) {
  const { definition, instance } = useRegisteredPanel(instanceId);
  if (!definition || !instance) {
    return <div className="dock-empty-content">面板不可用</div>;
  }
  return <PanelDefinitionBoundary definition={definition} instance={instance} active={active} />;
}

function PanelTitleContent({
  definition,
  instance,
  children,
}: {
  definition: RegisteredPanelDefinition;
  instance: PanelInstance;
  children: (title: string) => ReactNode;
}) {
  return children(definition.useTitle(instance.params));
}

export function PanelTitle({
  instanceId,
  children,
}: {
  instanceId: string;
  children: (title: string) => ReactNode;
}) {
  const { definition, instance } = useRegisteredPanel(instanceId);
  if (!definition || !instance) {
    return children("面板不可用");
  }
  return (
    <PanelInstanceProvider instanceId={instance.id}>
      <PanelTitleContent definition={definition} instance={instance} children={children} />
    </PanelInstanceProvider>
  );
}

function PanelActionsContent({
  definition,
  instance,
}: {
  definition: RegisteredPanelDefinition;
  instance: PanelInstance;
}) {
  return definition.useActions(instance.params);
}

export function PanelActions({ instanceId }: { instanceId: string }) {
  const { definition, instance } = useRegisteredPanel(instanceId);
  if (!definition || !instance) {
    return null;
  }
  return (
    <PanelInstanceProvider instanceId={instance.id}>
      <PanelActionsContent definition={definition} instance={instance} />
    </PanelInstanceProvider>
  );
}

function PanelMenuEntry({
  entry,
  closeMenu,
}: {
  entry: PanelMenuEntryDefinition;
  closeMenu: () => void;
}) {
  const [submenuOpen, setSubmenuOpen] = useState(false);
  if (entry.type === "separator") {
    return <PopupMenuSeparator />;
  }
  if (entry.type === "submenu") {
    return (
      <PopupMenuSubmenu
        label={entry.label}
        open={submenuOpen}
        disabled={entry.disabled}
        onOpenChange={setSubmenuOpen}
      >
        {entry.items.map((child) => (
          <PanelMenuEntry key={child.id} entry={child} closeMenu={closeMenu} />
        ))}
      </PopupMenuSubmenu>
    );
  }
  if (entry.type === "selection") {
    return (
      <PopupMenuSelectionGroup defaultValue={entry.defaultValue}>
        {entry.items.map((item) => (
          <PopupMenuSelectionItem
            key={item.id}
            value={item.id}
            shortcut={item.shortcut}
            mnemonic={item.mnemonic}
            disabled={item.disabled}
            title={item.title}
            onSelect={async () => {
              await item.onSelect();
              closeMenu();
            }}
          >
            {item.label}
          </PopupMenuSelectionItem>
        ))}
      </PopupMenuSelectionGroup>
    );
  }
  return (
    <PopupMenuItem
      shortcut={entry.shortcut}
      checked={entry.checked}
      disabled={entry.disabled}
      title={entry.title}
      onSelect={async () => {
        await entry.onSelect();
        closeMenu();
      }}
    >
      {entry.label}
    </PopupMenuItem>
  );
}

function PanelMenuItemsContent({
  definition,
  instance,
  closeMenu,
}: {
  definition: RegisteredPanelDefinition;
  instance: PanelInstance;
  closeMenu: () => void;
}) {
  const items = definition.useMenuItems(instance.params);
  if (items.length === 0) {
    return null;
  }
  return (
    <>
      <PopupMenuSeparator />
      {items.map((entry) => (
        <PanelMenuEntry key={entry.id} entry={entry} closeMenu={closeMenu} />
      ))}
    </>
  );
}

export function PanelMenuItems({
  instanceId,
  closeMenu,
}: {
  instanceId: string;
  closeMenu: () => void;
}) {
  const { definition, instance } = useRegisteredPanel(instanceId);
  if (!definition || !instance) {
    return null;
  }
  return (
    <PanelInstanceProvider instanceId={instance.id}>
      <PanelMenuItemsContent definition={definition} instance={instance} closeMenu={closeMenu} />
    </PanelInstanceProvider>
  );
}

export type { PanelDefinition };
