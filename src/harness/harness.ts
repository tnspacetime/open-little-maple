/** Application-facing composition and lifetime root. */
import { admitPrompt as admitSessionPrompt } from "./admit-prompt.js";
import { cancelPrompt as cancelSessionPrompt } from "./cancel-prompt.js";
import { configureSessionTurnServices } from "./configure-session-turn-services.js";
import { asError, assertNonempty } from "./json.js";
import type { LiveEvent, LiveEventSink } from "./live-events.js";
import {
  loadTurnServicePlugins,
  type LoadedTurnServicePlugin,
  type TurnServicePluginDeclaration,
} from "./load-turn-service-plugins.js";
import {
  SessionCoordinator,
  type SessionRecoveryResult,
} from "./session-coordinator.js";
import type { Prompt, StoredSessionFact } from "./session-facts.js";
import { SessionRunner } from "./session-runner.js";
import type { SessionState } from "./session-state.js";
import type {
  SessionCatalogPage,
  SessionCatalogQuery,
  SessionStore,
} from "./session-store.js";
import { TurnExecutor, type TurnTextDelta } from "./turn-executor.js";
import type { ConfigureTurnServices } from "./turn-service-configuration.js";
import type { TurnServicePluginFactoryRegistration } from "./turn-service-plugin.js";
import { TurnServiceRegistry } from "./turn-service-registry.js";

export type HarnessOptions = {
  /** Borrowed durable Session boundary; Harness does not close it. */
  readonly store: SessionStore;
  readonly pluginFactories: readonly TurnServicePluginFactoryRegistration[];
  readonly codePluginDeclarations?: readonly TurnServicePluginDeclaration[];
  readonly jsonPluginDeclarations?: unknown;

  /** One globally unique namespace for generated Session, Turn, Step, and fact Ids. */
  readonly nextId: () => string;

  /** Borrowed synchronous publication port for transient live observations. */
  readonly liveEvents?: LiveEventSink;
  readonly onLiveEventFailure?: (
    event: LiveEvent,
    error: Error,
  ) => void | Promise<void>;

  readonly onExecutionFailure: (
    sessionId: string,
    error: Error,
  ) => void | Promise<void>;
  readonly onRecoveryRequired: (
    sessionId: string,
    result: SessionRecoveryResult,
  ) => void | Promise<void>;
};

export type HarnessSession = {
  readonly sessionId: string;
  readonly state: SessionState;
};

export class HarnessNotOpen extends Error {
  override readonly name = "HarnessNotOpen";

  constructor(readonly lifecycle: "closing" | "closed") {
    super(`Harness is ${lifecycle}`);
  }
}

/**
 * Bootstraps live services and composes durable Session commands with
 * process-local execution. It introduces no new projection semantics.
 */
export class Harness {
  private lifecycle: "open" | "closing" | "closed" = "open";
  private closeTask: Promise<void> | undefined;

  private constructor(
    private readonly store: SessionStore,
    private readonly registry: TurnServiceRegistry,
    /** Retained for stable Plugin instance identity and future targeted lifecycle. */
    private readonly loadedPlugins: readonly LoadedTurnServicePlugin[],
    private readonly coordinator: SessionCoordinator,
    private readonly nextId: () => string,
  ) {}

  static async create(options: HarnessOptions): Promise<Harness> {
    if (typeof options.nextId !== "function") {
      throw new Error("Harness nextId must be a function");
    }
    if (typeof options.onExecutionFailure !== "function") {
      throw new Error("Harness onExecutionFailure must be a function");
    }
    if (typeof options.onRecoveryRequired !== "function") {
      throw new Error("Harness onRecoveryRequired must be a function");
    }

    const registry = new TurnServiceRegistry();
    let coordinator: SessionCoordinator | undefined;

    try {
      const loadedPlugins = await loadTurnServicePlugins({
        registry,
        factories: options.pluginFactories,
        ...(options.codePluginDeclarations
          ? { codeDeclarations: options.codePluginDeclarations }
          : {}),
        ...(options.jsonPluginDeclarations !== undefined
          ? { jsonDeclarations: options.jsonPluginDeclarations }
          : {}),
      });
      const publishTextDelta = safeTextDeltaPublisher(options);

      coordinator = new SessionCoordinator({
        createRunner(sessionId) {
          const executor = new TurnExecutor(options.store, sessionId, {
            nextId: options.nextId,
            ...(publishTextDelta ? { onTextDelta: publishTextDelta } : {}),
          });
          return new SessionRunner({
            store: options.store,
            registry,
            executor,
            sessionId,
            nextTurnId: options.nextId,
            nextFactId: options.nextId,
          });
        },
        onFailure: options.onExecutionFailure,
        onRecoveryRequired: options.onRecoveryRequired,
      });

      return new Harness(
        options.store,
        registry,
        loadedPlugins,
        coordinator,
        options.nextId,
      );
    } catch (cause) {
      const failures = [asError(cause)];
      if (coordinator) {
        try {
          await coordinator.close();
        } catch (cleanupCause) {
          failures.push(asError(cleanupCause));
        }
      }
      try {
        await registry.close();
      } catch (cleanupCause) {
        failures.push(asError(cleanupCause));
      }

      if (failures.length === 1) throw failures[0];
      throw new AggregateError(
        failures,
        "Harness construction and cleanup failed",
      );
    }
  }

  async createSession(sessionId?: string): Promise<HarnessSession> {
    this.assertOpen();
    const selectedId = sessionId ?? this.newId("Session");
    assertNonempty(selectedId, "Session Id");
    return {
      sessionId: selectedId,
      state: await this.store.create(selectedId),
    };
  }

  loadedPluginIds(): readonly string[] {
    this.assertOpen();
    return Object.freeze(this.loadedPlugins.map((plugin) => plugin.id));
  }

  async createBranch(
    sessionId: string,
    baseSessionId: string,
    throughSeq: number,
  ): Promise<HarnessSession> {
    this.assertOpen();
    return {
      sessionId,
      state: await this.store.createBranch(
        sessionId,
        baseSessionId,
        throughSeq,
      ),
    };
  }

  state(sessionId: string): Promise<SessionState> {
    this.assertOpen();
    return this.store.read(sessionId);
  }

  /** Read catalog metadata without creating an execution owner or wake. */
  listSessions(query: SessionCatalogQuery): Promise<SessionCatalogPage> {
    this.assertOpen();
    return this.store.listSessions(query);
  }

  facts(sessionId: string): Promise<readonly StoredSessionFact[]> {
    this.assertOpen();
    return this.store.readFacts(sessionId);
  }

  configureTurnServices(
    sessionId: string,
    configure: ConfigureTurnServices,
    signal: AbortSignal,
  ): Promise<SessionState> {
    this.assertOpen();
    return configureSessionTurnServices({
      store: this.store,
      registry: this.registry,
      sessionId,
      configure,
      nextFactId: this.nextId,
      signal,
    });
  }

  async admitPrompt(
    sessionId: string,
    prompt: Prompt,
    signal: AbortSignal,
  ): Promise<SessionState> {
    this.assertOpen();
    const state = await admitSessionPrompt({
      store: this.store,
      sessionId,
      prompt,
      nextFactId: this.nextId,
      signal,
    });

    // Durable ingress always precedes this transient, recoverable wake hint.
    this.coordinator.requestExecution(sessionId);
    return state;
  }

  /** Cancel one queued job, or terminally cancel the active Turn it started. */
  async cancelPrompt(
    sessionId: string,
    promptId: string,
  ): Promise<SessionState> {
    this.assertOpen();
    const result = await cancelSessionPrompt({
      store: this.store,
      sessionId,
      promptId,
      nextFactId: this.nextId,
    });

    // The durable terminal fact is the fence. Local abort and lease release
    // happen afterward and cannot make cancellation disappear.
    if (result.turnId !== undefined) {
      this.coordinator.cancelTurnExecution(sessionId, result.turnId);
    }
    return result.state;
  }

  resumeSession(sessionId: string): void {
    this.assertOpen();
    this.coordinator.requestExecution(sessionId);
  }

  retryBlockedSession(sessionId: string): void {
    this.assertOpen();
    this.coordinator.retryBlockedExecution(sessionId);
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.lifecycle = "closing";

    this.closeTask = (async () => {
      const failures: Error[] = [];
      try {
        await this.coordinator.close();
      } catch (cause) {
        failures.push(asError(cause));
      }
      try {
        await this.registry.close();
      } catch (cause) {
        failures.push(asError(cause));
      }

      this.lifecycle = "closed";
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Harness shutdown failed");
      }
    })();
    return this.closeTask;
  }

  private newId(label: string): string {
    const id = this.nextId();
    assertNonempty(id, `${label} Id`);
    return id;
  }

  private assertOpen(): void {
    if (this.lifecycle !== "open") {
      throw new HarnessNotOpen(this.lifecycle);
    }
  }
}

function safeTextDeltaPublisher(
  options: HarnessOptions,
): ((delta: TurnTextDelta) => undefined) | undefined {
  const sink = options.liveEvents;
  if (!sink) return undefined;

  return (delta) => {
    const event: LiveEvent = { type: "turn.text-delta", ...delta };
    try {
      sink.publish(event);
    } catch (cause) {
      reportLiveEventFailure(options, event, cause);
    }
    return undefined;
  };
}

/** Report sink failure without awaiting or exposing reporter failure. */
function reportLiveEventFailure(
  options: HarnessOptions,
  event: LiveEvent,
  cause: unknown,
): void {
  if (!options.onLiveEventFailure) return;

  try {
    void Promise.resolve(
      options.onLiveEventFailure(event, asError(cause)),
    ).catch(() => undefined);
  } catch {
    // Observation failure must never interrupt Provider consumption.
  }
}
