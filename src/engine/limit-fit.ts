/**
 * Does running work fit the applied limits, and if not, which call should
 * be stopped next to make it fit?
 *
 * Read-only. Limits come from their owner, slots from the gate and the
 * class slots, and the running calls from the set that owns them. Used by
 * the take-back in `stop.ts`.
 *
 * Token limits are checked against the calls still running. A stopped
 * call keeps its hold in the ledger until it settles, but it cannot be
 * stopped a second time, so it is left out.
 */
import type { ClassSlots } from "./class-slots.js";
import type { Limits } from "./limits.js";
import type { RunningCall, RunningCalls } from "./running-calls.js";
import type { ConcurrencyGate } from "./shared.js";

type Deps = {
  budgetEnabled: boolean;
  concurrency: ConcurrencyGate;
  limits: Limits;
  slots: ClassSlots;
  running: RunningCalls;
};

/** One limit that running work can be above. */
type LimitCheck = {
  /** Is running work above this limit right now? */
  over(): boolean;
  /** May stopping this call bring the work back under the limit? */
  eligible(call: RunningCall): boolean;
};

const holdsTokens = (call: RunningCall): boolean => call.held > 0;

export function createLimitFit(deps: Deps) {
  const { budgetEnabled, concurrency, limits, slots, running } = deps;
  const classIds = limits.classIds;

  /** Slots held above the class floors, summed over every class. */
  function borrowedSlots(): number {
    let borrowed = 0;
    for (const id of classIds) {
      borrowed += Math.max(
        0,
        slots.inFlight(id) - limits.classLimit(id).protectedConcurrent,
      );
    }
    return borrowed;
  }

  /** Running tokens held above the class floors, summed over every class. */
  function borrowedTokens(): number {
    let borrowed = 0;
    for (const id of classIds) {
      borrowed += Math.max(
        0,
        running.heldTokens(id) - limits.classLimit(id).protectedInFlightTokens,
      );
    }
    return borrowed;
  }

  const classOf = (call: RunningCall): string | undefined =>
    call.admissionClass;

  /**
   * Every limit a snapshot can lower, most specific first: a class that is
   * above its own ceiling gives up its own calls before anything shared is
   * looked at, and a restored floor takes from the classes above their
   * floors before the pool as a whole is trimmed.
   */
  function* limitChecks(): Generator<LimitCheck> {
    for (const id of classIds) {
      const classLimit = limits.classLimit(id);
      yield {
        over: () =>
          classLimit.maxConcurrent !== undefined &&
          slots.inFlight(id) > classLimit.maxConcurrent,
        eligible: (call) => classOf(call) === id && !call.slotReturned,
      };
      if (!budgetEnabled) continue;
      yield {
        over: () =>
          classLimit.maxInFlightTokens !== undefined &&
          running.heldTokens(id) > classLimit.maxInFlightTokens,
        eligible: (call) => classOf(call) === id && holdsTokens(call),
      };
    }

    if (limits.protectedConcurrentTotal() > 0) {
      yield {
        over: () =>
          borrowedSlots() >
          Math.max(
            0,
            concurrency.stats().maxConcurrent -
              limits.protectedConcurrentTotal(),
          ),
        eligible: (call) => {
          const id = classOf(call);
          return (
            id !== undefined &&
            !call.slotReturned &&
            slots.inFlight(id) > limits.classLimit(id).protectedConcurrent
          );
        },
      };
    }
    if (budgetEnabled && limits.protectedTokensTotal() > 0) {
      yield {
        over: () =>
          borrowedTokens() >
          Math.max(0, limits.budget()! - limits.protectedTokensTotal()),
        eligible: (call) => {
          const id = classOf(call);
          return (
            id !== undefined &&
            holdsTokens(call) &&
            running.heldTokens(id) >
              limits.classLimit(id).protectedInFlightTokens
          );
        },
      };
    }

    yield {
      over: () => {
        const gate = concurrency.stats();
        return gate.inFlight > gate.maxConcurrent;
      },
      eligible: (call) => !call.slotReturned,
    };
    if (budgetEnabled) {
      yield {
        over: () => running.heldTokens() > limits.budget()!,
        eligible: holdsTokens,
      };
    }
  }

  /** Is running work above any of the applied limits? */
  function aboveLimits(): boolean {
    for (const check of limitChecks()) {
      if (check.over()) return true;
    }
    return false;
  }

  /** The next call to stop so that running work fits the applied limits. */
  function nextToStop(): RunningCall | undefined {
    for (const check of limitChecks()) {
      if (!check.over()) continue;
      const call = running.firstToStop(check.eligible);
      if (call !== undefined) return call;
    }
    return undefined;
  }

  return { aboveLimits, nextToStop };
}

export type LimitFit = ReturnType<typeof createLimitFit>;
