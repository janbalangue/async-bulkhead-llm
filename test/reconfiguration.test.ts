import { describe, expect, it } from "vitest";
import {
  createLLMBulkhead,
  type LLMEventMap,
  type LLMRequest,
  type TokenEstimate,
} from "../src/index.js";

const request: LLMRequest = {
  messages: [{ role: "user", content: "reconfigure" }],
  max_tokens: 300,
};

const fixedEstimator = (): TokenEstimate => ({
  input: 100,
  maxOutput: 300,
});

function budgeted() {
  return createLLMBulkhead({
    model: "gpt-4o",
    maxConcurrent: 1,
    maxQueue: 1,
    initialRevision: 7,
    tokenBudget: {
      budget: 1_000,
      highPriorityReserve: 0,
      estimator: fixedEstimator,
    },
  });
}

describe("atomic versioned admission-limit reconfiguration", () => {
  it("exposes the initial complete snapshot", () => {
    const b = budgeted();

    expect(b.limits()).toEqual({
      revision: 7,
      maxConcurrent: 1,
      maxQueue: 1,
      tokenBudget: {
        budget: 1_000,
        highPriorityReserve: 0,
      },
    });
    expect(b.stats().limits).toEqual(b.limits());
    expect(Object.isFrozen(b.limits())).toBe(true);
    expect(Object.isFrozen(b.limits().tokenBudget)).toBe(true);
  });

  it("rejects equal and lower revisions without mutation", () => {
    const b = budgeted();

    const equal = b.applyLimits({
      revision: 7,
      maxConcurrent: 99,
      maxQueue: 99,
      tokenBudget: { budget: 99_000, highPriorityReserve: 99_000 },
    });
    const lower = b.applyLimits({
      revision: 6,
      maxConcurrent: 0,
      maxQueue: 0,
      tokenBudget: { budget: 0, highPriorityReserve: 0 },
    });

    expect(equal).toEqual({
      applied: false,
      reason: "stale_revision",
      current: b.limits(),
    });
    expect(lower).toEqual({
      applied: false,
      reason: "stale_revision",
      current: b.limits(),
    });
    expect(b.limits()).toEqual({
      revision: 7,
      maxConcurrent: 1,
      maxQueue: 1,
      tokenBudget: { budget: 1_000, highPriorityReserve: 0 },
    });
  });

  it("validates the entire higher-revision snapshot before mutation", () => {
    const b = budgeted();

    expect(() =>
      b.applyLimits({
        revision: 8,
        maxConcurrent: 2,
        maxQueue: -1,
        tokenBudget: { budget: 500, highPriorityReserve: 100 },
      }),
    ).toThrow(/limits\.maxQueue/);

    expect(b.limits()).toEqual({
      revision: 7,
      maxConcurrent: 1,
      maxQueue: 1,
      tokenBudget: { budget: 1_000, highPriorityReserve: 0 },
    });
  });

  it("applies one coherent snapshot before newly opened queue capacity resumes", async () => {
    const b = budgeted();
    const first = await b.acquire(request);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // This request passes the old 1,000-token pre-check and waits for the
    // single concurrency slot. The new revision opens concurrency while
    // shrinking the budget below the two-request total.
    const queued = b.acquire(request);
    expect(b.stats().bulkhead.pending).toBe(1);

    const events: LLMEventMap["reconfigure"][] = [];
    b.on("reconfigure", (event) => events.push(event));
    const applied = b.applyLimits({
      revision: 8,
      maxConcurrent: 2,
      maxQueue: 3,
      tokenBudget: { budget: 500, highPriorityReserve: 100 },
    });

    expect(applied.applied).toBe(true);
    expect(events).toEqual([
      {
        previous: {
          revision: 7,
          maxConcurrent: 1,
          maxQueue: 1,
          tokenBudget: { budget: 1_000, highPriorityReserve: 0 },
        },
        current: {
          revision: 8,
          maxConcurrent: 2,
          maxQueue: 3,
          tokenBudget: { budget: 500, highPriorityReserve: 100 },
        },
      },
    ]);

    // The resumed waiter must evaluate against revision 8's token ceiling,
    // not the old budget or a partially applied mix of values.
    await expect(queued).resolves.toMatchObject({
      ok: false,
      reason: "budget_limit",
    });
    expect(b.stats().bulkhead.inFlight).toBe(1);
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(400);

    first.token.release();
  });

  it("shrinks concurrency by attrition without revoking in-flight work", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 2,
      maxQueue: 0,
    });
    const first = await b.acquire(request);
    const second = await b.acquire(request);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    b.applyLimits({ revision: 1, maxConcurrent: 1, maxQueue: 0 });
    expect(b.stats().bulkhead.inFlight).toBe(2);
    expect((await b.acquire(request))).toMatchObject({
      ok: false,
      reason: "concurrency_limit",
    });

    first.token.release();
    expect(b.stats().bulkhead.inFlight).toBe(1);
    expect((await b.acquire(request))).toMatchObject({
      ok: false,
      reason: "concurrency_limit",
    });

    second.token.release();
    const admitted = await b.acquire(request);
    expect(admitted.ok).toBe(true);
    if (admitted.ok) admitted.token.release();
  });

  it("raises concurrency and admits already accepted waiters immediately", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 1,
      maxQueue: 1,
    });
    const first = await b.acquire(request);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const queued = b.acquire(request);
    expect(b.stats().bulkhead.pending).toBe(1);

    b.applyLimits({ revision: 1, maxConcurrent: 2, maxQueue: 1 });
    const second = await queued;
    expect(second.ok).toBe(true);
    expect(b.stats().bulkhead.inFlight).toBe(2);
    expect(b.stats().bulkhead.pending).toBe(0);

    first.token.release();
    if (second.ok) second.token.release();
  });

  it("updates the high-priority reserve with the same revision", async () => {
    const b = budgeted();
    b.applyLimits({
      revision: 8,
      maxConcurrent: 3,
      maxQueue: 0,
      tokenBudget: { budget: 1_000, highPriorityReserve: 700 },
    });

    expect(await b.acquire(request)).toMatchObject({
      ok: false,
      reason: "budget_limit",
    });
    const high = await b.acquire(request, { priority: "high" });
    expect(high.ok).toBe(true);
    if (high.ok) high.token.release();
  });

  it("supports a zero-concurrency fail-fast kill switch", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 2,
      maxQueue: 10,
    });

    b.applyLimits({ revision: 1, maxConcurrent: 0, maxQueue: 10 });
    expect(b.wouldAdmit(request)).toEqual({
      admit: false,
      reason: "concurrency_limit",
    });
    expect(await b.acquire(request)).toMatchObject({
      ok: false,
      reason: "concurrency_limit",
    });
    expect(b.stats().bulkhead.pending).toBe(0);
  });

  it("keeps token-budget feature shape fixed at construction", () => {
    const withBudget = budgeted();
    expect(() =>
      withBudget.applyLimits({
        revision: 8,
        maxConcurrent: 2,
        maxQueue: 0,
      }),
    ).toThrow(/limits\.tokenBudget is required/);
    expect(withBudget.limits().revision).toBe(7);

    const withoutBudget = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 1,
    });
    expect(() =>
      withoutBudget.applyLimits({
        revision: 1,
        maxConcurrent: 1,
        maxQueue: 0,
        tokenBudget: { budget: 100, highPriorityReserve: 0 },
      }),
    ).toThrow(/limits\.tokenBudget must be omitted/);
    expect(withoutBudget.limits().revision).toBe(0);
  });

  it("allows a runtime reserve above a shrunken budget", async () => {
    const b = budgeted();
    b.applyLimits({
      revision: 8,
      maxConcurrent: 2,
      maxQueue: 0,
      tokenBudget: { budget: 300, highPriorityReserve: 700 },
    });

    expect(b.stats().tokenBudget).toMatchObject({
      budget: 300,
      highPriorityReserve: 700,
    });
    expect(await b.acquire(request)).toMatchObject({
      ok: false,
      reason: "budget_limit",
    });
  });

  it("keeps setBudget as a version-advancing compatibility wrapper", () => {
    const b = budgeted();
    b.setBudget(250);

    expect(b.limits()).toEqual({
      revision: 8,
      maxConcurrent: 1,
      maxQueue: 1,
      tokenBudget: { budget: 250, highPriorityReserve: 0 },
    });
  });
});
