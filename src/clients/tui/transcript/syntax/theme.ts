import { SyntaxStyle, type ThemeTokenStyle } from "@opentui/core";

export type SyntaxPalette = {
  background: string;
  text: string;
  muted: string;
  focused: string;
  user: string;
  assistant: string;
  tool: string;
  error: string;
  success: string;
};

export function syntaxTheme(colors: SyntaxPalette): ThemeTokenStyle[] {
  const rule = (
    scope: string[],
    foreground: string,
    style: Omit<ThemeTokenStyle["style"], "foreground"> = {},
  ): ThemeTokenStyle => ({
    scope,
    style: { foreground, ...style },
  });

  return [
    rule(["default"], colors.text),
    rule(["comment", "comment.documentation"], colors.muted, {
      italic: true,
    }),
    rule(
      ["string", "symbol", "character", "character.special"],
      colors.user,
    ),
    rule(["number", "boolean", "constant", "float"], colors.tool),
    rule(
      [
        "keyword",
        "keyword.return",
        "keyword.conditional",
        "keyword.repeat",
        "keyword.coroutine",
        "keyword.directive",
        "keyword.modifier",
        "keyword.exception",
      ],
      colors.assistant,
      { italic: true },
    ),
    rule(
      ["keyword.import", "keyword.export", "string.escape", "string.regexp"],
      colors.assistant,
    ),
    rule(["keyword.type", "type.definition"], colors.tool, { bold: true }),
    rule(
      ["function", "function.call", "function.method", "constructor"],
      colors.focused,
    ),
    rule(
      ["type", "type.builtin", "module", "class", "namespace"],
      colors.tool,
    ),
    rule(
      ["variable", "variable.parameter", "property", "parameter", "field"],
      colors.text,
    ),
    rule(
      ["variable.builtin", "function.builtin", "constant.builtin"],
      colors.focused,
    ),
    rule(
      ["operator", "keyword.operator", "punctuation.special"],
      colors.assistant,
    ),
    rule(
      ["punctuation", "punctuation.bracket", "punctuation.delimiter"],
      colors.muted,
    ),
    rule(["attribute", "annotation"], colors.tool),
    rule(["tag", "tag.delimiter"], colors.error),
    rule(["markup.heading"], colors.assistant, { bold: true }),
    rule(["markup.heading.1"], colors.assistant, {
      bold: true,
      underline: true,
    }),
    rule(["markup.bold", "markup.strong"], colors.text, { bold: true }),
    rule(["markup.italic"], colors.text, { italic: true }),
    rule(["markup.list"], colors.tool),
    rule(["markup.quote"], colors.muted, { italic: true }),
    rule(["markup.raw", "markup.raw.block"], colors.user),
    rule(["markup.raw.inline"], colors.user, {
      background: colors.background,
    }),
    rule(
      ["markup.link", "markup.link.url", "string.special.url"],
      colors.focused,
      { underline: true },
    ),
    rule(["markup.link.label", "label"], colors.focused),
    rule(["markup.list.checked"], colors.success),
    rule(["markup.list.unchecked", "markup.strikethrough"], colors.muted),
    rule(["diff.plus"], colors.success),
    rule(["diff.minus"], colors.error),
    rule(["diff.delta"], colors.focused),
    rule(["error", "comment.error"], colors.error, { bold: true }),
    rule(["warning", "comment.warning"], colors.tool, { bold: true }),
  ];
}

export function createSyntaxStyle(colors: SyntaxPalette): SyntaxStyle {
  return SyntaxStyle.fromTheme(syntaxTheme(colors));
}
