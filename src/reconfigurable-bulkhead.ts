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

type Waiter = {
  resolve: (result: AcquireResult) => void;
  cancelled: boolean;
  settled: boolean;
  abortListener: (() => void) | undefined;
  timeoutId: ReturnType<typeof setTimeout> | undefined;
};

class RingDeque<T> {
  private buffer: Array<T | undefined>;
  private head = 0;
  private size = 0;

  constructor(capacity: number) {
    this.buffer = new Array(Math.max(4, capacity | 0));
  }

  get length(): number {
    return this.size;
  }

  pushBack(item: T): void {
    if (this.size === this.buffer.length) this.grow();
    const index = (this.head + this.size) % this.buffer.length;
    this.buffer[index] = item;
    this.size++;
  }

  peekFront(): T | undefined {
    return this.size === 0 ? undefined : this.buffer[this.head];
  }

  popFront(): T | undefined {
    if (this.size === 0) return undefined;
    const item = this.buffer[this.head];
    this.buffer[this.head] = undefined;
    this.head = (this.head + 1) % this.buffer.length;
    this.size--;
    return item;
  }

  private grow(): void {
    const next = new Array<T | undefined>(this.buffer.length * 2);
    for (let index = 0; index < this.size; index++) {
      next[index] = this.buffer[(this.head + index) % this.buffer.length];
    }
    this.buffer = next;
    this.head = 0;
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
  const queue = new RingDeque<Waiter>(initial.maxQueue + 1);
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

  const settle = (waiter: Waiter, result: AcquireResult): void => {
    if (waiter.settled) return;
    waiter.settled = true;
    if (!waiter.cancelled && !result.ok) waiter.cancelled = true;
    cleanupWaiter(waiter);
    livePending--;
    if (result.ok) totalAdmitted++;
    else bumpRejectReason(result.reason);
    waiter.resolve(result);
  };

  const pruneCancelledFront = (): void => {
    while (queue.length > 0) {
      const waiter = queue.peekFront();
      if (waiter === undefined) return;
      if (waiter.cancelled || waiter.settled) {
        queue.popFront();
        continue;
      }
      return;
    }
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

  const pump = (): void => {
    pruneCancelledFront();
    while (inFlight < limits.maxConcurrent && queue.length > 0) {
      const waiter = queue.popFront();
      if (waiter === undefined) break;
      if (waiter.cancelled || waiter.settled) {
        pruneCancelledFront();
        continue;
      }
      inFlight++;
      settle(waiter, { ok: true, token: makeToken() });
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

  const acquire = (options: AcquireOptions = {}): Promise<AcquireResult> => {
    if (closed) {
      bumpRejectReason("shutdown");
      return Promise.resolve({ ok: false, reason: "shutdown" });
    }
    if (inFlight < limits.maxConcurrent) {
      inFlight++;
      totalAdmitted++;
      return Promise.resolve({ ok: true, token: makeToken() });
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
        cancelled: false,
        settled: false,
        abortListener: undefined,
        timeoutId: undefined,
      };
      livePending++;

      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          settle(waiter, { ok: false, reason: "aborted" });
          return;
        }
        const onAbort = (): void => {
          waiter.cancelled = true;
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
          waiter.cancelled = true;
          settle(waiter, { ok: false, reason: "timeout" });
        }, options.timeoutMs);
      }

      queue.pushBack(waiter);
      if (inFlight < limits.maxConcurrent) pump();
    });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    while (queue.length > 0) {
      const waiter = queue.popFront();
      if (waiter === undefined || waiter.settled || waiter.cancelled) continue;
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
  };

  return { tryAcquire, acquire, stats, applyLimits, close, drain };
}
