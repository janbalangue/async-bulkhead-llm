/**
 * The admitted token: what a caller holds between admission and final
 * release. It reports streaming usage (which can grow or shrink the token
 * hold), can hand a borrowed concurrency slot back early, and settles
 * everything exactly once at release.
 *
 * This module keeps no pool or class counters. A token carries only its
 * own call's progress; every shared number it moves goes through the
 * owner of that number.
 */
import type { Token } from "async-bulkhead-ts";
import type {
  LLMAdmissionResources,
  LLMBorrowedConcurrencyAbandonCause,
  LLMPriority,
  LLMRequest,
  ProgressiveReconciliationOptions,
  TokenUsage,
  UsageReport,
} from "../types.js";
import { validateTokenUsage } from "../validation.js";
import type { AdmissionCounts } from "./admission-counts.js";
import type { ClassSlots } from "./class-slots.js";
import type { EventHub } from "./events.js";
import {
  ABANDON_WITH_CAUSE,
  type ReservationParts,
  type WrappedLLMToken,
} from "./shared.js";
import type { TokenLedger } from "./token-ledger.js";
import {
  assertReconciliation,
  consumedTokens,
  holdAfterReport,
  mergeUsage,
  progressiveFields,
  usageChanged,
  usageSnapshot,
  type UsageCell,
} from "./usage-report.js";

type Deps = {
  budgetEnabled: boolean;
  ledger: TokenLedger;
  slots: ClassSlots;
  counts: AdmissionCounts;
  events: EventHub;
  /** Wake `drain()` callers once the last admitted call has settled. */
  settleDrainWaiters: () => void;
};

/** Everything fixed at the moment a call was admitted. */
export type AdmittedCall = {
  /** The concurrency gate's own token for the slot this call holds. */
  readonly base: Token;
  readonly parts: ReservationParts | null;
  readonly request: LLMRequest;
  readonly admissionId: string;
  readonly limitRevision: number;
  readonly priority: LLMPriority;
  readonly admissionClass: string | undefined;
  readonly resources: LLMAdmissionResources;
};

/** One token's own progress. It never leaves this file. */
type TokenState = {
  /** `release()` has run: nothing is held against the budget any more. */
  finished: boolean;
  /** The concurrency slot went back, by release or by abandonment. */
  slotReturned: boolean;
  /** Tokens currently held against the budget for this request. */
  held: number;
  /** Last reported cumulative usage (monotonically clamped). */
  readonly usage: UsageCell;
  /** Monotonic sequence of effective pre-release usage updates. */
  usageSequence: number;
};

/** Fields every lifecycle event of an admitted call starts with. */
function callFields(call: AdmittedCall) {
  return {
    request: call.request,
    admissionId: call.admissionId,
    limitRevision: call.limitRevision,
    priority: call.priority,
    ...(call.admissionClass !== undefined
      ? { admissionClass: call.admissionClass }
      : {}),
  };
}

/** The `UsageReport` for a token as it stands right now. */
function snapshotOf(call: AdmittedCall, state: TokenState): UsageReport {
  const consumed = consumedTokens(state.usage);
  const outputCap = call.parts ? call.parts.maxOutput : null;
  return usageSnapshot({
    admissionId: call.admissionId,
    limitRevision: call.limitRevision,
    admissionClass: call.admissionClass,
    parts: call.parts,
    cell: state.usage,
    consumed,
    outputCap,
    sequence: state.usageSequence,
    held: state.held,
  });
}

function reportUsage(
  deps: Deps,
  call: AdmittedCall,
  state: TokenState,
  usage: TokenUsage,
  reconciliation?: ProgressiveReconciliationOptions,
): UsageReport {
  const { parts } = call;
  const cell = state.usage;
  const valid = validateTokenUsage(usage);
  assertReconciliation(reconciliation, parts);
  const previousReported = cell.reported;
  cell.reported = mergeUsage(previousReported, valid);
  const changed = usageChanged(cell, previousReported);
  const previousHeldTokens = state.held;

  // Accounting only applies pre-release with a budget configured.
  if (!state.finished && parts && deps.budgetEnabled) {
    const newHold = holdAfterReport(parts, cell, reconciliation);
    const delta = newHold - state.held;
    if (delta > 0) {
      deps.ledger.grow(call.admissionClass, delta);
    } else if (delta < 0) {
      deps.ledger.shrink(call.admissionClass, -delta);
    }
    state.held = newHold;
  }
  const holdChanged = state.held !== previousHeldTokens;
  if (!state.finished && (changed || holdChanged)) {
    state.usageSequence++;
  }

  const report = snapshotOf(call, state);

  if (!state.finished && (changed || holdChanged)) {
    deps.events.emit("usage", {
      ...callFields(call),
      sequence: state.usageSequence,
      reservedTokens: parts?.reserved ?? 0,
      previousHeldTokens,
      heldTokens: state.held,
      deltaTokens: state.held - previousHeldTokens,
      usage: { ...cell.reported! },
      outputCap: report.outputCap,
      outputRemaining: report.outputRemaining,
      overReservation: report.overReservation,
      ...progressiveFields(reconciliation),
    });
  }

  return report;
}

/**
 * Return a borrowed concurrency slot before the call settles. The token
 * hold stays charged until `release()`: a local abandonment does not
 * prove the provider stopped work.
 */
function abandonSlot(
  deps: Deps,
  call: AdmittedCall,
  state: TokenState,
  cause: LLMBorrowedConcurrencyAbandonCause,
): boolean {
  if (
    state.finished ||
    state.slotReturned ||
    !call.resources.borrowedConcurrency
  ) {
    return false;
  }
  state.slotReturned = true;
  try {
    call.base.release();
  } finally {
    deps.slots.vacate(call.admissionClass);
  }
  deps.counts.noteAbandon(call.admissionClass, cause);
  deps.events.emit("borrowedConcurrencyAbandon", {
    ...callFields(call),
    resources: call.resources,
    cause,
    heldTokens: state.held,
  });
  return true;
}

function release(
  deps: Deps,
  call: AdmittedCall,
  state: TokenState,
  usage?: TokenUsage,
): void {
  if (state.finished) return;
  state.finished = true;

  let validUsage: TokenUsage | undefined;
  let usageError: unknown;
  if (usage !== undefined) {
    try {
      validUsage = validateTokenUsage(usage);
    } catch (err) {
      usageError = err;
    }
  }
  // Fall back to the last mid-flight report when no (valid)
  // explicit usage is provided at release.
  if (validUsage === undefined && state.usage.reported !== undefined) {
    validUsage = state.usage.reported;
  }

  try {
    if (!state.slotReturned) {
      state.slotReturned = true;
      try {
        call.base.release();
      } finally {
        deps.slots.vacate(call.admissionClass);
      }
    }
  } finally {
    // Zero `held` before returning tokens: nothing is held against
    // the budget after release, and post-release `reportUsage()`
    // snapshots must reflect that (previously they reported the
    // stale pre-release hold).
    const heldAtRelease = state.held;
    state.held = 0;
    const refunded = deps.ledger.settle(
      call.admissionClass,
      heldAtRelease,
      validUsage,
    );
    deps.counts.noteRelease(call.admissionClass);
    deps.settleDrainWaiters();
    deps.events.emit("release", {
      ...callFields(call),
      reservedTokens: call.parts?.reserved ?? 0,
      resources: call.resources,
      heldTokens: heldAtRelease,
      refundedTokens: refunded,
      usageSequence: state.usageSequence,
      ...(validUsage !== undefined && { usage: validUsage }),
    });
  }

  if (usageError !== undefined) throw usageError;
}

export function createTokenWrapper(deps: Deps) {
  /**
   * Wraps a base Token so that release() also returns the token
   * reservation and optionally applies the refund, and so that
   * streaming callers can report cumulative usage mid-flight.
   */
  return function wrapToken(call: AdmittedCall): WrappedLLMToken {
    const state: TokenState = {
      finished: false,
      slotReturned: false,
      held: call.parts?.reserved ?? 0,
      usage: { reported: undefined },
      usageSequence: 0,
    };
    /** Public copy: callers cannot mutate internal accounting parts. */
    const reservation =
      call.parts === null ? null : Object.freeze({ ...call.parts });
    const abandonBorrowedConcurrency = (
      cause: LLMBorrowedConcurrencyAbandonCause,
    ): boolean => abandonSlot(deps, call, state, cause);

    return {
      admissionId: call.admissionId,
      limitRevision: call.limitRevision,
      ...(call.admissionClass !== undefined
        ? { admissionClass: call.admissionClass }
        : {}),
      reservation,
      resources: call.resources,
      reportUsage: (
        usage: TokenUsage,
        reconciliation?: ProgressiveReconciliationOptions,
      ): UsageReport => reportUsage(deps, call, state, usage, reconciliation),
      abandonBorrowedConcurrency: () => abandonBorrowedConcurrency("manual"),
      [ABANDON_WITH_CAUSE]: abandonBorrowedConcurrency,
      release(usage?: TokenUsage) {
        release(deps, call, state, usage);
      },
    };
  };
}

export type WrapToken = ReturnType<typeof createTokenWrapper>;
