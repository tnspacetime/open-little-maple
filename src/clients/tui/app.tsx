/** @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { HarnessClient } from "../harness-client.ts";
import { SessionClientStore } from "../session-client-store.ts";
import { SessionStateProvider } from "../use-session-state.ts";
import { SessionComposer } from "./composer/session-composer.tsx";
import { SessionActionBar } from "./session-action-bar.tsx";
import { SessionSidebar } from "./sidebar/session-sidebar.tsx";
import { useSessionCatalog } from "./sidebar/use-session-catalog.ts";
import { colors } from "./theme.ts";
import { SessionTranscript } from "./transcript/session-transcript.tsx";

type Focus = "sessions" | "transcript" | "composer";

export function Tui({
  client,
  quit,
}: {
  client: HarnessClient;
  quit(): void;
}) {
  const sessionStore = useMemo(
    () => new SessionClientStore(client),
    [client],
  );
  useEffect(() => () => sessionStore.close(), [sessionStore]);

  return (
    <SessionStateProvider store={sessionStore}>
      <TuiContent client={client} quit={quit} />
    </SessionStateProvider>
  );
}

function TuiContent({
  client,
  quit,
}: {
  client: HarnessClient;
  quit(): void;
}) {
  const catalog = useSessionCatalog(client);
  const [focus, setFocus] = useState<Focus>("composer");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [creatingSession, setCreatingSession] = useState(false);
  const creatingSessionRef = useRef<Promise<string | undefined> | undefined>(
    undefined,
  );

  const createSession = useCallback(() => {
    if (creatingSessionRef.current) return creatingSessionRef.current;
    const pending = (async () => {
      setCreatingSession(true);
      try {
        const sessionID = await catalog.createSession();
        if (sessionID) setFocus("composer");
        return sessionID;
      } finally {
        creatingSessionRef.current = undefined;
        setCreatingSession(false);
      }
    })();
    creatingSessionRef.current = pending;
    return pending;
  }, [catalog.createSession]);

  const toggleSidebar = useCallback(() => {
    if (sidebarVisible && focus === "sessions") setFocus("composer");
    setSidebarVisible((visible) => !visible);
  }, [focus, sidebarVisible]);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      quit();
      return;
    }
    if (key.ctrl && key.name === "r") {
      key.preventDefault();
      void catalog.refresh();
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      setFocus((current) => nextFocus(current, sidebarVisible));
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      setFocus(sidebarVisible ? "sessions" : "composer");
    }
  });

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: colors.background,
      }}
    >
      <box style={{ flexGrow: 1, minHeight: 0, flexDirection: "row" }}>
        {sidebarVisible ? (
          <SessionSidebar
            sessions={catalog.sessions}
            selectedSessionID={catalog.selectedSessionID}
            focused={focus === "sessions"}
            onFocus={() => setFocus("sessions")}
            onSelect={catalog.select}
          />
        ) : null}

        <box
          style={{
            flexGrow: 1,
            minWidth: 0,
            flexDirection: "column",
            gap: 1,
            padding: 1,
            backgroundColor: colors.background,
          }}
        >
          <SessionTranscript
            sessionID={catalog.selectedSessionID}
            focused={focus === "transcript"}
            onFocus={() => setFocus("transcript")}
          />

          <SessionActionBar
            sidebarVisible={sidebarVisible}
            creatingSession={creatingSession}
            onToggleSidebar={toggleSidebar}
            onCreateSession={() => {
              void createSession();
            }}
          />

          <SessionComposer
            sessionID={catalog.selectedSessionID}
            focused={focus === "composer"}
            onFocus={() => setFocus("composer")}
            onCreateSession={createSession}
          />
        </box>
      </box>

    </box>
  );
}

function nextFocus(focus: Focus, sidebarVisible: boolean): Focus {
  if (!sidebarVisible) {
    return focus === "composer" ? "transcript" : "composer";
  }
  if (focus === "sessions") return "transcript";
  if (focus === "transcript") return "composer";
  return "sessions";
}
