import type { SessionSynchronization } from "../../session-client-store.ts";

export type ComposerPresentation = {
  placeholder: string;
  enabled: boolean;
  status: {
    label: string;
    animated: boolean;
  };
};

export function presentComposer(
  sessionID: string | undefined,
  session: SessionSynchronization | undefined,
): ComposerPresentation {
  if (!sessionID) {
    return {
      placeholder: "Create a session first",
      enabled: false,
      status: { label: "No session selected", animated: false },
    };
  }
  if (session?.snapshot?.execution.status === "recovery-required") {
    return {
      placeholder: "Ctrl+U retry recovery",
      enabled: false,
      status: { label: "Recovery required", animated: false },
    };
  }
  if (session?.snapshot?.execution.status === "paused") {
    return {
      placeholder: "Ctrl+U resume",
      enabled: false,
      status: { label: "Paused", animated: false },
    };
  }
  if (session?.phase === "error") {
    return {
      placeholder: "Retry your message…",
      enabled: true,
      status: { label: "Error", animated: false },
    };
  }
  if (!session?.snapshot) {
    return {
      placeholder: "Loading session…",
      enabled: true,
      status: { label: "Loading session", animated: false },
    };
  }
  if (session.running) {
    return {
      placeholder: "",
      enabled: true,
      status: { label: executionActivity(session), animated: true },
    };
  }
  return {
    placeholder: "",
    enabled: true,
    status: { label: "Ready", animated: false },
  };
}

function executionActivity(
  session: SessionSynchronization,
): "Thinking" | "Running tools" {
  const turn = session.snapshot?.state.turns.find(
    (candidate) => candidate.status === "active",
  );
  const step = turn?.steps.find((candidate) => candidate.status === "active");
  const runningTool =
    step?.providerInvocation.status !== "committed" &&
    step?.toolCalls.some(
      (tool) => tool.status === "requested" || tool.status === "committed",
    );
  return runningTool ? "Running tools" : "Thinking";
}
