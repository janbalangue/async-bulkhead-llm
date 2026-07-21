/**
 * Public request, result, options, stats, and event types shared across
 * the library. Type declarations only — no runtime code lives here.
 */
import type {
  AcquireOptions,
  Stats,
  RejectReason as BaseRejectReason,
} from "async-bulkhead-ts";
import type { LLMBulkheadPreset } from "./profiles.js";

// ────────────────────────────────────────────
// Content block types (multimodal support)
// ────────────────────────────────────────────

/**
 * A text content block. The only block type that contributes to
 * character-based token estimation.
 */
export type TextContentBlock = {
  type: "text";
  text: string;
};

/**
 * A non-text content block (image, tool_result, document, etc.).
 *
 * By default, built-in estimators ignore non-text blocks — token
 * estimates for multimodal requests should then be treated as a lower
 * bound. To charge a fixed reservation per opaque block instead, use
 * `createModelAwareTokenEstimator`'s `opaqueBlockTokens` option, or
 * carry a caller-computed total in `LLMRequest.extraInputTokens`, or
 * provide a custom estimator.
 */
export type OpaqueContentBlock = {
  type: string;
  [key: string]: unknown;
};

export type ContentBlock = TextContentBlock | OpaqueContentBlock;

// ────────────────────────────────────────────
// Request types
// ────────────────────────────────────────────

/**
 * Minimal message shape shared across estimators.
 *
 * `content` may be a plain string (backward-compatible with v1) or
 * an array of content blocks for multimodal requests.
 */
export type LLMMessage = {
  role: string;
  content: string | ContentBlock[];
};

/**
 * Minimal request shape.
 *
 * `model` is optional at the request level. When present, the estimator
 * uses it for ratio lookup instead of the bulkhead-level default.
 * This supports A/B testing, canary deployments, and mixed-model routing
 * through a single bulkhead.
 */
export type LLMRequest = {
  model?: string;
  messages: LLMMessage[];
  max_tokens?: number;

  /**
   * Optional system prompt (v3.7). Counted by the built-in estimators
   * exactly like message content: a plain string, or an array of content
   * blocks (text blocks counted by characters, non-text blocks subject
   * to the model-aware estimator's `opaqueBlockTokens` surcharge).
   *
   * Before v3.7, callers had to fold the system prompt into a synthetic
   * message for it to participate in estimation — which also distorted
   * events, logs, and deduplication keys. Carry it here instead.
   */
  system?: string | ContentBlock[];

  /**
   * Additional input tokens the character-based estimators cannot see
   * (v3.7) — e.g. provider-side cost of tool schemas kept outside
   * `messages`, or media priced by out-of-band rules. Built-in
   * estimators add this verbatim to their input estimate; custom
   * estimators may honor or ignore it.
   *
   * Must be a non-negative integer when present. Participates in the
   * default deduplication key like any other request field, so requests
   * differing only here are never conflated.
   */
  extraInputTokens?: number;
};

// ────────────────────────────────────────────
// Token estimation types
// ────────────────────────────────────────────

export type TokenEstimate = {
  input: number;
  maxOutput: number;
};

/**
 * Exact token reservation the bulkhead will use for admission.
 *
 * `null` is returned by `bulkhead.estimate()` when `tokenBudget` is not
 * configured, because no token reservation participates in admission in
 * that mode.
 */
export type LLMReservationEstimate = {
  readonly input: number;
  readonly maxOutput: number;
  readonly reserved: number;
};

export type TokenEstimator = (request: LLMRequest) => TokenEstimate;

/**
 * Accepted shape for the per-call `reservation` override (v3.8).
 *
 * Structurally this is a `TokenEstimate` plus an optional `reserved`
 * field, which means the object returned by `bulkhead.estimate()`
 * (an `LLMReservationEstimate`) can be passed back verbatim — no need
 * to strip `reserved` first. When `reserved` is present it is treated
 * as a consistency check: it must equal `input + maxOutput`, otherwise
 * admission throws. This catches hand-built overrides whose fields
 * drifted apart (e.g. a cached `reserved` paired with edited parts).
 */
export type LLMReservationOverride = TokenEstimate & {
  /** Optional cross-check; must equal `input + maxOutput` when present. */
  reserved?: number;
};

/**
 * Result of `wouldAdmit()` (v3.8: optional capacity snapshot).
 *
 * `detail` is present only when the call passed `detail: true`. It is
 * the same `LLMRejectDetail` snapshot attached to real rejections —
 * including on an `admit: true` result, where it describes the capacity
 * the request *would* be admitted against. Like the boolean itself, it
 * is advisory: capacity can change before a subsequent `acquire()`.
 */
export type LLMWouldAdmitResult = {
  admit: boolean;
  reason?: LLMRejectReason;
  detail?: LLMRejectDetail;
};

/**
 * Result of `drain({ timeoutMs })` (v3.8).
 *
 * `drained: true` means all in-flight work and pending waiters
 * completed within the deadline (`inFlight`/`pending` are then 0).
 * `drained: false` means the deadline elapsed first; `inFlight` and
 * `pending` report what was still outstanding at that moment.
 */
export type LLMDrainResult = {
  drained: boolean;
  inFlight: number;
  pending: number;
};

/**
 * Actual token usage returned by the provider after a call completes.
 *
 * In v2, this drives the refund mechanism: when usage is reported at
 * release time, the difference between the pre-admission reservation
 * and actual consumption is returned to the budget immediately.
 */
export type TokenUsage = {
  input: number;
  output: number;
};

// ────────────────────────────────────────────
// Reject reason
// ────────────────────────────────────────────

/**
 * Rejection reasons.
 *
 * `"unshareable_result"` (v3.5) is raised only for deduplication
 * *followers*: the shared call resolved to a single-consumer value
 * (stream, `Response` with a body, async iterable) that cannot be
 * safely handed to more than one caller, and no
 * `deduplication.shareResult` hook was configured. The leader always
 * receives the original result unaffected.
 */
export type LLMRejectReason =
  | BaseRejectReason
  | "budget_limit"
  | "unshareable_result";

/**
 * Admission priority.
 *
 * `"high"` requests may use the full token budget. `"normal"` requests
 * (the default) are rejected once available budget drops to
 * `tokenBudget.highPriorityReserve`, keeping headroom for high-priority
 * traffic. Priority has no effect when `tokenBudget` is not configured
 * or `highPriorityReserve` is 0/unset.
 */
export type LLMPriority = "high" | "normal";

/**
 * Capacity snapshot attached to rejections so callers (e.g. gateways)
 * can build informative 429/503 responses.
 *
 * Note: no retry-after estimate is provided — a fail-fast bulkhead has
 * no honest ETA for capacity. Expose these numbers instead.
 */
export type LLMRejectDetail = {
  inFlight: number;
  maxConcurrent: number;
  pending: number;
  maxQueue: number;
  tokenBudget?: {
    /** Configured budget ceiling. */
    budget: number;
    /** Tokens currently held by in-flight reservations. */
    inFlightTokens: number;
    /** Budget this request was admitted against (priority-adjusted). */
    effectiveBudget: number;
    /** Tokens available at this priority (clamped at 0). */
    available: number;
    /** Tokens this request needed. */
    requested: number;
  };
};

/** Options accepted by `acquire()` / `run()` (base options + priority). */
export type LLMAcquireOptions = AcquireOptions & {
  priority?: LLMPriority;

  /**
   * Per-call token reservation override (v3.7).
   *
   * When provided and `tokenBudget` is configured, admission reserves
   * `input + maxOutput` from this value verbatim and the bulkhead's
   * estimator is not consulted for this call. Intended for callers —
   * typically gateways — that already compute a more accurate estimate
   * from the full provider request (tool schemas, response formats,
   * provider-priced media) than any character-ratio estimator could.
   *
   * Both fields must be non-negative integers. Ignored when
   * `tokenBudget` is not configured (no reservation participates in
   * admission in that mode). Not reflected by `estimate()`, which
   * always previews the estimator path.
   *
   * v3.8: the object returned by `bulkhead.estimate()` can be passed
   * here directly. When a `reserved` field is present it must equal
   * `input + maxOutput` (see `LLMReservationOverride`).
   */
  reservation?: LLMReservationOverride;
};

// ────────────────────────────────────────────
// Stats
// ────────────────────────────────────────────

export type LLMRequestStats = {
  /** Successful LLM admissions (slot + budget acquired). */
  admitted: number;
  /** Successful LLM releases via the wrapped LLM token. */
  released: number;
  /** Total LLM-layer rejections. */
  rejected: number;
  /** LLM-layer rejections by reason. */
  rejectedByReason: Partial<Record<LLMRejectReason, number>>;
};

export type LLMStats = {
  /** Underlying async-bulkhead-ts stats. */
  bulkhead: Stats;
  /** LLM-layer request stats. */
  llm: LLMRequestStats;
  /** Present only when `tokenBudget` is configured. */
  tokenBudget?: {
    budget: number;
    inFlightTokens: number;
    available: number;
    /**
     * Cumulative tokens reserved at admission across all successful
     * admissions. Monotonically increasing.
     */
    totalReserved: number;
    /**
     * Cumulative actual tokens consumed (`usage.input + usage.output`),
     * summed across releases that reported `TokenUsage`. Releases without
     * usage contribute 0 — `totalConsumed` is meaningful only when
     * `getUsage` is wired up consistently. Not clamped: over-consumption
     * (actual > reserved) is reported as-is.
     */
    totalConsumed: number;
    /**
     * Cumulative tokens returned to the budget via the refund mechanism —
     * both early refunds from `reportUsage()` and refunds at release.
     */
    totalRefunded: number;
    /**
     * Cumulative tokens held *beyond* original reservations because
     * `reportUsage()` reported consumption exceeding the reserved hold.
     * Overrun expands `inFlightTokens` (possibly above `budget`), which
     * correctly blocks new admissions until the overrunning work releases.
     */
    totalOverrun: number;
    /** Budget headroom reserved for `priority: "high"` requests. */
    highPriorityReserve: number;
  };
  /** Present only when deduplication is enabled. */
  deduplication?: {
    /** Number of distinct in-flight deduplication keys. */
    active: number;
    /** Cumulative requests that shared an existing in-flight call. */
    hits: number;
  };
};

// ────────────────────────────────────────────
// Event system
// ────────────────────────────────────────────

export type LLMEventMap = {
  /** Fired after a request is admitted (slot + budget acquired). */
  admit: {
    request: LLMRequest;
    admissionId: string;
    priority: LLMPriority;
    reservedTokens: number;
  };
  /** Fired when a request is rejected at any stage. */
  reject: {
    request: LLMRequest;
    reason: LLMRejectReason;
    /** Capacity snapshot; absent for dedup-wait rejections. */
    detail?: LLMRejectDetail;
  };
  /**
   * Fired when a slot is released.
   *
   * `reservedTokens` is the pre-admission reservation (input estimate +
   * `max_tokens` reservation). `refundedTokens` is what was returned to
   * the budget — non-zero only when `usage` was reported and
   * `usage.input + usage.output < reservedTokens`.
   *
   * Per-request actual consumption: `usage ? usage.input + usage.output : null`.
   * The library does not pre-derive this onto the event payload — `null`
   * (no usage reported) and `0` (genuinely zero usage) are different
   * states that observers should distinguish.
   *
   * For cumulative consumption across all releases, prefer
   * `stats().tokenBudget.totalConsumed` over aggregating these events.
   */
  release: {
    request: LLMRequest;
    admissionId: string;
    priority: LLMPriority;
    reservedTokens: number;
    /** Tokens held immediately before release returned them. */
    heldTokens: number;
    refundedTokens: number;
    /** Last emitted usage-event sequence for this admission. */
    usageSequence: number;
    usage?: TokenUsage;
  };
  /**
   * Fired after an effective cumulative `reportUsage()` update.
   *
   * Stale or duplicate reports that do not increase either cumulative
   * usage field are ignored and do not emit an event. `sequence` starts at
   * 1 per admission and increases monotonically, allowing external
   * coordinators to reject duplicate or out-of-order updates.
   */
  usage: {
    request: LLMRequest;
    admissionId: string;
    priority: LLMPriority;
    sequence: number;
    reservedTokens: number;
    previousHeldTokens: number;
    heldTokens: number;
    deltaTokens: number;
    usage: TokenUsage;
    outputCap: number | null;
    outputRemaining: number | null;
    overReservation: boolean;
  };
  /** Fired when a request joins an existing in-flight call via dedup. */
  dedup: { request: LLMRequest };
};

export type LLMEventType = keyof LLMEventMap;
export type Listener<K extends LLMEventType> = (payload: LLMEventMap[K]) => void;

// ────────────────────────────────────────────
// Token budget options
// ────────────────────────────────────────────

export type TokenBudgetOptions = {
  /**
   * Maximum tokens allowed in-flight simultaneously across all active requests.
   * Admission is always fail-fast when this ceiling is reached,
   * independent of concurrency headroom and independent of `profile`.
   *
   * Must be a non-negative integer. `0` is valid and intentional — it
   * represents a pool with no budget to grant this cycle (e.g. a lease
   * ledger reporting exhaustion) and results in every budget-gated
   * admission being rejected with `"budget_limit"` until the ceiling is
   * raised (via `setBudget()`) or `tokenBudget` admits a zero-token
   * request.
   */
  budget: number;


  /**
   * Estimator used to calculate token reservation pre-admission.
   * Defaults to `createModelAwareTokenEstimator` seeded with the bulkhead's `model`.
   */
  estimator?: TokenEstimator;

  /**
   * Fallback output reservation when `request.max_tokens` is absent.
   * Default: 2048.
   */
  outputCap?: number;

  /**
   * Tokens of budget headroom reserved for `priority: "high"` requests.
   *
   * Normal-priority admission is checked against
   * `budget - highPriorityReserve`; high-priority admission is checked
   * against the full `budget`. This lets interactive traffic keep
   * admitting while batch traffic has saturated the shared pool.
   *
   * Must satisfy `0 <= highPriorityReserve <= budget`. Default: 0
   * (priority has no effect).
   */
  highPriorityReserve?: number;
};

// ────────────────────────────────────────────
// Deduplication options
// ────────────────────────────────────────────

export type DeduplicationOptions = {
  /**
   * Custom function to derive a deduplication key from a request.
   * Requests with the same key that arrive while a matching call is
   * already in-flight share that call.
   *
   * Default (v3.4): a key-order-stable serialization of the **entire
   * request object**. Any own enumerable property difference —
   * `temperature`, `tools`, `system`, etc., not just `messages` /
   * `max_tokens` / `model` — prevents conflation. The tradeoff: volatile
   * per-request fields (request IDs, timestamps) also defeat
   * deduplication. If your requests carry such fields, supply a `keyFn`
   * that omits them. Non-serializable values (functions, symbols) are
   * dropped by JSON serialization and do not distinguish requests.
   *
   * Keys are SHA-256 hashed before being stored, so the in-flight map
   * never retains prompt text and per-entry key memory is bounded.
   *
   * Deduplication applies to `run()` only — `acquire()` never
   * deduplicates.
   *
   * **Multi-tenant callers:** the default key has no tenant dimension.
   * Two tenants sending byte-identical requests would share one
   * response. Pass `dedupScope` (per-call, on `run()` options) or bake
   * the tenant into a custom `keyFn` to prevent cross-tenant sharing.
   *
   * Return an empty string to opt a specific request out of deduplication.
   */
  keyFn?: (request: LLMRequest) => string;

  /**
   * Fan-out hook for delivering a shared in-flight result to
   * deduplication *followers* (v3.5).
   *
   * Called once per follower with the leader's resolved result; the
   * return value is what that follower receives. The leader always
   * receives the original result — `shareResult` is never called for
   * the leader.
   *
   * Why this exists: without it, followers receive the *same object*
   * the leader does. For plain JSON results that is fine (and remains
   * the default), but single-consumer values — `ReadableStream`,
   * Node `Readable`, async iterables, `Response` bodies — can only be
   * consumed once. Whichever caller reads first wins; the rest get a
   * locked or drained stream. The library cannot tee arbitrary stream
   * types on your behalf, so it provides this seam instead:
   *
   * ```ts
   * // fetch Response: hand each follower an independent clone.
   * // (clone() must be called before any consumer reads the body —
   * //  guaranteed here, since fan-out happens at resolution time.)
   * deduplication: { shareResult: (r) => (r as Response).clone() }
   * ```
   *
   * When `shareResult` is provided it is called for **every** follower
   * delivery, including safe (non-stream) results — it is a general
   * fan-out policy, usable e.g. for defensive deep-cloning.
   *
   * If `shareResult` throws, that follower's `run()` rejects with the
   * thrown error as-is; the leader and other followers are unaffected.
   *
   * When `shareResult` is **not** provided and the shared result is
   * detected as single-consumer, followers are rejected with
   * `LLMBulkheadRejectedError("unshareable_result")` rather than being
   * silently handed a stream they cannot read. Detection is shallow:
   * it inspects the result value itself, not nested properties — a
   * stream buried inside `{ stream: ... }` is not detected and will be
   * shared by reference as before.
   */
  shareResult?: (result: unknown) => unknown;
};

// ────────────────────────────────────────────
// Core options
// ────────────────────────────────────────────

export type LLMBulkheadOptions = {
  /**
   * Model identifier. Used by the default estimator for ratio lookup.
   *
   * One bulkhead per model is the strongly recommended deployment pattern.
   * When routing multiple models through one bulkhead, set `model` on
   * individual `LLMRequest` objects for accurate estimation.
   */
  model: string;

  /** Maximum number of requests in-flight simultaneously. */
  maxConcurrent: number;

  /**
   * Maximum number of requests waiting for admission.
   * Default: 0 (fail-fast). Prefer setting via `profile`.
   */
  maxQueue?: number;

  /**
   * Waiting timeout in milliseconds. Applies to queued requests only.
   * Has no effect when `maxQueue` is 0.
   */
  timeoutMs?: number;

  /**
   * Opinionated defaults for common deployment patterns.
   * Explicit options always override profile defaults.
   */
  profile?: "interactive" | "batch" | LLMBulkheadPreset;

  /**
   * Token budget enforcement. Admission fails fast when the in-flight token
   * ceiling is reached, regardless of concurrency headroom or `profile`.
   * Omit to disable token-aware admission.
   */
  tokenBudget?: TokenBudgetOptions;

  /**
   * Enable in-flight request deduplication.
   *
   * - `true` — use the default key function
   * - `DeduplicationOptions` — customize the key function
   * - `false` / omitted — disabled
   */
  deduplication?: boolean | DeduplicationOptions;
};

// ────────────────────────────────────────────
// LLM token (extended with refund)
// ────────────────────────────────────────────

/**
 * Snapshot returned by `LLMToken.reportUsage()`.
 *
 * `outputCap` / `outputRemaining` are `null` when `tokenBudget` is not
 * configured (there is no reservation to measure against).
 */
export type UsageReport = {
  /** Stable identifier of the admission this usage belongs to. */
  admissionId: string;
  /**
   * Last effective usage-update sequence for this admission.
   * Starts at 0 before any effective report, increments only when either
   * cumulative usage field increases, and remains stable for stale reports.
   */
  sequence: number;
  /** Original pre-admission reservation (0 when budget disabled). */
  reserved: number;
  /** Tokens currently held against the budget for this request. */
  held: number;
  /** Cumulative reported consumption (`input + output`). */
  consumed: number;
  /** Output tokens reserved for this request (`max_tokens`/`outputCap`). */
  outputCap: number | null;
  /** Output reservation remaining before the stream overruns it. */
  outputRemaining: number | null;
  /** True once cumulative consumption exceeds the original reservation. */
  overReservation: boolean;
};

/** Context passed to `run()` callbacks for mid-flight usage reporting. */
export type LLMRunContext = {
  /** Stable identifier for this successful admission. */
  readonly admissionId: string;
  /** Exact reservation used at admission, or `null` without a token budget. */
  readonly reservation: LLMReservationEstimate | null;
  reportUsage(usage: TokenUsage): UsageReport;
};

/**
 * Admission token returned by `acquire()`.
 *
 * Call `release()` exactly once when the request completes.
 * Pass `TokenUsage` to enable the refund mechanism — the bulkhead
 * returns the difference between the pre-admission reservation and
 * actual consumption to the budget immediately.
 *
 * For streaming workloads, call `reportUsage()` with *cumulative* usage
 * as stream events arrive:
 *
 * - If the reported input is lower than the pre-admission estimate, the
 *   surplus is refunded to the budget immediately (the full output
 *   reservation is retained).
 * - If reported consumption exceeds the hold, the hold expands (overrun),
 *   which blocks new admissions until this request releases.
 * - Reports are clamped to be monotonically non-decreasing per field.
 * - If `release()` is later called without usage, the last reported
 *   usage is used for the final refund.
 */
export type LLMToken = {
  /** Stable identifier for this successful admission. */
  readonly admissionId: string;
  /** Exact reservation used at admission, or `null` without a token budget. */
  readonly reservation: LLMReservationEstimate | null;
  release(usage?: TokenUsage): void;
  reportUsage(usage: TokenUsage): UsageReport;
};

export type LLMAcquireResult =
  | {
      ok: true;
      admissionId: string;
      reservation: LLMReservationEstimate | null;
      token: LLMToken;
    }
  | { ok: false; reason: LLMRejectReason; detail?: LLMRejectDetail };
