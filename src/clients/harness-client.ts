import { createClient } from "better-call/client";

import type { DaemonRouter } from "../daemon/api.ts";
import {
  daemonProtocolVersion,
  type DaemonDiscovery,
} from "../daemon/discovery.ts";
import type {
  Delivery,
  EventCursor,
  HarnessEvent,
  JsonValue,
  PromptPart,
  RevisionedHarnessEvent,
  SessionSnapshot,
} from "../daemon/protocol.ts";
import { readHarnessEventStream } from "./event-stream.ts";

export type DaemonLocator = () => Promise<DaemonDiscovery | undefined>;
export type HarnessClientStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export type { SessionSnapshot } from "../daemon/protocol.ts";

export type HarnessClientNotification =
  | { type: "connection"; status: HarnessClientStatus; error?: Error }
  | { type: "event"; envelope: RevisionedHarnessEvent }
  | { type: "resync"; cursor: EventCursor };

export type SessionWatchUpdate =
  | {
      type: "snapshot";
      reason: "initial" | "resync";
      snapshot: SessionSnapshot;
    }
  | { type: "event"; envelope: RevisionedHarnessEvent }
  | { type: "error"; error: Error };

export type HarnessClientOptions = {
  reconnectDelayMilliseconds?: number;
  maximumReconnectDelayMilliseconds?: number;
};

type Watcher = {
  sessionID: string;
  listener(update: SessionWatchUpdate): void;
  active: boolean;
  ready: boolean;
  load: number;
  cursor?: EventCursor;
  pending: RevisionedHarnessEvent[];
};

export class DaemonNotFoundError extends Error {
  constructor() {
    super("No running Little Maple daemon was discovered");
    this.name = "DaemonNotFoundError";
  }
}

export class HarnessClient {
  private readonly locator: DaemonLocator | undefined;
  private readonly reconnectDelayMilliseconds: number;
  private readonly maximumReconnectDelayMilliseconds: number;
  private readonly listeners = new Set<
    (notification: HarnessClientNotification) => void
  >();
  private readonly watchers = new Set<Watcher>();
  private readonly stop = new AbortController();

  private discoveryValue: DaemonDiscovery | undefined;
  private rpc: ReturnType<typeof daemonRpc> | undefined;
  private cursorValue: EventCursor | undefined;
  private eventTask: Promise<void> | undefined;
  private eventRequest: AbortController | undefined;
  private statusValue: HarnessClientStatus = "idle";
  private reconnectAttempt = 0;

  constructor(
    private readonly source: DaemonDiscovery | DaemonLocator,
    options: HarnessClientOptions = {},
  ) {
    this.locator = typeof source === "function" ? source : undefined;
    this.reconnectDelayMilliseconds =
      options.reconnectDelayMilliseconds ?? 100;
    this.maximumReconnectDelayMilliseconds =
      options.maximumReconnectDelayMilliseconds ?? 2_000;
  }

  status(): HarnessClientStatus {
    return this.statusValue;
  }

  discovery(): DaemonDiscovery | undefined {
    return this.discoveryValue && { ...this.discoveryValue };
  }

  cursor(): EventCursor | undefined {
    return this.cursorValue && { ...this.cursorValue };
  }

  async start(): Promise<void> {
    if (this.statusValue !== "idle") {
      throw new Error(`Harness client cannot start from ${this.statusValue}`);
    }
    const discovery = await this.locate();
    this.useDiscovery(discovery);
    this.setStatus("connecting");
    try {
      const health = await this.requireRpc()("/health");
      if (
        health.pid !== discovery.pid ||
        health.harnessID !== discovery.harnessID ||
        health.cursor.streamID !== discovery.streamID
      ) {
        throw new Error("Daemon discovery did not match daemon health");
      }
      this.cursorValue = health.cursor;
      this.eventTask = this.runEvents();
    } catch (error) {
      this.statusValue = "idle";
      throw error;
    }
  }

  subscribe(listener: (notification: HarnessClientNotification) => void): () => void {
    this.listeners.add(listener);
    this.call(listener, { type: "connection", status: this.statusValue });
    return () => this.listeners.delete(listener);
  }

  async waitUntilConnected(signal?: AbortSignal): Promise<void> {
    if (this.statusValue === "connected") return;
    if (this.statusValue === "closed") throw new Error("Harness client is closed");
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = (): void => undefined;
      const abort = (): void => {
        unsubscribe();
        reject(signal?.reason ?? new Error("Connection wait aborted"));
      };
      unsubscribe = this.subscribe((notification) => {
        if (notification.type !== "connection") return;
        if (notification.status === "connected") {
          signal?.removeEventListener("abort", abort);
          unsubscribe();
          resolve();
        }
        if (notification.status === "closed") abort();
      });
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  health() {
    this.assertStarted();
    return this.requireRpc()("/health");
  }

  listSessions() {
    this.assertStarted();
    return this.requireRpc()("/sessions");
  }

  createSession(input: { id?: string } = {}) {
    this.assertStarted();
    return this.requireRpc()("@post/sessions", {
      body: {
        ...(input.id ? { id: input.id } : {}),
      },
    });
  }

  forkSession(
    parentSessionID: string,
    input: { id?: string; throughSeq?: number } = {},
  ) {
    this.assertStarted();
    return this.requireRpc()("@post/sessions/:sessionID/forks", {
      params: { sessionID: parentSessionID },
      body: {
        ...(input.id ? { id: input.id } : {}),
        ...(input.throughSeq === undefined
          ? {}
          : { throughSeq: input.throughSeq }),
      },
    });
  }

  getSession(sessionID: string): Promise<SessionSnapshot> {
    this.assertStarted();
    return this.requireRpc()("/sessions/:sessionID", {
      params: { sessionID },
    });
  }

  sendMessage(
    sessionID: string,
    input: { id?: string; parts: readonly PromptPart[]; delivery?: Delivery },
  ) {
    this.assertStarted();
    return this.requireRpc()("@post/sessions/:sessionID/messages", {
      params: { sessionID },
      body: {
        parts: input.parts.map((part) => ({ ...part })) as Array<
          Record<string, JsonValue>
        >,
        ...(input.id ? { id: input.id } : {}),
        ...(input.delivery ? { delivery: input.delivery } : {}),
      },
    });
  }

  sendText(
    sessionID: string,
    text: string,
    options: { id?: string; delivery?: Delivery } = {},
  ) {
    return this.sendMessage(sessionID, {
      ...options,
      parts: [{ type: "input_text", text }],
    });
  }

  cancelPrompt(sessionID: string, promptID: string) {
    this.assertStarted();
    return this.requireRpc()(
      "@post/sessions/:sessionID/prompts/:promptID/cancel",
      { params: { sessionID, promptID } },
    );
  }

  resumeSession(sessionID: string) {
    this.assertStarted();
    return this.requireRpc()("@post/sessions/:sessionID/resume", {
      params: { sessionID },
    });
  }

  retryBlockedSession(sessionID: string) {
    this.assertStarted();
    return this.requireRpc()("@post/sessions/:sessionID/retry-blocked", {
      params: { sessionID },
    });
  }

  async watchSession(
    sessionID: string,
    listener: (update: SessionWatchUpdate) => void,
  ): Promise<() => void> {
    this.assertStarted();
    const watcher: Watcher = {
      sessionID,
      listener,
      active: true,
      ready: false,
      load: 0,
      pending: [],
    };
    this.watchers.add(watcher);
    try {
      await this.loadWatcher(watcher, "initial");
    } catch (error) {
      this.watchers.delete(watcher);
      throw error;
    }
    return () => {
      watcher.active = false;
      watcher.load += 1;
      this.watchers.delete(watcher);
    };
  }

  reconnect(): void {
    this.assertStarted();
    this.eventRequest?.abort(new Error("Reconnect requested"));
  }

  async close(): Promise<void> {
    if (this.statusValue === "closed") return;
    this.stop.abort(new Error("Harness client closed"));
    this.eventRequest?.abort(this.stop.signal.reason);
    await this.eventTask?.catch(() => undefined);
    for (const watcher of this.watchers) watcher.active = false;
    this.watchers.clear();
    this.setStatus("closed");
  }

  private async runEvents(): Promise<void> {
    while (!this.stop.signal.aborted) {
      const after = this.cursorValue;
      if (!after) return;
      const request = new AbortController();
      this.eventRequest = request;
      try {
        const result = await readHarnessEventStream({
          discovery: this.requireDiscovery(),
          after,
          signal: request.signal,
          connected: () => {
            this.reconnectAttempt = 0;
            this.setStatus("connected");
          },
          event: (envelope) => {
            this.cursorValue = {
              streamID: envelope.streamID,
              revision: envelope.revision,
            };
            this.notify({ type: "event", envelope });
            this.dispatch(envelope);
          },
        });
        if (result.type === "resync") {
          this.notify({ type: "resync", cursor: result.cursor });
          this.cursorValue = await this.refreshWatchers();
          continue;
        }
        throw new Error("Event stream ended");
      } catch (cause) {
        if (this.stop.signal.aborted) break;
        this.reconnectAttempt += 1;
        this.setStatus("reconnecting", asError(cause));
        await this.rediscover();
        await delay(this.reconnectDelay(), this.stop.signal).catch(() => undefined);
      } finally {
        if (this.eventRequest === request) this.eventRequest = undefined;
      }
    }
  }

  private dispatch(envelope: RevisionedHarnessEvent): void {
    const sessionID = eventSessionID(envelope.event);
    for (const watcher of this.watchers) {
      if (!watcher.active || watcher.sessionID !== sessionID) continue;
      if (!watcher.ready) {
        watcher.pending.push(envelope);
        continue;
      }
      if (
        watcher.cursor?.streamID === envelope.streamID &&
        envelope.revision > watcher.cursor.revision
      ) {
        watcher.cursor = {
          streamID: envelope.streamID,
          revision: envelope.revision,
        };
        this.callWatch(watcher, { type: "event", envelope });
      }
    }
  }

  private async loadWatcher(
    watcher: Watcher,
    reason: "initial" | "resync",
  ): Promise<SessionSnapshot | undefined> {
    const load = ++watcher.load;
    watcher.ready = false;
    watcher.pending = [];
    try {
      const snapshot = await this.getSession(watcher.sessionID);
      if (!watcher.active || watcher.load !== load) return;
      watcher.cursor = snapshot.cursor;
      this.callWatch(watcher, { type: "snapshot", reason, snapshot });
      for (const event of watcher.pending) {
        if (
          event.streamID === watcher.cursor.streamID &&
          event.revision > watcher.cursor.revision
        ) {
          watcher.cursor = {
            streamID: event.streamID,
            revision: event.revision,
          };
          this.callWatch(watcher, { type: "event", envelope: event });
        }
      }
      watcher.pending = [];
      watcher.ready = true;
      return snapshot;
    } catch (cause) {
      const error = asError(cause);
      this.callWatch(watcher, { type: "error", error });
      throw error;
    }
  }

  private async refreshWatchers(): Promise<EventCursor> {
    const snapshots = await Promise.all(
      [...this.watchers]
        .filter((watcher) => watcher.active)
        .map((watcher) => this.loadWatcher(watcher, "resync")),
    );
    const cursors = snapshots.flatMap((snapshot) =>
      snapshot ? [snapshot.cursor] : [],
    );
    if (cursors.length === 0) return (await this.health()).cursor;
    const streamID = cursors[0]!.streamID;
    if (cursors.some((cursor) => cursor.streamID !== streamID)) {
      throw new Error("Snapshots came from different daemon streams");
    }
    return {
      streamID,
      revision: Math.min(...cursors.map((cursor) => cursor.revision)),
    };
  }

  private async rediscover(): Promise<void> {
    if (!this.locator) return;
    const discovery = await this.locator().catch(() => undefined);
    if (discovery) this.useDiscovery(validDiscovery(discovery));
  }

  private async locate(): Promise<DaemonDiscovery> {
    const discovery =
      typeof this.source === "function" ? await this.source() : this.source;
    if (!discovery) throw new DaemonNotFoundError();
    return validDiscovery(discovery);
  }

  private useDiscovery(discovery: DaemonDiscovery): void {
    this.discoveryValue = discovery;
    this.rpc = daemonRpc(discovery);
  }

  private requireRpc(): ReturnType<typeof daemonRpc> {
    if (!this.rpc) throw new Error("Harness client has not started");
    return this.rpc;
  }

  private requireDiscovery(): DaemonDiscovery {
    if (!this.discoveryValue) throw new Error("Harness client has not started");
    return this.discoveryValue;
  }

  private assertStarted(): void {
    if (this.statusValue === "idle" || this.statusValue === "closed") {
      throw new Error(`Harness client is ${this.statusValue}`);
    }
  }

  private setStatus(status: HarnessClientStatus, error?: Error): void {
    this.statusValue = status;
    this.notify({
      type: "connection",
      status,
      ...(error ? { error } : {}),
    });
  }

  private notify(notification: HarnessClientNotification): void {
    for (const listener of this.listeners) this.call(listener, notification);
  }

  private call(
    listener: (notification: HarnessClientNotification) => void,
    notification: HarnessClientNotification,
  ): void {
    try {
      listener(notification);
    } catch (error) {
      console.error("Harness client listener failed", error);
    }
  }

  private callWatch(watcher: Watcher, update: SessionWatchUpdate): void {
    if (!watcher.active) return;
    try {
      watcher.listener(update);
    } catch (error) {
      console.error("Session watcher failed", error);
    }
  }

  private reconnectDelay(): number {
    return Math.min(
      this.maximumReconnectDelayMilliseconds,
      this.reconnectDelayMilliseconds * 2 ** (this.reconnectAttempt - 1),
    );
  }
}

export async function connectHarnessClient(
  source: DaemonDiscovery | DaemonLocator,
  options: HarnessClientOptions = {},
): Promise<HarnessClient> {
  const client = new HarnessClient(source, options);
  await client.start();
  return client;
}

function daemonRpc(discovery: DaemonDiscovery) {
  return createClient<
    DaemonRouter,
    {
      baseURL: string;
      headers: { authorization: `Bearer ${string}` };
      throw: true;
    }
  >({
    baseURL: discovery.origin,
    headers: { authorization: `Bearer ${discovery.secret}` },
    throw: true,
  });
}

function validDiscovery(discovery: DaemonDiscovery): DaemonDiscovery {
  const origin = new URL(discovery.origin);
  if (
    discovery.protocolVersion !== daemonProtocolVersion ||
    !discovery.harnessID.trim() ||
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    !origin.port
  ) {
    throw new Error("Daemon origin must be loopback-only HTTP");
  }
  return { ...discovery, origin: origin.origin };
}

function eventSessionID(event: HarnessEvent): string {
  return event.type === "session.created" ? event.session.id : event.sessionID;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
