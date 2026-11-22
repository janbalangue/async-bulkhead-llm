/**
 * Owner of the admission outcome counts: admitted, released, rejected, and
 * borrowed-concurrency abandoned.
 *
 * Each count exists once for the whole bulkhead (the `llm`-prefixed
 * variables) and once per admission class. Each function below moves the
 * global count and the count of the class the call belongs to together.
 * Nothing outside this file writes them; a class is always named by its
 * id.
 */
import type {
  LLMBorrowedConcurrencyAbandonCause,
  LLMRejectReason,
  LLMRequestStats,
} from "../types.js";

type ClassCounts = {
  admitted: number;
  released: number;
  borrowedConcurrencyAbandoned: number;
  rejected: number;
  rejectedByReason: Partial<Record<LLMRejectReason, number>>;
};

export function createAdmissionCounts(classIds: Iterable<string>) {
  let llmAdmitted = 0;
  let llmReleased = 0;
  let llmBorrowedConcurrencyAbandoned = 0;
  const llmBorrowedConcurrencyAbandonedByCause: Partial<
    Record<LLMBorrowedConcurrencyAbandonCause, number>
  > = {};
  let llmRejected = 0;
  const llmRejectedByReason: Partial<Record<LLMRejectReason, number>> = {};
  const perClass = new Map<string, ClassCounts>();
  for (const id of classIds) {
    perClass.set(id, {
      admitted: 0,
      released: 0,
      borrowedConcurrencyAbandoned: 0,
      rejected: 0,
      rejectedByReason: {},
    });
  }

  function countsOf(classId: string | undefined): ClassCounts | undefined {
    return classId === undefined ? undefined : perClass.get(classId)!;
  }

  /** A call was admitted: it holds a slot and its token reservation. */
  function noteAdmit(classId: string | undefined): void {
    const cls = countsOf(classId);
    llmAdmitted++;
    if (cls !== undefined) cls.admitted++;
  }

  /** An admitted call reached final settlement. */
  function noteRelease(classId: string | undefined): void {
    const cls = countsOf(classId);
    llmReleased++;
    if (cls !== undefined) cls.released++;
  }

  /** A call was rejected at any stage, for the given reason. */
  function noteReject(
    classId: string | undefined,
    reason: LLMRejectReason,
  ): void {
    const cls = countsOf(classId);
    llmRejected++;
    llmRejectedByReason[reason] =
      (llmRejectedByReason[reason] ?? 0) + 1;
    if (cls !== undefined) {
      cls.rejected++;
      cls.rejectedByReason[reason] =
        (cls.rejectedByReason[reason] ?? 0) + 1;
    }
  }

  /** A borrowed concurrency slot was returned before final settlement. */
  function noteAbandon(
    classId: string | undefined,
    cause: LLMBorrowedConcurrencyAbandonCause,
  ): void {
    const cls = countsOf(classId);
    llmBorrowedConcurrencyAbandoned++;
    llmBorrowedConcurrencyAbandonedByCause[cause] =
      (llmBorrowedConcurrencyAbandonedByCause[cause] ?? 0) + 1;
    if (cls !== undefined) cls.borrowedConcurrencyAbandoned++;
  }

  /** Admitted calls that have not reached final settlement. */
  function unsettled(): number {
    return Math.max(0, llmAdmitted - llmReleased);
  }

  /** Detached copy of the global counts, in the public `stats().llm` shape. */
  function totals(): LLMRequestStats {
    return {
      inFlight: unsettled(),
      admitted: llmAdmitted,
      released: llmReleased,
      borrowedConcurrencyAbandoned: llmBorrowedConcurrencyAbandoned,
      borrowedConcurrencyAbandonedByCause: {
        ...llmBorrowedConcurrencyAbandonedByCause,
      },
      rejected: llmRejected,
      rejectedByReason: { ...llmRejectedByReason },
    };
  }

  /** Detached copy of one class's counts. */
  function classTotals(classId: string): ClassCounts {
    const cls = perClass.get(classId)!;
    return { ...cls, rejectedByReason: { ...cls.rejectedByReason } };
  }

  return {
    noteAdmit,
    noteRelease,
    noteReject,
    noteAbandon,
    unsettled,
    totals,
    classTotals,
  };
}

export type AdmissionCounts = ReturnType<typeof createAdmissionCounts>;
