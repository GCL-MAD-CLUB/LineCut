import { useEffect, useMemo, useRef, useState } from "react";
import { invokeCommand, runOperation } from "../../errors";
import { pathKey, type ImportDirectory, type ImportEntry } from "./importBrowserModel";
import {
  collectSelectionFiles,
  scanImportFolder,
  type ImportSelectionItem,
} from "./importFolderScan";

// A shared bound keeps selecting many folders from flooding the filesystem.
let activeReads = 0;
const waitingReads: Array<() => void> = [];
async function readFolder(path: string, signal: AbortSignal) {
  if (activeReads >= 2) await new Promise<void>((resolve) => waitingReads.push(resolve));
  activeReads += 1;
  try {
    if (signal.aborted) return null;
    const outcome = await runOperation("media.scan", () =>
      invokeCommand<ImportDirectory>("list_import_directory", { directory: path }),
    );
    return outcome.status === "success" ? outcome.value : null;
  } finally {
    activeReads -= 1;
    waitingReads.shift()?.();
  }
}

export function useImportSelection(imported: Set<string>) {
  const [rawItems, setItems] = useState<ImportSelectionItem[]>([]);
  const jobs = useRef(new Map<string, AbortController>());
  const entries = useRef(new Map<string, ImportEntry>());
  useEffect(
    () => () => {
      jobs.current.forEach((job) => job.abort());
      jobs.current.clear();
    },
    [],
  );

  function scan(entry: ImportEntry) {
    const key = pathKey(entry.path);
    jobs.current.get(key)?.abort();
    const controller = new AbortController();
    jobs.current.set(key, controller);
    setItems((current) =>
      current.map((item) =>
        pathKey(item.entry.path) === key
          ? { ...item, files: [], unreadable: [], scanning: true }
          : item,
      ),
    );
    void scanImportFolder(
      entry.path,
      (path) => readFolder(path, controller.signal),
      controller.signal,
      (files, unreadable) => {
        if (controller.signal.aborted) return;
        setItems((current) =>
          current.map((item) =>
            pathKey(item.entry.path) === key ? { ...item, files, unreadable } : item,
          ),
        );
      },
    ).then(() => {
      if (controller.signal.aborted) return;
      jobs.current.delete(key);
      setItems((current) =>
        current.map((item) =>
          pathKey(item.entry.path) === key ? { ...item, scanning: false } : item,
        ),
      );
    });
  }
  function add(additions: ImportEntry[]) {
    const next: ImportSelectionItem[] = [];
    for (const entry of additions) {
      const key = pathKey(entry.path);
      if (entries.current.has(key) || (!entry.is_directory && imported.has(key))) continue;
      entries.current.set(key, entry);
      next.push({
        entry,
        files: entry.is_directory ? [] : [entry],
        scanning: entry.is_directory,
        unreadable: [],
      });
    }
    setItems((current) => [...current, ...next]);
    next.forEach((item) => {
      if (item.entry.is_directory) scan(item.entry);
    });
  }
  function removeMany(paths: string[]) {
    const keys = new Set(paths.map(pathKey));
    keys.forEach((key) => {
      jobs.current.get(key)?.abort();
      jobs.current.delete(key);
      entries.current.delete(key);
    });
    setItems((current) => current.filter((item) => !keys.has(pathKey(item.entry.path))));
  }
  function remove(path: string) {
    removeMany([path]);
  }
  function clear() {
    jobs.current.forEach((job) => job.abort());
    jobs.current.clear();
    entries.current.clear();
    setItems([]);
  }
  function toggle(entry: ImportEntry) {
    if (entries.current.has(pathKey(entry.path))) remove(entry.path);
    else add([entry]);
  }
  function retry(path: string) {
    const entry = entries.current.get(pathKey(path));
    if (entry?.is_directory) scan(entry);
  }
  const items = useMemo(
    () =>
      rawItems.map((item) => ({
        ...item,
        files: item.files.filter((entry) => !imported.has(pathKey(entry.path))),
      })),
    [rawItems, imported],
  );
  const files = useMemo(() => collectSelectionFiles(items, imported), [items, imported]);
  const selected = useMemo(() => new Set(items.map((item) => pathKey(item.entry.path))), [items]);
  return {
    items,
    files,
    selected,
    scanning: items.some((item) => item.scanning),
    hasErrors: items.some((item) => item.unreadable.length > 0),
    add,
    remove,
    removeMany,
    clear,
    toggle,
    retry,
    retainFiles: (remaining: ImportEntry[]) => {
      clear();
      add(remaining);
    },
  };
}
