interface MediaDragSession {
  itemIds: string[];
  videoId: string | null;
  handled: boolean;
}

let activeSession: MediaDragSession | null = null;

export function beginMediaDrag(itemIds: string[], videoId: string | null) {
  activeSession = {
    itemIds: [...itemIds],
    videoId,
    handled: false,
  };
}

export function activeMediaDragItemIds() {
  return activeSession?.itemIds ?? [];
}

export function activeMediaDragVideoId() {
  return activeSession?.videoId ?? null;
}

export function mediaDragWasHandled() {
  return activeSession?.handled ?? false;
}

export function markMediaDragHandled() {
  if (activeSession) {
    activeSession.handled = true;
  }
}

export function finishMediaDrag() {
  activeSession = null;
}
