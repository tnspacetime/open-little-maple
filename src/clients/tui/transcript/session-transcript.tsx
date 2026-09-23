/** @jsxImportSource @opentui/react */

import { useMemo } from "react";

import { useSessionState } from "../../use-session-state.ts";
import { colors } from "../theme.ts";
import { presentSessionTranscript } from "./transcript-presentation.ts";
import { TranscriptLine } from "./transcript-line.tsx";

export function SessionTranscript({
  sessionID,
  focused,
  onFocus,
}: {
  sessionID: string | undefined;
  focused: boolean;
  onFocus(): void;
}) {
  const session = useSessionState(sessionID);
  const presentation = useMemo(
    () => presentSessionTranscript(sessionID, session),
    [sessionID, session],
  );

  return (
    <scrollbox
      focused={focused}
      onMouseDown={onFocus}
      stickyScroll
      stickyStart="bottom"
      style={{ flexGrow: 1, minHeight: 0, paddingY: 1 }}
    >
      {presentation.rows.length === 0 ? (
        <text fg={colors.muted} wrapMode="word">
          {presentation.emptyText}
        </text>
      ) : (
        presentation.rows.map((row) => (
          <TranscriptLine key={row.id} row={row} />
        ))
      )}
    </scrollbox>
  );
}
