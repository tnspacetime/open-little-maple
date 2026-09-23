/** Bounded, transport-neutral fan-out for transient Harness observations. */
import { Buffer } from "node:buffer";
import { assertNonempty } from "./json.js";
import type { TurnTextDelta } from "./turn-executor.js";

/** Live observations are explicitly separate from durable Session facts. */
export type LiveEvent = {
  readonly type: "turn.text-delta";
} & TurnTextDelta;

/** Synchronous, nonblocking publication port borrowed by Harness. */
export type LiveEventSink = {
  publish(event: LiveEvent): undefined;
};

export type LiveEventBroadcasterOptions = {
  /** Hard per-subscriber bound on queued object overhead. */
  readonly maxQueuedEvents: number;

  /** Hard per-subscriber bound on queued delta text encoded as UTF-8. */
  readonly maxQueuedTextBytes: number;
};

export interface LiveEventSubscription extends AsyncIterableIterator<LiveEvent> {
  readonly sessionId: string;

  /** Unsubscribe immediately and release every queued event. */
  close(): void;
}

/** One slow subscriber exceeded its private transient delivery budget. */
export class LiveEventOverflow extends Error {
  override readonly name = "LiveEventOverflow";

  constructor(
    readonly sessionId: string,
    readonly maxQueuedEvents: number,
    readonly maxQueuedTextBytes: number,
  ) {
    super(`Live-event subscriber overflowed for Session ${sessionId}`);
  }
}

/** New subscriptions are invalid after the broadcaster lifetime ends. */
export class LiveEventBroadcasterClosed extends Error {
  override readonly name = "LiveEventBroadcasterClosed";

  constructor() {
    super("Live-event broadcaster is closed");
  }
}

/**
 * Fan out live events into one bounded queue per Session subscriber.
 * Publication performs no I/O, awaits nothing, and never throws. Overflow
 * terminates only the slow subscriber; durable Session state remains the
 * client's recovery source.
 */
export class LiveEventBroadcaster implements LiveEventSink {
  private readonly subscriptions = new Map<
    number,
    BufferedLiveEventSubscription
  >();
  private readonly maxQueuedEvents: number;
  private readonly maxQueuedTextBytes: number;
  private nextSubscriptionId = 0;
  private closed = false;

  constructor(options: LiveEventBroadcasterOptions) {
    this.maxQueuedEvents = positiveInteger(
      options.maxQueuedEvents,
      "Maximum queued live events",
    );
    this.maxQueuedTextBytes = positiveInteger(
      options.maxQueuedTextBytes,
      "Maximum queued live-event text bytes",
    );
  }

  publish(event: LiveEvent): undefined {
    if (this.closed) return undefined;

    const textBytes = Buffer.byteLength(event.delta, "utf8");
    for (const subscription of this.subscriptions.values()) {
      if (subscription.sessionId === event.sessionId) {
        subscription.publish(event, textBytes);
      }
    }
    return undefined;
  }

  subscribe(sessionId: string): LiveEventSubscription {
    if (this.closed) throw new LiveEventBroadcasterClosed();
    assertNonempty(sessionId, "Live-event subscription Session Id");

    const id = ++this.nextSubscriptionId;
    const subscription = new BufferedLiveEventSubscription(
      sessionId,
      this.maxQueuedEvents,
      this.maxQueuedTextBytes,
      () => {
        this.subscriptions.delete(id);
      },
    );
    this.subscriptions.set(id, subscription);
    return subscription;
  }

  /** End every subscription and ignore all later publication. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    const subscriptions = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const subscription of subscriptions) subscription.close();
  }
}

type QueuedLiveEvent = {
  readonly event: LiveEvent;
  readonly textBytes: number;
};

type PendingRead = {
  readonly resolve: (result: IteratorResult<LiveEvent>) => void;
  readonly reject: (cause: unknown) => void;
};

class BufferedLiveEventSubscription implements LiveEventSubscription {
  private queue: QueuedLiveEvent[] = [];
  private queueHead = 0;
  private queuedTextBytes = 0;
  private pendingRead: PendingRead | undefined;
  private terminalError: Error | undefined;
  private closed = false;

  constructor(
    readonly sessionId: string,
    private readonly maxQueuedEvents: number,
    private readonly maxQueuedTextBytes: number,
    private readonly remove: () => void,
  ) {}

  publish(event: LiveEvent, textBytes: number): void {
    if (this.closed) return;

    const pending = this.pendingRead;
    if (pending) {
      this.pendingRead = undefined;
      pending.resolve({ done: false, value: event });
      return;
    }

    if (
      this.queuedEvents + 1 > this.maxQueuedEvents ||
      this.queuedTextBytes + textBytes > this.maxQueuedTextBytes
    ) {
      this.fail(
        new LiveEventOverflow(
          this.sessionId,
          this.maxQueuedEvents,
          this.maxQueuedTextBytes,
        ),
      );
      return;
    }

    this.queue.push({ event, textBytes });
    this.queuedTextBytes += textBytes;
  }

  next(): Promise<IteratorResult<LiveEvent>> {
    const queued = this.dequeue();
    if (queued) {
      return Promise.resolve({ done: false, value: queued.event });
    }
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.closed) return Promise.resolve(doneResult());
    if (this.pendingRead) {
      return Promise.reject(
        new Error("Live-event subscription already has a pending read"),
      );
    }

    return new Promise<IteratorResult<LiveEvent>>((resolve, reject) => {
      this.pendingRead = { resolve, reject };
    });
  }

  async return(): Promise<IteratorResult<LiveEvent>> {
    this.close();
    return doneResult();
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<LiveEvent> {
    return this;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.remove();
    this.clearQueue();

    const pending = this.pendingRead;
    this.pendingRead = undefined;
    pending?.resolve(doneResult());
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.terminalError = error;
    this.remove();
    this.clearQueue();

    const pending = this.pendingRead;
    this.pendingRead = undefined;
    pending?.reject(error);
  }

  private dequeue(): QueuedLiveEvent | undefined {
    if (this.queueHead >= this.queue.length) return undefined;

    const queued = this.queue[this.queueHead++]!;
    this.queuedTextBytes -= queued.textBytes;

    // Compact occasionally without shifting the array for every event.
    if (this.queueHead >= 64 && this.queueHead * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.queueHead);
      this.queueHead = 0;
    }
    return queued;
  }

  private clearQueue(): void {
    this.queue = [];
    this.queueHead = 0;
    this.queuedTextBytes = 0;
  }

  private get queuedEvents(): number {
    return this.queue.length - this.queueHead;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function doneResult(): IteratorResult<LiveEvent> {
  return { done: true, value: undefined };
}
