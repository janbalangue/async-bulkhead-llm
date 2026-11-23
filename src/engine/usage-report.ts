/**
 * Usage-report arithmetic shared by admitted and bypassed calls: checking
 * a progressive reconciliation, keeping cumulative usage monotonic,
 * working out the hold a report implies, and building the `UsageReport`
 * snapshot. Everything here works on one call's own values.
 */
import type {
  ProgressiveReconciliationOptions,
  TokenUsage,
  UsageReport,
} from "../types.js";
import {
  assertNonNegativeInteger,
  assertOptionalNonNegativeInteger,
} from "../validation.js";
import type { ReservationParts } from "./shared.js";

/**
 * Holds one call's cumulative reported usage.
 *
 * The first report stores the caller's own usage object, so reading one of
 * its fields can run caller code, which may report again on the same call.
 * The functions below therefore read `cell.reported` afresh at every use
 * and never keep a copy of it across a field read.
 */
export type UsageCell = { reported: TokenUsage | undefined };

export function assertReconciliation(
  reconciliation: ProgressiveReconciliationOptions | undefined,
  parts: ReservationParts | null,
): void {
  if (reconciliation === undefined) return;
  assertNonNegativeInteger(
    reconciliation.remainingOutputTokens,
    "progressive reconciliation remainingOutputTokens",
  );
  assertOptionalNonNegativeInteger(
    reconciliation.safetyMarginTokens,
    "progressive reconciliation safetyMarginTokens",
  );
  if (
    parts !== null &&
    reconciliation.remainingOutputTokens > parts.maxOutput
  ) {
    throw new RangeError(
      "progressive reconciliation remainingOutputTokens must not exceed the reserved output cap",
    );
  }
}

/**
 * Clamp to monotonic non-decreasing per field — cumulative stream usage
 * never shrinks; a lower report is stale.
 */
export function mergeUsage(
  previous: TokenUsage | undefined,
  valid: TokenUsage,
): TokenUsage {
  return previous
    ? {
        input: Math.max(previous.input, valid.input),
        output: Math.max(previous.output, valid.output),
      }
    : valid;
}

/** Did the report just merged into the cell move either field? */
export function usageChanged(
  cell: UsageCell,
  previous: TokenUsage | undefined,
): boolean {
  return (
    previous === undefined ||
    cell.reported!.input !== previous.input ||
    cell.reported!.output !== previous.output
  );
}

/**
 * Tokens a call should hold after a usage report.
 *
 * Legacy mode holds known input plus the full output reservation.
 * Progressive mode is opt-in and may be used only after prefill is
 * known complete: it holds the caller-declared future output plus an
 * explicit safety margin. Output beyond the configured cap is added
 * back as overrun protection.
 */
export function holdAfterReport(
  parts: ReservationParts,
  cell: UsageCell,
  reconciliation: ProgressiveReconciliationOptions | undefined,
): number {
  const outputOverrun = Math.max(0, cell.reported!.output - parts.maxOutput);
  return reconciliation === undefined
    ? cell.reported!.input + Math.max(parts.maxOutput, cell.reported!.output)
    : reconciliation.remainingOutputTokens +
        (reconciliation.safetyMarginTokens ?? 0) +
        outputOverrun;
}

/** Event fields that mark a report as a progressive reconciliation. */
export function progressiveFields(
  reconciliation: ProgressiveReconciliationOptions | undefined,
): {
  progressive?: true;
  remainingOutputTokens?: number;
  safetyMarginTokens?: number;
} {
  return reconciliation === undefined
    ? {}
    : {
        progressive: true,
        remainingOutputTokens: reconciliation.remainingOutputTokens,
        safetyMarginTokens: reconciliation.safetyMarginTokens ?? 0,
      };
}

/** Cumulative tokens a call has reported so far. */
export function consumedTokens(cell: UsageCell): number {
  return cell.reported ? cell.reported.input + cell.reported.output : 0;
}

/**
 * Build the `UsageReport` for one call.
 *
 * The caller works out `consumed` (with `consumedTokens`) and `outputCap`
 * first, and only then reads the call's `sequence` and `held`.
 */
export function usageSnapshot(call: {
  admissionId: string;
  limitRevision: number;
  admissionClass: string | undefined;
  parts: ReservationParts | null;
  cell: UsageCell;
  consumed: number;
  outputCap: number | null;
  sequence: number;
  held: number;
  /** The engine has stopped this call. Never set for bypassed work. */
  stopped?: boolean;
}): UsageReport {
  const { parts, cell, consumed, outputCap } = call;
  return {
    admissionId: call.admissionId,
    limitRevision: call.limitRevision,
    ...(call.admissionClass !== undefined
      ? { admissionClass: call.admissionClass }
      : {}),
    sequence: call.sequence,
    reserved: parts?.reserved ?? 0,
    held: call.held,
    consumed,
    outputCap,
    outputRemaining:
      outputCap === null
        ? null
        : Math.max(0, outputCap - (cell.reported?.output ?? 0)),
    overReservation: parts ? consumed > parts.reserved : false,
    ...(call.stopped === true ? { stopped: true as const } : {}),
  };
}
