/** @jsxImportSource @opentui/react */

import type { SelectOption } from "@opentui/core";
import { useMemo } from "react";

import type { SessionSummary } from "../../../daemon/protocol.ts";
import { colors } from "../theme.ts";

export function SessionSidebar({
  sessions,
  selectedSessionID,
  focused,
  onFocus,
  onSelect,
}: {
  sessions: readonly SessionSummary[];
  selectedSessionID: string | undefined;
  focused: boolean;
  onFocus(): void;
  onSelect(sessionID: string): void;
}) {
  const options = useMemo<SelectOption[]>(
    () =>
      sessions.map((session) => ({
        name: session.id,
        description: `${session.activity} · seq ${session.headSeq}`,
        value: session.id,
      })),
    [sessions],
  );
  const selectedIndex = Math.max(
    0,
    sessions.findIndex((session) => session.id === selectedSessionID),
  );

  return (
    <box
      onMouseDown={onFocus}
      style={{
        width: "28%",
        minWidth: 24,
        height: "100%",
        flexShrink: 0,
        padding: 1,
        backgroundColor: colors.panel,
      }}
    >
      {sessions.length === 0 ? (
        <text fg={colors.muted} wrapMode="word">
          No sessions yet.
        </text>
      ) : (
        <select
          options={options}
          selectedIndex={selectedIndex}
          focused={focused}
          showDescription
          showScrollIndicator
          showSelectionIndicator
          wrapSelection
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          selectedBackgroundColor="transparent"
          textColor={colors.text}
          focusedTextColor={colors.text}
          selectedTextColor={focused ? colors.composer : colors.text}
          descriptionColor={colors.muted}
          selectedDescriptionColor={colors.muted}
          onChange={(index) => {
            const session = sessions[index];
            if (session) onSelect(session.id);
          }}
          style={{ flexGrow: 1 }}
        />
      )}
    </box>
  );
}
