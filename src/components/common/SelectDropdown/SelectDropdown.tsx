import { ChevronDown } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./SelectDropdown.css";

export type SelectDropdownItem<T extends string = string> =
  | {
      type: "option";
      value: T;
      label: string;
    }
  | {
      type: "separator";
    };

interface SelectDropdownProps<T extends string> {
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  items: Array<SelectDropdownItem<T>>;
  menuClassName?: string;
  menuId?: string;
  menuMinWidth?: number;
  menuWidth?: "content" | "trigger";
  placement?: "auto" | "bottom" | "top";
  selectedLabel?: string;
  selectedValues?: readonly T[];
  showCheck?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: string;
  trigger?: ReactNode;
  triggerElement?: ReactNode;
  value: T;
  onChange: (value: T) => void;
}

export function selectDropdownItems<T extends string>(
  options: Array<readonly [T, string]>,
): Array<SelectDropdownItem<T>> {
  return options.map(([value, label]) => ({
    type: "option",
    value,
    label,
  }));
}

function isOptionItem<T extends string>(
  item: SelectDropdownItem<T>,
): item is Extract<SelectDropdownItem<T>, { type: "option" }> {
  return item.type === "option";
}

export function SelectDropdown<T extends string>({
  ariaLabel,
  className,
  disabled = false,
  items,
  menuClassName,
  menuId,
  menuMinWidth = 0,
  menuWidth = "trigger",
  placement = "auto",
  selectedLabel,
  selectedValues,
  showCheck = true,
  open: controlledOpen,
  onOpenChange,
  title,
  trigger,
  triggerElement,
  value,
  onChange,
}: SelectDropdownProps<T>) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  function setOpen(next: boolean) {
    setInternalOpen(next);
    onOpenChange?.(next);
  }
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedItem = items.filter(isOptionItem).find((item) => item.value === value);
  const resolvedSelectedLabel = selectedLabel ?? selectedItem?.label ?? value;
  const resolvedSelectedValues = new Set(selectedValues ?? [value]);

  function updateMenuPosition() {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const rect = root.getBoundingClientRect();
    const gap = 4;
    const menuHeight = menuRef.current?.offsetHeight ?? 0;
    const measuredMenuWidth = menuRef.current?.getBoundingClientRect().width ?? rect.width;
    const shouldOpenUp =
      placement === "top" ||
      (placement === "auto" &&
        menuHeight > 0 &&
        rect.bottom + gap + menuHeight > window.innerHeight &&
        rect.top - gap - menuHeight > 0);
    const preferredTop = shouldOpenUp ? rect.top - gap - menuHeight : rect.bottom + gap;
    // Keep the (possibly max-height-clamped) menu box fully inside the viewport
    // even when neither direction has enough room for the whole list.
    const viewportLimit = Math.max(4, window.innerHeight - menuHeight - gap);
    const top = Math.min(Math.max(4, preferredTop), viewportLimit);
    const left =
      menuWidth === "content"
        ? Math.max(4, Math.min(rect.left, window.innerWidth - measuredMenuWidth - 4))
        : rect.left;
    setMenuStyle({
      left: `${left}px`,
      top: `${top}px`,
      width: menuWidth === "content" ? "max-content" : `${rect.width}px`,
      minWidth: menuWidth === "content" ? `${Math.max(rect.width, menuMinWidth)}px` : undefined,
      maxWidth: menuWidth === "content" ? "calc(100vw - 8px)" : undefined,
    });
  }

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    updateMenuPosition();
    const frame = window.requestAnimationFrame(updateMenuPosition);
    return () => window.cancelAnimationFrame(frame);
  }, [open, items, menuMinWidth, menuWidth, placement]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    const updatePosition = () => updateMenuPosition();
    const closeOnBlur = () => setOpen(false);
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [open]);

  function selectValue(nextValue: T) {
    onChange(nextValue);
    setOpen(false);
  }

  const menu = (
    <div
      ref={menuRef}
      id={menuId}
      className={`select-dropdown-menu ${showCheck ? "" : "without-checks"} ${menuClassName ?? ""}`}
      role="listbox"
      aria-label={ariaLabel}
      aria-multiselectable={selectedValues ? true : undefined}
      style={menuStyle}
    >
      {items.map((item, index) =>
        item.type === "separator" ? (
          <div key={`separator-${index}`} className="select-dropdown-separator" />
        ) : (
          <button
            key={item.value}
            id={menuId ? `${menuId}-${index}` : undefined}
            type="button"
            className={`select-dropdown-option ${resolvedSelectedValues.has(item.value) ? "selected" : ""}`}
            title={item.label}
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => selectValue(item.value)}
            role="option"
            aria-selected={resolvedSelectedValues.has(item.value)}
          >
            {showCheck && (
              <span className="select-dropdown-check">
                {resolvedSelectedValues.has(item.value) ? "✓" : ""}
              </span>
            )}
            <span className="select-dropdown-option-label">{item.label}</span>
          </button>
        ),
      )}
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={`select-dropdown ${open ? "open" : ""} ${disabled ? "disabled" : ""} ${className ?? ""}`}
    >
      {triggerElement ?? (
        <button
          type="button"
          className="select-dropdown-trigger"
          aria-label={ariaLabel}
          aria-expanded={open}
          disabled={disabled}
          title={title ?? resolvedSelectedLabel}
          onClick={() => setOpen(!open)}
        >
          {trigger ?? (
            <>
              <span>{resolvedSelectedLabel}</span>
              <ChevronDown size={18} />
            </>
          )}
        </button>
      )}
      {open && !disabled && createPortal(menu, document.body)}
    </div>
  );
}
