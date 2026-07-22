/**
 * async-bulkhead-llm — public API surface.
 *
 * This entry point re-exports everything the package supports; the
 * implementation lives in focused modules:
 *
 * - `types.ts`      — request/result/options/stats/event types
 * - `errors.ts`     — `LLMBulkheadRejectedError`
 * - `profiles.ts`   — `PROFILES` presets
 * - `estimators.ts` — naive + model-aware estimators, `extractTextLength`
 * - `adaptive.ts`   — `createAdaptiveTokenEstimator` (v3.8)
 * - `dedup.ts`      — deduplication internals (keying, share safety)
 * - `validation.ts` — internal numeric/estimate/usage guards
 * - `bulkhead.ts`   — `createLLMBulkhead` (admission, budget, events)
 *
 * Deep-importing the internal modules is not supported; the package
 * `exports` map exposes only this entry point.
 */

export type {
  ContentBlock,
  DeduplicationOptions,
  LLMAcquireOptions,
  LLMAcquireResult,
  LLMAdmissionMode,
  LLMBulkheadOptions,
  LLMDrainResult,
  LLMEventMap,
  LLMEventType,
  LLMMessage,
  LLMPriority,
  LLMRejectDetail,
  LLMRejectReason,
  LLMRequest,
  LLMRequestStats,
  LLMReservationEstimate,
  LLMRunAdmission,
  LLMRunOptions,
  LLMReservationOverride,
  LLMRunContext,
  LLMShadowableRejectReason,
  LLMStats,
  LLMObserveStats,
  LLMToken,
  LLMWouldAdmitResult,
  OpaqueContentBlock,
  TextContentBlock,
  TokenBudgetOptions,
  TokenEstimate,
  TokenEstimator,
  TokenUsage,
  UsageReport,
} from "./types.js";

export { LLMBulkheadRejectedError } from "./errors.js";

export { PROFILES } from "./profiles.js";
export type { LLMBulkheadPreset } from "./profiles.js";

export {
  createModelAwareTokenEstimator,
  extractTextLength,
  naiveTokenEstimator,
} from "./estimators.js";
export type {
  ModelAwareEstimatorOptions,
  OpaqueBlockTokens,
} from "./estimators.js";

export { createAdaptiveTokenEstimator } from "./adaptive.js";
export type {
  AdaptiveModelCorrection,
  AdaptiveTokenEstimator,
  AdaptiveTokenEstimatorOptions,
} from "./adaptive.js";

export { createLLMBulkhead } from "./bulkhead.js";
export type { LLMBulkhead } from "./bulkhead.js";
