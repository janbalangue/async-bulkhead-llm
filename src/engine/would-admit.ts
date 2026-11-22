/**
 * The advisory dry run behind `wouldAdmit()` and observe mode: would this
 * call be admitted right now? It reserves nothing and changes nothing, so
 * the answer can be stale by the time a real `acquire()` lands.
 */
import type { LLMCapacityConstraint, LLMWouldAdmitResult } from "../types.js";
import type { Capacity } from "./capacity.js";
import type { BuildRejectDetail } from "./reject-detail.js";
import type { ConcurrencyGate, ResolvedAdmission } from "./shared.js";

export function createWouldAdmit(deps: {
  concurrency: ConcurrencyGate;
  capacity: Capacity;
  buildRejectDetail: BuildRejectDetail;
}) {
  const { concurrency, capacity, buildRejectDetail } = deps;

  return function wouldAdmitResolved(
    admission: ResolvedAdmission,
    includeDetail: boolean,
  ): LLMWouldAdmitResult {
    const { priority, admissionClass, reserved } = admission;
    const withDetail = (
      result: LLMWouldAdmitResult,
      constraint?: LLMCapacityConstraint,
    ): LLMWouldAdmitResult => {
      if (includeDetail) {
        result.detail = buildRejectDetail(
          reserved,
          priority,
          admissionClass,
          constraint,
        );
      }
      return result;
    };
    const base = concurrency.stats();
    if (base.closed) {
      return withDetail({ admit: false, reason: "shutdown" });
    }
    const capacityFailure = capacity.check(reserved, priority, admissionClass);
    if (capacityFailure !== undefined) {
      return withDetail(
        { admit: false, reason: capacityFailure.reason },
        capacityFailure.constraint,
      );
    }
    if (base.inFlight < base.maxConcurrent) {
      return withDetail({ admit: true });
    }
    if (base.maxConcurrent === 0) {
      return withDetail(
        { admit: false, reason: "concurrency_limit" },
        "global",
      );
    }
    if (base.pending < base.maxQueue) {
      return withDetail({ admit: true });
    }
    return withDetail(
      {
        admit: false,
        reason: base.maxQueue > 0 ? "queue_limit" : "concurrency_limit",
      },
      "global",
    );
  };
}

export type WouldAdmitResolved = ReturnType<typeof createWouldAdmit>;
