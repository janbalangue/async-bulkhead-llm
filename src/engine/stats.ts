/**
 * `stats()`: one detached snapshot assembled from every owner. Read-only;
 * each section is a copy, so a caller cannot reach engine state through
 * the result.
 */
import type {
  LLMAdmissionClassSharedStats,
  LLMAdmissionClassStats,
  LLMStats,
} from "../types.js";
import type { AdmissionCounts } from "./admission-counts.js";
import type { ClassSlots } from "./class-slots.js";
import type { Dedup } from "./dedup-flow.js";
import type { Limits } from "./limits.js";
import type { ObserveStats } from "./observe-stats.js";
import type { ConcurrencyGate } from "./shared.js";
import type { SharedUsage } from "./shared-usage.js";
import type { TokenLedger } from "./token-ledger.js";

type Deps = {
  budgetEnabled: boolean;
  concurrency: ConcurrencyGate;
  limits: Limits;
  ledger: TokenLedger;
  slots: ClassSlots;
  counts: AdmissionCounts;
  usage: SharedUsage;
  observeStats: ObserveStats;
  dedup: Dedup;
};

/** Capacity left for borrowing once every class floor is set aside. */
function sharedStats(
  deps: Deps,
  maxConcurrent: number,
): LLMAdmissionClassSharedStats {
  const { limits, usage } = deps;
  const sharedConcurrentCapacity = Math.max(
    0,
    maxConcurrent - limits.protectedConcurrentTotal(),
  );
  const sharedConcurrentUsed = usage.sharedConcurrentInUse();
  return {
    maxConcurrent: sharedConcurrentCapacity,
    inFlight: sharedConcurrentUsed,
    availableConcurrent: Math.max(
      0,
      sharedConcurrentCapacity - sharedConcurrentUsed,
    ),
    ...(deps.budgetEnabled
      ? {
          tokenBudget: {
            budget: Math.max(
              0,
              limits.budget()! - limits.protectedTokensTotal(),
            ),
            inFlightTokens: usage.sharedTokensInUse(),
            available: Math.max(
              0,
              Math.max(0, limits.budget()! - limits.protectedTokensTotal()) -
                usage.sharedTokensInUse(),
            ),
          },
        }
      : {}),
  };
}

/** One class's limits, live usage and cumulative counters. */
function classStats(deps: Deps, classId: string): LLMAdmissionClassStats {
  const classSlots = deps.slots.inFlight(classId);
  const tokens = deps.ledger.classTotals(classId);
  const outcomes = deps.counts.classTotals(classId);
  const protectedConcurrency = deps.usage.protectedConcurrentInUse(classId);
  const protectedTokens = deps.usage.protectedTokensInUse(classId);
  return {
    limits: deps.limits.publicClassLimit(classId),
    inFlight: classSlots,
    protectedConcurrentInUse: protectedConcurrency,
    borrowedConcurrent: Math.max(0, classSlots - protectedConcurrency),
    inFlightTokens: tokens.inFlightTokens,
    protectedTokensInUse: protectedTokens,
    borrowedInFlightTokens: Math.max(
      0,
      tokens.inFlightTokens - protectedTokens,
    ),
    admitted: outcomes.admitted,
    released: outcomes.released,
    borrowedConcurrencyAbandoned: outcomes.borrowedConcurrencyAbandoned,
    rejected: outcomes.rejected,
    rejectedByReason: outcomes.rejectedByReason,
    totalReserved: tokens.totalReserved,
    totalConsumed: tokens.totalConsumed,
    totalRefunded: tokens.totalRefunded,
    totalOverrun: tokens.totalOverrun,
    totalBorrowedAdmissions: deps.slots.totalBorrowedAdmissions(classId),
    totalBorrowedTokensReserved: tokens.totalBorrowedTokensReserved,
  };
}

export function createStats(deps: Deps) {
  const { limits } = deps;

  /** Runtime stats. Optional fields are present only when the feature is enabled. */
  return function stats(): LLMStats {
    const base = deps.concurrency.stats();
    const result: LLMStats = {
      limits: limits.snapshot(),
      bulkhead: base,
      llm: deps.counts.totals(),
    };

    if (deps.budgetEnabled) {
      const pool = deps.ledger.totals();
      result.tokenBudget = {
        budget: limits.budget()!,
        inFlightTokens: pool.inFlightTokens,
        available: Math.max(0, limits.budget()! - pool.inFlightTokens),
        totalReserved: pool.totalReserved,
        totalConsumed: pool.totalConsumed,
        totalRefunded: pool.totalRefunded,
        totalOverrun: pool.totalOverrun,
        highPriorityReserve: limits.highPriorityReserve(),
      };
    }

    const observe = deps.observeStats.snapshot();
    if (observe !== undefined) result.observe = observe;

    const deduplication = deps.dedup.stats();
    if (deduplication !== undefined) result.deduplication = deduplication;

    if (limits.defaultClass !== undefined) {
      result.admissionClasses = {
        defaultClass: limits.defaultClass,
        shared: sharedStats(deps, base.maxConcurrent),
        classes: Object.fromEntries(
          limits.classIds.map((id) => [id, classStats(deps, id)]),
        ),
      };
    }

    return result;
  };
}
