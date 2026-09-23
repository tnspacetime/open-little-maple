---
title: Documentation
description: Turn configuration, Location and Tool authority, branching, and projection in Little Maple.
---

Little Maple configures an agent **Turn**, rather than specifying each model call separately. A Session records which services its next Turn should use. When a queued prompt starts that Turn, the Harness binds those services once. Tool results and steering prompts can lead to more model calls, but all of them run under the same selection. A **Step** is one actual `Provider.stream()` invocation, not a separate plan for one.

This changes where an agent's working context lives. A conventional runner can hold a model, Tools, policy, and working directory in process settings while its Session holds the transcript. Little Maple puts the *selection* of those capabilities into the Session's facts. The live implementations remain in the Plugin registry; the Turn captures the exact ones described by the facts.

## The Turn contract

Plugins register services that a Session can select. With repository services installed, configuration code can make a selection like this:

```ts
selection.include(Provider, "openai");
selection.include(Location, "repository");
selection.include(Tool, "read_file");
selection.include(ToolCallRule, "repository-policy");
```

`configureSessionTurnServices()` records the resulting `TurnServiceConfiguration` description as one Session fact. Each entry includes its `kind`, `key`, `revision`, `settings`, and `order`. The description contains every behavior-affecting setting needed to identify the service, while functions and connections stay live in the daemon.

At Turn start, `resolveTurnServiceConfiguration()` matches that description against a leased snapshot of the Plugin registry. The Turn keeps the lease through its Steps. A configuration change recorded while it runs becomes the selection for a later Turn; the active Turn retains its original contract. After a restart, a missing service or a mismatch in revision, settings, or order produces a resolution error rather than silently binding a different implementation.

## Location is selected, then scoped per call

In a workspace-bound Session, repository Tools often inherit one directory for the Session's lifetime. Little Maple selects `Location` as a Turn service, independently of the `Tool` and `Provider`. The Session can record another Location for a later Turn, and branches can diverge in their selection. The daemon's current directory is never an implicit repository grant.

```ts
context.provide(
  defineTurnService(
    Location,
    "repository",
    { uri: "file:///work/project" },
    { revision: "v1" },
  ),
);
```

A `Location` has a canonical, absolute, credential-free URI. The repository Tools require exactly one authorized `file:` Location when they execute. Selecting a Location gives the Turn a potential place to work; the Tool call receives only the resources left in its authorized scope.

## Tool exposure is separate from Tool authority

Selecting a `Tool` advertises its `name`, `description`, and `inputSchema` to the Provider. A Provider request to use it becomes `ToolCallRequested`; it does not invoke the Tool immediately. When `ToolCallRule` services are selected, each rule examines the requested Tool, exact arguments, and frozen Turn services before execution:

```ts
const repositoryPolicy: ToolCallRule = (call) =>
  call.tool.name === "read_file"
    ? { type: "allow", scope: [{ kind: Location.id, key: "repository" }] }
    : { type: "deny", reason: "Tool not allowed" };
```

A denial records `ToolCallRejected`. An authorization may name an upper bound on accessible resources; multiple rules intersect their bounds. After `ToolCallCommitted`, `Tool.execute()` receives a resolver restricted to that final scope. It cannot browse the entire registry through its execution context. If no rules are selected, Tool selection still controls which names the Provider can call, but there is no additional rule policy.

## A Step is the Provider invocation

Little Maple does not persist a Step specification that later has to be interpreted. `TurnExecutor` prepares the next `StepCommitted` fact and derives the `ProviderRequest` from the projected Session state and the Turn's frozen configuration:

```ts
const projected = projectSessionFact(state, fact, state.seq + 1);
const request = deriveProviderRequest(
  projected,
  configuration,
  turnId,
  stepId,
);
```

Only after both succeed does the Harness commit the Step and call `Provider.stream(request, signal)`. The first Step uses the queued prompt that started the Turn. Later Steps consume Tool results, steering prompts, or both. A steer joins at the next Step boundary; it does not replace the Turn's Provider, Tools, Location, or rules. A retry reconstructs the original request boundary, so later steers and output from a failed attempt do not enter the retried request.

The request also preserves Provider-native history. Completed output and Tool results are reconstructed from Session facts under the Provider's `historyFormat`. If a later Turn changes Provider format, continuation requires exactly one matching `HistoryTranslator`; foreign Provider IDs are not treated as native input to the new adapter.

## Branches inherit the full Session

Copying a chat transcript carries visible messages but can omit the configuration and Tool decisions that produced them. A Little Maple branch names an exact fact sequence in its parent:

```ts
await harness.createBranch("experiment", parentSessionId, 42);
```

The branch reads facts 1–42, including the service selection, Provider output, Tool-call commitments and settlements, and prompt history. It writes only its own suffix. Later parent facts never enter that branch; it can select a different Provider or Location for future Turns without changing the parent. Nested branches use the same inherited-prefix model.

## The projector is the protocol gate

Event-sourced systems commonly use projections to derive state from facts. Little Maple also runs `projectSessionFact(current, candidate, nextSeq)` **before** admitting a new fact. The pure function returns the next immutable Session state or rejects the transition with a structured error. It checks sequence order, entity identity, and lifecycle rules: a second Step cannot begin while one is active, a Tool call cannot settle before commitment, and a Turn cannot complete with unfinished work.

The `SessionStore` compares the expected head and applies that same projector in both its in-memory and SQLite implementations. SQLite appends the accepted fact and persists the changed projection in one transaction. Branch creation replays its inherited prefix through the same transition rules. The projector is a familiar event-sourcing technique; its specific role here is to make the agent protocol enforceable at the journal boundary, rather than leave lifecycle correctness to the runner's mutable control flow.

## Effects and recovery

The journal distinguishes a requested call, a committed external invocation, and its observed outcome:

**Provider**

- `StepCommitted` is followed by `Provider.stream()`.
- `ProviderOutput` records completed output items.
- `ProviderSettled` records the terminal result.

**Tool**

- `ToolCallRequested` is followed by selected `ToolCallRule` evaluation.
- `ToolCallCommitted` is written before `Tool.execute()`.
- `ToolCallSettled` records the terminal result.

If execution stops after commitment and before settlement, the outcome is unknown. Recovery requires an explicit decision instead of silently repeating the external call. Automatic Provider retry is limited to an explicitly retry-safe failure within budget when that Step made no Tool calls.

The Harness runs in a local daemon. SQLite stores the facts and projected state; live text deltas and Tool activity stream to clients, while reconnects read a fresh snapshot. The OpenTUI interface is a client of that state.

The current daemon installs the OpenAI Responses Provider. New Sessions select that Provider but no repository Location, Tool, or ToolCallRule yet. The Harness and daemon API support branching; the TUI does not yet expose repository selection or branch creation. [Browse the implementation](https://github.com/tnspacetime/open-little-maple).
