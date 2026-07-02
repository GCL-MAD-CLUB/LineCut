import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./TaskProgress.css";

export interface TaskProgressItem {
  task_id: string;
  operation: string;
  label: string;
  current: number;
  total: number;
  progress: number;
  done: boolean;
}

interface TaskProgressProps {
  children: ReactNode;
  onCancel?: () => void;
  clearDelayMs?: number;
}

const updateEventName = "linecut-task-progress:update";
const removeEventName = "linecut-task-progress:remove";
const clearEventName = "linecut-task-progress:clear";

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function taskProgressKey(progress: Pick<TaskProgressItem, "task_id" | "operation" | "label">) {
  return progress.task_id || `${progress.operation}:${progress.label}`;
}

function upsertProgressItem(items: TaskProgressItem[], item: TaskProgressItem) {
  const key = taskProgressKey(item);
  const index = items.findIndex((current) => taskProgressKey(current) === key);
  if (index === -1) {
    return [...items, item];
  }
  const next = [...items];
  next[index] = item;
  return next;
}

export function showTaskProgress(item: TaskProgressItem) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent<TaskProgressItem>(updateEventName, { detail: item }));
}

export function removeTaskProgress(task: string | Pick<TaskProgressItem, "task_id" | "operation" | "label">) {
  if (typeof window === "undefined") {
    return;
  }
  const key = typeof task === "string" ? task : taskProgressKey(task);
  window.dispatchEvent(new CustomEvent<string>(removeEventName, { detail: key }));
}

export function clearTaskProgress() {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(clearEventName));
}

export function TaskProgress({ children, onCancel, clearDelayMs = 700 }: TaskProgressProps) {
  const clearTimersRef = useRef<Map<string, number>>(new Map());
  const [items, setItems] = useState<TaskProgressItem[]>([]);

  useEffect(() => {
    function clearTimer(key: string) {
      const existingTimer = clearTimersRef.current.get(key);
      if (existingTimer) {
        window.clearTimeout(existingTimer);
        clearTimersRef.current.delete(key);
      }
    }

    function updateItem(rawItem: TaskProgressItem) {
      const item = {
        ...rawItem,
        progress: clamp(rawItem.progress, 0, 1),
      };
      const key = taskProgressKey(item);
      clearTimer(key);

      setItems((current) => upsertProgressItem(current, item));

      if (item.done) {
        const timer = window.setTimeout(() => {
          setItems((current) => current.filter((currentItem) => taskProgressKey(currentItem) !== key));
          clearTimersRef.current.delete(key);
        }, clearDelayMs);
        clearTimersRef.current.set(key, timer);
      }
    }

    function removeItem(key: string) {
      clearTimer(key);
      setItems((current) => current.filter((item) => taskProgressKey(item) !== key));
    }

    function clearTimers() {
      for (const timer of clearTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      clearTimersRef.current.clear();
    }

    function clearItems() {
      clearTimers();
      setItems([]);
    }

    const handleUpdate = (event: Event) => {
      updateItem((event as CustomEvent<TaskProgressItem>).detail);
    };
    const handleRemove = (event: Event) => {
      removeItem((event as CustomEvent<string>).detail);
    };

    window.addEventListener(updateEventName, handleUpdate);
    window.addEventListener(removeEventName, handleRemove);
    window.addEventListener(clearEventName, clearItems);

    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (isTauriRuntime()) {
      void listen<TaskProgressItem>("ffmpeg-progress", (event) => updateItem(event.payload))
        .then((dispose) => {
          if (disposed) {
            dispose();
            return;
          }
          unlisten = dispose;
        })
        .catch(() => undefined);
    }

    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener(updateEventName, handleUpdate);
      window.removeEventListener(removeEventName, handleRemove);
      window.removeEventListener(clearEventName, clearItems);
      clearTimers();
    };
  }, [clearDelayMs]);

  if (items.length === 0) {
    return <>{children}</>;
  }

  if (items.length === 1) {
    const item = items[0];
    return (
      <div className="topbar-progress" title={`${item.label} ${Math.round(item.progress * 100)}%`}>
        <span>{item.label}</span>
        <div className="topbar-progress-row">
          <div className="topbar-progress-track">
            <div className="topbar-progress-fill" style={{ width: `${Math.round(item.progress * 100)}%` }} />
          </div>
          <button
            className="topbar-progress-cancel"
            onClick={onCancel}
            title="取消任务"
            aria-label="取消任务"
            disabled={!onCancel}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="topbar-progress topbar-progress-multi">
      <span>{`正在执行 ${items.length} 项操作...`}</span>
      <div className="topbar-progress-stack" style={{ gridTemplateRows: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((item) => (
          <div
            key={taskProgressKey(item)}
            className="topbar-progress-track"
            title={`${item.label} ${Math.round(item.progress * 100)}%`}
          >
            <div className="topbar-progress-fill" style={{ width: `${Math.round(item.progress * 100)}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
