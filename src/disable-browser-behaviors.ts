function isDevToolsShortcut(event: KeyboardEvent): boolean {
  const key = event.key;
  const ctrl = event.ctrlKey;
  const shift = event.shiftKey;
  const alt = event.altKey;
  const meta = event.metaKey;

  // F12
  if (key === "F12") {
    return true;
  }

  // Ctrl/Cmd + Shift + I / J / C
  if ((ctrl || meta) && shift) {
    if (["i", "I", "j", "J", "c", "C"].includes(key)) {
      return true;
    }
  }

  // Ctrl/Cmd + U（查看源代码）
  if ((ctrl || meta) && (key === "u" || key === "U")) {
    return true;
  }

  // Ctrl/Cmd + Shift + K（Firefox 控制台）
  if ((ctrl || meta) && shift && (key === "k" || key === "K")) {
    return true;
  }

  // Ctrl/Cmd + Alt + I（部分浏览器）
  if ((ctrl || meta) && alt && (key === "i" || key === "I")) {
    return true;
  }

  return false;
}

export function disableBrowserBehaviors(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.addEventListener(
    "contextmenu",
    (event) => {
      event.preventDefault();
    },
    { capture: true },
  );

  window.addEventListener(
    "keydown",
    (event) => {
      if (isDevToolsShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    { capture: true },
  );
}
