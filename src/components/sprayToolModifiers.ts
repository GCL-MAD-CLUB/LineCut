import { useEffect, useState } from "react";

function isAltKeyEvent(event: KeyboardEvent) {
  return event.key === "Alt" || event.code === "AltLeft" || event.code === "AltRight";
}

function isShiftKeyEvent(event: KeyboardEvent) {
  return event.key === "Shift" || event.code === "ShiftLeft" || event.code === "ShiftRight";
}

const sprayEraserSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24"><path d="m4.1 15.8 9.9-9.9a2 2 0 0 1 2.8 0l2.3 2.3a2 2 0 0 1 0 2.8l-8.9 8.9H6.9l-2.8-2.8a.9.9 0 0 1 0-1.3Z" fill="#d8d8d8" stroke="#202020" stroke-width="1.25" stroke-linejoin="round"/><path d="m4.5 15.4 4.1 4.1h1.6l3.8-3.8-4.8-4.8-4.7 4.5Z" fill="#ef9ca8" stroke="#202020" stroke-width="1.25" stroke-linejoin="round"/><path d="M3.5 21h17" stroke="#d8d8d8" stroke-width="1.25" stroke-linecap="round"/></svg>`;

export const sprayEraserCursor = `url("data:image/svg+xml,${encodeURIComponent(
  sprayEraserSvg,
)}") 4 17, crosshair`;

export function useSprayToolModifiers(active: boolean, blockShift: boolean) {
  const [altPressed, setAltPressed] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isAltKeyEvent(event) || event.altKey) {
        setAltPressed(true);
        if (active) {
          event.preventDefault();
        }
      }
      if (active && blockShift && (isShiftKeyEvent(event) || event.shiftKey)) {
        event.preventDefault();
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (isAltKeyEvent(event)) {
        setAltPressed(false);
        if (active) {
          event.preventDefault();
        }
      }
      if (active && blockShift && isShiftKeyEvent(event)) {
        event.preventDefault();
      }
    };
    const clearModifiers = () => setAltPressed(false);

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", clearModifiers);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", clearModifiers);
    };
  }, [active, blockShift]);

  return active && altPressed;
}
