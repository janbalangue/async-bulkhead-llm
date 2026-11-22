/**
 * The capacity snapshot attached to rejection results, events and errors,
 * and to `wouldAdmit({ detail: true })`.
 *
 * Read-only: it describes the capacity a decision was made against and
 * never takes part in the decision itself.
 */
import type {
  LLMCapacityConstraint,
  LLMPriority,
  LLMRejectDetail,
} from "../types.js";
import type { ClassSlots } from "./class-slots.js";
import type { Limits } from "./limits.js";
import type { ConcurrencyGate } from "./shared.js";
import type { SharedUsage } from "./shared-usage.js";
import type { TokenLedger } from "./token-ledger.js";

type Deps = {
  budgetEnabled: boolean;
  concurrency: ConcurrencyGate;
  limits: Limits;
  ledger: TokenLedger;
  slots: ClassSlots;
  usage: SharedUsage;
};

type SharedCapacityDetail = NonNullable<LLMRejectDetail["sharedCapacity"]>;

/** Shared token capacity remaining after every configured class floor. */
function sharedTokenDetail(
  deps: Deps,
  requested: number,
  priority: LLMPriority,
  classId: string,
): NonNullable<SharedCapacityDetail["tokenBudget"]> {
  const { limits, usage } = deps;
  const sharedTokenCapacity = Math.max(
    0,
    limits.effectiveBudget(priority) - limits.protectedTokensTotal(),
  );
  return {
    capacity: sharedTokenCapacity,
    inUse: usage.sharedTokensInUse(),
    available: Math.max(0, sharedTokenCapacity - usage.sharedTokensInUse()),
    requestedBorrowed: usage.requestedBorrowedTokens(classId, requested),
  };
}

/** Shared capacity remaining after every configured class floor. */
function sharedCapacityDetail(
  deps: Deps,
  maxConcurrent: number,
  requested: number,
  priority: LLMPriority,
  classId: string,
): SharedCapacityDetail {
  const { limits, usage } = deps;
  const sharedConcurrentCapacity = Math.max(
    0,
    maxConcurrent - limits.protectedConcurrentTotal(),
  );
  const sharedConcurrentUsed = usage.sharedConcurrentInUse();
  return {
    concurrency: {
      capacity: sharedConcurrentCapacity,
      inUse: sharedConcurrentUsed,
      available: Math.max(
        0,
        sharedConcurrentCapacity - sharedConcurrentUsed,
      ),
      requestedBorrowed: usage.requestedBorrowedConcurrent(classId),
    },
    ...(deps.budgetEnabled
      ? {
          tokenBudget: sharedTokenDetail(deps, requested, priority, classId),
        }
      : {}),
  };
}

/** Bounded policy-class snapshot used for one decision. */
function classDetail(
  deps: Deps,
  requested: number,
  classId: string,
): NonNullable<LLMRejectDetail["admissionClass"]> {
  const classLimit = deps.limits.classLimit(classId);
  const classSlots = deps.slots.inFlight(classId);
  const classTokens = deps.ledger.classInFlight(classId);
  const classProtectedConcurrentInUse =
    deps.usage.protectedConcurrentInUse(classId);
  const classProtectedTokensInUse = deps.usage.protectedTokensInUse(classId);
  return {
    id: classId,
    inFlight: classSlots,
    protectedConcurrent: classLimit.protectedConcurrent,
    protectedConcurrentInUse: classProtectedConcurrentInUse,
    borrowedConcurrent: Math.max(
      0,
      classSlots - classProtectedConcurrentInUse,
    ),
    availableProtectedConcurrent: Math.max(
      0,
      classLimit.protectedConcurrent - classSlots,
    ),
    maxConcurrent: classLimit.maxConcurrent ?? null,
    availableConcurrent:
      classLimit.maxConcurrent === undefined
        ? null
        : Math.max(0, classLimit.maxConcurrent - classSlots),
    ...(deps.budgetEnabled
      ? {
          tokenBudget: {
            inFlightTokens: classTokens,
            protectedInFlightTokens: classLimit.protectedInFlightTokens,
            protectedTokensInUse: classProtectedTokensInUse,
            borrowedInFlightTokens: Math.max(
              0,
              classTokens - classProtectedTokensInUse,
            ),
            availableProtectedTokens: Math.max(
              0,
              classLimit.protectedInFlightTokens - classTokens,
            ),
            maxInFlightTokens: classLimit.maxInFlightTokens ?? null,
            available:
              classLimit.maxInFlightTokens === undefined
                ? null
                : Math.max(0, classLimit.maxInFlightTokens - classTokens),
            requested,
          },
        }
      : {}),
  };
}

export function createRejectDetail(deps: Deps) {
  /** Capacity snapshot for rejection results, events, and errors. */
  return function buildRejectDetail(
    requested: number,
    priority: LLMPriority,
    classId: string | undefined,
    constraint?: LLMCapacityConstraint,
  ): LLMRejectDetail {
    const { limits, ledger } = deps;
    const base = deps.concurrency.stats();
    const detail: LLMRejectDetail = {
      limitRevision: limits.revision(),
      ...(classId !== undefined && constraint !== undefined
        ? { constraint }
        : {}),
      inFlight: base.inFlight,
      pending: base.pending,
      maxConcurrent: base.maxConcurrent,
      maxQueue: base.maxQueue,
    };
    if (deps.budgetEnabled) {
      const eff = limits.effectiveBudget(priority);
      const poolTokens = ledger.inFlight();
      detail.tokenBudget = {
        budget: limits.budget()!,
        inFlightTokens: poolTokens,
        effectiveBudget: eff,
        available: Math.max(0, eff - poolTokens),
        requested,
      };
    }
    if (classId !== undefined) {
      detail.sharedCapacity = sharedCapacityDetail(
        deps,
        base.maxConcurrent,
        requested,
        priority,
        classId,
      );
      detail.admissionClass = classDetail(deps, requested, classId);
    }
    return detail;
  };
}

export type BuildRejectDetail = ReturnType<typeof createRejectDetail>;
