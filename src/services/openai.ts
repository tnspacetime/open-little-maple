import {
  object,
  stringField,
  type JsonObject,
} from "../harness/json.js";
import type {
  Provider,
  ProviderEvent,
  ProviderRequest,
  ToolCallResult,
} from "../harness/turn-service.js";

export const OPENAI_RESPONSES_V1 = "openai.responses/v1";

export type OpenAIResponsesProviderOptions = {
  readonly apiKey: string;
  readonly baseURL?: string;
};

/** Real OpenAI Responses API adapter for the Harness Provider boundary. */
export class OpenAIResponsesProvider implements Provider {
  readonly historyFormat = OPENAI_RESPONSES_V1;

  constructor(private readonly options: OpenAIResponsesProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("OpenAI API key cannot be empty");
  }

  encodePrompt(prompt: Parameters<Provider["encodePrompt"]>[0]) {
    return [{ role: "user", content: [...prompt.parts] }];
  }

  encodeToolCallResult(result: ToolCallResult): JsonObject {
    return {
      type: "function_call_output",
      call_id: result.callId,
      output: toolResultOutput(result),
    };
  }

  async *stream(
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const baseURL = this.options.baseURL ?? "https://api.openai.com/v1";
    const response = await fetch(`${baseURL.replace(/\/$/, "")}/responses`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        instructions: request.instructions.join("\n"),
        input: request.history,
        tools: request.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: true,
        })),
        tool_choice: "auto",
        include: ["reasoning.encrypted_content"],
        metadata: request.metadata,
        store: false,
        stream: true,
      }),
    });

    if (!response.ok) {
      const message = `OpenAI HTTP ${response.status}: ${await response.text()}`;
      yield {
        type: "failed",
        error: message,
        disposition: retryableHttpStatus(response.status)
          ? "retry-safe"
          : "terminal",
      };
      return;
    }
    if (!response.body) throw new Error("OpenAI response has no stream body");

    let terminal = false;
    for await (const event of sseObjects(response.body)) {
      const type = stringField(event, "type");

      if (
        (type === "response.output_text.delta" ||
          type === "response.refusal.delta") &&
        typeof event.delta === "string"
      ) {
        yield {
          type: "text-delta",
          outputIndex: nonnegativeInteger(event.output_index, "output_index"),
          contentIndex: nonnegativeInteger(event.content_index, "content_index"),
          delta: event.delta,
        };
        continue;
      }

      if (type === "response.output_item.done") {
        const item = object(event.item, "OpenAI output item");
        const outputIndex = nonnegativeInteger(event.output_index, "output_index");
        if (stringField(item, "type") === "function_call") {
          yield {
            type: "tool-call",
            outputIndex,
            itemId: stringField(item, "id"),
            callId: stringField(item, "call_id"),
            name: stringField(item, "name"),
            argumentsJSON:
              typeof item.arguments === "string" ? item.arguments : "{}",
            providerItem: item,
          };
        } else {
          yield { type: "output-item", outputIndex, item };
        }
        continue;
      }

      if (type === "response.completed") {
        const completed = object(event.response, "completed OpenAI response");
        terminal = true;
        yield {
          type: "completed",
          responseId: stringField(completed, "id"),
        };
        return;
      }

      if (type === "response.failed" || type === "response.incomplete") {
        const failure = responseFailure(event, type);
        terminal = true;
        yield {
          type: "failed",
          error: failure.message,
          disposition:
            type === "response.failed" && retryableOpenAIError(failure.code)
              ? "retry-safe"
              : "terminal",
        };
        return;
      }

      if (type === "error") {
        const code = typeof event.code === "string" ? event.code : undefined;
        terminal = true;
        yield {
          type: "failed",
          error:
            typeof event.message === "string"
              ? event.message
              : "OpenAI stream reported an error",
          disposition: retryableOpenAIError(code)
            ? "retry-safe"
            : "terminal",
        };
        return;
      }
    }

    if (!terminal) {
      // Missing a terminal SSE event leaves the already-committed invocation
      // externally ambiguous. Throwing deliberately produces no settlement.
      throw new Error("OpenAI stream ended without a terminal event");
    }
  }
}

function toolResultOutput(result: ToolCallResult): string {
  if (result.outcome === "ok") {
    return typeof result.output === "string"
      ? result.output
      : JSON.stringify(result.output);
  }
  if (result.outcome === "error") return `Tool error: ${result.error}`;
  return `Tool rejected: ${result.reason}`;
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryableOpenAIError(code: string | undefined): boolean {
  return (
    code === "server_error" ||
    code === "rate_limit_exceeded" ||
    code === "request_timeout"
  );
}

function responseFailure(
  event: JsonObject,
  type: string,
): { readonly code?: string; readonly message: string } {
  const response = object(event.response, `${type} response`);
  const error =
    response.error === null || response.error === undefined
      ? undefined
      : object(response.error, `${type} response error`);
  const code =
    error && typeof error.code === "string" ? error.code : undefined;
  const message =
    error && typeof error.message === "string"
      ? error.message
      : `OpenAI response ended with ${type}`;
  return { ...(code ? { code } : {}), message };
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`OpenAI ${label} must be a nonnegative integer`);
  }
  return value as number;
}

async function* sseObjects(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<JsonObject> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      const parsed = completeSseBlocks(buffer);
      buffer = parsed.remainder;
      for (const event of parsed.events) yield event;
    }

    buffer += decoder.decode();
    for (const event of completeSseBlocks(`${buffer}\n\n`).events) yield event;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function completeSseBlocks(buffer: string): {
  readonly events: readonly JsonObject[];
  readonly remainder: string;
} {
  const events: JsonObject[] = [];
  let start = 0;
  while (true) {
    const boundary = buffer.indexOf("\n\n", start);
    if (boundary < 0) break;
    const block = buffer.slice(start, boundary);
    start = boundary + 2;
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data && data !== "[DONE]") {
      events.push(object(JSON.parse(data), "OpenAI SSE event"));
    }
  }
  return { events, remainder: buffer.slice(start) };
}
