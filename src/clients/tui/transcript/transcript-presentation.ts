import type { SessionSnapshot } from "../../harness-client.ts";
import type { SessionSynchronization } from "../../session-client-store.ts";
import type { HarnessEvent } from "../../../daemon/protocol.ts";

export type RowKind = "user" | "assistant" | "tool" | "system" | "error";
type LabeledRow = {
  id: string;
  label: string;
  text: string;
};

export type AssistantState =
  | "streaming"
  | "complete"
  | "failed"
  | "interrupted";

export type TranscriptRow =
  | (LabeledRow & {
      kind: "assistant";
      state: AssistantState;
    })
  | (LabeledRow & {
      kind: Exclude<RowKind, "assistant">;
    });

export type SessionTranscriptPresentation = {
  rows: TranscriptRow[];
  emptyText: string | undefined;
};

export function presentSessionTranscript(
  sessionID: string | undefined,
  session: SessionSynchronization | undefined,
): SessionTranscriptPresentation {
  if (!sessionID) {
    return { rows: [], emptyText: "Choose or create a session." };
  }
  if (!session?.snapshot) {
    if (session?.error) {
      return {
        rows: [synchronizationErrorRow(sessionID, session.error)],
        emptyText: undefined,
      };
    }
    return { rows: [], emptyText: "Loading session…" };
  }

  const rows = rowsFromSessionState(session);
  if (
    session.running &&
    !rows.some((row) => row.kind === "assistant" && row.state === "streaming")
  ) {
    rows.push({
      id: `assistant:activity:${sessionID}`,
      kind: "assistant",
      label: "assistant",
      text: "",
      state: "streaming",
    });
  }
  if (
    session.error &&
    !rows.some((row) => row.kind === "error" && row.text === session.error?.message)
  ) {
    rows.push(synchronizationErrorRow(sessionID, session.error));
  }

  return {
    rows,
    emptyText:
      rows.length === 0
        ? "No messages yet. Tab to the composer and send one."
        : undefined,
  };
}

export function rowsFromSessionState(
  session: SessionSynchronization | undefined,
): TranscriptRow[] {
  if (!session?.snapshot) return [];
  let rows = rowsFromSnapshot(session.snapshot);
  for (const { event } of session.events) {
    rows = rowsAfterEvent(rows, event);
  }
  return rows;
}

export function rowsFromSnapshot(snapshot: SessionSnapshot): TranscriptRow[] {
  return snapshot.view.transcript.map((entry): TranscriptRow => {
    if (entry.kind === "user") {
      return { id: entry.id, kind: "user", label: "you", text: entry.text };
    }
    if (entry.kind === "assistant") {
      return {
        id: entry.id,
        kind: "assistant",
        label: assistantLabel(entry.status),
        text: entry.text,
        state: entry.status,
      };
    }
    if (entry.kind === "tool") {
      return {
        id: entry.id,
        kind: "tool",
        label: `tool · ${entry.name}`,
        text:
          entry.outcome === "running"
            ? "running"
            : `${entry.outcome}${entry.output ? ` · ${entry.output}` : ""}`,
      };
    }
    return {
      id: entry.id,
      kind: entry.kind,
      label: entry.kind === "error" ? "error" : "interrupted",
      text: entry.text,
    };
  });
}

export function rowsAfterEvent(
  current: readonly TranscriptRow[],
  event: HarnessEvent,
): TranscriptRow[] {
  if (event.type === "message.delta") {
    const id = `assistant:${event.stepID}`;
    const previous = current.find(
      (row): row is Extract<TranscriptRow, { kind: "assistant" }> =>
        row.id === id && row.kind === "assistant",
    );
    if (previous?.state === "complete") return [...current];
    return upsert(current, {
      id,
      kind: "assistant",
      label: previous?.label ?? "assistant",
      text: (previous?.text ?? "") + event.delta,
      state: previous?.state ?? "streaming",
    });
  }
  if (event.type === "tool.started") {
    return upsert(current, {
      id: `tool:${event.callID}`,
      kind: "tool",
      label: `tool · ${event.name}`,
      text: "running",
    });
  }
  if (event.type === "tool.completed") {
    return upsert(current, {
      id: `tool:${event.callID}`,
      kind: "tool",
      label: `tool · ${event.name}`,
      text: event.outcome,
    });
  }
  if (event.type === "permission.requested") {
    return upsert(current, {
      id: `permission:${event.requestID}`,
      kind: "system",
      label: "permission",
      text: `${event.toolName} ${event.argumentsJSON}`,
    });
  }
  if (
    event.type === "session.error" ||
    event.type === "session.recovery-required"
  ) {
    return upsert(current, {
      id: `error:session:${event.sessionID}`,
      kind: "error",
      label: "error",
      text: event.message,
    });
  }
  return [...current];
}

export function noticeAfterEvent(event: HarnessEvent): string | undefined {
  if (
    event.type === "session.error" ||
    event.type === "session.recovery-required"
  ) return event.message;
  if (
    event.type === "session.updated" &&
    event.change === "run-finished"
  ) {
    return "Ready";
  }
  return;
}

export function upsert(
  rows: readonly TranscriptRow[],
  replacement: TranscriptRow,
): TranscriptRow[] {
  const index = rows.findIndex((row) => row.id === replacement.id);
  if (index === -1) return [...rows, replacement];
  return rows.map((row, candidate) =>
    candidate === index ? replacement : row,
  );
}

function assistantLabel(state: AssistantState): string {
  return state === "complete" || state === "streaming"
    ? "assistant"
    : `assistant · ${state}`;
}

function synchronizationErrorRow(
  sessionID: string,
  error: Error,
): TranscriptRow {
  return {
    id: `error:synchronization:${sessionID}`,
    kind: "error",
    label: "error",
    text: error.message,
  };
}
