/**
 * Token reservation for one request: what admission will hold against the
 * budget. The value comes from the caller's per-call override when one is
 * given, otherwise from the configured estimator.
 */
import type {
  LLMBulkheadOptions,
  LLMRequest,
  LLMReservationEstimate,
  LLMReservationOverride,
  TokenBudgetOptions,
} from "../types.js";
import { createModelAwareTokenEstimator } from "../estimators.js";
import {
  assertNonNegativeInteger,
  assertOptionalNonNegativeInteger,
  validateTokenEstimate,
} from "../validation.js";
import type { ReservationParts } from "./shared.js";

export function createReservations(
  budget: TokenBudgetOptions | undefined,
  opts: Pick<LLMBulkheadOptions, "model">,
) {
  const estimator =
    budget?.estimator ??
    createModelAwareTokenEstimator(undefined, {
      defaultModel: opts.model,
      outputCap: budget?.outputCap,
    });

  /**
   * Reservation used for admission: the caller's per-call `reservation`
   * override verbatim when provided, otherwise the estimator's output.
   * Both paths validate as non-negative integers. `null` when
   * `tokenBudget` is disabled (no reservation participates then, and
   * the override is deliberately ignored).
   */
  function resolve(
    request: LLMRequest,
    override: LLMReservationOverride | undefined,
  ): ReservationParts | null {
    assertOptionalNonNegativeInteger(request.max_tokens, "request.max_tokens");
    if (!budget) return null;
    if (override !== undefined) {
      const reserved = validateTokenEstimate(override);
      // v3.8: `reserved`, when present (e.g. an `estimate()` result passed
      // back verbatim), is a consistency check — not an independent input.
      if (override.reserved !== undefined) {
        assertNonNegativeInteger(override.reserved, "reservation.reserved");
        if (override.reserved !== reserved) {
          throw new Error(
            `reservation.reserved (${override.reserved}) must equal ` +
              `reservation.input + reservation.maxOutput (${reserved})`,
          );
        }
      }
      return {
        input: override.input,
        maxOutput: override.maxOutput,
        reserved,
      };
    }
    const estimate = estimator(request);
    const reserved = validateTokenEstimate(estimate);
    return {
      input: estimate.input,
      maxOutput: estimate.maxOutput,
      reserved,
    };
  }

  /** Preview the estimator path's reservation without reserving anything. */
  function estimate(request: LLMRequest): LLMReservationEstimate | null {
    const parts = resolve(request, undefined);
    return parts === null ? null : { ...parts };
  }

  return { resolve, estimate };
}

export type Reservations = ReturnType<typeof createReservations>;
