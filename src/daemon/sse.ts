import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  EventCursor,
  HarnessEventHub,
  RevisionedHarnessEvent,
} from "./events.ts";

export type DaemonTransportEvent =
  | { type: "connected"; cursor: EventCursor }
  | { type: "heartbeat"; cursor: EventCursor }
  | { type: "resync-required"; cursor: EventCursor };

export function hasBearerToken(
  authorization: string | undefined,
  secret: string,
): boolean {
  if (!authorization) return false;
  const actual = Buffer.from(authorization);
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

type Replay =
  | {
      type: "ready";
      cursor: EventCursor;
      events: readonly RevisionedHarnessEvent[];
      unsubscribe(): void;
    }
  | { type: "resync-required"; cursor: EventCursor };

// This is replay memory, not durable state. SQLite remains authoritative.
export class BoundedEventBuffer {
  private readonly events: RevisionedHarnessEvent[] = [];
  private readonly listeners = new Set<
    (event: RevisionedHarnessEvent) => void
  >();
  private readonly unsubscribe: () => void;
  private current: EventCursor;

  constructor(events: HarnessEventHub, readonly capacity = 1_000) {
    this.current = events.cursor();
    this.unsubscribe = events.subscribe((event) => this.push(event));
  }

  cursor(): EventCursor {
    return { ...this.current };
  }

  open(
    after: EventCursor | undefined,
    listener: (event: RevisionedHarnessEvent) => void,
  ): Replay {
    const cursor = this.cursor();
    const requested = after ?? cursor;
    const oldest = this.events[0]?.revision ?? cursor.revision + 1;
    if (
      requested.streamID !== cursor.streamID ||
      requested.revision > cursor.revision ||
      requested.revision < oldest - 1
    ) {
      return { type: "resync-required", cursor };
    }

    this.listeners.add(listener);
    return {
      type: "ready",
      cursor,
      events: this.events.filter(
        (event) => event.revision > requested.revision,
      ),
      unsubscribe: () => this.listeners.delete(listener),
    };
  }

  close(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  private push(event: RevisionedHarnessEvent): void {
    this.current = { streamID: event.streamID, revision: event.revision };
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.shift();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One disconnected client must not block the others.
      }
    }
  }
}

export class HarnessEventSse {
  private readonly connections = new Set<() => void>();

  constructor(
    readonly buffer: BoundedEventBuffer,
    private readonly secret: string,
    private readonly heartbeatMilliseconds = 15_000,
  ) {}

  handle(request: IncomingMessage, response: ServerResponse): void {
    const authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;
    if (!hasBearerToken(authorization, this.secret)) {
      response.writeHead(401, { "WWW-Authenticate": "Bearer" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let after: EventCursor | undefined;
    try {
      after = cursorFrom(request.url);
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
      return;
    }

    let cleanup = (): void => undefined;
    const replay = this.buffer.open(after, (event) => {
      if (!response.writableEnded) writeHarnessEvent(response, event);
    });
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    });

    if (replay.type === "resync-required") {
      writeTransportEvent(response, {
        type: "resync-required",
        cursor: replay.cursor,
      });
      response.end();
      return;
    }

    const heartbeat = setInterval(() => {
      writeTransportEvent(response, {
        type: "heartbeat",
        cursor: this.buffer.cursor(),
      });
    }, this.heartbeatMilliseconds);
    heartbeat.unref();
    cleanup = () => {
      clearInterval(heartbeat);
      replay.unsubscribe();
      this.connections.delete(cleanup);
      if (!response.writableEnded) response.end();
    };
    this.connections.add(cleanup);
    request.once("aborted", cleanup);
    response.once("close", cleanup);
    response.once("error", cleanup);

    writeTransportEvent(response, { type: "connected", cursor: replay.cursor });
    for (const event of replay.events) writeHarnessEvent(response, event);
  }

  close(): void {
    for (const cleanup of [...this.connections]) cleanup();
    this.buffer.close();
  }
}

function cursorFrom(requestURL: string | undefined): EventCursor | undefined {
  const url = new URL(requestURL ?? "/events", "http://127.0.0.1");
  const streamID = url.searchParams.get("streamID");
  const after = url.searchParams.get("after");
  if (streamID === null && after === null) return;
  const revision = Number(after);
  if (
    streamID === null ||
    after === null ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw new Error("Invalid event cursor");
  }
  return { streamID, revision };
}

function writeHarnessEvent(
  response: ServerResponse,
  event: RevisionedHarnessEvent,
): void {
  response.write(
    `id: ${event.streamID}:${event.revision}\nevent: harness\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

function writeTransportEvent(
  response: ServerResponse,
  event: DaemonTransportEvent,
): void {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
