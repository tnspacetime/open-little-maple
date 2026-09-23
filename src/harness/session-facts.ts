/** Generic durable fact vocabulary for one Session history. */
import {
  assertNonempty,
  deepFreeze,
  jsonValue,
  nonnegativeIntegerField,
  numberField,
  object,
  objectsField,
  stringField,
  stringsField,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import type {
  TurnServiceConfigurationDescription,
  TurnServiceDescription,
} from "./turn-service-configuration.js";

/** One fact proposed for durable publication. */
export type SessionFact = {
  readonly id: string;
  readonly type: string;
  readonly data: JsonObject;
};

/** One durably stored fact in a resolved Session history. */
export type StoredSessionFact = SessionFact & {
  /** Session whose private suffix physically stores this fact. */
  readonly sessionId: string;

  /** Semantic position in every resolved Session history containing it. */
  readonly seq: number;

  readonly createdAt: number;
};

/** Open, typed identity and payload decoder for one Session fact kind. */
export class SessionFactKind<Data extends JsonObject> {
  constructor(
    readonly type: string,
    readonly decode: (data: JsonObject) => Data,
  ) {}

  make(id: string, data: Data): SessionFact {
    return {
      id,
      type: this.type,
      data,
    };
  }
}

// ===========================================================================
// Current Turn-service configuration
// ===========================================================================

/**
 * This is the one concrete fact defined in this section. Its data is the
 * complete TurnServiceConfigurationDescription directly—there is no separate
 * selection, intent, or wrapper-data representation. The decoder only
 * validates JSON read from the append log.
 *
 * The description remains current for the Session until a later fact of this
 * kind replaces it.
 */
export const TurnServiceConfigurationFact =
  new SessionFactKind<TurnServiceConfigurationDescription>(
    "turn-service.configuration",
    decodeTurnServiceConfigurationDescription,
  );

/** Validate the complete untrusted configuration JSON during append/replay. */
function decodeTurnServiceConfigurationDescription(
  value: unknown,
): TurnServiceConfigurationDescription {
  const configuration = object(value, "Turn service configuration");
  const services = objectsField(configuration, "services").map(
    (service, index) =>
      decodeTurnServiceDescription(
        service,
        `Turn service configuration services[${index}]`,
      ),
  );
  const identities = new Set<string>();

  for (const service of services) {
    const identity = `${service.kind}\u0000${service.key}`;
    if (identities.has(identity)) {
      throw new Error(
        `Turn service configuration repeats ${service.kind}:${service.key}`,
      );
    }
    identities.add(identity);
  }

  return deepFreeze({ services });
}

/** Validate one description nested inside the configuration fact. */
function decodeTurnServiceDescription(
  value: unknown,
  label: string,
): TurnServiceDescription {
  const service = object(value, label);
  const kind = stringField(service, "kind");
  const key = stringField(service, "key");
  const revision = stringField(service, "revision");
  assertNonempty(kind, `${label} kind`);
  assertNonempty(key, `${label} key`);
  assertNonempty(revision, `${label} revision`);

  const settingsLabel = `${label} settings`;
  const settings = object(
    jsonValue(service.settings, settingsLabel),
    settingsLabel,
  );

  return deepFreeze({
    kind,
    key,
    revision,
    settings,
    order: numberField(service, "order"),
  });
}

// ===========================================================================
// Prompt admission
// ===========================================================================

export type PromptMode = "queue" | "steer";

export type PromptPart = JsonObject & {
  readonly type: string;
};

/** One immutable piece of user input admitted to a Session. */
export type Prompt = {
  readonly id: string;
  readonly mode: PromptMode;
  readonly parts: readonly PromptPart[];
};

/**
 * One complete Prompt entered the Session's append log. The Prompt itself is
 * the fact data; there is no additional wrapper-data type.
 */
export const PromptAdmitted = new SessionFactKind<Prompt>(
  "prompt.admitted",
  decodePrompt,
);

/** Validate and detach untrusted Prompt JSON during append and replay. */
function decodePrompt(value: unknown): Prompt {
  const prompt = object(value, "Prompt");
  const id = stringField(prompt, "id");
  assertNonempty(id, "Prompt Id");

  const mode = prompt.mode;
  if (mode !== "queue" && mode !== "steer") {
    throw new Error("Prompt mode must be queue or steer");
  }

  const parts = objectsField(prompt, "parts").map((part, index) => {
    const label = `Prompt part ${index}`;
    const validated = object(jsonValue(part, label), label);
    const type = stringField(validated, "type");
    assertNonempty(type, `${label} type`);
    return deepFreeze({ ...validated, type });
  });

  return deepFreeze({ id, mode, parts });
}

/**
 * A pending queue Prompt and the queued suffix after it were explicitly
 * cancelled before starting Turns. Admission order defines that suffix; the
 * single target Id is the durable cutoff rather than a copied list.
 */
export type PromptSkippedData = {
  readonly promptId: string;
  readonly reason: "cancelled";
};

export const PromptSkipped = new SessionFactKind<PromptSkippedData>(
  "prompt.skipped",
  decodePromptSkipped,
);

/** Validate untrusted PromptSkipped JSON during append and replay. */
function decodePromptSkipped(value: unknown): PromptSkippedData {
  const skipped = object(value, "PromptSkipped");
  const promptId = stringField(skipped, "promptId");
  assertNonempty(promptId, "Skipped Prompt Id");
  if (skipped.reason !== "cancelled") {
    throw new Error("Prompt skip reason must be cancelled");
  }
  return deepFreeze({ promptId, reason: "cancelled" });
}

// ===========================================================================
// Turn lifecycle
// ===========================================================================

/**
 * The durable beginning of one complete user-level job. It claims exactly one
 * pending queue Prompt. A Prompt already supports multiple parts; separately
 * admitted queue Prompts remain separate jobs rather than being batched into
 * one Turn. The Turn uses the current service
 * configuration already established by the preceding Session facts; that
 * configuration is not duplicated here.
 */
export type TurnStartedData = {
  readonly turnId: string;
  readonly promptId: string;
};

export const TurnStarted = new SessionFactKind<TurnStartedData>(
  "turn.started",
  decodeTurnStarted,
);

/** Validate and detach untrusted TurnStarted JSON during append and replay. */
function decodeTurnStarted(value: unknown): TurnStartedData {
  const started = object(value, "TurnStarted");
  const turnId = stringField(started, "turnId");
  assertNonempty(turnId, "Turn Id");

  const promptId = stringField(started, "promptId");
  assertNonempty(promptId, "Turn Prompt Id");

  return deepFreeze({ turnId, promptId });
}

// ===========================================================================
// Step lifecycle
// ===========================================================================

/**
 * The final durable boundary before one provider invocation inside an active
 * Turn. ProviderRequest derivation creates no new durable truth, so there is no
 * StepPrepared fact: the request is computed from preceding Session facts and
 * the Turn's frozen service configuration before this commitment is appended.
 *
 * This fact establishes the Step, claims any steering Prompts entering it, and
 * permits the Harness to call Provider.stream(). The first Step processes the
 * queue Prompt already claimed by TurnStarted, so its steering Prompt list may
 * be empty. A later Step must be justified by Tool-call results from the
 * preceding Step, one or more newly claimed steering Prompts, or both. Its list
 * may therefore be empty only when Tool results supply the continuation.
 * Starting another Provider invocation with neither Tools nor steers would add
 * no new input and is rejected; the Turn must settle instead.
 *
 * Several steering Prompts may accumulate while the preceding Provider or its
 * Tools are running. Their separate durable identities and admission order are
 * preserved, so promptIds is plural rather than merging their contents.
 *
 * ProviderOutput and ToolCallRequested facts are later evidence that the
 * Provider responded; commitment itself does not prove physical provider
 * contact. Without a settlement, external reality is ambiguous and the Step
 * must not be silently retried.
 *
 * A retry is a separate Provider invocation and therefore a separate Step.
 * retryOfStepId identifies the immediately preceding failed Step whose exact
 * original ProviderRequest boundary must be reused. A retry claims no new
 * steering Prompts; steers admitted meanwhile remain pending for a later
 * normal continuation.
 */
export type StepCommittedData = {
  readonly turnId: string;
  readonly stepId: string;
  readonly promptIds: readonly string[];
  readonly retryOfStepId?: string;
};

export const StepCommitted = new SessionFactKind<StepCommittedData>(
  "step.committed",
  decodeStepCommitted,
);

/** Validate and detach untrusted StepCommitted JSON during append and replay. */
function decodeStepCommitted(value: unknown): StepCommittedData {
  const committed = object(value, "StepCommitted");
  const turnId = stringField(committed, "turnId");
  const stepId = stringField(committed, "stepId");
  assertNonempty(turnId, "Step Turn Id");
  assertNonempty(stepId, "Step Id");

  const retryOfStepId = committed.retryOfStepId;
  if (retryOfStepId !== undefined) {
    if (typeof retryOfStepId !== "string") {
      throw new Error("retryOfStepId must be a string");
    }
    assertNonempty(retryOfStepId, "Retried Step Id");
  }

  const promptIds = stringsField(committed, "promptIds");
  const seen = new Set<string>();
  for (const promptId of promptIds) {
    assertNonempty(promptId, "Step Prompt Id");
    if (seen.has(promptId)) {
      throw new Error(`StepCommitted repeats Prompt ${promptId}`);
    }
    seen.add(promptId);
  }

  return deepFreeze(
    retryOfStepId === undefined
      ? { turnId, stepId, promptIds }
      : { turnId, stepId, promptIds, retryOfStepId },
  );
}

// ===========================================================================
// Provider lifecycle
// ===========================================================================

/** One complete provider-native output item emitted by a Step. */
export type ProviderOutputData = {
  readonly turnId: string;
  readonly stepId: string;
  readonly outputIndex: number;
  readonly item: JsonObject;
};

export const ProviderOutput = new SessionFactKind<ProviderOutputData>(
  "provider.output",
  decodeProviderOutput,
);

/** Validate and detach untrusted ProviderOutput JSON during append and replay. */
function decodeProviderOutput(value: unknown): ProviderOutputData {
  const output = object(value, "ProviderOutput");
  const turnId = stringField(output, "turnId");
  const stepId = stringField(output, "stepId");
  assertNonempty(turnId, "Provider output Turn Id");
  assertNonempty(stepId, "Provider output Step Id");

  const item = object(
    jsonValue(output.item, "Provider output item"),
    "Provider output item",
  );

  return deepFreeze({
    turnId,
    stepId,
    outputIndex: nonnegativeIntegerField(output, "outputIndex"),
    item,
  });
}

/**
 * One Tool call requested by the Provider. This records the request only; it
 * does not mean that a ToolCallRule allowed it or that execution began.
 */
export type ToolCallRequestedData = {
  readonly turnId: string;
  readonly stepId: string;
  readonly outputIndex: number;
  readonly itemId: string;
  readonly callId: string;
  readonly name: string;
  readonly argumentsJSON: string;
  readonly providerItem: JsonObject;
};

export const ToolCallRequested =
  new SessionFactKind<ToolCallRequestedData>(
    "tool-call.requested",
    decodeToolCallRequested,
  );

/** Validate and detach untrusted ToolCallRequested JSON. */
function decodeToolCallRequested(value: unknown): ToolCallRequestedData {
  const requested = object(value, "ToolCallRequested");
  const turnId = stringField(requested, "turnId");
  const stepId = stringField(requested, "stepId");
  const itemId = stringField(requested, "itemId");
  const callId = stringField(requested, "callId");
  const name = stringField(requested, "name");
  assertNonempty(turnId, "Tool call Turn Id");
  assertNonempty(stepId, "Tool call Step Id");
  assertNonempty(itemId, "Tool call item Id");
  assertNonempty(callId, "Tool call Id");
  assertNonempty(name, "Tool call name");

  const providerItem = object(
    jsonValue(requested.providerItem, "Tool call provider item"),
    "Tool call provider item",
  );

  return deepFreeze({
    turnId,
    stepId,
    outputIndex: nonnegativeIntegerField(requested, "outputIndex"),
    itemId,
    callId,
    name,
    argumentsJSON: stringField(requested, "argumentsJSON"),
    providerItem,
  });
}

/**
 * The Provider's actual terminal outcome for one Step. This fact records the
 * terminal signal observed from the Provider; it is not inferred from an
 * absence of later output. Once it is durable, no later ProviderOutput or
 * ToolCallRequested is valid for the Step.
 *
 * This closes only the Provider invocation. The complete Step remains active
 * until every Tool call requested before this fact is rejected or settled.
 */
/** Whether one known Provider failure may safely be dispatched again. */
export type ProviderFailureDisposition = "retry-safe" | "terminal";

export type ProviderSettledData =
  | {
      readonly turnId: string;
      readonly stepId: string;
      readonly outcome: "completed";
      readonly responseId: string;
    }
  | {
      readonly turnId: string;
      readonly stepId: string;
      readonly outcome: "failed";
      readonly error: string;
      readonly disposition: ProviderFailureDisposition;
    };

export const ProviderSettled = new SessionFactKind<ProviderSettledData>(
  "provider.settled",
  decodeProviderSettled,
);

/** Validate untrusted ProviderSettled JSON during append and replay. */
function decodeProviderSettled(value: unknown): ProviderSettledData {
  const settled = object(value, "ProviderSettled");
  const turnId = stringField(settled, "turnId");
  const stepId = stringField(settled, "stepId");
  assertNonempty(turnId, "Settled Provider Turn Id");
  assertNonempty(stepId, "Settled Provider Step Id");

  if (settled.outcome === "completed") {
    const responseId = stringField(settled, "responseId");
    assertNonempty(responseId, "Settled Provider response Id");
    return deepFreeze({
      turnId,
      stepId,
      outcome: "completed",
      responseId,
    });
  }

  if (settled.outcome === "failed") {
    const error = stringField(settled, "error");
    assertNonempty(error, "Settled Provider error");
    const disposition = settled.disposition;
    if (disposition !== "retry-safe" && disposition !== "terminal") {
      throw new Error(
        "Provider failure disposition must be retry-safe or terminal",
      );
    }
    return deepFreeze({
      turnId,
      stepId,
      outcome: "failed",
      error,
      disposition,
    });
  }

  throw new Error("Unknown Provider settlement outcome");
}

// ===========================================================================
// Tool-call lifecycle
// ===========================================================================

/** Why a requested Tool call reached a terminal state without execution. */
export type ToolCallRejectionKind =
  | "denied"
  | "unavailable"
  | "invalid-arguments";

/**
 * A terminal decision not to execute a requested Tool call. An allowed call
 * has no corresponding fact here; ToolCallCommitted is its durable boundary.
 */
export type ToolCallRejectedData = {
  readonly turnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly kind: ToolCallRejectionKind;
  readonly reason: string;
};

export const ToolCallRejected =
  new SessionFactKind<ToolCallRejectedData>(
    "tool-call.rejected",
    decodeToolCallRejected,
  );

/** Validate untrusted ToolCallRejected JSON during append and replay. */
function decodeToolCallRejected(value: unknown): ToolCallRejectedData {
  const rejected = object(value, "ToolCallRejected");
  const turnId = stringField(rejected, "turnId");
  const stepId = stringField(rejected, "stepId");
  const callId = stringField(rejected, "callId");
  const reason = stringField(rejected, "reason");
  assertNonempty(turnId, "Rejected Tool call Turn Id");
  assertNonempty(stepId, "Rejected Tool call Step Id");
  assertNonempty(callId, "Rejected Tool call Id");
  assertNonempty(reason, "Rejected Tool call reason");

  const kind = rejected.kind;
  if (
    kind !== "denied" &&
    kind !== "unavailable" &&
    kind !== "invalid-arguments"
  ) {
    throw new Error("Unknown Tool-call rejection kind");
  }

  return deepFreeze({ turnId, stepId, callId, kind, reason });
}

/**
 * The final durable boundary before invoking one allowed Tool call. It records
 * the Harness's commitment to attempt the call, not proof that Tool.execute()
 * physically began. Without a later settlement, external reality is ambiguous
 * and the call must not be silently retried.
 */
export type ToolCallCommittedData = {
  readonly turnId: string;
  readonly stepId: string;
  readonly callId: string;
};

export const ToolCallCommitted =
  new SessionFactKind<ToolCallCommittedData>(
    "tool-call.committed",
    decodeToolCallCommitted,
  );

/** Validate untrusted ToolCallCommitted JSON during append and replay. */
function decodeToolCallCommitted(value: unknown): ToolCallCommittedData {
  const committed = object(value, "ToolCallCommitted");
  const turnId = stringField(committed, "turnId");
  const stepId = stringField(committed, "stepId");
  const callId = stringField(committed, "callId");
  assertNonempty(turnId, "Committed Tool call Turn Id");
  assertNonempty(stepId, "Committed Tool call Step Id");
  assertNonempty(callId, "Committed Tool call Id");
  return deepFreeze({ turnId, stepId, callId });
}

/** The durable outcome returned after one committed Tool invocation. */
export type ToolCallSettledData =
  | {
      readonly turnId: string;
      readonly stepId: string;
      readonly callId: string;
      readonly outcome: "ok";
      readonly output: JsonValue;
    }
  | {
      readonly turnId: string;
      readonly stepId: string;
      readonly callId: string;
      readonly outcome: "error";
      readonly error: string;
    };

export const ToolCallSettled = new SessionFactKind<ToolCallSettledData>(
  "tool-call.settled",
  decodeToolCallSettled,
);

/** Validate and detach untrusted ToolCallSettled JSON during append and replay. */
function decodeToolCallSettled(value: unknown): ToolCallSettledData {
  const settled = object(value, "ToolCallSettled");
  const turnId = stringField(settled, "turnId");
  const stepId = stringField(settled, "stepId");
  const callId = stringField(settled, "callId");
  assertNonempty(turnId, "Settled Tool call Turn Id");
  assertNonempty(stepId, "Settled Tool call Step Id");
  assertNonempty(callId, "Settled Tool call Id");

  if (settled.outcome === "ok") {
    return deepFreeze({
      turnId,
      stepId,
      callId,
      outcome: "ok",
      output: jsonValue(settled.output, "Tool call output"),
    });
  }

  if (settled.outcome === "error") {
    const error = stringField(settled, "error");
    assertNonempty(error, "Tool call error");
    return deepFreeze({ turnId, stepId, callId, outcome: "error", error });
  }

  throw new Error("Unknown Tool-call settlement outcome");
}

/**
 * The terminal outcome of one committed Step. A completed Step has received
 * ProviderSettled and resolved every requested Tool call by either rejection
 * or settlement. Its outcome must agree with ProviderSettled. The projector
 * enforces those lifecycle conditions.
 */
export type StepSettledData =
  | {
      readonly turnId: string;
      readonly stepId: string;
      readonly outcome: "completed";
      readonly responseId: string;
    }
  | {
      readonly turnId: string;
      readonly stepId: string;
      readonly outcome: "failed";
      readonly error: string;
    };

export const StepSettled = new SessionFactKind<StepSettledData>(
  "step.settled",
  decodeStepSettled,
);

/** Validate untrusted StepSettled JSON during append and replay. */
function decodeStepSettled(value: unknown): StepSettledData {
  const settled = object(value, "StepSettled");
  const turnId = stringField(settled, "turnId");
  const stepId = stringField(settled, "stepId");
  assertNonempty(turnId, "Settled Step Turn Id");
  assertNonempty(stepId, "Settled Step Id");

  if (settled.outcome === "completed") {
    const responseId = stringField(settled, "responseId");
    assertNonempty(responseId, "Settled Step response Id");
    return deepFreeze({
      turnId,
      stepId,
      outcome: "completed",
      responseId,
    });
  }

  if (settled.outcome === "failed") {
    const error = stringField(settled, "error");
    assertNonempty(error, "Settled Step error");
    return deepFreeze({ turnId, stepId, outcome: "failed", error });
  }

  throw new Error("Unknown Step settlement outcome");
}

/**
 * The terminal outcome of one complete user-level Turn.
 *
 * A successful Turn is derived from projected state, not announced by the
 * Provider: its latest Step completed, that Step requested no Tool calls whose
 * results require another Step, and no pending steering Prompt requires
 * continuation. Queue Prompts belong to later Turns. The completion fact is
 * appended only at the projected Session head, so a concurrently admitted
 * steer wins by changing the head and forcing the decision to be recomputed.
 *
 * A failed Step, or an orchestration failure before a Step is committed, may
 * instead fail the Turn. Explicit cancellation is also terminal immediately:
 * it abandons any unfinished child work without claiming that its external
 * effects were undone. After this fact is durable, the live Turn lease may be
 * released.
 */
export type TurnSettledData =
  | {
      readonly turnId: string;
      readonly outcome: "completed";
    }
  | {
      readonly turnId: string;
      readonly outcome: "failed";
      readonly error: string;
    }
  | {
      readonly turnId: string;
      readonly outcome: "cancelled";
    };

export const TurnSettled = new SessionFactKind<TurnSettledData>(
  "turn.settled",
  decodeTurnSettled,
);

/** Validate untrusted TurnSettled JSON during append and replay. */
function decodeTurnSettled(value: unknown): TurnSettledData {
  const settled = object(value, "TurnSettled");
  const turnId = stringField(settled, "turnId");
  assertNonempty(turnId, "Settled Turn Id");

  if (settled.outcome === "completed") {
    return deepFreeze({ turnId, outcome: "completed" });
  }

  if (settled.outcome === "failed") {
    const error = stringField(settled, "error");
    assertNonempty(error, "Settled Turn error");
    return deepFreeze({ turnId, outcome: "failed", error });
  }

  if (settled.outcome === "cancelled") {
    return deepFreeze({ turnId, outcome: "cancelled" });
  }

  throw new Error("Unknown Turn settlement outcome");
}
