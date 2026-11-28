import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  createLLMBulkhead,
  type LLMAcquireResult,
  type LLMBulkhead,
  type LLMRequest,
  type LLMToken,
} from "../src/index.js";

/**
 * A waiter that leaves the queue by abort or timeout is dropped at once.
 *
 * Before 3.19.0 it stayed in the queue until every waiter ahead of it had
 * been served, which with a full bulkhead means until the next release.
 * Its grant hook stayed reachable with it, and through the hook the
 * caller's request: with long calls and short queue timeouts, prompts
 * piled up in memory for as long as the longest call ran.
 *
 * The first two tests check that directly, by collecting garbage while the
 * slot is still held. The rest check that the queue serves the waiters
 * still in line exactly as before.
 */

// Full collections on demand, without starting the whole test run with
// `--expose-gc`.
setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

const nextTurn = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

/** How many of `refs` have lost their target after a full collection. */
async function collected(refs: readonly WeakRef<object>[]): Promise<number> {
  // A target stays alive until the job that last touched its WeakRef ends,
  // so collect on later turns of the event loop.
  await nextTurn();
  collectGarbage();
  await nextTurn();
  collectGarbage();
  return refs.filter((ref) => ref.deref() === undefined).length;
}

const WAITERS = 100;
/**
 * The engine may keep the last request or two reachable from its own
 * machinery. Before the fix none of the requests could be collected.
 */
const MOST = WAITERS - 5;

const request = (text: string): LLMRequest => ({
  messages: [{ role: "user", content: text }],
});

function queued(maxQueue: number): LLMBulkhead {
  return createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 1, maxQueue });
}

function tokenOf(result: LLMAcquireResult): LLMToken {
  if (!result.ok) throw new Error(`expected an admission, got ${result.reason}`);
  return result.token;
}

/**
 * Queue one call, abort it, and hand back a weak reference to its request.
 * The request is created here so that no caller frame keeps it alive.
 */
async function abortedWaiter(
  b: LLMBulkhead,
  index: number,
): Promise<WeakRef<object>> {
  const req = request(`aborted ${index}`);
  const controller = new AbortController();
  const waiting = b.acquire(req, { signal: controller.signal });
  controller.abort();
  expect(await waiting).toMatchObject({ ok: false, reason: "aborted" });
  return new WeakRef(req);
}

/** Queue `count` calls that all time out; weak references to their requests. */
async function timedOutWaiters(
  b: LLMBulkhead,
  count: number,
): Promise<WeakRef<object>[]> {
  const refs: WeakRef<object>[] = [];
  const waiting: Promise<LLMAcquireResult>[] = [];
  for (let index = 0; index < count; index++) {
    const req = request(`timed out ${index}`);
    refs.push(new WeakRef(req));
    waiting.push(b.acquire(req, { timeoutMs: 1 }));
  }
  for (const result of await Promise.all(waiting)) {
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  }
  return refs;
}

describe("queue waiters that gave up are released at once", () => {
  it("lets the requests of aborted waiters be collected while the slot is held", async () => {
    const b = queued(4);
    const holder = tokenOf(await b.acquire(request("holder")));

    const refs: WeakRef<object>[] = [];
    for (let index = 0; index < WAITERS; index++) {
      refs.push(await abortedWaiter(b, index));
    }

    // Nothing was released in between: the one slot is still held.
    expect(b.stats().bulkhead).toMatchObject({ inFlight: 1, pending: 0 });
    expect(await collected(refs)).toBeGreaterThanOrEqual(MOST);

    holder.release();
    await b.drain();
  });

  it("lets the requests of timed-out waiters be collected while the slot is held", async () => {
    const b = queued(WAITERS);
    const holder = tokenOf(await b.acquire(request("holder")));

    const refs = await timedOutWaiters(b, WAITERS);

    expect(b.stats().bulkhead).toMatchObject({ inFlight: 1, pending: 0 });
    expect(await collected(refs)).toBeGreaterThanOrEqual(MOST);

    holder.release();
    await b.drain();
  });
});

describe("the queue after waiters have left it", () => {
  /** Queue a call and record its name when it is granted a slot. */
  function wait(
    b: LLMBulkhead,
    order: string[],
    name: string,
    signal?: AbortSignal,
  ): Promise<LLMAcquireResult> {
    return b
      .acquire(request(name), signal === undefined ? {} : { signal })
      .then((result) => {
        if (result.ok) order.push(name);
        return result;
      });
  }

  it("serves the remaining waiters in arrival order when the first, a middle and the last one left", async () => {
    const b = queued(5);
    const holder = tokenOf(await b.acquire(request("holder")));
    const order: string[] = [];
    const first = new AbortController();
    const middle = new AbortController();
    const last = new AbortController();

    const a = wait(b, order, "a", first.signal);
    const second = wait(b, order, "b");
    const c = wait(b, order, "c", middle.signal);
    const fourth = wait(b, order, "d");
    const e = wait(b, order, "e", last.signal);
    expect(b.stats().bulkhead.pending).toBe(5);

    middle.abort();
    first.abort();
    last.abort();
    for (const gone of [a, c, e]) {
      expect(await gone).toMatchObject({ ok: false, reason: "aborted" });
    }
    expect(b.stats().bulkhead).toMatchObject({ inFlight: 1, pending: 2 });

    holder.release();
    const tokenB = tokenOf(await second);
    expect(order).toEqual(["b"]);
    expect(b.stats().bulkhead).toMatchObject({ inFlight: 1, pending: 1 });

    tokenB.release();
    const tokenD = tokenOf(await fourth);
    expect(order).toEqual(["b", "d"]);

    tokenD.release();
    await b.drain();
    const stats = b.stats().bulkhead;
    expect(stats).toMatchObject({ inFlight: 0, pending: 0 });
    expect(stats.rejectedByReason).toEqual({ aborted: 3 });
  });

  it("takes a new waiter after the only one in line left", async () => {
    const b = queued(1);
    const holder = tokenOf(await b.acquire(request("holder")));
    const order: string[] = [];
    const only = new AbortController();

    const gone = wait(b, order, "gone", only.signal);
    only.abort();
    expect(await gone).toMatchObject({ ok: false, reason: "aborted" });

    const next = wait(b, order, "next");
    expect(b.stats().bulkhead.pending).toBe(1);

    holder.release();
    tokenOf(await next).release();
    expect(order).toEqual(["next"]);
    await b.drain();
  });

  it("frees exactly one queue place for each waiter that left", async () => {
    const b = queued(2);
    const holder = tokenOf(await b.acquire(request("holder")));
    const order: string[] = [];
    const leaving = new AbortController();

    const first = wait(b, order, "first", leaving.signal);
    const second = wait(b, order, "second");
    expect(await b.acquire(request("too many"))).toMatchObject({
      ok: false,
      reason: "queue_limit",
    });

    leaving.abort();
    expect(await first).toMatchObject({ ok: false, reason: "aborted" });

    const third = wait(b, order, "third");
    expect(b.stats().bulkhead.pending).toBe(2);
    expect(await b.acquire(request("too many again"))).toMatchObject({
      ok: false,
      reason: "queue_limit",
    });

    holder.release();
    tokenOf(await second).release();
    tokenOf(await third).release();
    expect(order).toEqual(["second", "third"]);
    await b.drain();
  });

  it("rejects only the waiters still in line when the bulkhead closes", async () => {
    const b = queued(3);
    const holder = tokenOf(await b.acquire(request("holder")));
    const order: string[] = [];
    const leaving = new AbortController();

    const staying = wait(b, order, "staying");
    const gone = wait(b, order, "gone", leaving.signal);
    const alsoStaying = wait(b, order, "also staying");
    leaving.abort();
    expect(await gone).toMatchObject({ ok: false, reason: "aborted" });

    b.close();
    expect(await staying).toMatchObject({ ok: false, reason: "shutdown" });
    expect(await alsoStaying).toMatchObject({ ok: false, reason: "shutdown" });
    expect(order).toEqual([]);
    expect(b.stats().bulkhead.rejectedByReason).toEqual({
      aborted: 1,
      shutdown: 2,
    });

    holder.release();
    await b.drain();
    expect(b.stats().bulkhead).toMatchObject({ inFlight: 0, pending: 0 });
  });
});
