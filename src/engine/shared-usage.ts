/**
 * Protected versus shared usage: how much of what a class holds sits
 * inside its own floor, how much is borrowed from the shared remainder,
 * and what one more call would have to borrow.
 *
 * Read-only. Every number is read live from its owner (limits, token
 * ledger, class slots, concurrency gate); no value is cached here.
 */
import type { ClassSlots } from "./class-slots.js";
import type { ClassLimits, Limits } from "./limits.js";
import type { ConcurrencyGate } from "./shared.js";
import type { TokenLedger } from "./token-ledger.js";

/** Read access to one class. Private to this file; callers pass ids. */
type ClassReads = {
  /** The class's live limits, as held by the limits owner. */
  readonly limit: Readonly<ClassLimits>;
  /** Slots the class holds right now. */
  readonly slots: () => number;
  /** Tokens the class holds right now. */
  readonly tokens: () => number;
};

export function createSharedUsage(deps: {
  concurrency: ConcurrencyGate;
  limits: Limits;
  ledger: TokenLedger;
  slots: ClassSlots;
}) {
  const { concurrency, limits, ledger, slots } = deps;

  // The class table is fixed at construction, so each class is resolved
  // once here. Every read below is still live: nothing is copied.
  const reads = new Map<string, ClassReads>();
  for (const id of limits.classIds) {
    reads.set(id, {
      limit: limits.classLimit(id),
      slots: slots.reader(id),
      tokens: ledger.classReader(id),
    });
  }
  const allClasses = [...reads.values()];

  /** Slots a class is using inside its protected floor. */
  function protectedConcurrentInUse(classId: string): number {
    const cls = reads.get(classId)!;
    return Math.min(cls.slots(), cls.limit.protectedConcurrent);
  }

  /** Tokens a class is holding inside its protected floor. */
  function protectedTokensInUse(classId: string): number {
    const cls = reads.get(classId)!;
    return Math.min(cls.tokens(), cls.limit.protectedInFlightTokens);
  }

  /** Floor-covered slots in use, summed over every class. */
  function protectedConcurrentInUseTotal(): number {
    let protectedInUse = 0;
    for (const cls of allClasses) {
      protectedInUse += Math.min(cls.slots(), cls.limit.protectedConcurrent);
    }
    return protectedInUse;
  }

  function sharedConcurrentInUse(): number {
    return Math.max(
      0,
      concurrency.stats().inFlight - protectedConcurrentInUseTotal(),
    );
  }

  function sharedTokensInUse(): number {
    let protectedInUse = 0;
    for (const cls of allClasses) {
      protectedInUse += Math.min(
        cls.tokens(),
        cls.limit.protectedInFlightTokens,
      );
    }
    return Math.max(0, ledger.inFlight() - protectedInUse);
  }

  /** Slots one more call from this class would take from shared capacity. */
  function requestedBorrowedConcurrent(classId: string | undefined): number {
    if (classId === undefined) return 0;
    const cls = reads.get(classId)!;
    return cls.slots() < cls.limit.protectedConcurrent ? 0 : 1;
  }

  /** Tokens a reservation from this class would take from shared capacity. */
  function requestedBorrowedTokens(
    classId: string | undefined,
    reserved: number,
  ): number {
    if (classId === undefined || reserved === 0) return 0;
    const cls = reads.get(classId)!;
    const protectedAvailable = Math.max(
      0,
      cls.limit.protectedInFlightTokens - cls.tokens(),
    );
    return Math.max(0, reserved - protectedAvailable);
  }

  return {
    protectedConcurrentInUse,
    protectedTokensInUse,
    protectedConcurrentInUseTotal,
    sharedConcurrentInUse,
    sharedTokensInUse,
    requestedBorrowedConcurrent,
    requestedBorrowedTokens,
  };
}

export type SharedUsage = ReturnType<typeof createSharedUsage>;
