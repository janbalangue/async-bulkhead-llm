/**
 * The three triggers that stop admitted work, and the decision of which
 * calls to stop. All of it is off until a limits snapshot carries a `stop`
 * policy or a drain asks for `stopOnTimeout`.
 *
 *   - overrun:   a usage report raised a hold too far
 *   - drain:     a bounded drain reached its deadline
 *   - take-back: a limits snapshot left running work above the new limits
 *                and its grace period ran out
 *
 * This module keeps one piece of state, the timer of the take-back that is
 * waiting. Everything else is read live. Whether running work fits the
 * applied limits is answered by `limit-fit.ts`, and stopping itself is
 * done by the admitted token, through `deps.stop`.
 *
 * Token fitting counts only the calls still running. A stopped call keeps
 * its hold in the ledger until it settles, which keeps blocking new
 * admissions, but it cannot be stopped a second time.
 */
import type { LLMAdmissionStopCause } from "../types.js";
import type { ClassSlots } from "./class-slots.js";
import { createLimitFit } from "./limit-fit.js";
import type { Limits } from "./limits.js";
import type { RunningCall, RunningCalls } from "./running-calls.js";
import type { ConcurrencyGate } from "./shared.js";

type Deps = {
  budgetEnabled: boolean;
  concurrency: ConcurrencyGate;
  limits: Limits;
  slots: ClassSlots;
  running: RunningCalls;
  /**
   * Stop one running call. Returns false when it had already been stopped
   * or had settled, so it is never counted twice.
   */
  stop: (call: RunningCall, cause: LLMAdmissionStopCause) => boolean;
};

const holdsTokens = (call: RunningCall): boolean => call.held > 0;

export function createStopper(deps: Deps) {
  const { limits, running, stop } = deps;
  const fit = createLimitFit(deps);

  /** The take-back waiting for its grace period to end, if any. */
  let pendingTakeBack: ReturnType<typeof setTimeout> | undefined;

  /** The grace period is over: stop enough calls to fit. */
  function takeBack(): void {
    for (;;) {
      const call = fit.nextToStop();
      // Every stop lowers the limit it was picked for, so this ends.
      if (call === undefined || !stop(call, "limits")) return;
    }
  }

  /**
   * A limits snapshot was applied. It replaces a take-back that is still
   * waiting; if it has a grace period and leaves running work above the
   * new limits, a new take-back starts waiting.
   */
  function limitsApplied(): void {
    if (pendingTakeBack !== undefined) {
      clearTimeout(pendingTakeBack);
      pendingTakeBack = undefined;
    }
    const graceMs = limits.stopPolicy()?.takeBackGraceMs;
    if (graceMs === undefined || !fit.aboveLimits()) return;
    const timer = setTimeout(() => {
      if (pendingTakeBack === timer) pendingTakeBack = undefined;
      takeBack();
    }, graceMs);
    // A waiting take-back must not keep an otherwise finished process up.
    (timer as { unref?: () => void }).unref?.();
    pendingTakeBack = timer;
  }

  /** Stop calls `eligible` accepts until `held()` is at most `target`. */
  function fitTokens(
    held: () => number,
    target: number,
    eligible: (call: RunningCall) => boolean,
    cause: LLMAdmissionStopCause,
  ): void {
    while (held() > target) {
      const call = running.firstToStop(eligible);
      if (call === undefined || !stop(call, cause)) return;
    }
  }

  /**
   * A usage report raised the hold of `call`, a call still running, by
   * `delta` tokens.
   *
   * The call is stopped if its hold is now more than the allowance above
   * its reservation. Then its class ceiling and the pool budget are
   * fitted: calls are stopped until the holds still running are back under
   * the limit. If they were already above a limit before this report (a
   * snapshot lowered it), only this report's growth is undone: bringing
   * running work down to a lowered limit is the take-back's job, with its
   * own grace period.
   */
  function holdGrew(call: RunningCall, delta: number): void {
    const allowance = limits.stopPolicy()?.overrunAllowanceTokens;
    if (allowance === undefined) return;

    const classId = call.admissionClass;
    const classCeiling =
      classId === undefined
        ? undefined
        : limits.classLimit(classId).maxInFlightTokens;
    const classBefore =
      classCeiling === undefined ? 0 : running.heldTokens(classId) - delta;
    const poolBefore = running.heldTokens() - delta;

    if (call.held > call.reservedTokens + allowance) {
      stop(call, "overrun");
    }
    if (classCeiling !== undefined) {
      fitTokens(
        () => running.heldTokens(classId),
        Math.max(classCeiling, classBefore),
        (other) => other.admissionClass === classId && holdsTokens(other),
        "overrun",
      );
    }
    fitTokens(
      () => running.heldTokens(),
      Math.max(limits.budget()!, poolBefore),
      holdsTokens,
      "overrun",
    );
  }

  /** A bounded drain reached its deadline: stop every running call. */
  function stopForDrain(): number {
    let stopped = 0;
    for (const call of running.inStopOrder()) {
      if (stop(call, "drain_deadline")) stopped++;
    }
    return stopped;
  }

  return { holdGrew, limitsApplied, stopForDrain };
}

export type Stopper = ReturnType<typeof createStopper>;
