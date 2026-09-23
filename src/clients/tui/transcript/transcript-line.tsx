/** @jsxImportSource @opentui/react */

import { accentRailBorderCharacters, colors } from "../theme.ts";
import { MathMarkdown } from "./math-markdown.tsx";
import { createSyntaxStyle } from "./syntax/theme.ts";
import type { TranscriptRow } from "./transcript-presentation.ts";

const markdownStyle = createSyntaxStyle(colors);

export function TranscriptLine({ row }: { row: TranscriptRow }) {
  if (row.kind === "user") {
    return (
      <box
        border={["left"]}
        borderStyle="heavy"
        customBorderChars={accentRailBorderCharacters}
        borderColor={colors.composer}
        style={{
          width: "100%",
          flexDirection: "column",
          marginBottom: 1,
          paddingLeft: 1,
        }}
      >
        <text fg={colors.text} wrapMode="word">
          {row.text}
        </text>
      </box>
    );
  }

  if (row.kind === "assistant") {
    return (
      <box
        backgroundColor={colors.surface}
        style={{
          flexDirection: "column",
          marginBottom: 1,
          paddingLeft: 2,
          paddingY: 1,
        }}
      >
        {row.text ? (
          <MathMarkdown
            content={row.text}
            syntaxStyle={markdownStyle}
            streaming={row.state === "streaming"}
            foregroundColor={colors.text}
            backgroundColor={colors.surface}
          />
        ) : (
          <text fg={colors.muted}>…</text>
        )}
      </box>
    );
  }

  const color =
    row.kind === "tool"
      ? colors.tool
      : row.kind === "error"
        ? colors.error
        : colors.muted;

  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <text fg={color}>{row.label}</text>
      <text fg={colors.text} wrapMode="word">
        {row.text}
      </text>
    </box>
  );
}
