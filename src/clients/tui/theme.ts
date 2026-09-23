import { BorderChars } from "@opentui/core";

export const colors = {
  background: "#111318",
  surface: "#161920",
  panel: "#191c23",
  border: "#343946",
  focused: "#73a9ff",
  text: "#e7eaf0",
  muted: "#89909f",
  user: "#8bd5ca",
  assistant: "#c6a0f6",
  action: "#bf5af2",
  composer: "#f5a97f",
  tool: "#eed49f",
  error: "#ed8796",
  success: "#a6da95",
} as const;

export const accentRailBorderCharacters = {
  ...BorderChars.heavy,
  vertical: "▌",
};
