export type AnnotationShortcutAction =
  | { kind: "flag"; value: "retained" | "excluded" | "none" }
  | { kind: "rating"; value: number }
  | { kind: "ratingDelta"; value: -1 | 1 }
  | { kind: "colorLabel"; value: "red" | "yellow" | "green" | "blue" };

const shortcutByCode: Record<string, AnnotationShortcutAction> = {
  KeyP: { kind: "flag", value: "retained" },
  KeyX: { kind: "flag", value: "excluded" },
  KeyU: { kind: "flag", value: "none" },
  Digit0: { kind: "rating", value: 0 },
  Digit1: { kind: "rating", value: 1 },
  Digit2: { kind: "rating", value: 2 },
  Digit3: { kind: "rating", value: 3 },
  Digit4: { kind: "rating", value: 4 },
  Digit5: { kind: "rating", value: 5 },
  Digit6: { kind: "colorLabel", value: "red" },
  Digit7: { kind: "colorLabel", value: "yellow" },
  Digit8: { kind: "colorLabel", value: "green" },
  Digit9: { kind: "colorLabel", value: "blue" },
  Numpad0: { kind: "rating", value: 0 },
  Numpad1: { kind: "rating", value: 1 },
  Numpad2: { kind: "rating", value: 2 },
  Numpad3: { kind: "rating", value: 3 },
  Numpad4: { kind: "rating", value: 4 },
  Numpad5: { kind: "rating", value: 5 },
  Numpad6: { kind: "colorLabel", value: "red" },
  Numpad7: { kind: "colorLabel", value: "yellow" },
  Numpad8: { kind: "colorLabel", value: "green" },
  Numpad9: { kind: "colorLabel", value: "blue" },
  BracketLeft: { kind: "ratingDelta", value: -1 },
  BracketRight: { kind: "ratingDelta", value: 1 },
};

const shortcutByKey: Record<string, AnnotationShortcutAction> = {
  p: shortcutByCode.KeyP,
  x: shortcutByCode.KeyX,
  u: shortcutByCode.KeyU,
  "0": shortcutByCode.Digit0,
  "1": shortcutByCode.Digit1,
  "2": shortcutByCode.Digit2,
  "3": shortcutByCode.Digit3,
  "4": shortcutByCode.Digit4,
  "5": shortcutByCode.Digit5,
  "6": shortcutByCode.Digit6,
  "7": shortcutByCode.Digit7,
  "8": shortcutByCode.Digit8,
  "9": shortcutByCode.Digit9,
  "[": shortcutByCode.BracketLeft,
  "{": shortcutByCode.BracketLeft,
  "]": shortcutByCode.BracketRight,
  "}": shortcutByCode.BracketRight,
};

export function annotationShortcutAction(event: KeyboardEvent) {
  return shortcutByCode[event.code] ?? shortcutByKey[event.key.toLocaleLowerCase()] ?? null;
}

export function annotationShortcutAutoAdvances(event: KeyboardEvent) {
  return event.shiftKey || event.getModifierState("CapsLock");
}
