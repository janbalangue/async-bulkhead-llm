/**
 * Owner of the observe-mode counters: how many callbacks ran without
 * holding capacity, why, and the usage they reported. Bypassed work never
 * touches the token, slot or admission counts, so these stand alone.
 * Nothing outside this file writes them.
 */
import type {
  LLMObserveStats,
  LLMShadowableRejectReason,
  TokenUsage,
} from "../types.js";

export function createObserveStats() {
  let observeBypassed = 0;
  let observeRaceBypassed = 0;
  const observeBypassedByReason: Partial<
    Record<LLMShadowableRejectReason, number>
  > = {};
  let observeUsageReported = 0;
  let observeTotalInputTokens = 0;
  let observeTotalOutputTokens = 0;

  /**
   * A callback is about to run without capacity. `raced` is true when an
   * advisory positive decision lost a race to a real rejection.
   */
  function noteBypass(reason: LLMShadowableRejectReason, raced: boolean): void {
    observeBypassed++;
    if (raced) observeRaceBypassed++;
    observeBypassedByReason[reason] =
      (observeBypassedByReason[reason] ?? 0) + 1;
  }

  /** A bypassed callback settled with final usage available. */
  function noteUsage(usage: TokenUsage): void {
    observeUsageReported++;
    observeTotalInputTokens += usage.input;
    observeTotalOutputTokens += usage.output;
  }

  /** Detached copy; `undefined` until the first bypass has occurred. */
  function snapshot(): LLMObserveStats | undefined {
    if (!(observeBypassed > 0)) return undefined;
    return {
      bypassed: observeBypassed,
      raceBypassed: observeRaceBypassed,
      bypassedByReason: { ...observeBypassedByReason },
      usageReported: observeUsageReported,
      totalInputTokens: observeTotalInputTokens,
      totalOutputTokens: observeTotalOutputTokens,
    };
  }

  return { noteBypass, noteUsage, snapshot };
}

export type ObserveStats = ReturnType<typeof createObserveStats>;
