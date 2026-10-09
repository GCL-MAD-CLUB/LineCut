import { Channel } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { clientError, invokeCommand, runOperation } from "../../errors";

export interface SemanticSubtitle {
  id: string;
  text: string;
}
interface SemanticProgress {
  phase: "indexing" | "searching";
  completed: number;
  total: number;
}
interface SemanticMatch {
  id: string;
  similarity: number;
}
interface SearchResult {
  key: string;
  scores: ReadonlyMap<string, number>;
  status: "ready" | "failed";
}
const emptyScores: ReadonlyMap<string, number> = new Map();

export function useSubtitleSemanticSearch(
  enabled: boolean,
  query: string,
  subtitles: readonly SemanticSubtitle[],
) {
  // Only text and row identity invalidate the request, not playback or annotations.
  const key = useMemo(
    () =>
      enabled && query.trim() && subtitles.length ? JSON.stringify([query.trim(), subtitles]) : "",
    [enabled, query, subtitles],
  );
  const [result, setResult] = useState<SearchResult | null>(null);
  const [progress, setProgress] = useState<(SemanticProgress & { key: string }) | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let started = false;
    const taskId = `subtitle-semantic:${crypto.randomUUID()}`;
    const cancel = () => {
      void runOperation("task.cancel", () => invokeCommand("cancel_task", { taskId }));
    };
    const timer = window.setTimeout(() => {
      started = true;
      const [searchQuery, items] = JSON.parse(key) as [string, SemanticSubtitle[]];
      const onProgress = new Channel<SemanticProgress>((next) => {
        if (cancelled) {
          cancel();
          return;
        }
        setProgress({ ...next, key });
      });
      void (async () => {
        const outcome = await runOperation("subtitle.semanticSearch", async () => {
          try {
            const matches = await invokeCommand<SemanticMatch[]>("search_subtitles_semantic", {
              query: searchQuery,
              subtitles: items,
              taskId,
              onProgress,
            });
            if (cancelled) throw clientError("BROWSER_ABORTED", "Superseded semantic search");
            return matches;
          } catch (error) {
            if (cancelled) throw clientError("BROWSER_ABORTED", "Superseded semantic search");
            // invokeCommand has already normalized this boundary error.
            return Promise.reject(error);
          }
        });
        if (cancelled) return;
        if (outcome.status === "success") {
          setResult({
            key,
            scores: new Map(outcome.value.map((match) => [match.id, match.similarity])),
            status: "ready",
          });
        } else if (outcome.status === "failed") {
          setResult({ key, scores: emptyScores, status: "failed" });
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (started) cancel();
    };
  }, [key, retry]);
  const current = key && result?.key === key ? result : null;
  return useMemo(
    () => ({
      scores: current?.scores ?? emptyScores,
      status: !key ? "idle" : (current?.status ?? "pending"),
      progress: progress?.key === key ? progress : null,
      retry: () => {
        setResult(null);
        setProgress(null);
        setRetry((value) => value + 1);
      },
    }),
    [key, current, progress],
  );
}
