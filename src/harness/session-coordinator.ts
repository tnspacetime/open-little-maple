/** Lost-wakeup-safe, process-local Session execution coordination. */
import { asError } from "./json.js";
import type {
  SessionRunResult,
  SessionRunner,
} from "./session-runner.js";

export type SessionRecoveryResult = Extract<
  SessionRunResult,
  { readonly status: "recovery-required" }
>;

export type SessionBlock =
  | {
      readonly type: "recovery";
      readonly result: SessionRecoveryResult;
    }
  | {
      readonly type: "failure";
      readonly error: Error;
    };

type CoordinatedSessionRunner = Pick<
  SessionRunner,
  "runUntilBlocked" | "cancelTurn" | "close"
>;

export type SessionCoordinatorOptions = {
  /** Construct the one retained process-local runner for a Session. */
  readonly createRunner: (sessionId: string) => CoordinatedSessionRunner;

  /** Observe an unexpected runner failure after execution ownership is released. */
  readonly onFailure: (
    sessionId: string,
    error: Error,
  ) => void | Promise<void>;

  /** Observe explicit recovery requirements after execution ownership is released. */
  readonly onRecoveryRequired: (
    sessionId: string,
    result: SessionRecoveryResult,
  ) => void | Promise<void>;
};

class SessionExecutionOwner {
  task!: Promise<void>;
}

type SessionExecutionSlot = {
  readonly runner: CoordinatedSessionRunner;
  requested: boolean;
  retiring: boolean;
  owner: SessionExecutionOwner | undefined;
  blocked: SessionBlock | undefined;
};

/**
 * Coordinates transient execution ownership without making Session lifecycle
 * decisions. SessionRunner chooses and executes work; this class guarantees
 * at most one retained runner and one active owner per Session in this process.
 */
export class SessionCoordinator {
  /**
   * Active and blocked Sessions retain their runners. A genuinely idle slot is
   * removed synchronously, then its runner is closed in the background.
   */
  private readonly slots = new Map<string, SessionExecutionSlot>();
  /** Pending closes for runners already removed by idle eviction. */
  private readonly retiringRunners = new Set<Promise<void>>();
  private closed = false;
  private closeTask: Promise<void> | undefined;

  constructor(private readonly options: SessionCoordinatorOptions) {}

  /**
   * Record a wake hint after durable ingress. This method never throws: failure
   * to create an owner is reported through onFailure instead. A blocked Session
   * remembers the hint but cannot run until retryBlockedExecution() is called.
   */
  requestExecution(sessionId: string): void {
    if (this.closed) return;

    let slot: SessionExecutionSlot;
    try {
      slot = this.slot(sessionId);
    } catch (cause) {
      this.reportFailure(sessionId, asError(cause));
      return;
    }

    slot.requested = true;
    if (!slot.owner && !slot.blocked) this.startOwner(sessionId, slot);
  }

  /**
   * Explicitly re-evaluate durable state after application intervention or an
   * intentional retry. If the underlying issue remains, the runner blocks
   * again without the coordinator bypassing its durable safeguards.
   */
  retryBlockedExecution(sessionId: string): void {
    if (this.closed) return;

    const slot = this.slots.get(sessionId);
    if (!slot?.blocked) return;

    slot.blocked = undefined;
    slot.requested = true;
    if (!slot.owner) this.startOwner(sessionId, slot);
  }

  /**
   * Quiesce the process-local owner after its active Turn was durably
   * cancelled. Deleting the slot first lets later Prompts create a fresh
   * runner; closing the retired runner aborts its live work and releases its
   * Turn lease without changing durable state.
   */
  cancelTurnExecution(sessionId: string, turnId: string): void {
    if (this.closed) return;

    const slot = this.slots.get(sessionId);
    if (!slot) return;

    // The runner may already have released the cancelled Turn and advanced.
    // In that case it must remain untouched: aborting it could stop new work.
    if (!slot.runner.cancelTurn(turnId)) return;

    const requested = slot.requested;
    slot.requested = false;
    slot.blocked = undefined;
    slot.retiring = true;
    if (this.slots.get(sessionId) === slot) this.slots.delete(sessionId);
    this.retireRunner(sessionId, slot.runner);

    // A wake may have raced with cancellation for a later queued Prompt.
    // Retiring the old owner must not discard that durable work hint.
    if (requested) this.requestExecution(sessionId);
  }

  /** Stop accepting wakes, close every retained runner, and join every owner. */
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true;

    const slots = [...this.slots.values()];
    for (const slot of slots) slot.requested = false;

    const owners = slots
      .map((slot) => slot.owner)
      .filter(
        (owner): owner is SessionExecutionOwner => owner !== undefined,
      );
    const closingRunners = slots.map((slot) => slot.runner.close());

    const closing = [
      ...closingRunners,
      ...owners.map((owner) => owner.task),
      ...this.retiringRunners,
    ];
    this.closeTask = Promise.allSettled(closing).then((results) => {
      this.slots.clear();
      this.retiringRunners.clear();

      const failures = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => asError(result.reason));
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Failed to close Session coordinator",
        );
      }
    });
    return this.closeTask;
  }

  private slot(sessionId: string): SessionExecutionSlot {
    const existing = this.slots.get(sessionId);
    if (existing) return existing;

    const created: SessionExecutionSlot = {
      runner: this.options.createRunner(sessionId),
      requested: false,
      retiring: false,
      owner: undefined,
      blocked: undefined,
    };
    this.slots.set(sessionId, created);
    return created;
  }

  private startOwner(
    sessionId: string,
    slot: SessionExecutionSlot,
  ): void {
    if (
      this.closed ||
      slot.owner ||
      slot.blocked ||
      !slot.requested
    ) {
      return;
    }

    const owner = new SessionExecutionOwner();
    slot.owner = owner;
    owner.task = this.runOwner(sessionId, slot, owner);
  }

  private async runOwner(
    sessionId: string,
    slot: SessionExecutionSlot,
    owner: SessionExecutionOwner,
  ): Promise<void> {
    let block: SessionBlock | undefined;

    try {
      while (!this.closed && !slot.retiring && slot.requested) {
        slot.requested = false;

        try {
          const result = await slot.runner.runUntilBlocked();
          if (this.closed || slot.retiring) break;
          if (result.status === "recovery-required") {
            block = { type: "recovery", result };
            slot.blocked = block;
            break;
          }
        } catch (cause) {
          if (this.closed || slot.retiring) break;
          block = { type: "failure", error: asError(cause) };
          slot.blocked = block;
          break;
        }
      }
    } finally {
      this.releaseOwner(sessionId, slot, owner);
    }

    if (block?.type === "recovery") {
      this.reportRecovery(sessionId, block.result);
    } else if (block?.type === "failure") {
      this.reportFailure(sessionId, block.error);
    }
  }

  /** Relinquish ownership and synchronously close the lost-wakeup gap. */
  private releaseOwner(
    sessionId: string,
    slot: SessionExecutionSlot,
    owner: SessionExecutionOwner,
  ): void {
    if (slot.owner !== owner) return;
    slot.owner = undefined;

    if (
      this.closed ||
      slot.retiring ||
      slot.blocked
    ) {
      return;
    }

    if (slot.requested) {
      this.startOwner(sessionId, slot);
      return;
    }

    // An idle Session owns no TurnRuntime. Delete synchronously so a later wake
    // creates one fresh owner, then retire the old runner asynchronously.
    if (this.slots.get(sessionId) === slot) {
      this.slots.delete(sessionId);
      this.retireRunner(sessionId, slot.runner);
    }
  }

  private retireRunner(
    sessionId: string,
    runner: CoordinatedSessionRunner,
  ): void {
    let closing: Promise<void>;
    try {
      closing = Promise.resolve(runner.close());
    } catch (cause) {
      closing = Promise.reject(cause);
    }
    const retirement = closing
      .catch((cause) => {
        this.reportFailure(sessionId, asError(cause));
      })
      .finally(() => {
        this.retiringRunners.delete(retirement);
      });
    this.retiringRunners.add(retirement);
  }

  private reportFailure(sessionId: string, error: Error): void {
    try {
      void Promise.resolve(
        this.options.onFailure(sessionId, error),
      ).catch(() => undefined);
    } catch {
      // Observation must not compromise coordinator ownership or shutdown.
    }
  }

  private reportRecovery(
    sessionId: string,
    result: SessionRecoveryResult,
  ): void {
    try {
      void Promise.resolve(
        this.options.onRecoveryRequired(sessionId, result),
      ).catch(() => undefined);
    } catch {
      // Observation must not compromise coordinator ownership or shutdown.
    }
  }
}
