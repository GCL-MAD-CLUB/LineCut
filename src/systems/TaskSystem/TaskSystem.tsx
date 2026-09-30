import { X } from "lucide-react";
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { captureOperationError, type OperationKey, type PublicContext } from "../../errors";
import "../../components/TaskProgress/TaskProgress.css";

export interface CreateTaskProgressOptions {
  resourceKey?: string;
  operation: OperationKey;
  label: string;
  current: number;
  total: number;
  /** @deprecated All queued tasks are non-blocking. */
  blocking?: boolean;
  listener?: TaskProgressListener;
  on_cancel?: () => void | Promise<void>;
}

export interface TaskProgressUpdate {
  label?: string;
  current?: number;
}

export type TaskProgressListenerCleanup = () => void | Promise<void>;

export type TaskProgressListener = (
  publishUpdate: (update: TaskProgressUpdate) => void,
) => void | TaskProgressListenerCleanup | Promise<void | TaskProgressListenerCleanup>;

export interface TaskProgressHandle {
  readonly cancelled: boolean;
  update: (update: TaskProgressUpdate) => void;
  remove: () => void;
  fail: (error: unknown, context?: PublicContext) => void;
}

export interface TaskProgressView {
  id: string;
  resourceKey?: string;
  operation: OperationKey;
  label: string;
  current: number;
  total: number;
  percent: number;
  state: "queued" | "running";
  blocking: boolean;
  cancellable: boolean;
  isCancelling: boolean;
  cancel: () => Promise<void>;
}

export interface TaskProgressStatus {
  tasks: TaskProgressView[];
  count: number;
  isRunning: boolean;
}

interface TaskProgressRecord {
  control: { cancelled: boolean; start: () => void; done: Promise<void>; finish: () => void };
  id: string;
  resourceKey?: string;
  operation: OperationKey;
  label: string;
  current: number;
  total: number;
  state: "queued" | "running";
  blocking: boolean;
  is_cancelling: boolean;
  listener_cleanup?: TaskProgressListenerCleanup;
  on_cancel?: () => void | Promise<void>;
}

interface TaskProgressSnapshot {
  tasks: TaskProgressRecord[];
}

interface TaskProgressProps {
  children: ReactNode;
}

const listeners = new Set<() => void>();
let nextTaskId = 1;
let snapshot: TaskProgressSnapshot = {
  tasks: [],
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function taskPercent(task: Pick<TaskProgressRecord, "current" | "total">) {
  if (task.total <= 0) {
    return 0;
  }
  return clamp(task.current / task.total, 0, 1) * 100;
}

function toViewTask(task: TaskProgressRecord): TaskProgressView {
  return {
    id: task.id,
    resourceKey: task.resourceKey,
    operation: task.operation,
    state: task.state,
    label: task.label,
    current: task.current,
    total: task.total,
    percent: taskPercent(task),
    blocking: task.blocking,
    cancellable: Boolean(task.on_cancel),
    isCancelling: task.is_cancelling,
    cancel: () => runTaskCancel(task),
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

function setSnapshot(nextSnapshot: TaskProgressSnapshot) {
  snapshot = nextSnapshot;
  for (const listener of listeners) {
    listener();
  }
}

function getTaskProgressSnapshot() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function startNextTask() {
  if (snapshot.tasks.some((task) => task.state === "running")) return;
  const next = snapshot.tasks[0];
  if (!next) return;
  setSnapshot({
    tasks: snapshot.tasks.map((task) =>
      task.id === next.id ? { ...task, state: "running" } : task,
    ),
  });
  next.control.start();
}

function removeTask(id: string) {
  const task = snapshot.tasks.find((currentTask) => currentTask.id === id);
  if (!task) {
    return;
  }
  void stopTaskListener(task);
  setSnapshot({
    ...snapshot,
    tasks: snapshot.tasks.filter((task) => task.id !== id),
  });
  task.control.finish();
  startNextTask();
}

async function stopTaskListener(task: TaskProgressRecord) {
  const cleanup = task.listener_cleanup;
  task.listener_cleanup = undefined;
  if (!cleanup) {
    return;
  }
  try {
    await cleanup();
  } catch (error) {
    captureOperationError("task.listener", error);
  }
}

async function runTaskCancel(task: TaskProgressRecord) {
  const live = snapshot.tasks.find((current) => current.id === task.id);
  if (!live) return;
  task = live;
  if (task.control.cancelled || task.is_cancelling) {
    return;
  }
  if (task.state === "queued") {
    task.control.cancelled = true;
    removeTask(task.id);
    task.control.start();
    return;
  }
  setSnapshot({
    ...snapshot,
    tasks: snapshot.tasks.map((currentTask) =>
      currentTask.id === task.id
        ? { ...currentTask, is_cancelling: true, label: "正在取消任务" }
        : currentTask,
    ),
  });
  task.control.cancelled = true;
  try {
    await task.on_cancel?.();
    task.control.cancelled = true;
    // The owner releases the serial slot only after backend work has settled.
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "TASK_NOT_RUNNING") {
      task.control.cancelled = true;
      return;
    }
    task.control.cancelled = false;
    setSnapshot({
      ...snapshot,
      tasks: snapshot.tasks.map((currentTask) =>
        currentTask.id === task.id
          ? { ...currentTask, is_cancelling: false, label: task.label }
          : currentTask,
      ),
    });
    captureOperationError("task.cancel", error);
  }
}

/** Registers immediately and resolves when the task owns the serial slot.
 * Check cancelled before starting work; remove/fail only after work settles.
 */
export async function createTaskProgress({
  operation,
  resourceKey,
  label,
  current,
  total,
  listener,
  on_cancel,
}: CreateTaskProgressOptions): Promise<TaskProgressHandle> {
  const normalizedTotal = Number.isFinite(total) ? Math.max(0, total) : 0;
  const id = `task-progress:${nextTaskId++}`;
  let start!: () => void;
  const ready = new Promise<void>((resolve) => {
    start = resolve;
  });
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const control = { cancelled: false, start, done, finish };
  const task: TaskProgressRecord = {
    control,
    resourceKey,
    state: "queued",
    id,
    operation,
    label,
    current: clamp(Number.isFinite(current) ? current : 0, 0, normalizedTotal),
    total: normalizedTotal,
    blocking: false,
    is_cancelling: false,
    on_cancel,
  };

  const handle: TaskProgressHandle = {
    get cancelled() {
      return control.cancelled;
    },
    update: ({ current: nextCurrent, label: nextLabel }) => {
      if (!snapshot.tasks.some((currentTask) => currentTask.id === id)) {
        return;
      }
      setSnapshot({
        ...snapshot,
        tasks: snapshot.tasks.map((currentTask) =>
          currentTask.id === id
            ? {
                ...currentTask,
                label: nextLabel ?? currentTask.label,
                current:
                  nextCurrent === undefined
                    ? currentTask.current
                    : clamp(Number.isFinite(nextCurrent) ? nextCurrent : 0, 0, currentTask.total),
              }
            : currentTask,
        ),
      });
    },
    remove: () => removeTask(id),
    fail: (error, context) => {
      removeTask(id);
      captureOperationError(operation, error, context);
    },
  };

  setSnapshot({ tasks: [...snapshot.tasks, task] });
  startNextTask();
  await ready;
  if (control.cancelled) {
    removeTask(id);
    return handle;
  }

  if (listener) {
    try {
      const cleanup = await listener(handle.update);
      if (cleanup) {
        const live = snapshot.tasks.find((entry) => entry.id === id);
        if (live) live.listener_cleanup = cleanup;
        else await cleanup();
      }
    } catch (error) {
      captureOperationError("task.listener", error);
    }
  }

  if (control.cancelled) removeTask(id);
  return handle;
}

export async function cancelAllTaskProgress() {
  const tasks = snapshot.tasks;
  if (tasks.length === 0) {
    return;
  }

  // Remove queued work first so cancelling the active task cannot start it.
  await Promise.all(tasks.filter((task) => task.state === "queued").map(runTaskCancel));
  await Promise.all(tasks.filter((task) => task.state === "running").map(runTaskCancel));
  await Promise.all(tasks.map((task) => task.control.done));
}

export function useTaskProgressStatus(operation?: OperationKey): TaskProgressStatus {
  const { tasks } = getTaskProgressSnapshot();

  return useMemo(() => {
    const visibleTasks = operation ? tasks.filter((task) => task.operation === operation) : tasks;
    const viewTasks = visibleTasks.map(toViewTask);
    return {
      tasks: viewTasks,
      count: viewTasks.length,
      isRunning: viewTasks.length > 0,
    };
  }, [operation, tasks]);
}

export function TaskProgress({ children }: TaskProgressProps) {
  const { tasks } = getTaskProgressSnapshot();

  if (tasks.length === 0) {
    return children;
  }

  if (tasks.length === 1) {
    const task = tasks[0];
    const fillPercent = taskPercent(task);
    const percent = Math.round(fillPercent);
    return (
      <>
        <div
          className="topbar-progress"
          title={`${task.label} ${task.state === "queued" ? "排队中" : `${percent}%`}`}
        >
          <span>
            {task.label}
            {task.state === "queued" ? "（排队中）" : ""}
          </span>
          <div className="topbar-progress-row">
            <div className="topbar-progress-track">
              <div className="topbar-progress-fill" style={{ width: `${fillPercent}%` }} />
            </div>
            {task.on_cancel && (
              <button
                className="topbar-progress-cancel"
                onClick={() => void runTaskCancel(task)}
                title="取消任务"
                aria-label="取消任务"
                disabled={task.is_cancelling}
              >
                <X aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="topbar-progress topbar-progress-multi">
        <span>{`正在执行 ${tasks.length}  项操作...`}</span>
        <div
          className="topbar-progress-stack"
          style={{ gridTemplateRows: `repeat(${Math.min(tasks.length, 3)}, minmax(0, 1fr))` }}
        >
          {tasks.slice(0, 3).map((task) => {
            const fillPercent = taskPercent(task);
            const percent = Math.round(fillPercent);
            return (
              <div
                key={task.id}
                className="topbar-progress-track"
                title={`${task.label} ${task.state === "queued" ? "排队中" : `${percent}%`}`}
              >
                <div className="topbar-progress-fill" style={{ width: `${fillPercent}%` }} />
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
