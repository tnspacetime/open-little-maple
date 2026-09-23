import type { DaemonDiscovery } from "../daemon/discovery.ts";
import type { DaemonTransportEvent } from "../daemon/sse.ts";
import type {
  EventCursor,
  RevisionedHarnessEvent,
} from "../daemon/protocol.ts";

export type EventStreamResult =
  | { type: "ended" }
  | { type: "resync"; cursor: EventCursor };

export async function readHarnessEventStream(options: {
  discovery: DaemonDiscovery;
  after: EventCursor;
  signal: AbortSignal;
  connected(): void;
  event(event: RevisionedHarnessEvent): void;
}): Promise<EventStreamResult> {
  const url = new URL("/events", options.discovery.origin);
  url.searchParams.set("streamID", options.after.streamID);
  url.searchParams.set("after", String(options.after.revision));

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${options.discovery.secret}` },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Event stream returned ${response.status}`);
  }
  if (!response.body) throw new Error("Event stream returned no body");

  let cursor = options.after;
  for await (const frame of sseFrames(response.body)) {
    if (frame.event === "connected") {
      const connected = transportEvent(frame.data, "connected");
      if (connected.cursor.streamID !== cursor.streamID) {
        throw new Error("Connected to an unexpected event stream");
      }
      options.connected();
      continue;
    }
    if (frame.event === "heartbeat") continue;
    if (frame.event === "resync-required") {
      const resync = transportEvent(frame.data, "resync-required");
      return { type: "resync", cursor: resync.cursor };
    }
    if (frame.event !== "harness") continue;

    const event = harnessEvent(frame.data);
    if (
      event.streamID !== cursor.streamID ||
      event.revision !== cursor.revision + 1
    ) {
      throw new Error("Event stream cursor was not sequential");
    }
    cursor = { streamID: event.streamID, revision: event.revision };
    options.event(event);
  }
  return { type: "ended" };
}

type SseFrame = { event: string; data: string };

async function* sseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const match = /\r?\n\r?\n/.exec(buffered);
        if (match?.index === undefined) break;
        const raw = buffered.slice(0, match.index);
        buffered = buffered.slice(match.index + match[0].length);
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseFrame(raw: string): SseFrame | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trimStart();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length === 0 ? undefined : { event, data: data.join("\n") };
}

function harnessEvent(data: string): RevisionedHarnessEvent {
  const value = JSON.parse(data) as Partial<RevisionedHarnessEvent>;
  if (
    typeof value.streamID !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.event !== "object" ||
    value.event === null
  ) {
    throw new Error("Invalid harness event");
  }
  return value as RevisionedHarnessEvent;
}

function transportEvent<Type extends DaemonTransportEvent["type"]>(
  data: string,
  type: Type,
): Extract<DaemonTransportEvent, { type: Type }> {
  const value = JSON.parse(data) as Partial<DaemonTransportEvent>;
  if (value.type !== type || !value.cursor) {
    throw new Error(`Invalid ${type} event`);
  }
  return value as Extract<DaemonTransportEvent, { type: Type }>;
}
