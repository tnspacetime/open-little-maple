/** Restore the live binding for one already-active durable Turn. */
import { assertNonempty } from "./json.js";
import type { SessionState, TurnState } from "./session-state.js";
import type { SessionStore } from "./session-store.js";
import {
  resolveTurnServiceConfiguration,
  TurnServiceResolutionError,
  type TurnServiceConfiguration,
} from "./turn-service-configuration.js";
import type { TurnServiceRegistry } from "./turn-service-registry.js";
import type { TurnRuntime } from "./turn-runtime.js";

export type RestoreTurnRuntimeOptions = {
  readonly store: SessionStore;
  readonly registry: TurnServiceRegistry;
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal: AbortSignal;
};

/** The requested durable Turn is missing or is no longer active. */
export class ActiveTurnUnavailable extends Error {
  override readonly name = "ActiveTurnUnavailable";

  constructor(
    readonly sessionId: string,
    readonly turnId: string,
  ) {
    super(`Turn ${turnId} is not active in Session ${sessionId}`);
  }
}

/**
 * Rebind one active Turn's frozen durable configuration to exact live services.
 * This operation writes no fact. The caller must ensure that no local runtime
 * or executor already owns the same Turn.
 */
export async function restoreTurnRuntime(
  options: RestoreTurnRuntimeOptions,
): Promise<TurnRuntime> {
  assertNonempty(options.sessionId, "Session Id");
  assertNonempty(options.turnId, "Turn Id");
  options.signal.throwIfAborted();

  const state = await options.store.read(options.sessionId);
  options.signal.throwIfAborted();
  const turn = requireActiveTurn(state, options.sessionId, options.turnId);
  const lease = options.registry.lease();
  let transferred = false;

  try {
    let configuration: TurnServiceConfiguration;
    try {
      configuration = resolveTurnServiceConfiguration(
        turn.serviceConfiguration,
        lease,
      );
    } catch (cause) {
      if (!(cause instanceof TurnServiceResolutionError)) throw cause;

      /* Prefer lifecycle truth if the target settled while resolving. */
      const latest = await options.store.read(options.sessionId);
      options.signal.throwIfAborted();
      requireActiveTurn(latest, options.sessionId, options.turnId);
      throw cause;
    }

    options.signal.throwIfAborted();
    const latest = await options.store.read(options.sessionId);
    requireActiveTurn(latest, options.sessionId, options.turnId);
    options.signal.throwIfAborted();

    transferred = true;
    return Object.freeze({
      turnId: options.turnId,
      configuration,
      lease,
    });
  } finally {
    if (!transferred) lease.release();
  }
}

function requireActiveTurn(
  state: SessionState,
  sessionId: string,
  turnId: string,
): Extract<TurnState, { readonly status: "active" }> {
  const turn = state.turns.find((candidate) => candidate.turnId === turnId);
  if (!turn || turn.status !== "active") {
    throw new ActiveTurnUnavailable(sessionId, turnId);
  }
  return turn;
}
