import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invokeCommand, runOperation } from "../../errors";
import { isTauriRuntime } from "../../tauriRuntime";
import {
  mediaKind,
  type ImportDirectory,
  type ImportFilter,
  type ImportLocation,
} from "./importBrowserModel";

export function useImportBrowser() {
  const [locations, setLocations] = useState<ImportLocation[]>([]);
  const [listing, setListing] = useState<ImportDirectory | null>(null);
  const [loading, setLoading] = useState(isTauriRuntime());
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ImportFilter>("all");
  const [showHidden, setShowHidden] = useState(false);
  const [sort, setSort] = useState<"name" | "created">("name");
  const [descending, setDescending] = useState(false);
  const request = useRef(0);
  const navigate = useCallback(async (directory: string) => {
    if (!directory || !isTauriRuntime()) return;
    const id = ++request.current;
    setLoading(true);
    setError("");
    const outcome = await runOperation("media.import", () =>
      invokeCommand<ImportDirectory>("list_import_directory", { directory }),
    );
    if (id !== request.current) return;
    setLoading(false);
    if (outcome.status === "success") {
      setListing(outcome.value);
      setQuery("");
    } else setError("无法读取此文件夹，请检查路径和访问权限后重试。");
  }, []);
  useEffect(() => {
    let live = true;
    if (isTauriRuntime())
      void (async () => {
        const result = await runOperation("media.import", () =>
          invokeCommand<ImportLocation[]>("list_import_locations"),
        );
        if (!live) return;
        if (result.status === "success") {
          setLocations(result.value);
          const first = result.value[0];
          if (first) await navigate(first.path);
          else setLoading(false);
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
    listing,
    entries,
    loading,
    error,
    navigate,
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
