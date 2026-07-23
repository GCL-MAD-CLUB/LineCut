import { useMemo, useSyncExternalStore } from "react";
import type { SystemIdentity } from "../systems/identity";
import { systemIdentityKey } from "../systems/identity";
import { deepFreeze, type DeepReadonly } from "../immutable";

export interface StateProjection<Value> {
  readonly key: string;
  readonly owner: Readonly<SystemIdentity>;
  readonly revision: number;
  readonly value: DeepReadonly<Value>;
}

class StateHub {
  private readonly projections = new Map<string, Map<string, StateProjection<unknown>>>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  publish<Value>(key: string, owner: SystemIdentity, value: Value) {
    const ownerKey = systemIdentityKey(owner);
    const byOwner = this.projections.get(key) ?? new Map<string, StateProjection<unknown>>();
    this.revision += 1;
    byOwner.set(ownerKey, {
      key,
      owner: deepFreeze({ ...owner }),
      revision: this.revision,
      value: deepFreeze({ ...value }),
    });
    this.projections.set(key, byOwner);
    this.notify();
  }

  remove(key: string, owner: SystemIdentity) {
    const byOwner = this.projections.get(key);
    if (!byOwner?.delete(systemIdentityKey(owner))) {
      return;
    }
    if (byOwner.size === 0) {
      this.projections.delete(key);
    }
    this.revision += 1;
    this.notify();
  }

  get<Value>(key: string): ReadonlyArray<StateProjection<Value>> {
    return [...(this.projections.get(key)?.values() ?? [])] as StateProjection<Value>[];
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getRevision = () => this.revision;

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const stateHub = new StateHub();

export function useProjections<Value>(key: string) {
  const revision = useSyncExternalStore(
    stateHub.subscribe,
    stateHub.getRevision,
    stateHub.getRevision,
  );
  return useMemo(() => stateHub.get<Value>(key), [key, revision]);
}
