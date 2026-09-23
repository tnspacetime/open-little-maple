/** One immutable selection of live Turn services and its durable description. */
import {
  deepFreeze,
  sameJsonValue,
  type JsonObject,
} from "./json.js";
import type {
  RegisteredTurnServiceRecord,
  TurnServiceRegistryLease,
} from "./turn-service-registry.js";
import type {
  RegisteredTurnService,
  TurnServiceReference,
  TurnServiceResolver,
  TurnServiceKind,
} from "./turn-service.js";
import type { SessionState } from "./session-state.js";

export type TurnServiceDescription = {
  readonly kind: string;
  readonly key: string;
  readonly revision: string;

  /**
   * Complete durable service configuration. Together with kind, key, and
   * revision, this must contain every request- or behavior-affecting value
   * needed to interpret the service without persisting its live value.
   */
  readonly settings: JsonObject;

  readonly order: number;
};

export type TurnServiceConfigurationDescription = {
  readonly services: readonly TurnServiceDescription[];
};

export class TurnServiceConfiguration implements TurnServiceResolver {
  readonly description: TurnServiceConfigurationDescription;
  private readonly selected: readonly RegisteredTurnServiceRecord[];

  constructor(services: readonly RegisteredTurnServiceRecord[]) {
    const keysByKind = new Map<symbol, Set<string>>();

    this.selected = Object.freeze(
      services.map((service): RegisteredTurnServiceRecord => {
        const keys = keysByKind.get(service.kind.identity) ?? new Set<string>();
        if (keys.has(service.key)) {
          throw new Error(
            `Turn service selected twice: ${service.kind.id}:${service.key}`,
          );
        }
        keys.add(service.key);
        keysByKind.set(service.kind.identity, keys);

        return Object.freeze({
          kind: service.kind,
          key: service.key,
          value: service.value,
          revision: service.revision,
          settings: deepFreeze(structuredClone(service.settings)),
          order: service.order,
          registeredAt: service.registeredAt,
        });
      }),
    );

    this.description = deepFreeze({
      services: this.selected.map(
        (service): TurnServiceDescription => ({
          kind: service.kind.id,
          key: service.key,
          revision: service.revision,
          settings: structuredClone(service.settings),
          order: service.order,
        }),
      ),
    });

    Object.freeze(this);
  }

  entries<Value>(
    kind: TurnServiceKind<Value>,
  ): readonly RegisteredTurnService<Value>[] {
    return entriesFrom(this.selected, kind);
  }

  get<Value>(
    kind: TurnServiceKind<Value>,
    key: string,
  ): Value | undefined {
    return this.entries(kind).find((service) => service.key === key)?.value;
  }

  require<Value>(kind: TurnServiceKind<Value>, key: string): Value {
    const service = this.entries(kind).find(
      (candidate) => candidate.key === key,
    );
    if (!service) {
      throw new Error(`Missing configured Turn service ${kind.id}:${key}`);
    }
    return service.value;
  }

  /** Complete Tool-consumable resource universe before rules narrow it. */
  toolResourceReferences(): readonly TurnServiceReference[] {
    return Object.freeze(
      this.selected
        .filter((service) => service.kind.toolAccess === "scoped-resource")
        .map((service) =>
          Object.freeze({ kind: service.kind.id, key: service.key }),
        ),
    );
  }

  /** Build a frozen Tool resolver containing exactly the referenced resources. */
  restrict(
    references: readonly TurnServiceReference[],
  ): TurnServiceResolver {
    const available = new Map(
      this.selected.map((service) => [
        serviceIdentity(service.kind.id, service.key),
        service,
      ]),
    );
    const seen = new Set<string>();
    const restricted = references.map((reference) => {
      const identity = serviceIdentity(reference.kind, reference.key);
      if (seen.has(identity)) {
        throw new Error(
          `Turn service scope repeats ${reference.kind}:${reference.key}`,
        );
      }
      seen.add(identity);

      const service = available.get(identity);
      if (!service) {
        throw new Error(
          `Turn service scope contains unavailable service ${reference.kind}:${reference.key}`,
        );
      }
      if (service.kind.toolAccess !== "scoped-resource") {
        throw new Error(
          `Turn service ${reference.kind}:${reference.key} is not Tool-accessible`,
        );
      }
      return service;
    });

    return resolverFrom(Object.freeze(restricted));
  }
}

function serviceIdentity(kind: string, key: string): string {
  return `${kind}\u0000${key}`;
}

function entriesFrom<Value>(
  services: readonly RegisteredTurnServiceRecord[],
  kind: TurnServiceKind<Value>,
): readonly RegisteredTurnService<Value>[] {
  return Object.freeze(
    services.filter(
      (service) => service.kind.identity === kind.identity,
    ),
  ) as unknown as readonly RegisteredTurnService<Value>[];
}

function resolverFrom(
  services: readonly RegisteredTurnServiceRecord[],
): TurnServiceResolver {
  return Object.freeze({
    entries<Value>(
      kind: TurnServiceKind<Value>,
    ): readonly RegisteredTurnService<Value>[] {
      return entriesFrom(services, kind);
    },

    get<Value>(
      kind: TurnServiceKind<Value>,
      key: string,
    ): Value | undefined {
      return entriesFrom(services, kind).find(
        (service) => service.key === key,
      )?.value;
    },

    require<Value>(kind: TurnServiceKind<Value>, key: string): Value {
      const service = entriesFrom(services, kind).find(
        (candidate) => candidate.key === key,
      );
      if (!service) {
        throw new Error(`Missing configured Turn service ${kind.id}:${key}`);
      }
      return service.value;
    },
  });
}

// ===========================================================================
// Exact durable-description resolution against one leased registry snapshot
// ===========================================================================

export type TurnServiceResolutionFailure =
  | "missing"
  | "revision-mismatch"
  | "settings-mismatch"
  | "order-mismatch";

/** One durable service description cannot be bound to its exact live entry. */
export class TurnServiceResolutionError extends Error {
  override readonly name = "TurnServiceResolutionError";

  constructor(
    readonly kind: string,
    readonly key: string,
    readonly failure: TurnServiceResolutionFailure,
    message: string,
  ) {
    super(`Cannot resolve Turn service ${kind}:${key}: ${message}`);
  }
}

/**
 * Bind one complete durable configuration to exact live services captured by
 * the supplied lease. Extra leased services are irrelevant. The durable
 * description determines result order, and the caller retains ownership of
 * the lease and must release it after the resulting configuration is no longer
 * used.
 */
export function resolveTurnServiceConfiguration(
  description: TurnServiceConfigurationDescription,
  lease: TurnServiceRegistryLease,
): TurnServiceConfiguration {
  const resolved = description.services.map((service) => {
    const entry = lease.entries.find(
      (candidate) =>
        candidate.kind.id === service.kind && candidate.key === service.key,
    );

    if (!entry) {
      throw new TurnServiceResolutionError(
        service.kind,
        service.key,
        "missing",
        "it is not present in the registry lease",
      );
    }
    if (entry.revision !== service.revision) {
      throw new TurnServiceResolutionError(
        service.kind,
        service.key,
        "revision-mismatch",
        `live revision ${entry.revision} does not match durable revision ${service.revision}`,
      );
    }
    if (!sameJsonValue(entry.settings, service.settings)) {
      throw new TurnServiceResolutionError(
        service.kind,
        service.key,
        "settings-mismatch",
        "live settings do not match durable settings",
      );
    }
    if (entry.order !== service.order) {
      throw new TurnServiceResolutionError(
        service.kind,
        service.key,
        "order-mismatch",
        `live order ${entry.order} does not match durable order ${service.order}`,
      );
    }

    return entry;
  });

  return new TurnServiceConfiguration(resolved);
}

// ===========================================================================
// Code-based selection used only while explicitly configuring a Session
// ===========================================================================

/** Detached projected state and cancellation for one configuration run. */
export type ConfigureTurnServicesContext = {
  readonly state: SessionState;
  readonly signal: AbortSignal;
};

/**
 * Computes the complete next Turn-service selection from one leased registry
 * snapshot.
 *
 * The durable configuration operation may invoke this function more than once
 * after losing a Session head race. Implementations must therefore be safe to
 * rerun and must not perform non-idempotent external effects.
 *
 * This is ordinary application code, not a Turn service. It is neither
 * registered nor persisted; only the realized configuration is durable.
 */
export type ConfigureTurnServices = (
  selection: TurnServiceSelection,
  context: ConfigureTurnServicesContext,
) => void | Promise<void>;

/**
 * One mutable selection over one registry lease. Configuration code receives
 * this as an initially empty selection. Realization permanently closes it and
 * can use only services captured by that lease.
 */
export class TurnServiceSelection {
  private readonly leased: readonly RegisteredTurnServiceRecord[];
  private readonly selected = new Set<RegisteredTurnServiceRecord>();
  private realized = false;

  constructor(lease: TurnServiceRegistryLease) {
    this.leased = lease.entries;
  }

  includeAll(): this {
    this.assertMutable();
    for (const service of this.leased) this.selected.add(service);
    return this;
  }

  has<Value>(kind: TurnServiceKind<Value>, key: string): boolean {
    this.assertMutable();
    return this.leased.some(
      (service) =>
        service.kind.identity === kind.identity && service.key === key,
    );
  }

  /** Describe the available leased services without exposing live values. */
  available<Value>(
    kind: TurnServiceKind<Value>,
  ): readonly TurnServiceDescription[] {
    this.assertMutable();
    return deepFreeze(
      this.leased
        .filter((service) => service.kind.identity === kind.identity)
        .map((service): TurnServiceDescription => ({
          kind: service.kind.id,
          key: service.key,
          revision: service.revision,
          settings: structuredClone(service.settings),
          order: service.order,
        })),
    );
  }

  include<Value>(kind: TurnServiceKind<Value>, key: string): this {
    this.assertMutable();
    const service = this.leased.find(
      (candidate) =>
        candidate.kind.identity === kind.identity && candidate.key === key,
    );

    if (!service) {
      throw new Error(`Turn service is not selectable: ${kind.id}:${key}`);
    }

    this.selected.add(service);
    return this;
  }

  exclude<Value>(kind: TurnServiceKind<Value>, key: string): this {
    this.assertMutable();
    const service = this.leased.find(
      (candidate) =>
        candidate.kind.identity === kind.identity && candidate.key === key,
    );

    if (service) this.selected.delete(service);
    return this;
  }

  /** Inspect selected keys for one durable service-kind Id. */
  selectedKeys(kindId: string): readonly string[] {
    this.assertMutable();
    return Object.freeze(
      this.leased
        .filter(
          (service) =>
            service.kind.id === kindId && this.selected.has(service),
        )
        .map((service) => service.key)
        .sort(),
    );
  }

  realize(): TurnServiceConfiguration {
    this.assertMutable();
    this.realized = true;
    return new TurnServiceConfiguration(
      this.leased.filter((service) => this.selected.has(service)),
    );
  }

  private assertMutable(): void {
    if (this.realized) {
      throw new Error("Turn service selection is already realized");
    }
  }
}
