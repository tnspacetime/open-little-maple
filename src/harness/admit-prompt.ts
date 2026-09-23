/** Durably admit one queue or steering Prompt to a Session. */
import { assertNonempty } from "./json.js";
import { PromptAdmitted, type Prompt } from "./session-facts.js";
import type { SessionState } from "./session-state.js";
import {
  SessionHeadConflict,
  type SessionStore,
} from "./session-store.js";

export type AdmitPromptOptions = {
  readonly store: SessionStore;
  readonly sessionId: string;
  readonly prompt: Prompt;
  readonly nextFactId: () => string;
  readonly signal: AbortSignal;
};

/** A steering Prompt lost the active Turn it targeted before it could commit. */
export class SteerTargetUnavailable extends Error {
  override readonly name = "SteerTargetUnavailable";

  constructor(
    readonly promptId: string,
    readonly targetTurnId?: string,
  ) {
    super(
      targetTurnId
        ? `Steer Prompt ${promptId} cannot be admitted because Turn ${targetTurnId} is no longer active`
        : `Steer Prompt ${promptId} cannot be admitted without an active Turn`,
    );
  }
}

/**
 * Append one Prompt as a durable Session command.
 *
 * Queue admission may retry against any later Session head. A steer captures
 * the Turn active on its first read and may retry only while that same Turn
 * remains active, preventing a racing steer from leaking into another Turn.
 */
export async function admitPrompt(
  options: AdmitPromptOptions,
): Promise<SessionState> {
  assertNonempty(options.sessionId, "Session Id");
  options.signal.throwIfAborted();

  const prompt = PromptAdmitted.decode(options.prompt);
  const factId = options.nextFactId();
  assertNonempty(factId, "Prompt-admission fact Id");
  const fact = PromptAdmitted.make(factId, prompt);
  let targetTurnId: string | undefined;

  for (;;) {
    options.signal.throwIfAborted();
    const state = await options.store.read(options.sessionId);
    options.signal.throwIfAborted();

    if (prompt.mode === "steer") {
      const activeTurn = state.turns.find((turn) => turn.status === "active");

      if (targetTurnId === undefined) {
        if (!activeTurn) throw new SteerTargetUnavailable(prompt.id);
        targetTurnId = activeTurn.turnId;
      } else if (activeTurn?.turnId !== targetTurnId) {
        throw new SteerTargetUnavailable(prompt.id, targetTurnId);
      }
    }

    try {
      return await options.store.append(options.sessionId, state.seq, fact);
    } catch (cause) {
      if (cause instanceof SessionHeadConflict) continue;
      throw cause;
    }
  }
}
