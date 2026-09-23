/**
 * A scoped, atomic group of Turn-service registrations.
 *
 * A Plugin is installed; the Turn services it provides are registered.
 * Plugin installation owns setup and cleanup, while service registration is
 * the registry's publication of the successfully staged Turn services.
 */
import {
  assertNonempty,
  type Cleanup,
  type JsonObject,
} from "./json.js";
import type {
  TurnService,
  TurnServiceKind,
} from "./turn-service.js";

export interface TurnServicePluginContext {
  /** Stage a Turn service for this Plugin installation. */
  provide<Value>(service: TurnService<Value>): Value;

  /** Resolve staged services first, then the existing registry. */
  get<Value>(kind: TurnServiceKind<Value>, key: string): Value | undefined;
  require<Value>(kind: TurnServiceKind<Value>, key: string): Value;

  /** Own an arbitrary live resource under the same Plugin Scope. */
  defer(cleanup: Cleanup): void;
}

export type TurnServicePluginInstall = (
  context: TurnServicePluginContext,
) => void | Promise<void>;

export type TurnServicePlugin = {
  readonly name: string;
  readonly install: TurnServicePluginInstall;
};

export function defineTurnServicePlugin(
  name: string,
  install: TurnServicePluginInstall,
): TurnServicePlugin {
  assertNonempty(name, "Turn-service Plugin name");
  return Object.freeze({ name, install });
}

// ---------------------------------------------------------------------------
// Persistent bootstrap bridge
// ---------------------------------------------------------------------------

/**
 * Code-owned interpretation of one Plugin declaration's JSON settings.
 *
 * The future bootstrap loader supplies validated, detached, frozen settings.
 * A factory must only construct the Plugin. Resource acquisition belongs in
 * the returned Plugin's install function so registry installation can stage it
 * atomically and own every cleanup through the Plugin Scope.
 */
export type TurnServicePluginFactory = (
  settings: JsonObject,
) => TurnServicePlugin;

/**
 * Code-owned durable name for one Plugin factory implementation. A future
 * persistent declaration refers to this Id; several Plugin instances may use
 * the same factory with different instance Ids and settings. Factory-Id
 * uniqueness is enforced when the future bootstrap catalog is constructed.
 */
export type TurnServicePluginFactoryRegistration = {
  readonly id: string;
  readonly factory: TurnServicePluginFactory;
};
