import type { ApplicationEventMap, ApplicationEventType } from "./contracts";
import type { SystemIdentity } from "../systems/identity";
import { systemIdentityKey } from "../systems/identity";
import { deepFreeze } from "../immutable";

export interface EventContext {
  workspaceId?: string;
  projectId?: string;
}

export interface EventEnvelope<Type extends ApplicationEventType = ApplicationEventType> {
  readonly id: string;
  readonly type: Type;
  readonly version: 1;
  readonly timestamp: number;
  readonly source: Readonly<SystemIdentity>;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly context: Readonly<EventContext>;
  readonly payload: Readonly<ApplicationEventMap[Type]>;
}

export type EventHandlingResult = "handled" | "ignored";

export interface EventDeliveryFailure {
  subscriberId: string;
  error: unknown;
}

export interface EventDeliveryReport {
  eventId: string;
  delivered: number;
  handled: number;
  ignored: number;
  failed: EventDeliveryFailure[];
}

type AnyEvent = EventEnvelope<ApplicationEventType>;

interface Subscription {
  id: string;
  accepts: (event: AnyEvent) => boolean;
  handle: (event: AnyEvent) => EventHandlingResult | Promise<EventHandlingResult>;
}

interface PublishMeta {
  source: SystemIdentity;
  context?: EventContext;
  correlationId?: string;
  causationId?: string;
}

interface PublishJob {
  event: AnyEvent;
}

const EVENT_JOURNAL_LIMIT = 200;

class EventHub {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly journal: AnyEvent[] = [];
  private readonly deliveryJournal: EventDeliveryReport[] = [];
  private readonly queue: PublishJob[] = [];
  private draining = false;

  publish<Type extends ApplicationEventType>(
    type: Type,
    payload: ApplicationEventMap[Type],
    meta: PublishMeta,
  ): string {
    const event = Object.freeze({
      id: globalThis.crypto?.randomUUID?.() ?? `event:${Date.now()}:${Math.random()}`,
      type,
      version: 1 as const,
      timestamp: Date.now(),
      source: deepFreeze({ ...meta.source }),
      correlationId: meta.correlationId,
      causationId: meta.causationId,
      context: deepFreeze({ ...meta.context }),
      payload: deepFreeze({ ...payload }),
    }) as unknown as AnyEvent;

    this.journal.push(event);
    if (this.journal.length > EVENT_JOURNAL_LIMIT) {
      this.journal.splice(0, this.journal.length - EVENT_JOURNAL_LIMIT);
    }

    this.queue.push({ event });
    void this.drain();
    return event.id;
  }

  subscribe(subscription: Subscription) {
    const key = `${subscription.id}:${globalThis.crypto?.randomUUID?.() ?? Math.random()}`;
    this.subscriptions.set(key, subscription);
    return () => {
      this.subscriptions.delete(key);
    };
  }

  recentEvents() {
    return [...this.journal];
  }

  recentDeliveries() {
    return [...this.deliveryJournal];
  }

  private async drain() {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) {
          continue;
        }
        const report = await this.deliver(job.event);
        this.deliveryJournal.push(report);
        if (this.deliveryJournal.length > EVENT_JOURNAL_LIMIT) {
          this.deliveryJournal.splice(0, this.deliveryJournal.length - EVENT_JOURNAL_LIMIT);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async deliver(event: AnyEvent): Promise<EventDeliveryReport> {
    const subscriptions = [...this.subscriptions.values()];
    let handled = 0;
    let ignored = 0;
    const failed: EventDeliveryFailure[] = [];

    await Promise.all(
      subscriptions.map(async (subscription) => {
        if (!subscription.accepts(event)) {
          ignored += 1;
          return;
        }
        try {
          const result = await subscription.handle(event);
          if (result === "handled") {
            handled += 1;
          } else {
            ignored += 1;
          }
        } catch (error) {
          failed.push({ subscriberId: subscription.id, error });
        }
      }),
    );

    return {
      eventId: event.id,
      delivered: subscriptions.length,
      handled,
      ignored,
      failed,
    };
  }
}

export const eventHub = new EventHub();

export function eventSource(system: string, instanceId?: string): SystemIdentity {
  return instanceId ? { system, instanceId } : { system };
}

export function eventSubscriberId(identity: SystemIdentity, capability: string) {
  return `${systemIdentityKey(identity)}:${capability}`;
}
