import { ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
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
  placement?: "auto" | "bottom" | "top";
  selectedLabel?: string;
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
  placement = "auto",
  selectedLabel,
  value,
  onChange,
}: SelectDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedItem = items.filter(isOptionItem).find((item) => item.value === value);
  const resolvedSelectedLabel = selectedLabel ?? selectedItem?.label ?? value;

  function updateMenuPosition() {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const rect = root.getBoundingClientRect();
    const gap = 8;
    const menuHeight = menuRef.current?.offsetHeight ?? 0;
    const shouldOpenUp =
      placement === "top" ||
      (placement === "auto" &&
        menuHeight > 0 &&
        rect.bottom + gap + menuHeight > window.innerHeight &&
        rect.top - gap - menuHeight > 0);
    const top = shouldOpenUp ? rect.top - gap - menuHeight : rect.bottom + gap;
    setMenuStyle({
      left: `${rect.left}px`,
      top: `${Math.max(4, top)}px`,
      width: `${rect.width}px`,
    });
  }

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    updateMenuPosition();
    const frame = window.requestAnimationFrame(updateMenuPosition);
    return () => window.cancelAnimationFrame(frame);
  }, [open, items, placement]);

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
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  function selectValue(nextValue: T) {
    onChange(nextValue);
    setOpen(false);
  }

  const menu = (
    <div ref={menuRef} className={`select-dropdown-menu ${menuClassName ?? ""}`} role="listbox" style={menuStyle}>
      {items.map((item, index) =>
        item.type === "separator" ? (
          <div key={`separator-${index}`} className="select-dropdown-separator" />
        ) : (
          <button
            key={item.value}
            type="button"
            className={`select-dropdown-option ${item.value === value ? "selected" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => selectValue(item.value)}
            role="option"
            aria-selected={item.value === value}
          >
            <span className="select-dropdown-check">{item.value === value ? "✓" : ""}</span>
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
      <button
        type="button"
        className="select-dropdown-trigger"
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{resolvedSelectedLabel}</span>
        <ChevronDown size={18} />
      </button>
      {open && !disabled && createPortal(menu, document.body)}
    </div>
  );
}
