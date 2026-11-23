/**
 * Owner of the set of running calls: every admitted call that has neither
 * reached final settlement nor been stopped, in admission order.
 *
 * The other owners keep counters only, which is enough to admit and
 * release work. Stopping admitted work needs the calls themselves: which
 * ones are still running, what each holds right now, and which to stop
 * first. Nothing outside this file adds to or removes from the set; the
 * admitted token registers its call at admission and removes it at stop or
 * final release.
 *
 * Every admission pays for being registered, whether or not anything is
 * ever stopped, so the set is a linked list threaded through the calls
 * themselves. Adding or removing a call is a few pointer writes: no
 * allocation and no hashing.
 *
 * The stop order is fixed and lives here:
 *
 *   1. calls admitted on borrowed capacity
 *   2. normal priority before high priority
 *   3. on a tie, the call admitted last
 */
import type { LLMPriority } from "../types.js";

/**
 * One running call, as the stop triggers see it: a read-only view of the
 * admitted token's own record. `slotReturned` and `held` are live.
 */
export type RunningCall = {
  readonly priority: LLMPriority;
  readonly admissionClass: string | undefined;
  /** Admitted on a slot or on tokens above its class floor. */
  readonly borrowed: boolean;
  /** Tokens reserved at admission; 0 without a token budget. */
  readonly reservedTokens: number;
  /** The concurrency slot went back before final settlement. */
  readonly slotReturned: boolean;
  /** Tokens the call holds against the budget right now. */
  readonly held: number;
  /**
   * Neighbors in admission order. These two belong to the set of running
   * calls: a call starts with both `undefined`, and only this file writes
   * them.
   */
  admittedBefore: RunningCall | undefined;
  admittedAfter: RunningCall | undefined;
};

/** Does `a` belong to a group that is stopped before the group of `b`? */
function groupStopsBefore(a: RunningCall, b: RunningCall): boolean {
  if (a.borrowed !== b.borrowed) return a.borrowed;
  return a.priority !== b.priority && a.priority === "normal";
}

export function createRunningCalls() {
  let oldest: RunningCall | undefined;
  let newest: RunningCall | undefined;

  /** A call was admitted: it is now the newest running call. */
  function add(call: RunningCall): void {
    call.admittedBefore = newest;
    call.admittedAfter = undefined;
    if (newest === undefined) oldest = call;
    else newest.admittedAfter = call;
    newest = call;
  }

  /**
   * A call was stopped or reached final settlement. The caller removes a
   * call exactly once, and only after adding it.
   */
  function remove(call: RunningCall): void {
    const before = call.admittedBefore;
    const after = call.admittedAfter;
    if (before === undefined) oldest = after;
    else before.admittedAfter = after;
    if (after === undefined) newest = before;
    else after.admittedBefore = before;
    call.admittedBefore = undefined;
    call.admittedAfter = undefined;
  }

  /** The call to stop first among those `eligible` accepts. */
  function firstToStop(
    eligible: (call: RunningCall) => boolean,
  ): RunningCall | undefined {
    let first: RunningCall | undefined;
    // Newest to oldest, so within a group the newest call is met first
    // and a later, older call of the same group never replaces it.
    for (let call = newest; call !== undefined; call = call.admittedBefore) {
      if (!eligible(call)) continue;
      if (first === undefined || groupStopsBefore(call, first)) first = call;
    }
    return first;
  }

  /** Every running call, the one to stop first at the front. */
  function inStopOrder(): RunningCall[] {
    const newestFirst: RunningCall[] = [];
    for (let call = newest; call !== undefined; call = call.admittedBefore) {
      newestFirst.push(call);
    }
    // The sort is stable, so calls of one group stay newest first.
    return newestFirst.sort((a, b) =>
      groupStopsBefore(a, b) ? -1 : groupStopsBefore(b, a) ? 1 : 0,
    );
  }

  /**
   * Tokens held by the calls still running: across the pool, or by one
   * class. A stopped call keeps its hold in the token ledger until it
   * settles, but it is no longer running, so it is not counted here.
   */
  function heldTokens(classId?: string): number {
    let total = 0;
    for (let call = oldest; call !== undefined; call = call.admittedAfter) {
      if (classId === undefined || call.admissionClass === classId) {
        total += call.held;
      }
    }
    return total;
  }

  return { add, remove, firstToStop, inStopOrder, heldTokens };
}

export type RunningCalls = ReturnType<typeof createRunningCalls>;
