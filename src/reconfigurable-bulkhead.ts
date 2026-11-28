/**
 * Internal dynamically reconfigurable concurrency bulkhead.
 *
 * Adapted from the Apache-2.0-licensed async-bulkhead-ts 1.0.0 state
 * machine, with mutable concurrency/queue snapshots and zero-capacity
 * fail-fast semantics added for this package.
 *
 * This intentionally mirrors the public behavior and stats shape of
 * async-bulkhead-ts while adding an atomic `applyLimits()` operation.
 * It is kept private because the LLM wrapper is the supported API surface.
 */
import type {
  AcquireOptions,
  AcquireResult,
  RejectReason,
  Stats,
  Token,
  TryAcquireResult,
} from "async-bulkhead-ts";

export type ConcurrencyLimits = {
  maxConcurrent: number;
  maxQueue: number;
};

/**
 * Runs synchronously at the moment a slot is granted, before anything else
 * can observe the slot as held. Returning `false` gives the slot straight
 * back: the acquire still resolves `ok`, with a token that is already
 * released.
 */
export type GrantHook = () => boolean;

type Waiter = {
  resolve: (result: AcquireResult) => void;
  onGrant: GrantHook | undefined;
  settled: boolean;
  abortListener: (() => void) | undefined;
  timeoutId: ReturnType<typeof setTimeout> | undefined;
  /** True while the waiter stands in the waiting line. */
  inLine: boolean;
  /** Neighbors in the waiting line; both unset once the waiter left it. */
  ahead: Waiter | undefined;
  behind: Waiter | undefined;
};

/**
 * The waiters still waiting for a slot, oldest first.
 *
 * A waiter leaves the line the moment it settles, wherever it stands: at
 * the front when it is granted a slot, anywhere when it is aborted or times
 * out. The line therefore never holds more than the live waiters, and a
 * waiter that gave up is not kept reachable (with its grant hook and
 * everything that hook closes over, the caller's request included) until
 * the waiters ahead of it have been served. Joining, leaving and taking
 * the first waiter are all constant-time.
 */
class WaitingLine {
  private first: Waiter | undefined;
  private last: Waiter | undefined;

  join(waiter: Waiter): void {
    waiter.inLine = true;
    waiter.ahead = this.last;
    if (this.last === undefined) this.first = waiter;
    else this.last.behind = waiter;
    this.last = waiter;
  }

  /** Remove and return the oldest waiter, if any. */
  takeFirst(): Waiter | undefined {
    const waiter = this.first;
    if (waiter !== undefined) this.leave(waiter);
    return waiter;
  }

  /** Remove `waiter` wherever it stands. Does nothing if it is not in line. */
  leave(waiter: Waiter): void {
    if (!waiter.inLine) return;
    waiter.inLine = false;
    const { ahead, behind } = waiter;
    if (ahead === undefined) this.first = behind;
    else ahead.behind = behind;
    if (behind === undefined) this.last = ahead;
    else behind.ahead = ahead;
    waiter.ahead = undefined;
    waiter.behind = undefined;
  }
}

function validateLimits(limits: ConcurrencyLimits): void {
  if (!Number.isInteger(limits.maxConcurrent) || limits.maxConcurrent < 0) {
    throw new Error("maxConcurrent must be an integer >= 0");
  }
  if (!Number.isInteger(limits.maxQueue) || limits.maxQueue < 0) {
    throw new Error("maxQueue must be an integer >= 0");
  }
}

export function createReconfigurableBulkhead(initial: ConcurrencyLimits) {
  validateLimits(initial);

  let limits: ConcurrencyLimits = { ...initial };
  let inFlight = 0;
  let closed = false;
  let livePending = 0;
  const line = new WaitingLine();
  let drainWaiters: Array<() => void> = [];

  let totalAdmitted = 0;
  let totalReleased = 0;
  let rejected = 0;
  const rejectedByReason: Partial<Record<RejectReason, number>> = {};
  let doubleRelease = 0;
  let inFlightUnderflow = 0;

  const bumpRejectReason = (reason: RejectReason): void => {
    rejected++;
    rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + 1;
  };

  const cleanupWaiter = (waiter: Waiter): void => {
    waiter.abortListener?.();
    if (waiter.timeoutId !== undefined) clearTimeout(waiter.timeoutId);
    waiter.abortListener = undefined;
    waiter.timeoutId = undefined;
  };

  /**
   * Give a waiter its answer, once. Whatever the answer is, the waiter
   * leaves the line here, so nothing keeps it after it has settled.
   */
  const settle = (waiter: Waiter, result: AcquireResult): void => {
    if (waiter.settled) return;
    waiter.settled = true;
    line.leave(waiter);
    cleanupWaiter(waiter);
    livePending--;
    if (result.ok) totalAdmitted++;
    else bumpRejectReason(result.reason);
    waiter.resolve(result);
    // A waiter that leaves without a slot can be the last thing a drain was
    // waiting for. With `maxConcurrent` lowered to 0 the line outlives the
    // in-flight work, so no release follows that would wake the drain.
    if (!result.ok) notifyDrainWaiters();
  };

  const notifyDrainWaiters = (): void => {
    if (inFlight !== 0 || livePending !== 0 || drainWaiters.length === 0) {
      return;
    }
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const makeToken = (): Token => {
    let released = false;
    return {
      release(): void {
        if (released) {
          doubleRelease++;
          return;
        }
        released = true;
        inFlight--;
        totalReleased++;
        if (inFlight < 0) {
          inFlightUnderflow++;
          inFlight = 0;
        }
        pump();
        notifyDrainWaiters();
      },
    };
  };

  /**
   * What a grant resolves with when its hook declined the slot. The slot
   * was never left held, so releasing this token again is a double release.
   */
  const declinedToken: Token = {
    release(): void {
      doubleRelease++;
    },
  };

  /**
   * Grant one slot. `inFlight` already counts it when the hook runs, so
   * the hook sees the state the grant produces. A declined slot is counted
   * as admitted and released, as it was when the caller released it.
   */
  const grant = (onGrant: GrantHook | undefined): Token => {
    inFlight++;
    if (onGrant === undefined || onGrant()) return makeToken();
    inFlight--;
    totalReleased++;
    return declinedToken;
  };

  /** Hand free slots to the oldest waiters. Everyone in line is live. */
  const pump = (): void => {
    while (inFlight < limits.maxConcurrent) {
      const waiter = line.takeFirst();
      if (waiter === undefined) break;
      settle(waiter, { ok: true, token: grant(waiter.onGrant) });
    }
  };

  const tryAcquire = (): TryAcquireResult => {
    if (closed) {
      bumpRejectReason("shutdown");
      return { ok: false, reason: "shutdown" };
    }
    if (inFlight < limits.maxConcurrent) {
      inFlight++;
      totalAdmitted++;
      return { ok: true, token: makeToken() };
    }
    bumpRejectReason("concurrency_limit");
    return { ok: false, reason: "concurrency_limit" };
  };

  const acquire = (
    options: AcquireOptions = {},
    onGrant?: GrantHook,
  ): Promise<AcquireResult> => {
    if (closed) {
      bumpRejectReason("shutdown");
      return Promise.resolve({ ok: false, reason: "shutdown" });
    }
    if (inFlight < limits.maxConcurrent) {
      totalAdmitted++;
      return Promise.resolve({ ok: true, token: grant(onGrant) });
    }

    // A zero concurrency grant is a fail-fast kill switch. Existing queued
    // waiters remain accepted and can resume if a later revision restores
    // capacity, but new callers are not added to the queue while capacity is 0.
    if (limits.maxConcurrent === 0 || limits.maxQueue === 0) {
      bumpRejectReason("concurrency_limit");
      return Promise.resolve({ ok: false, reason: "concurrency_limit" });
    }
    if (livePending >= limits.maxQueue) {
      bumpRejectReason("queue_limit");
      return Promise.resolve({ ok: false, reason: "queue_limit" });
    }

    return new Promise<AcquireResult>((resolve) => {
      const waiter: Waiter = {
        resolve,
        onGrant,
        settled: false,
        abortListener: undefined,
        timeoutId: undefined,
        inLine: false,
        ahead: undefined,
        behind: undefined,
      };
      livePending++;

      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          settle(waiter, { ok: false, reason: "aborted" });
          return;
        }
        const onAbort = (): void => {
          settle(waiter, { ok: false, reason: "aborted" });
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        waiter.abortListener = () =>
          options.signal?.removeEventListener("abort", onAbort);
      }

      if (options.timeoutMs !== undefined) {
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
          settle(waiter, { ok: false, reason: "timeout" });
          return;
        }
        waiter.timeoutId = setTimeout(() => {
          settle(waiter, { ok: false, reason: "timeout" });
        }, options.timeoutMs);
      }

      line.join(waiter);
      if (inFlight < limits.maxConcurrent) pump();
    });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (
      let waiter = line.takeFirst();
      waiter !== undefined;
      waiter = line.takeFirst()
    ) {
      settle(waiter, { ok: false, reason: "shutdown" });
    }
    notifyDrainWaiters();
  };

  const drain = (): Promise<void> => {
    if (inFlight === 0 && livePending === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      drainWaiters.push(resolve);
    });
  };

  const stats = (): Stats => ({
    inFlight,
    pending: livePending,
    maxConcurrent: limits.maxConcurrent,
    maxQueue: limits.maxQueue,
    closed,
    totalAdmitted,
    totalReleased,
    aborted: rejectedByReason.aborted ?? 0,
    timedOut: rejectedByReason.timeout ?? 0,
    rejected,
    rejectedByReason: { ...rejectedByReason },
    doubleRelease,
    inFlightUnderflow,
    hookErrors: 0,
  });

  /**
   * Replace both concurrency limits as one synchronous snapshot.
   * Lower ceilings use shrink-by-attrition; raising concurrency pumps
   * already accepted waiters immediately.
   */
  const applyLimits = (next: ConcurrencyLimits): void => {
    validateLimits(next);
    limits = { ...next };
    pump();
    // A waiter whose hook declined its slot leaves nothing to release, so
    // a drain that was waiting only on the queue is settled here.
    notifyDrainWaiters();
  };

  return { tryAcquire, acquire, stats, applyLimits, close, drain };
}
