import { exec as execCallback } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { object, stringField } from "../harness/json.js";
import {
  Location,
  type Tool,
  type ToolExecutionContext,
} from "../harness/turn-service.js";

const exec = promisify(execCallback);
const maximumToolOutputCharacters = 200_000;

export const readRepositoryFileTool: Tool = Object.freeze({
  name: "read",
  description: "Read a UTF-8 file inside the authorized repository Location.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(value: unknown, context: ToolExecutionContext) {
    const input = object(value, "read arguments");
    const path = stringField(input, "path");
    const root = repositoryRoot(context);
    return clipped(
      await readFile(await readableRepositoryPath(root, path), {
        encoding: "utf8",
        signal: context.signal,
      }),
    );
  },
});

export const writeRepositoryFileTool: Tool = Object.freeze({
  name: "write",
  description:
    "Write a complete UTF-8 file inside the authorized repository Location.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(value: unknown, context: ToolExecutionContext) {
    const input = object(value, "write arguments");
    const path = stringField(input, "path");
    const content = stringField(input, "content");
    const root = repositoryRoot(context);
    const target = await writableRepositoryPath(root, path);
    const file = await open(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      0o666,
    );
    try {
      await file.writeFile(content, {
        encoding: "utf8",
        signal: context.signal,
      });
    } finally {
      await file.close();
    }
    return `Wrote ${Buffer.byteLength(content)} bytes to ${path}`;
  },
});

export const repositoryShellTool: Tool = Object.freeze({
  name: "bash",
  description:
    "Run a shell command with the authorized repository Location as cwd.",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
    additionalProperties: false,
  },
  async execute(value: unknown, context: ToolExecutionContext) {
    const input = object(value, "bash arguments");
    const command = stringField(input, "command");
    const result = await exec(command, {
      cwd: repositoryRoot(context),
      signal: context.signal,
      maxBuffer: 2 * 1024 * 1024,
    });
    return clipped(
      [result.stdout, result.stderr].filter(Boolean).join("\n") ||
        "(command produced no output)",
    );
  },
});

/** Resolve exactly one filesystem Location from this call's authorized scope. */
function repositoryRoot(context: ToolExecutionContext): string {
  const locations = context.services
    .entries(Location)
    .filter(({ value }) => new URL(value.uri).protocol === "file:");
  if (locations.length !== 1) {
    throw new Error(
      `Repository Tool requires exactly one authorized file Location, found ${locations.length}`,
    );
  }
  return fileURLToPath(locations[0]!.value.uri);
}

function lexicalRepositoryPath(root: string, requested: string): string {
  const path = resolve(root, requested);
  const rel = relative(root, path);
  const parentPrefix = process.platform === "win32" ? "..\\" : "../";
  if (rel === ".." || rel.startsWith(parentPrefix)) {
    throw new Error(`Path escapes repository root: ${requested}`);
  }
  return path;
}

async function readableRepositoryPath(
  root: string,
  requested: string,
): Promise<string> {
  const realRoot = await realpath(root);
  const target = await realpath(lexicalRepositoryPath(root, requested));
  return lexicalRepositoryPath(realRoot, target);
}

async function writableRepositoryPath(
  root: string,
  requested: string,
): Promise<string> {
  const realRoot = await realpath(root);
  const lexical = lexicalRepositoryPath(root, requested);
  let ancestor = dirname(lexical);

  while (true) {
    try {
      lexicalRepositoryPath(realRoot, await realpath(ancestor));
      break;
    } catch (cause) {
      const code =
        typeof cause === "object" && cause !== null && "code" in cause
          ? cause.code
          : undefined;
      if (code !== "ENOENT") throw cause;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw cause;
      ancestor = parent;
    }
  }

  await mkdir(dirname(lexical), { recursive: true });
  const realParent = await realpath(dirname(lexical));
  lexicalRepositoryPath(realRoot, realParent);
  return resolve(realParent, basename(lexical));
}

function clipped(value: string): string {
  if (value.length <= maximumToolOutputCharacters) return value;
  return `${value.slice(0, maximumToolOutputCharacters)}\n…(output clipped)`;
}
