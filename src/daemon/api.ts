import { APIError, createEndpoint, createRouter } from "better-call";
import { z } from "zod";

import type { PromptPart } from "./protocol.ts";
import type { DaemonBackend } from "./backend.ts";
import type { HarnessEventHub } from "./events.ts";
import { hasBearerToken } from "./sse.ts";

const createSessionBody = z.object({
  id: z.string().min(1).optional(),
});

const forkSessionBody = z.object({
  id: z.string().min(1).optional(),
  throughSeq: z.number().int().nonnegative().optional(),
});

const promptPart = z
  .record(z.string(), z.json())
  .refine((part) => typeof part.type === "string", {
    message: "Every prompt part must have a string type",
  });

const sendMessageBody = z.object({
  id: z.string().min(1).optional(),
  parts: z.array(promptPart).min(1),
  delivery: z.enum(["queue", "steer"]).optional(),
});

export type DaemonApiOptions = {
  backend: DaemonBackend;
  eventHub: HarnessEventHub;
  secret: string;
};

export function createDaemonRouter({
  backend,
  eventHub,
  secret,
}: DaemonApiOptions) {
  const health = createEndpoint(
    "/health",
    { method: "GET" },
    async () => ({
      ok: true as const,
      pid: process.pid,
      harnessID: backend.harnessID,
      capabilities: backend.capabilities,
      cursor: eventHub.cursor(),
    }),
  );

  const listSessions = createEndpoint(
    "/sessions",
    { method: "GET" },
    async () => ({
      sessions: await backend.listSessions(),
      cursor: eventHub.cursor(),
    }),
  );

  const createSession = createEndpoint(
    "/sessions",
    { method: "POST", body: createSessionBody },
    async ({ body }) =>
      translateHarnessErrors(async () => {
        const session = await backend.createSession({
          ...(body.id === undefined ? {} : { id: body.id }),
        });
        eventHub.emit({ type: "session.created", session });
        return { session, cursor: eventHub.cursor() };
      }),
  );

  const getSession = createEndpoint(
    "/sessions/:sessionID",
    { method: "GET" },
    async ({ params }) =>
      translateHarnessErrors(async () => {
        const data = await backend.getSession(params.sessionID);
        return {
          ...data,
          cursor: eventHub.cursor(),
        };
      }),
  );

  const forkSession = createEndpoint(
    "/sessions/:sessionID/forks",
    { method: "POST", body: forkSessionBody },
    async ({ body, params }) =>
      translateHarnessErrors(async () => {
        const session = await backend.branchSession(params.sessionID, {
          ...(body.id === undefined ? {} : { id: body.id }),
          ...(body.throughSeq === undefined
            ? {}
            : { throughSeq: body.throughSeq }),
        });
        eventHub.emit({ type: "session.created", session });
        return { session, cursor: eventHub.cursor() };
      }),
  );

  const sendMessage = createEndpoint(
    "/sessions/:sessionID/messages",
    { method: "POST", body: sendMessageBody },
    async ({ body, params }) =>
      translateHarnessErrors(async () => {
        const accepted = await backend.sendMessage(params.sessionID, {
          parts: body.parts as PromptPart[],
          ...(body.id === undefined ? {} : { id: body.id }),
          ...(body.delivery === undefined
            ? {}
            : { delivery: body.delivery }),
        });
        return {
          accepted: true as const,
          inputID: accepted.inputID,
          cursor: eventHub.cursor(),
        };
      }),
  );

  const cancelPrompt = createEndpoint(
    "/sessions/:sessionID/prompts/:promptID/cancel",
    { method: "POST" },
    async ({ params }) => {
      await translateHarnessErrors(() =>
        backend.cancelPrompt(params.sessionID, params.promptID),
      );
      return { cancelled: true as const, cursor: eventHub.cursor() };
    },
  );

  const resumeSession = createEndpoint(
    "/sessions/:sessionID/resume",
    { method: "POST" },
    async ({ params }) => {
      await translateHarnessErrors(() => backend.resumeSession(params.sessionID));
      return { resumed: true as const, cursor: eventHub.cursor() };
    },
  );

  const retryBlockedSession = createEndpoint(
    "/sessions/:sessionID/retry-blocked",
    { method: "POST" },
    async ({ params }) => {
      await translateHarnessErrors(() =>
        backend.retryBlockedSession(params.sessionID),
      );
      return { retried: true as const, cursor: eventHub.cursor() };
    },
  );

  return createRouter(
    {
      health,
      listSessions,
      createSession,
      getSession,
      forkSession,
      sendMessage,
      cancelPrompt,
      resumeSession,
      retryBlockedSession,
    },
    {
      allowedMediaTypes: ["application/json"],
      openapi: { disabled: true },
      onRequest(request) {
        if (hasBearerToken(request.headers.get("authorization") ?? undefined, secret)) {
          return;
        }
        return Response.json(
          { error: "Unauthorized" },
          {
            status: 401,
            headers: { "WWW-Authenticate": "Bearer" },
          },
        );
      },
    },
  );
}

export type DaemonRouter = ReturnType<typeof createDaemonRouter>;

async function translateHarnessErrors<Value>(
  body: () => Value | Promise<Value>,
): Promise<Value> {
  try {
    return await body();
  } catch (cause) {
    const error = asError(cause);
    if (error.message.startsWith("Session not found:")) {
      throw new APIError("NOT_FOUND", { message: error.message });
    }
    if (error.message.startsWith("Missing contribution:")) {
      throw new APIError("BAD_REQUEST", { message: error.message });
    }
    throw cause;
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
