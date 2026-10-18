export type AppStorage = Pick<Storage, "getItem" | "setItem">;

/** Read the current namespace, copying an old value only when the new key is absent. */
export function readAppStorage(key: string, storage: AppStorage = window.localStorage) {
  const current = storage.getItem(key);
  if (current !== null || !key.startsWith("locution-pro:")) return current;
  const legacy = storage.getItem(`linecut:${key.slice("locution-pro:".length)}`);
  if (legacy !== null) {
    try {
      storage.setItem(key, legacy);
    } catch {
      // A quota failure must not hide the old value; retry migration on the next read.
    }
  }
  return legacy;
}
