import type {
  Delivery,
  HarnessCapabilities,
  PromptPart,
  SessionExecution,
  SessionSummary,
  SessionView,
} from "./protocol.ts";
import type { SessionState } from "../harness/session-state.js";

export type SessionData = {
  session: SessionSummary;
  state: SessionState;
  execution: SessionExecution;
  view: SessionView;
  historyLength: number;
};

export type CreateSessionInput = {
  id?: string;
};

export type ForkSessionInput = {
  id?: string;
  throughSeq?: number;
};

export type SendMessageInput = {
  id?: string;
  parts: readonly PromptPart[];
  delivery?: Delivery;
};

export interface DaemonBackend {
  readonly harnessID: string;
  readonly capabilities: HarnessCapabilities;

  listSessions(): Promise<readonly SessionSummary[]>;
  createSession(input?: CreateSessionInput): Promise<SessionSummary>;
  getSession(sessionID: string): Promise<SessionData>;
  branchSession(
    parentSessionID: string,
    input?: ForkSessionInput,
  ): Promise<SessionSummary>;
  sendMessage(
    sessionID: string,
    input: SendMessageInput,
  ): Promise<{ inputID: string }>;
  cancelPrompt(sessionID: string, promptID: string): Promise<void>;
  resumeSession(sessionID: string): Promise<void>;
  retryBlockedSession(sessionID: string): Promise<void>;
  close(): Promise<void>;
}
