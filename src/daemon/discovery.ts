import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const daemonProtocolVersion = 5;
export const daemonHost = "127.0.0.1";
export const daemonDiscoveryFile = "daemon.json";

export type DaemonDiscovery = {
  protocolVersion: typeof daemonProtocolVersion;
  harnessID: string;
  pid: number;
  origin: string;
  secret: string;
  streamID: string;
  startedAt: number;
};

export function defaultDaemonStateDirectory(): string {
  return join(homedir(), ".little-maple");
}

export async function discoverDaemon(
  stateDirectory = defaultDaemonStateDirectory(),
  expectedHarnessID?: string,
): Promise<DaemonDiscovery | undefined> {
  const discovery = await readDiscovery(stateDirectory);
  if (!discovery) return;
  try {
    const response = await fetch(new URL("/health", discovery.origin), {
      headers: { Authorization: `Bearer ${discovery.secret}` },
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return;
    const health = (await response.json()) as {
      pid?: number;
      harnessID?: string;
      cursor?: { streamID?: string };
    };
    return health.pid === discovery.pid &&
      health.harnessID === discovery.harnessID &&
      (expectedHarnessID === undefined ||
        discovery.harnessID === expectedHarnessID) &&
      health.cursor?.streamID === discovery.streamID
      ? discovery
      : undefined;
  } catch {
    return;
  }
}

async function readDiscovery(
  stateDirectory: string,
): Promise<DaemonDiscovery | undefined> {
  try {
    const value = JSON.parse(
      await readFile(join(stateDirectory, daemonDiscoveryFile), "utf8"),
    ) as Partial<DaemonDiscovery>;
    return value.protocolVersion === daemonProtocolVersion &&
      typeof value.harnessID === "string" &&
      typeof value.pid === "number" &&
      typeof value.origin === "string" &&
      typeof value.secret === "string" &&
      typeof value.streamID === "string" &&
      typeof value.startedAt === "number"
      ? (value as DaemonDiscovery)
      : undefined;
  } catch {
    return;
  }
}
