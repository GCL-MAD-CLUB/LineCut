import { Check, ChevronRight } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
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
      : contextMenuAnchor?.x ?? rect.left - current.translateX;
    const anchorTop = submenuAnchor
      ? submenuAnchor.top - 3
      : contextMenuAnchor?.y ?? rect.top - current.translateY;
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
  checked?: boolean;
  disabled?: boolean;
  submenu?: boolean;
  title?: string;
  onSelect?: () => void | Promise<void>;
}

export function PopupMenuItem({
  children,
  shortcut,
  checked,
  disabled,
  submenu,
  title,
  onSelect,
}: PopupMenuItemProps) {
  return (
    <button
      type="button"
      className="popup-menu-item"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => void onSelect?.()}
    >
      <span className="popup-menu-check">{checked === true && <Check aria-hidden="true" />}</span>
      <span className="popup-menu-label">{children}</span>
      {shortcut ? <kbd>{shortcut}</kbd> : <span />}
      {submenu && <ChevronRight className="popup-menu-submenu-icon" aria-hidden="true" />}
    </button>
  );
}

export function PopupMenuSeparator() {
  return <div className="popup-menu-separator" role="separator" />;
}

interface PopupMenuSubmenuProps {
  label: ReactNode;
  children: ReactNode;
  open: boolean;
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PopupMenuSubmenu({
  label,
  children,
  open,
  disabled,
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
      <PopupMenuItem submenu disabled={disabled} onSelect={() => onOpenChange(!open)}>
        {label}
      </PopupMenuItem>
      {open &&
        anchor &&
        createPortal(
          <PopupMenu
            ariaLabel={typeof label === "string" ? label : undefined}
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
