/** Durable identity and immutable ancestry for one Session. */

/** The inclusive parent prefix inherited by a branched Session. */
export type SessionBase = {
  readonly sessionId: string;
  readonly throughSeq: number;
};

/** Stable metadata for one root Session or branch. */
export type Session = {
  readonly id: string;
  readonly createdAt: number;
  readonly base?: SessionBase;
};

/** Coarse catalog activity derived from the current Session projection. */
export type SessionActivity = "idle" | "queued" | "active";

/** Stable Session metadata plus its current projected catalog summary. */
export type SessionSummary = Session & {
  readonly headSeq: number;
  readonly activity: SessionActivity;
};
