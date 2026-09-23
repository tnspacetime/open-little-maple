/** Durable execution loop for one already-started Turn. */
import {
  asError,
  assertNonempty,
  deepFreeze,
  jsonValue,
  object,
  stringField,
  type JsonObject,
} from "./json.js";
import {
  deriveProviderRequest,
  assertTurnServiceConfiguration,
} from "./provider-request.js";
import {
  ProviderOutput,
  ProviderSettled,
  StepCommitted,
  StepSettled,
  ToolCallCommitted,
  ToolCallRejected,
  ToolCallRequested,
  ToolCallSettled,
  TurnSettled,
  type SessionFact,
  type StepCommittedData,
} from "./session-facts.js";
import { projectSessionFact } from "./session-projector.js";
import type {
  SessionState,
  StepState,
  ToolCallState,
  TurnState,
} from "./session-state.js";
import { SessionHeadConflict, type SessionStore } from "./session-store.js";
import {
  Provider,
  Tool,
  ToolCallRule,
  ToolOutcomeUnknown,
  type ProviderRequest,
  type ToolCallContext,
  type ToolDescription,
  type ToolExecutionContext,
  type TurnServiceReference,
} from "./turn-service.js";
import { TurnServiceConfiguration } from "./turn-service-configuration.js";

/** One transient text delta delivered without entering the Session journal. */
export type TurnTextDelta = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly outputIndex: number;
  readonly contentIndex: number;
  readonly delta: string;
};

export type TurnExecutorOptions = {
  /** Supplies unique Step and fact Ids. */
  readonly nextId: () => string;

  /**
   * Optional synchronous live publication. Observation must never delay or
   * interrupt Provider consumption after StepCommitted.
   */
  readonly onTextDelta?: (delta: TurnTextDelta) => undefined;
};

export type TurnRecoveryRequirement =
  | {
      readonly type: "provider-outcome-unknown";
      readonly stepId: string;
      readonly error: string;
    }
  | {
      readonly type: "tool-outcome-unknown";
      readonly stepId: string;
      readonly callId: string;
      readonly error: string;
    };

export type TurnExecutionResult =
  | {
      readonly status: "settled";
      readonly state: SessionState;
    }
  | {
      readonly status: "recovery-required";
      readonly state: SessionState;
      readonly requirements: readonly TurnRecoveryRequirement[];
    };

type PreparedStep = {
  readonly stepId: string;
  readonly request: ProviderRequest;
};

type RequestedTool = Pick<
  ToolCallState,
  | "callId"
  | "itemId"
  | "name"
  | "argumentsJSON"
  | "outputIndex"
  | "providerItem"
>;

type ToolExecutionDecision =
  "committed" | "rejected" | "stale" | "already-handled";

/**
 * Executes one Turn until it settles or reaches committed external work whose
 * outcome is unknown. Callers must not run two executors for the same Turn at
 * once; a pre-existing committed invocation is treated as recovery work.
 */
export class TurnExecutor {
  constructor(
    private readonly store: SessionStore,
    private readonly sessionId: string,
    private readonly options: TurnExecutorOptions,
  ) {
    assertNonempty(sessionId, "Session Id");
  }

  async execute(
    turnId: string,
    configuration: TurnServiceConfiguration,
    signal: AbortSignal,
  ): Promise<TurnExecutionResult> {
    assertNonempty(turnId, "Turn Id");
    const sessionId = this.sessionId;
    const publisher = new SessionFactPublisher(this.store, sessionId);

    for (;;) {
      signal.throwIfAborted();
      const state = await this.store.read(sessionId);
      const turn = requireTurn(state, turnId);

      if (turn.status !== "active") {
        return { status: "settled", state };
      }

      assertTurnServiceConfiguration(turn.serviceConfiguration, configuration);
      providerRetryLimit(turn);

      const activeStep = turn.steps.find((step) => step.status === "active");
      if (activeStep) {
        const requirements = await this.advanceActiveStep(
          sessionId,
          turn,
          activeStep,
          configuration,
          publisher,
          signal,
        );
        if (requirements.length > 0) {
          return recoveryRequired(
            await this.store.read(sessionId),
            requirements,
          );
        }
        continue;
      }

      const latestStep = turn.steps.at(-1);
      const pendingSteers = pendingSteerIds(state, turnId);

      if (!latestStep) {
        const prepared = await this.prepareAndCommitStep(
          sessionId,
          state,
          configuration,
          {
            turnId,
            stepId: this.nextId("Step"),
            promptIds: pendingSteers,
          },
          signal,
        );
        if (!prepared) continue;

        const requirements = await this.runProviderStep(
          sessionId,
          turnId,
          prepared,
          configuration,
          publisher,
          signal,
        );
        if (requirements.length > 0) {
          return recoveryRequired(
            await this.store.read(sessionId),
            requirements,
          );
        }
        continue;
      }

      const provider = latestStep.providerInvocation;
      if (provider.status === "completed") {
        if (latestStep.toolCalls.length > 0 || pendingSteers.length > 0) {
          const prepared = await this.prepareAndCommitStep(
            sessionId,
            state,
            configuration,
            {
              turnId,
              stepId: this.nextId("Step"),
              promptIds: pendingSteers,
            },
            signal,
          );
          if (!prepared) continue;

          const requirements = await this.runProviderStep(
            sessionId,
            turnId,
            prepared,
            configuration,
            publisher,
            signal,
          );
          if (requirements.length > 0) {
            return recoveryRequired(
              await this.store.read(sessionId),
              requirements,
            );
          }
          continue;
        }

        const settled = await this.tryAppendDecision(
          sessionId,
          state,
          TurnSettled.make(this.nextId("Turn settlement fact"), {
            turnId,
            outcome: "completed",
          }),
        );
        if (!settled) continue;
        return { status: "settled", state: settled };
      }

      if (provider.status === "failed") {
        const mayRetry =
          provider.disposition === "retry-safe" &&
          latestStep.toolCalls.length === 0 &&
          retryCount(turn) < providerRetryLimit(turn);

        if (mayRetry) {
          const prepared = await this.prepareAndCommitStep(
            sessionId,
            state,
            configuration,
            {
              turnId,
              stepId: this.nextId("Step"),
              promptIds: [],
              retryOfStepId: latestStep.stepId,
            },
            signal,
          );
          if (!prepared) continue;

          const requirements = await this.runProviderStep(
            sessionId,
            turnId,
            prepared,
            configuration,
            publisher,
            signal,
          );
          if (requirements.length > 0) {
            return recoveryRequired(
              await this.store.read(sessionId),
              requirements,
            );
          }
          continue;
        }

        const settled = await this.tryAppendDecision(
          sessionId,
          state,
          TurnSettled.make(this.nextId("Turn settlement fact"), {
            turnId,
            outcome: "failed",
            error: provider.error,
          }),
        );
        if (!settled) continue;
        return { status: "settled", state: settled };
      }

      throw new Error(
        `Settled Step ${latestStep.stepId} has an unsettled Provider`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Step preparation and Provider execution
  // -----------------------------------------------------------------------

  /**
   * Project the candidate Step and derive its request before publication.
   * Only after both succeed does StepCommitted become the final durable action
   * before dispatch. A head conflict discards both unpublished candidates.
   */
  private async prepareAndCommitStep(
    sessionId: string,
    state: SessionState,
    configuration: TurnServiceConfiguration,
    data: StepCommittedData,
    signal: AbortSignal,
  ): Promise<PreparedStep | undefined> {
    const fact = StepCommitted.make(this.nextId("Step commitment fact"), data);
    const projected = projectSessionFact(state, fact, state.seq + 1);
    const request = deriveProviderRequest(
      projected,
      configuration,
      data.turnId,
      data.stepId,
    );

    signal.throwIfAborted();
    const committed = await this.tryAppendDecision(sessionId, state, fact);
    return committed ? { stepId: data.stepId, request } : undefined;
  }

  private async runProviderStep(
    sessionId: string,
    turnId: string,
    prepared: PreparedStep,
    configuration: TurnServiceConfiguration,
    publisher: SessionFactPublisher,
    signal: AbortSignal,
  ): Promise<readonly TurnRecoveryRequirement[]> {
    const providers = configuration.entries(Provider);
    if (providers.length !== 1) {
      throw new Error(
        `Turn execution requires exactly one Provider, found ${providers.length}`,
      );
    }

    const provider = providers[0]!.value;
    const toolTasks: Array<Promise<TurnRecoveryRequirement | undefined>> = [];
    let terminal = false;
    let providerRequirement: TurnRecoveryRequirement | undefined;

    try {
      providerEvents: for await (const event of provider.stream(
        prepared.request,
        signal,
      )) {
        // A Provider may ignore AbortSignal. Never publish an event observed
        // after local cancellation; the durable Turn fence rejects it anyway.
        signal.throwIfAborted();
        switch (event.type) {
          case "text-delta":
            try {
              this.options.onTextDelta?.({
                sessionId,
                turnId,
                stepId: prepared.stepId,
                outputIndex: event.outputIndex,
                contentIndex: event.contentIndex,
                delta: event.delta,
              });
            } catch {
              // Transient observation cannot make Provider reality ambiguous.
            }
            break;

          case "output-item":
            await publisher.publish(
              ProviderOutput.make(this.nextId("Provider output fact"), {
                turnId,
                stepId: prepared.stepId,
                outputIndex: event.outputIndex,
                item: event.item,
              }),
            );
            break;

          case "tool-call": {
            await publisher.publish(
              ToolCallRequested.make(this.nextId("Tool-call request fact"), {
                turnId,
                stepId: prepared.stepId,
                outputIndex: event.outputIndex,
                itemId: event.itemId,
                callId: event.callId,
                name: event.name,
                argumentsJSON: event.argumentsJSON,
                providerItem: event.providerItem,
              }),
            );

            const requested: RequestedTool = {
              callId: event.callId,
              itemId: event.itemId,
              name: event.name,
              argumentsJSON: event.argumentsJSON,
              outputIndex: event.outputIndex,
              providerItem: event.providerItem,
            };
            toolTasks.push(
              this.processRequestedTool(
                sessionId,
                turnId,
                prepared.stepId,
                requested,
                configuration,
                publisher,
                signal,
              ),
            );
            break;
          }

          case "completed":
            await publisher.publish(
              ProviderSettled.make(this.nextId("Provider settlement fact"), {
                turnId,
                stepId: prepared.stepId,
                outcome: "completed",
                responseId: event.responseId,
              }),
            );
            terminal = true;
            break providerEvents;

          case "failed":
            await publisher.publish(
              ProviderSettled.make(this.nextId("Provider settlement fact"), {
                turnId,
                stepId: prepared.stepId,
                outcome: "failed",
                error: event.error,
                disposition: event.disposition,
              }),
            );
            terminal = true;
            break providerEvents;
        }
      }
    } catch (cause) {
      if (!terminal) {
        providerRequirement = {
          type: "provider-outcome-unknown",
          stepId: prepared.stepId,
          error: errorMessage(
            cause,
            "Provider stream failed without settlement",
          ),
        };
      }
    }

    if (!terminal && !providerRequirement) {
      providerRequirement = {
        type: "provider-outcome-unknown",
        stepId: prepared.stepId,
        error: "Provider stream ended without a terminal event",
      };
    }

    const toolRequirements = await joinToolWorkers(toolTasks);
    return Object.freeze(
      providerRequirement
        ? [providerRequirement, ...toolRequirements]
        : toolRequirements,
    );
  }

  // -----------------------------------------------------------------------
  // Resuming and settling an active Step
  // -----------------------------------------------------------------------

  private async advanceActiveStep(
    sessionId: string,
    turn: TurnState,
    step: StepState,
    configuration: TurnServiceConfiguration,
    publisher: SessionFactPublisher,
    signal: AbortSignal,
  ): Promise<readonly TurnRecoveryRequirement[]> {
    if (step.providerInvocation.status === "committed") {
      return Object.freeze([
        {
          type: "provider-outcome-unknown" as const,
          stepId: step.stepId,
          error: "Provider invocation is committed without settlement",
        },
        ...committedToolRequirements(step),
      ]);
    }

    const committed = committedToolRequirements(step);
    if (committed.length > 0) return committed;

    const requested = step.toolCalls.filter(
      (tool) => tool.status === "requested",
    );
    if (requested.length > 0) {
      const requirements = await joinToolWorkers(
        requested.map((tool) =>
          step.providerInvocation.status === "failed"
            ? this.rejectToolAfterProviderFailure(
                sessionId,
                turn.turnId,
                step.stepId,
                tool,
              )
            : this.processRequestedTool(
                sessionId,
                turn.turnId,
                step.stepId,
                tool,
                configuration,
                publisher,
                signal,
              ),
        ),
      );
      return requirements;
    }

    const current = await this.store.read(sessionId);
    const currentTurn = requireTurn(current, turn.turnId);
    const currentStep = currentTurn.steps.find(
      (candidate) => candidate.stepId === step.stepId,
    );
    if (!currentStep || currentStep.status !== "active") return [];

    const provider = currentStep.providerInvocation;
    if (provider.status === "committed") {
      return Object.freeze([
        {
          type: "provider-outcome-unknown",
          stepId: step.stepId,
          error: "Provider invocation lost its settlement",
        },
      ]);
    }

    const fact =
      provider.status === "completed"
        ? StepSettled.make(this.nextId("Step settlement fact"), {
            turnId: turn.turnId,
            stepId: step.stepId,
            outcome: "completed",
            responseId: provider.responseId,
          })
        : StepSettled.make(this.nextId("Step settlement fact"), {
            turnId: turn.turnId,
            stepId: step.stepId,
            outcome: "failed",
            error: provider.error,
          });
    await this.tryAppendDecision(sessionId, current, fact);
    return [];
  }

  // -----------------------------------------------------------------------
  // Tool authorization and execution
  // -----------------------------------------------------------------------

  private async processRequestedTool(
    sessionId: string,
    turnId: string,
    stepId: string,
    requested: RequestedTool,
    configuration: TurnServiceConfiguration,
    publisher: SessionFactPublisher,
    signal: AbortSignal,
  ): Promise<TurnRecoveryRequirement | undefined> {
    const matches = configuration
      .entries(Tool)
      .filter(
        (entry) => stringField(entry.settings, "name") === requested.name,
      );
    if (matches.length === 0) {
      await this.rejectTool(
        turnId,
        stepId,
        requested.callId,
        "unavailable",
        `Tool ${requested.name} is not selected`,
        publisher,
      );
      return undefined;
    }
    if (matches.length > 1) {
      throw new Error(`Selected Tools repeat Provider name ${requested.name}`);
    }

    const selected = matches[0]!;
    const description = toolDescription(selected.settings);
    let input: unknown;
    try {
      input = JSON.parse(requested.argumentsJSON);
    } catch {
      await this.rejectTool(
        turnId,
        stepId,
        requested.callId,
        "invalid-arguments",
        `Tool ${requested.name} arguments are not valid JSON`,
        publisher,
      );
      return undefined;
    }

    const context: ToolCallContext = Object.freeze({
      sessionId,
      turnId,
      stepId,
      callId: requested.callId,
      toolKey: selected.key,
      tool: description,
      argumentsJSON: requested.argumentsJSON,
      signal,
    });

    let serviceScope: readonly TurnServiceReference[] = [];
    for (;;) {
      serviceScope = configuration.toolResourceReferences();

      for (const rule of configuration.entries(ToolCallRule)) {
        let decision;
        try {
          signal.throwIfAborted();
          decision = await rule.value(context, configuration);
        } catch (cause) {
          await this.rejectTool(
            turnId,
            stepId,
            requested.callId,
            "denied",
            `Tool-call rule ${rule.key} failed: ${errorMessage(cause, "unknown error")}`,
            publisher,
          );
          return undefined;
        }

        if (decision.type === "deny") {
          await this.rejectTool(
            turnId,
            stepId,
            requested.callId,
            "denied",
            errorMessage(decision.reason, "Tool call was denied"),
            publisher,
          );
          return undefined;
        }
        if (decision.type !== "allow") {
          await this.rejectTool(
            turnId,
            stepId,
            requested.callId,
            "denied",
            `Tool-call rule ${rule.key} returned an invalid decision`,
            publisher,
          );
          return undefined;
        }
        if (decision.scope !== undefined) {
          try {
            serviceScope = intersectServiceScope(
              serviceScope,
              decision.scope,
              configuration,
            );
          } catch (cause) {
            await this.rejectTool(
              turnId,
              stepId,
              requested.callId,
              "denied",
              `Tool-call rule ${rule.key} returned an invalid scope: ${errorMessage(cause, "unknown error")}`,
              publisher,
            );
            return undefined;
          }
        }
      }

      if (signal.aborted) {
        await this.rejectTool(
          turnId,
          stepId,
          requested.callId,
          "denied",
          "Turn execution was aborted before Tool commitment",
          publisher,
        );
        return undefined;
      }

      const executionDecision = await this.decideToolExecution(
        sessionId,
        turnId,
        stepId,
        requested.callId,
      );
      if (executionDecision === "stale") continue;
      if (executionDecision !== "committed") return undefined;
      break;
    }

    const executionContext: ToolExecutionContext = Object.freeze({
      ...context,
      services: configuration.restrict(serviceScope),
    });

    try {
      const output = await selected.value.execute(input, executionContext);
      const validated = jsonValue(output, `Tool ${requested.name} output`);
      await publisher.publish(
        ToolCallSettled.make(this.nextId("Tool-call settlement fact"), {
          turnId,
          stepId,
          callId: requested.callId,
          outcome: "ok",
          output: validated,
        }),
      );
      return undefined;
    } catch (cause) {
      if (cause instanceof ToolOutcomeUnknown || signal.aborted) {
        return {
          type: "tool-outcome-unknown",
          stepId,
          callId: requested.callId,
          error: errorMessage(cause, "Tool outcome is unknown"),
        };
      }

      await publisher.publish(
        ToolCallSettled.make(this.nextId("Tool-call settlement fact"), {
          turnId,
          stepId,
          callId: requested.callId,
          outcome: "error",
          error: errorMessage(cause, "Tool execution failed"),
        }),
      );
      return undefined;
    }
  }

  private async rejectToolAfterProviderFailure(
    sessionId: string,
    turnId: string,
    stepId: string,
    tool: ToolCallState,
  ): Promise<undefined> {
    for (;;) {
      const decision = await this.decideToolExecution(
        sessionId,
        turnId,
        stepId,
        tool.callId,
      );
      if (decision !== "stale") break;
    }
    return undefined;
  }

  /**
   * Recompute the Tool lifecycle decision after every stale-head conflict.
   * An existing authorization outcome is not repeated; only current durable
   * eligibility is reconsidered. The failed-Provider restart path uses the
   * same boundary to reject without authorization. Tool execution may begin
   * only after this method durably returns "committed".
   */
  private async decideToolExecution(
    sessionId: string,
    turnId: string,
    stepId: string,
    callId: string,
  ): Promise<ToolExecutionDecision> {
    const state = await this.store.read(sessionId);
    const turn = state.turns.find((candidate) => candidate.turnId === turnId);
    if (!turn || turn.status !== "active") return "already-handled";

    const step = turn.steps.find((candidate) => candidate.stepId === stepId);
    if (!step || step.status !== "active") return "already-handled";

    const tool = step.toolCalls.find(
      (candidate) => candidate.callId === callId,
    );
    if (!tool || tool.status !== "requested") return "already-handled";

    const providerFailed = step.providerInvocation.status === "failed";
    const fact = providerFailed
      ? ToolCallRejected.make(this.nextId("Tool-call rejection fact"), {
          turnId,
          stepId,
          callId,
          kind: "denied",
          reason: "Provider failed before Tool execution began",
        })
      : ToolCallCommitted.make(this.nextId("Tool-call commitment fact"), {
          turnId,
          stepId,
          callId,
        });

    const appended = await this.tryAppendDecision(sessionId, state, fact);
    if (!appended) return "stale";
    return providerFailed ? "rejected" : "committed";
  }

  private async rejectTool(
    turnId: string,
    stepId: string,
    callId: string,
    kind: "denied" | "unavailable" | "invalid-arguments",
    reason: string,
    publisher: SessionFactPublisher,
  ): Promise<void> {
    await publisher.publish(
      ToolCallRejected.make(this.nextId("Tool-call rejection fact"), {
        turnId,
        stepId,
        callId,
        kind,
        reason,
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Durable publication
  // -----------------------------------------------------------------------

  private async tryAppendDecision(
    sessionId: string,
    state: SessionState,
    fact: SessionFact,
  ): Promise<SessionState | undefined> {
    try {
      return await this.store.append(sessionId, state.seq, fact);
    } catch (cause) {
      if (cause instanceof SessionHeadConflict) return undefined;
      throw cause;
    }
  }

  private nextId(label: string): string {
    const value = this.options.nextId();
    assertNonempty(value, label + " Id");
    return value;
  }
}

/** Serializes facts emitted concurrently by Provider and Tool workers. */
class SessionFactPublisher {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: SessionStore,
    private readonly sessionId: string,
  ) {}

  publish(fact: SessionFact): Promise<SessionState> {
    const publication = this.tail.then(() => this.appendObserved(fact));
    this.tail = publication.then(
      () => undefined,
      () => undefined,
    );
    return publication;
  }

  private async appendObserved(fact: SessionFact): Promise<SessionState> {
    for (;;) {
      const current = await this.store.read(this.sessionId);
      try {
        return await this.store.append(this.sessionId, current.seq, fact);
      } catch (cause) {
        if (cause instanceof SessionHeadConflict) continue;
        throw cause;
      }
    }
  }
}

function requireTurn(state: SessionState, turnId: string): TurnState {
  const turn = state.turns.find((candidate) => candidate.turnId === turnId);
  if (!turn) throw new Error(`Unknown Turn ${turnId}`);
  return turn;
}

function pendingSteerIds(
  state: SessionState,
  turnId: string,
): readonly string[] {
  return Object.freeze(
    state.prompts
      .filter(
        (prompt) =>
          prompt.status === "pending" &&
          prompt.prompt.mode === "steer" &&
          prompt.turnId === turnId,
      )
      .map((prompt) => prompt.prompt.id),
  );
}

function serviceReferenceIdentity(reference: TurnServiceReference): string {
  return `${reference.kind}\u0000${reference.key}`;
}

/** Validate one rule scope and intersect it without changing Turn order. */
function intersectServiceScope(
  current: readonly TurnServiceReference[],
  proposed: unknown,
  configuration: TurnServiceConfiguration,
): readonly TurnServiceReference[] {
  if (!Array.isArray(proposed)) {
    throw new Error("scope must be an array");
  }

  const selected = new Set(
    configuration.description.services.map((service) =>
      serviceReferenceIdentity({ kind: service.kind, key: service.key }),
    ),
  );
  const accessible = new Set(
    configuration.toolResourceReferences().map(serviceReferenceIdentity),
  );
  const proposedIdentities = new Set<string>();

  for (let index = 0; index < proposed.length; index += 1) {
    const value = object(proposed[index], `scope[${index}]`);
    const reference: TurnServiceReference = {
      kind: stringField(value, "kind"),
      key: stringField(value, "key"),
    };
    assertNonempty(reference.kind, `Scope service ${index} kind`);
    assertNonempty(reference.key, `Scope service ${index} key`);

    const identity = serviceReferenceIdentity(reference);
    if (!selected.has(identity)) {
      throw new Error(
        `scope contains unavailable Turn service ${reference.kind}:${reference.key}`,
      );
    }
    if (!accessible.has(identity)) {
      throw new Error(
        `scope contains internal Turn service ${reference.kind}:${reference.key}`,
      );
    }
    if (proposedIdentities.has(identity)) {
      throw new Error(
        `scope repeats Turn service ${reference.kind}:${reference.key}`,
      );
    }
    proposedIdentities.add(identity);
  }

  return Object.freeze(
    current.filter((reference) =>
      proposedIdentities.has(serviceReferenceIdentity(reference)),
    ),
  );
}

function providerRetryLimit(turn: TurnState): number {
  const providers = turn.serviceConfiguration.services.filter(
    (service) => service.kind === Provider.id,
  );
  if (providers.length !== 1) {
    throw new Error(
      `Turn ${turn.turnId} requires exactly one Provider, found ${providers.length}`,
    );
  }

  const value = providers[0]!.settings.maxRetries;
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("Provider maxRetries must be a nonnegative integer");
  }
  return value;
}

/** Number of physical retries already made for the latest request boundary. */
function retryCount(turn: TurnState): number {
  let count = 0;
  for (let index = turn.steps.length - 1; index >= 0; index -= 1) {
    if (turn.steps[index]!.retryOfStepId === undefined) break;
    count += 1;
  }
  return count;
}

function committedToolRequirements(
  step: StepState,
): readonly TurnRecoveryRequirement[] {
  return Object.freeze(
    step.toolCalls
      .filter((tool) => tool.status === "committed")
      .map((tool): TurnRecoveryRequirement => ({
        type: "tool-outcome-unknown",
        stepId: step.stepId,
        callId: tool.callId,
        error: "Tool invocation is committed without settlement",
      })),
  );
}

/**
 * Join every concurrent Tool worker before propagating an unexpected failure.
 * This prevents one rejected worker from leaving its siblings running after
 * the executor has already returned control to its caller.
 */
async function joinToolWorkers(
  workers: readonly Promise<TurnRecoveryRequirement | undefined>[],
): Promise<readonly TurnRecoveryRequirement[]> {
  const outcomes = await Promise.allSettled(workers);
  const requirements: TurnRecoveryRequirement[] = [];
  const failures: unknown[] = [];

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      failures.push(outcome.reason);
    } else if (outcome.value !== undefined) {
      requirements.push(outcome.value);
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Multiple Tool workers failed");
  }
  return Object.freeze(requirements);
}

function toolDescription(settings: JsonObject): ToolDescription {
  const name = stringField(settings, "name");
  const description = stringField(settings, "description");
  assertNonempty(name, "Tool name");
  assertNonempty(description, `Tool ${name} description`);
  return deepFreeze({
    name,
    description,
    inputSchema: object(
      jsonValue(settings.inputSchema, `Tool ${name} input schema`),
      `Tool ${name} input schema`,
    ),
  });
}

function recoveryRequired(
  state: SessionState,
  requirements: readonly TurnRecoveryRequirement[],
): TurnExecutionResult {
  return {
    status: "recovery-required",
    state,
    requirements: deepFreeze(structuredClone(requirements)),
  };
}

function errorMessage(cause: unknown, fallback: string): string {
  const message = asError(cause).message.trim();
  return message || fallback;
}
