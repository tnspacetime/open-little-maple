/** Persistent declarations to live, scoped Turn-service Plugin installations. */
import {
  asError,
  assertNonempty,
  deepFreeze,
  jsonValue,
  object,
  stringField,
  type JsonObject,
} from "./json.js";
import type {
  TurnServicePlugin,
  TurnServicePluginFactory,
  TurnServicePluginFactoryRegistration,
} from "./turn-service-plugin.js";
import {
  type InstalledTurnServicePlugin,
  TurnServiceRegistry,
} from "./turn-service-registry.js";

/** One persistable configured use of a code-owned Plugin factory. */
export type TurnServicePluginDeclaration = {
  /** Stable identity of this configured Plugin instance. */
  readonly id: string;

  /** Stable Id of its code-owned TurnServicePluginFactoryRegistration. */
  readonly factory: string;

  /** Complete JSON input interpreted by that factory. */
  readonly settings: JsonObject;
};

export type LoadTurnServicePluginsOptions = {
  readonly registry: TurnServiceRegistry;
  readonly factories: readonly TurnServicePluginFactoryRegistration[];

  /** Application defaults in deterministic installation order. */
  readonly codeDeclarations?: readonly TurnServicePluginDeclaration[];

  /** Already-parsed JSON array; matching instance Ids override code defaults. */
  readonly jsonDeclarations?: unknown;
};

/** Preserve the persistent instance identity beside its live installation. */
export type LoadedTurnServicePlugin = {
  readonly id: string;
  readonly installation: InstalledTurnServicePlugin;
};

/**
 * Reconstruct the live registry from code defaults overlaid by persistent JSON.
 *
 * This function does not read files. It validates and detaches both inputs,
 * resolves each factory Id, constructs Plugins, and installs them through the
 * existing scoped registry boundary. Each Plugin rejects service conflicts
 * before atomic publication. A later failure rolls back earlier installations
 * in reverse order, but the complete group is not one visibility transaction;
 * the caller must not expose the bootstrap registry until loading succeeds.
 */
export async function loadTurnServicePlugins(
  options: LoadTurnServicePluginsOptions,
): Promise<readonly LoadedTurnServicePlugin[]> {
  const factories = factoryCatalog(options.factories);
  const code = readDeclarations(
    options.codeDeclarations ?? [],
    "Code Turn-service Plugin declarations",
  );
  const json = readDeclarations(
    options.jsonDeclarations ?? [],
    "JSON Turn-service Plugin declarations",
  );
  const declarations = overlayDeclarations(code, json);
  const loaded: LoadedTurnServicePlugin[] = [];

  try {
    for (const declaration of declarations) {
      const factory = factories.get(declaration.factory);
      if (!factory) {
        throw new Error(
          `Unknown Turn-service Plugin factory "${declaration.factory}" ` +
            `for Plugin instance "${declaration.id}"`,
        );
      }

      const plugin = factory(declaration.settings);
      assertPlugin(plugin, declaration);
      const installation = await options.registry.install(plugin, {
        rejectServiceConflicts: true,
      });
      loaded.push(Object.freeze({ id: declaration.id, installation }));
    }

    return Object.freeze([...loaded]);
  } catch (cause) {
    const failures = [asError(cause)];
    for (const { installation } of [...loaded].reverse()) {
      try {
        await installation.close();
      } catch (cleanupCause) {
        failures.push(asError(cleanupCause));
      }
    }

    if (failures.length === 1) throw failures[0];
    throw new AggregateError(
      failures,
      "Turn-service Plugin loading and rollback failed",
    );
  }
}

function factoryCatalog(
  registrations: readonly TurnServicePluginFactoryRegistration[],
): ReadonlyMap<string, TurnServicePluginFactory> {
  const factories = new Map<string, TurnServicePluginFactory>();
  for (const [index, registration] of registrations.entries()) {
    const label = `Turn-service Plugin factory registration ${index}`;
    if (!registration || typeof registration !== "object") {
      throw new Error(`${label} must be an object`);
    }
    if (typeof registration.id !== "string") {
      throw new Error(`${label} Id must be a string`);
    }
    assertNonempty(registration.id, `${label} Id`);
    if (typeof registration.factory !== "function") {
      throw new Error(`${label} factory must be a function`);
    }
    if (factories.has(registration.id)) {
      throw new Error(
        `Duplicate Turn-service Plugin factory Id "${registration.id}"`,
      );
    }
    factories.set(registration.id, registration.factory);
  }
  return factories;
}

function readDeclarations(
  input: unknown,
  label: string,
): readonly TurnServicePluginDeclaration[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`);

  const declarations = input.map((candidate, index) => {
    const itemLabel = `${label}[${index}]`;
    const value = object(jsonValue(candidate, itemLabel), itemLabel);
    const id = stringField(value, "id");
    const factory = stringField(value, "factory");
    assertNonempty(id, `${itemLabel} Id`);
    assertNonempty(factory, `${itemLabel} factory Id`);
    const settings = object(value.settings, `${itemLabel}.settings`);

    return deepFreeze({ id, factory, settings });
  });

  const seen = new Set<string>();
  for (const declaration of declarations) {
    if (seen.has(declaration.id)) {
      throw new Error(
        `${label} contains duplicate Plugin instance Id "${declaration.id}"`,
      );
    }
    seen.add(declaration.id);
  }

  return Object.freeze(declarations);
}

function overlayDeclarations(
  code: readonly TurnServicePluginDeclaration[],
  json: readonly TurnServicePluginDeclaration[],
): readonly TurnServicePluginDeclaration[] {
  const effective = [...code];
  const indexes = new Map(
    effective.map((declaration, index) => [declaration.id, index]),
  );

  for (const declaration of json) {
    const index = indexes.get(declaration.id);
    if (index === undefined) {
      indexes.set(declaration.id, effective.length);
      effective.push(declaration);
    } else {
      // An override retains the code declaration's installation position.
      effective[index] = declaration;
    }
  }

  return Object.freeze(effective);
}

function assertPlugin(
  plugin: TurnServicePlugin,
  declaration: TurnServicePluginDeclaration,
): void {
  if (!plugin || typeof plugin !== "object") {
    throw new Error(
      `Factory "${declaration.factory}" did not return a Plugin object`,
    );
  }
  if (typeof plugin.name !== "string") {
    throw new Error(
      `Factory "${declaration.factory}" returned a Plugin without a name`,
    );
  }
  assertNonempty(plugin.name, `Factory "${declaration.factory}" Plugin name`);
  if (typeof plugin.install !== "function") {
    throw new Error(
      `Factory "${declaration.factory}" returned a Plugin without install()`,
    );
  }
}
