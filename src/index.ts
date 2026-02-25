import {
  createBulkhead,
  type AcquireOptions,
  type Stats,
  type Token,
  type RejectReason as BaseRejectReason,
} from "async-bulkhead-ts";

// ---- Request types ----

/**
 * Minimal request shape shared across estimators.
 *
 * `content` must be a plain string. Multimodal content blocks (images, documents)
 * are not supported in v1 — non-string content will be ignored by estimators,
 * causing underestimation. Treat token budget results as a lower bound for
 * multimodal requests.
 *
 * Structural compatibility: most provider SDK request types satisfy this
 * interface without adaptation, provided `content` is a plain string.
 */
export type LLMMessage = {
  role: string;
  content: string;
};

export type LLMRequest = {
  messages: LLMMessage[];
  max_tokens?: number;
};

// ---- Token estimation types ----

export type TokenEstimate = {
  input: number;
  maxOutput: number;
};

export type TokenEstimator = (request: LLMRequest) => TokenEstimate;

/**
 * Actual token usage returned by the provider after a call completes.
 *
 * Not acted on in v1 — exported as a forward-looking type for v2 refund support.
 * Callers can use this type today to annotate their own provider response handling.
 */
export type TokenUsage = {
  input: number;
  output: number;
};

// ---- Reject reason ----

export type LLMRejectReason = BaseRejectReason | "budget_limit";

export class LLMBulkheadRejectedError extends Error {
  readonly code = "LLM_BULKHEAD_REJECTED" as const;

  constructor(readonly reason: LLMRejectReason) {
    super(`LLM bulkhead rejected: ${reason}`);
    this.name = "LLMBulkheadRejectedError";
  }
}

// ---- Stats ----

export type LLMStats = Stats & {
  /**
   * Present only when `tokenBudget` is configured.
   */
  tokenBudget?: {
    budget: number;
    inFlightTokens: number;
    available: number;
  };
  /**
   * Present only when `deduplication` is enabled.
   */
  deduplication?: {
    /** Number of distinct in-flight deduplication keys. */
    active: number;
    /** Cumulative requests that shared an existing in-flight call. */
    hits: number;
  };
};

// ---- Profile / preset ----

export type LLMBulkheadPreset = {
  maxQueue?: number;
  timeoutMs?: number;
};

/**
 * Built-in presets for common deployment patterns.
 * Explicit options always override preset defaults.
 * Pass a plain `LLMBulkheadPreset` object to escape the named presets entirely.
 */
export const PROFILES: Record<"interactive" | "batch", LLMBulkheadPreset> = {
  interactive: { maxQueue: 0 },
  batch: { maxQueue: 20, timeoutMs: 30_000 },
};

// ---- Token budget options ----

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

// ---- Core options ----

export type LLMBulkheadOptions = {
  /**
   * Model identifier. Used by the default estimator for ratio lookup.
   *
   * One bulkhead per model is the strongly recommended deployment pattern —
   * different models have different cost, latency, and rate-limit profiles.
   * See README for a multi-model routing recipe.
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
   *
   * - `'interactive'` — fail-fast, no waiting (`maxQueue: 0`)
   * - `'batch'`       — bounded queue, 30s timeout (`maxQueue: 20, timeoutMs: 30_000`)
   *
   * Escape hatch: pass a plain `LLMBulkheadPreset` object for custom defaults.
   *
   * @example
   * profile: 'batch'
   * profile: { maxQueue: 5, timeoutMs: 5_000 }
   */
  profile?: "interactive" | "batch" | LLMBulkheadPreset;

  /**
   * Token budget enforcement. Admission fails fast when the in-flight token
   * ceiling is reached, regardless of concurrency headroom or `profile`.
   * Omit to disable token-aware admission.
   */
  tokenBudget?: TokenBudgetOptions;

  /**
   * Deduplicate identical in-flight requests.
   * Requests with the same deduplication key share one in-flight call.
   *
   * v1 key: `JSON.stringify(request.messages)`. Key design is a known
   * limitation in v1 — callers with non-string content or custom key
   * requirements should await v2.
   *
   * Default: false.
   */
  deduplication?: boolean;
};

// ---- Estimator internals ----

const DEFAULT_OUTPUT_CAP = 2_048;
const NAIVE_CHAR_RATIO = 4.0;

/** Shared helper used by both estimators. */
function resolveMaxOutput(request: LLMRequest, fallback: number): number {
  return request.max_tokens ?? fallback;
}

/**
 * Estimates token usage using a flat 4-characters-per-token ratio.
 *
 * Accuracy: ±25% for English prose.
 * Underestimates for code and non-Latin scripts.
 * Suitable for load-shedding; not suitable for cost accounting.
 */
export function naiveTokenEstimator(request: LLMRequest): TokenEstimate {
  const inputChars = request.messages.reduce(
    (sum, m) => sum + m.content.length,
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
 * Keyed at the model-family level; snapshot suffixes are handled by prefix matching.
 */
const BUILT_IN_RATIOS: Array<[string, number]> = [
  ["claude-3-5-haiku", 3.8],
  ["claude-3-5-sonnet", 3.9],
  ["claude-3-opus", 3.9],
  ["claude-3-sonnet", 3.9],
  ["claude-3-haiku", 3.8],
  ["claude-sonnet-4", 3.9],
  ["claude-opus-4", 3.9],
  ["gpt-4o", 3.7],
  ["gpt-4-turbo", 3.7],
  ["gpt-4", 3.7],
  ["gpt-3.5", 3.8],
  ["o1", 3.7],
  ["o3", 3.7],
  ["gemini-1.5", 3.8],
  ["gemini-2", 3.8],
];

export type ModelAwareEstimatorOptions = {
  /**
   * Model string used for ratio lookup when the estimator is called without
   * per-request model information. Should match the `model` field on the
   * owning `LLMBulkhead`.
   */
  defaultModel?: string | undefined;

  /**
   * Fallback output reservation when `request.max_tokens` is absent.
   * Default: 2048.
   */
  outputCap?: number | undefined;

  /**
   * Called when the model string matches no built-in prefix and no override.
   * Use to log a warning or throw in strict environments.
   * The estimator falls back to the naive 4.0 ratio when this fires.
   */
  onUnknownModel?: ((model: string) => void) | undefined;
};

/**
 * Estimates token usage using per-model character ratios.
 *
 * Accuracy: ±15% for known models on English prose.
 * Falls back to naiveTokenEstimator (ratio 4.0) for unknown models.
 * Extend the model map via the `overrides` parameter.
 * Suitable for load-shedding; not suitable for cost accounting.
 *
 * Matching rules:
 * - `overrides` keys are exact-matched first (case-sensitive as provided,
 *   also tried lowercased). Exact match always wins over prefix scan.
 * - Built-in ratios are prefix-matched; longest prefix wins.
 * - Model string is lowercased before prefix scan.
 * - Unknown models fire `onUnknownModel` and fall back to ratio 4.0.
 *
 * Azure OpenAI deployment names (e.g. `'my-gpt4-prod'`) will not match any
 * built-in prefix. Pass an override keyed on your deployment name, or
 * provide `onUnknownModel` to surface the miss.
 */
export function createModelAwareTokenEstimator(
  overrides?: Record<string, number>,
  opts: ModelAwareEstimatorOptions = {},
): TokenEstimator {
  const outputCap = opts.outputCap ?? DEFAULT_OUTPUT_CAP;

  function lookupRatio(model: string): number {
    // Option B: exact overrides checked before prefix scan.
    if (overrides) {
      const exact = overrides[model] ?? overrides[model.toLowerCase()];
      if (exact != null) return exact;
    }

    // Prefix scan: lowercase, longest match wins.
    const normalized = model.toLowerCase();
    const matched = BUILT_IN_RATIOS.filter(([prefix]) =>
      normalized.startsWith(prefix),
    ).sort((a, b) => b[0].length - a[0].length)[0];

    if (matched) return matched[1];

    opts.onUnknownModel?.(model);
    return NAIVE_CHAR_RATIO;
  }

  return (request: LLMRequest): TokenEstimate => {
    const model = opts.defaultModel ?? "";
    const ratio = lookupRatio(model);
    const inputChars = request.messages.reduce(
      (sum, m) => sum + m.content.length,
      0,
    );
    return {
      input: Math.ceil(inputChars / ratio),
      maxOutput: resolveMaxOutput(request, outputCap),
    };
  };
}

// ---- Option resolution ----

function resolvePreset(
  profile: LLMBulkheadOptions["profile"],
): LLMBulkheadPreset {
  if (!profile) return {};
  if (typeof profile === "string") return PROFILES[profile];
  return profile;
}

// ---- Acquire result (internal; surface matches base library) ----

type InternalAcquireResult =
  | { ok: true; token: Token }
  | { ok: false; reason: LLMRejectReason };

// ---- createLLMBulkhead ----

export function createLLMBulkhead(opts: LLMBulkheadOptions) {
  // Validate
  if (!opts.model || typeof opts.model !== "string") {
    throw new Error("model must be a non-empty string");
  }
  if (!Number.isInteger(opts.maxConcurrent) || opts.maxConcurrent <= 0) {
    throw new Error("maxConcurrent must be a positive integer");
  }

  // Resolve profile defaults; explicit opts always win
  const preset = resolvePreset(opts.profile);
  const maxQueue = opts.maxQueue ?? preset.maxQueue ?? 0;
  const timeoutMs = opts.timeoutMs ?? preset.timeoutMs;

  // Internal bulkhead from async-bulkhead-ts
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

  // ---- Deduplication state ----
  // v1 key: JSON.stringify(messages). Key design deferred to v2.
  const dedupMap = new Map<string, Promise<unknown>>();
  let dedupHits = 0;

  function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  // ---- Internal helpers ----

  /**
   * Attempt token budget admission synchronously before queuing.
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

  function releaseTokens(reserved: number): void {
    inFlightTokens = Math.max(0, inFlightTokens - reserved);
  }

  /**
   * Wraps a base Token so that release() also returns the token reservation.
   * The wrapped token is the single place that tracks both concerns atomically.
   */
  function wrapToken(base: Token, reserved: number): Token {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        try {
          base.release();
        } finally {
          releaseTokens(reserved);
        }
      },
    };
  }

  // ---- Internal acquire ----
  // Shared by the public `acquire()` and `run()` paths.

  async function _acquire(
    request: LLMRequest,
    ao: AcquireOptions,
  ): Promise<InternalAcquireResult> {
    // Token budget: read-only pre-check before entering the queue.
    // Do NOT reserve here — budget may shift while we wait.
    if (budget) {
      const estimate = estimator(request);
      const needed = estimate.input + estimate.maxOutput;
      if (inFlightTokens + needed > budget.budget)
        return { ok: false, reason: "budget_limit" };
    }

    const mergedOptions: AcquireOptions = {};
    if (ao.signal !== undefined) mergedOptions.signal = ao.signal;
    if (ao.timeoutMs !== undefined) mergedOptions.timeoutMs = ao.timeoutMs;
    else if (timeoutMs !== undefined) mergedOptions.timeoutMs = timeoutMs;

    const r = await bulkhead.acquire(mergedOptions);

    if (!r.ok) {
      return { ok: false, reason: r.reason };
    }

    // Post-admission: now reserve tokens. Re-check because other
    // requests may have been admitted while this one was queued.
    const reserved = tryReserveTokens(request);
    if (reserved === null) {
      r.token.release(); // return the concurrency slot
      return { ok: false, reason: "budget_limit" };
    }

    return { ok: true, token: wrapToken(r.token, reserved) };
  }

  // ---- Public API ----

  /**
   * Acquire a slot manually.
   *
   * Advanced usage. Token budget reservations are not correctable post-call
   * without `run()` in v1 (refund mechanism deferred to v2). For most
   * use cases, prefer `run()`.
   *
   * Throws a `LLMBulkheadRejectedError` only indirectly via the returned
   * `AcquireResult` — callers must check `r.ok`.
   */
  async function acquire(
    request: LLMRequest,
    ao: AcquireOptions = {},
  ): Promise<InternalAcquireResult> {
    return _acquire(request, ao);
  }

  /**
   * Primary API. Acquire → call `fn` → release, automatically.
   *
   * Throws `LLMBulkheadRejectedError` on rejection.
   * The provided `AbortSignal` (if any) is passed through to `fn`,
   * allowing in-flight work to observe cancellation.
   *
   * Note: cancellation affects admission only; in-flight work is not
   * forcibly terminated by the bulkhead.
   */
  async function run<T>(
    request: LLMRequest,
    fn: (signal?: AbortSignal) => Promise<T>,
    ao: AcquireOptions = {},
  ): Promise<T> {
    let dedupKey = "";
    if (opts.deduplication) {
      try {
        dedupKey = JSON.stringify(request.messages);
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

    // If we create a deferred, this is what BOTH leader and followers should await.
    let resultPromise: Promise<T> | undefined;

    if (opts.deduplication && dedupKey !== "") {
      const existing = dedupMap.get(dedupKey);
      if (existing) {
        dedupHits++;
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
      const r = await _acquire(request, ao);
      if (!r.ok) {
        throw new LLMBulkheadRejectedError(r.reason);
      }

      const work = (async () => {
        try {
          return await fn(ao.signal);
        } finally {
          r.token.release();
        }
      })();

      if (deferred) {
        void work.then(
          (v) => {
            deferred.resolve(v);
          },
          (e) => {
            deferred.reject(e);
          },
        );
        return resultPromise!; // leader awaits the same promise as followers
      }

      return work;
    } catch (err) {
      if (deferred) {
        deferred.reject(err);
        return resultPromise!; // IMPORTANT: avoid throwing here -> no unhandled deferred rejection
      }
      throw err;
    }
  }

  /** Runtime stats. Optional fields are present only when the feature is enabled. */
  function stats(): LLMStats {
    const base = bulkhead.stats();
    const result: LLMStats = { ...base };

    if (budget) {
      result.tokenBudget = {
        budget: budget.budget,
        inFlightTokens,
        available: Math.max(0, budget.budget - inFlightTokens),
      };
    }

    if (opts.deduplication) {
      result.deduplication = {
        active: dedupMap.size,
        hits: dedupHits,
      };
    }

    return result;
  }

  return { acquire, run, stats };
}

export type LLMBulkhead = ReturnType<typeof createLLMBulkhead>;
