---
title: Documentation
description: Turn services, Locations, Tools, and branching in Little Maple.
---

In a typical in-process agent loop, the model adapter, tools, policy, and working directory live in runner settings. Little Maple makes their selection part of the Session's history. A `TurnServiceConfiguration` records which `Provider`, `Tool`, `ToolCallRule`, `Location`, and `HistoryTranslator` services a Turn can use. The Turn resolves them once and uses the same configuration through every model Step.

## Configuring a Turn

Plugins register live implementations; a Session records which ones its Turns should use. For a runtime with repository services installed, that selection looks like this:

```ts
selection.include(Provider, "openai");
selection.include(Location, "repository");
selection.include(Tool, "read_file");
selection.include(ToolCallRule, "repository-policy");
```

Rather than persist functions or re-read mutable process configuration on each model call, `TurnServiceSelection` records each service's `kind`, `key`, `revision`, `settings`, and `order`. `configureSessionTurnServices()` appends that selection to the Session. At Turn startup, `resolveTurnServiceConfiguration()` matches it to live implementations, and the Runner holds the registry lease until the Turn finishes. A Session configuration change applies to its next Turn, not to Steps already in progress.

SQLite stores the descriptions while functions and connections remain in the daemon. After a restart, Plugins register live services again and the Harness resolves the recorded selection against them. It reports a compatibility error if a selected implementation is missing or incompatible; it does not silently substitute another service.

## Location and Tool authority

Agent loops commonly let repository Tools inherit the process's current working directory. Little Maple makes **`Location` a selected service** instead. A Plugin can register a place with a canonical, absolute, credential-free URI:

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

The Session selects `Location` and `Tool` independently, then freezes both for the Turn. A repository Tool requires exactly one compatible, authorized `file:` Location. Starting the daemon inside a repository grants no implicit access to it.

In a simple tool loop, exposing a function to the model can also make it executable. Here the model sees a selected Tool's `name`, `description`, and `inputSchema`, but its request goes through `ToolCallRule` before execution. A rule can authorize the call and scope the Location it may see:

```ts
const repositoryPolicy: ToolCallRule = (call) =>
  call.tool.name === "read_file"
    ? { type: "allow", scope: [{ kind: Location.id, key: "repository" }] }
    : { type: "deny", reason: "Tool not allowed" };
```

Rules inspect the frozen Turn configuration. If several rules authorize a call, their scopes intersect. `Tool.execute()` receives only the resulting resource resolver, rather than the registry or the complete Turn configuration. The selected Location defines where the Turn can operate; each Tool call can be narrowed further.

## Turns and model Steps

An agent loop that binds services for each model call can change Tools between a call and its Tool-result continuation. Little Maple groups those calls into a **Turn**: a queued prompt starts one, and each `Provider.stream()` call is a **Step** within it. Tool results and steers can start later Steps without changing the Turn's selected services. A steer joins at the next Step boundary. `SessionCoordinator` schedules the Session, `SessionRunner` holds its Turn and registry lease, and `TurnExecutor` advances the Steps. One process-local runner owns a Session at a time.

A provider-agnostic chat transcript flattens Provider-specific response items. Little Maple keeps Provider-native history under its `historyFormat` identity. `deriveProviderRequest()` builds each request from recorded prompts, accepted output, Tool results, and the frozen configuration. If a later Turn selects a Provider with a different format, continuation requires exactly one matching `HistoryTranslator`; the new adapter does not receive foreign Provider IDs as if they were its own.

## Branching the configuration and history

Copying a transcript creates a new conversation but can leave out the configuration and Tool decisions that produced it. A Little Maple branch instead selects an exact fact sequence in a parent Session:

```ts
await harness.createBranch("experiment", parentSessionId, 42);
```

The new Session reads facts 1–42, including the service selection at that point, and writes a private suffix. Later parent prompts and configuration changes do not enter it. The branch can select a different `Provider` or `Location` for future Turns without changing the parent. Nested branches use the same inherited-prefix model; the Harness and daemon API expose the operation.

## External effects and recovery

When a loop records only a call's result, a process stop can erase evidence that it dispatched the call. The Harness writes a commitment *before* each external invocation:

**Provider**  
`StepCommitted` is followed by `Provider.stream()`.  
Each `ProviderOutput` is recorded as it arrives.  
`ProviderSettled` records the terminal result.

**Tool**  
`ToolCallRequested` is followed by `ToolCallRule` evaluation.  
`ToolCallCommitted` is written before `Tool.execute()`.  
`ToolCallSettled` records the terminal result.

If the process stops between commitment and outcome, the invocation is ambiguous and requires explicit recovery. Repeating it automatically could run a Tool twice. A Provider retry is automatic only for an explicitly retry-safe failure, within budget, and when the failed Step made no Tool calls.

Rather than make the UI the owner of the agent loop, Little Maple runs the Harness in a local daemon. SQLite stores each Session's facts and projected state together. Live text and Tool activity stream to clients for display; reconnects read a fresh Session snapshot. Restarted work remains paused until explicitly resumed. OpenTUI is a client of that daemon.

The current daemon installs the OpenAI Responses Provider. New Sessions do not yet configure repository Tools or a Location; that awaits an explicit Location-selection workflow. [Browse the implementation](https://github.com/tnspacetime/open-little-maple).
