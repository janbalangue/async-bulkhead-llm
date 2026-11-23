/**
 * Validator for the `stop` part of a limits snapshot.
 *
 * A pure function, like the class-limit validators: it reads a
 * caller-supplied value and either returns a validated, frozen copy or
 * throws. It never touches engine state.
 */
import type { LLMAdmissionStopPolicy } from "../types.js";
import { assertNonNegativeInteger } from "../validation.js";

/** Largest delay `setTimeout` honors without firing at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Read the `stop` part of a limits snapshot. `undefined` means the
 * snapshot carries no stop policy. Each property is read once, so an
 * accessor cannot return one value here and another later.
 */
export function readStopPolicy(
  supplied: unknown,
  tokenBudgetEnabled: boolean,
): LLMAdmissionStopPolicy | undefined {
  if (supplied === undefined) return undefined;
  if (
    typeof supplied !== "object" ||
    supplied === null ||
    Array.isArray(supplied)
  ) {
    throw new Error("limits.stop must be an object");
  }
  const source = supplied as LLMAdmissionStopPolicy;
  const overrunAllowanceTokens = source.overrunAllowanceTokens;
  const takeBackGraceMs = source.takeBackGraceMs;

  if (overrunAllowanceTokens !== undefined) {
    assertNonNegativeInteger(
      overrunAllowanceTokens,
      "limits.stop.overrunAllowanceTokens",
    );
    if (!tokenBudgetEnabled) {
      throw new Error(
        "limits.stop.overrunAllowanceTokens requires tokenBudget to be configured",
      );
    }
  }
  if (takeBackGraceMs !== undefined) {
    assertNonNegativeInteger(takeBackGraceMs, "limits.stop.takeBackGraceMs");
    if (takeBackGraceMs > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `limits.stop.takeBackGraceMs must be <= ${MAX_TIMER_DELAY_MS}`,
      );
    }
  }
  return Object.freeze({
    ...(overrunAllowanceTokens !== undefined && { overrunAllowanceTokens }),
    ...(takeBackGraceMs !== undefined && { takeBackGraceMs }),
  });
}
