/** Deterministic reconstruction of one Step's transient ProviderRequest. */
import {
  assertNonempty,
  deepFreeze,
  jsonValue,
  object,
  stringField,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import type { Prompt } from "./session-facts.js";
import type {
  SessionState,
  StepState,
  ToolCallState,
  TurnState,
} from "./session-state.js";
import {
  HistoryTranslator,
  Provider,
  Tool,
  type ProviderRequest,
  type ProviderTurnHistory,
  type StepHistory,
  type ToolCallResult,
  type ToolDescription,
} from "./turn-service.js";
import {
  TurnServiceConfiguration,
  type TurnServiceConfigurationDescription,
} from "./turn-service-configuration.js";

/**
 * Reconstruct the exact request committed for one Step.
 *
 * SessionState supplies every durable input. TurnServiceConfiguration supplies
 * only the matching live Provider and HistoryTranslators needed to encode that
 * input. A retry follows retryOfStepId to the original request boundary, so
 * output from failed attempts and steers admitted after that boundary cannot
 * enter the reconstructed request.
 */
export function deriveProviderRequest(
  state: SessionState,
  configuration: TurnServiceConfiguration,
  turnId: string,
  stepId: string,
): ProviderRequest {
  const turnIndex = state.turns.findIndex((turn) => turn.turnId === turnId);
  if (turnIndex < 0) throw new Error(`Unknown Turn ${turnId}`);

  const turn = state.turns[turnIndex]!;
  const stepIndex = turn.steps.findIndex((step) => step.stepId === stepId);
  if (stepIndex < 0) {
    throw new Error(`Unknown Step ${stepId} in Turn ${turnId}`);
  }

  assertTurnServiceConfiguration(
    turn.serviceConfiguration,
    configuration,
  );

  const providers = configuration.entries(Provider);
  if (providers.length !== 1) {
    throw new Error(
      `ProviderRequest requires exactly one Provider, found ${providers.length}`,
    );
  }

  const providerEntry = providers[0]!;
  const provider = providerEntry.value;
  const historyFormat = stringField(
    providerEntry.settings,
    "historyFormat",
  );
  assertNonempty(historyFormat, "Provider history format");
  if (provider.historyFormat !== historyFormat) {
    throw new Error(
      `Provider ${providerEntry.key} live history format ` +
        `${provider.historyFormat} does not match durable format ${historyFormat}`,
    );
  }

  const history: JsonObject[] = [];

  /* Earlier completed Turns contribute their accepted response history. */
  for (const earlierTurn of state.turns.slice(0, turnIndex)) {
    if (earlierTurn.status === "active") {
      throw new Error(
        `Turn ${turnId} cannot follow active Turn ${earlierTurn.turnId}`,
      );
    }

    if (earlierTurn.status === "completed") {
      appendEarlierCompletedTurn(
        history,
        state,
        earlierTurn,
        configuration,
        provider,
      );
      continue;
    }

    /*
     * Failed or cancelled Provider output is not accepted continuation
     * history. User-authored Prompts remain history, however, just as they
     * remain durable Session facts after the terminal Turn.
     */
    for (const prompt of requestPromptsFromUncompletedTurn(
      state,
      earlierTurn,
    )) {
      appendEncodedPrompt(history, provider, prompt);
    }
  }

  const boundaryIndex = originalRequestBoundaryIndex(turn, stepIndex);

  /* Every accepted response before this boundary continues in native format. */
  appendNativeStepHistories(
    history,
    provider,
    completedStepHistories(state, turn, boundaryIndex),
  );

  /* The boundary's Prompts are the final input before Provider.stream(). */
  for (const prompt of promptsForBoundary(state, turn, boundaryIndex)) {
    appendEncodedPrompt(history, provider, prompt);
  }

  return deepFreeze({
    model: providerModel(providerEntry.settings),
    instructions: providerInstructions(providerEntry.settings),
    history,
    tools: selectedToolDescriptions(configuration),
    metadata: providerMetadata(providerEntry.settings),
  });
}

function appendEarlierCompletedTurn(
  destination: JsonObject[],
  state: SessionState,
  turn: TurnState,
  configuration: TurnServiceConfiguration,
  provider: Provider,
): void {
  const sourceFormat = providerHistoryFormat(turn.serviceConfiguration);
  const history = deepFreeze({
    turnId: turn.turnId,
    historyFormat: sourceFormat,
    steps: completedStepHistories(state, turn, turn.steps.length),
  } satisfies ProviderTurnHistory);

  if (sourceFormat === provider.historyFormat) {
    appendNativeStepHistories(destination, provider, history.steps);
    return;
  }

  const translators = configuration
    .entries(HistoryTranslator)
    .filter(
      ({ value }) =>
        value.sourceFormat === sourceFormat &&
        value.targetFormat === provider.historyFormat,
    );
  if (translators.length !== 1) {
    throw new Error(
      `ProviderRequest requires exactly one HistoryTranslator from ` +
        `${sourceFormat} to ${provider.historyFormat}, found ${translators.length}`,
    );
  }

  const translator = translators[0]!;
  const durableSource = stringField(translator.settings, "sourceFormat");
  const durableTarget = stringField(translator.settings, "targetFormat");
  if (
    durableSource !== translator.value.sourceFormat ||
    durableTarget !== translator.value.targetFormat
  ) {
    throw new Error(
      `HistoryTranslator ${translator.key} does not match its durable formats`,
    );
  }

  appendJsonObjects(
    destination,
    translator.value.translate(history),
    `HistoryTranslator ${translator.key} output`,
  );
}

function appendNativeStepHistories(
  destination: JsonObject[],
  provider: Provider,
  steps: readonly StepHistory[],
): void {
  for (const step of steps) {
    for (const prompt of step.prompts) {
      appendEncodedPrompt(destination, provider, prompt);
    }
    for (const item of step.providerItems) {
      destination.push(
        validatedObject(
          item.item,
          `Step ${step.stepId} Provider output ${item.outputIndex}`,
        ),
      );
    }
    for (const result of step.toolCallResults) {
      destination.push(
        validatedObject(
          provider.encodeToolCallResult(result),
          `Step ${step.stepId} Tool result ${result.callId}`,
        ),
      );
    }
  }
}

function appendEncodedPrompt(
  destination: JsonObject[],
  provider: Provider,
  prompt: Prompt,
): void {
  appendJsonObjects(
    destination,
    provider.encodePrompt(prompt),
    `Prompt ${prompt.id} encoding`,
  );
}

function appendJsonObjects(
  destination: JsonObject[],
  values: readonly JsonObject[],
  label: string,
): void {
  for (const [index, value] of values.entries()) {
    destination.push(validatedObject(value, `${label}[${index}]`));
  }
}

function validatedObject(value: unknown, label: string): JsonObject {
  return object(jsonValue(value, label), label);
}

/** Collapse physical retry attempts into accepted logical request histories. */
function completedStepHistories(
  state: SessionState,
  turn: TurnState,
  throughStepIndex: number,
): readonly StepHistory[] {
  const histories: StepHistory[] = [];
  let index = 0;

  while (index < throughStepIndex) {
    const boundaryIndex = index;
    const boundary = turn.steps[index]!;
    if (boundary.retryOfStepId !== undefined) {
      throw new Error(
        `Step ${boundary.stepId} has no original request boundary`,
      );
    }

    let accepted = boundary;
    index += 1;
    while (index < throughStepIndex) {
      const retry = turn.steps[index]!;
      if (retry.retryOfStepId === undefined) break;
      if (retry.retryOfStepId !== accepted.stepId) {
        throw new Error(
          `Retry Step ${retry.stepId} does not follow ${accepted.stepId}`,
        );
      }
      accepted = retry;
      index += 1;
    }

    if (
      accepted.status !== "settled" ||
      accepted.providerInvocation.status !== "completed"
    ) {
      throw new Error(
        `Step chain ending at ${accepted.stepId} has no completed response`,
      );
    }

    histories.push(
      deepFreeze({
        stepId: accepted.stepId,
        prompts: promptsForBoundary(state, turn, boundaryIndex),
        providerItems: providerItems(accepted),
        toolCallResults: toolCallResults(accepted),
      }),
    );
  }

  return Object.freeze(histories);
}

function originalRequestBoundaryIndex(
  turn: TurnState,
  targetIndex: number,
): number {
  let index = targetIndex;
  while (turn.steps[index]!.retryOfStepId !== undefined) {
    const retry = turn.steps[index]!;
    const preceding = turn.steps[index - 1];
    if (!preceding || retry.retryOfStepId !== preceding.stepId) {
      throw new Error(
        `Retry Step ${retry.stepId} does not identify its preceding Step`,
      );
    }
    index -= 1;
  }
  return index;
}

function promptsForBoundary(
  state: SessionState,
  turn: TurnState,
  boundaryIndex: number,
): readonly Prompt[] {
  const step = turn.steps[boundaryIndex];
  if (!step) {
    throw new Error(
      `Turn ${turn.turnId} has no Step at index ${boundaryIndex}`,
    );
  }

  const promptIds =
    boundaryIndex === 0
      ? [turn.promptId, ...step.promptIds]
      : [...step.promptIds];
  return Object.freeze(
    promptIds.map((promptId) => requirePrompt(state, promptId)),
  );
}

function requestPromptsFromUncompletedTurn(
  state: SessionState,
  turn: TurnState,
): readonly Prompt[] {
  const prompts: Prompt[] = [requirePrompt(state, turn.promptId)];
  for (const step of turn.steps) {
    if (step.retryOfStepId !== undefined) continue;
    for (const promptId of step.promptIds) {
      prompts.push(requirePrompt(state, promptId));
    }
  }
  return Object.freeze(prompts);
}

function requirePrompt(state: SessionState, promptId: string): Prompt {
  const prompt = state.prompts.find(
    (candidate) => candidate.prompt.id === promptId,
  );
  if (!prompt) throw new Error(`Unknown Prompt ${promptId}`);
  return prompt.prompt;
}

function providerItems(step: StepState): StepHistory["providerItems"] {
  return Object.freeze(
    [
      ...step.providerOutputs.map(({ outputIndex, item }) => ({
        outputIndex,
        item: validatedObject(item, `Provider output ${outputIndex}`),
      })),
      ...step.toolCalls.map(({ outputIndex, providerItem }) => ({
        outputIndex,
        item: validatedObject(
          providerItem,
          `Tool-call Provider item ${outputIndex}`,
        ),
      })),
    ].sort((left, right) => left.outputIndex - right.outputIndex),
  );
}

function toolCallResults(step: StepState): readonly ToolCallResult[] {
  return Object.freeze(
    [...step.toolCalls]
      .sort(
        (left, right) =>
          left.outputIndex - right.outputIndex ||
          left.callId.localeCompare(right.callId),
      )
      .map(toolCallResult),
  );
}

function toolCallResult(tool: ToolCallState): ToolCallResult {
  if (tool.status === "rejected") {
    return deepFreeze({
      outcome: "rejected",
      callId: tool.callId,
      name: tool.name,
      reason: tool.reason,
    });
  }
  if (tool.status === "settled" && tool.outcome === "ok") {
    return deepFreeze({
      outcome: "ok",
      callId: tool.callId,
      name: tool.name,
      output: structuredClone(tool.output),
    });
  }
  if (tool.status === "settled") {
    return deepFreeze({
      outcome: "error",
      callId: tool.callId,
      name: tool.name,
      error: tool.error,
    });
  }
  throw new Error(`Tool call ${tool.callId} is not terminal`);
}

function providerHistoryFormat(
  description: TurnServiceConfigurationDescription,
): string {
  const providers = description.services.filter(
    (service) => service.kind === Provider.id,
  );
  if (providers.length !== 1) {
    throw new Error(
      `Turn configuration requires exactly one Provider, found ${providers.length}`,
    );
  }
  const format = stringField(providers[0]!.settings, "historyFormat");
  assertNonempty(format, "Turn Provider history format");
  return format;
}

function providerModel(settings: JsonObject): string {
  const model = stringField(settings, "model");
  assertNonempty(model, "Provider model");
  return model;
}

function providerInstructions(settings: JsonObject): readonly string[] {
  const value = settings.instructions;
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Provider instructions must be an array of strings");
  }
  const instructions = [...value] as string[];
  for (const instruction of instructions) {
    assertNonempty(instruction, "Provider instruction");
  }
  return Object.freeze(instructions);
}

function providerMetadata(settings: JsonObject): JsonObject {
  return validatedObject(settings.metadata ?? {}, "Provider metadata");
}

function selectedToolDescriptions(
  configuration: TurnServiceConfiguration,
): readonly ToolDescription[] {
  const names = new Set<string>();
  return Object.freeze(
    configuration.entries(Tool).map((entry): ToolDescription => {
      const name = stringField(entry.settings, "name");
      const description = stringField(entry.settings, "description");
      assertNonempty(name, `Tool ${entry.key} name`);
      assertNonempty(description, `Tool ${name} description`);
      if (names.has(name)) {
        throw new Error(`Selected Tools repeat Provider name ${name}`);
      }
      names.add(name);

      return deepFreeze({
        name,
        description,
        inputSchema: validatedObject(
          entry.settings.inputSchema,
          `Tool ${name} input schema`,
        ),
      });
    }),
  );
}

/** Require one live configuration to be the exact configuration frozen on a Turn. */
export function assertTurnServiceConfiguration(
  durable: TurnServiceConfigurationDescription,
  live: TurnServiceConfiguration,
): void {
  const candidate = live.description;
  const matches =
    durable.services.length === candidate.services.length &&
    durable.services.every((service, index) => {
      const other = candidate.services[index];
      return (
        other !== undefined &&
        service.kind === other.kind &&
        service.key === other.key &&
        service.revision === other.revision &&
        service.order === other.order &&
        sameJsonValue(service.settings, other.settings)
      );
    });
  if (!matches) {
    throw new Error("Live TurnServiceConfiguration does not match the Turn");
  }
}

function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]!))
    );
  }

  const leftObject = left as { readonly [key: string]: JsonValue };
  const rightObject = right as { readonly [key: string]: JsonValue };
  const leftKeys = Object.keys(leftObject);
  return (
    leftKeys.length === Object.keys(rightObject).length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightObject, key) &&
        sameJsonValue(leftObject[key]!, rightObject[key]!),
    )
  );
}
