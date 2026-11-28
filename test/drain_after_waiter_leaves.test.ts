import { describe, expect, it } from "vitest";
import {
  createLLMBulkhead,
  type LLMAcquireOptions,
  type LLMAcquireResult,
  type LLMBulkhead,
  type LLMRequest,
  type LLMToken,
} from "../src/index.js";

/**
 * `drain()` and a waiter that leaves the queue without a slot.
 *
 * Normally a queue cannot outlive the work in flight: a free slot goes to
 * the oldest waiter at once. Lowering `maxConcurrent` to 0 is the exception.
 * Accepted waiters stay queued, the running work finishes, and from then on
 * no release will ever follow. Before 3.19.0 a `drain()` that was waiting at
 * that point was woken only by a release, a limits update or `close()`, so
 * when the last waiter timed out or was aborted, the bulkhead was idle and
 * the drain promise stayed open.
 */

const request: LLMRequest = {
  messages: [{ role: "user", content: "drain" }],
};

/** Let every promise reaction that is already due run. */
const nextTurn = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

/** Watch a promise without awaiting it. */
function track(promise: Promise<unknown>): { resolved: boolean } {
  const state = { resolved: false };
  void promise.then(() => {
    state.resolved = true;
  });
  return state;
}

function tokenOf(result: LLMAcquireResult): LLMToken {
  if (!result.ok) throw new Error(`expected an admission, got ${result.reason}`);
  return result.token;
}

/**
 * One call in flight, one waiter queued per entry of `waiterOptions`, and
 * then the limit lowered to 0. The waiters stay accepted; the caller decides
 * when the call in flight is released.
 */
async function closedWithWaiters(
  waiterOptions: LLMAcquireOptions[],
): Promise<{
  b: LLMBulkhead;
  holder: LLMToken;
  waiters: Promise<LLMAcquireResult>[];
}> {
  const b = createLLMBulkhead({
    model: "gpt-4o",
    maxConcurrent: 1,
    maxQueue: waiterOptions.length,
  });
  const holder = tokenOf(await b.acquire(request));
  const waiters = waiterOptions.map((options) => b.acquire(request, options));
  const applied = b.applyLimits({
    revision: 1,
    maxConcurrent: 0,
    maxQueue: waiterOptions.length,
  });
  expect(applied.applied).toBe(true);
  return { b, holder, waiters };
}

describe("drain() when the last queued waiter leaves without a slot", () => {
  it("resolves when that waiter times out behind a zero limit", async () => {
    const { b, holder, waiters } = await closedWithWaiters([{ timeoutMs: 5 }]);
    holder.release();
    expect(b.stats().bulkhead).toMatchObject({
      inFlight: 0,
      pending: 1,
      maxConcurrent: 0,
    });

    const drain = track(b.drain());
    await nextTurn();
    expect(drain.resolved).toBe(false);

    expect(await waiters[0]).toMatchObject({ ok: false, reason: "timeout" });
    await nextTurn();

    expect(b.stats().bulkhead).toMatchObject({ inFlight: 0, pending: 0 });
    expect(drain.resolved).toBe(true);
  });

  it("resolves when that waiter is aborted behind a zero limit", async () => {
    const leaving = new AbortController();
    const { b, holder, waiters } = await closedWithWaiters([
      { signal: leaving.signal },
    ]);
    holder.release();

    const drain = track(b.drain());
    await nextTurn();
    expect(drain.resolved).toBe(false);

    leaving.abort();
    expect(await waiters[0]).toMatchObject({ ok: false, reason: "aborted" });
    await nextTurn();

    expect(drain.resolved).toBe(true);
  });

  it("reports a bounded drain as drained, not as a deadline with nothing outstanding", async () => {
    const { b, holder, waiters } = await closedWithWaiters([{ timeoutMs: 5 }]);
    holder.release();

    // The waiter leaves long before this deadline.
    const result = b.drain({ timeoutMs: 400 });
    expect(await waiters[0]).toMatchObject({ ok: false, reason: "timeout" });

    expect(await result).toEqual({ drained: true, inFlight: 0, pending: 0 });
  });

  it("wakes every drain that was waiting", async () => {
    const leaving = new AbortController();
    const { b, holder, waiters } = await closedWithWaiters([
      { signal: leaving.signal },
    ]);
    holder.release();

    const first = track(b.drain());
    const second = track(b.drain());
    leaving.abort();
    await waiters[0];
    await nextTurn();

    expect(first.resolved).toBe(true);
    expect(second.resolved).toBe(true);
  });
});

describe("drain() keeps waiting for what is still outstanding", () => {
  it("waits for the other waiters still in line", async () => {
    const firstLeaving = new AbortController();
    const secondLeaving = new AbortController();
    const { b, holder, waiters } = await closedWithWaiters([
      { signal: firstLeaving.signal },
      { signal: secondLeaving.signal },
    ]);
    holder.release();

    const drain = track(b.drain());
    firstLeaving.abort();
    expect(await waiters[0]).toMatchObject({ ok: false, reason: "aborted" });
    await nextTurn();
    expect(b.stats().bulkhead).toMatchObject({ inFlight: 0, pending: 1 });
    expect(drain.resolved).toBe(false);

    secondLeaving.abort();
    expect(await waiters[1]).toMatchObject({ ok: false, reason: "aborted" });
    await nextTurn();
    expect(drain.resolved).toBe(true);
  });

  it("waits for work in flight after the last waiter left", async () => {
    const leaving = new AbortController();
    const { b, holder, waiters } = await closedWithWaiters([
      { signal: leaving.signal },
    ]);

    const drain = track(b.drain());
    leaving.abort();
    expect(await waiters[0]).toMatchObject({ ok: false, reason: "aborted" });
    await nextTurn();
    expect(b.stats().bulkhead).toMatchObject({ inFlight: 1, pending: 0 });
    expect(drain.resolved).toBe(false);

    holder.release();
    await nextTurn();
    expect(drain.resolved).toBe(true);
  });

  it("still hands the slot to a waiter when capacity comes back", async () => {
    const { b, holder, waiters } = await closedWithWaiters([{}]);
    holder.release();

    const drain = track(b.drain());
    b.applyLimits({ revision: 2, maxConcurrent: 1, maxQueue: 1 });
    const admitted = tokenOf(await waiters[0]!);
    await nextTurn();
    expect(drain.resolved).toBe(false);

    admitted.release();
    await nextTurn();
    expect(drain.resolved).toBe(true);
  });
});
