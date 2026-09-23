/** @jsxImportSource @opentui/react */

import { colors } from "./theme.ts";

export function SessionActionBar({
  sidebarVisible,
  creatingSession,
  onToggleSidebar,
  onCreateSession,
}: {
  sidebarVisible: boolean;
  creatingSession: boolean;
  onToggleSidebar(): void;
  onCreateSession(): void;
}) {
  return (
    <box
      style={{
        width: "100%",
        height: 1,
        flexDirection: "row",
        flexShrink: 0,
        gap: 1,
        paddingLeft: 1,
      }}
    >
      <text
        onMouseUp={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggleSidebar();
        }}
      >
        <span style={{ fg: colors.action }}>
          {sidebarVisible ? "●" : "○"}
        </span>
        <span style={{ fg: colors.muted }}>{" Sessions"}</span>
      </text>

      <text
        onMouseUp={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!creatingSession) onCreateSession();
        }}
      >
        <span style={{ fg: colors.action }}>{creatingSession ? "…" : "+"}</span>
        <span style={{ fg: colors.muted }}>
          {creatingSession ? " Creating session" : " Add session"}
        </span>
      </text>
    </box>
  );
}
