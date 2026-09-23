/** Application-facing state projected from one Session's durable facts. */
import type { JsonObject, JsonValue } from "./json.js";
import type {
  Prompt,
  ProviderFailureDisposition,
  ToolCallRejectionKind,
} from "./session-facts.js";
import type { TurnServiceConfigurationDescription } from "./turn-service-configuration.js";

// ===========================================================================
// Prompt state
// ===========================================================================

/**
 * One admitted Prompt in the durable inbox/history.
 *
 * A pending queue Prompt has no turnId because it may start a future Turn. A
 * pending steer records the active Turn derived at admission. This ownership
 * belongs to projected lifecycle state, not to the durable Prompt itself.
 *
 * A claimed Prompt belongs permanently to its Turn or Step. Cancelling one
 * pending queue Prompt skips its causal queue suffix; an unconsumed steer
 * becomes skipped when its associated Turn fails or is cancelled.
 */
export type PromptState = {
  readonly prompt: Prompt;
  readonly admittedSeq: number;
} & (
  | {
      readonly status: "pending";
      readonly turnId?: string;
    }
  | {
      readonly status: "claimed-by-turn";
      readonly turnId: string;
      readonly claimedSeq: number;
    }
  | {
      readonly status: "claimed-by-step";
      readonly turnId: string;
      readonly stepId: string;
      readonly claimedSeq: number;
    }
  | {
      readonly status: "skipped";
      readonly turnId?: undefined;
      readonly skippedSeq: number;
      readonly reason: "cancelled";
    }
  | {
      readonly status: "skipped";
      readonly turnId: string;
      readonly skippedSeq: number;
      readonly reason: "turn-failed" | "turn-cancelled";
    }
);

// ===========================================================================
// Provider-invocation state
// ===========================================================================

/**
 * The durable state of the one Provider invocation belonging to a Step.
 * StepCommitted supplies committedSeq; ProviderSettled supplies a terminal
 * state. A committed invocation without settlement remains ambiguous.
 */
export type ProviderInvocationState =
  | {
      readonly status: "committed";
      readonly committedSeq: number;
    }
  | {
      readonly status: "completed";
      readonly committedSeq: number;
      readonly settledSeq: number;
      readonly responseId: string;
    }
  | {
      readonly status: "failed";
      readonly committedSeq: number;
      readonly settledSeq: number;
      readonly error: string;
      readonly disposition: ProviderFailureDisposition;
    };

// ===========================================================================
// Provider output state
// ===========================================================================

/** One complete provider-native output item durably recorded for a Step. */
export type ProviderOutputState = {
  readonly outputIndex: number;
  readonly item: JsonObject;
  readonly recordedSeq: number;
};

// ===========================================================================
// Tool-call state
// ===========================================================================

/**
 * One Provider-requested Tool call and its durable execution lifecycle.
 * Request data remains available in every state so the application and later
 * Provider history can reconstruct exactly what the Provider requested.
 */
export type ToolCallState = {
  readonly callId: string;
  readonly itemId: string;
  readonly name: string;
  readonly argumentsJSON: string;
  readonly outputIndex: number;
  readonly providerItem: JsonObject;
  readonly requestedSeq: number;
} & (
  | {
      readonly status: "requested";
    }
  | {
      readonly status: "rejected";
      readonly kind: ToolCallRejectionKind;
      readonly reason: string;
      readonly rejectedSeq: number;
    }
  | {
      readonly status: "committed";
      readonly committedSeq: number;
    }
  | {
      readonly status: "settled";
      readonly committedSeq: number;
      readonly settledSeq: number;
      readonly outcome: "ok";
      readonly output: JsonValue;
    }
  | {
      readonly status: "settled";
      readonly committedSeq: number;
      readonly settledSeq: number;
      readonly outcome: "error";
      readonly error: string;
    }
);

// ===========================================================================
// Step state
// ===========================================================================

/**
 * One Provider invocation and all Tool calls requested by it.
 *
 * The Provider may already be terminal while the complete Step remains active
 * waiting for requested Tool calls. StepSettled supplies settledSeq only after
 * ProviderSettled and every requested Tool call are terminal.
 */
export type StepState = {
  readonly stepId: string;

  /**
   * The immediately preceding failed Step when this invocation is an exact
   * retry. Absence means this is an initial invocation or normal continuation.
   */
  readonly retryOfStepId?: string;

  /**
   * Steering Prompts claimed together at this Provider boundary. This may be
   * empty for the first Step or for a later Tool-result-only continuation.
   */
  readonly promptIds: readonly string[];

  readonly providerInvocation: ProviderInvocationState;
  readonly providerOutputs: readonly ProviderOutputState[];
  readonly toolCalls: readonly ToolCallState[];
} & (
  | {
      readonly status: "active";
    }
  | {
      readonly status: "settled";
      readonly settledSeq: number;
    }
  | {
      /** Parent Turn was cancelled while this Step remained unfinished. */
      readonly status: "abandoned";
      readonly abandonedSeq: number;
    }
);

// ===========================================================================
// Turn state
// ===========================================================================

/** One complete user-level job containing one or more Provider Steps. */
export type TurnState = {
  readonly turnId: string;
  readonly startedSeq: number;

  /** The one initial Prompt claimed by TurnStarted. */
  readonly promptId: string;

  /** Complete durable configuration frozen for every Step of this Turn. */
  readonly serviceConfiguration: TurnServiceConfigurationDescription;

  /** Steps ordered by their Provider commitment sequence. */
  readonly steps: readonly StepState[];
} & (
  | {
      readonly status: "active";
    }
  | {
      readonly status: "completed";
      readonly settledSeq: number;
    }
  | {
      readonly status: "failed";
      readonly settledSeq: number;
      readonly error: string;
    }
  | {
      readonly status: "cancelled";
      readonly settledSeq: number;
    }
);

// ===========================================================================
// Session state
// ===========================================================================

/** The current application state projected from one resolved Session history. */
export type SessionState = {
  /** Greatest Session-relative semantic sequence incorporated into this state. */
  readonly seq: number;

  /**
   * Complete configuration governing the next Turn. It is absent until the
   * Session records its first TurnServiceConfigurationFact.
   */
  readonly currentServiceConfiguration?: TurnServiceConfigurationDescription;

  /** Prompts ordered by admission sequence. */
  readonly prompts: readonly PromptState[];

  /** Turns ordered by start sequence. At most one Turn may be active. */
  readonly turns: readonly TurnState[];
};
