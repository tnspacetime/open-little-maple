/** @jsxImportSource @opentui/react */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { registerLatex } from "opentui-math/react";

import {
  connectHarnessClient,
  type HarnessClient,
} from "../harness-client.ts";
import {
  defaultDaemonStateDirectory,
  discoverDaemon,
} from "../../daemon/discovery.ts";
import { Tui } from "./app.tsx";
import { colors } from "./theme.ts";
import { registerSyntaxParsers } from "./transcript/syntax/parsers.ts";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function main(): Promise<void> {
  registerSyntaxParsers();
  registerLatex();

  let client: HarnessClient;
  try {
    const stateDirectory =
      process.env.LITTLE_MAPLE_STATE_DIR ?? defaultDaemonStateDirectory();
    client = await connectHarnessClient(() =>
      discoverDaemon(stateDirectory, "little-maple"),
    );
  } catch (cause) {
    console.error(`Little Maple TUI could not connect: ${errorMessage(cause)}`);
    console.error("Start the daemon with `npm run daemon`, then try again.");
    process.exitCode = 1;
    return;
  }

  let closing = false;
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    backgroundColor: colors.background,
    onDestroy: () => void client.close(),
  });
  const quit = () => {
    if (closing) return;
    closing = true;
    void client.close().finally(() => renderer.destroy());
  };
  createRoot(renderer).render(<Tui client={client} quit={quit} />);
}

await main();
