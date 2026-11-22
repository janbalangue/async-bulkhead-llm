/**
 * The capacity decision: would this call fit, and if so, reserve it.
 *
 * `check` reads every non-queue capacity layer in a fixed order and names
 * the first limit that is broken. That order is what decides the `reason`
 * and `constraint` a caller sees when a request breaks several limits at
 * once, so it must not be rearranged:
 *
 *   1. global token budget
 *   2. class token ceiling
 *   3. class concurrency ceiling
 *   4. shared concurrency left after every class floor
 *   5. shared tokens left after every class floor
 *
 * `tryReserve` is all or nothing: it runs the same checks and only then
 * asks the owners to move their counters.
 */
import type { LLMAdmissionResources, LLMPriority } from "../types.js";
import type { ClassSlots } from "./class-slots.js";
import type { Limits } from "./limits.js";
import type {
  CapacityFailure,
  CapacityReservationResult,
  ConcurrencyGate,
} from "./shared.js";
import type { SharedUsage } from "./shared-usage.js";
import type { TokenLedger } from "./token-ledger.js";

export function createCapacity(deps: {
  budgetEnabled: boolean;
  concurrency: ConcurrencyGate;
  limits: Limits;
  ledger: TokenLedger;
  slots: ClassSlots;
  usage: SharedUsage;
}) {
  const { budgetEnabled, concurrency, limits, ledger, slots, usage } = deps;

  /** Would borrowing one more slot eat into another class's floor? */
  function sharedConcurrencyExhausted(
    classId: string,
    globalSlotHeld: boolean,
  ): boolean {
    const totalProtectedConcurrent = limits.protectedConcurrentTotal();
    if (totalProtectedConcurrent <= 0) return false;
    const sharedConcurrentCapacity = Math.max(
      0,
      concurrency.stats().maxConcurrent - totalProtectedConcurrent,
    );
    const globalInFlightBefore = Math.max(
      0,
      concurrency.stats().inFlight - (globalSlotHeld ? 1 : 0),
    );
    const sharedConcurrentBefore = Math.max(
      0,
      globalInFlightBefore - usage.protectedConcurrentInUseTotal(),
    );
    const borrowedConcurrentRequested =
      usage.requestedBorrowedConcurrent(classId);
    return (
      borrowedConcurrentRequested > 0 &&
      sharedConcurrentBefore + borrowedConcurrentRequested >
        sharedConcurrentCapacity
    );
  }

  /** Would borrowing these tokens eat into another class's floor? */
  function sharedTokensExhausted(
    classId: string,
    reserved: number,
    priority: LLMPriority,
  ): boolean {
    const totalProtectedTokens = limits.protectedTokensTotal();
    if (!budgetEnabled || totalProtectedTokens <= 0) return false;
    const sharedTokenCapacity = Math.max(
      0,
      limits.effectiveBudget(priority) - totalProtectedTokens,
    );
    const borrowedTokensRequested = usage.requestedBorrowedTokens(
      classId,
      reserved,
    );
    return (
      borrowedTokensRequested > 0 &&
      usage.sharedTokensInUse() + borrowedTokensRequested >
        sharedTokenCapacity
    );
  }

  /**
   * Check a call against every non-queue capacity layer without changing
   * anything. `globalSlotHeld` is true once the call already holds its
   * global concurrency slot, so that slot is not counted against it.
   */
  function check(
    reserved: number,
    priority: LLMPriority,
    classId: string | undefined,
    globalSlotHeld = false,
  ): CapacityFailure | undefined {
    if (
      budgetEnabled &&
      ledger.inFlight() + reserved > limits.effectiveBudget(priority)
    ) {
      return { reason: "budget_limit", constraint: "global" };
    }
    if (classId === undefined) return undefined;

    const classLimit = limits.classLimit(classId);
    if (
      classLimit.maxInFlightTokens !== undefined &&
      ledger.classInFlight(classId) + reserved > classLimit.maxInFlightTokens
    ) {
      return { reason: "budget_limit", constraint: "admission_class" };
    }
    if (
      classLimit.maxConcurrent !== undefined &&
      slots.inFlight(classId) >= classLimit.maxConcurrent
    ) {
      return { reason: "concurrency_limit", constraint: "admission_class" };
    }
    if (sharedConcurrencyExhausted(classId, globalSlotHeld)) {
      return {
        reason: "concurrency_limit",
        constraint: "admission_class_protection",
      };
    }
    if (sharedTokensExhausted(classId, reserved, priority)) {
      return {
        reason: "budget_limit",
        constraint: "admission_class_protection",
      };
    }
    return undefined;
  }

  /**
   * Atomically reserve every non-queue capacity layer after the global
   * concurrency slot is held. No counters are changed unless all checks pass.
   */
  function tryReserve(
    reserved: number,
    priority: LLMPriority,
    classId: string | undefined,
  ): CapacityReservationResult {
    const failure = check(reserved, priority, classId, true);
    if (failure !== undefined) return { ok: false, failure };

    // Attribute the admission before any counter moves: both values are
    // read from the state the checks above just approved.
    const resources: LLMAdmissionResources = Object.freeze({
      borrowedConcurrency:
        classId === undefined
          ? false
          : usage.requestedBorrowedConcurrent(classId) > 0,
      borrowedTokens:
        classId === undefined
          ? 0
          : usage.requestedBorrowedTokens(classId, reserved),
    });

    ledger.reserve(classId, reserved, resources.borrowedTokens);
    slots.occupy(classId, resources.borrowedConcurrency);
    return { ok: true, resources };
  }

  return { check, tryReserve };
}

export type Capacity = ReturnType<typeof createCapacity>;
