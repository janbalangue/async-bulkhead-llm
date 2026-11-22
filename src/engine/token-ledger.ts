/**
 * Owner of the token counters: tokens held in flight and the cumulative
 * reserved, consumed, refunded and overrun totals.
 *
 * Every counter exists once for the whole pool and once per admission
 * class. Each function below moves a pool counter and the same counter of
 * the class the call belongs to, so the two can never drift apart. Nothing
 * outside this file writes them; a class is always named by its id.
 */
import type { TokenUsage } from "../types.js";

type TokenCounters = {
  inFlightTokens: number;
  totalReserved: number;
  totalConsumed: number;
  totalRefunded: number;
  totalOverrun: number;
};

type ClassTokenCounters = TokenCounters & {
  /** Reservation tokens placed in shared capacity at admission time. */
  totalBorrowedTokensReserved: number;
};

export function createTokenLedger(
  budgetEnabled: boolean,
  classIds: Iterable<string>,
) {
  let inFlightTokens = 0;
  let totalReserved = 0;
  let totalConsumed = 0;
  let totalRefunded = 0;
  let totalOverrun = 0;
  const perClass = new Map<string, ClassTokenCounters>();
  for (const id of classIds) {
    perClass.set(id, {
      inFlightTokens: 0,
      totalReserved: 0,
      totalConsumed: 0,
      totalRefunded: 0,
      totalOverrun: 0,
      totalBorrowedTokensReserved: 0,
    });
  }

  function countersOf(
    classId: string | undefined,
  ): ClassTokenCounters | undefined {
    return classId === undefined ? undefined : perClass.get(classId)!;
  }

  /**
   * Admission: hold `reserved` tokens for a call. `borrowedTokens` is the
   * part of the reservation that sits above the class's protected floor.
   */
  function reserve(
    classId: string | undefined,
    reserved: number,
    borrowedTokens: number,
  ): void {
    const cls = countersOf(classId);
    if (budgetEnabled) {
      inFlightTokens += reserved;
      totalReserved += reserved;
    }
    if (cls !== undefined) {
      cls.totalBorrowedTokensReserved += borrowedTokens;
      if (budgetEnabled) {
        cls.inFlightTokens += reserved;
        cls.totalReserved += reserved;
      }
    }
  }

  /** A usage report pushed a call's hold above what it held: overrun. */
  function grow(classId: string | undefined, delta: number): void {
    const cls = countersOf(classId);
    inFlightTokens += delta;
    totalOverrun += delta;
    if (cls !== undefined) {
      cls.inFlightTokens += delta;
      cls.totalOverrun += delta;
    }
  }

  /** A usage report lowered a call's hold: an early refund. */
  function shrink(classId: string | undefined, refund: number): void {
    const cls = countersOf(classId);
    inFlightTokens = Math.max(0, inFlightTokens - refund);
    totalRefunded += refund;
    if (cls !== undefined) {
      cls.inFlightTokens = Math.max(0, cls.inFlightTokens - refund);
      cls.totalRefunded += refund;
    }
  }

  /**
   * Final release: return a call's whole hold, and record what it actually
   * consumed when usage is known. Returns the tokens refunded.
   */
  function settle(
    classId: string | undefined,
    held: number,
    usage: TokenUsage | undefined,
  ): number {
    const cls = countersOf(classId);
    let refunded = 0;
    if (usage && held > 0) {
      const actual = usage.input + usage.output;
      totalConsumed += actual;
      if (cls !== undefined) {
        cls.totalConsumed += actual;
      }
      if (actual < held) {
        refunded = held - actual;
        totalRefunded += refunded;
        if (cls !== undefined) {
          cls.totalRefunded += refunded;
        }
      }
    }
    inFlightTokens = Math.max(0, inFlightTokens - held);
    if (cls !== undefined) {
      cls.inFlightTokens = Math.max(0, cls.inFlightTokens - held);
    }
    return refunded;
  }

  return {
    reserve,
    grow,
    shrink,
    settle,
    /** Tokens currently held across the whole pool. */
    inFlight: (): number => inFlightTokens,
    /** Tokens currently held by one class. */
    classInFlight: (classId: string): number =>
      perClass.get(classId)!.inFlightTokens,
    /** A live read of one class's held tokens, without a lookup per read. */
    classReader: (classId: string): (() => number) => {
      const cls = perClass.get(classId)!;
      return () => cls.inFlightTokens;
    },
    /** Detached copy of the pool counters. */
    totals: (): TokenCounters => ({
      inFlightTokens,
      totalReserved,
      totalConsumed,
      totalRefunded,
      totalOverrun,
    }),
    /** Detached copy of one class's counters. */
    classTotals: (classId: string): ClassTokenCounters => ({
      ...perClass.get(classId)!,
    }),
  };
}

export type TokenLedger = ReturnType<typeof createTokenLedger>;
