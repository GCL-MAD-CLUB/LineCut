import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { PopupMenu, useCloseOnOutsidePointer } from "../PopupMenu";

export function ImportMenu({
  anchor,
  label,
  onClose,
  children,
  light = false,
}: {
  anchor: { x: number; y: number };
  label: string;
  onClose: () => void;
  children: ReactNode;
  light?: boolean;
}) {
  useCloseOnOutsidePointer(true, onClose, { ignorePopupMenuTargets: true });
  return createPortal(
    <PopupMenu
      className={`import-popup ${light ? "is-light" : "is-dark"}`}
      ariaLabel={label}
      contextMenuAnchor={anchor}
      style={{ position: "fixed", left: anchor.x, top: anchor.y, zIndex: 200 }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </PopupMenu>,
    document.body,
  );
}
