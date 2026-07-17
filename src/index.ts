import {
  createBulkhead,
  type AcquireOptions,
  type Stats,
  type Token,
  type RejectReason as BaseRejectReason,
} from "async-bulkhead-ts";

type BulkheadSignal = NonNullable<AcquireOptions["signal"]>;

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
 * Built-in estimators ignore non-text blocks — token estimates for
 * multimodal requests should be treated as a lower bound.
 * Provide a custom estimator for accurate multimodal estimation.
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
};

// ────────────────────────────────────────────
// Token estimation types
// ────────────────────────────────────────────

export type TokenEstimate = {
  input: number;
  maxOutput: number;
};

export type TokenEstimator = (request: LLMRequest) => TokenEstimate;

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

export type LLMRejectReason = BaseRejectReason | "budget_limit";

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
};

export class LLMBulkheadRejectedError extends Error {
  readonly code = "LLM_BULKHEAD_REJECTED" as const;
  readonly detail: LLMRejectDetail | undefined;

  constructor(reason: LLMRejectReason, detail?: LLMRejectDetail);
  constructor(
    readonly reason: LLMRejectReason,
    detail?: LLMRejectDetail,
  ) {
    super(`LLM bulkhead rejected: ${reason}`);
    this.name = "LLMBulkheadRejectedError";
    this.detail = detail;
  }
}

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
  admit: { request: LLMRequest; reservedTokens: number };
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
    reservedTokens: number;
    refundedTokens: number;
    usage?: TokenUsage;
  };
  /** Fired when a request joins an existing in-flight call via dedup. */
  dedup: { request: LLMRequest };
};

export type LLMEventType = keyof LLMEventMap;
type Listener<K extends LLMEventType> = (payload: LLMEventMap[K]) => void;

// ────────────────────────────────────────────
// Profile / preset
// ────────────────────────────────────────────

export type LLMBulkheadPreset = {
  maxQueue?: number;
  timeoutMs?: number;
};

/**
 * Built-in presets for common deployment patterns.
 * Explicit options always override preset defaults.
 */
export const PROFILES: Record<"interactive" | "batch", LLMBulkheadPreset> = {
  interactive: { maxQueue: 0 },
  batch: { maxQueue: 20, timeoutMs: 30_000 },
};

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
   * Default: `JSON.stringify({ m: request.messages, t: request.max_tokens, o: request.model })`.
   *
   * Return an empty string to opt a specific request out of deduplication.
   */
  keyFn?: (request: LLMRequest) => string;
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
  release(usage?: TokenUsage): void;
  reportUsage(usage: TokenUsage): UsageReport;
};

export type LLMAcquireResult =
  | { ok: true; token: LLMToken }
  | { ok: false; reason: LLMRejectReason; detail?: LLMRejectDetail };

// ────────────────────────────────────────────
// Estimator internals
// ────────────────────────────────────────────

const DEFAULT_OUTPUT_CAP = 2_048;
const NAIVE_CHAR_RATIO = 4.0;

function isNonNegativeInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!isNonNegativeInteger(value)) {
    throw new Error(`${name} must be an integer >= 0`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertOptionalNonNegativeInteger(
  value: number | undefined,
  name: string,
): void {
  if (value !== undefined) assertNonNegativeInteger(value, name);
}

function validateTokenEstimate(estimate: TokenEstimate): number {
  assertNonNegativeInteger(estimate.input, "token estimator input");
  assertNonNegativeInteger(estimate.maxOutput, "token estimator maxOutput");
  const needed = estimate.input + estimate.maxOutput;
  assertNonNegativeInteger(needed, "token reservation");
  return needed;
}

function validateTokenUsage(usage: TokenUsage): TokenUsage {
  assertNonNegativeInteger(usage.input, "token usage input");
  assertNonNegativeInteger(usage.output, "token usage output");
  const actual = usage.input + usage.output;
  assertNonNegativeInteger(actual, "token usage total");
  return usage;
}

/**
 * Extract total character count from message content.
 * Handles both plain strings and multimodal content block arrays.
 * Non-text blocks are ignored (contribute 0 characters).
 */
export function extractTextLength(
  content: string | ContentBlock[],
): number {
  if (typeof content === "string") return content.length;
  let len = 0;
  for (const block of content) {
    if (
      block.type === "text" &&
      "text" in block &&
      typeof (block as TextContentBlock).text === "string"
    ) {
      len += (block as TextContentBlock).text.length;
    }
  }
  return len;
}

function resolveMaxOutput(request: LLMRequest, fallback: number): number {
  assertNonNegativeInteger(fallback, "outputCap");
  assertOptionalNonNegativeInteger(request.max_tokens, "request.max_tokens");
  return request.max_tokens ?? fallback;
}

/**
 * Estimates token usage using a flat 4-characters-per-token ratio.
 *
 * Handles both plain string and multimodal content.
 * Non-text content blocks are ignored (treated as zero tokens).
 *
 * Accuracy: ±25% for English prose.
 * Suitable for load-shedding; not suitable for cost accounting.
 */
export function naiveTokenEstimator(request: LLMRequest): TokenEstimate {
  const inputChars = request.messages.reduce(
    (sum, m) => sum + extractTextLength(m.content),
    0,
  );
  return {
    input: Math.ceil(inputChars / NAIVE_CHAR_RATIO),
    maxOutput: resolveMaxOutput(request, DEFAULT_OUTPUT_CAP),
  };
}

/**
 * Per-model character-to-token ratios.
 * Flat array of [prefix, ratio] pairs — longest matching prefix wins.
 */
const BUILT_IN_RATIOS: ReadonlyArray<readonly [string, number]> = [
  // Anthropic — Claude 3.x
  ["claude-3-5-haiku", 3.8],
  ["claude-3-5-sonnet", 3.9],
  ["claude-3-opus", 3.9],
  ["claude-3-sonnet", 3.9],
  ["claude-3-haiku", 3.8],
  // Anthropic — Claude 4.x
  ["claude-sonnet-4", 3.9],
  ["claude-opus-4", 3.9],
  ["claude-haiku-4", 3.8],
  // Anthropic — Claude 4.5
  ["claude-sonnet-4-5", 3.9],
  ["claude-opus-4-5", 3.9],
  ["claude-haiku-4-5", 3.8],
  // OpenAI — GPT
  ["gpt-4o", 3.7],
  ["gpt-4-turbo", 3.7],
  ["gpt-4.1", 3.7],
  ["gpt-4", 3.7],
  ["gpt-3.5", 3.8],
  // OpenAI — reasoning
  ["o1", 3.7],
  ["o3", 3.7],
  ["o4-mini", 3.7],
  // Google — Gemini
  ["gemini-2.5", 3.8],
  ["gemini-2", 3.8],
  ["gemini-1.5", 3.8],
];

export type ModelAwareEstimatorOptions = {
  /**
   * Model string used for ratio lookup when the request does not
   * carry its own `model` field. Should match the `model` field on
   * the owning `LLMBulkhead`.
   */
  defaultModel?: string | undefined;

  /**
   * Fallback output reservation when `request.max_tokens` is absent.
   * Default: 2048.
   */
  outputCap?: number | undefined;

  /**
   * Called when the model string matches no built-in prefix and no override.
   * The estimator falls back to the naive 4.0 ratio when this fires.
   */
  onUnknownModel?: ((model: string) => void) | undefined;
};

function isModelAwareEstimatorOptions(
  value: unknown,
): value is ModelAwareEstimatorOptions {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (
    "defaultModel" in value ||
    "outputCap" in value ||
    "onUnknownModel" in value
  );
}

/**
 * Estimates token usage using per-model character ratios.
 *
 * Accuracy: ±15% for known models on English prose.
 * Falls back to naiveTokenEstimator (ratio 4.0) for unknown models.
 *
 * v2: respects `request.model` when present, falling back to `defaultModel`.
 * v2: handles multimodal content (text blocks counted, others ignored).
 */
export function createModelAwareTokenEstimator(
  opts?: ModelAwareEstimatorOptions,
): TokenEstimator;
export function createModelAwareTokenEstimator(
  overrides?: Record<string, number>,
  opts?: ModelAwareEstimatorOptions,
 ): TokenEstimator;
 export function createModelAwareTokenEstimator(
  overridesOrOpts?: Record<string, number> | ModelAwareEstimatorOptions,
  maybeOpts?: ModelAwareEstimatorOptions,
 ): TokenEstimator {
  const hasSingleOptionsArg =
    maybeOpts === undefined &&
    isModelAwareEstimatorOptions(overridesOrOpts);

  const overrides = hasSingleOptionsArg
    ? undefined
    : (overridesOrOpts as Record<string, number> | undefined);
  const opts = hasSingleOptionsArg
    ? overridesOrOpts
    : (maybeOpts ?? {});
  const outputCap = opts.outputCap ?? DEFAULT_OUTPUT_CAP;
  assertNonNegativeInteger(outputCap, "outputCap");

  function lookupRatio(model: string): number {
    // Exact overrides checked first (case-sensitive, then lowercased).
    if (overrides) {
      const exact = overrides[model] ?? overrides[model.toLowerCase()];
      if (exact != null) return exact;
    }

    // Prefix scan: lowercase, longest match wins.
    const normalized = model.toLowerCase();
    let bestLen = 0;
    let bestRatio = -1;
    for (const [prefix, ratio] of BUILT_IN_RATIOS) {
      if (normalized.startsWith(prefix) && prefix.length > bestLen) {
        bestLen = prefix.length;
        bestRatio = ratio;
      }
    }

    if (bestRatio > 0) return bestRatio;

    opts.onUnknownModel?.(model);
    return NAIVE_CHAR_RATIO;
  }

  return (request: LLMRequest): TokenEstimate => {
    const model = request.model ?? opts.defaultModel ?? "";
    const ratio = lookupRatio(model);
    const inputChars = request.messages.reduce(
      (sum, m) => sum + extractTextLength(m.content),
      0,
    );
    return {
      input: Math.ceil(inputChars / ratio),
      maxOutput: resolveMaxOutput(request, outputCap),
    };
  };
}

// ────────────────────────────────────────────
// Option resolution
// ────────────────────────────────────────────

function resolvePreset(
  profile: LLMBulkheadOptions["profile"],
): LLMBulkheadPreset {
  if (!profile) return {};
  if (typeof profile === "string") return PROFILES[profile];
  return profile;
}

function resolveDedup(
  opt: LLMBulkheadOptions["deduplication"],
): { enabled: boolean; keyFn: (request: LLMRequest) => string } {
  if (!opt) return { enabled: false, keyFn: defaultDedupKey };
  if (opt === true) return { enabled: true, keyFn: defaultDedupKey };
  return { enabled: true, keyFn: opt.keyFn ?? defaultDedupKey };
}

/**
 * Default deduplication key.
 *
 * v2: includes `max_tokens` and `model` so that requests with
 * identical messages but different output limits or models are
 * not conflated.
 */
function defaultDedupKey(request: LLMRequest): string {
  try {
    return JSON.stringify({
      m: request.messages,
      t: request.max_tokens,
      o: request.model,
    });
  } catch {
    return "";
  }
}

// ────────────────────────────────────────────
// createLLMBulkhead
// ────────────────────────────────────────────

export function createLLMBulkhead(opts: LLMBulkheadOptions) {
  // ---- Validate ----
  if (typeof opts.model !== "string" || opts.model.trim() === "") {
    throw new Error("model must be a non-empty string");
  }
  assertPositiveInteger(opts.maxConcurrent, "maxConcurrent");

  // ---- Resolve profile defaults ----
  const preset = resolvePreset(opts.profile);
  const maxQueue = opts.maxQueue ?? preset.maxQueue ?? 0;
  const timeoutMs = opts.timeoutMs ?? preset.timeoutMs;
  assertNonNegativeInteger(maxQueue, "maxQueue");
  assertOptionalNonNegativeInteger(timeoutMs, "timeoutMs");
  if (opts.tokenBudget) {
    assertNonNegativeInteger(opts.tokenBudget.budget, "tokenBudget.budget");

    assertOptionalNonNegativeInteger(
      opts.tokenBudget.outputCap,
      "tokenBudget.outputCap",
    );
    assertOptionalNonNegativeInteger(
      opts.tokenBudget.highPriorityReserve,
      "tokenBudget.highPriorityReserve",
    );
    if (
      opts.tokenBudget.highPriorityReserve !== undefined &&
      opts.tokenBudget.highPriorityReserve > opts.tokenBudget.budget
    ) {
      throw new Error(
        "tokenBudget.highPriorityReserve must be <= tokenBudget.budget",
      );
    }
  }

  // ---- Internal bulkhead from async-bulkhead-ts ----
  const bulkhead = createBulkhead({
    maxConcurrent: opts.maxConcurrent,
    maxQueue,
  });

  // ---- Token budget state ----
  const budget = opts.tokenBudget;
  const estimator =
    budget?.estimator ??
    createModelAwareTokenEstimator(undefined, {
      defaultModel: opts.model,
      outputCap: budget?.outputCap,
    });

  const highPriorityReserve = budget?.highPriorityReserve ?? 0;

  /**
   * Mutable budget ceiling, initialized from `tokenBudget.budget`.
   * `undefined` when `tokenBudget` was never configured — `setBudget()`
   * throws in that case rather than silently no-op'ing.
   * Mutated only by `setBudget()`. All admission math reads this value
   * (via `effectiveBudget()`), not the frozen `opts.tokenBudget.budget`,
   * so budget changes take effect on the very next admission check.
   */
  let currentBudget: number | undefined = budget?.budget;

  let inFlightTokens = 0;

  let totalReserved = 0;
  let totalConsumed = 0;
  let totalRefunded = 0;
  let totalOverrun = 0;
  let llmAdmitted = 0;
  let llmReleased = 0;
  let llmRejected = 0;
  const llmRejectedByReason: Partial<Record<LLMRejectReason, number>> = {};

  // ---- Deduplication state ----
  const dedup = resolveDedup(opts.deduplication);
  const dedupMap = new Map<string, Promise<unknown>>();
  let dedupHits = 0;

  // ---- Event emitter state ----
  const listeners: { [K in LLMEventType]: Set<Listener<K>> } = {
    admit: new Set(),
    reject: new Set(),
    release: new Set(),
    dedup: new Set(),
  };

  function emit<K extends LLMEventType>(
    event: K,
    payload: LLMEventMap[K],
  ): void {
    for (const fn of listeners[event]) {
      try {
        fn(payload);
      } catch {
        // listeners must not throw into the bulkhead
      }
    }
  }

  function noteLLMAdmit(): void {
    llmAdmitted++;
  }

  function noteLLMRelease(): void {
    llmReleased++;
  }

  function noteLLMReject(reason: LLMRejectReason): void {
    llmRejected++;
    llmRejectedByReason[reason] =
      (llmRejectedByReason[reason] ?? 0) + 1;
  }
  // ---- Internal helpers ----

  function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Estimate parts kept per-token so streaming reports can re-derive holds. */
  type ReservationParts = {
    input: number;
    maxOut: number;
    reserved: number;
  };

  function estimateParts(request: LLMRequest): ReservationParts | null {
    if (!budget) return null;
    const estimate = estimator(request);
    const reserved = validateTokenEstimate(estimate);
    return { input: estimate.input, maxOut: estimate.maxOutput, reserved };
  }

  function resolvePriority(priority: LLMPriority | undefined): LLMPriority {
    if (priority === undefined) return "normal";
    if (priority !== "high" && priority !== "normal") {
      throw new Error(`priority must be "high" or "normal"`);
    }
    return priority;
  }

  /** Budget ceiling applicable to a request at the given priority. */
  function effectiveBudget(priority: LLMPriority): number {
    if (!budget) return Infinity;
    return priority === "high"
      ? currentBudget!
      : currentBudget! - highPriorityReserve;
  }


  /**
   * Attempt token budget admission synchronously for a precomputed
   * reservation. Returns false if the priority-adjusted ceiling is
   * exceeded.
   */
  function tryReserveTokens(reserved: number, priority: LLMPriority): boolean {
    if (!budget) return true;
    if (inFlightTokens + reserved > effectiveBudget(priority)) return false;
    inFlightTokens += reserved;
    totalReserved += reserved;
    return true;
  }

  function releaseTokens(held: number, usage?: TokenUsage): number {
    let refunded = 0;
    if (usage && held > 0) {
      const actual = usage.input + usage.output;
      totalConsumed += actual;
      if (actual < held) {
        refunded = held - actual;
        totalRefunded += refunded;
      }
    }
    inFlightTokens = Math.max(0, inFlightTokens - held);
    return refunded;
  }

  /** Capacity snapshot for rejection results, events, and errors. */
  function buildRejectDetail(
    requested: number,
    priority: LLMPriority,
  ): LLMRejectDetail {
    const base = bulkhead.stats();
    const detail: LLMRejectDetail = {
      inFlight: base.inFlight,
      pending: base.pending,
      maxConcurrent: base.maxConcurrent,
      maxQueue: base.maxQueue,
    };
    if (budget) {
      const eff = effectiveBudget(priority);
      detail.tokenBudget = {
        budget: currentBudget!,
        inFlightTokens,
        effectiveBudget: eff,
        available: Math.max(0, eff - inFlightTokens),
        requested,
      };
    }
    return detail;
  }

  /**
   * Update the token budget ceiling at runtime.
   *
   * Semantics (deliberate, not incidental):
   *
   * - **Raising takes effect immediately.** The very next admission check
   *   reads the new ceiling via `effectiveBudget()` — no caching to
   *   invalidate, no in-flight work touched.
   * - **Lowering below `inFlightTokens` is legal — shrink by attrition.**
   *   No in-flight work is revoked or cancelled. New admissions reject
   *   with `"budget_limit"` until enough in-flight work releases to bring
   *   `inFlightTokens` back under the new ceiling. This mirrors the
   *   library's existing overrun tolerance (`inFlightTokens` can already
   *   exceed `budget` via `reportUsage()` overrun) — over-budget in-flight
   *   state is an established, intentional condition, not an invariant
   *   violation.
   * - **Throws if `tokenBudget` was never configured.** An explicit error
   *   beats a silent no-op — there is no budget ceiling to adjust.
   * - **Validation:** `tokens` must be a non-negative integer.
   */
  function setBudget(tokens: number): void {
    if (!budget) {
      throw new Error(
        "setBudget requires tokenBudget to be configured at construction",
      );
    }
    assertNonNegativeInteger(tokens, "tokens");
    currentBudget = tokens;
  }


  function normalizeAcquireOptions(ao: AcquireOptions): AcquireOptions {
    const normalized: AcquireOptions = {};
    if (ao.signal !== undefined) normalized.signal = ao.signal;
    const effectiveTimeoutMs = ao.timeoutMs ?? timeoutMs;
    if (effectiveTimeoutMs !== undefined) {
      assertNonNegativeInteger(effectiveTimeoutMs, "timeoutMs");
      normalized.timeoutMs = effectiveTimeoutMs;
    }
    return normalized;
  }

  function noteDedupWaitRejection(
    request: LLMRequest,
    reason: Extract<LLMRejectReason, "aborted" | "timeout">,
  ): LLMBulkheadRejectedError {
    noteLLMReject(reason);
    emit("reject", { request, reason });
    return new LLMBulkheadRejectedError(reason);
  }

  function waitForSharedDedup<T>(
    shared: Promise<T>,
    request: LLMRequest,
    ao: AcquireOptions,
  ): Promise<T> {
    const normalized = normalizeAcquireOptions(ao);
    const signal = normalized.signal;
    const effectiveTimeoutMs = normalized.timeoutMs;

    if (signal?.aborted) {
      return Promise.reject(noteDedupWaitRejection(request, "aborted"));
    }
    if (signal === undefined && effectiveTimeoutMs === undefined) {
      return shared;
    }

    return new Promise<T>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const cleanup = () => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        if (signal !== undefined) {
          signal.removeEventListener("abort", onAbort);
        }
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const onAbort = () => {
        settle(() => {
          reject(noteDedupWaitRejection(request, "aborted"));
        });
      };

      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (effectiveTimeoutMs !== undefined) {
        timeoutId = setTimeout(() => {
          settle(() => {
            reject(noteDedupWaitRejection(request, "timeout"));
          });
        }, effectiveTimeoutMs);
      }

      void shared.then(
        (value) => settle(() => resolve(value)),
        (err) => settle(() => reject(err)),
      );
    });
  }

  /**
   * Wraps a base Token so that release() also returns the token
   * reservation and optionally applies the refund, and so that
   * streaming callers can report cumulative usage mid-flight.
   */
  function wrapToken(
    base: Token,
    parts: ReservationParts | null,
    request: LLMRequest,
  ): LLMToken {
    let released = false;
    /** Tokens currently held against the budget for this request. */
    let held = parts?.reserved ?? 0;
    /** Last reported cumulative usage (monotonically clamped). */
    let reported: TokenUsage | undefined;

    const snapshot = (): UsageReport => {
      const consumed = reported
        ? reported.input + reported.output
        : 0;
      const outputCap = parts ? parts.maxOut : null;
      return {
        reserved: parts?.reserved ?? 0,
        held,
        consumed,
        outputCap,
        outputRemaining:
          outputCap === null
            ? null
            : Math.max(0, outputCap - (reported?.output ?? 0)),
        overReservation: parts ? consumed > parts.reserved : false,
      };
    };

    const reportUsage = (usage: TokenUsage): UsageReport => {
      const valid = validateTokenUsage(usage);
      // Clamp to monotonic non-decreasing per field — cumulative
      // stream usage never shrinks; a lower report is stale.
      reported = reported
        ? {
            input: Math.max(reported.input, valid.input),
            output: Math.max(reported.output, valid.output),
          }
        : valid;

      // Accounting only applies pre-release with a budget configured.
      if (!released && parts && budget) {
        // Hold = known input + the larger of (output ceiling, actual output).
        // Keeps the full output reservation while refunding input
        // over-estimates immediately; expands on output overrun.
        const newHold =
          reported.input + Math.max(parts.maxOut, reported.output);
        const delta = newHold - held;
        if (delta > 0) {
          inFlightTokens += delta;
          totalOverrun += delta;
        } else if (delta < 0) {
          const refund = -delta;
          inFlightTokens = Math.max(0, inFlightTokens - refund);
          totalRefunded += refund;
        }
        held = newHold;
      }
      return snapshot();
    };

    return {
      reportUsage,
      release(usage?: TokenUsage) {
        if (released) return;
        released = true;

        let validUsage: TokenUsage | undefined;
        let usageError: unknown;
        if (usage !== undefined) {
          try {
            validUsage = validateTokenUsage(usage);
          } catch (err) {
            usageError = err;
          }
        }
        // Fall back to the last mid-flight report when no (valid)
        // explicit usage is provided at release.
        if (validUsage === undefined && reported !== undefined) {
          validUsage = reported;
        }

        try {
          base.release();
        } finally {
          const refunded = releaseTokens(held, validUsage);
          noteLLMRelease();
          emit("release", {
            request,
            reservedTokens: parts?.reserved ?? 0,
            refundedTokens: refunded,
            ...(validUsage !== undefined && { usage: validUsage }),
          });
        }

        if (usageError !== undefined) throw usageError;
      },
    };
  }

  // ---- Internal acquire ----

  async function _acquire(
    request: LLMRequest,
    ao: LLMAcquireOptions,
  ): Promise<LLMAcquireResult> {
    assertOptionalNonNegativeInteger(request.max_tokens, "request.max_tokens");
    const priority = resolvePriority(ao.priority);
    const parts = estimateParts(request);
    const reserved = parts?.reserved ?? 0;

    const rejectWith = (reason: LLMRejectReason): LLMAcquireResult => {
      const detail = buildRejectDetail(reserved, priority);
      noteLLMReject(reason);
      emit("reject", { request, reason, detail });
      return { ok: false, reason, detail };
    };

    // Token budget: pre-check before entering the queue.
    if (budget && inFlightTokens + reserved > effectiveBudget(priority)) {
      return rejectWith("budget_limit");
    }

    const mergedOptions = normalizeAcquireOptions(ao);

    const r = await bulkhead.acquire(mergedOptions);

    if (!r.ok) {
      return rejectWith(r.reason);
    }

    // Post-admission: reserve the precomputed amount now.
    if (!tryReserveTokens(reserved, priority)) {
      r.token.release();
      return rejectWith("budget_limit");
    }

    noteLLMAdmit();
    emit("admit", { request, reservedTokens: reserved });
    return { ok: true, token: wrapToken(r.token, parts, request) };
  }

  // ---- Public API ----

  /**
   * Acquire a slot manually.
   *
   * The returned token accepts optional `TokenUsage` at release time
   * to trigger the refund mechanism. For most use cases, prefer `run()`.
   */
  async function acquire(
    request: LLMRequest,
    ao: LLMAcquireOptions = {},
  ): Promise<LLMAcquireResult> {
    return _acquire(request, ao);
  }

  /**
   * Advisory dry-run: would a request of this shape be admitted right
   * now at the given priority?
   *
   * This is a snapshot for routing decisions (e.g. pick a different
   * model pool). It does NOT reserve anything — the answer can change
   * before a subsequent `acquire()`/`run()` lands. Never treat `true`
   * as a guarantee.
   */
  function wouldAdmit(
    request: LLMRequest,
    opts: { priority?: LLMPriority } = {},
  ): { admit: boolean; reason?: LLMRejectReason } {
    const priority = resolvePriority(opts.priority);
    const base = bulkhead.stats();
    if (base.closed) return { admit: false, reason: "shutdown" };
    const parts = estimateParts(request);
    const reserved = parts?.reserved ?? 0;
    if (budget && inFlightTokens + reserved > effectiveBudget(priority)) {
      return { admit: false, reason: "budget_limit" };
    }
    if (base.inFlight < base.maxConcurrent) return { admit: true };
    if (base.pending < base.maxQueue) return { admit: true };
    return {
      admit: false,
      reason: base.maxQueue > 0 ? "queue_limit" : "concurrency_limit",
    };
  }

  /**
   * Primary API. Acquire → call `fn` → release, automatically.
   *
   * Throws `LLMBulkheadRejectedError` on rejection.
   *
   * When `getUsage` is provided in options, it is called with the result
   * of `fn` to extract actual token usage. The refund mechanism then
   * returns the difference between the reservation and actual consumption
   * to the budget.
   */
  async function run<T>(
    request: LLMRequest,
    fn: (signal?: BulkheadSignal, ctx?: LLMRunContext) => Promise<T>,
    ao: LLMAcquireOptions & {
      getUsage?: (result: T) => TokenUsage | undefined;
    } = {},
  ): Promise<T> {
    const { getUsage, ...acquireOpts } = ao;

    // ---- Deduplication ----
    let dedupKey = "";
    if (dedup.enabled) {
      try {
        dedupKey = dedup.keyFn(request);
      } catch {
        dedupKey = "";
      }
    }

    let deferred:
      | {
          promise: Promise<T>;
          resolve: (v: T) => void;
          reject: (e?: unknown) => void;
        }
      | undefined;
    let resultPromise: Promise<T> | undefined;

    if (dedup.enabled && dedupKey !== "") {
      const existing = dedupMap.get(dedupKey);
      if (existing) {
        dedupHits++;
        emit("dedup", { request });
        return waitForSharedDedup(existing as Promise<T>, request, acquireOpts);
      }
      deferred = createDeferred<T>();
      resultPromise = deferred.promise;
      dedupMap.set(dedupKey, deferred.promise);

      const cleanup = () => {
        try {
          const p = dedupMap.get(dedupKey);
          if (p === deferred!.promise) dedupMap.delete(dedupKey);
        } catch {
          // never throw from cleanup
        }
      };
      void deferred.promise.then(cleanup, cleanup);
    }

    try {
      const r = await _acquire(request, acquireOpts);
      if (!r.ok) {
        throw new LLMBulkheadRejectedError(r.reason, r.detail);
      }

      const ctx: LLMRunContext = {
        reportUsage: (usage) => r.token.reportUsage(usage),
      };

      const work = (async () => {
        let result: T;
        try {
          result = await fn(ao.signal, ctx);
        } catch (err) {
          r.token.release(); // no usage on error
          throw err;
        }

        // Extract usage for refund.
        let usage: TokenUsage | undefined;
        if (getUsage) {
          try {
            const extracted = getUsage(result);
            usage =
              extracted === undefined ? undefined : validateTokenUsage(extracted);
          } catch {
            // bad getUsage must not break release
          }
        }
        r.token.release(usage);
        return result;
      })();

      if (deferred) {
        void work.then(
          (v) => deferred.resolve(v),
          (e) => deferred.reject(e),
        );
        return resultPromise!;
      }

      return work;
    } catch (err) {
      if (deferred) {
        deferred.reject(err);
        return resultPromise!;
      }
      throw err;
    }
  }

  /** Runtime stats. Optional fields are present only when the feature is enabled. */
  function stats(): LLMStats {
    const base = bulkhead.stats();
    const result: LLMStats = {
      bulkhead: base,
      llm: {
        admitted: llmAdmitted,
        released: llmReleased,
        rejected: llmRejected,
        rejectedByReason: { ...llmRejectedByReason },
      },
    };

    if (budget) {
      result.tokenBudget = {
        budget: currentBudget!,
        inFlightTokens,
        available: Math.max(0, currentBudget! - inFlightTokens),
        totalReserved,
        totalConsumed,
        totalRefunded,
        totalOverrun,
        highPriorityReserve,
      };
    }


    if (dedup.enabled) {
      result.deduplication = {
        active: dedupMap.size,
        hits: dedupHits,
      };
    }

    return result;
  }

  /**
   * Stop admission permanently. All pending waiters in the underlying
   * bulkhead are rejected with `'shutdown'`. Future `acquire`/`run`
   * calls reject immediately. In-flight work is not interrupted.
   */
  function close(): void {
    bulkhead.close();
  }

  /**
   * Returns a promise that resolves when all in-flight work and
   * pending waiters have completed. Works with or without `close()`.
   * Compose as `close()` → `drain()` for graceful shutdown.
   */
  function drain(): Promise<void> {
    return bulkhead.drain();
  }

  /**
   * Subscribe to a bulkhead lifecycle event.
   * Returns an unsubscribe function.
   *
   * Listeners are called synchronously from the bulkhead's internal
   * control flow. They must not throw — exceptions are silently caught.
   */
  function on<K extends LLMEventType>(
    event: K,
    listener: Listener<K>,
  ): () => void {
    listeners[event].add(listener);
    return () => {
      listeners[event].delete(listener);
    };
  }

  return { acquire, run, wouldAdmit, stats, setBudget, close, drain, on };
}


export type LLMBulkhead = ReturnType<typeof createLLMBulkhead>;