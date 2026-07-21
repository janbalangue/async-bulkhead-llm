/**
 * Built-in token estimators: the flat-ratio `naiveTokenEstimator`, the
 * per-model `createModelAwareTokenEstimator` (with `opaqueBlockTokens`
 * surcharges), and the text-extraction utility they share.
 */
import type {
  ContentBlock,
  LLMRequest,
  TextContentBlock,
  TokenEstimate,
  TokenEstimator,
} from "./types.js";
import {
  assertNonNegativeInteger,
  assertOptionalNonNegativeInteger,
} from "./validation.js";

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
    if (isTextBlock(block)) len += block.text.length;
  }
  return len;
}

/** A block counts as text iff `type === "text"` with a string `text`. */
function isTextBlock(block: ContentBlock): block is TextContentBlock {
  return (
    block.type === "text" &&
    "text" in block &&
    typeof (block as TextContentBlock).text === "string"
  );
}

/**
 * Total characters across `messages[].content` and `system`.
 * The single character-count surface shared by both built-in estimators.
 */
function requestInputChars(request: LLMRequest): number {
  let chars = request.messages.reduce(
    (sum, m) => sum + extractTextLength(m.content),
    0,
  );
  if (request.system !== undefined) {
    chars += extractTextLength(request.system);
  }
  return chars;
}

/** Validated `request.extraInputTokens`, defaulting to 0. */
function resolveExtraInputTokens(request: LLMRequest): number {
  assertOptionalNonNegativeInteger(
    request.extraInputTokens,
    "request.extraInputTokens",
  );
  return request.extraInputTokens ?? 0;
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
 *
 * v3.7: counts `request.system` alongside message content and adds
 * `request.extraInputTokens` verbatim. Non-text blocks still contribute
 * zero characters (use the model-aware estimator's `opaqueBlockTokens`
 * for per-block surcharges).
 */
export function naiveTokenEstimator(request: LLMRequest): TokenEstimate {
  const inputChars = requestInputChars(request);
  return {
    input:
      Math.ceil(inputChars / NAIVE_CHAR_RATIO) +
      resolveExtraInputTokens(request),
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

/**
 * Surcharge policy for opaque (non-text) content blocks (v3.7).
 *
 * - `number` — every opaque block reserves this many input tokens.
 * - `{ default?, byType? }` — per-`block.type` surcharges with an
 *   optional fallback for types not listed; unlisted types with no
 *   `default` contribute 0.
 *
 * All values must be non-negative integers. A block is "opaque" unless
 * it is a well-formed text block (`type: "text"` with a string `text`)
 * — malformed text blocks are treated as opaque, which errs toward
 * over-reservation. Applies to blocks in `messages[].content` and
 * `system` arrays.
 */
export type OpaqueBlockTokens =
  | number
  | {
      /** Fallback surcharge for opaque types without a `byType` entry. */
      default?: number;
      /** Per-block-type surcharges, keyed by `block.type`. */
      byType?: Record<string, number>;
    };

function validateOpaqueBlockTokens(
  opt: OpaqueBlockTokens | undefined,
): void {
  if (opt === undefined) return;
  if (typeof opt === "number") {
    assertNonNegativeInteger(opt, "opaqueBlockTokens");
    return;
  }
  assertOptionalNonNegativeInteger(opt.default, "opaqueBlockTokens.default");
  if (opt.byType) {
    for (const [type, tokens] of Object.entries(opt.byType)) {
      assertNonNegativeInteger(
        tokens,
        `opaqueBlockTokens.byType[${JSON.stringify(type)}]`,
      );
    }
  }
}

function opaqueBlockCost(opt: OpaqueBlockTokens, type: string): number {
  if (typeof opt === "number") return opt;
  return opt.byType?.[type] ?? opt.default ?? 0;
}

/** Sum of surcharges for every opaque block in messages + system. */
function countOpaqueBlockTokens(
  request: LLMRequest,
  opt: OpaqueBlockTokens | undefined,
): number {
  if (opt === undefined) return 0;
  let total = 0;
  const scan = (content: string | ContentBlock[]): void => {
    if (typeof content === "string") return;
    for (const block of content) {
      if (isTextBlock(block)) continue;
      total += opaqueBlockCost(opt, block.type);
    }
  };
  for (const m of request.messages) scan(m.content);
  if (request.system !== undefined) scan(request.system);
  return total;
}

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

  /**
   * Input-token surcharge for opaque (non-text) content blocks (v3.7).
   *
   * Without this, opaque blocks contribute 0 input tokens — an
   * image-heavy request estimates as nearly free, which is the wrong
   * direction for admission control. A flat conservative number (e.g.
   * 2048 per block) or a per-type map converts each opaque block into a
   * fixed reservation. Validated at estimator creation. Omitted:
   * surcharge disabled (previous behavior).
   */
  opaqueBlockTokens?: OpaqueBlockTokens | undefined;
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
    "onUnknownModel" in value ||
    "opaqueBlockTokens" in value
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
 * v3.7: counts `request.system`, adds `request.extraInputTokens`
 * verbatim, and applies the `opaqueBlockTokens` surcharge (when
 * configured) to every non-text block in messages and system.
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
  const opaqueBlockTokens = opts.opaqueBlockTokens;
  validateOpaqueBlockTokens(opaqueBlockTokens);

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
    const inputChars = requestInputChars(request);
    return {
      input:
        Math.ceil(inputChars / ratio) +
        countOpaqueBlockTokens(request, opaqueBlockTokens) +
        resolveExtraInputTokens(request),
      maxOutput: resolveMaxOutput(request, outputCap),
    };
  };
}
