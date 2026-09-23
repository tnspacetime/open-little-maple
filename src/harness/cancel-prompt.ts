/** Durably cancel one queued Prompt or the active Turn it started. */
import { assertNonempty } from "./json.js";
import { PromptSkipped, TurnSettled } from "./session-facts.js";
import type { SessionState } from "./session-state.js";
import { SessionHeadConflict, type SessionStore } from "./session-store.js";

export type CancelPromptOptions = {
  readonly store: SessionStore;
  readonly sessionId: string;
  readonly promptId: string;
  readonly nextFactId: () => string;
};

export type CancelPromptResult = {
  readonly state: SessionState;
  /** Present when cancellation terminally settled the Prompt's active Turn. */
  readonly turnId?: string;
};

/** The target is not a cancellable queued job in its current durable state. */
export class PromptCancellationUnavailable extends Error {
  override readonly name = "PromptCancellationUnavailable";

  constructor(
    readonly promptId: string,
    readonly reason: string,
  ) {
    super(`Prompt ${promptId} cannot be cancelled: ${reason}`);
  }
}

/**
 * Cancel exactly one user-level queued job.
 *
 * A pending queue Prompt truncates the queue from its admission position. Once
 * TurnStarted has claimed that Prompt, cancellation terminally settles its
 * active Turn and truncates every queue Prompt waiting behind it. A stale head
 * recomputes this choice, so a Turn-start or Prompt-admission race is ordered
 * entirely by the durable cancellation boundary.
 */
export async function cancelPrompt(
  options: CancelPromptOptions,
): Promise<CancelPromptResult> {
  assertNonempty(options.sessionId, "Session Id");
  assertNonempty(options.promptId, "Cancelled Prompt Id");

  for (;;) {
    const state = await options.store.read(options.sessionId);
    const prompt = state.prompts.find(
      (candidate) => candidate.prompt.id === options.promptId,
    );
    if (!prompt) {
      throw new PromptCancellationUnavailable(
        options.promptId,
        "it does not exist",
      );
    }

    if (prompt.prompt.mode !== "queue") {
      throw new PromptCancellationUnavailable(
        options.promptId,
        "only a queue Prompt represents a cancellable user-level job",
      );
    }

    if (prompt.status === "pending") {
      const factId = options.nextFactId();
      assertNonempty(factId, "Prompt-skip fact Id");
      try {
        return {
          state: await options.store.append(
            options.sessionId,
            state.seq,
            PromptSkipped.make(factId, {
              promptId: options.promptId,
              reason: "cancelled",
            }),
          ),
        };
      } catch (cause) {
        if (cause instanceof SessionHeadConflict) continue;
        throw cause;
      }
    }

    if (prompt.status === "skipped" && prompt.reason === "cancelled") {
      return { state };
    }

    if (prompt.status !== "claimed-by-turn") {
      throw new PromptCancellationUnavailable(
        options.promptId,
        `its current status is ${prompt.status}`,
      );
    }

    const turn = state.turns.find(
      (candidate) => candidate.turnId === prompt.turnId,
    );
    if (!turn) {
      throw new Error(
        `Prompt ${options.promptId} belongs to missing Turn ${prompt.turnId}`,
      );
    }
    if (turn.status === "cancelled") {
      return { state, turnId: turn.turnId };
    }
    if (turn.status !== "active") {
      throw new PromptCancellationUnavailable(
        options.promptId,
        `its Turn ${turn.turnId} is already ${turn.status}`,
      );
    }

    const factId = options.nextFactId();
    assertNonempty(factId, "Turn-cancellation fact Id");
    try {
      return {
        state: await options.store.append(
          options.sessionId,
          state.seq,
          TurnSettled.make(factId, {
            turnId: turn.turnId,
            outcome: "cancelled",
          }),
        ),
        turnId: turn.turnId,
      };
    } catch (cause) {
      if (cause instanceof SessionHeadConflict) continue;
      throw cause;
    }
  }
}
