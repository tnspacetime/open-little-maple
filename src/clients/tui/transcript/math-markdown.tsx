/** @jsxImportSource @opentui/react */

import type { SyntaxStyle } from "@opentui/core";
import {
  completeLatexPrefix,
  type LatexRenderable,
  LatexStreamController,
} from "opentui-math";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { splitTranscriptBlocks } from "./math.ts";

export function MathMarkdown({
  content,
  streaming,
  syntaxStyle,
  foregroundColor,
  backgroundColor,
}: {
  content: string;
  streaming: boolean;
  syntaxStyle: SyntaxStyle;
  foregroundColor: string;
  backgroundColor: string;
}) {
  const blocks = useMemo(
    () => splitTranscriptBlocks(content, streaming),
    [content, streaming],
  );

  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      {blocks.map((block, index) =>
        block.kind === "math" ? (
          <StreamingMath
            key={`math:${index}`}
            source={block.source}
            streaming={streaming}
            foregroundColor={foregroundColor}
          />
        ) : (
          <markdown
            key={`markdown:${index}`}
            content={block.source}
            syntaxStyle={syntaxStyle}
            streaming={streaming}
            internalBlockMode="top-level"
            tableOptions={{ style: "grid" }}
            conceal
            fg={foregroundColor}
            bg={backgroundColor}
          />
        ),
      )}
    </box>
  );
}

function StreamingMath({
  source,
  streaming,
  foregroundColor,
}: {
  source: string;
  streaming: boolean;
  foregroundColor: string;
}) {
  const controller = useRef<
    LatexStreamController<LatexRenderable> | undefined
  >(undefined);
  const sourceRef = useRef(source);
  const streamingRef = useRef(streaming);
  sourceRef.current = source;
  streamingRef.current = streaming;

  const update = useCallback(
    (
      stream: LatexStreamController<LatexRenderable>,
      nextSource: string,
      isStreaming: boolean,
    ) => {
      if (stream.isFinished) return;
      stream.replace(nextSource);
      if (!isStreaming) void stream.finish();
    },
    [],
  );

  const attach = useCallback(
    (formula: LatexRenderable | null) => {
      controller.current?.dispose();
      controller.current = undefined;
      if (!formula) return;

      const stream = new LatexStreamController(formula, {
        updateIntervalMs: 80,
        validationOptions: { strict: true },
        preview: completeLatexPrefix,
      });
      controller.current = stream;
      update(stream, sourceRef.current, streamingRef.current);
    },
    [update],
  );

  useEffect(() => {
    const stream = controller.current;
    if (stream) update(stream, source, streaming);
  }, [source, streaming, update]);

  useEffect(
    () => () => {
      controller.current?.dispose();
      controller.current = undefined;
    },
    [],
  );

  return (
    <latex
      ref={attach}
      content=""
      fallback="source"
      foregroundColor={foregroundColor}
      displayMode
    />
  );
}
