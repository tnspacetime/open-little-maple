import type {
  AssistantStatus,
  SessionView,
  ToolOutcome,
  TranscriptEntry,
} from "./protocol.ts";
import type { JsonValue } from "../harness/json.js";
import type {
  SessionState,
  StepState,
  ToolCallState,
} from "../harness/session-state.js";

/** Derive the existing transcript surface without hiding the rich projection. */
export function createSessionView(
  state: SessionState,
  running: boolean,
): SessionView {
  const transcript: TranscriptEntry[] = [];

  for (const prompt of state.prompts) {
    transcript.push({
      id: `user:${prompt.prompt.id}`,
      kind: "user",
      position: prompt.admittedSeq,
      text: prompt.prompt.parts.map(promptPartText).join("\n"),
    });
  }

  for (const turn of state.turns) {
    for (const step of turn.steps) {
      const status = assistantStatus(step);
      const text = [...step.providerOutputs]
        .sort(
          (left, right) =>
            left.outputIndex - right.outputIndex ||
            left.recordedSeq - right.recordedSeq,
        )
        .map(({ item }) => providerOutputText(item))
        .filter(Boolean)
        .join("\n");
      if (text || status !== "complete") {
        transcript.push({
          id: `assistant:${step.stepId}`,
          kind: "assistant",
          position:
            step.providerOutputs[0]?.recordedSeq ??
            step.providerInvocation.committedSeq,
          stepID: step.stepId,
          text,
          status,
        });
      }

      for (const tool of step.toolCalls) {
        const presentation = toolPresentation(tool);
        transcript.push({
          id: `tool:${tool.callId}`,
          kind: "tool",
          position: tool.requestedSeq,
          stepID: step.stepId,
          callID: tool.callId,
          name: tool.name,
          outcome: presentation.outcome,
          output: presentation.output,
        });
      }

      if (step.providerInvocation.status === "failed") {
        transcript.push({
          id: `error:${step.stepId}`,
          kind: "error",
          position: step.providerInvocation.settledSeq,
          text: step.providerInvocation.error,
        });
      }
      if (step.status === "abandoned") {
        transcript.push({
          id: `cancelled:${step.stepId}`,
          kind: "system",
          position: step.abandonedSeq,
          text: "The Turn was cancelled.",
        });
      }
    }
  }

  return {
    transcript: transcript.sort(
      (left, right) => left.position - right.position,
    ),
    running,
  };
}

function promptPartText(part: { readonly [key: string]: JsonValue }): string {
  return typeof part.text === "string" ? part.text : JSON.stringify(part);
}

function assistantStatus(step: StepState): AssistantStatus {
  if (step.status === "abandoned") return "interrupted";
  if (step.status === "active") return "streaming";
  return step.providerInvocation.status === "failed" ? "failed" : "complete";
}

function toolPresentation(tool: ToolCallState): {
  readonly outcome: ToolOutcome | "running";
  readonly output: string;
} {
  if (tool.status === "requested" || tool.status === "committed") {
    return { outcome: "running", output: "" };
  }
  if (tool.status === "rejected") {
    return { outcome: "error", output: tool.reason };
  }
  if (tool.outcome === "error") {
    return { outcome: "error", output: tool.error };
  }
  return {
    outcome: "ok",
    output:
      typeof tool.output === "string"
        ? tool.output
        : JSON.stringify(tool.output),
  };
}

function providerOutputText(item: { readonly [key: string]: JsonValue }): string {
  if (Array.isArray(item.content)) {
    return item.content
      .flatMap((part) =>
        record(part) && typeof part.text === "string" ? [part.text] : [],
      )
      .join("\n");
  }
  return typeof item.output === "string" ? item.output : "";
}

function record(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
