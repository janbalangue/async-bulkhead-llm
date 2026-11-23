/**
 * async-bulkhead-llm — public API surface.
 *
 * This entry point re-exports everything the package supports; the
 * implementation lives in focused modules:
 *
 * - `types.ts`      — request/result/options/stats/event types
 * - `errors.ts`     — `LLMBulkheadRejectedError` and the two errors for
 *                     admitted work that ended early
 * - `profiles.ts`   — `PROFILES` presets
 * - `estimators.ts` — naive + model-aware estimators, `extractTextLength`
 * - `adaptive.ts`   — `createAdaptiveTokenEstimator` (v3.8)
 * - `dedup.ts`      — deduplication internals (keying, share safety)
 * - `validation.ts` — internal numeric/estimate/usage guards
 * - `bulkhead.ts`   — `createLLMBulkhead`: validates options and wires the
 *                     engine parts together
 * - `reconfigurable-bulkhead.ts` — internal concurrency gate (global slot
 *                     count and queue)
 * - `engine/`       — the parts of the admission engine, one concern per
 *                     file (limits, token ledger, class slots, admission
 *                     counts, capacity checks, the admitted token, `run()`,
 *                     observe mode, deduplication, stats, shutdown, the
 *                     running calls and the stop triggers); the full list
 *                     is in the header of `bulkhead.ts`
 *
 * Deep-importing the internal modules is not supported; the package
 * `exports` map exposes only this entry point.
 */

export type {
  ContentBlock,
  DeduplicationOptions,
  Listener,
  LLMAdmissionClassLimits,
  LLMAdmissionResources,
  LLMBorrowedConcurrencyAbandonCause,
  LLMAdmissionClassesOptions,
  LLMAdmissionClassStats,
  LLMAdmissionClassSharedStats,
  LLMAdmissionLimits,
  LLMAdmissionStopCause,
  LLMAdmissionStopPolicy,
  LLMApplyLimitsResult,
  LLMAcquireOptions,
  LLMAcquireResult,
  LLMAdmissionMode,
  LLMBulkheadOptions,
  LLMCapacityConstraint,
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
  ProgressiveReconciliationOptions,
  TextContentBlock,
  TokenBudgetOptions,
  TokenEstimate,
  TokenEstimator,
  TokenUsage,
  UsageReport,
} from "./types.js";

export {
  LLMAdmissionStoppedError,
  LLMBorrowedConcurrencyDeadlineError,
  LLMBulkheadRejectedError,
} from "./errors.js";

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
