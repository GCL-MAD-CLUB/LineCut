import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invokeCommand, runOperation } from "../../errors";
import { isTauriRuntime } from "../../tauriRuntime";
import {
  mediaKind,
  pathKey,
  type ImportDirectory,
  type ImportFilter,
  type ImportLocation,
  type ImportSettings,
} from "./importBrowserModel";
import {
  defaultImportSettings,
  loadImportBrowserConfig,
  saveImportBrowserFavorites,
  saveImportBrowserLastDirectory,
  saveImportSettings,
} from "./importBrowserConfig";

export function useImportBrowser() {
  const [locations, setLocations] = useState<ImportLocation[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [settings, setSettings] = useState<ImportSettings>(defaultImportSettings);
  const [configLoaded, setConfigLoaded] = useState(!isTauriRuntime());
  const [listing, setListing] = useState<ImportDirectory | null>(null);
  const [loading, setLoading] = useState(isTauriRuntime());
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ImportFilter>("all");
  const [showHidden, setShowHidden] = useState(false);
  const [sort, setSort] = useState<"name" | "created">("name");
  const [descending, setDescending] = useState(false);
  const request = useRef(0);
  const favoritesRef = useRef<string[]>([]);
  const navigate = useCallback(async (directory: string) => {
    if (!directory || !isTauriRuntime()) return false;
    const id = ++request.current;
    setLoading(true);
    setError("");
    const outcome = await runOperation("media.import", () =>
      invokeCommand<ImportDirectory>("list_import_directory", { directory }),
    );
    if (id !== request.current) return false;
    setLoading(false);
    if (outcome.status === "success") {
      setListing(outcome.value);
      setQuery("");
      void saveImportBrowserLastDirectory(outcome.value.directory);
      return true;
    }
    setError("无法读取此文件夹，请检查路径和访问权限后重试。");
    return false;
  }, []);
  const toggleFavorite = useCallback((directory: string) => {
    if (!directory) return;
    const key = pathKey(directory);
    const exists = favoritesRef.current.some((path) => pathKey(path) === key);
    const next = exists
      ? favoritesRef.current.filter((path) => pathKey(path) !== key)
      : [...favoritesRef.current, directory];
    favoritesRef.current = next;
    setFavorites(next);
    void saveImportBrowserFavorites(next);
  }, []);
  const updateSettings = useCallback((next: ImportSettings) => {
    setSettings(next);
    void saveImportSettings(next);
  }, []);
  useEffect(() => {
    let live = true;
    if (isTauriRuntime())
      void (async () => {
        const [result, config] = await Promise.all([
          runOperation("media.import", () =>
            invokeCommand<ImportLocation[]>("list_import_locations"),
          ),
          loadImportBrowserConfig(),
        ]);
        if (!live) return;
        const seen = new Set<string>();
        const restoredFavorites = config.favorites.filter((path) => {
          const key = pathKey(path);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        favoritesRef.current = restoredFavorites;
        setFavorites(restoredFavorites);
        setSettings(config.settings);
        setConfigLoaded(true);
        if (result.status === "success") {
          setLocations(result.value);
          const first = result.value[0];
          const restored = config.lastDirectory ? await navigate(config.lastDirectory) : false;
          if (!live) return;
          if (!restored && first) await navigate(first.path);
          else if (!restored) setLoading(false);
        } else {
          setError("无法读取本地位置。");
          setLoading(false);
        }
      })();
    return () => {
      live = false;
      request.current += 1;
    };
  }, [navigate]);
  const entries = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return (listing?.entries ?? [])
      .filter((entry) => {
        const kind = mediaKind(entry.path);
        return (
          (showHidden || !entry.is_hidden) &&
          (entry.is_directory || (kind && (filter === "all" || kind === filter))) &&
          (!search || entry.name.toLocaleLowerCase().includes(search))
        );
      })
      .sort(
        (a, b) =>
          Number(b.is_directory) - Number(a.is_directory) ||
          (descending ? -1 : 1) *
            ((sort === "created" ? (a.created_at ?? 0) - (b.created_at ?? 0) : 0) ||
              a.name.localeCompare(b.name, "zh-CN", { numeric: true })),
      );
  }, [listing, query, filter, showHidden, sort, descending]);
  return {
    locations,
    favorites,
    settings,
    updateSettings,
    configLoaded,
    listing,
    entries,
    loading,
    error,
    navigate,
    toggleFavorite,
    query,
    setQuery,
    filter,
    setFilter,
    showHidden,
    setShowHidden,
    sort,
    setSort,
    descending,
    setDescending,
  };
}
