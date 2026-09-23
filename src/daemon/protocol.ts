import type { SessionState } from "../harness/session-state.js";
import type {
  SessionActivity,
  SessionBase,
} from "../harness/session.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };
export type PromptPart = JsonObject & { type: string };
export type Delivery = "steer" | "queue";
export type ToolOutcome = "ok" | "error" | "interrupted";
export type AssistantStatus =
  | "streaming"
  | "complete"
  | "failed"
  | "interrupted";

export type SessionSummary = {
  id: string;
  createdAt: number;
  base?: SessionBase;
  headSeq: number;
  activity: SessionActivity;
};

export type TranscriptEntry =
  | {
      id: string;
      kind: "user";
      position: number;
      text: string;
    }
  | {
      id: string;
      kind: "assistant";
      position: number;
      stepID: string;
      text: string;
      status: AssistantStatus;
    }
  | {
      id: string;
      kind: "tool";
      position: number;
      stepID: string;
      callID: string;
      name: string;
      outcome: ToolOutcome | "running";
      output: string;
    }
  | {
      id: string;
      kind: "system" | "error";
      position: number;
      text: string;
    };

export type SessionView = {
  transcript: readonly TranscriptEntry[];
  running: boolean;
};

export type HarnessCapabilities = {
  branchSessions: true;
  cancelPrompts: true;
  resumeSessions: true;
  configureTurnServices: true;
};

export type SessionExecution =
  | { status: "idle" }
  | { status: "paused" }
  | { status: "running" }
  | { status: "recovery-required"; message: string }
  | { status: "failed"; message: string };

export type EventCursor = {
  streamID: string;
  revision: number;
};

export type SessionSnapshot = {
  session: SessionSummary;
  /** Complete durable Harness projection; the transcript is derived from it. */
  state: SessionState;
  execution: SessionExecution;
  view: SessionView;
  historyLength: number;
  cursor: EventCursor;
};

export type SessionChange =
  | "input-admitted"
  | "run-started"
  | "run-finished"
  | "other";

export type HarnessEvent =
  | { type: "session.created"; session: SessionSummary }
  | {
      type: "session.updated";
      sessionID: string;
      headSeq: number;
      change: SessionChange;
    }
  | {
      type: "message.delta";
      sessionID: string;
      stepID: string;
      outputIndex: number;
      contentIndex: number;
      delta: string;
    }
  | { type: "message.boundary"; sessionID: string; stepID: string }
  | {
      type: "tool.started";
      sessionID: string;
      stepID: string;
      callID: string;
      name: string;
    }
  | {
      type: "tool.completed";
      sessionID: string;
      stepID: string;
      callID: string;
      name: string;
      outcome: ToolOutcome;
    }
  | {
      type: "permission.requested";
      sessionID: string;
      requestID: string;
      toolName: string;
      argumentsJSON: string;
    }
  | { type: "session.recovery-required"; sessionID: string; message: string }
  | { type: "session.error"; sessionID: string; message: string };

export type RevisionedHarnessEvent = EventCursor & {
  event: HarnessEvent;
};
