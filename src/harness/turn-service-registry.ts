/** Atomic registration and scoped ownership of live Turn services. */
import {
  asError,
  assertNonempty,
  deepFreeze,
  type JsonObject,
} from "./json.js";
import { Scope } from "./scope.js";
import type {
  TurnServicePlugin,
  TurnServicePluginContext,
} from "./turn-service-plugin.js";
import type {
  RegisteredTurnService,
  TurnService,
  TurnServiceKind,
  TurnServiceKindRef,
} from "./turn-service.js";

type TurnServiceRecord = {
  readonly kind: TurnServiceKindRef;
  readonly key: string;
  readonly value: unknown;
  readonly revision: string;
  readonly settings: JsonObject;
  readonly order: number;
};

export type RegisteredTurnServiceRecord = TurnServiceRecord & {
  readonly registeredAt: number;
};

type StoredRegistration = RegisteredTurnServiceRecord & {
  readonly registration: symbol;
};

/**
 * One immutable capture of the registry's effective services. Releasing it
 * permits Plugin resources hidden after this capture to finish cleanup.
 */
export class TurnServiceRegistryLease {
  private released = false;

  constructor(
    readonly entries: readonly RegisteredTurnServiceRecord[],
    private readonly releaseLease: () => void,
  ) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    this.releaseLease();
  }
}

type RegistryLeaseBarrier = {
  readonly throughGeneration: number;
  readonly resolve: () => void;
};

/** Coordinates captures and cleanup barriers for one live registry. */
class RegistryLeaseCoordinator {
  private nextGeneration = 0;
  private readonly activeGenerations = new Set<number>();
  private readonly barriers = new Set<RegistryLeaseBarrier>();

  capture(
    readEntries: () => readonly RegisteredTurnServiceRecord[],
  ): TurnServiceRegistryLease {
    const generation = ++this.nextGeneration;
    this.activeGenerations.add(generation);

    try {
      const entries = Object.freeze(
        readEntries().map((entry) => Object.freeze({ ...entry })),
      );
      return new TurnServiceRegistryLease(entries, () =>
        this.release(generation),
      );
    } catch (cause) {
      this.release(generation);
      throw cause;
    }
  }

  /** Wait only for leases that existed when this barrier was created. */
  whenCurrentLeasesFinish(): Promise<void> {
    const throughGeneration = this.nextGeneration;
    if (!this.hasActiveLeaseThrough(throughGeneration)) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.barriers.add({ throughGeneration, resolve });
    });
  }

  private release(generation: number): void {
    if (!this.activeGenerations.delete(generation)) {
      throw new Error(`Unknown registry lease generation: ${generation}`);
    }

    for (const barrier of this.barriers) {
      if (this.hasActiveLeaseThrough(barrier.throughGeneration)) continue;
      this.barriers.delete(barrier);
      barrier.resolve();
    }
  }

  private hasActiveLeaseThrough(generation: number): boolean {
    for (const active of this.activeGenerations) {
      if (active <= generation) return true;
    }
    return false;
  }
}

function toTurnServiceRecord<Value>(
  service: TurnService<Value>,
): TurnServiceRecord {
  assertNonempty(service.kind.id, "Turn service kind Id");
  assertNonempty(service.key, "Turn service key");
  assertNonempty(service.revision, "Turn service revision");
  if (service.value === undefined) {
    throw new Error("Turn service value cannot be undefined");
  }

  return Object.freeze({
    kind: service.kind,
    key: service.key,
    value: service.value,
    revision: service.revision,
    settings: deepFreeze(structuredClone(service.settings)),
    order: service.order,
  });
}

/** Handle for one installed Plugin and the lifetime it owns. */
export class InstalledTurnServicePlugin {
  constructor(
    readonly name: string,
    private readonly scope: Scope,
  ) {}

  close(): Promise<void> {
    return this.scope.close();
  }
}

export type TurnServicePluginInstallationOptions = {
  /** Reject an existing effective (kind, key) instead of overriding it. */
  readonly rejectServiceConflicts?: boolean;
};

export class TurnServiceRegistry {
  private readonly lifetime = new Scope();
  private readonly registered: StoredRegistration[] = [];
  private readonly kindsById = new Map<string, TurnServiceKindRef>();
  private readonly leaseCoordinator = new RegistryLeaseCoordinator();
  private nextRegistrationOrder = 0;

  /**
   * Install one Plugin transactionally: successful setup registers its whole
   * staged group; failed setup registers nothing and closes acquired resources.
   */
  async install(
    plugin: TurnServicePlugin,
    options: TurnServicePluginInstallationOptions = {},
  ): Promise<InstalledTurnServicePlugin> {
    const scope = this.lifetime.child();
    const staged: TurnServiceRecord[] = [];

    const findStaged = <Value>(
      kind: TurnServiceKind<Value>,
      key: string,
    ): Value | undefined => {
      for (let index = staged.length - 1; index >= 0; index -= 1) {
        const service = staged[index]!;
        if (service.kind.identity === kind.identity && service.key === key) {
          return service.value as Value;
        }
      }
      return undefined;
    };

    const context: TurnServicePluginContext = {
      provide: <Value>(service: TurnService<Value>): Value => {
        const record = toTurnServiceRecord(service);
        if (
          staged.some(
            (candidate) =>
              candidate.kind.identity === record.kind.identity &&
              candidate.key === record.key,
          )
        ) {
          throw new Error(
            `Plugin ${plugin.name} provides duplicate Turn service ` +
              `${record.kind.id}:${record.key}`,
          );
        }

        staged.push(record);
        return service.value;
      },
      get: <Value>(
        kind: TurnServiceKind<Value>,
        key: string,
      ): Value | undefined => findStaged(kind, key) ?? this.get(kind, key),
      require: <Value>(
        kind: TurnServiceKind<Value>,
        key: string,
      ): Value => {
        const value = findStaged(kind, key) ?? this.get(kind, key);
        if (value === undefined) {
          throw new Error(`Missing Turn service ${kind.id}:${key}`);
        }
        return value;
      },
      defer: (cleanup) => scope.defer(cleanup),
    };

    try {
      await plugin.install(context);
      this.register(scope, staged, options);
      return new InstalledTurnServicePlugin(plugin.name, scope);
    } catch (cause) {
      try {
        await scope.close();
      } catch (cleanupCause) {
        throw new AggregateError(
          [asError(cause), asError(cleanupCause)],
          `Plugin ${plugin.name} failed and cleanup also failed`,
        );
      }
      throw cause;
    }
  }

  entries<Value>(
    kind: TurnServiceKind<Value>,
  ): readonly RegisteredTurnService<Value>[] {
    return this.effectiveServices().filter(
      (service) => service.kind.identity === kind.identity,
    ) as unknown as readonly RegisteredTurnService<Value>[];
  }

  get<Value>(kind: TurnServiceKind<Value>, key: string): Value | undefined {
    return this.entries(kind).find((service) => service.key === key)?.value;
  }

  require<Value>(kind: TurnServiceKind<Value>, key: string): Value {
    const value = this.get(kind, key);
    if (value === undefined) {
      throw new Error(`Missing Turn service ${kind.id}:${key}`);
    }
    return value;
  }

  /** Capture the effective services and keep their resources alive. */
  lease(): TurnServiceRegistryLease {
    return this.leaseCoordinator.capture(() =>
      this.effectiveServices().map(
        ({ registration: _registration, ...service }) => service,
      ),
    );
  }

  close(): Promise<void> {
    return this.lifetime.close();
  }

  private effectiveServices(): readonly StoredRegistration[] {
    const byKind = new Map<
      symbol,
      Map<string, StoredRegistration>
    >();

    for (const service of this.registered) {
      let services = byKind.get(service.kind.identity);
      if (!services) {
        services = new Map();
        byKind.set(service.kind.identity, services);
      }
      services.set(service.key, service);
    }

    return Object.freeze(
      [...byKind.values()]
        .flatMap((services) => [...services.values()])
        .sort(
          (left, right) =>
            left.order - right.order ||
            left.registeredAt - right.registeredAt ||
            left.kind.id.localeCompare(right.kind.id) ||
            left.key.localeCompare(right.key),
        ),
    );
  }

  private register(
    scope: Scope,
    services: readonly TurnServiceRecord[],
    options: TurnServicePluginInstallationOptions,
  ): void {
    if (services.length === 0) return;

    const kinds = new Map(this.kindsById);
    for (const service of services) {
      const known = kinds.get(service.kind.id);
      if (known && known.identity !== service.kind.identity) {
        throw new Error(
          `Turn service kind Id "${service.kind.id}" is already claimed ` +
            "by a different TurnServiceKind",
        );
      }
      kinds.set(service.kind.id, service.kind);
    }

    if (options.rejectServiceConflicts) {
      const effective = this.effectiveServices();
      for (const service of services) {
        if (
          effective.some(
            (registered) =>
              registered.kind.identity === service.kind.identity &&
              registered.key === service.key,
          )
        ) {
          throw new Error(
            `Turn service ${service.kind.id}:${service.key} is already registered`,
          );
        }
      }
    }

    for (const service of services) {
      this.kindsById.set(service.kind.id, service.kind);
    }

    const registered = services.map(
      (service): StoredRegistration => Object.freeze({
        ...service,
        registeredAt: this.nextRegistrationOrder++,
        registration: Symbol(`${service.kind.id}:${service.key}`),
      }),
    );

    this.registered.push(...registered);

    const registrations = new Set(
      registered.map((service) => service.registration),
    );
    scope.defer(async () => {
      // Hide the complete Plugin group synchronously so later leases cannot
      // capture it.
      for (let index = this.registered.length - 1; index >= 0; index -= 1) {
        if (registrations.has(this.registered[index]!.registration)) {
          this.registered.splice(index, 1);
        }
      }

      // Only leases that could have captured these registrations delay the
      // Plugin's remaining resource cleanup.
      await this.leaseCoordinator.whenCurrentLeasesFinish();
    });
  }
}
