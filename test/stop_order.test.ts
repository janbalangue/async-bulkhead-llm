import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLLMBulkhead,
  LLMAdmissionStoppedError,
  type LLMBulkhead,
  type LLMBulkheadOptions,
  type LLMEventMap,
  type LLMRequest,
  type LLMRunContext,
  type LLMRunOptions,
} from "../src/index.js";

/**
 * Which calls are stopped first. The order is the same for every trigger:
 *
 *   1. calls admitted on borrowed capacity
 *   2. normal priority before high priority
 *   3. on a tie, the call admitted last
 *
 * Deduplication followers, observe-mode bypasses and queue waiters are
 * never picked.
 */

const request: LLMRequest = {
  messages: [{ role: "user", content: "who is stopped first" }],
  max_tokens: 100,
};

function bulkhead(extra: Partial<LLMBulkheadOptions> = {}): LLMBulkhead {
  return createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 6, ...extra });
}

/** Two classes; `a` has a floor of two slots, `b` only ever borrows. */
function classedBulkhead(): LLMBulkhead {
  return bulkhead({
    admissionClasses: {
      defaultClass: "b",
      classes: { a: { protectedConcurrent: 2 }, b: {} },
    },
  });
}

type Running = {
  /** What the caller of `run()` holds. A rejection is already handled. */
  promise: Promise<string>;
  ctx: LLMRunContext;
  /** Let the callback settle. */
  finish(): void;
};

/** Start a call and wait until its callback is running. */
async function start(
  b: LLMBulkhead,
  opts: LLMRunOptions<string> = {},
): Promise<Running> {
  let finish!: (value: string) => void;
  let entered!: (ctx: LLMRunContext) => void;
  const inside = new Promise<LLMRunContext>((resolve) => {
    entered = resolve;
  });
  const promise = b.run<string>(
    request,
    (_signal, ctx) => {
      entered(ctx!);
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    },
    opts,
  );
  promise.catch(() => {});
  const ctx = await inside;
  return { promise, ctx, finish: () => finish("done") };
}

/** Let every promise reaction that is already due run. */
const settle = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

/** "running", "done", or the cause the call was stopped with. */
async function outcome(call: Running): Promise<string> {
  let state = "running";
  void call.promise.then(
    () => {
      state = "done";
    },
    (err: unknown) => {
      state = err instanceof LLMAdmissionStoppedError ? err.cause : "failed";
    },
  );
  await settle();
  return state;
}

/** Names of the stopped calls, in the order their `stop` events fired. */
function stopOrder(
  b: LLMBulkhead,
  names: () => Map<string, string>,
): string[] {
  const order: string[] = [];
  b.on("stop", (event: LLMEventMap["stop"]) => {
    order.push(names().get(event.admissionId) ?? event.admissionId);
  });
  return order;
}

/**
 * Five calls that exercise every rung of the order, admitted oldest first:
 *
 *   a1  class a, protected slot, normal
 *   b1  class b, borrowed slot,  normal
 *   a2  class a, protected slot, high
 *   b2  class b, borrowed slot,  high
 *   b3  class b, borrowed slot,  normal
 */
async function startLadder(b: LLMBulkhead) {
  const calls = {
    a1: await start(b, { admissionClass: "a" }),
    b1: await start(b, { admissionClass: "b" }),
    a2: await start(b, { admissionClass: "a", priority: "high" }),
    b2: await start(b, { admissionClass: "b", priority: "high" }),
    b3: await start(b, { admissionClass: "b" }),
  };
  expect(calls.a1.ctx.resources.borrowedConcurrency).toBe(false);
  expect(calls.a2.ctx.resources.borrowedConcurrency).toBe(false);
  expect(calls.b1.ctx.resources.borrowedConcurrency).toBe(true);
  expect(calls.b2.ctx.resources.borrowedConcurrency).toBe(true);
  expect(calls.b3.ctx.resources.borrowedConcurrency).toBe(true);
  const names = new Map(
    Object.entries(calls).map(([name, call]) => [call.ctx.admissionId, name]),
  );
  const finishAll = (): void => {
    for (const call of Object.values(calls)) call.finish();
  };
  return { calls, names, finishAll };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the order in which calls are stopped", () => {
  it("is borrowed first, then normal before high, then newest first", async () => {
    const b = classedBulkhead();
    let names = new Map<string, string>();
    const order = stopOrder(b, () => names);
    const ladder = await startLadder(b);
    names = ladder.names;

    const result = await b.drain({ timeoutMs: 5, stopOnTimeout: true });

    expect(result.stopped).toBe(5);
    expect(order).toEqual(["b3", "b1", "b2", "a1", "a2"]);
    ladder.finishAll();
  });

  it("stops only as far down the order as a take-back needs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const b = classedBulkhead();
    let names = new Map<string, string>();
    const order = stopOrder(b, () => names);
    const ladder = await startLadder(b);
    names = ladder.names;
    const { calls } = ladder;

    // Five calls are running under a new limit of three.
    const current = b.limits();
    b.applyLimits({
      ...current,
      revision: current.revision + 1,
      maxConcurrent: 3,
      stop: { takeBackGraceMs: 10 },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(order).toEqual(["b3", "b1"]);
    expect(await outcome(calls.b2)).toBe("running");
    expect(await outcome(calls.a1)).toBe("running");
    expect(await outcome(calls.a2)).toBe("running");

    // Two more have to go. The remaining borrowed call is high priority
    // and still goes before a protected normal one.
    const next = b.limits();
    b.applyLimits({
      ...next,
      revision: next.revision + 1,
      maxConcurrent: 2,
      admissionClasses: { a: { protectedConcurrent: 1 }, b: {} },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual(["b3", "b1", "b2"]);

    const last = b.limits();
    b.applyLimits({
      ...last,
      revision: last.revision + 1,
      maxConcurrent: 1,
      admissionClasses: { a: { protectedConcurrent: 1 }, b: {} },
    });
    await vi.advanceTimersByTimeAsync(10);

    // Between the two protected calls, normal goes before high even
    // though the high-priority call is newer.
    expect(order).toEqual(["b3", "b1", "b2", "a1"]);
    expect(await outcome(calls.a2)).toBe("running");
    expect(b.stats().llm).toMatchObject({
      stopped: 4,
      stoppedByCause: { limits: 4 },
    });
    ladder.finishAll();
  });

  it("breaks a tie by stopping the call admitted last", async () => {
    const b = bulkhead();
    let names = new Map<string, string>();
    const order = stopOrder(b, () => names);
    const first = await start(b);
    const second = await start(b);
    const third = await start(b);
    names = new Map([
      [first.ctx.admissionId, "first"],
      [second.ctx.admissionId, "second"],
      [third.ctx.admissionId, "third"],
    ]);

    await b.drain({ timeoutMs: 5, stopOnTimeout: true });

    expect(order).toEqual(["third", "second", "first"]);
    first.finish();
    second.finish();
    third.finish();
  });

  it("does not pick a call that already gave its borrowed slot back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const b = classedBulkhead();
    let names = new Map<string, string>();
    const order = stopOrder(b, () => names);
    const ladder = await startLadder(b);
    names = ladder.names;
    // b3 is first in the order, but it holds no slot any more, so stopping
    // it would not bring the slot count down.
    expect(ladder.calls.b3.ctx.abandonBorrowedConcurrency()).toBe(true);

    const current = b.limits();
    b.applyLimits({
      ...current,
      revision: current.revision + 1,
      maxConcurrent: 3,
      stop: { takeBackGraceMs: 10 },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(order).toEqual(["b1"]);
    expect(await outcome(ladder.calls.b3)).toBe("running");
    ladder.finishAll();
  });
});

describe("what is never stopped", () => {
  it("leaves deduplication followers out of the count", async () => {
    const b = bulkhead({ deduplication: true });
    const leader = await start(b);
    const follower = b.run(request, async () => "follower");
    follower.catch(() => {});
    await settle();
    expect(b.stats().deduplication!.hits).toBe(1);

    const result = await b.drain({ timeoutMs: 5, stopOnTimeout: true });

    // One admitted call, one stop; the follower gets the leader's error.
    expect(result.stopped).toBe(1);
    expect(b.stats().llm.stopped).toBe(1);
    const leaderError = await leader.promise.catch((err: unknown) => err);
    expect(leaderError).toBeInstanceOf(LLMAdmissionStoppedError);
    await expect(follower).rejects.toBe(leaderError);
    leader.finish();
  });

  it("leaves observe-mode bypasses running", async () => {
    const b = bulkhead({ maxConcurrent: 1 });
    const admitted = await start(b);
    const bypassed = await start(b, { mode: "observe" });
    expect(bypassed.ctx.admission).toBe("bypassed");

    const result = await b.drain({ timeoutMs: 5, stopOnTimeout: true });

    expect(result.stopped).toBe(1);
    expect(await outcome(admitted)).toBe("drain_deadline");
    expect(await outcome(bypassed)).toBe("running");
    bypassed.finish();
    await expect(bypassed.promise).resolves.toBe("done");
    admitted.finish();
  });

  it("leaves queue waiters in the queue", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const b = bulkhead({ maxConcurrent: 2, maxQueue: 2 });
    const first = await start(b);
    const second = await start(b);
    const waiterOne = start(b);
    const waiterTwo = start(b);
    await settle();
    expect(b.stats().bulkhead.pending).toBe(2);

    const current = b.limits();
    b.applyLimits({
      ...current,
      revision: current.revision + 1,
      maxConcurrent: 1,
      stop: { takeBackGraceMs: 10 },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(await outcome(second)).toBe("limits");
    expect(b.stats()).toMatchObject({
      bulkhead: { inFlight: 1, pending: 2 },
      llm: { stopped: 1, rejected: 0 },
    });

    first.finish();
    const admittedOne = await waiterOne;
    admittedOne.finish();
    const admittedTwo = await waiterTwo;
    admittedTwo.finish();
    await expect(admittedTwo.promise).resolves.toBe("done");
    second.finish();
  });
});
