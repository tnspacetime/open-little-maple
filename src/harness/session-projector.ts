/** Pure validation and projection of one Session fact. */
import type { JsonObject } from "./json.js";
import {
  PromptAdmitted,
  PromptSkipped,
  ProviderOutput,
  ProviderSettled,
  StepCommitted,
  StepSettled,
  ToolCallCommitted,
  ToolCallRejected,
  ToolCallRequested,
  ToolCallSettled,
  TurnServiceConfigurationFact,
  TurnSettled,
  TurnStarted,
  type SessionFact,
  type SessionFactKind,
} from "./session-facts.js";
import type {
  PromptState,
  SessionState,
  StepState,
  ToolCallState,
  TurnState,
} from "./session-state.js";

/** Stable reasons why a candidate fact cannot be projected. */
export type SessionProjectionErrorCode =
  | "invalid-fact-data"
  | "unknown-fact-type"
  | "invalid-sequence"
  | "unknown-entity"
  | "duplicate-entity"
  | "invalid-lifecycle-transition"
  | "invariant-violation";

/** One structured rejection produced by projectSessionFact. */
export class SessionProjectionError extends Error {
  override readonly name = "SessionProjectionError";

  constructor(
    readonly code: SessionProjectionErrorCode,
    message: string,
    readonly factId: string,
    readonly factType: string,
    readonly seq: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

type ProjectionContext = {
  readonly factId: string;
  readonly factType: string;
  readonly seq: number;
};

/**
 * Validate one candidate fact against the current projection and compute the
 * next projection with immutable updates and structural sharing. This function
 * performs no I/O and does not mutate current. The journal later appends the
 * same fact and persists this result in one database transaction.
 */
export function projectSessionFact(
  current: SessionState,
  fact: SessionFact,
  nextSeq: number,
): SessionState {
  const context: ProjectionContext = {
    factId: fact.id,
    factType: fact.type,
    seq: nextSeq,
  };

  if (!Number.isInteger(nextSeq) || nextSeq !== current.seq + 1) {
    fail(
      context,
      "invalid-sequence",
      `Session fact sequence ${nextSeq} must immediately follow ${current.seq}`,
    );
  }
  if (!fact.id.trim()) {
    fail(context, "invalid-fact-data", "Session fact Id cannot be empty");
  }

  switch (fact.type) {
    // =======================================================================
    // TurnServiceConfigurationFact
    // =======================================================================

    case TurnServiceConfigurationFact.type: {
      const configuration = decodeHelper(
        TurnServiceConfigurationFact,
        fact,
        context,
      );
      return {
        ...current,
        seq: nextSeq,
        currentServiceConfiguration: configuration,
      };
    }

    // =======================================================================
    // PromptAdmitted
    // =======================================================================

    case PromptAdmitted.type: {
      const prompt = decodeHelper(PromptAdmitted, fact, context);
      if (current.prompts.some((state) => state.prompt.id === prompt.id)) {
        fail(
          context,
          "duplicate-entity",
          `Prompt admitted twice: ${prompt.id}`,
        );
      }

      /*
       * Queue Prompts intentionally remain available for a future Turn. A
       * steer means "change the Turn active now", so its Turn is derived here
       * and retained only in PromptState. Prompt fact data stays unchanged.
       */
      const promptState: PromptState =
        prompt.mode === "queue"
          ? { prompt, admittedSeq: nextSeq, status: "pending" }
          : {
              prompt,
              admittedSeq: nextSeq,
              status: "pending",
              turnId: requireCurrentActiveTurn(current, prompt.id, context)
                .turnId,
            };

      return {
        ...current,
        seq: nextSeq,
        prompts: [...current.prompts, promptState],
      };
    }

    // =======================================================================
    // PromptSkipped
    // =======================================================================

    case PromptSkipped.type: {
      const skipped = decodeHelper(PromptSkipped, fact, context);
      const promptIndex = current.prompts.findIndex(
        (prompt) => prompt.prompt.id === skipped.promptId,
      );
      if (promptIndex < 0) {
        fail(
          context,
          "unknown-entity",
          `Prompt cancellation belongs to unknown Prompt ${skipped.promptId}`,
        );
      }

      const prompt = current.prompts[promptIndex]!;
      if (prompt.status !== "pending" || prompt.prompt.mode !== "queue") {
        fail(
          context,
          "invalid-lifecycle-transition",
          `Only a pending queue Prompt may be cancelled directly: ${skipped.promptId}`,
        );
      }

      return {
        ...current,
        seq: nextSeq,
        prompts: skipPendingQueueSuffix(
          current.prompts,
          prompt.admittedSeq,
          nextSeq,
        ),
      };
    }

    // =======================================================================
    // TurnStarted
    // =======================================================================

    case TurnStarted.type: {
      const turnStarted = decodeHelper(TurnStarted, fact, context);
      if (!current.currentServiceConfiguration) {
        fail(
          context,
          "invalid-lifecycle-transition",
          `Turn ${turnStarted.turnId} started without a current service configuration`,
        );
      }
      if (current.turns.some((turn) => turn.turnId === turnStarted.turnId)) {
        fail(
          context,
          "duplicate-entity",
          `Turn started twice: ${turnStarted.turnId}`,
        );
      }
      if (current.turns.some((turn) => turn.status === "active")) {
        fail(
          context,
          "invalid-lifecycle-transition",
          `Turn ${turnStarted.turnId} started while another Turn is active`,
        );
      }

      const prompts = claimPromptForTurn(
        current.prompts,
        turnStarted.promptId,
        turnStarted.turnId,
        nextSeq,
        context,
      );
      const turn: TurnState = {
        turnId: turnStarted.turnId,
        startedSeq: nextSeq,
        promptId: turnStarted.promptId,
        serviceConfiguration: current.currentServiceConfiguration,
        steps: [],
        status: "active",
      };

      return {
        ...current,
        seq: nextSeq,
        prompts,
        turns: [...current.turns, turn],
      };
    }

    // =======================================================================
    // StepCommitted
    // =======================================================================

    case StepCommitted.type: {
      const stepCommitted = decodeHelper(StepCommitted, fact, context);
      const { turn, turnIndex } = requireActiveTurn(
        current,
        stepCommitted.turnId,
        "Step commitment",
        context,
      );
      if (turn.steps.some((step) => step.stepId === stepCommitted.stepId)) {
        fail(
          context,
          "duplicate-entity",
          `Step committed twice in Turn ${turn.turnId}: ${stepCommitted.stepId}`,
        );
      }
      if (turn.steps.some((step) => step.status === "active")) {
        fail(
          context,
          "invalid-lifecycle-transition",
          `Step ${stepCommitted.stepId} committed while Turn ${turn.turnId} has an active Step`,
        );
      }

      /*
       * A Turn is a sequential Provider conversation. Tools requested inside
       * one Step may execute concurrently, but another Provider invocation
       * cannot begin until that whole Step has settled.
       *
       * A retry is exceptional: it must identify the immediately preceding
       * Step, whose Provider positively settled with a retry-safe failure. It
       * claims no steers because its request is reconstructed from that
       * Step's original input boundary, not from current Session state.
       *
       * Otherwise the first Step processes the queue Prompt already owned by
       * the Turn. Every later Step must be caused by Tool-call results,
       * steering Prompts, or both. Without either, the Turn must settle.
       */
      const precedingStep = turn.steps.at(-1);
      let prompts: readonly PromptState[];

      if (stepCommitted.retryOfStepId !== undefined) {
        if (!precedingStep) {
          fail(
            context,
            "invalid-lifecycle-transition",
            `First Step ${stepCommitted.stepId} cannot retry another Step`,
          );
        }
        if (stepCommitted.retryOfStepId !== precedingStep.stepId) {
          fail(
            context,
            "invalid-lifecycle-transition",
            `Step ${stepCommitted.stepId} must retry the immediately preceding Step ${precedingStep.stepId}`,
          );
        }
        if (
          precedingStep.providerInvocation.status !== "failed" ||
          precedingStep.providerInvocation.disposition !== "retry-safe"
        ) {
          fail(
            context,
            "invalid-lifecycle-transition",
            `Step ${precedingStep.stepId} did not settle with a retry-safe Provider failure`,
          );
        }
        if (precedingStep.toolCalls.length > 0) {
          fail(
            context,
            "invalid-lifecycle-transition",
            `Step ${precedingStep.stepId} contains Tool calls and cannot be retried without explicit recovery authorization`,
          );
        }
        if (stepCommitted.promptIds.length > 0) {
          fail(
            context,
            "invalid-lifecycle-transition",
            `Retry Step ${stepCommitted.stepId} cannot claim steering Prompts`,
          );
        }
        prompts = current.prompts;
      } else {
        if (
          precedingStep &&
          precedingStep.providerInvocation.status === "failed"
        ) {
          fail(
            context,
            "invalid-lifecycle-transition",
            `Step ${stepCommitted.stepId} must explicitly retry failed Step ${precedingStep.stepId}`,
          );
        }
        if (
          precedingStep &&
          precedingStep.toolCalls.length === 0 &&
          stepCommitted.promptIds.length === 0
        ) {
          fail(
            context,
            "invalid-lifecycle-transition",
            `Step ${stepCommitted.stepId} has no Tool-call results or steering Prompts to continue Turn ${turn.turnId}`,
          );
        }

        prompts = claimPromptsForStep(
          current.prompts,
          stepCommitted.promptIds,
          turn.turnId,
          stepCommitted.stepId,
          nextSeq,
          context,
        );
      }

      const step: StepState = {
        stepId: stepCommitted.stepId,
        ...(stepCommitted.retryOfStepId === undefined
          ? {}
          : { retryOfStepId: stepCommitted.retryOfStepId }),
        promptIds: stepCommitted.promptIds,
        providerInvocation: {
          status: "committed",
          committedSeq: nextSeq,
        },
        providerOutputs: [],
        toolCalls: [],
        status: "active",
      };
      const nextTurn: TurnState = {
        ...turn,
        steps: [...turn.steps, step],
      };

      return {
        ...current,
        seq: nextSeq,
        prompts,
        turns: replaceAt(current.turns, turnIndex, nextTurn),
      };
    }

    // =======================================================================
    // ProviderOutput
    // =======================================================================

    case ProviderOutput.type: {
      const providerOutput = decodeHelper(ProviderOutput, fact, context);
      const location = requireActiveStep(
        current,
        providerOutput.turnId,
        providerOutput.stepId,
        "Provider output",
        context,
      );
      assertProviderOpen(location.step, "Provider output", context);
      assertOutputIndexAvailable(
        location.step,
        providerOutput.outputIndex,
        context,
      );

      const nextStep: StepState = {
        ...location.step,
        providerOutputs: [
          ...location.step.providerOutputs,
          {
            outputIndex: providerOutput.outputIndex,
            item: providerOutput.item,
            recordedSeq: nextSeq,
          },
        ].sort((left, right) => left.outputIndex - right.outputIndex),
      };
      return replaceStep(current, location, nextStep, nextSeq);
    }

    // =======================================================================
    // ToolCallRequested
    // =======================================================================

    case ToolCallRequested.type: {
      const toolRequested = decodeHelper(ToolCallRequested, fact, context);
      const location = requireActiveStep(
        current,
        toolRequested.turnId,
        toolRequested.stepId,
        "Tool-call request",
        context,
      );
      assertProviderOpen(location.step, "Tool-call request", context);
      assertOutputIndexAvailable(
        location.step,
        toolRequested.outputIndex,
        context,
      );
      if (
        location.step.toolCalls.some(
          (tool) => tool.callId === toolRequested.callId,
        )
      ) {
        fail(
          context,
          "duplicate-entity",
          `Tool call requested twice: ${toolRequested.callId}`,
        );
      }
      if (
        location.step.toolCalls.some(
          (tool) => tool.itemId === toolRequested.itemId,
        )
      ) {
        fail(
          context,
          "duplicate-entity",
          `Tool-call item repeated: ${toolRequested.itemId}`,
        );
      }

      const tool: ToolCallState = {
        callId: toolRequested.callId,
        itemId: toolRequested.itemId,
        name: toolRequested.name,
        argumentsJSON: toolRequested.argumentsJSON,
        outputIndex: toolRequested.outputIndex,
        providerItem: toolRequested.providerItem,
        requestedSeq: nextSeq,
        status: "requested",
      };
      const nextStep: StepState = {
        ...location.step,
        toolCalls: [...location.step.toolCalls, tool].sort(
          (left, right) =>
            left.outputIndex - right.outputIndex ||
            left.callId.localeCompare(right.callId),
        ),
      };
      return replaceStep(current, location, nextStep, nextSeq);
    }

    // =======================================================================
    // ProviderSettled
    // =======================================================================

    case ProviderSettled.type: {
      const providerSettled = decodeHelper(ProviderSettled, fact, context);
      const location = requireActiveStep(
        current,
        providerSettled.turnId,
        providerSettled.stepId,
        "Provider settlement",
        context,
      );
      assertProviderOpen(location.step, "Provider settlement", context);

      const providerInvocation =
        providerSettled.outcome === "completed"
          ? {
              status: "completed" as const,
              committedSeq: location.step.providerInvocation.committedSeq,
              settledSeq: nextSeq,
              responseId: providerSettled.responseId,
            }
          : {
              status: "failed" as const,
              committedSeq: location.step.providerInvocation.committedSeq,
              settledSeq: nextSeq,
              error: providerSettled.error,
              disposition: providerSettled.disposition,
            };
      const nextStep: StepState = {
        ...location.step,
        providerInvocation,
      };
      return replaceStep(current, location, nextStep, nextSeq);
    }

    // =======================================================================
    // ToolCallRejected
    // =======================================================================

    case ToolCallRejected.type: {
      const toolRejected = decodeHelper(ToolCallRejected, fact, context);
      const location = requireActiveTool(
        current,
        toolRejected.turnId,
        toolRejected.stepId,
        toolRejected.callId,
        "Tool-call rejection",
        context,
      );
      if (location.tool.status !== "requested") {
        fail(
          context,
          "invalid-lifecycle-transition",
          `Tool call ${toolRejected.callId} cannot be rejected from ${location.tool.status}`,
        );
      }

      const nextTool: ToolCallState = {
        ...location.tool,
        status: "rejected",
        kind: toolRejected.kind,
        reason: toolRejected.reason,
        rejectedSeq: nextSeq,
      };
      return replaceTool(current, location, nextTool, nextSeq);
    }

    // =======================================================================
    // ToolCallCommitted
    // =======================================================================

    case ToolCallCommitted.type: {
      const toolCommitted = decodeHelper(ToolCallCommitted, fact, context);
      const location = requireActiveTool(
        current,
        toolCommitted.turnId,
        toolCommitted.stepId,
        toolCommitted.callId,
        "Tool-call commitment",
        context,
      );
      if (location.tool.status !== "requested") {
        fail(
          context,
          "invalid-lifecycle-transition",
          `Tool call ${toolCommitted.callId} cannot be committed from ${location.tool.status}`,
        );
      }
      if (location.step.providerInvocation.status === "failed") {
        fail(
          context,
          "invalid-lifecycle-transition",
          `Tool call ${toolCommitted.callId} cannot be committed after Provider failure`,
        );
      }

      const nextTool: ToolCallState = {
        ...location.tool,
        status: "committed",
        committedSeq: nextSeq,
      };
      return replaceTool(current, location, nextTool, nextSeq);
    }

    // =======================================================================
    // ToolCallSettled
    // =======================================================================

    case ToolCallSettled.type: {
      const toolSettled = decodeHelper(ToolCallSettled, fact, context);
      const location = requireActiveTool(
        current,
        toolSettled.turnId,
        toolSettled.stepId,
        toolSettled.callId,
        "Tool-call settlement",
        context,
      );
      if (location.tool.status !== "committed") {
        fail(
          context,
          "invalid-lifecycle-transition",
          `Tool call ${toolSettled.callId} cannot settle from ${location.tool.status}`,
        );
      }

      const nextTool: ToolCallState =
        toolSettled.outcome === "ok"
          ? {
              ...location.tool,
              status: "settled",
              settledSeq: nextSeq,
              outcome: "ok",
              output: toolSettled.output,
            }
          : {
              ...location.tool,
              status: "settled",
              settledSeq: nextSeq,
              outcome: "error",
              error: toolSettled.error,
            };
      return replaceTool(current, location, nextTool, nextSeq);
    }

    // =======================================================================
    // StepSettled
    // =======================================================================

    case StepSettled.type: {
      const stepSettled = decodeHelper(StepSettled, fact, context);
      const location = requireActiveStep(
        current,
        stepSettled.turnId,
        stepSettled.stepId,
        "Step settlement",
        context,
      );
      const provider = location.step.providerInvocation;
      if (provider.status === "committed") {
        fail(
          context,
          "invalid-lifecycle-transition",
          `Step ${location.step.stepId} cannot settle before its Provider`,
        );
      }
      const unfinishedTool = location.step.toolCalls.find(
        (tool) => tool.status === "requested" || tool.status === "committed",
      );
      if (unfinishedTool) {
        fail(
          context,
          "invalid-lifecycle-transition",
          `Step ${location.step.stepId} cannot settle while Tool call ${unfinishedTool.callId} is ${unfinishedTool.status}`,
        );
      }

      if (
        provider.status === "completed" &&
        (stepSettled.outcome !== "completed" ||
          stepSettled.responseId !== provider.responseId)
      ) {
        fail(
          context,
          "invariant-violation",
          `Step ${location.step.stepId} settlement does not match its Provider completion`,
        );
      }
      if (
        provider.status === "failed" &&
        (stepSettled.outcome !== "failed" ||
          stepSettled.error !== provider.error)
      ) {
        fail(
          context,
          "invariant-violation",
          `Step ${location.step.stepId} settlement does not match its Provider failure`,
        );
      }

      const nextStep: StepState = {
        ...location.step,
        status: "settled",
        settledSeq: nextSeq,
      };
      return replaceStep(current, location, nextStep, nextSeq);
    }

    // =======================================================================
    // TurnSettled
    // =======================================================================

    case TurnSettled.type: {
      const turnSettled = decodeHelper(TurnSettled, fact, context);
      const { turn, turnIndex } = requireActiveTurn(
        current,
        turnSettled.turnId,
        "Turn settlement",
        context,
      );
      const activeStep = turn.steps.find((step) => step.status === "active");
      if (activeStep && turnSettled.outcome !== "cancelled") {
        fail(
          context,
          "invalid-lifecycle-transition",
          `Turn ${turn.turnId} cannot settle while Step ${activeStep.stepId} is active`,
        );
      }

      let nextTurn: TurnState;
      if (turnSettled.outcome === "completed") {
        const latestStep = turn.steps.at(-1);
        if (!latestStep) {
          fail(
            context,
            "invalid-lifecycle-transition",
            `Turn ${turn.turnId} cannot complete without a Step`,
          );
        }
        if (latestStep.providerInvocation.status !== "completed") {
          fail(
            context,
            "invalid-lifecycle-transition",
            `Turn ${turn.turnId} cannot complete after a failed Provider`,
          );
        }
        if (latestStep.toolCalls.length > 0) {
          fail(
            context,
            "invalid-lifecycle-transition",
            `Turn ${turn.turnId} requires another Step for its Tool-call results`,
          );
        }
        if (
          current.prompts.some(
            (prompt) =>
              prompt.status === "pending" &&
              prompt.prompt.mode === "steer" &&
              prompt.turnId === turn.turnId,
          )
        ) {
          fail(
            context,
            "invalid-lifecycle-transition",
            `Turn ${turn.turnId} cannot complete while a steering Prompt is pending`,
          );
        }

        nextTurn = {
          ...turn,
          status: "completed",
          settledSeq: nextSeq,
        };
      } else if (turnSettled.outcome === "failed") {
        nextTurn = {
          ...turn,
          status: "failed",
          settledSeq: nextSeq,
          error: turnSettled.error,
        };
      } else {
        nextTurn = {
          ...turn,
          status: "cancelled",
          settledSeq: nextSeq,
          steps: turn.steps.map((step): StepState =>
            step.status === "active"
              ? { ...step, status: "abandoned", abandonedSeq: nextSeq }
              : step,
          ),
        };
      }

      return {
        ...current,
        seq: nextSeq,
        prompts:
          turnSettled.outcome === "failed"
            ? skipPendingSteersForTurn(
                current.prompts,
                turn.turnId,
                nextSeq,
                "turn-failed",
              )
            : turnSettled.outcome === "cancelled"
              ? skipAllPendingQueuePrompts(
                  skipPendingSteersForTurn(
                    current.prompts,
                    turn.turnId,
                    nextSeq,
                    "turn-cancelled",
                  ),
                  nextSeq,
                )
              : current.prompts,
        turns: replaceAt(current.turns, turnIndex, nextTurn),
      };
    }

    default:
      fail(
        context,
        "unknown-fact-type",
        `Unknown Session fact type: ${fact.type}`,
      );
  }
}

type StepLocation = {
  readonly turn: TurnState;
  readonly turnIndex: number;
  readonly step: StepState;
  readonly stepIndex: number;
};

type ToolLocation = StepLocation & {
  readonly tool: ToolCallState;
  readonly toolIndex: number;
};

/** Decode the fact selected by the switch into its typed data. */
function decodeHelper<Data extends JsonObject>(
  kind: SessionFactKind<Data>,
  fact: SessionFact,
  context: ProjectionContext,
): Data {
  try {
    return kind.decode(fact.data);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    fail(
      context,
      "invalid-fact-data",
      `Invalid ${fact.type} fact data: ${detail}`,
      cause,
    );
  }
}

function fail(
  context: ProjectionContext,
  code: SessionProjectionErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new SessionProjectionError(
    code,
    message,
    context.factId,
    context.factType,
    context.seq,
    cause === undefined ? undefined : { cause },
  );
}

function requireActiveTurn(
  state: SessionState,
  turnId: string,
  action: string,
  context: ProjectionContext,
): { readonly turn: TurnState; readonly turnIndex: number } {
  const turnIndex = state.turns.findIndex((turn) => turn.turnId === turnId);
  if (turnIndex < 0) {
    fail(
      context,
      "unknown-entity",
      `${action} belongs to unknown Turn ${turnId}`,
    );
  }

  const turn = state.turns[turnIndex]!;
  if (turn.status !== "active") {
    fail(
      context,
      "invalid-lifecycle-transition",
      `${action} belongs to settled Turn ${turnId}`,
    );
  }
  return { turn, turnIndex };
}

function requireActiveStep(
  state: SessionState,
  turnId: string,
  stepId: string,
  action: string,
  context: ProjectionContext,
): StepLocation {
  const { turn, turnIndex } = requireActiveTurn(
    state,
    turnId,
    action,
    context,
  );
  const stepIndex = turn.steps.findIndex((step) => step.stepId === stepId);
  if (stepIndex < 0) {
    fail(
      context,
      "unknown-entity",
      `${action} belongs to unknown Step ${stepId}`,
    );
  }

  const step = turn.steps[stepIndex]!;
  if (step.status !== "active") {
    fail(
      context,
      "invalid-lifecycle-transition",
      `${action} belongs to settled Step ${stepId}`,
    );
  }
  return { turn, turnIndex, step, stepIndex };
}

function requireActiveTool(
  state: SessionState,
  turnId: string,
  stepId: string,
  callId: string,
  action: string,
  context: ProjectionContext,
): ToolLocation {
  const location = requireActiveStep(
    state,
    turnId,
    stepId,
    action,
    context,
  );
  const toolIndex = location.step.toolCalls.findIndex(
    (tool) => tool.callId === callId,
  );
  if (toolIndex < 0) {
    fail(
      context,
      "unknown-entity",
      `${action} belongs to unknown Tool call ${callId}`,
    );
  }
  return {
    ...location,
    tool: location.step.toolCalls[toolIndex]!,
    toolIndex,
  };
}

function claimPromptForTurn(
  prompts: readonly PromptState[],
  promptId: string,
  turnId: string,
  claimedSeq: number,
  context: ProjectionContext,
): readonly PromptState[] {
  const claimed = requirePendingPrompt(prompts, promptId, "Turn", context);
  if (claimed.prompt.mode !== "queue") {
    fail(
      context,
      "invalid-lifecycle-transition",
      `Turn ${turnId} cannot claim steering Prompt ${promptId}`,
    );
  }
  return prompts.map((prompt): PromptState =>
    prompt.prompt.id === promptId
      ? {
          prompt: prompt.prompt,
          admittedSeq: prompt.admittedSeq,
          status: "claimed-by-turn",
          turnId,
          claimedSeq,
        }
      : prompt,
  );
}

function claimPromptsForStep(
  prompts: readonly PromptState[],
  promptIds: readonly string[],
  turnId: string,
  stepId: string,
  claimedSeq: number,
  context: ProjectionContext,
): readonly PromptState[] {
  const claimed = requirePendingPrompts(
    prompts,
    promptIds,
    "Step",
    context,
  );
  for (const prompt of prompts) {
    if (!claimed.has(prompt.prompt.id)) continue;

    if (prompt.prompt.mode !== "steer") {
      fail(
        context,
        "invalid-lifecycle-transition",
        `Step ${stepId} cannot claim queue Prompt ${prompt.prompt.id}`,
      );
    }
    if (prompt.status === "pending" && prompt.turnId !== turnId) {
      fail(
        context,
        "invalid-lifecycle-transition",
        `Step ${stepId} cannot claim steering Prompt ${prompt.prompt.id} belonging to another Turn`,
      );
    }
  }

  /*
   * One Step boundary consumes the complete steer batch accumulated for this
   * Turn. Exact admission order makes ProviderRequest reconstruction
   * deterministic and prevents a caller from postponing one pending steer.
   */
  const pendingSteerIds = prompts
    .filter(
      (prompt) =>
        prompt.status === "pending" &&
        prompt.prompt.mode === "steer" &&
        prompt.turnId === turnId,
    )
    .map((prompt) => prompt.prompt.id);
  if (
    promptIds.length !== pendingSteerIds.length ||
    promptIds.some((promptId, index) => promptId !== pendingSteerIds[index])
  ) {
    fail(
      context,
      "invalid-lifecycle-transition",
      `Step ${stepId} must claim all pending steering Prompts for Turn ${turnId} in admission order`,
    );
  }

  if (promptIds.length === 0) return prompts;

  return prompts.map((prompt): PromptState =>
    claimed.has(prompt.prompt.id)
      ? {
          prompt: prompt.prompt,
          admittedSeq: prompt.admittedSeq,
          status: "claimed-by-step",
          turnId,
          stepId,
          claimedSeq,
        }
      : prompt,
  );
}

function requireCurrentActiveTurn(
  state: SessionState,
  promptId: string,
  context: ProjectionContext,
): TurnState {
  const turn = state.turns.find((candidate) => candidate.status === "active");
  if (!turn) {
    fail(
      context,
      "invalid-lifecycle-transition",
      `Steering Prompt ${promptId} admitted without an active Turn`,
    );
  }
  return turn;
}

/** A terminal Turn fact is the durable reason its unconsumed steers skip. */
function skipPendingSteersForTurn(
  prompts: readonly PromptState[],
  turnId: string,
  skippedSeq: number,
  reason: "turn-failed" | "turn-cancelled",
): readonly PromptState[] {
  return prompts.map((prompt): PromptState =>
    prompt.status === "pending" &&
    prompt.prompt.mode === "steer" &&
    prompt.turnId === turnId
      ? {
          prompt: prompt.prompt,
          admittedSeq: prompt.admittedSeq,
          status: "skipped",
          turnId,
          skippedSeq,
          reason,
        }
      : prompt,
  );
}

/**
 * Cancel one causal queue suffix. A fact sees exactly the Prompts admitted
 * before it, so a concurrent admission that commits first joins the suffix;
 * one committed afterward is new user intent and remains pending.
 */
function skipPendingQueueSuffix(
  prompts: readonly PromptState[],
  fromAdmittedSeq: number,
  skippedSeq: number,
): readonly PromptState[] {
  return prompts.map((prompt): PromptState =>
    prompt.status === "pending" &&
    prompt.prompt.mode === "queue" &&
    prompt.admittedSeq >= fromAdmittedSeq
      ? {
          prompt: prompt.prompt,
          admittedSeq: prompt.admittedSeq,
          status: "skipped",
          skippedSeq,
          reason: "cancelled",
        }
      : prompt,
  );
}

/** Active-Turn cancellation invalidates every queue job already behind it. */
function skipAllPendingQueuePrompts(
  prompts: readonly PromptState[],
  skippedSeq: number,
): readonly PromptState[] {
  return skipPendingQueueSuffix(prompts, 0, skippedSeq);
}

function requirePendingPrompts(
  prompts: readonly PromptState[],
  promptIds: readonly string[],
  owner: string,
  context: ProjectionContext,
): ReadonlySet<string> {
  const claimed = new Set<string>();
  for (const promptId of promptIds) {
    requirePendingPrompt(prompts, promptId, owner, context);
    claimed.add(promptId);
  }
  return claimed;
}

function requirePendingPrompt(
  prompts: readonly PromptState[],
  promptId: string,
  owner: string,
  context: ProjectionContext,
): PromptState {
  const prompt = prompts.find((candidate) => candidate.prompt.id === promptId);
  if (!prompt) {
    fail(
      context,
      "unknown-entity",
      `${owner} claims unknown Prompt ${promptId}`,
    );
  }
  if (prompt.status !== "pending") {
    fail(
      context,
      "invalid-lifecycle-transition",
      `${owner} claims non-pending Prompt ${promptId} with status ${prompt.status}`,
    );
  }
  return prompt;
}

function assertProviderOpen(
  step: StepState,
  action: string,
  context: ProjectionContext,
): void {
  if (step.providerInvocation.status !== "committed") {
    fail(
      context,
      "invalid-lifecycle-transition",
      `${action} recorded after Provider settlement in Step ${step.stepId}`,
    );
  }
}

function assertOutputIndexAvailable(
  step: StepState,
  outputIndex: number,
  context: ProjectionContext,
): void {
  if (
    step.providerOutputs.some((output) => output.outputIndex === outputIndex) ||
    step.toolCalls.some((tool) => tool.outputIndex === outputIndex)
  ) {
    fail(
      context,
      "duplicate-entity",
      `Step ${step.stepId} repeats Provider output index ${outputIndex}`,
    );
  }
}

function replaceStep(
  current: SessionState,
  location: StepLocation,
  step: StepState,
  nextSeq: number,
): SessionState {
  const turn: TurnState = {
    ...location.turn,
    steps: replaceAt(location.turn.steps, location.stepIndex, step),
  };
  return {
    ...current,
    seq: nextSeq,
    turns: replaceAt(current.turns, location.turnIndex, turn),
  };
}

function replaceTool(
  current: SessionState,
  location: ToolLocation,
  tool: ToolCallState,
  nextSeq: number,
): SessionState {
  const step: StepState = {
    ...location.step,
    toolCalls: replaceAt(location.step.toolCalls, location.toolIndex, tool),
  };
  return replaceStep(current, location, step, nextSeq);
}

function replaceAt<T>(items: readonly T[], index: number, item: T): readonly T[] {
  return items.map((candidate, candidateIndex) =>
    candidateIndex === index ? item : candidate,
  );
}
