/**
 * Validators for admission-class ids and class limits.
 *
 * Pure functions: each reads a caller-supplied value and either returns a
 * validated copy or throws. They run at construction and again for every
 * limits snapshot, and they never touch engine state.
 */
import type { LLMAdmissionClassLimits } from "../types.js";
import { assertOptionalNonNegativeInteger } from "../validation.js";

export function validateAdmissionClassId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function readAdmissionClassLimits(
  value: unknown,
  label: string,
  tokenBudgetEnabled: boolean,
): LLMAdmissionClassLimits {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const source = value as LLMAdmissionClassLimits;
  const protectedConcurrent = source.protectedConcurrent;
  const maxConcurrent = source.maxConcurrent;
  const protectedInFlightTokens = source.protectedInFlightTokens;
  const maxInFlightTokens = source.maxInFlightTokens;
  assertOptionalNonNegativeInteger(
    protectedConcurrent,
    `${label}.protectedConcurrent`,
  );
  assertOptionalNonNegativeInteger(
    maxConcurrent,
    `${label}.maxConcurrent`,
  );
  assertOptionalNonNegativeInteger(
    protectedInFlightTokens,
    `${label}.protectedInFlightTokens`,
  );
  assertOptionalNonNegativeInteger(
    maxInFlightTokens,
    `${label}.maxInFlightTokens`,
  );
  if (
    maxConcurrent !== undefined &&
    (protectedConcurrent ?? 0) > maxConcurrent
  ) {
    throw new Error(
      `${label}.protectedConcurrent must be <= ${label}.maxConcurrent`,
    );
  }
  if (
    maxInFlightTokens !== undefined &&
    (protectedInFlightTokens ?? 0) > maxInFlightTokens
  ) {
    throw new Error(
      `${label}.protectedInFlightTokens must be <= ${label}.maxInFlightTokens`,
    );
  }
  if (!tokenBudgetEnabled) {
    if (protectedInFlightTokens !== undefined) {
      throw new Error(
        `${label}.protectedInFlightTokens requires tokenBudget to be configured`,
      );
    }
    if (maxInFlightTokens !== undefined) {
      throw new Error(
        `${label}.maxInFlightTokens requires tokenBudget to be configured`,
      );
    }
  }
  return Object.freeze({
    ...(protectedConcurrent !== undefined && { protectedConcurrent }),
    ...(maxConcurrent !== undefined && { maxConcurrent }),
    ...(protectedInFlightTokens !== undefined && {
      protectedInFlightTokens,
    }),
    ...(maxInFlightTokens !== undefined && { maxInFlightTokens }),
  });
}

export function validateProtectedCapacity(
  limits: Iterable<LLMAdmissionClassLimits>,
  maxConcurrent: number,
  tokenBudget: number | undefined,
  label: string,
): void {
  let protectedConcurrent = 0;
  let protectedTokens = 0;
  for (const classLimits of limits) {
    protectedConcurrent += classLimits.protectedConcurrent ?? 0;
    protectedTokens += classLimits.protectedInFlightTokens ?? 0;
  }
  if (protectedConcurrent > maxConcurrent) {
    throw new Error(
      `${label} protectedConcurrent sum must be <= maxConcurrent`,
    );
  }
  if (tokenBudget !== undefined && protectedTokens > tokenBudget) {
    throw new Error(
      `${label} protectedInFlightTokens sum must be <= tokenBudget.budget`,
    );
  }
}

/**
 * Read the `admissionClasses` part of a limits snapshot.
 *
 * `classIds` is the fixed construction-time class table, or `undefined`
 * when the bulkhead has no classes. A snapshot must name exactly those
 * classes: keys cannot be added or removed at runtime.
 */
export function readAdmissionClassLimitsUpdate(
  supplied: unknown,
  classIds: readonly string[] | undefined,
  tokenBudgetEnabled: boolean,
): Map<string, LLMAdmissionClassLimits> | undefined {
  if (classIds === undefined) {
    if (supplied !== undefined) {
      throw new Error(
        "limits.admissionClasses must be omitted because admissionClasses was not configured at construction",
      );
    }
    return undefined;
  }
  if (supplied === undefined) {
    throw new Error(
      "limits.admissionClasses is required because admissionClasses was configured at construction",
    );
  }
  if (
    typeof supplied !== "object" ||
    supplied === null ||
    Array.isArray(supplied)
  ) {
    throw new Error("limits.admissionClasses must be an object");
  }
  const suppliedKeys = Object.keys(supplied);
  if (suppliedKeys.length !== classIds.length) {
    throw new Error(
      "limits.admissionClasses must contain exactly the construction-time class keys",
    );
  }
  const prepared = new Map<string, LLMAdmissionClassLimits>();
  for (const id of classIds) {
    if (!Object.prototype.hasOwnProperty.call(supplied, id)) {
      throw new Error(
        "limits.admissionClasses must contain exactly the construction-time class keys",
      );
    }
    prepared.set(
      id,
      readAdmissionClassLimits(
        (supplied as Record<string, unknown>)[id],
        `limits.admissionClasses[${JSON.stringify(id)}]`,
        tokenBudgetEnabled,
      ),
    );
  }
  return prepared;
}
