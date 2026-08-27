import { useEffect, useState } from "react";

function isAltKeyEvent(event: KeyboardEvent) {
  return event.key === "Alt" || event.code === "AltLeft" || event.code === "AltRight";
}

function isShiftKeyEvent(event: KeyboardEvent) {
  return event.key === "Shift" || event.code === "ShiftLeft" || event.code === "ShiftRight";
}

const sprayEraserSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24"><path d="m4.1 15.8 9.9-9.9a2 2 0 0 1 2.8 0l2.3 2.3a2 2 0 0 1 0 2.8l-8.9 8.9H6.9l-2.8-2.8a.9.9 0 0 1 0-1.3Z" fill="#d8d8d8" stroke="#202020" stroke-width="1.25" stroke-linejoin="round"/><path d="m4.5 15.4 4.1 4.1h1.6l3.8-3.8-4.8-4.8-4.7 4.5Z" fill="#ef9ca8" stroke="#202020" stroke-width="1.25" stroke-linejoin="round"/><path d="M3.5 21h17" stroke="#d8d8d8" stroke-width="1.25" stroke-linecap="round"/></svg>`;
const sprayEyedropperPaths = `<path d="m14.8 4.7 1.8-1.8a2.8 2.8 0 0 1 4 4l-1.8 1.8 1.1 1.1-2.4 2.4-5.7-5.7 2.4-2.4 1.1 1.1Z" fill="#d8d8d8" stroke="#202020" stroke-width="1.2" stroke-linejoin="round"/><path d="m13.5 7.8 2.7 2.7-8.8 8.8-3.7 1 1-3.7 8.8-8.8Z" fill="#f1f1f1" stroke="#202020" stroke-width="1.2" stroke-linejoin="round"/><path d="m4.7 16.6 2.7 2.7" stroke="#777" stroke-width="1"/>`;
const sprayEyedropperSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24">${sprayEyedropperPaths}</svg>`;

function sprayEyedropperActionSvg(action: "add" | "remove") {
  const actionPath = action === "add" ? "M21 12.5v7M17.5 16h7" : "M17.5 16h7";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">${sprayEyedropperPaths}<path d="${actionPath}" fill="none" stroke="#202020" stroke-width="3.5" stroke-linecap="round"/><path d="${actionPath}" fill="none" stroke="#f1f1f1" stroke-width="1.5" stroke-linecap="round"/></svg>`;
}

export const sprayEraserCursor = `url("data:image/svg+xml,${encodeURIComponent(
  sprayEraserSvg,
)}") 4 17, crosshair`;
export const sprayEyedropperImageUrl = `data:image/svg+xml,${encodeURIComponent(
  sprayEyedropperSvg,
)}`;
export const sprayEyedropperCursor = `url("${sprayEyedropperImageUrl}") 4 18, crosshair`;
export const sprayEyedropperAddCursor = `url("data:image/svg+xml,${encodeURIComponent(
  sprayEyedropperActionSvg("add"),
)}") 4 18, crosshair`;
export const sprayEyedropperRemoveCursor = `url("data:image/svg+xml,${encodeURIComponent(
  sprayEyedropperActionSvg("remove"),
)}") 4 18, crosshair`;

export function useSprayToolModifiers(active: boolean, blockShift: boolean) {
  const [altPressed, setAltPressed] = useState(false);
  const [shiftPressed, setShiftPressed] = useState(false);

  useEffect(() => {
    if (!active) {
      setAltPressed(false);
      setShiftPressed(false);
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isAltKeyEvent(event) || event.altKey) {
        setAltPressed(true);
        event.preventDefault();
      }
      if (blockShift && (isShiftKeyEvent(event) || event.shiftKey)) {
        setShiftPressed(true);
        event.preventDefault();
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (isAltKeyEvent(event)) {
        setAltPressed(false);
        event.preventDefault();
      }
      if (isShiftKeyEvent(event)) {
        setShiftPressed(false);
        if (blockShift) {
          event.preventDefault();
        }
      }
    };
    const clearModifiers = () => {
      setAltPressed(false);
      setShiftPressed(false);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", clearModifiers);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", clearModifiers);
    };
  }, [active, blockShift]);

  return {
    altPressed: active && altPressed,
    shiftPressed: active && blockShift && shiftPressed,
  };
}
