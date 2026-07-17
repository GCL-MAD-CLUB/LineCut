import { Check, ChevronRight } from "lucide-react";
import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import "./PopupMenu.css";

const popupViewportMargin = 8;

interface PopupMenuViewportLayout {
  maxHeight: number | undefined;
  translateX: number;
  translateY: number;
  scrollable: boolean;
}

interface PopupMenuContextAnchor {
  x: number;
  y: number;
}

const initialViewportLayout: PopupMenuViewportLayout = {
  maxHeight: undefined,
  translateX: 0,
  translateY: 0,
  scrollable: false,
};

interface PopupMenuProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  submenuAnchor?: DOMRect;
  contextMenuAnchor?: PopupMenuContextAnchor;
  enableMnemonics?: boolean;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

export function PopupMenu({
  children,
  className = "",
  style,
  ariaLabel,
  submenuAnchor,
  contextMenuAnchor,
  enableMnemonics = false,
  onPointerDown,
  onContextMenu,
}: PopupMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const viewportLayoutRef = useRef(initialViewportLayout);
  const [viewportLayout, setViewportLayout] = useState(initialViewportLayout);
  const [positioned, setPositioned] = useState(false);

  const fitToViewport = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const current = viewportLayoutRef.current;
    const rect = menu.getBoundingClientRect();
    const anchorLeft = submenuAnchor
      ? submenuAnchor.right - 4
      : (contextMenuAnchor?.x ?? rect.left - current.translateX);
    const anchorTop = submenuAnchor
      ? submenuAnchor.top - 3
      : (contextMenuAnchor?.y ?? rect.top - current.translateY);
    const borderHeight = Math.max(0, rect.height - menu.clientHeight);
    const naturalHeight = menu.scrollHeight + borderHeight;
    const maximumViewportHeight = Math.max(0, window.innerHeight - popupViewportMargin * 2);
    let maximumHeight = Math.max(0, maximumViewportHeight - borderHeight);
    let renderedHeight = Math.min(naturalHeight, maximumHeight + borderHeight);
    let targetTop: number;

    if (contextMenuAnchor) {
      const spaceAbove = Math.max(0, anchorTop - popupViewportMargin);
      const spaceBelow = Math.max(0, window.innerHeight - popupViewportMargin - anchorTop);

      if (naturalHeight <= spaceBelow) {
        targetTop = anchorTop;
      } else if (naturalHeight <= spaceAbove) {
        targetTop = anchorTop - naturalHeight;
      } else if (spaceBelow >= spaceAbove) {
        maximumHeight = Math.max(0, spaceBelow - borderHeight);
        renderedHeight = Math.min(naturalHeight, maximumHeight + borderHeight);
        targetTop = anchorTop;
      } else {
        maximumHeight = Math.max(0, spaceAbove - borderHeight);
        renderedHeight = Math.min(naturalHeight, maximumHeight + borderHeight);
        targetTop = anchorTop - renderedHeight;
      }
    } else {
      const maximumTop = Math.max(
        popupViewportMargin,
        window.innerHeight - popupViewportMargin - renderedHeight,
      );
      targetTop = Math.min(Math.max(anchorTop, popupViewportMargin), maximumTop);
    }

    const maximumLeft = Math.max(
      popupViewportMargin,
      window.innerWidth - popupViewportMargin - rect.width,
    );
    let targetLeft = Math.min(Math.max(anchorLeft, popupViewportMargin), maximumLeft);
    if (submenuAnchor && anchorLeft + rect.width > window.innerWidth - popupViewportMargin) {
      targetLeft = Math.max(popupViewportMargin, submenuAnchor.left - rect.width + 4);
    }

    const next: PopupMenuViewportLayout = {
      maxHeight: maximumHeight,
      translateX: targetLeft - anchorLeft,
      translateY: targetTop - anchorTop,
      scrollable: naturalHeight > maximumHeight + 0.5,
    };
    if (
      current.maxHeight === next.maxHeight &&
      Math.abs(current.translateX - next.translateX) < 0.5 &&
      Math.abs(current.translateY - next.translateY) < 0.5 &&
      current.scrollable === next.scrollable
    ) {
      return;
    }
    viewportLayoutRef.current = next;
    setViewportLayout(next);
  }, [contextMenuAnchor, submenuAnchor]);

  useLayoutEffect(() => {
    fitToViewport();
    setPositioned(true);
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const resizeObserver = new ResizeObserver(fitToViewport);
    resizeObserver.observe(menu);
    window.addEventListener("resize", fitToViewport);
    window.addEventListener("scroll", fitToViewport, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", fitToViewport);
      window.removeEventListener("scroll", fitToViewport, true);
    };
  }, [children, fitToViewport, style]);

  useEffect(() => {
    if (!enableMnemonics) {
      return;
    }

    const selectByMnemonic = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      const mnemonic = event.key.toLocaleLowerCase();
      const item = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>("[data-popup-menu-mnemonic]") ?? [],
      ).find((candidate) => candidate.dataset.popupMenuMnemonic === mnemonic);
      if (!item) {
        return;
      }
      event.preventDefault();
      if (!item.disabled) {
        item.click();
      }
    };

    window.addEventListener("keydown", selectByMnemonic);
    return () => window.removeEventListener("keydown", selectByMnemonic);
  }, [enableMnemonics]);

  const transforms = [
    style?.transform,
    viewportLayout.translateX || viewportLayout.translateY
      ? `translate(${viewportLayout.translateX}px, ${viewportLayout.translateY}px)`
      : undefined,
  ].filter(Boolean);

  return (
    <div
      ref={menuRef}
      className={["popup-menu", className].filter(Boolean).join(" ")}
      role="menu"
      aria-label={ariaLabel}
      style={{
        ...style,
        maxHeight: viewportLayout.maxHeight,
        overflowY: viewportLayout.scrollable ? "auto" : "visible",
        transform: transforms.length > 0 ? transforms.join(" ") : undefined,
        visibility: positioned ? style?.visibility : "hidden",
      }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      {children}
    </div>
  );
}

interface PopupMenuItemProps {
  children: ReactNode;
  shortcut?: string;
  mnemonic?: string;
  checked?: boolean;
  indicator?: "check" | "dot";
  disabled?: boolean;
  submenu?: boolean;
  title?: string;
  onSelect?: () => void | Promise<void>;
}

export function PopupMenuItem({
  children,
  shortcut,
  mnemonic,
  checked,
  indicator = "check",
  disabled,
  submenu,
  title,
  onSelect,
}: PopupMenuItemProps) {
  return (
    <button
      type="button"
      className="popup-menu-item"
      role={
        checked === undefined
          ? "menuitem"
          : indicator === "dot"
            ? "menuitemradio"
            : "menuitemcheckbox"
      }
      aria-checked={checked}
      aria-keyshortcuts={mnemonic}
      data-popup-menu-mnemonic={mnemonic?.toLocaleLowerCase()}
      disabled={disabled}
      title={title}
      onClick={() => void onSelect?.()}
    >
      <span className="popup-menu-check">
        {checked === true &&
          (indicator === "dot" ? (
            <span className="popup-menu-selection-dot" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          ))}
      </span>
      <span className="popup-menu-label">{children}</span>
      {shortcut ? <kbd>{shortcut}</kbd> : <span />}
      {submenu && <ChevronRight className="popup-menu-submenu-icon" aria-hidden="true" />}
    </button>
  );
}

export function PopupMenuSeparator() {
  return <div className="popup-menu-separator" role="separator" />;
}

interface PopupMenuSelectionGroupValue {
  selectedValue: string | null;
  selectValue: (value: string) => void;
}

const PopupMenuSelectionGroupContext = createContext<PopupMenuSelectionGroupValue | null>(null);

interface PopupMenuSelectionItemMetadata {
  value: string;
  disabled: boolean;
}

function selectionItemMetadata(children: ReactNode): PopupMenuSelectionItemMetadata[] {
  const items: PopupMenuSelectionItemMetadata[] = [];
  const collect = (nodes: ReactNode) => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement<PopupMenuSelectionItemProps>(child)) {
        return;
      }
      if (child.type === Fragment) {
        collect(child.props.children);
        return;
      }
      if (child.type === PopupMenuSelectionItem) {
        items.push({ value: child.props.value, disabled: child.props.disabled === true });
      }
    });
  };
  collect(children);
  return items;
}

interface PopupMenuSelectionGroupProps {
  children: ReactNode;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

/** A self-contained radio group for popup menus that owns the selected value internally. */
export function PopupMenuSelectionGroup({
  children,
  defaultValue,
  onValueChange,
}: PopupMenuSelectionGroupProps) {
  const items = useMemo(() => selectionItemMetadata(children), [children]);
  const duplicateValue = items.find(
    (item, index) => items.findIndex((candidate) => candidate.value === item.value) !== index,
  )?.value;
  if (duplicateValue) {
    throw new Error(`PopupMenuSelectionItem value "${duplicateValue}" must be unique.`);
  }
  const itemKey = items.map((item) => `${item.value}:${item.disabled}`).join("\u0000");
  const initialValueRef = useRef<string | null | undefined>(undefined);
  if (initialValueRef.current === undefined) {
    initialValueRef.current =
      items.find((item) => item.value === defaultValue && !item.disabled)?.value ??
      items.find((item) => !item.disabled)?.value ??
      items[0]?.value ??
      null;
  }
  const [selectedValue, setSelectedValue] = useState(initialValueRef.current);
  const selectedValueRef = useRef(selectedValue);

  useEffect(() => {
    const selectedItem = items.find((item) => item.value === selectedValueRef.current);
    if (selectedItem && !selectedItem.disabled) {
      return;
    }
    const fallbackValue = items.find((item) => !item.disabled)?.value ?? items[0]?.value ?? null;
    selectedValueRef.current = fallbackValue;
    setSelectedValue(fallbackValue);
  }, [itemKey, items]);

  const selectValue = useCallback(
    (value: string) => {
      if (selectedValueRef.current === value) {
        return;
      }
      selectedValueRef.current = value;
      setSelectedValue(value);
      onValueChange?.(value);
    },
    [onValueChange],
  );

  if (items.length === 0) {
    return null;
  }

  return (
    <PopupMenuSelectionGroupContext.Provider value={{ selectedValue, selectValue }}>
      {children}
    </PopupMenuSelectionGroupContext.Provider>
  );
}

interface PopupMenuSelectionItemProps {
  value: string;
  children: ReactNode;
  shortcut?: string;
  mnemonic?: string;
  disabled?: boolean;
  title?: string;
  onSelect?: () => void | Promise<void>;
}

export function PopupMenuSelectionItem({
  value,
  children,
  shortcut,
  mnemonic,
  disabled,
  title,
  onSelect,
}: PopupMenuSelectionItemProps) {
  const group = useContext(PopupMenuSelectionGroupContext);
  if (!group) {
    throw new Error("PopupMenuSelectionItem must be used inside PopupMenuSelectionGroup.");
  }

  return (
    <PopupMenuItem
      shortcut={shortcut}
      mnemonic={mnemonic}
      checked={group.selectedValue === value}
      indicator="dot"
      disabled={disabled}
      title={title}
      onSelect={() => {
        group.selectValue(value);
        return onSelect?.();
      }}
    >
      {children}
    </PopupMenuItem>
  );
}

interface PopupMenuSubmenuProps {
  label: ReactNode;
  children: ReactNode;
  open: boolean;
  disabled?: boolean;
  mnemonic?: string;
  menuClassName?: string;
  onOpenChange: (open: boolean) => void;
}

export function PopupMenuSubmenu({
  label,
  children,
  open,
  disabled,
  mnemonic,
  menuClassName,
  onOpenChange,
}: PopupMenuSubmenuProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const updateAnchor = useCallback(() => {
    const next = hostRef.current?.getBoundingClientRect() ?? null;
    setAnchor((current) =>
      current &&
      next &&
      current.left === next.left &&
      current.top === next.top &&
      current.width === next.width &&
      current.height === next.height
        ? current
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    return () => {
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
    };
  }, [open, updateAnchor]);

  return (
    <div ref={hostRef} className="popup-menu-submenu">
      <PopupMenuItem
        submenu
        disabled={disabled}
        mnemonic={mnemonic}
        onSelect={() => onOpenChange(!open)}
      >
        {label}
      </PopupMenuItem>
      {open &&
        anchor &&
        createPortal(
          <PopupMenu
            ariaLabel={typeof label === "string" ? label : undefined}
            className={menuClassName}
            submenuAnchor={anchor}
            style={{ position: "fixed", left: anchor.right - 4, top: anchor.top - 3 }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {children}
          </PopupMenu>,
          document.body,
        )}
    </div>
  );
}
