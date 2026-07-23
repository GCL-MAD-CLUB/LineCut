export interface SystemIdentity {
  system: string;
  instanceId?: string;
}

export function systemIdentity(system: string, instanceId?: string): SystemIdentity {
  return instanceId ? { system, instanceId } : { system };
}

export function systemIdentityKey(identity: SystemIdentity) {
  return identity.instanceId ? `${identity.system}:${identity.instanceId}` : identity.system;
}
