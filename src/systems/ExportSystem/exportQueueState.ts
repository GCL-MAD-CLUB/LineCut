import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ExportQueueEvent, ExportQueueEventStatus, ExportResult } from "./exportTypes";

const completedEventHistoryLimit = 100;

export interface ExportQueueState {
  events: ExportQueueEvent[];
  activeEventId: string | null;
  queuedCount: number;
  append: (event: ExportQueueEvent) => void;
  updateStatus: (
    eventId: string,
    status: ExportQueueEventStatus,
    result?: ExportResult | null,
  ) => void;
}

function trimCompletedEvents(events: ExportQueueEvent[]) {
  const active = events.filter((event) => event.status === "queued" || event.status === "running");
  const completed = events.filter(
    (event) => event.status !== "queued" && event.status !== "running",
  );
  return [...completed.slice(-completedEventHistoryLimit), ...active].sort(
    (left, right) => left.createdAt - right.createdAt,
  );
}

export const exportQueueStore = createStore<ExportQueueState>()((set) => ({
  events: [],
  activeEventId: null,
  queuedCount: 0,
  append: (event) =>
    set((state) => ({
      events: trimCompletedEvents([...state.events, event]),
      queuedCount: state.queuedCount + 1,
    })),
  updateStatus: (eventId, status, result = null) =>
    set((state) => ({
      events: trimCompletedEvents(
        state.events.map((event) => (event.id === eventId ? { ...event, status, result } : event)),
      ),
      activeEventId:
        status === "running"
          ? eventId
          : state.activeEventId === eventId
            ? null
            : state.activeEventId,
      queuedCount: status === "running" ? Math.max(0, state.queuedCount - 1) : state.queuedCount,
    })),
}));

export function useExportQueueState<Selection>(selector: (state: ExportQueueState) => Selection) {
  return useStore(exportQueueStore, selector);
}
