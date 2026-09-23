import { useCallback, useEffect, useState } from "react";

import type {
  HarnessClient,
  HarnessClientStatus,
} from "../../harness-client.ts";
import type { SessionSummary } from "../../../daemon/protocol.ts";

export type SessionCatalog = {
  connection: HarnessClientStatus;
  sessions: readonly SessionSummary[];
  selectedSessionID: string | undefined;
  notice: string;
  select(sessionID: string | undefined): void;
  refresh(preferredSessionID?: string): Promise<void>;
  createSession(): Promise<string | undefined>;
};

export function useSessionCatalog(client: HarnessClient): SessionCatalog {
  const [connection, setConnection] = useState<HarnessClientStatus>(
    client.status(),
  );
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionID, setSelectedSessionID] = useState<string>();
  const [notice, setNotice] = useState("Discovering sessions…");

  const refresh = useCallback(
    async (preferredSessionID?: string) => {
      try {
        const response = await client.listSessions();
        setSessions([...response.sessions]);
        setSelectedSessionID((current) => {
          const preferred = response.sessions.find(
            (session) => session.id === preferredSessionID,
          );
          if (preferred) return preferred.id;
          if (response.sessions.some((session) => session.id === current)) {
            return current;
          }
          return response.sessions[0]?.id;
        });
        setNotice(
          response.sessions.length === 0
            ? "No sessions yet."
            : `${response.sessions.length} session${response.sessions.length === 1 ? "" : "s"}`,
        );
      } catch (cause) {
        setNotice(errorMessage(cause));
      }
    },
    [client],
  );

  const createSession = useCallback(async (): Promise<string | undefined> => {
    setNotice("Creating session…");
    try {
      const created = await client.createSession();
      await refresh(created.session.id);
      return created.session.id;
    } catch (cause) {
      setNotice(errorMessage(cause));
      return undefined;
    }
  }, [client, refresh]);

  useEffect(() => {
    void refresh();
    return client.subscribe((notification) => {
      if (notification.type === "connection") {
        setConnection(notification.status);
        if (notification.error) setNotice(notification.error.message);
        return;
      }
      if (
        notification.type === "event" &&
        notification.envelope.event.type === "session.created"
      ) {
        void refresh(notification.envelope.event.session.id);
        return;
      }
      if (
        notification.type === "event" &&
        notification.envelope.event.type === "session.updated" &&
        notification.envelope.event.change !== "other"
      ) {
        void refresh();
      }
    });
  }, [client, refresh]);

  return {
    connection,
    sessions,
    selectedSessionID,
    notice,
    select: setSelectedSessionID,
    refresh,
    createSession,
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
