import { randomUUID } from "node:crypto";

import type {
  EventCursor,
  HarnessEvent,
  RevisionedHarnessEvent,
} from "./protocol.ts";

export type {
  EventCursor,
  HarnessEvent,
  RevisionedHarnessEvent,
} from "./protocol.ts";

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export type HarnessEventListener = (
  event: RevisionedHarnessEvent,
) => void | Promise<void>;

export class HarnessEventHub {
  private revision = 0;
  private readonly listeners = new Set<HarnessEventListener>();

  constructor(
    readonly streamID: string = randomUUID(),
    private readonly onListenerError: (error: Error) => void = (error) =>
      console.error("Harness event listener failed", error),
  ) {}

  cursor(): EventCursor {
    return { streamID: this.streamID, revision: this.revision };
  }

  emit(event: HarnessEvent): RevisionedHarnessEvent {
    const envelope: RevisionedHarnessEvent = Object.freeze({
      streamID: this.streamID,
      revision: ++this.revision,
      event: Object.freeze(event),
    });

    for (const listener of this.listeners) {
      try {
        const result = listener(envelope);
        if (result instanceof Promise) {
          void result.catch((error) => this.reportListenerError(error));
        }
      } catch (error) {
        this.reportListenerError(error);
      }
    }
    return envelope;
  }

  subscribe(listener: HarnessEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private reportListenerError(cause: unknown): void {
    try {
      this.onListenerError(asError(cause));
    } catch {
      // Observation must never change harness execution.
    }
  }
}
