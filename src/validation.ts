/**
 * Internal numeric guards and estimate/usage validators, shared by the
 * estimators, the adaptive estimator, and the bulkhead. Not part of the
 * public API — nothing here is re-exported from the package entry point.
 */
import type { TokenEstimate, TokenUsage } from "./types.js";

function isNonNegativeInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

export function assertNonNegativeInteger(value: number, name: string): void {
  if (!isNonNegativeInteger(value)) {
    throw new Error(`${name} must be an integer >= 0`);
  }
}

export function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export function assertOptionalNonNegativeInteger(
  value: number | undefined,
  name: string,
): void {
  if (value !== undefined) assertNonNegativeInteger(value, name);
}

export function validateTokenEstimate(estimate: TokenEstimate): number {
  assertNonNegativeInteger(estimate.input, "token estimator input");
  assertNonNegativeInteger(estimate.maxOutput, "token estimator maxOutput");
  const needed = estimate.input + estimate.maxOutput;
  assertNonNegativeInteger(needed, "token reservation");
  return needed;
}

export function validateTokenUsage(usage: TokenUsage): TokenUsage {
  assertNonNegativeInteger(usage.input, "token usage input");
  assertNonNegativeInteger(usage.output, "token usage output");
  const actual = usage.input + usage.output;
  assertNonNegativeInteger(actual, "token usage total");
  return usage;
}
