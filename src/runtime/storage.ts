export type AppStorage = Pick<Storage, "getItem">;

/** Read compatible keys only from this application's own (possibly copied) profile. */
export function readAppStorage(key: string, storage: AppStorage = window.localStorage) {
  const current = storage.getItem(key);
  if (current !== null || !key.startsWith("locution-pro:")) return current;
  return storage.getItem(`linecut:${key.slice("locution-pro:".length)}`);
}
