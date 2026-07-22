import { describe, expect, it, vi } from "vitest";
import {
  LLMBulkheadRejectedError,
  createLLMBulkhead,
  type LLMEventMap,
  type LLMRequest,
} from "../src/index.js";

const request: LLMRequest = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 5,
};

function budgeted(budget: number) {
  return createLLMBulkhead({
    model: "gpt-4o",
    maxConcurrent: 1,
    tokenBudget: {
      budget,
      estimator: () => ({ input: 5, maxOutput: 5 }),
    },
  });
}

describe("observe mode", () => {
  it("bypasses a budget rejection and records usage without holding capacity", async () => {
    const b = budgeted(0);
    const bypassEvents: LLMEventMap["bypass"][] = [];
    const usageEvents: LLMEventMap["bypassUsage"][] = [];
    const releaseEvents: LLMEventMap["bypassRelease"][] = [];
    b.on("bypass", (event) => bypassEvents.push(event));
    b.on("bypassUsage", (event) => usageEvents.push(event));
    b.on("bypassRelease", (event) => releaseEvents.push(event));

    const value = await b.run(
      request,
      async (_signal, context) => {
        expect(context).toMatchObject({
          admission: "bypassed",
          bypassReason: "budget_limit",
          reservation: { input: 5, maxOutput: 5, reserved: 10 },
        });
        expect(context?.admissionId).toMatch(/^shadow-/);
        expect(context?.bypassDetail?.tokenBudget).toMatchObject({
          budget: 0,
          requested: 10,
        });
        expect(context?.reportUsage({ input: 3, output: 2 })).toMatchObject({
          sequence: 1,
          held: 0,
          consumed: 5,
          outputRemaining: 3,
        });
        return "proxied";
      },
      { mode: "observe" },
    );

    expect(value).toBe("proxied");
    expect(b.stats()).toMatchObject({
      bulkhead: { inFlight: 0, pending: 0 },
      llm: { admitted: 0, released: 0, rejected: 0 },
      tokenBudget: { inFlightTokens: 0, totalReserved: 0 },
      observe: {
        bypassed: 1,
        raceBypassed: 0,
        bypassedByReason: { budget_limit: 1 },
        usageReported: 1,
        totalInputTokens: 3,
        totalOutputTokens: 2,
      },
    });
    expect(bypassEvents).toHaveLength(1);
    expect(bypassEvents[0]).toMatchObject({
      reason: "budget_limit",
      raced: false,
    });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      sequence: 1,
      usage: { input: 3, output: 2 },
    });
    expect(releaseEvents).toHaveLength(1);
    expect(releaseEvents[0]).toMatchObject({
      usageSequence: 1,
      usage: { input: 3, output: 2 },
    });
  });

  it("marks normally admitted observe-mode callbacks as admitted", async () => {
    const b = budgeted(100);

    const admission = await b.run(
      request,
      async (_signal, context) => ({
        admission: context?.admission,
        bypassReason: context?.bypassReason,
      }),
      { mode: "observe" },
    );

    expect(admission).toEqual({
      admission: "admitted",
      bypassReason: undefined,
    });
    expect(b.stats().observe).toBeUndefined();
    expect(b.stats().llm).toMatchObject({ admitted: 1, released: 1 });
  });

  it("does not bypass shutdown", async () => {
    const b = budgeted(0);
    const callback = vi.fn(async () => "must not run");
    b.close();

    await expect(
      b.run(request, callback, { mode: "observe" }),
    ).rejects.toMatchObject({ reason: "shutdown" });

    expect(callback).not.toHaveBeenCalled();
    expect(b.stats().observe).toBeUndefined();
  });

  it("does not bypass an already-aborted signal even when budget is exhausted", async () => {
    const b = budgeted(0);
    const callback = vi.fn(async () => "must not run");
    const controller = new AbortController();
    controller.abort();

    await expect(
      b.run(request, callback, {
        mode: "observe",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: "aborted" });

    expect(callback).not.toHaveBeenCalled();
    expect(b.stats().observe).toBeUndefined();
    expect(b.stats().llm.rejectedByReason.aborted).toBe(1);
  });

  it("honors a restricted shadowReasons list", async () => {
    const b = budgeted(0);
    const callback = vi.fn(async () => "must not run");

    await expect(
      b.run(request, callback, {
        mode: "observe",
        shadowReasons: ["concurrency_limit"],
      }),
    ).rejects.toBeInstanceOf(LLMBulkheadRejectedError);

    expect(callback).not.toHaveBeenCalled();
    expect(b.stats().observe).toBeUndefined();
    expect(b.stats().llm.rejectedByReason.budget_limit).toBe(1);
  });

  it("bypasses a queue-timeout race after an advisory positive decision", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 1,
      maxQueue: 1,
    });
    const held = await b.acquire(request);
    expect(held.ok).toBe(true);
    if (!held.ok) throw new Error("expected initial admission");

    const value = await b.run(
      request,
      async (_signal, context) => {
        expect(context).toMatchObject({
          admission: "bypassed",
          bypassReason: "timeout",
        });
        return "after-timeout";
      },
      { mode: "observe", timeoutMs: 5 },
    );

    expect(value).toBe("after-timeout");
    expect(b.stats().observe).toMatchObject({
      bypassed: 1,
      raceBypassed: 1,
      bypassedByReason: { timeout: 1 },
    });
    expect(b.stats().llm.rejectedByReason.timeout).toBe(1);
    held.token.release();
  });

  it("retains reported usage when bypassed work throws", async () => {
    const b = budgeted(0);
    const releaseEvents: LLMEventMap["bypassRelease"][] = [];
    b.on("bypassRelease", (event) => releaseEvents.push(event));

    await expect(
      b.run(
        request,
        async (_signal, context) => {
          context?.reportUsage({ input: 7, output: 4 });
          throw new Error("upstream failed");
        },
        { mode: "observe" },
      ),
    ).rejects.toThrow("upstream failed");

    expect(b.stats().observe).toMatchObject({
      usageReported: 1,
      totalInputTokens: 7,
      totalOutputTokens: 4,
    });
    expect(releaseEvents[0]).toMatchObject({
      usage: { input: 7, output: 4 },
    });
  });

  it("rejects invalid observe-mode options at runtime", async () => {
    const b = budgeted(100);

    await expect(
      b.run(request, async () => "x", {
        mode: "invalid",
      } as unknown as { mode: "observe" }),
    ).rejects.toThrow(/mode must be/);

    await expect(
      b.run(request, async () => "x", {
        mode: "observe",
        shadowReasons: ["shutdown"],
      } as unknown as { mode: "observe"; shadowReasons: ["timeout"] }),
    ).rejects.toThrow(/shadowReasons may contain only/);
  });
});
