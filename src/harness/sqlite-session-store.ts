/** SQLite journal and durable projection for the SessionStore contract. */
import type { PathLike } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  assertNonempty,
  jsonValue,
  object,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import {
  PromptAdmitted,
  TurnServiceConfigurationFact,
  type SessionFact,
  type StoredSessionFact,
} from "./session-facts.js";
import type {
  PromptState,
  ProviderInvocationState,
  ProviderOutputState,
  SessionState,
  StepState,
  ToolCallState,
  TurnState,
} from "./session-state.js";
import {
  canonicalSessionFact,
  createSessionCatalogPage,
  decodeSessionCatalogQuery,
  emptySessionState,
  projectFacts,
  sameSessionFact,
  SessionAlreadyExists,
  SessionBranchPointUnavailable,
  SessionFactIdConflict,
  SessionHeadConflict,
  SessionNotFound,
  type SessionCatalogPage,
  type SessionCatalogQuery,
  type SessionStore,
} from "./session-store.js";
import { projectSessionFact } from "./session-projector.js";
import type { SessionSummary } from "./session.js";
import type { TurnServiceConfigurationDescription } from "./turn-service-configuration.js";

const SCHEMA_VERSION = 3;

type SqlParameter = null | number | string;

export type SqliteSessionStoreOptions = {
  /** How long SQLite waits for another writer before reporting SQLITE_BUSY. */
  readonly busyTimeoutMs?: number;

  /** Injectable only to make durable append metadata testable. */
  readonly now?: () => number;
};

type SessionRow = {
  readonly id: string;
  readonly created_at: number;
  readonly base_session_id: string | null;
  readonly base_through_seq: number | null;
  readonly head_seq: number;
};

type SessionCatalogRow = SessionRow & {
  readonly activity: string;
};

type FactRow = {
  readonly owner_session_id: string;
  readonly seq: number;
  readonly fact_id: string;
  readonly type: string;
  readonly data_json: string;
  readonly created_at: number;
};

type ConfigurationRow = {
  readonly description_json: string;
};

type PromptRow = {
  readonly prompt_id: string;
  readonly admitted_seq: number;
  readonly mode: string;
  readonly parts_json: string;
  readonly status: string;
  readonly turn_id: string | null;
  readonly step_id: string | null;
  readonly transition_seq: number | null;
  readonly skip_reason: string | null;
};

type TurnRow = {
  readonly turn_id: string;
  readonly started_seq: number;
  readonly prompt_id: string;
  readonly service_configuration_json: string;
  readonly status: string;
  readonly settled_seq: number | null;
  readonly error_text: string | null;
};

type StepRow = {
  readonly turn_id: string;
  readonly step_id: string;
  readonly committed_seq: number;
  readonly retry_of_step_id: string | null;
  readonly prompt_ids_json: string;
  readonly status: string;
  readonly settled_seq: number | null;
  readonly provider_status: string;
  readonly provider_settled_seq: number | null;
  readonly provider_response_id: string | null;
  readonly provider_error: string | null;
  readonly provider_failure_disposition: string | null;
};

type ProviderOutputRow = {
  readonly turn_id: string;
  readonly step_id: string;
  readonly output_index: number;
  readonly item_json: string;
  readonly recorded_seq: number;
};

type ToolCallRow = {
  readonly turn_id: string;
  readonly step_id: string;
  readonly call_id: string;
  readonly item_id: string;
  readonly name: string;
  readonly arguments_json: string;
  readonly output_index: number;
  readonly provider_item_json: string;
  readonly requested_seq: number;
  readonly status: string;
  readonly rejection_kind: string | null;
  readonly rejection_reason: string | null;
  readonly rejected_seq: number | null;
  readonly committed_seq: number | null;
  readonly settled_seq: number | null;
  readonly outcome: string | null;
  readonly output_json: string | null;
  readonly error_text: string | null;
};

/**
 * File-backed implementation of the semantic SessionStore boundary.
 *
 * The caller owns this store and must close it after the Harness using it has
 * closed. The asynchronous interface is retained for substitutability; the
 * underlying node:sqlite transaction is synchronous and cannot interleave on
 * this connection.
 */
export class SqliteSessionStore implements SessionStore {
  private readonly database: DatabaseSync;
  private readonly now: () => number;
  private closed = false;

  constructor(path: PathLike, options: SqliteSessionStoreOptions = {}) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new Error("SQLite busy timeout must be a nonnegative integer");
    }

    this.now = options.now ?? Date.now;
    this.database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
    });

    try {
      this.database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = FULL");
      this.initializeSchema();
    } catch (cause) {
      this.database.close();
      this.closed = true;
      throw cause;
    }
  }

  async create(sessionId: string): Promise<SessionState> {
    this.ensureOpen();
    assertNonempty(sessionId, "Session Id");

    return this.writeTransaction(() => {
      if (this.findSession(sessionId)) {
        throw new SessionAlreadyExists(sessionId);
      }

      this.run(
        `INSERT INTO sessions (
           id, created_at, base_session_id, base_through_seq, head_seq
         ) VALUES (?, ?, NULL, NULL, 0)`,
        sessionId,
        this.timestamp(),
      );
      return structuredClone(emptySessionState());
    });
  }

  async createBranch(
    sessionId: string,
    baseSessionId: string,
    throughSeq: number,
  ): Promise<SessionState> {
    this.ensureOpen();
    assertNonempty(sessionId, "Session Id");
    assertNonempty(baseSessionId, "Base Session Id");

    return this.writeTransaction(() => {
      if (this.findSession(sessionId)) {
        throw new SessionAlreadyExists(sessionId);
      }

      const baseFacts = this.resolveFacts(baseSessionId);
      if (
        !Number.isInteger(throughSeq) ||
        throughSeq < 0 ||
        throughSeq > baseFacts.length
      ) {
        throw new SessionBranchPointUnavailable(
          baseSessionId,
          throughSeq,
          baseFacts.length,
        );
      }

      const state = projectFacts(baseFacts.slice(0, throughSeq));
      this.run(
        `INSERT INTO sessions (
           id, created_at, base_session_id, base_through_seq, head_seq
         ) VALUES (?, ?, ?, ?, ?)`,
        sessionId,
        this.timestamp(),
        baseSessionId,
        throughSeq,
        throughSeq,
      );
      this.persistProjection(sessionId, undefined, state);
      return structuredClone(state);
    });
  }

  async read(sessionId: string): Promise<SessionState> {
    this.ensureOpen();
    return this.readTransaction(() =>
      structuredClone(this.readProjection(sessionId)),
    );
  }

  async listSessions(query: SessionCatalogQuery): Promise<SessionCatalogPage> {
    this.ensureOpen();
    const decoded = decodeSessionCatalogQuery(query);
    const { activity, after, limit } = decoded;

    return this.readTransaction(() => {
      const select = `SELECT
          catalog.id,
          catalog.created_at,
          catalog.base_session_id,
          catalog.base_through_seq,
          catalog.head_seq,
          catalog.activity
        FROM (
          SELECT
            sessions.id,
            sessions.created_at,
            sessions.base_session_id,
            sessions.base_through_seq,
            sessions.head_seq,
            CASE
              WHEN EXISTS (
                SELECT 1
                  FROM turns
                 WHERE turns.session_id = sessions.id
                   AND turns.status = 'active'
              ) THEN 'active'
              WHEN EXISTS (
                SELECT 1
                  FROM prompts
                 WHERE prompts.session_id = sessions.id
                   AND prompts.status = 'pending'
                   AND prompts.mode = 'queue'
              ) THEN 'queued'
              ELSE 'idle'
            END AS activity
          FROM sessions
        ) AS catalog`;
      const conditions: string[] = [];
      const parameters: SqlParameter[] = [];
      if (activity) {
        conditions.push(
          `catalog.activity IN (${activity.map(() => "?").join(", ")})`,
        );
        parameters.push(...activity);
      }
      if (after) {
        conditions.push(
          `(catalog.created_at < ? OR (
             catalog.created_at = ?
             AND catalog.id COLLATE BINARY < ?
           ))`,
        );
        parameters.push(after.createdAt, after.createdAt, after.sessionId);
      }
      const where =
        conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
      const rows = this.all<SessionCatalogRow>(
        `${select}
         ${where}
         ORDER BY catalog.created_at DESC, catalog.id COLLATE BINARY DESC
         LIMIT ?`,
        ...parameters,
        limit + 1,
      );
      return createSessionCatalogPage(
        rows.map(decodeSessionCatalogRow),
        decoded,
      );
    });
  }

  async readFacts(sessionId: string): Promise<readonly StoredSessionFact[]> {
    this.ensureOpen();
    return this.readTransaction(() =>
      structuredClone(this.resolveFacts(sessionId)),
    );
  }

  async append(
    sessionId: string,
    expectedSeq: number,
    fact: SessionFact,
  ): Promise<SessionState> {
    this.ensureOpen();
    const candidate = canonicalSessionFact(fact);

    return this.writeTransaction(() => {
      const session = this.requireSession(sessionId);

      /* Idempotency includes the immutable inherited prefix of a branch. */
      const previous = this.findResolvedFact(sessionId, candidate.id);
      if (previous) {
        if (!sameSessionFact(previous, candidate)) {
          throw new SessionFactIdConflict(sessionId, candidate.id);
        }
        return structuredClone(this.readProjection(sessionId, session));
      }

      if (session.head_seq !== expectedSeq) {
        throw new SessionHeadConflict(sessionId, expectedSeq, session.head_seq);
      }

      const current = this.readProjection(sessionId, session);
      const next = projectSessionFact(current, candidate, expectedSeq + 1);

      this.run(
        `INSERT INTO session_facts (
           owner_session_id, seq, fact_id, type, data_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        sessionId,
        next.seq,
        candidate.id,
        candidate.type,
        encodeJson(candidate.data),
        this.timestamp(),
      );
      this.persistProjection(sessionId, current, next);

      const result = this.run(
        `UPDATE sessions
            SET head_seq = ?
          WHERE id = ? AND head_seq = ?`,
        next.seq,
        sessionId,
        expectedSeq,
      );
      if (Number(result.changes) !== 1) {
        throw new Error(
          `SQLite Session head changed inside locked transaction: ${sessionId}`,
        );
      }

      return structuredClone(next);
    });
  }

  /** Close the owned SQLite connection. This operation is idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  // =======================================================================
  // Schema and transactions
  // =======================================================================

  private initializeSchema(): void {
    this.writeTransaction(() => {
      const version = this.pragmaUserVersion();
      if (version > SCHEMA_VERSION) {
        throw new Error(
          `SQLite Session schema ${version} is newer than supported schema ${SCHEMA_VERSION}`,
        );
      }
      if (version === SCHEMA_VERSION) return;
      if (version !== 0 && version !== 1 && version !== 2) {
        throw new Error(`Unsupported SQLite Session schema ${version}`);
      }

      if (version === 0) {
        this.database.exec(SCHEMA_V1);
      } else {
        this.database.exec(CANCELLATION_PROJECTION_MIGRATION);
      }
      this.database.exec(SESSION_CATALOG_INDEX);
      this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  private readTransaction<Value>(work: () => Value): Value {
    this.database.exec("BEGIN");
    return this.finishTransaction(work);
  }

  private writeTransaction<Value>(work: () => Value): Value {
    this.database.exec("BEGIN IMMEDIATE");
    return this.finishTransaction(work);
  }

  private finishTransaction<Value>(work: () => Value): Value {
    try {
      const value = work();
      this.database.exec("COMMIT");
      return value;
    } catch (cause) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original semantic, projection, or SQLite failure.
      }
      throw cause;
    }
  }

  private pragmaUserVersion(): number {
    const row = this.get<{ readonly user_version: number }>(
      "PRAGMA user_version",
    );
    if (!row || !Number.isInteger(row.user_version)) {
      throw new Error("SQLite did not return a valid schema version");
    }
    return row.user_version;
  }

  // =======================================================================
  // Journal and branch resolution
  // =======================================================================

  private findSession(sessionId: string): SessionRow | undefined {
    return this.get<SessionRow>(
      `SELECT id, created_at, base_session_id, base_through_seq, head_seq
         FROM sessions
        WHERE id = ?`,
      sessionId,
    );
  }

  private requireSession(sessionId: string): SessionRow {
    const row = this.findSession(sessionId);
    if (!row) throw new SessionNotFound(sessionId);
    return row;
  }

  private resolveFacts(
    sessionId: string,
    ancestors: ReadonlySet<string> = new Set(),
  ): readonly StoredSessionFact[] {
    if (ancestors.has(sessionId)) {
      throw new Error(
        `SQLite Session ancestry contains a cycle at ${sessionId}`,
      );
    }

    const session = this.requireSession(sessionId);
    const nextAncestors = new Set(ancestors).add(sessionId);
    const inherited =
      session.base_session_id === null
        ? []
        : this.resolveFacts(session.base_session_id, nextAncestors).slice(
            0,
            requiredInteger(
              session.base_through_seq,
              `Session ${sessionId} base sequence`,
            ),
          );
    const privateFacts = this.all<FactRow>(
      `SELECT owner_session_id, seq, fact_id, type, data_json, created_at
         FROM session_facts
        WHERE owner_session_id = ?
        ORDER BY seq`,
      sessionId,
    ).map(decodeFactRow);
    const resolved = [...inherited, ...privateFacts];

    if (resolved.length !== session.head_seq) {
      throw new Error(
        `SQLite Session ${sessionId} projection head ${session.head_seq} ` +
          `does not match resolved history length ${resolved.length}`,
      );
    }
    for (let index = 0; index < resolved.length; index += 1) {
      const expectedSeq = index + 1;
      const actualSeq = resolved[index]!.seq;
      if (actualSeq !== expectedSeq) {
        throw new Error(
          `SQLite Session ${sessionId} resolved history has sequence ` +
            `${actualSeq} at position ${expectedSeq}`,
        );
      }
    }
    return resolved;
  }

  /** Find one Id in the exact inherited prefix plus private suffix. */
  private findResolvedFact(
    sessionId: string,
    factId: string,
    throughSeq?: number,
    ancestors: ReadonlySet<string> = new Set(),
  ): StoredSessionFact | undefined {
    if (ancestors.has(sessionId)) {
      throw new Error(
        `SQLite Session ancestry contains a cycle at ${sessionId}`,
      );
    }
    const session = this.requireSession(sessionId);
    const limit = Math.min(throughSeq ?? session.head_seq, session.head_seq);
    const privateRow = this.get<FactRow>(
      `SELECT owner_session_id, seq, fact_id, type, data_json, created_at
         FROM session_facts
        WHERE owner_session_id = ? AND fact_id = ? AND seq <= ?`,
      sessionId,
      factId,
      limit,
    );
    if (privateRow) return decodeFactRow(privateRow);

    if (session.base_session_id === null) return undefined;
    return this.findResolvedFact(
      session.base_session_id,
      factId,
      Math.min(
        limit,
        requiredInteger(
          session.base_through_seq,
          `Session ${sessionId} base sequence`,
        ),
      ),
      new Set(ancestors).add(sessionId),
    );
  }

  // =======================================================================
  // Durable projection reads
  // =======================================================================

  private readProjection(
    sessionId: string,
    knownSession?: SessionRow,
  ): SessionState {
    const session = knownSession ?? this.requireSession(sessionId);
    const configurationRow = this.get<ConfigurationRow>(
      `SELECT description_json
         FROM session_service_configurations
        WHERE session_id = ?`,
      sessionId,
    );
    const currentServiceConfiguration = configurationRow
      ? decodeConfiguration(configurationRow.description_json)
      : undefined;

    const prompts = this.all<PromptRow>(
      `SELECT prompt_id, admitted_seq, mode, parts_json, status,
              turn_id, step_id, transition_seq, skip_reason
         FROM prompts
        WHERE session_id = ?
        ORDER BY admitted_seq`,
      sessionId,
    ).map(decodePromptRow);

    const outputRows = this.all<ProviderOutputRow>(
      `SELECT turn_id, step_id, output_index, item_json, recorded_seq
         FROM provider_outputs
        WHERE session_id = ?
        ORDER BY turn_id, step_id, output_index`,
      sessionId,
    );
    const outputsByStep = new Map<string, ProviderOutputState[]>();
    for (const row of outputRows) {
      appendGrouped(outputsByStep, stepIdentity(row.turn_id, row.step_id), {
        outputIndex: row.output_index,
        item: object(
          parseJson(row.item_json, "Provider output"),
          "Provider output",
        ),
        recordedSeq: row.recorded_seq,
      });
    }

    const toolRows = this.all<ToolCallRow>(
      `SELECT turn_id, step_id, call_id, item_id, name, arguments_json,
              output_index, provider_item_json, requested_seq, status,
              rejection_kind, rejection_reason, rejected_seq, committed_seq,
              settled_seq, outcome, output_json, error_text
         FROM tool_calls
        WHERE session_id = ?
        ORDER BY turn_id, step_id, output_index, call_id`,
      sessionId,
    );
    const toolsByStep = new Map<string, ToolCallState[]>();
    for (const row of toolRows) {
      appendGrouped(
        toolsByStep,
        stepIdentity(row.turn_id, row.step_id),
        decodeToolCallRow(row),
      );
    }

    const stepRows = this.all<StepRow>(
      `SELECT turn_id, step_id, committed_seq, retry_of_step_id,
              prompt_ids_json, status, settled_seq, provider_status,
              provider_settled_seq, provider_response_id, provider_error,
              provider_failure_disposition
         FROM steps
        WHERE session_id = ?
        ORDER BY committed_seq`,
      sessionId,
    );
    const stepsByTurn = new Map<string, StepState[]>();
    for (const row of stepRows) {
      const identity = stepIdentity(row.turn_id, row.step_id);
      appendGrouped(
        stepsByTurn,
        row.turn_id,
        decodeStepRow(
          row,
          outputsByStep.get(identity) ?? [],
          toolsByStep.get(identity) ?? [],
        ),
      );
    }

    const turns = this.all<TurnRow>(
      `SELECT turn_id, started_seq, prompt_id, service_configuration_json,
              status, settled_seq, error_text
         FROM turns
        WHERE session_id = ?
        ORDER BY started_seq`,
      sessionId,
    ).map((row) => decodeTurnRow(row, stepsByTurn.get(row.turn_id) ?? []));

    return currentServiceConfiguration === undefined
      ? { seq: session.head_seq, prompts, turns }
      : {
          seq: session.head_seq,
          currentServiceConfiguration,
          prompts,
          turns,
        };
  }

  // =======================================================================
  // Durable projection writes
  // =======================================================================

  /**
   * Persist only entities changed by projectSessionFact(). Object identity is
   * a safe fast path because that projector promises structural sharing; no
   * lifecycle decision is recomputed here.
   */
  private persistProjection(
    sessionId: string,
    current: SessionState | undefined,
    next: SessionState,
  ): void {
    if (
      current?.currentServiceConfiguration !== next.currentServiceConfiguration
    ) {
      this.persistCurrentConfiguration(
        sessionId,
        next.currentServiceConfiguration,
      );
    }

    const currentPrompts = keyed(current?.prompts ?? [], promptId);
    const nextPrompts = keyed(next.prompts, promptId);
    for (const id of currentPrompts.keys()) {
      if (!nextPrompts.has(id)) {
        this.run(
          "DELETE FROM prompts WHERE session_id = ? AND prompt_id = ?",
          sessionId,
          id,
        );
      }
    }
    for (const prompt of next.prompts) {
      if (currentPrompts.get(promptId(prompt)) !== prompt) {
        this.upsertPrompt(sessionId, prompt);
      }
    }

    const currentTurns = keyed(current?.turns ?? [], turnId);
    const nextTurns = keyed(next.turns, turnId);
    for (const id of currentTurns.keys()) {
      if (!nextTurns.has(id)) {
        this.run(
          "DELETE FROM turns WHERE session_id = ? AND turn_id = ?",
          sessionId,
          id,
        );
      }
    }
    for (const turn of next.turns) {
      const previous = currentTurns.get(turn.turnId);
      if (previous === turn) continue;
      this.upsertTurn(sessionId, turn);
      this.persistSteps(sessionId, previous, turn);
    }
  }

  private persistCurrentConfiguration(
    sessionId: string,
    configuration: TurnServiceConfigurationDescription | undefined,
  ): void {
    if (!configuration) {
      this.run(
        "DELETE FROM session_service_configurations WHERE session_id = ?",
        sessionId,
      );
      return;
    }

    this.run(
      `INSERT INTO session_service_configurations (
         session_id, description_json
       ) VALUES (?, ?)
       ON CONFLICT (session_id) DO UPDATE SET
         description_json = excluded.description_json`,
      sessionId,
      encodeJson(configuration),
    );
  }

  private upsertPrompt(sessionId: string, state: PromptState): void {
    let turnId: string | null = null;
    let stepId: string | null = null;
    let transitionSeq: number | null = null;
    let skipReason: string | null = null;

    switch (state.status) {
      case "pending":
        turnId = state.turnId ?? null;
        break;
      case "claimed-by-turn":
        turnId = state.turnId;
        transitionSeq = state.claimedSeq;
        break;
      case "claimed-by-step":
        turnId = state.turnId;
        stepId = state.stepId;
        transitionSeq = state.claimedSeq;
        break;
      case "skipped":
        turnId = state.reason === "cancelled" ? null : state.turnId;
        transitionSeq = state.skippedSeq;
        skipReason = state.reason;
        break;
    }

    this.run(
      `INSERT INTO prompts (
         session_id, prompt_id, admitted_seq, mode, parts_json, status,
         turn_id, step_id, transition_seq, skip_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, prompt_id) DO UPDATE SET
         admitted_seq = excluded.admitted_seq,
         mode = excluded.mode,
         parts_json = excluded.parts_json,
         status = excluded.status,
         turn_id = excluded.turn_id,
         step_id = excluded.step_id,
         transition_seq = excluded.transition_seq,
         skip_reason = excluded.skip_reason`,
      sessionId,
      state.prompt.id,
      state.admittedSeq,
      state.prompt.mode,
      encodeJson(state.prompt.parts),
      state.status,
      turnId,
      stepId,
      transitionSeq,
      skipReason,
    );
  }

  private upsertTurn(sessionId: string, turn: TurnState): void {
    this.run(
      `INSERT INTO turns (
         session_id, turn_id, started_seq, prompt_id,
         service_configuration_json, status, settled_seq, error_text
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, turn_id) DO UPDATE SET
         started_seq = excluded.started_seq,
         prompt_id = excluded.prompt_id,
         service_configuration_json = excluded.service_configuration_json,
         status = excluded.status,
         settled_seq = excluded.settled_seq,
         error_text = excluded.error_text`,
      sessionId,
      turn.turnId,
      turn.startedSeq,
      turn.promptId,
      encodeJson(turn.serviceConfiguration),
      turn.status,
      turn.status === "active" ? null : turn.settledSeq,
      turn.status === "failed" ? turn.error : null,
    );
  }

  private persistSteps(
    sessionId: string,
    current: TurnState | undefined,
    next: TurnState,
  ): void {
    const currentSteps = keyed(current?.steps ?? [], stepId);
    const nextSteps = keyed(next.steps, stepId);
    for (const id of currentSteps.keys()) {
      if (!nextSteps.has(id)) {
        this.run(
          `DELETE FROM steps
            WHERE session_id = ? AND turn_id = ? AND step_id = ?`,
          sessionId,
          next.turnId,
          id,
        );
      }
    }

    for (const step of next.steps) {
      const previous = currentSteps.get(step.stepId);
      if (previous === step) continue;
      this.upsertStep(sessionId, next.turnId, step);
      this.persistProviderOutputs(sessionId, next.turnId, previous, step);
      this.persistToolCalls(sessionId, next.turnId, previous, step);
    }
  }

  private upsertStep(sessionId: string, turnId: string, step: StepState): void {
    const provider = step.providerInvocation;
    this.run(
      `INSERT INTO steps (
         session_id, turn_id, step_id, committed_seq, retry_of_step_id,
         prompt_ids_json, status, settled_seq, provider_status,
         provider_settled_seq, provider_response_id, provider_error,
         provider_failure_disposition
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, turn_id, step_id) DO UPDATE SET
         committed_seq = excluded.committed_seq,
         retry_of_step_id = excluded.retry_of_step_id,
         prompt_ids_json = excluded.prompt_ids_json,
         status = excluded.status,
         settled_seq = excluded.settled_seq,
         provider_status = excluded.provider_status,
         provider_settled_seq = excluded.provider_settled_seq,
         provider_response_id = excluded.provider_response_id,
         provider_error = excluded.provider_error,
         provider_failure_disposition = excluded.provider_failure_disposition`,
      sessionId,
      turnId,
      step.stepId,
      provider.committedSeq,
      step.retryOfStepId ?? null,
      encodeJson(step.promptIds),
      step.status,
      step.status === "settled"
        ? step.settledSeq
        : step.status === "abandoned"
          ? step.abandonedSeq
          : null,
      provider.status,
      provider.status === "committed" ? null : provider.settledSeq,
      provider.status === "completed" ? provider.responseId : null,
      provider.status === "failed" ? provider.error : null,
      provider.status === "failed" ? provider.disposition : null,
    );
  }

  private persistProviderOutputs(
    sessionId: string,
    turnId: string,
    current: StepState | undefined,
    next: StepState,
  ): void {
    const currentOutputs = keyed(
      current?.providerOutputs ?? [],
      providerOutputId,
    );
    const nextOutputs = keyed(next.providerOutputs, providerOutputId);
    for (const id of currentOutputs.keys()) {
      if (!nextOutputs.has(id)) {
        this.run(
          `DELETE FROM provider_outputs
            WHERE session_id = ? AND turn_id = ? AND step_id = ?
              AND output_index = ?`,
          sessionId,
          turnId,
          next.stepId,
          id,
        );
      }
    }
    for (const output of next.providerOutputs) {
      if (currentOutputs.get(output.outputIndex) === output) continue;
      this.run(
        `INSERT INTO provider_outputs (
           session_id, turn_id, step_id, output_index, item_json, recorded_seq
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, turn_id, step_id, output_index) DO UPDATE SET
           item_json = excluded.item_json,
           recorded_seq = excluded.recorded_seq`,
        sessionId,
        turnId,
        next.stepId,
        output.outputIndex,
        encodeJson(output.item),
        output.recordedSeq,
      );
    }
  }

  private persistToolCalls(
    sessionId: string,
    turnId: string,
    current: StepState | undefined,
    next: StepState,
  ): void {
    const currentTools = keyed(current?.toolCalls ?? [], toolCallId);
    const nextTools = keyed(next.toolCalls, toolCallId);
    for (const id of currentTools.keys()) {
      if (!nextTools.has(id)) {
        this.run(
          `DELETE FROM tool_calls
            WHERE session_id = ? AND turn_id = ? AND step_id = ?
              AND call_id = ?`,
          sessionId,
          turnId,
          next.stepId,
          id,
        );
      }
    }
    for (const tool of next.toolCalls) {
      if (currentTools.get(tool.callId) === tool) continue;
      this.upsertToolCall(sessionId, turnId, next.stepId, tool);
    }
  }

  private upsertToolCall(
    sessionId: string,
    turnId: string,
    stepId: string,
    tool: ToolCallState,
  ): void {
    const rejected = tool.status === "rejected";
    const committed = tool.status === "committed" || tool.status === "settled";
    const settled = tool.status === "settled";

    this.run(
      `INSERT INTO tool_calls (
         session_id, turn_id, step_id, call_id, item_id, name,
         arguments_json, output_index, provider_item_json, requested_seq,
         status, rejection_kind, rejection_reason, rejected_seq,
         committed_seq, settled_seq, outcome, output_json, error_text
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, turn_id, step_id, call_id) DO UPDATE SET
         item_id = excluded.item_id,
         name = excluded.name,
         arguments_json = excluded.arguments_json,
         output_index = excluded.output_index,
         provider_item_json = excluded.provider_item_json,
         requested_seq = excluded.requested_seq,
         status = excluded.status,
         rejection_kind = excluded.rejection_kind,
         rejection_reason = excluded.rejection_reason,
         rejected_seq = excluded.rejected_seq,
         committed_seq = excluded.committed_seq,
         settled_seq = excluded.settled_seq,
         outcome = excluded.outcome,
         output_json = excluded.output_json,
         error_text = excluded.error_text`,
      sessionId,
      turnId,
      stepId,
      tool.callId,
      tool.itemId,
      tool.name,
      tool.argumentsJSON,
      tool.outputIndex,
      encodeJson(tool.providerItem),
      tool.requestedSeq,
      tool.status,
      rejected ? tool.kind : null,
      rejected ? tool.reason : null,
      rejected ? tool.rejectedSeq : null,
      committed ? tool.committedSeq : null,
      settled ? tool.settledSeq : null,
      settled ? tool.outcome : null,
      settled && tool.outcome === "ok" ? encodeJson(tool.output) : null,
      settled && tool.outcome === "error" ? tool.error : null,
    );
  }

  // =======================================================================
  // Small SQLite helpers
  // =======================================================================

  private get<Row>(
    sql: string,
    ...parameters: readonly SqlParameter[]
  ): Row | undefined {
    return this.database.prepare(sql).get(...parameters) as Row | undefined;
  }

  private all<Row>(sql: string, ...parameters: readonly SqlParameter[]): Row[] {
    return this.database.prepare(sql).all(...parameters) as Row[];
  }

  private run(
    sql: string,
    ...parameters: readonly SqlParameter[]
  ): { readonly changes: number | bigint } {
    return this.database.prepare(sql).run(...parameters);
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isFinite(value)) {
      throw new Error("SQLite Session timestamp must be finite");
    }
    return value;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("SQLite Session store is closed");
  }
}

// ===========================================================================
// Projection row decoding
// ===========================================================================

function decodeFactRow(row: FactRow): StoredSessionFact {
  return {
    sessionId: row.owner_session_id,
    seq: row.seq,
    id: row.fact_id,
    type: row.type,
    data: object(
      parseJson(row.data_json, "Session fact data"),
      "Session fact data",
    ),
    createdAt: row.created_at,
  };
}

function decodeSessionCatalogRow(row: SessionCatalogRow): SessionSummary {
  if (
    row.activity !== "idle" &&
    row.activity !== "queued" &&
    row.activity !== "active"
  ) {
    throw new Error(`Session ${row.id} has unknown activity ${row.activity}`);
  }

  const withoutBase = row.base_session_id === null;
  if (withoutBase !== (row.base_through_seq === null)) {
    throw new Error(`Session ${row.id} has incomplete branch origin`);
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    ...(withoutBase
      ? {}
      : {
          base: {
            sessionId: row.base_session_id!,
            throughSeq: requiredInteger(
              row.base_through_seq,
              `Session ${row.id} base sequence`,
            ),
          },
        }),
    headSeq: row.head_seq,
    activity: row.activity,
  };
}

function decodeConfiguration(
  encoded: string,
): TurnServiceConfigurationDescription {
  return TurnServiceConfigurationFact.decode(
    object(
      parseJson(encoded, "Turn service configuration"),
      "Turn service configuration",
    ),
  );
}

function decodePromptRow(row: PromptRow): PromptState {
  const parts = parseJson(row.parts_json, `Prompt ${row.prompt_id} parts`);
  const prompt = PromptAdmitted.decode({
    id: row.prompt_id,
    mode: row.mode,
    parts,
  } as JsonObject);

  switch (row.status) {
    case "pending":
      return row.turn_id === null
        ? { prompt, admittedSeq: row.admitted_seq, status: "pending" }
        : {
            prompt,
            admittedSeq: row.admitted_seq,
            status: "pending",
            turnId: row.turn_id,
          };
    case "claimed-by-turn":
      return {
        prompt,
        admittedSeq: row.admitted_seq,
        status: "claimed-by-turn",
        turnId: requiredString(row.turn_id, `Prompt ${prompt.id} Turn`),
        claimedSeq: requiredInteger(
          row.transition_seq,
          `Prompt ${prompt.id} claimed sequence`,
        ),
      };
    case "claimed-by-step":
      return {
        prompt,
        admittedSeq: row.admitted_seq,
        status: "claimed-by-step",
        turnId: requiredString(row.turn_id, `Prompt ${prompt.id} Turn`),
        stepId: requiredString(row.step_id, `Prompt ${prompt.id} Step`),
        claimedSeq: requiredInteger(
          row.transition_seq,
          `Prompt ${prompt.id} claimed sequence`,
        ),
      };
    case "skipped":
      if (row.skip_reason === "cancelled") {
        if (row.turn_id !== null) {
          throw new Error(
            `Cancelled Prompt ${prompt.id} unexpectedly has a Turn`,
          );
        }
        return {
          prompt,
          admittedSeq: row.admitted_seq,
          status: "skipped",
          skippedSeq: requiredInteger(
            row.transition_seq,
            `Prompt ${prompt.id} skipped sequence`,
          ),
          reason: "cancelled",
        };
      }
      if (
        row.skip_reason !== "turn-failed" &&
        row.skip_reason !== "turn-cancelled"
      ) {
        throw new Error(`Prompt ${prompt.id} has unknown skip reason`);
      }
      return {
        prompt,
        admittedSeq: row.admitted_seq,
        status: "skipped",
        turnId: requiredString(row.turn_id, `Prompt ${prompt.id} Turn`),
        skippedSeq: requiredInteger(
          row.transition_seq,
          `Prompt ${prompt.id} skipped sequence`,
        ),
        reason: row.skip_reason,
      };
    default:
      throw new Error(`Prompt ${prompt.id} has unknown status ${row.status}`);
  }
}

function decodeTurnRow(row: TurnRow, steps: readonly StepState[]): TurnState {
  const base = {
    turnId: row.turn_id,
    startedSeq: row.started_seq,
    promptId: row.prompt_id,
    serviceConfiguration: decodeConfiguration(row.service_configuration_json),
    steps,
  };

  switch (row.status) {
    case "active":
      return { ...base, status: "active" };
    case "completed":
      return {
        ...base,
        status: "completed",
        settledSeq: requiredInteger(
          row.settled_seq,
          `Turn ${row.turn_id} settled sequence`,
        ),
      };
    case "failed":
      return {
        ...base,
        status: "failed",
        settledSeq: requiredInteger(
          row.settled_seq,
          `Turn ${row.turn_id} settled sequence`,
        ),
        error: requiredString(row.error_text, `Turn ${row.turn_id} error`),
      };
    case "cancelled":
      return {
        ...base,
        status: "cancelled",
        settledSeq: requiredInteger(
          row.settled_seq,
          `Turn ${row.turn_id} settled sequence`,
        ),
      };
    default:
      throw new Error(`Turn ${row.turn_id} has unknown status ${row.status}`);
  }
}

function decodeStepRow(
  row: StepRow,
  providerOutputs: readonly ProviderOutputState[],
  toolCalls: readonly ToolCallState[],
): StepState {
  const providerInvocation = decodeProviderInvocation(row);
  const parsedPromptIds = parseJson(
    row.prompt_ids_json,
    `Step ${row.step_id} Prompt Ids`,
  );
  if (
    !Array.isArray(parsedPromptIds) ||
    parsedPromptIds.some((value) => typeof value !== "string")
  ) {
    throw new Error(`Step ${row.step_id} Prompt Ids must be strings`);
  }

  const base = {
    stepId: row.step_id,
    ...(row.retry_of_step_id === null
      ? {}
      : { retryOfStepId: row.retry_of_step_id }),
    promptIds: parsedPromptIds as string[],
    providerInvocation,
    providerOutputs,
    toolCalls,
  };

  switch (row.status) {
    case "active":
      return { ...base, status: "active" };
    case "settled":
      return {
        ...base,
        status: "settled",
        settledSeq: requiredInteger(
          row.settled_seq,
          `Step ${row.step_id} settled sequence`,
        ),
      };
    case "abandoned":
      return {
        ...base,
        status: "abandoned",
        abandonedSeq: requiredInteger(
          row.settled_seq,
          `Step ${row.step_id} abandoned sequence`,
        ),
      };
    default:
      throw new Error(`Step ${row.step_id} has unknown status ${row.status}`);
  }
}

function decodeProviderInvocation(row: StepRow): ProviderInvocationState {
  switch (row.provider_status) {
    case "committed":
      return { status: "committed", committedSeq: row.committed_seq };
    case "completed":
      return {
        status: "completed",
        committedSeq: row.committed_seq,
        settledSeq: requiredInteger(
          row.provider_settled_seq,
          `Step ${row.step_id} Provider settled sequence`,
        ),
        responseId: requiredString(
          row.provider_response_id,
          `Step ${row.step_id} Provider response Id`,
        ),
      };
    case "failed": {
      const disposition = row.provider_failure_disposition;
      if (disposition !== "retry-safe" && disposition !== "terminal") {
        throw new Error(
          `Step ${row.step_id} has unknown Provider failure disposition`,
        );
      }
      return {
        status: "failed",
        committedSeq: row.committed_seq,
        settledSeq: requiredInteger(
          row.provider_settled_seq,
          `Step ${row.step_id} Provider settled sequence`,
        ),
        error: requiredString(
          row.provider_error,
          `Step ${row.step_id} Provider error`,
        ),
        disposition,
      };
    }
    default:
      throw new Error(
        `Step ${row.step_id} has unknown Provider status ${row.provider_status}`,
      );
  }
}

function decodeToolCallRow(row: ToolCallRow): ToolCallState {
  const base = {
    callId: row.call_id,
    itemId: row.item_id,
    name: row.name,
    argumentsJSON: row.arguments_json,
    outputIndex: row.output_index,
    providerItem: object(
      parseJson(
        row.provider_item_json,
        `Tool call ${row.call_id} Provider item`,
      ),
      `Tool call ${row.call_id} Provider item`,
    ),
    requestedSeq: row.requested_seq,
  };

  switch (row.status) {
    case "requested":
      return { ...base, status: "requested" };
    case "rejected": {
      const kind = row.rejection_kind;
      if (
        kind !== "denied" &&
        kind !== "unavailable" &&
        kind !== "invalid-arguments"
      ) {
        throw new Error(`Tool call ${row.call_id} has unknown rejection kind`);
      }
      return {
        ...base,
        status: "rejected",
        kind,
        reason: requiredString(
          row.rejection_reason,
          `Tool call ${row.call_id} rejection reason`,
        ),
        rejectedSeq: requiredInteger(
          row.rejected_seq,
          `Tool call ${row.call_id} rejected sequence`,
        ),
      };
    }
    case "committed":
      return {
        ...base,
        status: "committed",
        committedSeq: requiredInteger(
          row.committed_seq,
          `Tool call ${row.call_id} committed sequence`,
        ),
      };
    case "settled": {
      const settled = {
        ...base,
        status: "settled" as const,
        committedSeq: requiredInteger(
          row.committed_seq,
          `Tool call ${row.call_id} committed sequence`,
        ),
        settledSeq: requiredInteger(
          row.settled_seq,
          `Tool call ${row.call_id} settled sequence`,
        ),
      };
      if (row.outcome === "ok") {
        return {
          ...settled,
          outcome: "ok",
          output: parseJson(
            requiredString(row.output_json, `Tool call ${row.call_id} output`),
            `Tool call ${row.call_id} output`,
          ),
        };
      }
      if (row.outcome === "error") {
        return {
          ...settled,
          outcome: "error",
          error: requiredString(
            row.error_text,
            `Tool call ${row.call_id} error`,
          ),
        };
      }
      throw new Error(`Tool call ${row.call_id} has unknown outcome`);
    }
    default:
      throw new Error(
        `Tool call ${row.call_id} has unknown status ${row.status}`,
      );
  }
}

// ===========================================================================
// Generic projection and JSON helpers
// ===========================================================================

function keyed<Value, Key extends string | number>(
  values: readonly Value[],
  identity: (value: Value) => Key,
): Map<Key, Value> {
  return new Map(values.map((value) => [identity(value), value]));
}

function promptId(prompt: PromptState): string {
  return prompt.prompt.id;
}

function turnId(turn: TurnState): string {
  return turn.turnId;
}

function stepId(step: StepState): string {
  return step.stepId;
}

function providerOutputId(output: ProviderOutputState): number {
  return output.outputIndex;
}

function toolCallId(tool: ToolCallState): string {
  return tool.callId;
}

function stepIdentity(turnIdValue: string, stepIdValue: string): string {
  return `${turnIdValue}\u0000${stepIdValue}`;
}

function appendGrouped<Value>(
  groups: Map<string, Value[]>,
  identity: string,
  value: Value,
): void {
  const group = groups.get(identity) ?? [];
  group.push(value);
  groups.set(identity, group);
}

function encodeJson(value: JsonValue | JsonObject | object): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Error("Durable JSON cannot be undefined");
  return encoded;
}

function parseJson(encoded: string, label: string): JsonValue {
  try {
    return jsonValue(JSON.parse(encoded), label);
  } catch (cause) {
    throw new Error(`Invalid durable ${label} JSON`, { cause });
  }
}

function requiredString(value: string | null, label: string): string {
  if (value === null) throw new Error(`${label} is missing`);
  return value;
}

function requiredInteger(value: number | null, label: string): number {
  if (value === null || !Number.isInteger(value)) {
    throw new Error(`${label} is missing or invalid`);
  }
  return value;
}

// ===========================================================================
// Schema version 1
// ===========================================================================

const SCHEMA_V1 = String.raw`
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  base_session_id TEXT REFERENCES sessions(id),
  base_through_seq INTEGER,
  head_seq INTEGER NOT NULL CHECK (head_seq >= 0),
  CHECK (
    (base_session_id IS NULL AND base_through_seq IS NULL) OR
    (base_session_id IS NOT NULL AND base_through_seq >= 0)
  )
) STRICT;

CREATE TABLE session_facts (
  owner_session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL CHECK (seq > 0),
  fact_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_session_id, seq),
  UNIQUE (owner_session_id, fact_id)
) STRICT;

CREATE TABLE session_service_configurations (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  description_json TEXT NOT NULL CHECK (json_valid(description_json))
) STRICT;

CREATE TABLE prompts (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_id TEXT NOT NULL,
  admitted_seq INTEGER NOT NULL CHECK (admitted_seq > 0),
  mode TEXT NOT NULL CHECK (mode IN ('queue', 'steer')),
  parts_json TEXT NOT NULL CHECK (json_valid(parts_json)),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'claimed-by-turn', 'claimed-by-step', 'skipped')
  ),
  turn_id TEXT,
  step_id TEXT,
  transition_seq INTEGER,
  skip_reason TEXT,
  PRIMARY KEY (session_id, prompt_id)
) STRICT;
CREATE UNIQUE INDEX prompts_admission_order
  ON prompts(session_id, admitted_seq);

CREATE TABLE turns (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  started_seq INTEGER NOT NULL CHECK (started_seq > 0),
  prompt_id TEXT NOT NULL,
  service_configuration_json TEXT NOT NULL
    CHECK (json_valid(service_configuration_json)),
  status TEXT NOT NULL
    CHECK (status IN ('active', 'completed', 'failed', 'cancelled')),
  settled_seq INTEGER,
  error_text TEXT,
  PRIMARY KEY (session_id, turn_id),
  FOREIGN KEY (session_id, prompt_id)
    REFERENCES prompts(session_id, prompt_id)
) STRICT;
CREATE UNIQUE INDEX turns_start_order
  ON turns(session_id, started_seq);

CREATE TABLE steps (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  committed_seq INTEGER NOT NULL CHECK (committed_seq > 0),
  retry_of_step_id TEXT,
  prompt_ids_json TEXT NOT NULL CHECK (json_valid(prompt_ids_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'settled', 'abandoned')),
  settled_seq INTEGER,
  provider_status TEXT NOT NULL
    CHECK (provider_status IN ('committed', 'completed', 'failed')),
  provider_settled_seq INTEGER,
  provider_response_id TEXT,
  provider_error TEXT,
  provider_failure_disposition TEXT,
  PRIMARY KEY (session_id, turn_id, step_id),
  FOREIGN KEY (session_id, turn_id)
    REFERENCES turns(session_id, turn_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX steps_commit_order
  ON steps(session_id, committed_seq);

CREATE TABLE provider_outputs (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  output_index INTEGER NOT NULL CHECK (output_index >= 0),
  item_json TEXT NOT NULL CHECK (json_valid(item_json)),
  recorded_seq INTEGER NOT NULL CHECK (recorded_seq > 0),
  PRIMARY KEY (session_id, turn_id, step_id, output_index),
  FOREIGN KEY (session_id, turn_id, step_id)
    REFERENCES steps(session_id, turn_id, step_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE tool_calls (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  output_index INTEGER NOT NULL CHECK (output_index >= 0),
  provider_item_json TEXT NOT NULL CHECK (json_valid(provider_item_json)),
  requested_seq INTEGER NOT NULL CHECK (requested_seq > 0),
  status TEXT NOT NULL
    CHECK (status IN ('requested', 'rejected', 'committed', 'settled')),
  rejection_kind TEXT,
  rejection_reason TEXT,
  rejected_seq INTEGER,
  committed_seq INTEGER,
  settled_seq INTEGER,
  outcome TEXT,
  output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  error_text TEXT,
  PRIMARY KEY (session_id, turn_id, step_id, call_id),
  UNIQUE (session_id, turn_id, step_id, item_id),
  UNIQUE (session_id, turn_id, step_id, output_index),
  FOREIGN KEY (session_id, turn_id, step_id)
    REFERENCES steps(session_id, turn_id, step_id) ON DELETE CASCADE
) STRICT;
`;

/** Schema version 2 adds only the stable catalog-order access path. */
const SESSION_CATALOG_INDEX = String.raw`
CREATE INDEX IF NOT EXISTS sessions_catalog_order
  ON sessions(created_at DESC, id DESC);
`;

/**
 * Version 3 adds honest terminal cancellation/abandonment values to the
 * projection tables. SQLite cannot alter CHECK constraints in place, so the
 * projection tables are rebuilt while the journal and Session identities stay
 * untouched. All rows are copied exactly before the old tables are removed.
 */
const CANCELLATION_PROJECTION_MIGRATION = String.raw`
CREATE TABLE prompts_v3 (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_id TEXT NOT NULL,
  admitted_seq INTEGER NOT NULL CHECK (admitted_seq > 0),
  mode TEXT NOT NULL CHECK (mode IN ('queue', 'steer')),
  parts_json TEXT NOT NULL CHECK (json_valid(parts_json)),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'claimed-by-turn', 'claimed-by-step', 'skipped')
  ),
  turn_id TEXT,
  step_id TEXT,
  transition_seq INTEGER,
  skip_reason TEXT,
  PRIMARY KEY (session_id, prompt_id)
) STRICT;

CREATE TABLE turns_v3 (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  started_seq INTEGER NOT NULL CHECK (started_seq > 0),
  prompt_id TEXT NOT NULL,
  service_configuration_json TEXT NOT NULL
    CHECK (json_valid(service_configuration_json)),
  status TEXT NOT NULL
    CHECK (status IN ('active', 'completed', 'failed', 'cancelled')),
  settled_seq INTEGER,
  error_text TEXT,
  PRIMARY KEY (session_id, turn_id),
  FOREIGN KEY (session_id, prompt_id)
    REFERENCES prompts_v3(session_id, prompt_id)
) STRICT;

CREATE TABLE steps_v3 (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  committed_seq INTEGER NOT NULL CHECK (committed_seq > 0),
  retry_of_step_id TEXT,
  prompt_ids_json TEXT NOT NULL CHECK (json_valid(prompt_ids_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'settled', 'abandoned')),
  settled_seq INTEGER,
  provider_status TEXT NOT NULL
    CHECK (provider_status IN ('committed', 'completed', 'failed')),
  provider_settled_seq INTEGER,
  provider_response_id TEXT,
  provider_error TEXT,
  provider_failure_disposition TEXT,
  PRIMARY KEY (session_id, turn_id, step_id),
  FOREIGN KEY (session_id, turn_id)
    REFERENCES turns_v3(session_id, turn_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE provider_outputs_v3 (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  output_index INTEGER NOT NULL CHECK (output_index >= 0),
  item_json TEXT NOT NULL CHECK (json_valid(item_json)),
  recorded_seq INTEGER NOT NULL CHECK (recorded_seq > 0),
  PRIMARY KEY (session_id, turn_id, step_id, output_index),
  FOREIGN KEY (session_id, turn_id, step_id)
    REFERENCES steps_v3(session_id, turn_id, step_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE tool_calls_v3 (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  output_index INTEGER NOT NULL CHECK (output_index >= 0),
  provider_item_json TEXT NOT NULL CHECK (json_valid(provider_item_json)),
  requested_seq INTEGER NOT NULL CHECK (requested_seq > 0),
  status TEXT NOT NULL
    CHECK (status IN ('requested', 'rejected', 'committed', 'settled')),
  rejection_kind TEXT,
  rejection_reason TEXT,
  rejected_seq INTEGER,
  committed_seq INTEGER,
  settled_seq INTEGER,
  outcome TEXT,
  output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  error_text TEXT,
  PRIMARY KEY (session_id, turn_id, step_id, call_id),
  UNIQUE (session_id, turn_id, step_id, item_id),
  UNIQUE (session_id, turn_id, step_id, output_index),
  FOREIGN KEY (session_id, turn_id, step_id)
    REFERENCES steps_v3(session_id, turn_id, step_id) ON DELETE CASCADE
) STRICT;

INSERT INTO prompts_v3 SELECT * FROM prompts;
INSERT INTO turns_v3 SELECT * FROM turns;
INSERT INTO steps_v3 SELECT * FROM steps;
INSERT INTO provider_outputs_v3 SELECT * FROM provider_outputs;
INSERT INTO tool_calls_v3 SELECT * FROM tool_calls;

DROP TABLE provider_outputs;
DROP TABLE tool_calls;
DROP TABLE steps;
DROP TABLE turns;
DROP TABLE prompts;

ALTER TABLE prompts_v3 RENAME TO prompts;
ALTER TABLE turns_v3 RENAME TO turns;
ALTER TABLE steps_v3 RENAME TO steps;
ALTER TABLE provider_outputs_v3 RENAME TO provider_outputs;
ALTER TABLE tool_calls_v3 RENAME TO tool_calls;

CREATE UNIQUE INDEX prompts_admission_order
  ON prompts(session_id, admitted_seq);
CREATE UNIQUE INDEX turns_start_order
  ON turns(session_id, started_seq);
CREATE UNIQUE INDEX steps_commit_order
  ON steps(session_id, committed_seq);
`;
