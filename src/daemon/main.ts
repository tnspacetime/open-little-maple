import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { toNodeHandler } from "better-call/node";

import { createDaemonRouter } from "./api.ts";
import type { DaemonBackend } from "./backend.ts";
import {
  daemonDiscoveryFile,
  daemonHost,
  daemonProtocolVersion,
  defaultDaemonStateDirectory,
  discoverDaemon,
  type DaemonDiscovery,
} from "./discovery.ts";
import { HarnessEventHub } from "./events.ts";
import { openHarnessBackend } from "./harness-backend.ts";
import { BoundedEventBuffer, HarnessEventSse } from "./sse.ts";

const lockDirectory = "daemon.lock";
const harnessID = "little-maple";

export {
  daemonHost,
  daemonProtocolVersion,
  defaultDaemonStateDirectory,
  discoverDaemon,
  type DaemonDiscovery,
} from "./discovery.ts";

export type StartDaemonOptions = {
  stateDirectory?: string;
  databasePath?: string;
  port?: number;
  eventBufferCapacity?: number;
  heartbeatMilliseconds?: number;
  secret?: string;
  streamID?: string;
  environment?: NodeJS.ProcessEnv;
};

export type RunningDaemon = {
  discovery: DaemonDiscovery;
  backend: DaemonBackend;
  server: Server;
  events: HarnessEventSse;
  eventHub: HarnessEventHub;
  close(): Promise<void>;
};

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly discovery: DaemonDiscovery) {
    super(`Little Maple daemon is already running at ${discovery.origin}`);
    this.name = "DaemonAlreadyRunningError";
  }
}

export async function startOrDiscoverDaemon(
  options: StartDaemonOptions = {},
): Promise<
  | { type: "started"; daemon: RunningDaemon; discovery: DaemonDiscovery }
  | { type: "existing"; discovery: DaemonDiscovery }
> {
  try {
    const daemon = await startDaemon(options);
    return { type: "started", daemon, discovery: daemon.discovery };
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      return { type: "existing", discovery: error.discovery };
    }
    throw error;
  }
}

export async function startDaemon(
  options: StartDaemonOptions = {},
): Promise<RunningDaemon> {
  const stateDirectory = resolve(
    options.stateDirectory ?? defaultDaemonStateDirectory(),
  );
  const databasePath = resolve(
    options.databasePath ?? join(stateDirectory, "harness.sqlite"),
  );
  const secret = options.secret ?? randomBytes(32).toString("base64url");
  const streamID = options.streamID ?? randomUUID();
  const lock = await claimSingleton(stateDirectory, harnessID);

  let backend: DaemonBackend | undefined;
  let events: HarnessEventSse | undefined;
  let server: Server | undefined;
  try {
    const eventHub = new HarnessEventHub(streamID);
    backend = await openHarnessBackend({
      databasePath,
      eventHub,
      environment: options.environment ?? process.env,
    });

    events = new HarnessEventSse(
      new BoundedEventBuffer(
        eventHub,
        options.eventBufferCapacity,
      ),
      secret,
      options.heartbeatMilliseconds,
    );
    const router = createDaemonRouter({
      backend,
      eventHub,
      secret,
    });
    const api = toNodeHandler(router.handler);
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", `http://${daemonHost}`).pathname;
      if (path === "/events" && request.method === "GET") {
        events?.handle(request, response);
        return;
      }
      void api(request, response);
    });
    await listen(server, options.port ?? 0);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Daemon did not receive a TCP address");
    }

    const discovery: DaemonDiscovery = {
      protocolVersion: daemonProtocolVersion,
      harnessID,
      pid: process.pid,
      origin: `http://${daemonHost}:${address.port}`,
      secret,
      streamID,
      startedAt: Date.now(),
    };
    await writeFile(
      join(stateDirectory, daemonDiscoveryFile),
      `${JSON.stringify(discovery)}\n`,
      { mode: 0o600 },
    );

    let closing: Promise<void> | undefined;
    return {
      discovery,
      backend,
      server,
      events,
      eventHub,
      close() {
        closing ??= (async () => {
          events?.close();
          server?.closeIdleConnections();
          if (server?.listening) await closeServer(server);
          await backend?.close();
          await lock.release();
        })();
        return closing;
      },
    };
  } catch (error) {
    events?.close();
    server?.closeIdleConnections();
    if (server?.listening) await closeServer(server).catch(() => undefined);
    await backend?.close().catch(() => undefined);
    await lock.release();
    throw error;
  }
}

async function claimSingleton(
  stateDirectory: string,
  harnessID: string,
): Promise<{ release(): Promise<void> }> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDirectory, lockDirectory);
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    const running = await waitForDaemon(stateDirectory, harnessID);
    if (running) throw new DaemonAlreadyRunningError(running);
    const ownerPID = await readOwnerPID(lockPath);
    if (ownerPID && processIsAlive(ownerPID)) {
      throw new Error(`Daemon process ${ownerPID} owns the singleton`);
    }
    await rm(join(stateDirectory, daemonDiscoveryFile), { force: true });
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath, { mode: 0o700 });
  }

  try {
    await writeFile(join(lockPath, "owner"), String(process.pid), {
      mode: 0o600,
    });
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
  return {
    async release() {
      await rm(join(stateDirectory, daemonDiscoveryFile), { force: true });
      await rm(lockPath, { recursive: true, force: true });
    },
  };
}

async function waitForDaemon(
  stateDirectory: string,
  harnessID: string,
): Promise<DaemonDiscovery | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const daemon = await discoverDaemon(stateDirectory, harnessID);
    if (daemon) return daemon;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  return;
}

async function readOwnerPID(lockPath: string): Promise<number | undefined> {
  try {
    const pid = Number(await readFile(join(lockPath, "owner"), "utf8"));
    return Number.isSafeInteger(pid) ? pid : undefined;
  } catch {
    return;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, daemonHost, () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function runDaemonProcess(): Promise<void> {
  const port = process.env.LITTLE_MAPLE_PORT;
  const stateDirectory =
    process.env.LITTLE_MAPLE_STATE_DIR ?? defaultDaemonStateDirectory();
  const result = await startOrDiscoverDaemon({
    stateDirectory,
    ...(process.env.LITTLE_MAPLE_DATABASE
      ? { databasePath: process.env.LITTLE_MAPLE_DATABASE }
      : {}),
    ...(port ? { port: Number(port) } : {}),
  });
  console.log(JSON.stringify(result.discovery));
  if (result.type === "existing") return;
  const close = (): void => {
    void result.daemon.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runDaemonProcess().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
