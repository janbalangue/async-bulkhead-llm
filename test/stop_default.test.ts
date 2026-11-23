import { describe, expect, it } from "vitest";
import {
  createLLMBulkhead,
  LLMAdmissionStoppedError,
  type LLMAdmissionLimits,
  type LLMBulkhead,
  type LLMBulkheadOptions,
  type LLMEventMap,
  type LLMRequest,
  type LLMRunContext,
  type LLMRunOptions,
  type TokenEstimate,
} from "../src/index.js";

/**
 * Stopping is opt-in. Without a stop policy nothing is ever stopped and
 * every result keeps the shape it had before 3.18. This file also covers
 * how the policy is stated, validated and cleared.
 */

const request: LLMRequest = {
  messages: [{ role: "user", content: "never stop by default" }],
  max_tokens: 1000,
};

/** Every call reserves 100 input + 1000 output = 1100 tokens. */
const fixedEstimator = (): TokenEstimate => ({ input: 100, maxOutput: 1000 });

function bulkhead(extra: Partial<LLMBulkheadOptions> = {}): LLMBulkhead {
  return createLLMBulkhead({
    model: "gpt-4o",
    maxConcurrent: 2,
    tokenBudget: { budget: 10_000, estimator: fixedEstimator },
    ...extra,
  });
}

function next(
  b: LLMBulkhead,
  changes: Record<string, unknown> = {},
): LLMAdmissionLimits {
  const current = b.limits();
  return {
    ...current,
    revision: current.revision + 1,
    ...changes,
  } as LLMAdmissionLimits;
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

const wait = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function stopEvents(b: LLMBulkhead): LLMEventMap["stop"][] {
  const events: LLMEventMap["stop"][] = [];
  b.on("stop", (event) => events.push(event));
  return events;
}

describe("without a stop policy nothing is stopped", () => {
  it("only widens the hold of a call that overruns its reservation", async () => {
    const b = bulkhead();
    const events = stopEvents(b);
    const call = await start(b);

    const report = call.ctx.reportUsage({ input: 100, output: 6_000 });

    expect(report).toEqual({
      admissionId: call.ctx.admissionId,
      limitRevision: 0,
      sequence: 1,
      reserved: 1_100,
      held: 6_100,
      consumed: 6_100,
      outputCap: 1_000,
      outputRemaining: 0,
      overReservation: true,
    });
    call.finish();
    await expect(call.promise).resolves.toBe("done");
    expect(b.stats().tokenBudget!.totalOverrun).toBe(5_000);
    expect(events).toHaveLength(0);
  });

  it("does not stop anything when a report leaves the pool above its budget", async () => {
    const b = bulkhead({
      tokenBudget: { budget: 2_500, estimator: fixedEstimator },
    });
    const first = await start(b);
    const second = await start(b);

    first.ctx.reportUsage({ input: 100, output: 9_000 });

    expect(b.stats().tokenBudget!.inFlightTokens).toBe(10_200);
    first.finish();
    second.finish();
    await expect(first.promise).resolves.toBe("done");
    await expect(second.promise).resolves.toBe("done");
  });

  it("reports a drain deadline without stopping the work", async () => {
    const b = bulkhead();
    const events = stopEvents(b);
    const call = await start(b);

    const result = await b.drain({ timeoutMs: 20 });

    expect(result).toEqual({ drained: false, inFlight: 1, pending: 0 });
    expect(events).toHaveLength(0);
    call.finish();
    await expect(call.promise).resolves.toBe("done");
  });

  it("waits out running work when a snapshot lowers a limit", async () => {
    const b = bulkhead();
    const events = stopEvents(b);
    const first = await start(b);
    const second = await start(b);

    expect(b.applyLimits(next(b, { maxConcurrent: 1 })).applied).toBe(true);
    await wait(60);

    expect(events).toHaveLength(0);
    expect(b.stats().bulkhead.inFlight).toBe(2);
    first.finish();
    second.finish();
    await expect(first.promise).resolves.toBe("done");
    await expect(second.promise).resolves.toBe("done");
  });

  it("keeps the stats and limits shapes free of stop fields", async () => {
    const b = bulkhead({
      admissionClasses: { defaultClass: "a", classes: { a: {} } },
    });
    const call = await start(b);
    call.finish();
    await call.promise;

    const stats = b.stats();
    expect(stats.llm).toEqual({
      inFlight: 0,
      admitted: 1,
      released: 1,
      borrowedConcurrencyAbandoned: 0,
      borrowedConcurrencyAbandonedByCause: {},
      rejected: 0,
      rejectedByReason: {},
    });
    expect("stopped" in stats.admissionClasses!.classes.a!).toBe(false);
    expect("stop" in b.limits()).toBe(false);
    expect("stop" in stats.limits).toBe(false);
  });

  it("hands the callback exactly the signal the caller passed", async () => {
    const b = bulkhead();
    const caller = new AbortController();

    const withSignal = await start(b, { signal: caller.signal });
    const withoutSignal = await start(b);

    expect(withSignal.signal).toBe(caller.signal);
    expect(withoutSignal.signal).toBeUndefined();
    withSignal.finish();
    withoutSignal.finish();
  });
});

describe("stating and clearing the stop policy", () => {
  it("returns the policy from limits(), stats() and the reconfigure event", () => {
    const b = bulkhead();
    const reconfigured: LLMEventMap["reconfigure"][] = [];
    b.on("reconfigure", (event) => reconfigured.push(event));
    const stop = { overrunAllowanceTokens: 100, takeBackGraceMs: 250 };

    const result = b.applyLimits(next(b, { stop }));

    expect(result).toMatchObject({ applied: true, current: { stop } });
    expect(b.limits().stop).toEqual(stop);
    expect(Object.isFrozen(b.limits().stop)).toBe(true);
    expect(b.stats().limits.stop).toEqual(stop);
    expect(reconfigured).toHaveLength(1);
    expect("stop" in reconfigured[0]!.previous).toBe(false);
    expect(reconfigured[0]!.current.stop).toEqual(stop);
  });

  it("copies the policy, so later changes to the caller's object do nothing", () => {
    const b = bulkhead();
    const stop = { overrunAllowanceTokens: 100 };

    b.applyLimits(next(b, { stop }));
    stop.overrunAllowanceTokens = 0;

    expect(b.limits().stop).toEqual({ overrunAllowanceTokens: 100 });
  });

  it("clears the policy with a snapshot that does not state one", async () => {
    const b = bulkhead();
    const events = stopEvents(b);
    b.applyLimits(next(b, { stop: { overrunAllowanceTokens: 0 } }));
    const { stop: _dropped, ...withoutStop } = next(b);
    void _dropped;

    const result = b.applyLimits(withoutStop);

    expect(result.applied).toBe(true);
    expect("stop" in b.limits()).toBe(false);
    const call = await start(b);
    // No policy at admission, so the callback has no engine signal.
    expect(call.signal).toBeUndefined();
    expect(
      call.ctx.reportUsage({ input: 100, output: 6_000 }).stopped,
    ).toBeUndefined();
    call.finish();
    await expect(call.promise).resolves.toBe("done");
    expect(events).toHaveLength(0);
  });

  it("ignores a stale snapshot's policy", () => {
    const b = bulkhead();
    b.applyLimits(next(b, { stop: { takeBackGraceMs: 10 } }));

    const stale = b.applyLimits({
      ...b.limits(),
      stop: { takeBackGraceMs: 99 },
    });

    expect(stale).toMatchObject({ applied: false, reason: "stale_revision" });
    expect(b.limits().stop).toEqual({ takeBackGraceMs: 10 });
  });

  it("rejects an invalid policy without changing anything", () => {
    const b = bulkhead();
    const before = b.limits();
    const invalid: Array<[unknown, RegExp]> = [
      [null, /limits\.stop must be an object/],
      ["soon", /limits\.stop must be an object/],
      [[], /limits\.stop must be an object/],
      [
        { overrunAllowanceTokens: -1 },
        /limits\.stop\.overrunAllowanceTokens must be an integer >= 0/,
      ],
      [
        { overrunAllowanceTokens: 1.5 },
        /limits\.stop\.overrunAllowanceTokens must be an integer >= 0/,
      ],
      [
        { takeBackGraceMs: -1 },
        /limits\.stop\.takeBackGraceMs must be an integer >= 0/,
      ],
      [
        { takeBackGraceMs: 2_147_483_648 },
        /limits\.stop\.takeBackGraceMs must be <= 2147483647/,
      ],
    ];

    for (const [stop, message] of invalid) {
      expect(() => b.applyLimits(next(b, { stop }))).toThrow(message);
    }
    expect(b.limits()).toEqual(before);
  });

  it("requires a token budget for the overrun allowance", () => {
    const b = createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 2 });

    expect(() =>
      b.applyLimits(next(b, { stop: { overrunAllowanceTokens: 10 } })),
    ).toThrow(/overrunAllowanceTokens requires tokenBudget to be configured/);
    expect(b.applyLimits(next(b, { stop: { takeBackGraceMs: 10 } }))).toMatchObject(
      { applied: true },
    );
  });

  it("exposes the error with its cause, admission id and code", () => {
    const resources = { borrowedConcurrency: true, borrowedTokens: 7 };
    const error = new LLMAdmissionStoppedError(
      "limits",
      "admission-1",
      resources,
      "batch",
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("LLMAdmissionStoppedError");
    expect(error.code).toBe("LLM_ADMISSION_STOPPED");
    expect(error.cause).toBe("limits");
    expect(error.admissionId).toBe("admission-1");
    expect(error.admissionClass).toBe("batch");
    expect(error.resources).toBe(resources);
    expect(error.message).toBe("LLM admission stopped: limits");
  });
});
