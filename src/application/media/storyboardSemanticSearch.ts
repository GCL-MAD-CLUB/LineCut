import { publishSelectedFrames } from "./storyboardSelectedFrames";
import { Channel } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { invokeCommand, runOperation } from "../../errors";
import { createTaskProgress } from "../../systems/TaskSystem";
import { isTauriRuntime } from "../../platform/tauri/runtime";

export function useStoryboardSemanticSearchAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    void runOperation("storyboard.semanticAvailability", () =>
      invokeCommand<boolean>("storyboard_semantic_search_available"),
    ).then((outcome) => {
      if (active) setAvailable(outcome.status === "success" && outcome.value === true);
    });
    return () => {
      active = false;
    };
  }, []);
  return available;
}

export interface SemanticShot {
  id: string;
  assetId: string;
  fingerprint: string;
  startFrame: number;
  endFrame: number;
  source: string;
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
  version: number;
}
interface SearchState {
  enabled: boolean;
  query: string;
  scope: string;
  shots: readonly SemanticShot[];
  indexKey: string;
  requestKey: string;
  clearQuery: () => void;
}
interface IndexJob {
  scope: string;
  query: string;
  cancelled: boolean;
  listeners: Set<() => void>;
  promise: Promise<"ready" | "cancelled" | "failed">;
}
const emptyScores: ReadonlyMap<string, number> = new Map();
// Same scope and storyboard content share one native job across panel instances.
const indexJobs = new Map<string, IndexJob>();

function indexShots(state: SearchState): IndexJob {
  const existing = indexJobs.get(state.indexKey);
  if (existing) return existing;
  const job: IndexJob = {
    scope: state.scope,
    query: state.query,
    cancelled: false,
    listeners: new Set(),
    promise: Promise.resolve("ready"),
  };
  indexJobs.set(state.indexKey, job);
  const notify = () => {
    for (const listener of job.listeners) listener();
  };
  const taskId = `storyboard-semantic-index:${crypto.randomUUID()}`;
  job.promise = (async () => {
    const task = await createTaskProgress({
      operation: "storyboard.semanticIndex",
      resourceKey: state.scope,
      label: "正在选择分镜帧...",
      current: 0,
      total: 1,
      on_cancel: async () => {
        // A false return means cancellation preceded native registration.
        // Its initial progress message will retry cancellation in that case.
        await invokeCommand("cancel_task", { taskId });
        job.cancelled = true;
        notify();
      },
    });
    try {
      if (task.cancelled) {
        job.cancelled = true;
        notify();
        return "cancelled" as const;
      }
      const onProgress = new Channel<SemanticProgress>((progress) => {
        if (job.cancelled || task.cancelled) {
          void runOperation("task.cancel", () => invokeCommand("cancel_task", { taskId }));
          return;
        }
        task.update({
          label: `正在选择 ${progress.total} 条分镜帧...`,
          current: progress.total ? progress.completed / progress.total : 0,
        });
      });
      const selected = await invokeCommand<{ id: string; frames: number[] }[]>(
        "select_storyboard_frames",
        {
          shots: state.shots,
          taskId,
          onProgress,
        },
      );
      if (!job.cancelled && !task.cancelled) publishSelectedFrames(state.shots, selected);
      return job.cancelled || task.cancelled ? ("cancelled" as const) : ("ready" as const);
    } catch (error) {
      if (job.cancelled || task.cancelled) return "cancelled" as const;
      task.fail(error, { resourceKind: "media" });
      return "failed" as const;
    } finally {
      task.remove();
      indexJobs.delete(state.indexKey);
    }
  })();
  return job;
}

export function useStoryboardSemanticSearch(
  enabled: boolean,
  query: string,
  shots: readonly SemanticShot[],
  scope: string,
  clearQuery: () => void,
) {
  const indexKey = useMemo(() => JSON.stringify([scope, shots]), [scope, shots]);
  const requestKey = useMemo(
    () => (enabled && query.trim() && shots.length ? JSON.stringify([indexKey, query]) : ""),
    [enabled, query, indexKey, shots.length],
  );
  const latest = useRef<SearchState>({
    enabled,
    query,
    scope,
    shots,
    indexKey,
    requestKey,
    clearQuery,
  });
  latest.current = { enabled, query, scope, shots, indexKey, requestKey, clearQuery };
  const mounted = useRef(true);
  const busy = useRef(false);
  const indexed = useRef(new Set<string>());
  const cancelledRequest = useRef<string | null>(null);
  const completedRequest = useRef<string | null>(null);
  const version = useRef(0);
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<SearchResult | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (cancelledRequest.current !== requestKey) cancelledRequest.current = null;
    if (
      !requestKey ||
      busy.current ||
      completedRequest.current === requestKey ||
      cancelledRequest.current === requestKey
    )
      return;
    const timer = window.setTimeout(() => {
      busy.current = true;
      void (async () => {
        const start = latest.current;
        try {
          if (!start.requestKey) return;
          if (!indexed.current.has(start.indexKey)) {
            const job = indexShots(start);
            const onUpdate = () => {
              if (!mounted.current) return;
              const current = latest.current;
              if (job.cancelled && current.scope === job.scope && current.query === job.query) {
                cancelledRequest.current = current.requestKey;
                current.clearQuery();
              }
            };
            job.listeners.add(onUpdate);
            onUpdate();
            let outcome: Awaited<IndexJob["promise"]>;
            try {
              outcome = await job.promise;
            } finally {
              job.listeners.delete(onUpdate);
            }
            if (!mounted.current) return;
            if (outcome === "ready") indexed.current.add(start.indexKey);
            if (outcome === "failed") {
              if (latest.current.indexKey === start.indexKey && latest.current.requestKey) {
                completedRequest.current = latest.current.requestKey;
                setResult({
                  key: latest.current.requestKey,
                  scores: emptyScores,
                  status: "failed",
                  version: version.current,
                });
              }
              return;
            }
            if (outcome === "cancelled") return;
          }
          // Read the panel now: query changes during indexing are intentionally
          // accepted. A different scope is handled by the next pump iteration.
          const current = latest.current;
          if (!mounted.current || !current.requestKey || current.indexKey !== start.indexKey)
            return;
          const outcome = await runOperation("storyboard.semanticSearch", () =>
            invokeCommand<SemanticMatch[]>("search_storyboards_semantic", {
              query: current.query.trim(),
              shots: current.shots,
            }),
          );
          if (!mounted.current || latest.current.requestKey !== current.requestKey) return;
          completedRequest.current = current.requestKey;
          if (outcome.status === "success") {
            setResult({
              key: current.requestKey,
              scores: new Map(outcome.value.map((match) => [match.id, match.similarity])),
              status: "ready",
              version: ++version.current,
            });
          } else if (outcome.status === "failed") {
            setResult({
              key: current.requestKey,
              scores: emptyScores,
              status: "failed",
              version: version.current,
            });
          }
        } finally {
          busy.current = false;
          if (mounted.current) setTick((value) => value + 1);
        }
      })();
    }, 350);
    // Only the debounce is tied to view changes. A started index keeps its
    // background task and queue slot until native work settles.
    return () => window.clearTimeout(timer);
  }, [requestKey, tick]);

  const current = requestKey && result?.key === requestKey ? result : null;
  return {
    scores: current?.scores ?? emptyScores,
    status: !requestKey ? "idle" : (current?.status ?? "pending"),
    resultVersion: current?.version ?? 0,
    retry: () => {
      indexed.current.delete(indexKey);
      completedRequest.current = null;
      cancelledRequest.current = null;
      setResult(null);
      setTick((value) => value + 1);
    },
  };
}
