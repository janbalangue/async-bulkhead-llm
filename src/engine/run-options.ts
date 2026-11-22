/**
 * Reading the options of one `run()` call: what belongs to `run()` itself
 * (usage extraction, observe mode, deduplication, the borrowed-slot
 * deadline) and what is passed on to admission. Invalid values throw.
 */
import type {
  LLMAdmissionMode,
  LLMRejectReason,
  LLMRunOptions,
  LLMShadowableRejectReason,
} from "../types.js";

const DEFAULT_SHADOW_REASONS: readonly LLMShadowableRejectReason[] = [
  "budget_limit",
  "concurrency_limit",
  "queue_limit",
  "timeout",
];

const SHADOWABLE_REASONS = new Set<LLMShadowableRejectReason>(
  DEFAULT_SHADOW_REASONS,
);

function resolveAdmissionMode(
  mode: LLMAdmissionMode | undefined,
): LLMAdmissionMode {
  if (mode === undefined) return "enforce";
  if (mode !== "enforce" && mode !== "observe") {
    throw new Error(`mode must be "enforce" or "observe"`);
  }
  return mode;
}

function resolveShadowReasons(
  reasons: readonly LLMShadowableRejectReason[] | undefined,
): ReadonlySet<LLMShadowableRejectReason> {
  if (reasons === undefined) return SHADOWABLE_REASONS;
  const resolved = new Set<LLMShadowableRejectReason>();
  for (const reason of reasons) {
    if (!SHADOWABLE_REASONS.has(reason)) {
      throw new Error(
        `shadowReasons may contain only budget_limit, concurrency_limit, ` +
          `queue_limit, or timeout`,
      );
    }
    resolved.add(reason);
  }
  return resolved;
}

/** May observe mode turn a rejection for this reason into a bypass? */
export function shouldBypass(
  reason: LLMRejectReason,
  configured: ReadonlySet<LLMShadowableRejectReason>,
): reason is LLMShadowableRejectReason {
  return (
    SHADOWABLE_REASONS.has(reason as LLMShadowableRejectReason) &&
    configured.has(reason as LLMShadowableRejectReason)
  );
}

export function readRunOptions<T>(ao: LLMRunOptions<T>) {
  const {
    getUsage,
    mode: requestedMode,
    shadowReasons: requestedShadowReasons,
    dedupScope,
    dedup: perCallDedup,
    borrowedConcurrencyDeadlineMs,
    ...acquireOpts
  } = ao;
  if (
    borrowedConcurrencyDeadlineMs !== undefined &&
    (!Number.isSafeInteger(borrowedConcurrencyDeadlineMs) ||
      borrowedConcurrencyDeadlineMs < 1 ||
      borrowedConcurrencyDeadlineMs > 2_147_483_647)
  ) {
    throw new Error(
      "borrowedConcurrencyDeadlineMs must be a safe integer from 1 through 2147483647",
    );
  }
  const mode = resolveAdmissionMode(requestedMode);
  const shadowReasons = resolveShadowReasons(requestedShadowReasons);
  return {
    getUsage,
    mode,
    shadowReasons,
    dedupScope,
    perCallDedup,
    borrowedConcurrencyDeadlineMs,
    /** Everything else: the options admission itself understands. */
    acquireOpts,
  };
}
