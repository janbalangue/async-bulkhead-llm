import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLLMBulkhead,
  LLMAdmissionStoppedError,
  type LLMAdmissionLimits,
  type LLMBulkhead,
  type LLMBulkheadOptions,
  type LLMRequest,
  type LLMRunContext,
  type LLMRunOptions,
  type TokenEstimate,
} from "../src/index.js";

/**
 * The take-back trigger: `stop.takeBackGraceMs` in a limits snapshot that
 * leaves running work above the new limits.
 */

const request: LLMRequest = {
  messages: [{ role: "user", content: "take capacity back" }],
  max_tokens: 1000,
};

/** Every call reserves 100 input + 1000 output = 1100 tokens. */
const fixedEstimator = (): TokenEstimate => ({ input: 100, maxOutput: 1000 });

function bulkhead(extra: Partial<LLMBulkheadOptions> = {}): LLMBulkhead {
  return createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 2, ...extra });
}

/** Apply the current limits with `changes` on top, at the next revision. */
function apply(b: LLMBulkhead, changes: Partial<LLMAdmissionLimits>): void {
  const { stop: _previousStop, ...current } = b.limits();
  void _previousStop;
  const result = b.applyLimits({
    ...current,
    revision: current.revision + 1,
    ...changes,
  });
  expect(result.applied).toBe(true);
}

type Signal = NonNullable<LLMRunOptions<string>["signal"]>;

type Running = {
  /** What the caller of `run()` holds. A rejection is already handled. */
  promise: Promise<string>;
  signal: Signal | undefined;
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
  let entered!: (value: { signal: Signal | undefined; ctx: LLMRunContext }) => void;
  const inside = new Promise<{ signal: Signal | undefined; ctx: LLMRunContext }>(
    (resolve) => {
      entered = resolve;
    },
  );
  const promise = b.run<string>(
    request,
    (signal, ctx) => {
      entered({ signal, ctx: ctx! });
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    },
    opts,
  );
  promise.catch(() => {});
  const { signal, ctx } = await inside;
  return { promise, signal, ctx, finish: () => finish("done") };
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

const stoppedCount = (b: LLMBulkhead): number => b.stats().llm.stopped ?? 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("take-back after a limits snapshot", () => {
  it("waits out the grace period, then stops the newest call", async () => {
    const b = bulkhead();
    const a = await start(b);
    const second = await start(b);

    apply(b, { maxConcurrent: 1, stop: { takeBackGraceMs: 50 } });
    expect(b.limits().stop).toEqual({ takeBackGraceMs: 50 });

    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome(a)).toBe("running");
    expect(await outcome(second)).toBe("running");
    expect(stoppedCount(b)).toBe(0);

    await vi.advanceTimersByTimeAsync(140);
    expect(await outcome(second)).toBe("limits");
    expect(await outcome(a)).toBe("running");
    // The policy was active when the snapshot arrived, not when these
    // calls were admitted, so their callbacks had no engine signal.
    expect(second.signal).toBeUndefined();
    expect(b.stats()).toMatchObject({
      bulkhead: { inFlight: 1 },
      llm: { inFlight: 2, stopped: 1, stoppedByCause: { limits: 1 } },
    });

    a.finish();
    second.finish();
    await expect(a.promise).resolves.toBe("done");
  });

  it("aborts the callback of a call admitted under the policy", async () => {
    const b = bulkhead();
    apply(b, { stop: { takeBackGraceMs: 50 } });
    const a = await start(b);
    const second = await start(b);

    apply(b, { maxConcurrent: 1, stop: { takeBackGraceMs: 50 } });
    await vi.advanceTimersByTimeAsync(50);

    expect(second.signal!.aborted).toBe(true);
    expect(second.signal!.reason).toBeInstanceOf(LLMAdmissionStoppedError);
    expect(a.signal!.aborted).toBe(false);
    expect(await outcome(second)).toBe("limits");
    a.finish();
    second.finish();
  });

  it("leaves alone a call that finishes inside the grace period", async () => {
    const b = bulkhead();
    const a = await start(b);
    const second = await start(b);
    apply(b, { maxConcurrent: 1, stop: { takeBackGraceMs: 50 } });

    await vi.advanceTimersByTimeAsync(10);
    second.finish();
    await vi.advanceTimersByTimeAsync(140);

    expect(await outcome(second)).toBe("done");
    expect(await outcome(a)).toBe("running");
    expect(stoppedCount(b)).toBe(0);
    a.finish();
  });

  it("is replaced by a newer snapshot that fits the running work", async () => {
    const b = bulkhead();
    const a = await start(b);
    const second = await start(b);
    apply(b, { maxConcurrent: 1, stop: { takeBackGraceMs: 50 } });

    await vi.advanceTimersByTimeAsync(10);
    apply(b, { maxConcurrent: 2, stop: { takeBackGraceMs: 50 } });
    await vi.advanceTimersByTimeAsync(500);

    expect(await outcome(a)).toBe("running");
    expect(await outcome(second)).toBe("running");
    expect(stoppedCount(b)).toBe(0);
    a.finish();
    second.finish();
  });

  it("is dropped by a newer snapshot that carries no stop policy", async () => {
    const b = bulkhead();
    const a = await start(b);
    const second = await start(b);
    apply(b, { maxConcurrent: 1, stop: { takeBackGraceMs: 50 } });

    await vi.advanceTimersByTimeAsync(10);
    // Still one call too many, but this snapshot states no policy, so the
    // policy is gone: the excess is waited out as before 3.18.
    apply(b, { maxConcurrent: 1 });
    expect(b.limits().stop).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);

    expect(await outcome(a)).toBe("running");
    expect(await outcome(second)).toBe("running");
    expect(stoppedCount(b)).toBe(0);
    a.finish();
    second.finish();
  });

  it("starts its grace period again with every newer snapshot", async () => {
    const b = bulkhead();
    const a = await start(b);
    const second = await start(b);
    apply(b, { maxConcurrent: 1, stop: { takeBackGraceMs: 50 } });

    await vi.advanceTimersByTimeAsync(30);
    apply(b, { maxConcurrent: 1, stop: { takeBackGraceMs: 50 } });
    await vi.advanceTimersByTimeAsync(30);
    expect(stoppedCount(b)).toBe(0);

    await vi.advanceTimersByTimeAsync(20);
    expect(await outcome(second)).toBe("limits");
    expect(stoppedCount(b)).toBe(1);
    a.finish();
    second.finish();
  });

  it("never stops a queue waiter, which is admitted once there is room", async () => {
    const b = bulkhead({ maxQueue: 1 });
    const a = await start(b);
    const second = await start(b);
    const waiting = start(b);
    await Promise.resolve();
    expect(b.stats().bulkhead.pending).toBe(1);

    apply(b, { maxConcurrent: 1, maxQueue: 1, stop: { takeBackGraceMs: 50 } });
    await vi.advanceTimersByTimeAsync(150);

    expect(await outcome(second)).toBe("limits");
    // One slot is in use under a limit of one: the waiter keeps waiting.
    expect(b.stats().bulkhead).toMatchObject({ inFlight: 1, pending: 1 });

    a.finish();
    const admitted = await waiting;
    expect(b.stats().bulkhead).toMatchObject({ inFlight: 1, pending: 0 });
    admitted.finish();
    await expect(admitted.promise).resolves.toBe("done");
    second.finish();
  });

  it("does nothing without takeBackGraceMs, as before 3.18", async () => {
    const b = bulkhead({
      tokenBudget: { budget: 10_000, estimator: fixedEstimator },
    });
    const a = await start(b);
    const second = await start(b);

    apply(b, { maxConcurrent: 1, stop: { overrunAllowanceTokens: 100 } });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await outcome(a)).toBe("running");
    expect(await outcome(second)).toBe("running");
    expect(stoppedCount(b)).toBe(0);
    a.finish();
    second.finish();
  });

  it("stops on a later timer tick even with a grace period of zero", async () => {
    const b = bulkhead();
    const a = await start(b);
    const second = await start(b);

    apply(b, { maxConcurrent: 1, stop: { takeBackGraceMs: 0 } });
    expect(stoppedCount(b)).toBe(0);

    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome(second)).toBe("limits");
    expect(await outcome(a)).toBe("running");
    a.finish();
    second.finish();
  });

  it("stops as many calls as the new concurrency limit requires", async () => {
    const b = bulkhead({ maxConcurrent: 4 });
    const calls = [
      await start(b),
      await start(b),
      await start(b),
      await start(b),
    ];

    apply(b, { maxConcurrent: 1, stop: { takeBackGraceMs: 5 } });
    await vi.advanceTimersByTimeAsync(5);

    expect(await Promise.all(calls.map(outcome))).toEqual([
      "running",
      "limits",
      "limits",
      "limits",
    ]);
    expect(b.stats().bulkhead.inFlight).toBe(1);
    for (const call of calls) call.finish();
  });
});

describe("take-back of token and class capacity", () => {
  it("fits the holds of running calls under a lowered token budget", async () => {
    const b = bulkhead({
      maxConcurrent: 4,
      tokenBudget: { budget: 10_000, estimator: fixedEstimator },
    });
    const calls = [await start(b), await start(b), await start(b)];

    // 3300 tokens are running; 2500 leaves room for two calls.
    apply(b, {
      tokenBudget: { budget: 2_500, highPriorityReserve: 0 },
      stop: { takeBackGraceMs: 20 },
    });
    await vi.advanceTimersByTimeAsync(20);

    expect(await Promise.all(calls.map(outcome))).toEqual([
      "running",
      "running",
      "limits",
    ]);
    // The stopped call's tokens stay charged until its callback settles.
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(3_300);
    calls[2]!.finish();
    await settle();
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(2_200);
    for (const call of calls) call.finish();
  });

  it("carries the policy through setBudget()", async () => {
    const b = bulkhead({
      maxConcurrent: 4,
      tokenBudget: { budget: 10_000, estimator: fixedEstimator },
    });
    apply(b, { stop: { takeBackGraceMs: 20 } });
    const calls = [await start(b), await start(b)];

    b.setBudget(1_500);

    expect(b.limits().stop).toEqual({ takeBackGraceMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    expect(await Promise.all(calls.map(outcome))).toEqual([
      "running",
      "limits",
    ]);
    for (const call of calls) call.finish();
  });

  it("gives a restored floor back by stopping a borrower", async () => {
    const lent = { a: {}, b: {} };
    const b = bulkhead({
      admissionClasses: { defaultClass: "b", classes: lent },
    });
    const first = await start(b, { admissionClass: "b" });
    const second = await start(b, { admissionClass: "b" });
    await expect(
      b.acquire(request, { admissionClass: "a" }),
    ).resolves.toMatchObject({ ok: false });

    // Class a gets one protected slot back. Both slots are held by b.
    apply(b, {
      admissionClasses: { a: { protectedConcurrent: 1 }, b: {} },
      stop: { takeBackGraceMs: 30 },
    });
    await vi.advanceTimersByTimeAsync(30);

    expect(await outcome(second)).toBe("limits");
    expect(await outcome(first)).toBe("running");
    expect(b.stats().admissionClasses!.classes.b!.stopped).toBe(1);
    // The floor is usable again.
    const restored = await start(b, { admissionClass: "a" });
    expect(restored.ctx.resources.borrowedConcurrency).toBe(false);
    first.finish();
    second.finish();
    restored.finish();
  });

  it("fits a class under its own lowered token ceiling", async () => {
    const b = bulkhead({
      maxConcurrent: 4,
      tokenBudget: { budget: 10_000, estimator: fixedEstimator },
      admissionClasses: { defaultClass: "a", classes: { a: {}, b: {} } },
    });
    const b1 = await start(b, { admissionClass: "b" });
    const b2 = await start(b, { admissionClass: "b" });
    const a1 = await start(b, { admissionClass: "a" });

    // Class b holds 2200 tokens under a new ceiling of 1500.
    apply(b, {
      admissionClasses: { a: {}, b: { maxInFlightTokens: 1_500 } },
      stop: { takeBackGraceMs: 10 },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(await outcome(b2)).toBe("limits");
    expect(await outcome(b1)).toBe("running");
    expect(await outcome(a1)).toBe("running");
    b1.finish();
    b2.finish();
    a1.finish();
  });

  it("gives a restored token floor back by stopping a borrower", async () => {
    const b = bulkhead({
      maxConcurrent: 4,
      tokenBudget: { budget: 4_000, estimator: fixedEstimator },
      admissionClasses: { defaultClass: "b", classes: { a: {}, b: {} } },
    });
    const calls = [
      await start(b, { admissionClass: "b" }),
      await start(b, { admissionClass: "b" }),
      await start(b, { admissionClass: "b" }),
    ];
    await expect(
      b.acquire(request, { admissionClass: "a" }),
    ).resolves.toMatchObject({ ok: false, reason: "budget_limit" });

    // Class a gets 1500 protected tokens back, which leaves 2500 to share.
    // Class b is running 3300.
    apply(b, {
      admissionClasses: { a: { protectedInFlightTokens: 1_500 }, b: {} },
      stop: { takeBackGraceMs: 10 },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(await Promise.all(calls.map(outcome))).toEqual([
      "running",
      "running",
      "limits",
    ]);
    // The stopped call still holds its tokens. Once its callback settles,
    // the floor is usable again.
    calls[2]!.finish();
    await settle();
    const restored = await start(b, { admissionClass: "a" });
    expect(restored.ctx.resources.borrowedTokens).toBe(0);
    for (const call of calls) call.finish();
    restored.finish();
  });

  it("picks among the calls of a class whose ceiling was lowered", async () => {
    const b = bulkhead({
      maxConcurrent: 4,
      admissionClasses: {
        defaultClass: "a",
        classes: { a: {}, b: {} },
      },
    });
    const b1 = await start(b, { admissionClass: "b" });
    const b2 = await start(b, { admissionClass: "b" });
    const a1 = await start(b, { admissionClass: "a" });

    apply(b, {
      admissionClasses: { a: {}, b: { maxConcurrent: 1 } },
      stop: { takeBackGraceMs: 10 },
    });
    await vi.advanceTimersByTimeAsync(10);

    // The newest call overall is in class a, but only class b is above a
    // limit.
    expect(await outcome(b2)).toBe("limits");
    expect(await outcome(b1)).toBe("running");
    expect(await outcome(a1)).toBe("running");
    b1.finish();
    b2.finish();
    a1.finish();
  });
});
