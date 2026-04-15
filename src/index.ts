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

export class LLMBulkheadRejectedError extends Error {
  readonly code = "LLM_BULKHEAD_REJECTED" as const;

  constructor(readonly reason: LLMRejectReason) {
    super(`LLM bulkhead rejected: ${reason}`);
    this.name = "LLMBulkheadRejectedError";
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
  llm: LLMRequestStats;  /** Present only when `tokenBudget` is configured. */
  tokenBudget?: {
    budget: number;
    inFlightTokens: number;
    available: number;
    /** Cumulative tokens returned to the budget via the refund mechanism. */
    totalRefunded: number;
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
  reject: { request: LLMRequest; reason: LLMRejectReason };
  /** Fired when a slot is released. */
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
   * Default: `JSON.stringify({ m: request.messages, t: request.max_tokens })`.
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
 * Admission token returned by `acquire()`.
 *
 * Call `release()` exactly once when the request completes.
 * Pass `TokenUsage` to enable the refund mechanism — the bulkhead
 * returns the difference between the pre-admission reservation and
 * actual consumption to the budget immediately.
 */
export type LLMToken = {
  release(usage?: TokenUsage): void;
};

export type LLMAcquireResult =
  | { ok: true; token: LLMToken }
  | { ok: false; reason: LLMRejectReason };

// ────────────────────────────────────────────
// Estimator internals
// ────────────────────────────────────────────

const DEFAULT_OUTPUT_CAP = 2_048;
const NAIVE_CHAR_RATIO = 4.0;

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
  overrides?: Record<string, number>,
  opts: ModelAwareEstimatorOptions = {},
): TokenEstimator {
  const outputCap = opts.outputCap ?? DEFAULT_OUTPUT_CAP;

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
  if (!opts.model || typeof opts.model !== "string") {
    throw new Error("model must be a non-empty string");
  }
  if (!Number.isInteger(opts.maxConcurrent) || opts.maxConcurrent <= 0) {
    throw new Error("maxConcurrent must be a positive integer");
  }

  // ---- Resolve profile defaults ----
  const preset = resolvePreset(opts.profile);
  const maxQueue = opts.maxQueue ?? preset.maxQueue ?? 0;
  const timeoutMs = opts.timeoutMs ?? preset.timeoutMs;

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

  let inFlightTokens = 0;
  let totalRefunded = 0;
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

  /**
   * Attempt token budget admission synchronously.
   * Returns the reserved token count (0 when budget is disabled),
   * or null if the budget ceiling is exceeded.
   */
  function tryReserveTokens(request: LLMRequest): number | null {
    if (!budget) return 0;
    const estimate = estimator(request);
    const needed = estimate.input + estimate.maxOutput;
    if (inFlightTokens + needed > budget.budget) return null;
    inFlightTokens += needed;
    return needed;
  }

  function releaseTokens(reserved: number, usage?: TokenUsage): number {
    let refunded = 0;
    if (usage && reserved > 0) {
      const actual = usage.input + usage.output;
      if (actual < reserved) {
        refunded = reserved - actual;
        totalRefunded += refunded;
      }
    }
    inFlightTokens = Math.max(0, inFlightTokens - reserved);
    return refunded;
  }

  /**
   * Wraps a base Token so that release() also returns the token
   * reservation and optionally applies the refund.
   */
  function wrapToken(
    base: Token,
    reserved: number,
    request: LLMRequest,
  ): LLMToken {
    let released = false;
    return {
      release(usage?: TokenUsage) {
        if (released) return;
        released = true;
        try {
          base.release();
        } finally {
          const refunded = releaseTokens(reserved, usage);
          noteLLMRelease();
          emit("release", {
            request,
            reservedTokens: reserved,
            refundedTokens: refunded,
            ...(usage !== undefined && { usage }),
          });
        }
      },
    };
  }

  // ---- Internal acquire ----

  async function _acquire(
    request: LLMRequest,
    ao: AcquireOptions,
  ): Promise<LLMAcquireResult> {
    // Token budget: pre-check before entering the queue.
    if (budget) {
      const estimate = estimator(request);
      const needed = estimate.input + estimate.maxOutput;
      if (inFlightTokens + needed > budget.budget) {
        noteLLMReject("budget_limit");
        emit("reject", { request, reason: "budget_limit" });
        return { ok: false, reason: "budget_limit" };
      }
    }

    const mergedOptions: AcquireOptions = {};
    if (ao.signal !== undefined) mergedOptions.signal = ao.signal;
    if (ao.timeoutMs !== undefined) mergedOptions.timeoutMs = ao.timeoutMs;
    else if (timeoutMs !== undefined) mergedOptions.timeoutMs = timeoutMs;

    const r = await bulkhead.acquire(mergedOptions);

    if (!r.ok) {
      noteLLMReject(r.reason);
      emit("reject", { request, reason: r.reason });
      return { ok: false, reason: r.reason };
    }

    // Post-admission: reserve tokens now.
    const reserved = tryReserveTokens(request);
    if (reserved === null) {
      r.token.release();
      noteLLMReject("budget_limit");
      emit("reject", { request, reason: "budget_limit" });
      return { ok: false, reason: "budget_limit" };
    }

    noteLLMAdmit();
    emit("admit", { request, reservedTokens: reserved });
    return { ok: true, token: wrapToken(r.token, reserved, request) };
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
    ao: AcquireOptions = {},
  ): Promise<LLMAcquireResult> {
    return _acquire(request, ao);
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
    fn: (signal?: BulkheadSignal) => Promise<T>,
    ao: AcquireOptions & {
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
        return existing as Promise<T>;
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
        throw new LLMBulkheadRejectedError(r.reason);
      }

      const work = (async () => {
        let result: T;
        try {
          result = await fn(ao.signal);
        } catch (err) {
          r.token.release(); // no usage on error
          throw err;
        }

        // Extract usage for refund.
        let usage: TokenUsage | undefined;
        if (getUsage) {
          try {
            usage = getUsage(result);
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
        budget: budget.budget,
        inFlightTokens,
        available: Math.max(0, budget.budget - inFlightTokens),
        totalRefunded,
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

  return { acquire, run, stats, close, drain, on };
}

export type LLMBulkhead = ReturnType<typeof createLLMBulkhead>;
