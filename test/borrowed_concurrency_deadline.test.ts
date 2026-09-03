import { describe, expect, it } from "vitest";
import {
  createLLMBulkhead,
  LLMBorrowedConcurrencyDeadlineError,
  type LLMEventMap,
  type LLMRequest,
  type TokenEstimate,
} from "../src/index.js";

const request: LLMRequest = {
  messages: [{ role: "user", content: "resource-specific restoration" }],
  max_tokens: 300,
};

const fixedEstimator = (): TokenEstimate => ({ input: 100, maxOutput: 300 });

function resourceAwareBulkhead() {
  return createLLMBulkhead({
    model: "gpt-4o",
    maxConcurrent: 2,
    tokenBudget: { budget: 1_000, estimator: fixedEstimator },
    admissionClasses: {
      defaultClass: "background",
      classes: {
        interactive: {
          protectedConcurrent: 1,
          protectedInFlightTokens: 600,
          maxConcurrent: 2,
          maxInFlightTokens: 1_000,
        },
        background: {
          maxConcurrent: 2,
          maxInFlightTokens: 1_000,
        },
      },
    },
  });
}

describe("borrowed concurrency restoration", () => {
  it("returns only the borrowed local slot while retaining the token hold", async () => {
    const bulkhead = resourceAwareBulkhead();
    const events: LLMEventMap["borrowedConcurrencyAbandon"][] = [];
    bulkhead.on("borrowedConcurrencyAbandon", (event) => events.push(event));

    const background = await bulkhead.acquire(request, {
      admissionClass: "background",
    });
    expect(background.ok).toBe(true);
    if (!background.ok) return;

    expect(background.resources).toEqual({
      borrowedConcurrency: true,
      borrowedTokens: 400,
    });
    expect(background.token.resources).toBe(background.resources);
    expect(background.token.abandonBorrowedConcurrency()).toBe(true);
    expect(background.token.abandonBorrowedConcurrency()).toBe(false);

    expect(bulkhead.stats()).toMatchObject({
      bulkhead: { inFlight: 0 },
      llm: { inFlight: 1, borrowedConcurrencyAbandoned: 1 },
      tokenBudget: { inFlightTokens: 400 },
      admissionClasses: {
        shared: {
          inFlight: 0,
          tokenBudget: { inFlightTokens: 400, available: 0 },
        },
        classes: {
          background: {
            inFlight: 0,
            inFlightTokens: 400,
            borrowedConcurrencyAbandoned: 1,
          },
        },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      admissionId: background.admissionId,
      admissionClass: "background",
      cause: "manual",
      heldTokens: 400,
      resources: { borrowedConcurrency: true, borrowedTokens: 400 },
    });
    expect(bulkhead.stats().llm.borrowedConcurrencyAbandonedByCause).toEqual({
      manual: 1,
    });

    let unboundedDrained = false;
    const unboundedDrain = bulkhead.drain().then(() => {
      unboundedDrained = true;
    });
    await Promise.resolve();
    expect(unboundedDrained).toBe(false);

    await expect(
      bulkhead.acquire(request, { admissionClass: "background" }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "budget_limit",
      detail: { constraint: "admission_class_protection" },
    });

    const interactive = await bulkhead.acquire(request, {
      admissionClass: "interactive",
    });
    expect(interactive).toMatchObject({
      ok: true,
      resources: { borrowedConcurrency: false, borrowedTokens: 0 },
    });
    if (interactive.ok) interactive.token.release();

    await expect(bulkhead.drain({ timeoutMs: 0 })).resolves.toMatchObject({
      drained: false,
      inFlight: 1,
    });
    background.token.release({ input: 100, output: 25 });
    await unboundedDrain;
    expect(unboundedDrained).toBe(true);
    await expect(bulkhead.drain({ timeoutMs: 100 })).resolves.toEqual({
      drained: true,
      inFlight: 0,
      pending: 0,
    });
    expect(bulkhead.stats()).toMatchObject({
      llm: { inFlight: 0, admitted: 2, released: 2 },
      tokenBudget: { inFlightTokens: 0 },
    });
  });

  it("expires borrowed run callers while settling capacity only when work settles", async () => {
    const bulkhead = resourceAwareBulkhead();
    let finish!: (value: string) => void;
    let callbackSignal: AbortSignal | undefined;
    let callbackResources: { borrowedConcurrency: boolean; borrowedTokens: number } | undefined;

    const run = bulkhead.run(
      request,
      async (signal, context) => {
        callbackSignal = signal;
        callbackResources = context?.resources;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
      {
        admissionClass: "background",
        borrowedConcurrencyDeadlineMs: 10,
      },
    );

    let caught: unknown;
    try {
      await run;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LLMBorrowedConcurrencyDeadlineError);
    expect(caught).toMatchObject({
      code: "LLM_BORROWED_CONCURRENCY_DEADLINE",
      deadlineMs: 10,
      admissionClass: "background",
      resources: { borrowedConcurrency: true, borrowedTokens: 400 },
    });
    expect(callbackResources).toEqual({
      borrowedConcurrency: true,
      borrowedTokens: 400,
    });
    expect(callbackSignal?.aborted).toBe(true);
    expect(bulkhead.stats()).toMatchObject({
      bulkhead: { inFlight: 0 },
      llm: {
        inFlight: 1,
        released: 0,
        borrowedConcurrencyAbandoned: 1,
        borrowedConcurrencyAbandonedByCause: { deadline: 1 },
      },
      tokenBudget: { inFlightTokens: 400 },
    });

    finish("provider-settled");
    await expect(bulkhead.drain({ timeoutMs: 100 })).resolves.toEqual({
      drained: true,
      inFlight: 0,
      pending: 0,
    });
    expect(bulkhead.stats()).toMatchObject({
      llm: { inFlight: 0, released: 1 },
      tokenBudget: { inFlightTokens: 0 },
    });
  });

  it("does not apply a borrowed deadline to protected or bypassed work", async () => {
    const bulkhead = resourceAwareBulkhead();

    await expect(
      bulkhead.run(
        request,
        async (_signal, context) => {
          expect(context?.resources).toEqual({
            borrowedConcurrency: false,
            borrowedTokens: 0,
          });
          await new Promise((resolve) => setTimeout(resolve, 15));
          return "protected";
        },
        {
          admissionClass: "interactive",
          borrowedConcurrencyDeadlineMs: 5,
        },
      ),
    ).resolves.toBe("protected");

    const held = await bulkhead.acquire(request, {
      admissionClass: "background",
    });
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    await expect(
      bulkhead.run(
        request,
        async (_signal, context) => {
          expect(context?.admission).toBe("bypassed");
          expect(context?.resources).toEqual({
            borrowedConcurrency: false,
            borrowedTokens: 0,
          });
          return "bypassed";
        },
        {
          admissionClass: "background",
          mode: "observe",
          borrowedConcurrencyDeadlineMs: 1,
        },
      ),
    ).resolves.toBe("bypassed");
    held.token.release();
  });

  it("abandons a borrowed slot from inside the run callback", async () => {
    const bulkhead = resourceAwareBulkhead();
    const events: LLMEventMap["borrowedConcurrencyAbandon"][] = [];
    bulkhead.on("borrowedConcurrencyAbandon", (event) => events.push(event));

    await expect(
      bulkhead.run(
        request,
        async (_signal, context) => {
          expect(context?.abandonBorrowedConcurrency()).toBe(true);
          expect(context?.abandonBorrowedConcurrency()).toBe(false);
          // The local slot is free while the callback still owns the tokens.
          expect(bulkhead.stats()).toMatchObject({
            bulkhead: { inFlight: 0 },
            llm: { inFlight: 1, borrowedConcurrencyAbandoned: 1 },
            tokenBudget: { inFlightTokens: 400 },
          });
          return "shed-early";
        },
        { admissionClass: "background" },
      ),
    ).resolves.toBe("shed-early");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ cause: "manual", heldTokens: 400 });
    expect(bulkhead.stats().llm).toMatchObject({
      inFlight: 0,
      released: 1,
      borrowedConcurrencyAbandonedByCause: { manual: 1 },
    });
  });

  it("forwards caller cancellation into the wrapped callback signal", async () => {
    const bulkhead = resourceAwareBulkhead();
    const controller = new AbortController();
    const cancellation = new Error("caller-cancelled");
    let sawCallerSignal: boolean | undefined;
    let observedReason: unknown;

    const run = bulkhead.run(
      request,
      async (signal) => {
        // The deadline wraps the caller signal, so the callback must not
        // receive the caller's own object while still seeing its abort.
        sawCallerSignal = signal === controller.signal;
        await new Promise<void>((resolve) => {
          (signal as AbortSignal).addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        observedReason = (signal as AbortSignal).reason;
        throw (signal as AbortSignal).reason;
      },
      {
        admissionClass: "background",
        borrowedConcurrencyDeadlineMs: 5_000,
        signal: controller.signal,
      },
    );

    setTimeout(() => controller.abort(cancellation), 5);
    await expect(run).rejects.toBe(cancellation);
    expect(sawCallerSignal).toBe(false);
    expect(observedReason).toBe(cancellation);

    // Caller cancellation is not a borrowed-slot abandonment: the callback
    // settled, so the slot and the token return together.
    expect(bulkhead.stats().llm).toMatchObject({
      inFlight: 0,
      released: 1,
      borrowedConcurrencyAbandoned: 0,
      borrowedConcurrencyAbandonedByCause: {},
    });
    await expect(bulkhead.drain({ timeoutMs: 100 })).resolves.toEqual({
      drained: true,
      inFlight: 0,
      pending: 0,
    });
  });

  it("forwards a caller signal already aborted before the callback ran", async () => {
    const bulkhead = resourceAwareBulkhead();
    const controller = new AbortController();
    const cancellation = new Error("pre-aborted");
    controller.abort(cancellation);
    let observed: { aborted: boolean; reason: unknown } | undefined;

    await expect(
      bulkhead.run(
        request,
        async (signal) => {
          observed = {
            aborted: (signal as AbortSignal).aborted,
            reason: (signal as AbortSignal).reason,
          };
          return "ran";
        },
        {
          admissionClass: "background",
          borrowedConcurrencyDeadlineMs: 5_000,
          signal: controller.signal,
        },
      ),
    ).resolves.toBe("ran");

    // Wrapping must not swallow an abort that happened before admission.
    expect(observed).toEqual({ aborted: true, reason: cancellation });
    expect(bulkhead.stats().llm).toMatchObject({
      inFlight: 0,
      released: 1,
      borrowedConcurrencyAbandoned: 0,
    });
  });

  it("cannot abandon concurrency that was never borrowed", async () => {
    const bulkhead = resourceAwareBulkhead();
    const protectedAdmission = await bulkhead.acquire(request, {
      admissionClass: "interactive",
    });
    expect(protectedAdmission.ok).toBe(true);
    if (!protectedAdmission.ok) return;

    expect(protectedAdmission.resources).toEqual({
      borrowedConcurrency: false,
      borrowedTokens: 0,
    });
    expect(protectedAdmission.token.abandonBorrowedConcurrency()).toBe(false);
    expect(bulkhead.stats()).toMatchObject({
      bulkhead: { inFlight: 1 },
      llm: {
        inFlight: 1,
        borrowedConcurrencyAbandoned: 0,
        borrowedConcurrencyAbandonedByCause: {},
      },
    });

    protectedAdmission.token.release();
    // A post-release call stays ineffective rather than double-releasing.
    expect(protectedAdmission.token.abandonBorrowedConcurrency()).toBe(false);
    expect(bulkhead.stats()).toMatchObject({
      bulkhead: { inFlight: 0 },
      llm: { inFlight: 0, released: 1, borrowedConcurrencyAbandoned: 0 },
    });
  });

  it("rejects deadline values Node timers cannot enforce faithfully", async () => {
    const bulkhead = resourceAwareBulkhead();
    for (const deadline of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      await expect(
        bulkhead.run(request, async () => "no", {
          admissionClass: "background",
          borrowedConcurrencyDeadlineMs: deadline,
        }),
      ).rejects.toThrow(/borrowedConcurrencyDeadlineMs/);
    }
    expect(bulkhead.stats().llm.admitted).toBe(0);
  });
});
