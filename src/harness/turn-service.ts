/** A typed kind of service that may be selected for a Turn. */
import {
  assertNonempty,
  deepFreeze,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import type {
  Prompt,
  ProviderFailureDisposition,
} from "./session-facts.js";

export interface TurnServiceKindRef {
  readonly identity: symbol;
  readonly id: string;
  readonly toolAccess: TurnServiceToolAccess;
}

export type TurnServiceToolAccess = "internal" | "scoped-resource";

export type TurnServiceKindOptions<Value> = {
  /** Whether a Tool may receive values of this kind through its resolver. */
  readonly toolAccess?: TurnServiceToolAccess;

  /** Stabilize a supplied live value before settings are derived and stored. */
  readonly prepareValue?: (value: Value) => Value;
};

export class TurnServiceKind<Value> implements TurnServiceKindRef {
  /** Collision-safe identity for live lookup. */
  readonly identity: symbol;

  /** Keeps Value invariant in TypeScript's structural type system. */
  declare private readonly valueType: (value: Value) => Value;

  constructor(
    readonly id: string,
    private readonly completeSettings: (
      value: Value,
      supplied: JsonObject,
    ) => JsonObject,
    readonly toolAccess: TurnServiceToolAccess,
    private readonly prepare: (value: Value) => Value,
  ) {
    if (!id.trim()) throw new Error("Turn service kind Id cannot be empty");
    this.identity = Symbol(id);
    Object.freeze(this);
  }

  /** Complete this kind's durable settings from its live value. */
  settingsFor(value: Value, supplied: JsonObject): JsonObject {
    return this.completeSettings(value, supplied);
  }

  /** Produce the stable live value retained by the service registration. */
  prepareValue(value: Value): Value {
    return this.prepare(value);
  }
}

/** Define one open, typed kind of service a Turn may need. */
export function defineTurnServiceKind<Value>(
  id: string,
  completeSettings: (
    value: Value,
    supplied: JsonObject,
  ) => JsonObject = (_value, supplied) => supplied,
  options: TurnServiceKindOptions<Value> = {},
): TurnServiceKind<Value> {
  return new TurnServiceKind<Value>(
    id,
    completeSettings,
    options.toolAccess ?? "internal",
    options.prepareValue ?? ((value) => value),
  );
}

// ===========================================================================
// Turn service definition
// ===========================================================================

export type TurnServiceOptions = {
  readonly revision: string;

  /**
   * Complete durable JSON configuration affecting this service's semantics.
   * Omit it only when the service genuinely has no such configuration. Live
   * functions, clients, credentials, and connections do not belong here.
   */
  readonly settings?: JsonObject;

  /** Explicit relative precedence; equal values retain installation order. */
  readonly order?: number;
};

export type TurnService<Value> = {
  readonly kind: TurnServiceKind<Value>;
  readonly key: string;

  /**
   * Live behavior. Public identity and behavior-defining fields must remain
   * stable for the registration lifetime; stateful resources hidden behind
   * that stable interface may continue to change internally.
   */
  readonly value: Value;
  readonly revision: string;
  readonly settings: JsonObject;
  readonly order: number;
};

export type RegisteredTurnService<Value> = TurnService<Value> & {
  /** Registry-assigned fallback ordering for equal explicit order values. */
  readonly registeredAt: number;
};

/** Identity of one service selected in a frozen Turn configuration. */
export type TurnServiceReference = {
  readonly kind: string;
  readonly key: string;
};

/** Read-only lookup over a complete or authorization-restricted service set. */
export interface TurnServiceResolver {
  entries<Value>(
    kind: TurnServiceKind<Value>,
  ): readonly RegisteredTurnService<Value>[];

  get<Value>(kind: TurnServiceKind<Value>, key: string): Value | undefined;

  require<Value>(kind: TurnServiceKind<Value>, key: string): Value;
}

export function defineTurnService<Value>(
  kind: TurnServiceKind<Value>,
  key: string,
  value: Value,
  options: TurnServiceOptions,
): TurnService<Value> {
  if (!key.trim()) throw new Error("Turn service key cannot be empty");
  if (value === undefined) {
    throw new Error("Turn service value cannot be undefined");
  }
  if (!options.revision.trim()) {
    throw new Error("Turn service revision cannot be empty");
  }

  const preparedValue = kind.prepareValue(value);
  if (preparedValue === undefined) {
    throw new Error("Prepared Turn service value cannot be undefined");
  }

  return Object.freeze({
    kind,
    key,
    value: preparedValue,
    revision: options.revision,
    settings: deepFreeze(
      structuredClone(
        kind.settingsFor(preparedValue, options.settings ?? {}),
      ),
    ),
    order: options.order ?? 0,
  });
}

// ===========================================================================
// Tool
// ===========================================================================

/** The immutable provider-visible portion of a Tool. */
export type ToolDescription = {
  /** Independent of the registry service key. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
};

/** One live operation that a Provider may request during a Turn. */
export interface Tool extends ToolDescription {
  /**
   * Resolve with JSON on success or reject only for a known terminal error.
   * Throw ToolOutcomeUnknown when execution may have happened but its outcome
   * cannot be established; the executor will leave the commitment unsettled.
   */
  execute(input: unknown, context: ToolExecutionContext): Promise<JsonValue>;
}

/** A committed Tool invocation whose external outcome cannot be established. */
export class ToolOutcomeUnknown extends Error {
  override readonly name = "ToolOutcomeUnknown";
}

/** The resolved result of one Provider-requested Tool call. */
export type ToolCallResult =
  | {
      readonly outcome: "ok";
      readonly callId: string;
      readonly name: string;
      readonly output: JsonValue;
    }
  | {
      readonly outcome: "error";
      readonly callId: string;
      readonly name: string;
      readonly error: string;
    }
  | {
      readonly outcome: "rejected";
      readonly callId: string;
      readonly name: string;
      readonly reason: string;
    };

/** One Tool-call authorization result. */
export type ToolCallDecision =
  | {
      readonly type: "allow";

      /**
       * Optional upper bound on services this call may access. Absence leaves
       * the current scope unchanged; ordered rules intersect their bounds.
       */
      readonly scope?: readonly TurnServiceReference[];
    }
  | { readonly type: "deny"; readonly reason: string };

/** Context supplied to every selected ToolCallRule. */
export type ToolCallContext = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly callId: string;

  /** Internal registry identity of the selected Tool service. */
  readonly toolKey: string;

  /** Provider-visible identity and schema of that Tool. */
  readonly tool: ToolDescription;

  /** Exact arguments emitted by the Provider. */
  readonly argumentsJSON: string;
  readonly signal: AbortSignal;
};

/** Context supplied to Tool.execute() after authorization is committed. */
export type ToolExecutionContext = ToolCallContext & {
  /** Only the frozen Turn services authorized for this Tool call. */
  readonly services: TurnServiceResolver;
};

/**
 * One ordered authorization rule applied to a Provider-requested Tool call.
 * For identical durable call data and the same frozen service configuration,
 * it must return the same decision and scope. Cancellation may stop evaluation
 * but must not otherwise influence its result.
 */
export type ToolCallRule = (
  context: ToolCallContext,
  services: TurnServiceResolver,
) => ToolCallDecision | Promise<ToolCallDecision>;

// ===========================================================================
// Provider
// ===========================================================================

/** Complete transient input for one provider invocation. */
export type ProviderRequest = {
  readonly model: string;
  readonly instructions: readonly string[];
  readonly history: readonly JsonObject[];
  readonly tools: readonly ToolDescription[];
  readonly metadata: JsonObject;
};

/** One observation emitted while a provider invocation is running. */
export type ProviderEvent =
  | {
      /** Transient text for immediate publication to live subscribers. */
      readonly type: "text-delta";
      readonly outputIndex: number;
      readonly contentIndex: number;
      readonly delta: string;
    }
  | {
      readonly type: "output-item";
      readonly outputIndex: number;
      readonly item: JsonObject;
    }
  | {
      readonly type: "tool-call";
      readonly outputIndex: number;
      readonly itemId: string;
      readonly callId: string;
      readonly name: string;
      readonly argumentsJSON: string;
      readonly providerItem: JsonObject;
    }
  | {
      readonly type: "completed";
      readonly responseId: string;
    }
  | {
      /**
       * A definite terminal Provider failure normalized by the adapter. This
       * must not represent an uncertain disconnect or missing terminal event.
       */
      readonly type: "failed";
      readonly error: string;
      readonly disposition: ProviderFailureDisposition;
    };

/** One selected provider used by every Step of a frozen Turn. */
export interface Provider {
  /** Compatibility identity for provider-native history items. */
  readonly historyFormat: string;

  /**
   * Encode one durable Prompt into this Provider's native history format.
   * This must be deterministic: the same Prompt under the same frozen service
   * revision/configuration must produce semantically identical JSON.
   */
  encodePrompt(prompt: Prompt): readonly JsonObject[];

  /**
   * Encode one durable Tool-call result into this Provider's native format.
   * This has the same deterministic, side-effect-free contract as
   * encodePrompt().
   */
  encodeToolCallResult(result: ToolCallResult): JsonObject;

  stream(
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
}

// ===========================================================================
// History translation
// ===========================================================================

/** One provider-native item durably recorded from a Step. */
export type ProviderOutputItem = {
  readonly outputIndex: number;
  readonly item: JsonObject;
};

/** One completed Step retained inside its complete Turn history. */
export type StepHistory = {
  readonly stepId: string;

  /** Initial or steering Prompts consumed before this provider invocation. */
  readonly prompts: readonly Prompt[];

  /** Provider response items, kept in provider output order. */
  readonly providerItems: readonly ProviderOutputItem[];

  /**
   * Results of Tool calls requested by those items. They are a separate phase:
   * they follow the complete provider response and feed the next Step.
   */
  readonly toolCallResults: readonly ToolCallResult[];
};

/**
 * One complete settled Turn reconstructed as provider continuation history.
 * Its configuration and history format were frozen across every nested Step.
 */
export type ProviderTurnHistory = {
  readonly turnId: string;
  readonly historyFormat: string;
  readonly steps: readonly StepHistory[];
};

/**
 * Translate one complete foreign-format Turn for a later selected Provider.
 * Translation never occurs between Steps of the same frozen Turn.
 */
export interface HistoryTranslator {
  readonly sourceFormat: string;
  readonly targetFormat: string;

  /**
   * Deterministically translate durable history. Identical history under the
   * same frozen service revision/configuration must produce semantically
   * identical JSON without clocks, randomness, or unrecorded external state.
   */
  translate(turn: ProviderTurnHistory): readonly JsonObject[];
}

// ===========================================================================
// Location
// ===========================================================================

/** One general place in which a Turn may perform work. */
export interface Location {
  /** Canonical, absolute, credential-free identity of the place. */
  readonly uri: string;
}

function locationUri(location: Location): string {
  assertNonempty(location.uri, "Location URI");

  let parsed: URL;
  try {
    parsed = new URL(location.uri);
  } catch {
    throw new Error("Location URI must be absolute");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Location URI must not contain credentials");
  }
  if (parsed.href !== location.uri) {
    throw new Error(`Location URI must be canonical: ${parsed.href}`);
  }

  return location.uri;
}

function prepareLocation(location: Location): Location {
  return Object.freeze({ uri: locationUri(location) });
}

// ===========================================================================
// Turn service kinds
// ===========================================================================

export const Tool = defineTurnServiceKind<Tool>(
  "tool",
  (tool, supplied) => {
    assertNonempty(tool.name, "Tool name");
    return {
      ...supplied,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
  },
);
export const ToolCallRule =
  defineTurnServiceKind<ToolCallRule>("tool-call-rule");
export const HistoryTranslator = defineTurnServiceKind<HistoryTranslator>(
  "history-translator",
  (translator, supplied) => {
    assertNonempty(translator.sourceFormat, "History source format");
    assertNonempty(translator.targetFormat, "History target format");
    return {
      ...supplied,
      sourceFormat: translator.sourceFormat,
      targetFormat: translator.targetFormat,
    };
  },
);
export const Provider = defineTurnServiceKind<Provider>(
  "provider",
  (provider, supplied) => {
    assertNonempty(provider.historyFormat, "Provider history format");
    return {
      ...supplied,
      historyFormat: provider.historyFormat,
    };
  },
);
export const Location = defineTurnServiceKind<Location>(
  "location",
  (location, supplied) => ({
    ...supplied,
    uri: location.uri,
  }),
  {
    toolAccess: "scoped-resource",
    prepareValue: prepareLocation,
  },
);
// export const Worktree = defineTurnServiceKind<Worktree>("worktree");
