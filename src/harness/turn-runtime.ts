/** The process-local binding retained while one durable Turn is active. */
import type { TurnServiceConfiguration } from "./turn-service-configuration.js";
import type { TurnServiceRegistryLease } from "./turn-service-registry.js";

/**
 * Live resources governing one durable active Turn.
 *
 * The owner retains the lease across every Step while it owns local execution.
 * Normal execution releases it after settlement; a quiesced runner may instead
 * relinquish it for later exact restoration.
 */
export type TurnRuntime = {
  readonly turnId: string;
  readonly configuration: TurnServiceConfiguration;
  readonly lease: TurnServiceRegistryLease;
};
