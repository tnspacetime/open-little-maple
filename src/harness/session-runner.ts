/** Process-local owner and execution loop for one Session. */
import { assertNonempty } from "./json.js";
import {
  ActiveTurnUnavailable,
  restoreTurnRuntime,
} from "./restore-turn-runtime.js";
import type { SessionState } from "./session-state.js";
import type { SessionStore } from "./session-store.js";
import { startTurn } from "./start-turn.js";
import {
  type TurnExecutor,
  type TurnRecoveryRequirement,
} from "./turn-executor.js";
import type { TurnServiceRegistry } from "./turn-service-registry.js";
import type { TurnRuntime } from "./turn-runtime.js";

export type SessionRunnerOptions = {
  readonly store: SessionStore;
  readonly registry: TurnServiceRegistry;
  /** The already Session-bound TurnExecutor owned by this runner. */
  readonly executor: TurnExecutor;
  readonly sessionId: string;
  readonly nextTurnId: () => string;
  readonly nextFactId: () => string;
};

export type SessionRunResult =
  | {
      readonly status: "idle";
      readonly state: SessionState;
    }
  | {
      readonly status: "recovery-required";
      readonly state: SessionState;
      readonly requirements: readonly TurnRecoveryRequirement[];
    };

/** No new work may be started after this local Session owner is closed. */
export class SessionRunnerClosed extends Error {
  override readonly name = "SessionRunnerClosed";

  constructor(readonly sessionId: string) {
    super(`Session runner is closed: ${sessionId}`);
  }
}

/**
 * Owns at most one process-local TurnRuntime and drives queued Turns until the
 * Session is idle or explicit recovery is required.
 *
 * The Harness must create at most one SessionRunner per Session. Calls on this
 * instance are coalesced, but cross-instance or cross-process fencing is not
 * provided by the current in-memory architecture. When recovery or failure
 * leaves an active runtime retained, the caller must keep this runner and
 * either run it again or close it; dropping the runner would leak its lease.
 */
export class SessionRunner {
  private runtime: TurnRuntime | undefined;
  private running: Promise<SessionRunResult> | undefined;
  private controller: AbortController | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: SessionRunnerOptions) {
    assertNonempty(options.sessionId, "Session Id");
  }

  /**
   * Return the existing run when called concurrently. Cancellation belongs to
   * this runner and is initiated only by close(), not by an individual caller.
   */
  runUntilBlocked(): Promise<SessionRunResult> {
    if (this.closed) {
      return Promise.reject(new SessionRunnerClosed(this.options.sessionId));
    }
    if (this.running) return this.running;

    const controller = new AbortController();
    const running = this.runAndPreserveActiveRuntime(
      controller.signal,
    ).finally(() => {
      if (this.running === running) this.running = undefined;
      if (this.controller === controller) this.controller = undefined;
    });
    this.controller = controller;
    this.running = running;
    return running;
  }

  /**
   * Abort only when this runner still owns the exact Turn that was durably
   * cancelled. The synchronous ownership check prevents a delayed application
   * callback from aborting a later Turn that has already replaced it.
   */
  cancelTurn(turnId: string): boolean {
    if (this.closed || this.runtime?.turnId !== turnId) return false;
    this.controller?.abort();
    return true;
  }

  /**
   * Stop and join local execution, then relinquish its process-local lease.
   * Durable Turn state is unchanged and may later be restored by another
   * runner.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing;

    this.closed = true;
    this.controller?.abort();
    const running = this.running;
    this.closing = (async () => {
      if (running) {
        try {
          await running;
        } catch {
          // The run's caller observes its failure; close still owns cleanup.
        }
      }
      this.releaseRuntime();
    })();
    return this.closing;
  }

  private async runAndPreserveActiveRuntime(
    signal: AbortSignal,
  ): Promise<SessionRunResult> {
    try {
      return await this.drive(signal);
    } catch (cause) {
      await this.releaseRuntimeIfSettled();
      throw cause;
    }
  }

  private async drive(signal: AbortSignal): Promise<SessionRunResult> {
    for (;;) {
      signal.throwIfAborted();
      const state = await this.options.store.read(this.options.sessionId);
      signal.throwIfAborted();

      if (this.runtime) {
        const owned = state.turns.find(
          (turn) => turn.turnId === this.runtime?.turnId,
        );
        if (!owned || owned.status !== "active") {
          this.releaseRuntime();
          continue;
        }
      } else {
        const active = state.turns.find((turn) => turn.status === "active");
        if (active) {
          try {
            this.runtime = await restoreTurnRuntime({
              store: this.options.store,
              registry: this.options.registry,
              sessionId: this.options.sessionId,
              turnId: active.turnId,
              signal,
            });
          } catch (cause) {
            if (cause instanceof ActiveTurnUnavailable) continue;
            throw cause;
          }
        } else {
          const prompt = state.prompts.find(
            (candidate) =>
              candidate.status === "pending" &&
              candidate.prompt.mode === "queue",
          );
          if (!prompt) return { status: "idle", state };

          this.runtime = await startTurn({
            store: this.options.store,
            registry: this.options.registry,
            sessionId: this.options.sessionId,
            promptId: prompt.prompt.id,
            nextTurnId: this.options.nextTurnId,
            nextFactId: this.options.nextFactId,
            signal,
          });
        }
      }

      const runtime = this.runtime;
      const result = await this.options.executor.execute(
        runtime.turnId,
        runtime.configuration,
        signal,
      );

      if (result.status === "recovery-required") return result;

      this.releaseRuntime(runtime);
    }
  }

  /** Preserve the runtime if its durable Turn is still active. */
  private async releaseRuntimeIfSettled(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;

    try {
      const state = await this.options.store.read(this.options.sessionId);
      const turn = state.turns.find(
        (candidate) => candidate.turnId === runtime.turnId,
      );
      if (!turn || turn.status !== "active") this.releaseRuntime(runtime);
    } catch {
      // Failure to prove settlement must retain the active runtime lease.
    }
  }

  private releaseRuntime(expected = this.runtime): void {
    if (!expected || this.runtime !== expected) return;
    this.runtime = undefined;
    expected.lease.release();
  }
}
