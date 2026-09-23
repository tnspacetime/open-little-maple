/** Start one durable Turn and bind it to its exact live services. */
import { assertNonempty } from "./json.js";
import { TurnStarted } from "./session-facts.js";
import { SessionHeadConflict, type SessionStore } from "./session-store.js";
import {
  resolveTurnServiceConfiguration,
  TurnServiceResolutionError,
  type TurnServiceConfiguration,
} from "./turn-service-configuration.js";
import { type TurnServiceRegistry } from "./turn-service-registry.js";
import type { TurnRuntime } from "./turn-runtime.js";

export type StartTurnOptions = {
  readonly store: SessionStore;
  readonly registry: TurnServiceRegistry;
  readonly sessionId: string;
  readonly promptId: string;
  readonly nextTurnId: () => string;
  readonly nextFactId: () => string;
  readonly signal: AbortSignal;
};

/**
 * Claim one chosen queued Prompt and start its Turn under the Session's current
 * durable service configuration.
 *
 * A stale-head retry rereads Session state and resolves against a fresh lease.
 * Failed attempts release their leases; a successful attempt transfers its
 * lease to the returned TurnRuntime.
 */
export async function startTurn(
  options: StartTurnOptions,
): Promise<TurnRuntime> {
  assertNonempty(options.sessionId, "Session Id");
  assertNonempty(options.promptId, "Turn Prompt Id");

  const turnId = options.nextTurnId();
  assertNonempty(turnId, "Turn Id");

  for (;;) {
    options.signal.throwIfAborted();
    const state = await options.store.read(options.sessionId);
    options.signal.throwIfAborted();

    const description = state.currentServiceConfiguration;
    if (!description) {
      throw new Error(
        `Session ${options.sessionId} has no Turn-service configuration`,
      );
    }

    const lease = options.registry.lease();
    let transferred = false;

    try {
      let configuration: TurnServiceConfiguration;
      try {
        configuration = resolveTurnServiceConfiguration(description, lease);
      } catch (cause) {
        if (!(cause instanceof TurnServiceResolutionError)) throw cause;

        /*
         * Resolution happens before the TurnStarted CAS. Its input may already
         * be stale, so do not report a mismatch until the projected head still
         * matches the snapshot whose configuration failed to resolve.
         */
        const latest = await options.store.read(options.sessionId);
        if (latest.seq !== state.seq) continue;
        throw cause;
      }
      options.signal.throwIfAborted();

      const factId = options.nextFactId();
      assertNonempty(factId, "Turn-start fact Id");

      try {
        await options.store.append(
          options.sessionId,
          state.seq,
          TurnStarted.make(factId, {
            turnId,
            promptId: options.promptId,
          }),
        );
      } catch (cause) {
        if (cause instanceof SessionHeadConflict) continue;
        throw cause;
      }

      transferred = true;
      return Object.freeze({ turnId, configuration, lease });
    } finally {
      if (!transferred) lease.release();
    }
  }
}
