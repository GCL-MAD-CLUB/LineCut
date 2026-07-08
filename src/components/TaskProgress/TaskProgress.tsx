import { X } from "lucide-react";
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import "./TaskProgress.css";

export interface CreateTaskProgressOptions {
  operation: string;
  label: string;
  current: number;
  total: number;
  on_cancel: () => void | Promise<void>;
}

export interface TaskProgressUpdate {
  label?: string;
  current?: number;
}

export interface TaskProgressHandle {
  update: (update: TaskProgressUpdate) => void;
  remove: () => void;
  fail: (errorName: string, errorMessage: string) => void;
}

export interface TaskProgressView {
  operation: string;
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
  operation: string;
  label: string;
  current: number;
  total: number;
  on_cancel: () => void | Promise<void>;
}

interface TaskProgressError {
  id: string;
  name: string;
  message: string;
}

interface TaskProgressSnapshot {
  tasks: TaskProgressRecord[];
  errors: TaskProgressError[];
}

interface TaskProgressProps {
  children: ReactNode;
}

const listeners = new Set<() => void>();
let nextTaskId = 1;
let nextErrorId = 1;
let snapshot: TaskProgressSnapshot = {
  tasks: [],
  errors: [],
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
  if (!snapshot.tasks.some((task) => task.id === id)) {
    return;
  }
  setSnapshot({
    ...snapshot,
    tasks: snapshot.tasks.filter((task) => task.id !== id),
  });
}

function addError(name: string, message: string) {
  const id = `task-progress-error:${nextErrorId++}`;
  setSnapshot({
    ...snapshot,
    errors: [...snapshot.errors, { id, name, message }],
  });

  window.setTimeout(() => {
    removeError(id);
  }, 6000);
}

function removeError(id: string) {
  if (!snapshot.errors.some((error) => error.id === id)) {
    return;
  }
  setSnapshot({
    ...snapshot,
    errors: snapshot.errors.filter((error) => error.id !== id),
  });
}

async function runTaskCancel(task: TaskProgressRecord) {
  try {
    await task.on_cancel();
  } catch (error) {
    addError("取消任务失败", error instanceof Error ? error.message : String(error));
  }
}

export function createTaskProgress({
  operation,
  label,
  current,
  total,
  on_cancel,
}: CreateTaskProgressOptions): TaskProgressHandle {
  const normalizedTotal = Number.isFinite(total) ? Math.max(0, total) : 0;
  const id = `task-progress:${nextTaskId++}`;
  const task: TaskProgressRecord = {
    id,
    operation,
    label,
    current: clamp(Number.isFinite(current) ? current : 0, 0, normalizedTotal),
    total: normalizedTotal,
    on_cancel,
  };

  setSnapshot({
    ...snapshot,
    tasks: [...snapshot.tasks, task],
  });

  return {
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
    fail: (errorName, errorMessage) => {
      removeTask(id);
      addError(errorName, errorMessage);
    },
  };
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

  await Promise.all(tasks.map((task) => runTaskCancel(task)));
}

export function getTaskProgressStatus(operation?: string): TaskProgressStatus {
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
  const { errors, tasks } = getTaskProgressSnapshot();

  const errorStack = (
    <div className="task-progress-errors" aria-live="polite">
      {errors.map((error) => (
        <div key={error.id} className="task-progress-error">
          <div>
            <strong>{error.name}</strong>
            <span>{error.message}</span>
          </div>
          <button type="button" onClick={() => removeError(error.id)} title="关闭">
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );

  if (tasks.length === 0) {
    return (
      <>
        {children}
        {errorStack}
      </>
    );
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
            <button
              className="topbar-progress-cancel"
              onClick={() => {
                removeTask(task.id);
                void runTaskCancel(task);
              }}
              title="取消任务"
              aria-label="取消任务"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </div>
        {errorStack}
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
      {errorStack}
    </>
  );
}
