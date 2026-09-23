# Little Maple

Little Maple gives an agent a durable Session: prompts, model output, Tool outcomes, and the services selected to produce them are recorded together. A loopback daemon runs the Harness and owns SQLite state; an OpenTUI client shows live output and reconnects to the same Sessions. The current runtime uses the OpenAI Responses API.

## Design

An in-process agent loop can keep its model, tools, policy, and working directory in mutable runner settings. Little Maple records the chosen services in the Session instead. Each **Turn** resolves that selection once; every model **Step** and Tool call in the Turn uses the same configuration.

- **Turn services.** Plugins register live `Provider`, `Tool`, `ToolCallRule`, `Location`, and `HistoryTranslator` implementations. The Session records each choice's identity, revision, and settings; the Turn holds the matching live implementations. A restart must resolve the recorded selection rather than substitute a different service.
- **Location as a service.** Repository access comes from an explicitly selected `Location`, not the daemon's current directory. `ToolCallRule` policies authorize each requested Tool call and can narrow the Location visible to it.
- **Branches of the full Session.** A branch inherits an exact prefix of Session facts, including its service selection, then writes its own suffix. Later prompts or configuration changes in the parent do not enter the branch.
- **Recorded effect boundaries.** The Harness commits a Step or Tool call before invoking external work and records the outcome afterward. If the outcome is lost, the invocation needs explicit recovery rather than an automatic repeat.

The daemon exposes authenticated local commands and live events. SQLite facts and projections are the source of truth; the TUI is a client of that state.

## Run

Requires Node.js 22 or later and Bun 1.x.

```bash
bun install
cp .env.example .env
# Add your OPENAI_API_KEY to .env
npm run daemon
```

In another terminal:

```bash
npm run tui
```

Select **Add session**, type a prompt, and press Enter. Use `Ctrl+J` for a newline. `Tab` moves focus, `Ctrl+R` refreshes the Session list, and `Ctrl+C` closes the TUI. `Ctrl+U` resumes a paused Session. Closing the TUI does not stop the daemon.

`OPENAI_MODEL` defaults to `gpt-5.6-luna`; `OPENAI_BASE_URL` can point the Responses adapter at a compatible endpoint. State lives in `~/.little-maple` by default. Set `LITTLE_MAPLE_STATE_DIR` to move it, or `LITTLE_MAPLE_DATABASE` to choose the SQLite file.

## Current scope

The daemon currently installs the OpenAI Responses `Provider`. New Sessions select that Provider but no repository `Location`, `Tool`, or `ToolCallRule`. The Harness supports those service kinds and branching; the daemon API exposes branches. Repository selection and branch creation are not yet available in the TUI.

After a daemon restart, queued or active work stays paused until explicitly resumed. A committed Provider or Tool invocation with no recorded outcome is shown as requiring recovery and is not silently retried.

## Development

```bash
npm run check
```

This runs the TypeScript check.

Little Maple is licensed under [MIT](LICENSE).
