import { describe, expect, it } from "vitest";
import {
  createLLMBulkhead,
  LLMAdmissionStoppedError,
  type LLMAdmissionStopPolicy,
  type LLMBulkhead,
  type LLMBulkheadOptions,
  type LLMEventMap,
  type LLMRequest,
  type LLMRunContext,
  type LLMRunOptions,
  type TokenEstimate,
} from "../src/index.js";

/**
 * The overrun trigger: `stop.overrunAllowanceTokens` in a limits snapshot.
 *
 * Every call reserves 100 input + 1000 output = 1100 tokens, so reporting
 * `{ input: 100, output: 1000 + n }` puts its hold n above its reservation.
 */

const request: LLMRequest = {
  messages: [{ role: "user", content: "stop on overrun" }],
  max_tokens: 1000,
};

const fixedEstimator = (): TokenEstimate => ({ input: 100, maxOutput: 1000 });

const over = (n: number) => ({ input: 100, output: 1000 + n });

function bulkhead(
  budget: number,
  extra: Partial<LLMBulkheadOptions> = {},
): LLMBulkhead {
  return createLLMBulkhead({
    model: "gpt-4o",
    maxConcurrent: 4,
    tokenBudget: { budget, estimator: fixedEstimator },
    ...extra,
  });
}

function setStop(b: LLMBulkhead, stop: LLMAdmissionStopPolicy): void {
  const current = b.limits();
  const result = b.applyLimits({
    ...current,
    revision: current.revision + 1,
    stop,
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

function stopEvents(b: LLMBulkhead): LLMEventMap["stop"][] {
  const events: LLMEventMap["stop"][] = [];
  b.on("stop", (event) => events.push(event));
  return events;
}

async function expectStopped(
  call: Running,
  cause: LLMAdmissionStoppedError["cause"],
): Promise<LLMAdmissionStoppedError> {
  const error = await call.promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(LLMAdmissionStoppedError);
  const stopped = error as LLMAdmissionStoppedError;
  expect(stopped.cause).toBe(cause);
  expect(stopped.admissionId).toBe(call.ctx.admissionId);
  return stopped;
}

/** Let every promise reaction that is already due run. */
const settle = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

/** True while the caller's promise has neither resolved nor rejected. */
async function stillRunning(call: Running): Promise<boolean> {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  void call.promise.then(mark, mark);
  await settle();
  return !settled;
}

describe("stop on overrun: the allowance of one call", () => {
  it("lets the hold grow exactly the allowance above the reservation", async () => {
    const b = bulkhead(10_000);
    setStop(b, { overrunAllowanceTokens: 100 });
    const events = stopEvents(b);
    const call = await start(b);

    const report = call.ctx.reportUsage(over(100));

    expect(report.held).toBe(1_200);
    expect(report.stopped).toBeUndefined();
    expect(call.signal!.aborted).toBe(false);
    expect(await stillRunning(call)).toBe(true);
    expect(events).toHaveLength(0);
    expect(b.stats().llm.stopped).toBeUndefined();

    call.finish();
    await expect(call.promise).resolves.toBe("done");
  });

  it("does not stop a call for a safety margin larger than its reservation", async () => {
    const b = bulkhead(10_000);
    setStop(b, { overrunAllowanceTokens: 0 });
    const events = stopEvents(b);
    // 2 input + 100 output = 102 reserved, less than the margin below.
    const call = await start(b, {
      reservation: { input: 2, maxOutput: 100 },
    });

    const report = call.ctx.reportUsage(
      { input: 2, output: 0 },
      { remainingOutputTokens: 100, safetyMarginTokens: 256 },
    );

    // The margin keeps back the whole reservation and nothing more, so the
    // call, which used 2 tokens, is not over anything.
    expect(report.held).toBe(102);
    expect(report.stopped).toBeUndefined();
    expect(call.signal!.aborted).toBe(false);
    expect(await stillRunning(call)).toBe(true);
    expect(events).toHaveLength(0);
    expect(b.stats().tokenBudget!.totalOverrun).toBe(0);

    // Output beyond the reserved cap is still overrun, margin or not.
    const beyondCap = call.ctx.reportUsage(
      { input: 2, output: 101 },
      { remainingOutputTokens: 0, safetyMarginTokens: 256 },
    );
    expect(beyondCap).toMatchObject({ held: 103, stopped: true });
    await expectStopped(call, "overrun");
    expect(events).toHaveLength(1);

    call.finish();
    await settle();
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(0);
  });

  it("stops the call one token above the allowance", async () => {
    const b = bulkhead(10_000);
    setStop(b, { overrunAllowanceTokens: 100 });
    const events = stopEvents(b);
    const releases: LLMEventMap["release"][] = [];
    b.on("release", (event) => releases.push(event));
    const call = await start(b);
    expect(b.stats().bulkhead.inFlight).toBe(1);

    const report = call.ctx.reportUsage(over(101));

    // The report that causes the stop already says so.
    expect(report).toMatchObject({ held: 1_201, stopped: true });

    // The callback's signal is aborted with the error the caller gets.
    expect(call.signal!.aborted).toBe(true);
    const error = await expectStopped(call, "overrun");
    expect(call.signal!.reason).toBe(error);
    expect(error.code).toBe("LLM_ADMISSION_STOPPED");
    expect(error.resources).toEqual(call.ctx.resources);

    // The slot is back at once; the tokens stay charged while the
    // callback is still running.
    const before = b.stats();
    expect(before.bulkhead.inFlight).toBe(0);
    expect(before.llm.inFlight).toBe(1);
    expect(before.tokenBudget!.inFlightTokens).toBe(1_201);
    expect(before.llm.stopped).toBe(1);
    expect(before.llm.stoppedByCause).toEqual({ overrun: 1 });
    expect(releases).toHaveLength(0);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      admissionId: call.ctx.admissionId,
      cause: "overrun",
      heldTokens: 1_201,
      priority: "normal",
      resources: call.ctx.resources,
    });

    call.finish();
    await settle();

    const after = b.stats();
    expect(after.tokenBudget!.inFlightTokens).toBe(0);
    expect(after.llm.inFlight).toBe(0);
    expect(after.llm.stopped).toBe(1);
    expect(releases).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("keeps reporting stopped and keeps the hold accurate after the stop", async () => {
    const b = bulkhead(10_000);
    setStop(b, { overrunAllowanceTokens: 0 });
    const events = stopEvents(b);
    const call = await start(b);

    expect(call.ctx.reportUsage(over(1)).stopped).toBe(true);
    const later = call.ctx.reportUsage(over(500));

    expect(later).toMatchObject({ held: 1_600, stopped: true });
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(1_600);
    expect(events).toHaveLength(1);
    expect(b.stats().llm.stopped).toBe(1);
    call.finish();
  });

  it("frees the slot for the next caller while the tokens stay held", async () => {
    const b = bulkhead(10_000, { maxConcurrent: 1 });
    setStop(b, { overrunAllowanceTokens: 0 });
    const first = await start(b);
    await expect(b.acquire(request)).resolves.toMatchObject({
      ok: false,
      reason: "concurrency_limit",
    });

    first.ctx.reportUsage(over(1));

    const second = await start(b);
    expect(b.stats()).toMatchObject({
      bulkhead: { inFlight: 1 },
      llm: { inFlight: 2 },
      tokenBudget: { inFlightTokens: 1_101 + 1_100 },
    });
    first.finish();
    second.finish();
    await expect(second.promise).resolves.toBe("done");
  });
});

describe("stop on overrun: fitting the pool and class ceilings", () => {
  it("stops the newest call when a report leaves the pool above its budget", async () => {
    const b = bulkhead(2_500);
    setStop(b, { overrunAllowanceTokens: 5_000 });
    const events = stopEvents(b);
    const a = await start(b);
    const second = await start(b);

    // A is 400 above its reservation, inside its own allowance, but the
    // pool now holds 1500 + 1100 = 2600 > 2500.
    expect(a.ctx.reportUsage(over(400)).stopped).toBeUndefined();

    await expectStopped(second, "overrun");
    expect(await stillRunning(a)).toBe(true);
    expect(a.signal!.aborted).toBe(false);
    expect(events.map((event) => event.admissionId)).toEqual([
      second.ctx.admissionId,
    ]);

    // The same usage again changes nothing, so nothing else is stopped.
    a.ctx.reportUsage(over(400));
    expect(b.stats().llm.stopped).toBe(1);
    expect(await stillRunning(a)).toBe(true);

    a.finish();
    second.finish();
    await expect(a.promise).resolves.toBe("done");
  });

  it("does not count or pick a stopped call again", async () => {
    const b = bulkhead(2_500);
    setStop(b, { overrunAllowanceTokens: 5_000 });
    const a = await start(b);
    const second = await start(b);
    a.ctx.reportUsage(over(400));
    await expectStopped(second, "overrun");

    // The ledger still charges the stopped call (1600 + 1100 > 2500), but
    // the calls still running fit, so A is left alone.
    a.ctx.reportUsage(over(500));

    expect(b.stats().tokenBudget!.inFlightTokens).toBe(2_700);
    expect(b.stats().llm.stopped).toBe(1);
    expect(await stillRunning(a)).toBe(true);
    a.finish();
    second.finish();
  });

  it("stops a normal-priority call before a high-priority one", async () => {
    const b = bulkhead(2_500);
    setStop(b, { overrunAllowanceTokens: 5_000 });
    const a = await start(b);
    const high = await start(b, { priority: "high" });

    a.ctx.reportUsage(over(400));

    await expectStopped(a, "overrun");
    expect(await stillRunning(high)).toBe(true);
    a.finish();
    high.finish();
    await expect(high.promise).resolves.toBe("done");
  });

  it("stops a call on borrowed capacity before a newer protected one", async () => {
    const b = bulkhead(4_000, {
      admissionClasses: {
        defaultClass: "b",
        classes: {
          a: { protectedConcurrent: 1, protectedInFlightTokens: 1_500 },
          b: {},
        },
      },
    });
    setStop(b, { overrunAllowanceTokens: 5_000 });
    const borrowed = await start(b, { admissionClass: "b" });
    const protectedCall = await start(b, { admissionClass: "a" });
    expect(borrowed.ctx.resources.borrowedConcurrency).toBe(true);
    expect(protectedCall.ctx.resources).toEqual({
      borrowedConcurrency: false,
      borrowedTokens: 0,
    });

    // 3000 + 1100 = 4100 > 4000.
    borrowed.ctx.reportUsage(over(1_900));

    await expectStopped(borrowed, "overrun");
    expect(await stillRunning(protectedCall)).toBe(true);
    const classes = b.stats().admissionClasses!.classes;
    expect(classes.b!.stopped).toBe(1);
    expect(classes.a!.stopped).toBe(0);
    borrowed.finish();
    protectedCall.finish();
  });

  it("picks among the calls of a class that is above its own ceiling", async () => {
    const b = bulkhead(10_000, {
      admissionClasses: {
        defaultClass: "a",
        classes: { a: {}, b: { maxInFlightTokens: 2_500 } },
      },
    });
    setStop(b, { overrunAllowanceTokens: 5_000 });
    const first = await start(b, { admissionClass: "b" });
    const second = await start(b, { admissionClass: "b" });
    const other = await start(b, { admissionClass: "a" });

    // Class b holds 1500 + 1100 = 2600 > 2500. The newest call overall is
    // in class a, but only class b gives up a call.
    first.ctx.reportUsage(over(400));

    await expectStopped(second, "overrun");
    expect(await stillRunning(first)).toBe(true);
    expect(await stillRunning(other)).toBe(true);
    expect(b.stats().llm.stopped).toBe(1);
    first.finish();
    second.finish();
    other.finish();
  });

  it("only undoes its own growth when a snapshot already lowered the budget", async () => {
    const b = bulkhead(10_000);
    const a = await start(b);
    const second = await start(b);
    const third = await start(b);
    // 3300 tokens are running under a budget that is now 2000. Without a
    // take-back grace period, that is left to finish by itself.
    const current = b.limits();
    b.applyLimits({
      ...current,
      revision: current.revision + 1,
      tokenBudget: { budget: 2_000, highPriorityReserve: 0 },
      stop: { overrunAllowanceTokens: 5_000 },
    });
    expect(b.stats().llm.stopped).toBeUndefined();

    // A report that lowers a hold stops nothing.
    a.ctx.reportUsage({ input: 50, output: 0 });
    expect(b.stats().llm.stopped).toBeUndefined();

    // A report that raises one stops just enough to undo the growth: one
    // call, not every call above the lowered budget.
    second.ctx.reportUsage(over(10));

    await expectStopped(third, "overrun");
    expect(b.stats().llm.stopped).toBe(1);
    expect(await stillRunning(a)).toBe(true);
    expect(await stillRunning(second)).toBe(true);
    a.finish();
    second.finish();
    third.finish();
  });

  it("does nothing without overrunAllowanceTokens in the policy", async () => {
    const b = bulkhead(2_500);
    setStop(b, { takeBackGraceMs: 60_000 });
    const a = await start(b);
    const second = await start(b);

    a.ctx.reportUsage(over(5_000));

    expect(b.stats().llm.stopped).toBeUndefined();
    expect(b.stats().tokenBudget!.totalOverrun).toBe(5_000);
    expect(await stillRunning(a)).toBe(true);
    expect(await stillRunning(second)).toBe(true);
    a.finish();
    second.finish();
    await expect(a.promise).resolves.toBe("done");
  });
});

describe("stop on overrun: who is and is not stopped", () => {
  it("rejects a call stopped before its callback started, without running it", async () => {
    const b = bulkhead(2_500);
    setStop(b, { overrunAllowanceTokens: 5_000 });
    const a = await start(b);
    // The second call is admitted, and at that instant A's report leaves
    // the pool above its budget. The second call is the newest.
    let admissions = 0;
    b.on("admit", () => {
      admissions++;
      if (admissions === 1) a.ctx.reportUsage(over(400));
    });
    let called = false;

    const error = await b
      .run(request, async () => {
        called = true;
        return "ran";
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(LLMAdmissionStoppedError);
    expect((error as LLMAdmissionStoppedError).cause).toBe("overrun");
    expect(called).toBe(false);
    // Nothing was started, so nothing is held for it.
    expect(b.stats()).toMatchObject({
      bulkhead: { inFlight: 1 },
      llm: { inFlight: 1, stopped: 1 },
      tokenBudget: { inFlightTokens: 1_500 },
    });
    a.finish();
  });

  it("tells an acquire() token through the event and the usage report", async () => {
    const b = bulkhead(10_000);
    setStop(b, { overrunAllowanceTokens: 100 });
    const events = stopEvents(b);
    const admitted = await b.acquire(request);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const { token } = admitted;

    expect(token.reportUsage(over(100)).stopped).toBeUndefined();
    const stoppedReport = token.reportUsage(over(101));
    const next = token.reportUsage(over(101));

    expect(stoppedReport.stopped).toBe(true);
    expect(next.stopped).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      admissionId: admitted.admissionId,
      cause: "overrun",
    });
    // The slot is back, the tokens are not.
    expect(b.stats()).toMatchObject({
      bulkhead: { inFlight: 0 },
      llm: { inFlight: 1, stopped: 1 },
      tokenBudget: { inFlightTokens: 1_201 },
    });

    token.release();

    expect(b.stats()).toMatchObject({
      llm: { inFlight: 0, stopped: 1 },
      tokenBudget: { inFlightTokens: 0 },
    });
    expect(events).toHaveLength(1);
  });

  it("gives a deduplication follower its leader's error and never picks it", async () => {
    const b = bulkhead(10_000, { deduplication: true });
    setStop(b, { overrunAllowanceTokens: 100 });
    const events = stopEvents(b);
    const leader = await start(b);
    let followerCalled = false;
    const follower = b.run(request, async () => {
      followerCalled = true;
      return "follower";
    });
    follower.catch(() => {});
    await Promise.resolve();
    expect(b.stats().deduplication!.hits).toBe(1);

    leader.ctx.reportUsage(over(101));

    const leaderError = await expectStopped(leader, "overrun");
    await expect(follower).rejects.toBe(leaderError);
    expect(followerCalled).toBe(false);
    expect(b.stats().llm.stopped).toBe(1);
    expect(events).toHaveLength(1);
    leader.finish();
  });

  it("never stops a call that observe mode let through without capacity", async () => {
    const b = bulkhead(10_000, { maxConcurrent: 1 });
    setStop(b, { overrunAllowanceTokens: 100 });
    const holder = await start(b);
    const bypassed = await start(b, { mode: "observe" });
    expect(bypassed.ctx.admission).toBe("bypassed");

    const report = bypassed.ctx.reportUsage(over(8_000));

    expect(report.stopped).toBeUndefined();
    expect(await stillRunning(bypassed)).toBe(true);
    expect(b.stats().llm.stopped).toBeUndefined();
    bypassed.finish();
    await expect(bypassed.promise).resolves.toBe("done");
    holder.finish();
  });
});
