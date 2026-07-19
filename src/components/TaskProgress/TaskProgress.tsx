import { X } from "lucide-react";
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { captureOperationError, type OperationKey, type PublicContext } from "../../errors";
import "./TaskProgress.css";

export interface CreateTaskProgressOptions {
  operation: OperationKey;
  label: string;
  current: number;
  total: number;
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
  update: (update: TaskProgressUpdate) => void;
  remove: () => void;
  fail: (error: unknown, context?: PublicContext) => void;
}

export interface TaskProgressView {
  operation: OperationKey;
  label: string;
  current: number;
  total: number;
  percent: number;
}

export interface TaskProgressStatus {
  tasks: TaskProgressView[];
  count: number;
  isRunning: boolean;
}

interface TaskProgressRecord {
  id: string;
  operation: OperationKey;
  label: string;
  current: number;
  total: number;
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
    operation: task.operation,
    label: task.label,
    current: task.current,
    total: task.total,
    percent: taskPercent(task),
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
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
  if (!task.on_cancel || task.is_cancelling) {
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
  try {
    await task.on_cancel();
    removeTask(task.id);
  } catch (error) {
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

export async function createTaskProgress({
  operation,
  label,
  current,
  total,
  listener,
  on_cancel,
}: CreateTaskProgressOptions): Promise<TaskProgressHandle> {
  const normalizedTotal = Number.isFinite(total) ? Math.max(0, total) : 0;
  const id = `task-progress:${nextTaskId++}`;
  const task: TaskProgressRecord = {
    id,
    operation,
    label,
    current: clamp(Number.isFinite(current) ? current : 0, 0, normalizedTotal),
    total: normalizedTotal,
    is_cancelling: false,
    on_cancel,
  };

  const handle: TaskProgressHandle = {
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

  if (listener) {
    try {
      const cleanup = await listener(handle.update);
      if (cleanup) {
        task.listener_cleanup = cleanup;
      }
    } catch (error) {
      captureOperationError("task.listener", error);
    }
  }

  setSnapshot({
    ...snapshot,
    tasks: [...snapshot.tasks, task],
  });

  return handle;
}

export async function cancelAllTaskProgress() {
  const tasks = snapshot.tasks;
  if (tasks.length === 0) {
    return;
  }

  setSnapshot({
    ...snapshot,
    tasks: [],
  });

  await Promise.all([
    ...tasks.map((task) => stopTaskListener(task)),
    ...tasks.map((task) => runTaskCancel(task)),
  ]);
}

export function getTaskProgressStatus(operation?: OperationKey): TaskProgressStatus {
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
    const percent = Math.round(taskPercent(task));
    return (
      <>
        <div className="topbar-progress" title={`${task.label} ${percent}%`}>
          <span>{task.label}</span>
          <div className="topbar-progress-row">
            <div className="topbar-progress-track">
              <div className="topbar-progress-fill" style={{ width: `${percent}%` }} />
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
        <span>{`正在执行 ${tasks.length} 项操作...`}</span>
        <div
          className="topbar-progress-stack"
          style={{ gridTemplateRows: `repeat(${tasks.length}, minmax(0, 1fr))` }}
        >
          {tasks.map((task) => {
            const percent = Math.round(taskPercent(task));
            return (
              <div
                key={task.id}
                className="topbar-progress-track"
                title={`${task.label} ${percent}%`}
              >
                <div className="topbar-progress-fill" style={{ width: `${percent}%` }} />
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
