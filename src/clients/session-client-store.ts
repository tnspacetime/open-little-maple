import type {
  Delivery,
  HarnessEvent,
  PromptPart,
  RevisionedHarnessEvent,
} from "../daemon/protocol.ts";
import type {
  SessionSnapshot,
  SessionWatchUpdate,
} from "./harness-client.ts";

export type SessionSynchronizationPhase = "loading" | "ready" | "error";

export type SessionSynchronization = Readonly<{
  sessionID: string;
  phase: SessionSynchronizationPhase;
  snapshot: SessionSnapshot | undefined;
  snapshotReason: "initial" | "resync" | "refresh" | undefined;
  events: readonly RevisionedHarnessEvent[];
  latestEvent: RevisionedHarnessEvent | undefined;
  running: boolean;
  error: Error | undefined;
  version: number;
}>;

export interface SessionStateClient {
  watchSession(
    sessionID: string,
    listener: (update: SessionWatchUpdate) => void,
  ): Promise<() => void>;
  getSession(sessionID: string): Promise<SessionSnapshot>;
  sendMessage(
    sessionID: string,
    input: {
      id?: string;
      parts: readonly PromptPart[];
      delivery?: Delivery;
    },
  ): Promise<unknown>;
  sendText(
    sessionID: string,
    text: string,
    options?: { id?: string; delivery?: Delivery },
  ): Promise<unknown>;
  cancelPrompt(sessionID: string, promptID: string): Promise<unknown>;
  resumeSession(sessionID: string): Promise<unknown>;
  retryBlockedSession(sessionID: string): Promise<unknown>;
}

type Listener = () => void;

type Entry = {
  state: SessionSynchronization;
  listeners: Set<Listener>;
  watchGeneration: number;
  refreshGeneration: number;
  stopWatch: (() => void) | undefined;
};

export class SessionClientStore {
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  constructor(private readonly client: SessionStateClient) {}

  state(sessionID: string): SessionSynchronization {
    return this.entry(sessionID).state;
  }

  subscribe(sessionID: string, listener: Listener): () => void {
    this.assertOpen();
    const entry = this.entry(sessionID);
    entry.listeners.add(listener);
    if (entry.listeners.size === 1) this.startWatch(sessionID, entry);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) this.stopWatch(entry);
    };
  }

  async send(
    sessionID: string,
    input: {
      id?: string;
      parts: readonly PromptPart[];
      delivery?: Delivery;
    },
  ): Promise<void> {
    const entry = this.requireEntry(sessionID);
    this.publish(entry, {
      ...entry.state,
      phase: entry.state.snapshot ? "ready" : "loading",
      running: true,
      error: undefined,
    });
    try {
      await this.client.sendMessage(sessionID, input);
      await this.refreshEntry(sessionID, entry);
    } catch (cause) {
      this.fail(entry, cause);
      throw asError(cause);
    }
  }

  async sendText(
    sessionID: string,
    text: string,
    options: { id?: string; delivery?: Delivery } = {},
  ): Promise<void> {
    const entry = this.requireEntry(sessionID);
    this.publish(entry, {
      ...entry.state,
      phase: entry.state.snapshot ? "ready" : "loading",
      running: true,
      error: undefined,
    });
    try {
      await this.client.sendText(sessionID, text, options);
      await this.refreshEntry(sessionID, entry);
    } catch (cause) {
      this.fail(entry, cause);
      throw asError(cause);
    }
  }

  async refresh(sessionID: string): Promise<void> {
    const entry = this.requireEntry(sessionID);
    await this.refreshEntry(sessionID, entry);
  }

  async cancel(sessionID: string): Promise<void> {
    const entry = this.requireEntry(sessionID);
    const promptID = cancellationPromptId(entry.state.snapshot);
    if (!promptID) return;
    try {
      await this.client.cancelPrompt(sessionID, promptID);
      await this.refreshEntry(sessionID, entry);
    } catch (cause) {
      this.fail(entry, cause);
      throw asError(cause);
    }
  }

  async resume(sessionID: string): Promise<void> {
    const entry = this.requireEntry(sessionID);
    const recoveryRequired =
      entry.state.snapshot?.execution.status === "recovery-required";
    try {
      if (recoveryRequired) await this.client.retryBlockedSession(sessionID);
      else await this.client.resumeSession(sessionID);
      await this.refreshEntry(sessionID, entry);
    } catch (cause) {
      this.fail(entry, cause);
      throw asError(cause);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries.values()) this.stopWatch(entry);
    this.entries.clear();
  }

  private entry(sessionID: string): Entry {
    const existing = this.entries.get(sessionID);
    if (existing) return existing;
    const entry: Entry = {
      state: {
        sessionID,
        phase: "loading",
        snapshot: undefined,
        snapshotReason: undefined,
        events: [],
        latestEvent: undefined,
        running: false,
        error: undefined,
        version: 0,
      },
      listeners: new Set(),
      watchGeneration: 0,
      refreshGeneration: 0,
      stopWatch: undefined,
    };
    this.entries.set(sessionID, entry);
    return entry;
  }

  private requireEntry(sessionID: string): Entry {
    this.assertOpen();
    return this.entry(sessionID);
  }

  private startWatch(sessionID: string, entry: Entry): void {
    const generation = ++entry.watchGeneration;
    void this.client
      .watchSession(sessionID, (update) => {
        if (
          this.closed ||
          entry.watchGeneration !== generation ||
          entry.listeners.size === 0
        ) {
          return;
        }
        this.receive(sessionID, entry, update);
      })
      .then((stop) => {
        if (
          this.closed ||
          entry.watchGeneration !== generation ||
          entry.listeners.size === 0
        ) {
          stop();
          return;
        }
        entry.stopWatch = stop;
      })
      .catch((cause) => {
        if (entry.watchGeneration === generation) this.fail(entry, cause);
      });
  }

  private stopWatch(entry: Entry): void {
    entry.watchGeneration += 1;
    entry.stopWatch?.();
    entry.stopWatch = undefined;
  }

  private receive(
    sessionID: string,
    entry: Entry,
    update: SessionWatchUpdate,
  ): void {
    if (update.type === "error") {
      this.fail(entry, update.error);
      return;
    }
    if (update.type === "snapshot") {
      this.applySnapshot(entry, update.snapshot, update.reason);
      return;
    }

    const envelope = update.envelope;
    const event = envelope.event;
    this.publish(entry, {
      ...entry.state,
      phase: "ready",
      events: [...entry.state.events, envelope],
      latestEvent: envelope,
      running: runningAfterEvent(entry.state.running, event),
      ...(event.type === "session.error" ||
      event.type === "session.recovery-required"
        ? { error: new Error(event.message) }
        : { error: undefined }),
    });

    if (event.type === "session.updated") {
      void this.refreshEntry(sessionID, entry).catch(() => undefined);
    }
  }

  private async refreshEntry(sessionID: string, entry: Entry): Promise<void> {
    const generation = ++entry.refreshGeneration;
    try {
      const snapshot = await this.client.getSession(sessionID);
      if (this.closed || entry.refreshGeneration !== generation) return;
      this.applySnapshot(entry, snapshot, "refresh");
    } catch (cause) {
      if (this.closed || entry.refreshGeneration !== generation) return;
      this.fail(entry, cause);
      throw asError(cause);
    }
  }

  private applySnapshot(
    entry: Entry,
    snapshot: SessionSnapshot,
    reason: "initial" | "resync" | "refresh",
  ): void {
    const current = entry.state.snapshot;
    if (
      current?.cursor.streamID === snapshot.cursor.streamID &&
      current.cursor.revision > snapshot.cursor.revision
    ) {
      return;
    }
    this.publish(entry, {
      ...entry.state,
      phase: "ready",
      snapshot,
      snapshotReason: reason,
      events: compactEvents(entry.state.events, snapshot),
      running: snapshotIsRunning(snapshot),
      error: executionError(snapshot),
    });
  }

  private fail(entry: Entry, cause: unknown): void {
    this.publish(entry, {
      ...entry.state,
      phase: "error",
      running: false,
      error: asError(cause),
    });
  }

  private publish(
    entry: Entry,
    next: Omit<SessionSynchronization, "version"> & { version?: number },
  ): void {
    entry.state = Object.freeze({
      ...next,
      events: Object.freeze([...next.events]),
      version: entry.state.version + 1,
    });
    for (const listener of entry.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("Session state listener failed", error);
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Session client store is closed");
  }
}

function compactEvents(
  events: readonly RevisionedHarnessEvent[],
  snapshot: SessionSnapshot,
): RevisionedHarnessEvent[] {
  return events.filter((envelope) => {
    if (
      envelope.streamID === snapshot.cursor.streamID &&
      envelope.revision > snapshot.cursor.revision
    ) {
      return true;
    }

    const event = envelope.event;
    if (event.type === "message.delta") {
      const step = snapshot.view.transcript.find(
        (candidate) =>
          candidate.kind === "assistant" && candidate.stepID === event.stepID,
      );
      return step?.kind !== "assistant" || step.status !== "complete";
    }
    if (event.type === "permission.requested" || event.type === "session.error") {
      return true;
    }
    if (event.type === "tool.started" || event.type === "tool.completed") {
      return !snapshot.view.transcript.some(
        (entry) => entry.kind === "tool" && entry.callID === event.callID,
      );
    }
    return false;
  });
}

function snapshotIsRunning(snapshot: SessionSnapshot): boolean {
  return snapshot.execution.status === "running";
}

function executionError(snapshot: SessionSnapshot): Error | undefined {
  return snapshot.execution.status === "failed" ||
    snapshot.execution.status === "recovery-required"
    ? new Error(snapshot.execution.message)
    : undefined;
}

function runningAfterEvent(current: boolean, event: HarnessEvent): boolean {
  if (
    event.type === "session.error" ||
    event.type === "session.recovery-required"
  ) return false;
  if (event.type !== "session.updated") return current;
  if (
    event.change === "input-admitted" ||
    event.change === "run-started"
  ) {
    return true;
  }
  if (event.change === "run-finished") return false;
  return current;
}

function cancellationPromptId(snapshot: SessionSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined;
  const activeTurn = snapshot.state.turns.find((turn) => turn.status === "active");
  if (activeTurn) return activeTurn.promptId;
  return snapshot.state.prompts.find(
    ({ prompt, status }) => prompt.mode === "queue" && status === "pending",
  )?.prompt.id;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
