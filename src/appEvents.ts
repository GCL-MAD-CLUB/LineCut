import { useEffect, useRef } from "react";

interface AppEventMap {
  "monitor:seek": { timeUs: number };
}

export function emitAppEvent<K extends keyof AppEventMap>(
  type: K,
  ...detail: AppEventMap[K] extends undefined ? [] : [AppEventMap[K]]
) {
  window.dispatchEvent(new CustomEvent(type, { detail: detail[0] }));
}

export function useAppEvent<K extends keyof AppEventMap>(
  type: K,
  handler: (detail: AppEventMap[K]) => void,
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (event: Event) => {
      try {
        handlerRef.current((event as CustomEvent<AppEventMap[K]>).detail);
      } catch (error) {
        console.error(`AppEvent handler failed for "${String(type)}":`, error);
      }
    };
    window.addEventListener(type, listener);
    return () => window.removeEventListener(type, listener);
  }, [type]);
}
