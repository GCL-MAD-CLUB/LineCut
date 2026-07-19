import { useEffect, useRef } from "react";
import { runOperation } from "./errors";

interface AppEventMap {
  "media:import": { paths?: string[]; folderId?: string };
  "media:copy": { instanceId: string };
  "media:paste": { instanceId: string };
  "media:clear": { instanceId: string };
  "media:duplicate": { instanceId: string };
  "media:select-all": { instanceId: string };
  "media:clear-selection": { instanceId: string };
  "monitor:seek": { timeUs: number; focusEndUs?: number; play?: boolean };
  "subtitle:select-all": undefined;
  "subtitle:clear-selection": undefined;
}

export function emitAppEvent<K extends keyof AppEventMap>(
  type: K,
  ...detail: AppEventMap[K] extends undefined ? [] : [AppEventMap[K]]
) {
  window.dispatchEvent(new CustomEvent(type, { detail: detail[0] }));
}

export function useAppEvent<K extends keyof AppEventMap>(
  type: K,
  handler: (detail: AppEventMap[K]) => void | Promise<void>,
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (event: Event) => {
      void runOperation(
        "app.event",
        async () => handlerRef.current((event as CustomEvent<AppEventMap[K]>).detail),
        {
          displayName: String(type),
        },
      );
    };
    window.addEventListener(type, listener);
    return () => window.removeEventListener(type, listener);
  }, [type]);
}
