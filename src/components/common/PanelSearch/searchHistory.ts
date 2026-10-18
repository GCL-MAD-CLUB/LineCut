export type SearchHistoryKind = "subtitle" | "storyboard";

const historyLimit = 6;
type HistoryStorage = Pick<Storage, "getItem" | "setItem">;

function normalizeHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(entries)].slice(0, historyLimit);
}

export function readSearchHistory(kind: SearchHistoryKind, storage?: HistoryStorage): string[] {
  try {
    const stored = (storage ?? window.localStorage).getItem(`linecut:search-history:${kind}`);
    return stored ? normalizeHistory(JSON.parse(stored)) : [];
  } catch {
    // History is optional; unavailable storage must not interrupt searching.
    return [];
  }
}

export function rememberSearch(
  kind: SearchHistoryKind,
  query: string,
  storage?: HistoryStorage,
): string[] {
  const history = readSearchHistory(kind, storage);
  if (!query.trim()) return history;
  const next = normalizeHistory([query, ...history]);
  try {
    (storage ?? window.localStorage).setItem(
      `linecut:search-history:${kind}`,
      JSON.stringify(next),
    );
  } catch {
    // Keep the current interaction usable even if persistence is unavailable.
  }
  return next;
}

export function filterSearchHistory(history: readonly string[], query: string): string[] {
  const prefix = query.trim().toLocaleLowerCase();
  return history.filter((entry) => entry.toLocaleLowerCase().startsWith(prefix));
}
