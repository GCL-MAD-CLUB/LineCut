import { useLayoutEffect, useMemo } from "react";
import { stateHub } from "./StateHub";
import type { SystemIdentity } from "../systems/identity";

export function usePublishProjection<Value>(key: string, owner: SystemIdentity, value: Value) {
  useLayoutEffect(() => {
    stateHub.publish(key, owner, value);
    return () => stateHub.remove(key, owner);
  }, [key, owner.instanceId, owner.system, value]);
}

export function useStableIdentity(system: string, instanceId?: string) {
  return useMemo(() => (instanceId ? { system, instanceId } : { system }), [instanceId, system]);
}
