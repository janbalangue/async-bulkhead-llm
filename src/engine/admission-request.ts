/**
 * Resolving what one call asks for: its priority, its admission class (as
 * an id) and its token reservation. Invalid input throws here, before any
 * capacity is looked at.
 */
import type { LLMAcquireOptions, LLMPriority, LLMRequest } from "../types.js";
import type { Limits } from "./limits.js";
import type { Reservations } from "./reservation.js";
import type { ResolvedAdmission } from "./shared.js";

function resolvePriority(priority: LLMPriority | undefined): LLMPriority {
  if (priority === undefined) return "normal";
  if (priority !== "high" && priority !== "normal") {
    throw new Error(`priority must be "high" or "normal"`);
  }
  return priority;
}

export function createAdmissionResolver(
  limits: Limits,
  reservations: Reservations,
) {
  /**
   * `resolvedClass` lets a caller that already resolved the class (for
   * deduplication keying) pass it on instead of resolving it twice.
   */
  return function resolveAdmission(
    request: LLMRequest,
    ao: Pick<
      LLMAcquireOptions,
      "priority" | "reservation" | "admissionClass"
    >,
    resolvedClass: string | undefined = limits.resolveClass(ao.admissionClass),
  ): ResolvedAdmission {
    const priority = resolvePriority(ao.priority);
    const parts = reservations.resolve(request, ao.reservation);
    return {
      priority,
      admissionClass: resolvedClass,
      parts,
      reserved: parts?.reserved ?? 0,
    };
  };
}

export type ResolveAdmission = ReturnType<typeof createAdmissionResolver>;
