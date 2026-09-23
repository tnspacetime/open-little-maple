/** Semantic storage boundary for Session facts and their projection. */
import { Buffer } from "node:buffer";
import { assertNonempty, jsonValue, object, sameJsonValue } from "./json.js";
import type { SessionFact, StoredSessionFact } from "./session-facts.js";
import { projectSessionFact } from "./session-projector.js";
import type { SessionState } from "./session-state.js";
import type {
  SessionActivity,
  SessionBase,
  SessionSummary,
} from "./session.js";

/** Hard storage-level bound shared by every SessionStore implementation. */
export const MAX_SESSION_CATALOG_PAGE_SIZE = 100;

const SESSION_ACTIVITIES = ["active", "queued", "idle"] as const;

export type SessionCatalogQuery = {
  /** Optional inclusive filter over derived catalog activity. */
  readonly activity?: readonly SessionActivity[];

  /** Required positive page bound. */
  readonly limit: number;

  /** Opaque position returned by the preceding page. */
  readonly cursor?: string;
};

export type SessionCatalogPage = {
  readonly sessions: readonly SessionSummary[];
  readonly nextCursor?: string;
};

export type DecodedSessionCatalogQuery = {
  /** Canonically ordered and deduplicated; absent means every activity. */
  readonly activity?: readonly SessionActivity[];
  readonly limit: number;
  readonly after?: {
    readonly createdAt: number;
    readonly sessionId: string;
  };
};

/**
 * Storage used by Session orchestration. Implementations must provide
 * per-Session fact-Id idempotency, compare the expected head for new facts,
 * and publish each accepted fact and its projection atomically.
 */
export interface SessionStore {
  create(sessionId: string): Promise<SessionState>;

  /** Create an empty private suffix over one exact resolved parent prefix. */
  createBranch(
    sessionId: string,
    baseSessionId: string,
    throughSeq: number,
  ): Promise<SessionState>;

  /** Return a detached snapshot that callers may not use to mutate the store. */
  read(sessionId: string): Promise<SessionState>;

  /**
   * Return one stable keyset-ordered catalog page. Activity is derived from
   * the current projection and is never stored independently.
   */
  listSessions(query: SessionCatalogQuery): Promise<SessionCatalogPage>;

  /**
   * Return the detached resolved history with each fact's physical owner,
   * semantic sequence, and original append time.
   */
  readFacts(sessionId: string): Promise<readonly StoredSessionFact[]>;

  /**
   * A retry of an existing identical fact succeeds before the expected-head
   * check. Reusing its Id with different content throws SessionFactIdConflict.
   * A new fact with a stale head throws SessionHeadConflict; an invalid new
   * fact preserves and rethrows projectSessionFact()'s SessionProjectionError.
   */
  append(
    sessionId: string,
    expectedSeq: number,
    fact: SessionFact,
  ): Promise<SessionState>;
}

export class SessionAlreadyExists extends Error {
  override readonly name = "SessionAlreadyExists";

  constructor(readonly sessionId: string) {
    super(`Session already exists: ${sessionId}`);
  }
}

export class SessionNotFound extends Error {
  override readonly name = "SessionNotFound";

  constructor(readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
  }
}

/** The requested inclusive parent prefix does not exist. */
export class SessionBranchPointUnavailable extends Error {
  override readonly name = "SessionBranchPointUnavailable";

  constructor(
    readonly baseSessionId: string,
    readonly throughSeq: number,
    readonly baseHeadSeq: number,
  ) {
    super(
      `Session ${baseSessionId} cannot branch through ${throughSeq}; ` +
        `its head is ${baseHeadSeq}`,
    );
  }
}

/** One Session fact Id was reused for different semantic content. */
export class SessionFactIdConflict extends Error {
  override readonly name = "SessionFactIdConflict";

  constructor(
    readonly sessionId: string,
    readonly factId: string,
  ) {
    super(`Session ${sessionId} fact Id was reused: ${factId}`);
  }
}

/** A candidate fact was prepared from an obsolete Session prefix. */
export class SessionHeadConflict extends Error {
  override readonly name = "SessionHeadConflict";

  constructor(
    readonly sessionId: string,
    readonly expectedSeq: number,
    readonly actualSeq: number,
  ) {
    super(`Session ${sessionId} head is ${actualSeq}, expected ${expectedSeq}`);
  }
}

type InMemorySessionRecord = {
  state: SessionState;

  /** Immutable Session creation time used by stable catalog pagination. */
  readonly createdAt: number;

  /** Immutable resolved prefix inherited by this Session, when it is a branch. */
  readonly base?: SessionBase;

  /** Only facts appended privately to this Session. */
  readonly facts: StoredSessionFact[];
};

export type InMemorySessionStoreOptions = {
  /** Injectable only to make Session and fact metadata testable. */
  readonly now?: () => number;
};

/**
 * Process-local SessionStore used to develop and test execution semantics.
 * Each method completes its Map operation synchronously before its Promise is
 * returned, so concurrent callers cannot interleave one append transition.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, InMemorySessionRecord>();
  private readonly now: () => number;

  constructor(options: InMemorySessionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async create(sessionId: string): Promise<SessionState> {
    assertNonempty(sessionId, "Session Id");
    if (this.sessions.has(sessionId)) {
      throw new SessionAlreadyExists(sessionId);
    }

    const state = emptySessionState();
    this.sessions.set(sessionId, {
      state,
      createdAt: this.timestamp(),
      facts: [],
    });
    return structuredClone(state);
  }

  async createBranch(
    sessionId: string,
    baseSessionId: string,
    throughSeq: number,
  ): Promise<SessionState> {
    assertNonempty(sessionId, "Session Id");
    assertNonempty(baseSessionId, "Base Session Id");
    if (this.sessions.has(sessionId)) {
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
    this.sessions.set(sessionId, {
      state,
      createdAt: this.timestamp(),
      base: { sessionId: baseSessionId, throughSeq },
      facts: [],
    });
    return structuredClone(state);
  }

  async read(sessionId: string): Promise<SessionState> {
    return structuredClone(this.requireSession(sessionId).state);
  }

  async listSessions(query: SessionCatalogQuery): Promise<SessionCatalogPage> {
    const decoded = decodeSessionCatalogQuery(query);
    const { activity, after } = decoded;
    const candidates = [...this.sessions.entries()]
      .map(([id, session]): SessionSummary => ({
        id,
        createdAt: session.createdAt,
        ...(session.base ? { base: session.base } : {}),
        headSeq: session.state.seq,
        activity: deriveSessionActivity(session.state),
      }))
      .filter((summary) => !activity || activity.includes(summary.activity))
      .filter((summary) => !after || isAfterCatalogPosition(summary, after))
      .sort(compareSessionSummaries);

    return structuredClone(createSessionCatalogPage(candidates, decoded));
  }

  async readFacts(sessionId: string): Promise<readonly StoredSessionFact[]> {
    return structuredClone(this.resolveFacts(sessionId));
  }

  async append(
    sessionId: string,
    expectedSeq: number,
    fact: SessionFact,
  ): Promise<SessionState> {
    const session = this.requireSession(sessionId);

    /*
     * Validate and detach data before the idempotency early return. This keeps
     * non-JSON runtime values from bypassing projection through a reused Id.
     */
    const candidate = canonicalSessionFact(fact);

    /*
     * Idempotency precedes the head comparison. An uncertain retry naturally
     * carries the old expectedSeq from before its first successful append.
     */
    const previous = this.resolveFacts(sessionId).find(
      (stored) => stored.id === candidate.id,
    );
    if (previous) {
      if (!sameSessionFact(previous, candidate)) {
        throw new SessionFactIdConflict(sessionId, candidate.id);
      }
      return structuredClone(session.state);
    }

    if (session.state.seq !== expectedSeq) {
      throw new SessionHeadConflict(sessionId, expectedSeq, session.state.seq);
    }

    const next = projectSessionFact(session.state, candidate, expectedSeq + 1);

    /* Projection succeeds before the detached fact and state are published. */
    session.facts.push({
      ...candidate,
      sessionId,
      seq: expectedSeq + 1,
      createdAt: this.timestamp(),
    });
    session.state = next;
    return structuredClone(next);
  }

  private requireSession(sessionId: string): InMemorySessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFound(sessionId);
    return session;
  }

  private resolveFacts(sessionId: string): readonly StoredSessionFact[] {
    const session = this.requireSession(sessionId);
    const inherited = session.base
      ? this.resolveFacts(session.base.sessionId).slice(
          0,
          session.base.throughSeq,
        )
      : [];
    return [...inherited, ...session.facts];
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isFinite(value)) {
      throw new Error("In-memory Session timestamp must be finite");
    }
    return value;
  }
}

/** Empty projection shared by SessionStore implementations and replay tools. */
export function emptySessionState(): SessionState {
  return {
    seq: 0,
    prompts: [],
    turns: [],
  };
}

/** Rebuild one projection from an already resolved contiguous fact history. */
export function projectFacts(facts: readonly SessionFact[]): SessionState {
  let state = emptySessionState();
  for (let index = 0; index < facts.length; index += 1) {
    state = projectSessionFact(state, facts[index]!, index + 1);
  }
  return state;
}

/** Validate and detach one candidate before idempotency is considered. */
export function canonicalSessionFact(fact: SessionFact): SessionFact {
  const label = `Session fact ${String(fact.id)} data`;
  return {
    id: fact.id,
    type: fact.type,
    data: object(jsonValue(fact.data, label), label),
  };
}

/** Compare only the semantic identity content stored for a fact Id. */
export function sameSessionFact(
  left: SessionFact,
  right: SessionFact,
): boolean {
  return left.type === right.type && sameJsonValue(left.data, right.data);
}

/** Validate a public catalog query and decode its opaque keyset position. */
export function decodeSessionCatalogQuery(
  query: SessionCatalogQuery,
): DecodedSessionCatalogQuery {
  if (!query || typeof query !== "object") {
    throw new Error("Session catalog query must be an object");
  }
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit <= 0 ||
    query.limit > MAX_SESSION_CATALOG_PAGE_SIZE
  ) {
    throw new Error(
      `Session catalog limit must be an integer from 1 through ${MAX_SESSION_CATALOG_PAGE_SIZE}`,
    );
  }
  const activity = normalizeSessionActivityFilter(query.activity);
  if (query.cursor === undefined) {
    return {
      limit: query.limit,
      ...(activity ? { activity } : {}),
    };
  }
  if (typeof query.cursor !== "string" || query.cursor.length === 0) {
    throw new Error("Session catalog cursor must be a nonempty string");
  }

  const cursor = decodeSessionCatalogCursor(query.cursor);
  if (!sameActivityFilter(activity, cursor.activity)) {
    throw new Error(
      "Session catalog cursor activity filter does not match query",
    );
  }
  return {
    limit: query.limit,
    ...(activity ? { activity } : {}),
    after: {
      createdAt: cursor.createdAt,
      sessionId: cursor.sessionId,
    },
  };
}

/** Build a page from at most limit + 1 summaries in catalog order. */
export function createSessionCatalogPage(
  orderedCandidates: readonly SessionSummary[],
  query: DecodedSessionCatalogQuery,
): SessionCatalogPage {
  const sessions = orderedCandidates.slice(0, query.limit);
  if (orderedCandidates.length <= query.limit) return { sessions };

  const last = sessions[sessions.length - 1]!;
  const nextCursor = Buffer.from(
    JSON.stringify({
      version: 1,
      activity: query.activity ?? null,
      createdAt: last.createdAt,
      sessionId: last.id,
    }),
    "utf8",
  ).toString("base64url");
  return { sessions, nextCursor };
}

/** Derive coarse catalog activity from authoritative projected lifecycle. */
export function deriveSessionActivity(state: SessionState): SessionActivity {
  if (state.turns.some((turn) => turn.status === "active")) return "active";
  return state.prompts.some(
    (prompt) => prompt.status === "pending" && prompt.prompt.mode === "queue",
  )
    ? "queued"
    : "idle";
}

function normalizeSessionActivityFilter(
  value: unknown,
): readonly SessionActivity[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Session catalog activity must be a nonempty array");
  }

  const selected = new Set<SessionActivity>();
  for (const activity of value) {
    if (activity !== "active" && activity !== "queued" && activity !== "idle") {
      throw new Error(
        `Session catalog activity is invalid: ${String(activity)}`,
      );
    }
    selected.add(activity);
  }
  if (selected.size === SESSION_ACTIVITIES.length) return undefined;
  return SESSION_ACTIVITIES.filter((activity) => selected.has(activity));
}

function decodeSessionCatalogCursor(cursor: string): {
  readonly activity?: readonly SessionActivity[];
  readonly createdAt: number;
  readonly sessionId: string;
} {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("invalid cursor payload");
    }
    const payload = decoded as Record<string, unknown>;
    if (
      payload.version !== 1 ||
      !Object.hasOwn(payload, "activity") ||
      typeof payload.createdAt !== "number" ||
      !Number.isFinite(payload.createdAt) ||
      typeof payload.sessionId !== "string" ||
      payload.sessionId.length === 0
    ) {
      throw new Error("invalid cursor payload");
    }
    const activity =
      payload.activity === null
        ? undefined
        : normalizeSessionActivityFilter(payload.activity);
    return {
      ...(activity ? { activity } : {}),
      createdAt: payload.createdAt,
      sessionId: payload.sessionId,
    };
  } catch (cause) {
    throw new Error("Session catalog cursor is invalid", { cause });
  }
}

function sameActivityFilter(
  left: readonly SessionActivity[] | undefined,
  right: readonly SessionActivity[] | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((activity, index) => activity === right[index]))
  );
}

function compareSessionSummaries(
  left: SessionSummary,
  right: SessionSummary,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt > right.createdAt ? -1 : 1;
  }
  return compareSessionIds(right.id, left.id);
}

function isAfterCatalogPosition(
  summary: SessionSummary,
  position: NonNullable<DecodedSessionCatalogQuery["after"]>,
): boolean {
  return (
    summary.createdAt < position.createdAt ||
    (summary.createdAt === position.createdAt &&
      compareSessionIds(summary.id, position.sessionId) < 0)
  );
}

function compareSessionIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
