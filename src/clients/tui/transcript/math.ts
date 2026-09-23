import { renderLatexToString } from "opentui-math";

export type MarkdownBlock = {
  kind: "markdown";
  source: string;
};

export type MathBlock = {
  kind: "math";
  source: string;
};

export type TranscriptBlock = MarkdownBlock | MathBlock;

const mathFenceLanguages = new Set(["latex", "math", "tex"]);

type DelimitedMath = {
  display: boolean;
  end: number;
  raw: string;
  source: string;
};

type Fence = {
  end: number;
  raw: string;
  mathSource?: string;
};

/**
 * Prepare streamed assistant text for OpenTUI Markdown.
 *
 * Inline formulas become Unicode inside the Markdown source. Display formulas
 * become separate blocks for the existing streaming math renderable. Code spans
 * and fenced code are copied without looking for math inside them.
 */
export function splitTranscriptBlocks(
  content: string,
  streaming: boolean,
): TranscriptBlock[] {
  if (!content) return [];

  const blocks: TranscriptBlock[] = [];
  let markdown = "";
  let index = 0;

  const flushMarkdown = () => {
    if (!markdown) return;
    blocks.push({ kind: "markdown", source: markdown });
    markdown = "";
  };

  const appendMath = (math: DelimitedMath) => {
    const source = math.source.trim();
    if (!source) {
      markdown += math.raw;
      return;
    }

    if (!math.display) {
      markdown += renderInlineMath(source, math.raw);
      return;
    }

    flushMarkdown();
    blocks.push({ kind: "math", source });
  };

  while (index < content.length) {
    if (isLineStart(content, index)) {
      const fence = readFence(content, index, streaming);
      if (fence) {
        if (fence.mathSource?.trim()) {
          flushMarkdown();
          blocks.push({ kind: "math", source: fence.mathSource.trim() });
        } else {
          markdown += fence.raw;
        }
        index = fence.end;
        continue;
      }
    }

    if (content[index] === "`" && !isEscaped(content, index)) {
      const codeEnd = findInlineCodeEnd(content, index);
      if (codeEnd < 0) {
        markdown += content.slice(index);
        break;
      }
      markdown += content.slice(index, codeEnd);
      index = codeEnd;
      continue;
    }

    const bracketMath = readBracketMath(content, index, streaming);
    if (bracketMath) {
      appendMath(bracketMath);
      index = bracketMath.end;
      continue;
    }

    const dollarMath = readDollarMath(content, index, streaming);
    if (dollarMath) {
      appendMath(dollarMath);
      index = dollarMath.end;
      continue;
    }

    markdown += content[index];
    index += 1;
  }

  flushMarkdown();
  return blocks;
}

function renderInlineMath(source: string, fallback: string): string {
  try {
    return renderLatexToString(source, { displayMode: false });
  } catch {
    return fallback;
  }
}

function readBracketMath(
  content: string,
  start: number,
  streaming: boolean,
): DelimitedMath | undefined {
  if (
    content[start] !== "\\" ||
    (content[start + 1] !== "(" && content[start + 1] !== "[") ||
    isEscaped(content, start)
  ) {
    return undefined;
  }

  const display = content[start + 1] === "[";
  const close = display ? "\\]" : "\\)";
  const closeStart = findUnescapedDelimiter(
    content,
    close,
    start + 2,
    display,
  );

  if (closeStart >= 0) {
    const end = closeStart + close.length;
    return {
      display,
      end,
      raw: content.slice(start, end),
      source: content.slice(start + 2, closeStart),
    };
  }

  if (!display || !streaming) return undefined;
  return {
    display: true,
    end: content.length,
    raw: content.slice(start),
    source: content.slice(start + 2),
  };
}

function readDollarMath(
  content: string,
  start: number,
  streaming: boolean,
): DelimitedMath | undefined {
  if (content[start] !== "$" || isEscaped(content, start)) return undefined;

  if (content[start + 1] === "$") {
    if (content.slice(lineStart(content, start), start).trim()) return undefined;

    const closeStart = findUnescapedDelimiter(content, "$$", start + 2, true);
    if (closeStart >= 0) {
      const end = closeStart + 2;
      return {
        display: true,
        end,
        raw: content.slice(start, end),
        source: content.slice(start + 2, closeStart),
      };
    }

    if (!streaming) return undefined;
    return {
      display: true,
      end: content.length,
      raw: content.slice(start),
      source: content.slice(start + 2),
    };
  }

  const first = content[start + 1] ?? "";
  if (!first || /[\s\d]/.test(first)) return undefined;

  const lineEnd = content.indexOf("\n", start + 1);
  const limit = lineEnd < 0 ? content.length : lineEnd;
  let searchFrom = start + 1;
  while (searchFrom < limit) {
    const closeStart = content.indexOf("$", searchFrom);
    if (closeStart < 0 || closeStart >= limit) return undefined;
    if (
      !isEscaped(content, closeStart) &&
      content[closeStart + 1] !== "$" &&
      !/\s/.test(content[closeStart - 1] ?? "")
    ) {
      const end = closeStart + 1;
      return {
        display: false,
        end,
        raw: content.slice(start, end),
        source: content.slice(start + 1, closeStart),
      };
    }
    searchFrom = closeStart + 1;
  }

  return undefined;
}

function readFence(
  content: string,
  start: number,
  streaming: boolean,
): Fence | undefined {
  const headerEnd = endOfLine(content, start);
  const header = content.slice(start, headerEnd);
  const match = header.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
  if (!match) return undefined;

  const marker = match[1]!;
  const markerCharacter = marker[0]!;
  const language = (match[2] ?? "").trim().split(/\s+/, 1)[0]?.toLowerCase();
  const bodyStart = headerEnd < content.length ? headerEnd + 1 : headerEnd;
  let closeStart = bodyStart;

  while (closeStart < content.length) {
    const closeEnd = endOfLine(content, closeStart);
    const line = content.slice(closeStart, closeEnd);
    if (isClosingFence(line, markerCharacter, marker.length)) {
      const end = closeEnd;
      const raw = content.slice(start, end);
      if (!language || !mathFenceLanguages.has(language)) {
        return { end, raw };
      }
      return {
        end,
        raw,
        mathSource: content.slice(bodyStart, closeStart).trim(),
      };
    }
    closeStart = closeEnd < content.length ? closeEnd + 1 : content.length;
  }

  const raw = content.slice(start);
  if (!streaming || !language || !mathFenceLanguages.has(language)) {
    return { end: content.length, raw };
  }
  return {
    end: content.length,
    raw,
    mathSource: content.slice(bodyStart).trim(),
  };
}

function isClosingFence(
  line: string,
  markerCharacter: string,
  minimumLength: number,
): boolean {
  const trimmed = line.trim();
  if (trimmed.length < minimumLength) return false;
  for (const character of trimmed) {
    if (character !== markerCharacter) return false;
  }
  return true;
}

function findInlineCodeEnd(content: string, start: number): number {
  let count = 1;
  while (content[start + count] === "`") count += 1;
  const marker = "`".repeat(count);
  const closeStart = content.indexOf(marker, start + count);
  return closeStart < 0 ? -1 : closeStart + count;
}

function findUnescapedDelimiter(
  content: string,
  delimiter: string,
  start: number,
  allowNewline: boolean,
): number {
  const lineEnd = allowNewline ? content.length : endOfLine(content, start);
  let searchFrom = start;

  while (searchFrom < lineEnd) {
    const found = content.indexOf(delimiter, searchFrom);
    if (found < 0 || found >= lineEnd) return -1;
    if (!isEscaped(content, found)) return found;
    searchFrom = found + delimiter.length;
  }

  return -1;
}

function isEscaped(content: string, index: number): boolean {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && content[cursor] === "\\";
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isLineStart(content: string, index: number): boolean {
  return index === 0 || content[index - 1] === "\n";
}

function lineStart(content: string, index: number): number {
  return content.lastIndexOf("\n", index - 1) + 1;
}

function endOfLine(content: string, start: number): number {
  const end = content.indexOf("\n", start);
  return end < 0 ? content.length : end;
}
