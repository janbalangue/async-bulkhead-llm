/** The library's single error type, thrown by `run()` on rejection. */
import type { LLMRejectDetail, LLMRejectReason } from "./types.js";

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
