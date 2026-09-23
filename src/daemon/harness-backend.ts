import { randomUUID } from "node:crypto";

import { Harness } from "../harness/harness.js";
import {
  ToolCallCommitted,
  ToolCallRejected,
  ToolCallSettled,
  type SessionFact,
} from "../harness/session-facts.js";
import type { SessionState } from "../harness/session-state.js";
import {
  deriveSessionActivity,
  type SessionCatalogPage,
  type SessionCatalogQuery,
  type SessionStore,
} from "../harness/session-store.js";
import { SqliteSessionStore } from "../harness/sqlite-session-store.js";
import type { SessionSummary } from "../harness/session.js";
import type { SessionRecoveryResult } from "../harness/session-coordinator.js";
import type { StoredSessionFact } from "../harness/session-facts.js";
import type { SessionExecution } from "./protocol.ts";
import {
  configureDefaultTurnServices,
  runtimePluginDeclaration,
  runtimePluginFactory,
} from "../services/runtime.js";
import type {
  CreateSessionInput,
  DaemonBackend,
  ForkSessionInput,
  SendMessageInput,
  SessionData,
} from "./backend.ts";
import type { HarnessEventHub } from "./events.ts";
import { createSessionView } from "./view.ts";

export type OpenHarnessBackendOptions = {
  readonly databasePath: string;
  readonly eventHub: HarnessEventHub;
  readonly environment?: NodeJS.ProcessEnv;
};

/** Open Little Maple's one canonical durable Harness runtime. */
export async function openHarnessBackend(
  options: OpenHarnessBackendOptions,
): Promise<LittleMapleBackend> {
  const environment = options.environment ?? process.env;
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required. Copy .env.example to .env and add your key.",
    );
  }

  const sqlite = new SqliteSessionStore(options.databasePath);
  const summaries = new Map<string, SessionSummary>();
  const execution = new Map<string, SessionExecution>();
  await loadSummaries(sqlite, summaries);

  const observedStore = new ObservedSessionStore(sqlite, (sessionId, state, fact) => {
    const previous = summaries.get(sessionId);
    if (previous) {
      summaries.set(sessionId, {
        ...previous,
        headSeq: state.seq,
        activity: deriveSessionActivity(state),
      });
    }
    if (deriveSessionActivity(state) === "idle") execution.delete(sessionId);
    if (fact) {
      options.eventHub.emit({
        type: "session.updated",
        sessionID: sessionId,
        headSeq: state.seq,
        change: sessionChange(fact.type),
      });
      emitFactObservation(options.eventHub, sessionId, state, fact);
    }
  });

  const setExecution = (sessionId: string, state: SessionExecution): void => {
    execution.set(sessionId, state);
  };

  let application: Harness | undefined;
  try {
    application = await Harness.create({
      store: observedStore,
      pluginFactories: [runtimePluginFactory(apiKey)],
      codePluginDeclarations: [
        runtimePluginDeclaration({
          model: environment.OPENAI_MODEL?.trim() || "gpt-5.6-luna",
          ...(environment.OPENAI_BASE_URL?.trim()
            ? { baseURL: environment.OPENAI_BASE_URL.trim() }
            : {}),
        }),
      ],
      nextId: randomUUID,
      liveEvents: {
        publish(event) {
          options.eventHub.emit({
            type: "message.delta",
            sessionID: event.sessionId,
            stepID: event.stepId,
            outputIndex: event.outputIndex,
            contentIndex: event.contentIndex,
            delta: event.delta,
          });
          return undefined;
        },
      },
      onExecutionFailure(sessionId, error) {
        setExecution(sessionId, { status: "failed", message: error.message });
        options.eventHub.emit({
          type: "session.error",
          sessionID: sessionId,
          message: error.message,
        });
      },
      onRecoveryRequired(sessionId, result) {
        const message = recoveryMessage(result);
        setExecution(sessionId, { status: "recovery-required", message });
        options.eventHub.emit({
          type: "session.recovery-required",
          sessionID: sessionId,
          message,
        });
      },
    });

    return new LittleMapleBackend(
      application,
      sqlite,
      summaries,
      execution,
    );
  } catch (cause) {
    await application?.close().catch(() => undefined);
    sqlite.close();
    throw cause;
  }
}

export class LittleMapleBackend implements DaemonBackend {
  readonly harnessID = "little-maple";
  readonly capabilities = Object.freeze({
    branchSessions: true,
    cancelPrompts: true,
    resumeSessions: true,
    configureTurnServices: true,
  } as const);

  constructor(
    readonly application: Harness,
    private readonly sqlite: SqliteSessionStore,
    private readonly summaries: Map<string, SessionSummary>,
    private readonly execution: Map<string, SessionExecution>,
  ) {}

  async listSessions(): Promise<readonly SessionSummary[]> {
    await loadSummaries(this.sqlite, this.summaries);
    return Object.freeze(
      [...this.summaries.values()].sort(
        (left, right) =>
          right.createdAt - left.createdAt || right.id.localeCompare(left.id),
      ),
    );
  }

  async createSession(
    input: CreateSessionInput = {},
  ): Promise<SessionSummary> {
    const created = await this.application.createSession(input.id);
    await this.application.configureTurnServices(
      created.sessionId,
      configureDefaultTurnServices,
      new AbortController().signal,
    );
    return this.refreshSummary(created.sessionId);
  }

  async getSession(sessionID: string): Promise<SessionData> {
    const state = await this.application.state(sessionID);
    const session = await this.refreshSummary(sessionID);
    const execution = this.executionState(session, state);
    return {
      session,
      state,
      execution,
      view: createSessionView(state, execution.status === "running"),
      historyLength: state.seq,
    };
  }

  async branchSession(
    parentSessionID: string,
    input: ForkSessionInput = {},
  ): Promise<SessionSummary> {
    const parent = await this.application.state(parentSessionID);
    const sessionID = input.id ?? randomUUID();
    await this.application.createBranch(
      sessionID,
      parentSessionID,
      input.throughSeq ?? parent.seq,
    );
    return this.refreshSummary(sessionID);
  }

  async sendMessage(
    sessionID: string,
    input: SendMessageInput,
  ): Promise<{ inputID: string }> {
    const state = await this.application.state(sessionID);
    const activity = deriveSessionActivity(state);
    const execution = this.execution.get(sessionID);
    if (!execution && activity !== "idle") {
      throw new Error(
        `Session ${sessionID} is paused; resume or cancel it before admitting new work`,
      );
    }
    if (
      execution?.status === "recovery-required" ||
      execution?.status === "failed"
    ) {
      throw new Error(
        `Session ${sessionID} is ${execution.status}; resolve or cancel it before admitting new work`,
      );
    }

    const inputID = input.id ?? randomUUID();
    const previous = execution;
    this.execution.set(sessionID, { status: "running" });
    try {
      await this.application.admitPrompt(
        sessionID,
        {
          id: inputID,
          mode: input.delivery ?? "queue",
          parts: input.parts,
        },
        new AbortController().signal,
      );
      return { inputID };
    } catch (cause) {
      if (previous) this.execution.set(sessionID, previous);
      else this.execution.delete(sessionID);
      throw cause;
    }
  }

  async cancelPrompt(sessionID: string, promptID: string): Promise<void> {
    await this.application.cancelPrompt(sessionID, promptID);
  }

  async resumeSession(sessionID: string): Promise<void> {
    const state = await this.application.state(sessionID);
    if (deriveSessionActivity(state) === "idle") return;
    this.execution.set(sessionID, { status: "running" });
    this.application.resumeSession(sessionID);
  }

  async retryBlockedSession(sessionID: string): Promise<void> {
    await this.application.state(sessionID);
    this.execution.set(sessionID, { status: "running" });
    this.application.retryBlockedSession(sessionID);
  }

  async close(): Promise<void> {
    try {
      await this.application.close();
    } finally {
      this.sqlite.close();
    }
  }

  private executionState(
    session: SessionSummary,
    state: SessionState,
  ): SessionExecution {
    const current = this.execution.get(session.id);
    if (current) return current;
    return deriveSessionActivity(state) === "idle"
      ? { status: "idle" }
      : { status: "paused" };
  }

  private async refreshSummary(sessionID: string): Promise<SessionSummary> {
    await loadSummaries(this.sqlite, this.summaries);
    const summary = this.summaries.get(sessionID);
    if (!summary) throw new Error(`Session not found: ${sessionID}`);
    return summary;
  }
}

class ObservedSessionStore implements SessionStore {
  constructor(
    private readonly inner: SessionStore,
    private readonly changed: (
      sessionId: string,
      state: SessionState,
      fact?: SessionFact,
    ) => void,
  ) {}

  async create(sessionId: string): Promise<SessionState> {
    const state = await this.inner.create(sessionId);
    this.changed(sessionId, state);
    return state;
  }

  async createBranch(
    sessionId: string,
    baseSessionId: string,
    throughSeq: number,
  ): Promise<SessionState> {
    const state = await this.inner.createBranch(
      sessionId,
      baseSessionId,
      throughSeq,
    );
    this.changed(sessionId, state);
    return state;
  }

  read(sessionId: string): Promise<SessionState> {
    return this.inner.read(sessionId);
  }

  listSessions(query: SessionCatalogQuery): Promise<SessionCatalogPage> {
    return this.inner.listSessions(query);
  }

  readFacts(sessionId: string): Promise<readonly StoredSessionFact[]> {
    return this.inner.readFacts(sessionId);
  }

  async append(
    sessionId: string,
    expectedSeq: number,
    fact: SessionFact,
  ): Promise<SessionState> {
    const state = await this.inner.append(sessionId, expectedSeq, fact);
    this.changed(sessionId, state, fact);
    return state;
  }
}

async function loadSummaries(
  store: SessionStore,
  destination: Map<string, SessionSummary>,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await store.listSessions({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const summary of page.sessions) destination.set(summary.id, summary);
    cursor = page.nextCursor;
  } while (cursor);
}

function recoveryMessage(result: SessionRecoveryResult): string {
  return result.requirements
    .map((requirement) =>
      requirement.type === "provider-outcome-unknown"
        ? `Step ${requirement.stepId}: ${requirement.error}`
        : `Step ${requirement.stepId}, Tool ${requirement.callId}: ${requirement.error}`,
    )
    .join("\n");
}

function sessionChange(type: string): "input-admitted" | "run-started" | "run-finished" | "other" {
  if (type === "prompt.admitted") return "input-admitted";
  if (type === "step.committed") return "run-started";
  if (type === "turn.settled") return "run-finished";
  return "other";
}

function emitFactObservation(
  eventHub: HarnessEventHub,
  sessionId: string,
  state: SessionState,
  fact: SessionFact,
): void {
  if (fact.type === ToolCallCommitted.type) {
    const committed = ToolCallCommitted.decode(fact.data);
    const name = findToolName(
      state,
      committed.turnId,
      committed.stepId,
      committed.callId,
    );
    if (!name) return;
    eventHub.emit({
      type: "tool.started",
      sessionID: sessionId,
      stepID: committed.stepId,
      callID: committed.callId,
      name,
    });
    return;
  }

  if (fact.type === ToolCallSettled.type) {
    const settled = ToolCallSettled.decode(fact.data);
    const name = findToolName(
      state,
      settled.turnId,
      settled.stepId,
      settled.callId,
    );
    if (!name) return;
    eventHub.emit({
      type: "tool.completed",
      sessionID: sessionId,
      stepID: settled.stepId,
      callID: settled.callId,
      name,
      outcome: settled.outcome,
    });
    return;
  }

  if (fact.type === ToolCallRejected.type) {
    const rejected = ToolCallRejected.decode(fact.data);
    const name = findToolName(
      state,
      rejected.turnId,
      rejected.stepId,
      rejected.callId,
    );
    if (!name) return;
    eventHub.emit({
      type: "tool.completed",
      sessionID: sessionId,
      stepID: rejected.stepId,
      callID: rejected.callId,
      name,
      outcome: "error",
    });
  }
}

function findToolName(
  state: SessionState,
  turnId: string,
  stepId: string,
  callId: string,
): string | undefined {
  const tool = state.turns
    .find((turn) => turn.turnId === turnId)
    ?.steps.find((step) => step.stepId === stepId)
    ?.toolCalls.find((candidate) => candidate.callId === callId);
  return tool?.name;
}
