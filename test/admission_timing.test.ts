import { describe, expect, it } from "vitest";
import {
  createLLMBulkhead,
  type LLMEventMap,
  type LLMRequest,
  type TokenEstimate,
} from "../src/index.js";

const request: LLMRequest = {
  messages: [{ role: "user", content: "instrument admission" }],
  max_tokens: 50,
};

const fixedEstimator = (): TokenEstimate => ({
  input: 50,
  maxOutput: 50,
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("admission-decision timing", () => {
  it("records an exact zero queue wait on a precheck rejection", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 1,
      tokenBudget: {
        budget: 10,
        estimator: fixedEstimator,
      },
    });
    const rejects: LLMEventMap["reject"][] = [];
    b.on("reject", (event) => rejects.push(event));

    const result = await b.acquire(request);

    expect(result).toMatchObject({ ok: false, reason: "budget_limit" });
    expect(rejects).toHaveLength(1);
    expect(rejects[0]!.queueWaitNs).toBe(0);
    expect(rejects[0]!.decisionDurationNs).toEqual(expect.any(Number));
    expect(Number.isInteger(rejects[0]!.decisionDurationNs)).toBe(true);
    expect(rejects[0]!.decisionDurationNs).toBeGreaterThanOrEqual(0);
  });

  it("records decision and acquire-wait timing on an immediate admission", async () => {
    const b = createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 1 });
    const admits: LLMEventMap["admit"][] = [];
    b.on("admit", (event) => admits.push(event));

    const result = await b.acquire(request);

    expect(result.ok).toBe(true);
    expect(admits).toHaveLength(1);
    expect(admits[0]!.decisionDurationNs).toEqual(expect.any(Number));
    expect(admits[0]!.queueWaitNs).toEqual(expect.any(Number));
    expect(Number.isInteger(admits[0]!.decisionDurationNs)).toBe(true);
    expect(Number.isInteger(admits[0]!.queueWaitNs)).toBe(true);
    expect(admits[0]!.decisionDurationNs).toBeGreaterThanOrEqual(0);
    expect(admits[0]!.queueWaitNs).toBeGreaterThanOrEqual(0);
    if (result.ok) result.token.release();
  });

  it("separates queue wait from decision time on a queued admission", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 1,
      maxQueue: 1,
    });
    const admits: LLMEventMap["admit"][] = [];
    b.on("admit", (event) => admits.push(event));

    const first = await b.acquire(request);
    expect(first.ok).toBe(true);

    const secondPromise = b.acquire(request);
    await sleep(5);
    if (first.ok) first.token.release();
    const second = await secondPromise;

    expect(second.ok).toBe(true);
    expect(admits).toHaveLength(2);
    expect(admits[1]!.queueWaitNs).toBeGreaterThan(0);
    expect(admits[1]!.decisionDurationNs).toBeGreaterThanOrEqual(0);
    if (second.ok) second.token.release();
  });

  it("records the full awaited span for an acquire timeout", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 1,
      maxQueue: 1,
    });
    const rejects: LLMEventMap["reject"][] = [];
    b.on("reject", (event) => rejects.push(event));

    const first = await b.acquire(request);
    expect(first.ok).toBe(true);

    const second = await b.acquire(request, { timeoutMs: 5 });

    expect(second).toMatchObject({ ok: false, reason: "timeout" });
    expect(rejects).toHaveLength(1);
    expect(rejects[0]!.queueWaitNs).toBeGreaterThan(0);
    expect(rejects[0]!.decisionDurationNs).toBeGreaterThanOrEqual(0);
    if (first.ok) first.token.release();
  });

  it("records timing for an acquire queue_limit rejection", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 1,
      maxQueue: 1,
    });
    const rejects: LLMEventMap["reject"][] = [];
    b.on("reject", (event) => rejects.push(event));

    const first = await b.acquire(request);
    const secondPromise = b.acquire(request);
    const third = await b.acquire(request);

    expect(third).toMatchObject({ ok: false, reason: "queue_limit" });
    expect(rejects).toHaveLength(1);
    expect(rejects[0]!.queueWaitNs).toEqual(expect.any(Number));
    expect(rejects[0]!.queueWaitNs).toBeGreaterThanOrEqual(0);
    expect(rejects[0]!.decisionDurationNs).toBeGreaterThanOrEqual(0);

    if (first.ok) first.token.release();
    const second = await secondPromise;
    if (second.ok) second.token.release();
  });

  it("records postcheck rejection timing after a limits race", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 1,
      maxQueue: 0,
      initialRevision: 1,
      tokenBudget: {
        budget: 1_000,
        estimator: fixedEstimator,
      },
    });
    const rejects: LLMEventMap["reject"][] = [];
    b.on("reject", (event) => rejects.push(event));

    const pending = b.acquire(request);
    b.applyLimits({
      revision: 2,
      maxConcurrent: 1,
      maxQueue: 0,
      tokenBudget: { budget: 50, highPriorityReserve: 0 },
    });
    const result = await pending;

    expect(result).toMatchObject({ ok: false, reason: "budget_limit" });
    expect(rejects).toHaveLength(1);
    expect(rejects[0]!.limitRevision).toBe(2);
    expect(rejects[0]!.queueWaitNs).toEqual(expect.any(Number));
    expect(rejects[0]!.decisionDurationNs).toEqual(expect.any(Number));
    expect(rejects[0]!.decisionDurationNs).toBeGreaterThanOrEqual(0);
  });

  it("does not emit admission timing for an advisory observe bypass", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 1,
      tokenBudget: {
        budget: 0,
        estimator: fixedEstimator,
      },
    });
    const admits: LLMEventMap["admit"][] = [];
    const rejects: LLMEventMap["reject"][] = [];
    const bypasses: LLMEventMap["bypass"][] = [];
    b.on("admit", (event) => admits.push(event));
    b.on("reject", (event) => rejects.push(event));
    b.on("bypass", (event) => bypasses.push(event));

    const value = await b.run(request, async () => "bypassed", {
      mode: "observe",
    });

    expect(value).toBe("bypassed");
    expect(admits).toHaveLength(0);
    expect(rejects).toHaveLength(0);
    expect(bypasses).toHaveLength(1);
  });

  it("leaves the raced reject untimed when observe mode converts it to bypass", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 1,
      maxQueue: 1,
    });
    const rejects: LLMEventMap["reject"][] = [];
    const bypasses: LLMEventMap["bypass"][] = [];
    b.on("reject", (event) => rejects.push(event));
    b.on("bypass", (event) => bypasses.push(event));

    const held = await b.acquire(request);
    expect(held.ok).toBe(true);

    const value = await b.run(request, async () => "bypassed", {
      mode: "observe",
      timeoutMs: 5,
    });

    expect(value).toBe("bypassed");
    expect(rejects).toHaveLength(1);
    expect(rejects[0]).not.toHaveProperty("decisionDurationNs");
    expect(rejects[0]).not.toHaveProperty("queueWaitNs");
    expect(bypasses).toHaveLength(1);
    if (held.ok) held.token.release();
  });
});

describe("admission timing instrumentation overhead", () => {
  it("records timer overhead alongside the measured decision cost", async () => {
    const iterations = 100_000;
    let sink = 0;

    // Warm the intrinsic and bigint arithmetic before measuring them.
    for (let index = 0; index < 1_000; index++) {
      const decisionStartedNs = process.hrtime.bigint();
      const waitStartedNs = process.hrtime.bigint();
      const waitEndedNs = process.hrtime.bigint();
      const decisionEndedNs = process.hrtime.bigint();
      sink += Number(
        waitStartedNs -
          decisionStartedNs +
          (decisionEndedNs - waitEndedNs),
      );
    }

    // Baseline loop cost lets us report the incremental runtime tax of the
    // four clock reads + bigint arithmetic rather than charging loop overhead
    // to the instrumentation itself.
    const baselineStartedNs = process.hrtime.bigint();
    for (let index = 0; index < iterations; index++) sink += index & 1;
    const baselineNsPerIteration =
      Number(process.hrtime.bigint() - baselineStartedNs) / iterations;

    let reportedTimerFloorTotalNs = 0;
    const instrumentedStartedNs = process.hrtime.bigint();
    for (let index = 0; index < iterations; index++) {
      const decisionStartedNs = process.hrtime.bigint();
      const waitStartedNs = process.hrtime.bigint();
      const waitEndedNs = process.hrtime.bigint();
      const decisionEndedNs = process.hrtime.bigint();
      sink += Number(waitEndedNs - waitStartedNs);
      reportedTimerFloorTotalNs += Number(
        waitStartedNs -
          decisionStartedNs +
          (decisionEndedNs - waitEndedNs),
      );
    }
    const instrumentedNsPerIteration =
      Number(process.hrtime.bigint() - instrumentedStartedNs) / iterations;
    const runtimeTaxNs = Math.max(
      0,
      instrumentedNsPerIteration - baselineNsPerIteration,
    );
    const reportedTimerFloorNs = reportedTimerFloorTotalNs / iterations;

    const b = createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 1 });
    let decisionTotalNs = 0;
    let decisionCount = 0;
    b.on("admit", (event) => {
      if (event.decisionDurationNs !== undefined) {
        decisionTotalNs += event.decisionDurationNs;
        decisionCount++;
      }
    });
    for (let index = 0; index < 10_000; index++) {
      const acquired = await b.acquire(request);
      if (!acquired.ok) throw new Error("microbenchmark admission rejected");
      acquired.token.release();
    }
    const meanDecisionNs = decisionTotalNs / decisionCount;

    // This is intentionally diagnostic rather than a brittle performance gate:
    // CI scheduling noise must not turn an instrumentation benchmark into a
    // release blocker. The emitted numbers are captured in normal test output.
    console.info(
      `[admission-timing] runtime-tax=${runtimeTaxNs.toFixed(1)} ns/decision; ` +
        `reported-timer-floor=${reportedTimerFloorNs.toFixed(1)} ns; ` +
        `immediate-admit decision=${meanDecisionNs.toFixed(1)} ns mean; ` +
        `timer-floor-share=${((reportedTimerFloorNs / meanDecisionNs) * 100).toFixed(2)}%; ` +
        `sink=${sink}`,
    );

    expect(Number.isFinite(runtimeTaxNs)).toBe(true);
    expect(runtimeTaxNs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(reportedTimerFloorNs)).toBe(true);
    expect(reportedTimerFloorNs).toBeGreaterThan(0);
    expect(decisionCount).toBe(10_000);
    expect(Number.isFinite(meanDecisionNs)).toBe(true);
    expect(meanDecisionNs).toBeGreaterThanOrEqual(0);
    expect(sink).toBeGreaterThan(0);
  });
});
