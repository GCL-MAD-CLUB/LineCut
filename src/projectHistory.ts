import type { MediaBinItem, Project } from "./types";

export const projectHistoryRowLimit = 40;

export type ProjectHistoryCategory =
  | "project"
  | "import"
  | "paste"
  | "rename"
  | "enable"
  | "disable"
  | "show"
  | "hide"
  | "online"
  | "offline"
  | "relink"
  | "bind"
  | "unbind"
  | "delete"
  | "demux"
  | "subtitle"
  | "selection"
  | "proxy"
  | "default";

export type SubtitleSelections = Record<string, Record<string, Set<string>>>;

export interface ProjectFileState {
  projects: Record<string, Project>;
  mediaItems: MediaBinItem[];
  activeVideoId: string;
  activeTrackId: string;
  subtitleSelections: SubtitleSelections;
  detachedVideoIds: Set<string>;
  useProxy: boolean;
}

interface ProjectSetOperation {
  type: "project.set";
  projectId: string;
  value: Project | null;
}

interface MediaItemSetOperation {
  type: "media-item.set";
  itemId: string;
  value: MediaBinItem | null;
  index: number;
}

interface StringSetOperation {
  type: "editor.active-video.set" | "editor.active-track.set";
  value: string;
}

interface StringSetSetOperation {
  type: "editor.detached-videos.set";
  value: string[];
}

interface SubtitleSelectionSetOperation {
  type: "editor.subtitle-selection.set";
  videoId: string;
  trackId: string;
  value: string[];
}

interface BooleanSetOperation {
  type: "editor.use-proxy.set";
  value: boolean;
}

export type ProjectFileOperation =
  | ProjectSetOperation
  | MediaItemSetOperation
  | StringSetOperation
  | StringSetSetOperation
  | SubtitleSelectionSetOperation
  | BooleanSetOperation;

export interface ProjectFileEvent {
  id: string;
  label: string;
  category: ProjectHistoryCategory;
  operations: ProjectFileOperation[];
}

export interface ProjectHistoryEntry {
  id: string;
  label: string;
  category: ProjectHistoryCategory;
  event: ProjectFileEvent;
  inverseEvent: ProjectFileEvent;
}

export interface ProjectHistoryState {
  active: boolean;
  baseLabel: string;
  entries: ProjectHistoryEntry[];
  cursor: number;
  savedCursor: number;
}

let eventSequence = 0;

function nextEventId() {
  eventSequence += 1;
  return `project-event-${Date.now()}-${eventSequence}`;
}

function setsEqual(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function addSetOperation(
  eventOperations: ProjectFileOperation[],
  inverseOperations: ProjectFileOperation[],
  type: StringSetSetOperation["type"],
  before: Set<string>,
  after: Set<string>,
) {
  if (setsEqual(before, after)) {
    return;
  }
  eventOperations.push({ type, value: [...after] });
  inverseOperations.push({ type, value: [...before] });
}

function addScalarOperation<Type extends StringSetOperation["type"]>(
  eventOperations: ProjectFileOperation[],
  inverseOperations: ProjectFileOperation[],
  type: Type,
  before: string,
  after: string,
): void;
function addScalarOperation<Type extends BooleanSetOperation["type"]>(
  eventOperations: ProjectFileOperation[],
  inverseOperations: ProjectFileOperation[],
  type: Type,
  before: boolean,
  after: boolean,
): void;
function addScalarOperation(
  eventOperations: ProjectFileOperation[],
  inverseOperations: ProjectFileOperation[],
  type: StringSetOperation["type"] | BooleanSetOperation["type"],
  before: string | boolean,
  after: string | boolean,
) {
  if (before === after) {
    return;
  }
  if (typeof after === "string" && typeof before === "string") {
    const stringType = type as StringSetOperation["type"];
    eventOperations.push({ type: stringType, value: after });
    inverseOperations.push({ type: stringType, value: before });
    return;
  }
  const booleanType = type as BooleanSetOperation["type"];
  eventOperations.push({ type: booleanType, value: after as boolean });
  inverseOperations.push({ type: booleanType, value: before as boolean });
}

export function createProjectHistoryEntry(
  label: string,
  category: ProjectHistoryCategory,
  before: ProjectFileState,
  after: ProjectFileState,
): ProjectHistoryEntry | null {
  const eventOperations: ProjectFileOperation[] = [];
  const inverseOperations: ProjectFileOperation[] = [];
  const projectIds = new Set([...Object.keys(before.projects), ...Object.keys(after.projects)]);

  for (const projectId of projectIds) {
    const previousProject = before.projects[projectId] ?? null;
    const nextProject = after.projects[projectId] ?? null;
    if (previousProject === nextProject) {
      continue;
    }
    eventOperations.push({ type: "project.set", projectId, value: nextProject });
    inverseOperations.push({ type: "project.set", projectId, value: previousProject });
  }

  const previousItems = new Map(
    before.mediaItems.map((item, index) => [item.id, { item, index }] as const),
  );
  const nextItems = new Map(
    after.mediaItems.map((item, index) => [item.id, { item, index }] as const),
  );
  const mediaItemIds = new Set([...previousItems.keys(), ...nextItems.keys()]);

  for (const itemId of mediaItemIds) {
    const previous = previousItems.get(itemId);
    const next = nextItems.get(itemId);
    if (previous?.item === next?.item && previous?.index === next?.index) {
      continue;
    }
    eventOperations.push({
      type: "media-item.set",
      itemId,
      value: next?.item ?? null,
      index: next?.index ?? previous?.index ?? 0,
    });
    inverseOperations.push({
      type: "media-item.set",
      itemId,
      value: previous?.item ?? null,
      index: previous?.index ?? next?.index ?? 0,
    });
  }

  addScalarOperation(
    eventOperations,
    inverseOperations,
    "editor.active-video.set",
    before.activeVideoId,
    after.activeVideoId,
  );
  addScalarOperation(
    eventOperations,
    inverseOperations,
    "editor.active-track.set",
    before.activeTrackId,
    after.activeTrackId,
  );
  const selectionVideoIds = new Set([
    ...Object.keys(before.subtitleSelections),
    ...Object.keys(after.subtitleSelections),
  ]);
  for (const videoId of selectionVideoIds) {
    const previousVideoSelections = before.subtitleSelections[videoId] ?? {};
    const nextVideoSelections = after.subtitleSelections[videoId] ?? {};
    const trackIds = new Set([
      ...Object.keys(previousVideoSelections),
      ...Object.keys(nextVideoSelections),
    ]);
    for (const trackId of trackIds) {
      const previousSelection = previousVideoSelections[trackId] ?? new Set<string>();
      const nextSelection = nextVideoSelections[trackId] ?? new Set<string>();
      if (setsEqual(previousSelection, nextSelection)) {
        continue;
      }
      eventOperations.push({
        type: "editor.subtitle-selection.set",
        videoId,
        trackId,
        value: [...nextSelection],
      });
      inverseOperations.push({
        type: "editor.subtitle-selection.set",
        videoId,
        trackId,
        value: [...previousSelection],
      });
    }
  }
  addSetOperation(
    eventOperations,
    inverseOperations,
    "editor.detached-videos.set",
    before.detachedVideoIds,
    after.detachedVideoIds,
  );
  addScalarOperation(
    eventOperations,
    inverseOperations,
    "editor.use-proxy.set",
    before.useProxy,
    after.useProxy,
  );
  if (eventOperations.length === 0) {
    return null;
  }

  const id = nextEventId();
  return {
    id,
    label,
    category,
    event: { id, label, category, operations: eventOperations },
    inverseEvent: {
      id: `${id}-inverse`,
      label: `撤销 ${label}`,
      category,
      operations: inverseOperations,
    },
  };
}

export function applyProjectFileEvent(
  current: ProjectFileState,
  event: ProjectFileEvent,
): ProjectFileState {
  const projects = { ...current.projects };
  const mediaOperations = event.operations.filter(
    (operation): operation is MediaItemSetOperation => operation.type === "media-item.set",
  );

  for (const operation of event.operations) {
    if (operation.type !== "project.set") {
      continue;
    }
    if (operation.value) {
      projects[operation.projectId] = operation.value;
    } else {
      delete projects[operation.projectId];
    }
  }

  let mediaItems = current.mediaItems;
  if (mediaOperations.length > 0) {
    const changedIds = new Set(mediaOperations.map((operation) => operation.itemId));
    mediaItems = current.mediaItems.filter((item) => !changedIds.has(item.id));
    for (const operation of mediaOperations
      .filter((candidate) => candidate.value)
      .sort((left, right) => left.index - right.index)) {
      mediaItems.splice(Math.min(operation.index, mediaItems.length), 0, operation.value!);
    }
  }

  const next: ProjectFileState = {
    ...current,
    projects,
    mediaItems,
    subtitleSelections: { ...current.subtitleSelections },
  };

  for (const operation of event.operations) {
    switch (operation.type) {
      case "editor.active-video.set":
        next.activeVideoId = operation.value;
        break;
      case "editor.active-track.set":
        next.activeTrackId = operation.value;
        break;
      case "editor.subtitle-selection.set": {
        const videoSelections = { ...(next.subtitleSelections[operation.videoId] ?? {}) };
        if (operation.value.length > 0) {
          videoSelections[operation.trackId] = new Set(operation.value);
        } else {
          delete videoSelections[operation.trackId];
        }
        if (Object.keys(videoSelections).length > 0) {
          next.subtitleSelections[operation.videoId] = videoSelections;
        } else {
          delete next.subtitleSelections[operation.videoId];
        }
        break;
      }
      case "editor.detached-videos.set":
        next.detachedVideoIds = new Set(operation.value);
        break;
      case "editor.use-proxy.set":
        next.useProxy = operation.value;
        break;
    }
  }

  return next;
}

export function createProjectHistory(
  active = false,
  saved = true,
  baseLabel = "新建/打开",
): ProjectHistoryState {
  return {
    active,
    baseLabel,
    entries: [],
    cursor: 0,
    savedCursor: saved ? 0 : -1,
  };
}

export function appendProjectHistoryEntry(
  current: ProjectHistoryState,
  entry: ProjectHistoryEntry,
): ProjectHistoryState {
  const source = current.active ? current : createProjectHistory(true);
  let savedCursor = source.savedCursor > source.cursor ? -1 : source.savedCursor;
  const entries = [...source.entries.slice(0, source.cursor), entry];
  let cursor = entries.length;
  let baseLabel = source.baseLabel;

  while (entries.length >= projectHistoryRowLimit) {
    const removed = entries.shift();
    cursor -= 1;
    baseLabel = removed?.label ?? baseLabel;
    savedCursor = savedCursor > 0 ? savedCursor - 1 : -1;
  }

  return {
    active: true,
    baseLabel,
    entries,
    cursor,
    savedCursor,
  };
}

export function markProjectHistorySaved(current: ProjectHistoryState): ProjectHistoryState {
  return current.active ? { ...current, savedCursor: current.cursor } : current;
}

export function discardFutureProjectHistory(current: ProjectHistoryState): ProjectHistoryState {
  if (!current.active || current.cursor >= current.entries.length) {
    return current;
  }
  return {
    ...current,
    entries: current.entries.slice(0, current.cursor),
    savedCursor: current.savedCursor > current.cursor ? -1 : current.savedCursor,
  };
}

export function isProjectHistoryDirty(history: ProjectHistoryState) {
  return history.active && history.cursor !== history.savedCursor;
}
