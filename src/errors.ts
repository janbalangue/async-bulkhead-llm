/** Typed errors returned by `run()` for admission rejection and lease expiry. */
import type {
  LLMAdmissionResources,
  LLMRejectDetail,
  LLMRejectReason,
} from "./types.js";

export class LLMBulkheadRejectedError extends Error {
  readonly code = "LLM_BULKHEAD_REJECTED" as const;
  readonly detail: LLMRejectDetail | undefined;

  constructor(reason: LLMRejectReason, detail?: LLMRejectDetail);
  constructor(
    readonly reason: LLMRejectReason,
    detail?: LLMRejectDetail,
  ) {
    super(`LLM bulkhead rejected: ${reason}`);
    this.name = "LLMBulkheadRejectedError";
    this.detail = detail;
  }
}

/**
 * Returned by `run()` when an admitted borrowed concurrency slot reaches its
 * wall-clock deadline. The local slot has been returned, but token accounting
 * remains held until the underlying callback actually settles.
 */
export class LLMBorrowedConcurrencyDeadlineError extends Error {
  readonly code = "LLM_BORROWED_CONCURRENCY_DEADLINE" as const;

  constructor(
    readonly deadlineMs: number,
    readonly admissionId: string,
    readonly resources: LLMAdmissionResources,
    readonly admissionClass?: string,
  ) {
    super(`Borrowed LLM concurrency deadline expired after ${deadlineMs}ms`);
    this.name = "LLMBorrowedConcurrencyDeadlineError";
  }
}
