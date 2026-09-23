/** Configure and durably replace one Session's Turn services. */
import {
  assertNonempty,
  deepFreeze,
  sameJsonValue,
} from "./json.js";
import { TurnServiceConfigurationFact } from "./session-facts.js";
import type { SessionState } from "./session-state.js";
import {
  SessionHeadConflict,
  type SessionStore,
} from "./session-store.js";
import {
  TurnServiceSelection,
  type ConfigureTurnServices,
  type TurnServiceConfigurationDescription,
} from "./turn-service-configuration.js";
import type { TurnServiceRegistry } from "./turn-service-registry.js";

export type ConfigureSessionTurnServicesOptions = {
  readonly store: SessionStore;
  readonly registry: TurnServiceRegistry;
  readonly sessionId: string;
  readonly configure: ConfigureTurnServices;
  readonly nextFactId: () => string;
  readonly signal: AbortSignal;
};

/**
 * Run application configuration code as one explicit durable Session command.
 * Each stale-head retry starts again from fresh projected state and a fresh
 * registry lease. The returned state is the committed or unchanged state;
 * no live configuration escapes its temporary lease.
 */
export async function configureSessionTurnServices(
  options: ConfigureSessionTurnServicesOptions,
): Promise<SessionState> {
  assertNonempty(options.sessionId, "Session Id");

  for (;;) {
    options.signal.throwIfAborted();
    const state = await options.store.read(options.sessionId);
    options.signal.throwIfAborted();
    const lease = options.registry.lease();

    try {
      const selection = new TurnServiceSelection(lease);
      const context = Object.freeze({
        state: deepFreeze(structuredClone(state)),
        signal: options.signal,
      });

      await options.configure(selection, context);
      options.signal.throwIfAborted();
      const configuration = selection.realize();

      if (
        state.currentServiceConfiguration &&
        sameConfiguration(
          state.currentServiceConfiguration,
          configuration.description,
        )
      ) {
        return state;
      }

      const factId = options.nextFactId();
      assertNonempty(factId, "Turn-service configuration fact Id");

      try {
        return await options.store.append(
          options.sessionId,
          state.seq,
          TurnServiceConfigurationFact.make(
            factId,
            configuration.description,
          ),
        );
      } catch (cause) {
        if (cause instanceof SessionHeadConflict) continue;
        throw cause;
      }
    } finally {
      lease.release();
    }
  }
}

function sameConfiguration(
  left: TurnServiceConfigurationDescription,
  right: TurnServiceConfigurationDescription,
): boolean {
  return (
    left.services.length === right.services.length &&
    left.services.every((service, index) => {
      const candidate = right.services[index];
      return (
        candidate !== undefined &&
        service.kind === candidate.kind &&
        service.key === candidate.key &&
        service.revision === candidate.revision &&
        service.order === candidate.order &&
        sameJsonValue(service.settings, candidate.settings)
      );
    })
  );
}
