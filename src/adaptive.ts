/**
 * `createAdaptiveTokenEstimator` (v3.8): a self-calibrating wrapper
 * around the model-aware estimator that learns per-model correction
 * factors from observed usage.
 */
import type { LLMRequest, TokenEstimator, TokenUsage } from "./types.js";
import {
  createModelAwareTokenEstimator,
  type ModelAwareEstimatorOptions,
} from "./estimators.js";
import { assertPositiveInteger, validateTokenUsage } from "./validation.js";

// ────────────────────────────────────────────
// Adaptive estimator (v3.8)
// ────────────────────────────────────────────

export type AdaptiveTokenEstimatorOptions = ModelAwareEstimatorOptions & {
  /**
   * Exact-model ratio overrides, forwarded to the underlying
   * model-aware estimator (same semantics as the two-argument form of
   * `createModelAwareTokenEstimator`).
   */
  overrides?: Record<string, number> | undefined;

  /**
   * EWMA smoothing factor in (0, 1]. Each observation moves the
   * per-model correction factor by `smoothing * (observed - current)`.
   * Higher adapts faster but is noisier. Default: 0.2.
   */
  smoothing?: number | undefined;

  /**
   * Observations required for a model before its correction is applied
   * to estimates. Until then the estimator returns the uncorrected
   * base estimate. Must be a positive integer. Default: 5.
   */
  minSamples?: number | undefined;

  /**
   * Lower clamp for the applied correction factor. Guards admission
   * against a run of anomalous observations collapsing estimates
   * toward zero. Must be > 0. Default: 0.5.
   */
  minCorrection?: number | undefined;

  /**
   * Upper clamp for the applied correction factor. Must be
   * >= `minCorrection`. Default: 2.
   */
  maxCorrection?: number | undefined;

  /**
   * Maximum distinct models tracked. When a new model would exceed
   * this, the oldest-inserted entry is evicted. Bounds memory in the
   * face of unbounded / attacker-controlled model strings. Must be a
   * positive integer. Default: 64.
   */
  maxModels?: number | undefined;
};

/** Per-model calibration snapshot returned by `corrections()`. */
export type AdaptiveModelCorrection = {
  /** Normalized (lowercased) model key. `""` = no model resolved. */
  model: string;
  /** Observations recorded for this model. */
  samples: number;
  /** Raw EWMA of `usage.input / baseEstimate.input` (unclamped). */
  factor: number;
  /**
   * Factor currently applied to estimates: `1` until `minSamples`
   * observations exist, then `factor` clamped to
   * [`minCorrection`, `maxCorrection`].
   */
  applied: number;
};

export type AdaptiveTokenEstimator = {
  /** The estimator to pass as `tokenBudget.estimator`. */
  estimator: TokenEstimator;
  /**
   * Record one completed call: the request as estimated, and the
   * provider-reported actual usage. Wire this to the bulkhead's
   * `release` event: `on("release", (e) => { if (e.usage) observe(e.request, e.usage) })`.
   * Observations with a zero base input estimate are ignored (no ratio
   * can be formed). Throws if `usage` fields are not non-negative
   * integers.
   */
  observe(request: LLMRequest, usage: TokenUsage): void;
  /** Snapshot of per-model calibration state, in insertion order. */
  corrections(): AdaptiveModelCorrection[];
  /** Clear calibration for one model, or for all when omitted. */
  reset(model?: string): void;
};

/**
 * A self-calibrating wrapper around `createModelAwareTokenEstimator`
 * (v3.8).
 *
 * Character-ratio estimation is ±15% at best and drifts with content
 * mix (code vs prose vs CJK) and provider tokenizer changes. This
 * estimator closes the loop: feed it actual usage from completed calls
 * via `observe()`, and it maintains a per-model EWMA of
 * `actual input / estimated input`, multiplying future *input*
 * estimates by that factor (clamped, and only after `minSamples`
 * observations). Output reservations are never corrected —
 * `max_tokens` / `outputCap` is a ceiling, not an estimate.
 *
 * The correction applies to the **whole** input estimate, including
 * any `opaqueBlockTokens` surcharge and `extraInputTokens` — the
 * observed ratio necessarily includes those components too, so scaling
 * the total is the self-consistent choice (the fixed point is
 * "corrected estimate ≈ actual"). If your `extraInputTokens` values
 * are exact, expect the factor to settle slightly differently than a
 * pure-prose deployment; the clamps bound the damage either way.
 *
 * `observe()` always measures against the *uncorrected* base estimate,
 * so feedback does not compound: an already-corrected estimator does
 * not drag its own factor back toward 1.
 *
 * Not distributed and not persisted — calibration lives in this
 * instance. Share one instance per bulkhead (create it, pass
 * `.estimator` into `tokenBudget`, and subscribe `.observe` to the
 * same bulkhead's `release` events).
 */
export function createAdaptiveTokenEstimator(
  opts: AdaptiveTokenEstimatorOptions = {},
): AdaptiveTokenEstimator {
  const smoothing = opts.smoothing ?? 0.2;
  if (
    typeof smoothing !== "number" ||
    !Number.isFinite(smoothing) ||
    smoothing <= 0 ||
    smoothing > 1
  ) {
    throw new Error("smoothing must be a finite number in (0, 1]");
  }
  const minSamples = opts.minSamples ?? 5;
  assertPositiveInteger(minSamples, "minSamples");
  const minCorrection = opts.minCorrection ?? 0.5;
  if (
    typeof minCorrection !== "number" ||
    !Number.isFinite(minCorrection) ||
    minCorrection <= 0
  ) {
    throw new Error("minCorrection must be a finite number > 0");
  }
  const maxCorrection = opts.maxCorrection ?? 2;
  if (
    typeof maxCorrection !== "number" ||
    !Number.isFinite(maxCorrection) ||
    maxCorrection < minCorrection
  ) {
    throw new Error(
      "maxCorrection must be a finite number >= minCorrection",
    );
  }
  const maxModels = opts.maxModels ?? 64;
  assertPositiveInteger(maxModels, "maxModels");

  const base = createModelAwareTokenEstimator(opts.overrides, {
    defaultModel: opts.defaultModel,
    outputCap: opts.outputCap,
    onUnknownModel: opts.onUnknownModel,
    opaqueBlockTokens: opts.opaqueBlockTokens,
  });

  type ModelState = { samples: number; factor: number };
  /** Insertion-ordered; oldest-inserted evicted at capacity. */
  const models = new Map<string, ModelState>();

  const modelKey = (request: LLMRequest): string =>
    (request.model ?? opts.defaultModel ?? "").toLowerCase();

  const appliedFactor = (state: ModelState | undefined): number => {
    if (state === undefined || state.samples < minSamples) return 1;
    return Math.min(maxCorrection, Math.max(minCorrection, state.factor));
  };

  const estimator: TokenEstimator = (request) => {
    const e = base(request);
    const factor = appliedFactor(models.get(modelKey(request)));
    if (factor === 1) return e;
    return {
      input: Math.ceil(e.input * factor),
      maxOutput: e.maxOutput,
    };
  };

  function observe(request: LLMRequest, usage: TokenUsage): void {
    const valid = validateTokenUsage(usage);
    // Always ratio against the *uncorrected* base estimate so the
    // feedback loop does not compound through its own corrections.
    const baseInput = base(request).input;
    if (baseInput <= 0) return;
    const observed = valid.input / baseInput;
    const key = modelKey(request);
    const state = models.get(key);
    if (state === undefined) {
      while (models.size >= maxModels) {
        const oldest = models.keys().next().value;
        if (oldest === undefined) break;
        models.delete(oldest);
      }
      models.set(key, { samples: 1, factor: observed });
      return;
    }
    state.factor += smoothing * (observed - state.factor);
    state.samples++;
  }

  function corrections(): AdaptiveModelCorrection[] {
    const out: AdaptiveModelCorrection[] = [];
    for (const [model, state] of models) {
      out.push({
        model,
        samples: state.samples,
        factor: state.factor,
        applied: appliedFactor(state),
      });
    }
    return out;
  }

  function reset(model?: string): void {
    if (model === undefined) {
      models.clear();
      return;
    }
    models.delete(model.toLowerCase());
  }

  return { estimator, observe, corrections, reset };
}
