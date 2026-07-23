import { useEffect, useRef } from "react";
import { runOperation } from "../../errors";
import type { ApplicationEventMap, ApplicationEventType } from "./contracts";
import {
  eventHub,
  eventSubscriberId,
  type EventEnvelope,
  type EventHandlingResult,
} from "./EventHub";
import type { SystemIdentity } from "../systems/identity";

export function useBroadcastEvent<Type extends ApplicationEventType>(
  identity: SystemIdentity,
  type: Type,
  handler: (event: EventEnvelope<Type>) => EventHandlingResult | Promise<EventHandlingResult>,
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(
    () =>
      eventHub.subscribe({
        id: eventSubscriberId(identity, type),
        accepts: (event) => event.type === type,
        handle: async (event) => {
          let result: EventHandlingResult = "ignored";
          const outcome = await runOperation(
            "app.event",
            async () => {
              result = await handlerRef.current(event as EventEnvelope<Type>);
            },
            { displayName: type },
          );
          return outcome.status === "success" ? result : "ignored";
        },
      }),
    [identity.instanceId, identity.system, type],
  );
}

export function publishEvent<Type extends ApplicationEventType>(
  type: Type,
  payload: ApplicationEventMap[Type],
  source: SystemIdentity,
) {
  return eventHub.publish(type, payload, { source });
}
