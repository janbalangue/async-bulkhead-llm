import { describe, expect, it } from "vitest";
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

/** The drain trigger: `drain({ timeoutMs, stopOnTimeout: true })`. */

const request: LLMRequest = {
  messages: [{ role: "user", content: "stop at the drain deadline" }],
  max_tokens: 100,
};

function bulkhead(extra: Partial<LLMBulkheadOptions> = {}): LLMBulkhead {
  return createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 2, ...extra });
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

async function stopCause(call: Running): Promise<string | undefined> {
  const error = await call.promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(LLMAdmissionStoppedError);
  expect((error as LLMAdmissionStoppedError).admissionId).toBe(
    call.ctx.admissionId,
  );
  return (error as LLMAdmissionStoppedError).cause;
}

describe("drain with stopOnTimeout", () => {
  it("stops every call still running at the deadline", async () => {
    const b = bulkhead();
    const events: LLMEventMap["stop"][] = [];
    b.on("stop", (event) => events.push(event));
    const first = await start(b);
    const second = await start(b);

    const result = await b.drain({ timeoutMs: 20, stopOnTimeout: true });

    // Both slots are back, but both callbacks are still running.
    expect(result).toEqual({
      drained: false,
      inFlight: 2,
      pending: 0,
      stopped: 2,
    });
    expect(await stopCause(first)).toBe("drain_deadline");
    expect(await stopCause(second)).toBe("drain_deadline");
    expect(b.stats()).toMatchObject({
      bulkhead: { inFlight: 0 },
      llm: {
        inFlight: 2,
        stopped: 2,
        stoppedByCause: { drain_deadline: 2 },
      },
    });
    expect(events.map((event) => event.cause)).toEqual([
      "drain_deadline",
      "drain_deadline",
    ]);

    // A drain right now is still not drained: the callbacks have not
    // settled. Stopped calls are not stopped a second time.
    expect(await b.drain({ timeoutMs: 0, stopOnTimeout: true })).toEqual({
      drained: false,
      inFlight: 2,
      pending: 0,
      stopped: 0,
    });

    first.finish();
    second.finish();

    expect(await b.drain({ timeoutMs: 20 })).toEqual({
      drained: true,
      inFlight: 0,
      pending: 0,
    });
    expect(events).toHaveLength(2);
  });

  it("aborts the callback when a stop policy was active at admission", async () => {
    const b = bulkhead();
    const current = b.limits();
    // An empty policy turns on no trigger of its own; it makes callbacks
    // abortable.
    b.applyLimits({ ...current, revision: current.revision + 1, stop: {} });
    expect(b.limits().stop).toEqual({});
    const caller = new AbortController();
    const withSignal = await start(b, { signal: caller.signal });
    const withoutSignal = await start(b);
    expect(withSignal.signal).not.toBe(caller.signal);
    expect(withoutSignal.signal).toBeDefined();

    const result = await b.drain({ timeoutMs: 20, stopOnTimeout: true });

    expect(result.stopped).toBe(2);
    for (const call of [withSignal, withoutSignal]) {
      expect(call.signal!.aborted).toBe(true);
      expect(call.signal!.reason).toBeInstanceOf(LLMAdmissionStoppedError);
      expect(await stopCause(call)).toBe("drain_deadline");
    }
    // The caller's own signal is never aborted by the engine.
    expect(caller.signal.aborted).toBe(false);
    withSignal.finish();
    withoutSignal.finish();
  });

  it("still forwards the caller's abort to a callback under a stop policy", async () => {
    const b = bulkhead();
    const current = b.limits();
    b.applyLimits({ ...current, revision: current.revision + 1, stop: {} });
    const caller = new AbortController();
    const call = await start(b, { signal: caller.signal });

    caller.abort(new Error("caller gave up"));

    expect(call.signal!.aborted).toBe(true);
    expect(call.signal!.reason).toBe(caller.signal.reason);
    expect(b.stats().llm.stopped).toBeUndefined();
    call.finish();
    await expect(call.promise).resolves.toBe("done");
  });

  it("rejects the caller but cannot abort a callback admitted without a policy", async () => {
    const b = bulkhead();
    const caller = new AbortController();
    const withSignal = await start(b, { signal: caller.signal });
    const withoutSignal = await start(b);
    // Without a policy the callback gets exactly what the caller passed.
    expect(withSignal.signal).toBe(caller.signal);
    expect(withoutSignal.signal).toBeUndefined();

    const result = await b.drain({ timeoutMs: 20, stopOnTimeout: true });

    expect(result.stopped).toBe(2);
    expect(await stopCause(withSignal)).toBe("drain_deadline");
    expect(await stopCause(withoutSignal)).toBe("drain_deadline");
    expect(caller.signal.aborted).toBe(false);
    withSignal.finish();
    withoutSignal.finish();
    expect(await b.drain({ timeoutMs: 20 })).toMatchObject({ drained: true });
  });

  it("reports zero stops when everything finished before the deadline", async () => {
    const b = bulkhead();
    const call = await start(b);
    const draining = b.drain({ timeoutMs: 1_000, stopOnTimeout: true });

    call.finish();

    expect(await draining).toEqual({
      drained: true,
      inFlight: 0,
      pending: 0,
      stopped: 0,
    });
    await expect(call.promise).resolves.toBe("done");
    expect(b.stats().llm.stopped).toBeUndefined();
  });

  it("never stops a queue waiter, which takes the freed slot", async () => {
    const b = bulkhead({ maxConcurrent: 1, maxQueue: 1 });
    const running = await start(b);
    const waiting = start(b);
    await Promise.resolve();
    expect(b.stats().bulkhead.pending).toBe(1);

    const result = await b.drain({ timeoutMs: 20, stopOnTimeout: true });

    expect(result.stopped).toBe(1);
    expect(await stopCause(running)).toBe("drain_deadline");
    // The waiter was not stopped: it was admitted on the slot that came
    // back and is running now.
    const admitted = await waiting;
    expect(b.stats()).toMatchObject({
      bulkhead: { inFlight: 1, pending: 0 },
      llm: { stopped: 1 },
    });
    admitted.finish();
    await expect(admitted.promise).resolves.toBe("done");
    running.finish();
  });

  it("stops an acquire() token, which stays in flight until released", async () => {
    const b = bulkhead();
    const events: LLMEventMap["stop"][] = [];
    b.on("stop", (event) => events.push(event));
    const admitted = await b.acquire(request);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    const result = await b.drain({ timeoutMs: 10, stopOnTimeout: true });

    expect(result).toEqual({
      drained: false,
      inFlight: 1,
      pending: 0,
      stopped: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      admissionId: admitted.admissionId,
      cause: "drain_deadline",
    });
    expect(
      admitted.token.reportUsage({ input: 1, output: 1 }).stopped,
    ).toBe(true);

    admitted.token.release();

    expect(await b.drain({ timeoutMs: 10 })).toEqual({
      drained: true,
      inFlight: 0,
      pending: 0,
    });
  });

  it("validates its options", () => {
    const b = bulkhead();
    expect(() =>
      b.drain({ stopOnTimeout: true } as unknown as { timeoutMs: number }),
    ).toThrow(/stopOnTimeout requires timeoutMs/);
    expect(() =>
      b.drain({
        timeoutMs: 1,
        stopOnTimeout: "yes" as unknown as boolean,
      }),
    ).toThrow(/stopOnTimeout must be a boolean/);
  });
});
