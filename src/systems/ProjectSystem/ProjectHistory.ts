import type {
  MediaBinFolder,
  MediaBinItem,
  Project,
  StoryboardState,
  SubtitleState,
} from "../../types";

export const projectHistoryRowLimit = 40;

export type ProjectHistoryCategory =
  | "project"
  | "import"
  | "paste"
  | "rename"
  | "folder"
  | "move"
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
  | "storyboard"
  | "proxy"
  | "export"
  | "default";

export interface ProjectFileState {
  projects: Record<string, Project>;
  mediaFolders: MediaBinFolder[];
  mediaItems: MediaBinItem[];
  activeVideoId: string;
  activeTrackId: string;
  detachedVideoIds: Set<string>;
  useProxy: boolean;
  subtitles: Record<string, SubtitleState>;
  storyboards: Record<string, StoryboardState>;
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

interface MediaFolderSetOperation {
  type: "media-folder.set";
  folderId: string;
  value: MediaBinFolder | null;
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

interface BooleanSetOperation {
  type: "editor.use-proxy.set";
  value: boolean;
}

interface StoryboardSetOperation {
  type: "storyboard.set";
  videoContext: string;
  value: StoryboardState | null;
}

interface SubtitleSetOperation {
  type: "subtitle.set";
  trackContext: string;
  value: SubtitleState | null;
}

export type ProjectFileOperation =
  | ProjectSetOperation
  | MediaFolderSetOperation
  | MediaItemSetOperation
  | StringSetOperation
  | StringSetSetOperation
  | BooleanSetOperation
  | SubtitleSetOperation
  | StoryboardSetOperation;

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
  groupId?: string;
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
  groupId?: string,
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

  const previousFolders = new Map(
    before.mediaFolders.map((folder, index) => [folder.id, { folder, index }] as const),
  );
  const nextFolders = new Map(
    after.mediaFolders.map((folder, index) => [folder.id, { folder, index }] as const),
  );
  const folderIds = new Set([...previousFolders.keys(), ...nextFolders.keys()]);

  for (const folderId of folderIds) {
    const previous = previousFolders.get(folderId);
    const next = nextFolders.get(folderId);
    if (previous?.folder === next?.folder && previous?.index === next?.index) {
      continue;
    }
    eventOperations.push({
      type: "media-folder.set",
      folderId,
      value: next?.folder ?? null,
      index: next?.index ?? previous?.index ?? 0,
    });
    inverseOperations.push({
      type: "media-folder.set",
      folderId,
      value: previous?.folder ?? null,
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
  const trackContexts = new Set([
    ...Object.keys(before.subtitles),
    ...Object.keys(after.subtitles),
  ]);
  for (const trackContext of trackContexts) {
    const previousSubtitle = before.subtitles[trackContext] ?? null;
    const nextSubtitle = after.subtitles[trackContext] ?? null;
    if (previousSubtitle === nextSubtitle) {
      continue;
    }
    eventOperations.push({
      type: "subtitle.set",
      trackContext,
      value: nextSubtitle,
    });
    inverseOperations.push({
      type: "subtitle.set",
      trackContext,
      value: previousSubtitle,
    });
  }
  const videoContexts = new Set([
    ...Object.keys(before.storyboards),
    ...Object.keys(after.storyboards),
  ]);
  for (const videoContext of videoContexts) {
    const previousStoryboard = before.storyboards[videoContext] ?? null;
    const nextStoryboard = after.storyboards[videoContext] ?? null;
    if (previousStoryboard === nextStoryboard) {
      continue;
    }
    eventOperations.push({
      type: "storyboard.set",
      videoContext,
      value: nextStoryboard,
    });
    inverseOperations.push({
      type: "storyboard.set",
      videoContext,
      value: previousStoryboard,
    });
  }
  if (eventOperations.length === 0) {
    return null;
  }

  const id = nextEventId();
  return {
    id,
    label,
    category,
    groupId,
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
  const folderOperations = event.operations.filter(
    (operation): operation is MediaFolderSetOperation => operation.type === "media-folder.set",
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

  let mediaFolders = current.mediaFolders;
  if (folderOperations.length > 0) {
    const changedIds = new Set(folderOperations.map((operation) => operation.folderId));
    mediaFolders = current.mediaFolders.filter((folder) => !changedIds.has(folder.id));
    for (const operation of folderOperations
      .filter((candidate) => candidate.value)
      .sort((left, right) => left.index - right.index)) {
      mediaFolders.splice(Math.min(operation.index, mediaFolders.length), 0, operation.value!);
    }
  }

  const next: ProjectFileState = {
    ...current,
    projects,
    mediaFolders,
    mediaItems,
    subtitles: { ...current.subtitles },
    storyboards: { ...current.storyboards },
  };

  for (const operation of event.operations) {
    switch (operation.type) {
      case "editor.active-video.set":
        next.activeVideoId = operation.value;
        break;
      case "editor.active-track.set":
        next.activeTrackId = operation.value;
        break;
      case "subtitle.set":
        if (operation.value) {
          next.subtitles[operation.trackContext] = operation.value;
        } else {
          delete next.subtitles[operation.trackContext];
        }
        break;
      case "editor.detached-videos.set":
        next.detachedVideoIds = new Set(operation.value);
        break;
      case "editor.use-proxy.set":
        next.useProxy = operation.value;
        break;
      case "storyboard.set":
        if (operation.value) {
          next.storyboards[operation.videoContext] = operation.value;
        } else {
          delete next.storyboards[operation.videoContext];
        }
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
  const previousEntry = source.entries[source.cursor - 1];
  const shouldMerge =
    Boolean(entry.groupId) &&
    entry.groupId === previousEntry?.groupId &&
    source.cursor === source.entries.length;
  const nextEntry = shouldMerge
    ? {
        ...entry,
        id: previousEntry.id,
        inverseEvent: previousEntry.inverseEvent,
      }
    : entry;
  const entries = [
    ...source.entries.slice(0, shouldMerge ? source.cursor - 1 : source.cursor),
    nextEntry,
  ];
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
