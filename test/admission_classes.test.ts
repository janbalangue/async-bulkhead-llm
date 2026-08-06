import { describe, expect, it } from "vitest";
import {
  createLLMBulkhead,
  type LLMEventMap,
  type LLMRequest,
  type TokenEstimate,
} from "../src/index.js";

const request: LLMRequest = {
  messages: [{ role: "user", content: "class-aware admission" }],
  max_tokens: 300,
};

const fixedEstimator = (): TokenEstimate => ({
  input: 100,
  maxOutput: 300,
});

function classed(extra: { maxConcurrent?: number; budget?: number } = {}) {
  return createLLMBulkhead({
    model: "gpt-4o",
    maxConcurrent: extra.maxConcurrent ?? 4,
    tokenBudget: {
      budget: extra.budget ?? 2_000,
      estimator: fixedEstimator,
    },
    admissionClasses: {
      defaultClass: "standard",
      classes: {
        premium: { maxConcurrent: 2, maxInFlightTokens: 1_200 },
        standard: { maxConcurrent: 1, maxInFlightTokens: 800 },
      },
    },
  });
}

describe("bounded admission classes", () => {
  it("validates a fixed class table and refuses unbounded class creation", async () => {
    expect(() =>
      createLLMBulkhead({
        model: "gpt-4o",
        maxConcurrent: 1,
        admissionClasses: {
          defaultClass: "missing",
          classes: { standard: { maxConcurrent: 1 } },
        },
      }),
    ).toThrow(/defaultClass/);

    expect(() =>
      createLLMBulkhead({
        model: "gpt-4o",
        maxConcurrent: 1,
        admissionClasses: {
          defaultClass: "standard",
          classes: {
            standard: { maxInFlightTokens: 100 },
          },
        },
      }),
    ).toThrow(/requires tokenBudget/);

    expect(() =>
      createLLMBulkhead({
        model: "gpt-4o",
        maxConcurrent: 1,
        admissionClasses: {
          defaultClass: "standard",
          classes: {
            standard: { protectedInFlightTokens: 100 },
          },
        },
      }),
    ).toThrow(/protectedInFlightTokens requires tokenBudget/);

    const plain = createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 1 });
    await expect(
      plain.acquire(request, { admissionClass: "standard" }),
    ).rejects.toThrow(/requires admissionClasses/);

    const b = classed();
    await expect(
      b.acquire(request, { admissionClass: "raw-tenant-id" }),
    ).rejects.toThrow(/unknown admissionClass/);
    expect(Object.keys(b.stats().admissionClasses!.classes)).toEqual([
      "premium",
      "standard",
    ]);
  });

  it("supports concurrency-only classes without a token budget", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 2,
      admissionClasses: {
        defaultClass: "standard",
        classes: {
          premium: { maxConcurrent: 2 },
          standard: { maxConcurrent: 1 },
        },
      },
    });

    const first = await b.acquire(request);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const blocked = b.wouldAdmit(request, {
      admissionClass: "standard",
      detail: true,
    });
    expect(blocked).toMatchObject({
      admit: false,
      reason: "concurrency_limit",
      detail: {
        constraint: "admission_class",
        admissionClass: { id: "standard" },
      },
    });
    expect(blocked.detail?.admissionClass?.tokenBudget).toBeUndefined();

    const premium = await b.acquire(request, { admissionClass: "premium" });
    expect(premium.ok).toBe(true);
    if (premium.ok) premium.token.release();
    first.token.release();
  });

  it("enforces class concurrency without consuming another class's headroom", async () => {
    const b = classed();

    const standard = await b.acquire(request);
    expect(standard.ok).toBe(true);
    if (!standard.ok) return;
    expect(standard.admissionClass).toBe("standard");
    expect(standard.token.admissionClass).toBe("standard");

    const rejected = await b.acquire(request);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.reason).toBe("concurrency_limit");
    expect(rejected.detail).toMatchObject({
      constraint: "admission_class",
      admissionClass: {
        id: "standard",
        inFlight: 1,
        maxConcurrent: 1,
        availableConcurrent: 0,
      },
    });

    const premium = await b.acquire(request, { admissionClass: "premium" });
    expect(premium.ok).toBe(true);
    if (!premium.ok) return;

    expect(b.stats().bulkhead.inFlight).toBe(2);
    expect(b.stats().admissionClasses!.classes.standard).toMatchObject({
      inFlight: 1,
      admitted: 1,
      rejected: 1,
      rejectedByReason: { concurrency_limit: 1 },
    });
    expect(b.stats().admissionClasses!.classes.premium!.inFlight).toBe(1);

    standard.token.release();
    premium.token.release();
    expect(b.stats().admissionClasses!.classes.standard!.inFlight).toBe(0);
    expect(b.stats().admissionClasses!.classes.premium!.inFlight).toBe(0);
  });

  it("enforces and progressively reconciles class token ceilings", async () => {
    const b = classed({ budget: 4_000 });

    const first = await b.acquire(request, { admissionClass: "standard" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Raise only the concurrency ceiling so the next rejection is class-token
    // capacity: each request reserves 400, and the class token ceiling is 800.
    b.applyLimits({
      revision: 1,
      maxConcurrent: 4,
      maxQueue: 0,
      tokenBudget: { budget: 4_000, highPriorityReserve: 0 },
      admissionClasses: {
        premium: { maxConcurrent: 2, maxInFlightTokens: 1_200 },
        standard: { maxConcurrent: 2, maxInFlightTokens: 700 },
      },
    });

    const secondBeforeRefund = await b.acquire(request, {
      admissionClass: "standard",
    });
    expect(secondBeforeRefund.ok).toBe(false);
    if (secondBeforeRefund.ok) return;
    expect(secondBeforeRefund.reason).toBe("budget_limit");
    expect(secondBeforeRefund.detail).toMatchObject({
      constraint: "admission_class",
      admissionClass: {
        id: "standard",
        tokenBudget: {
          inFlightTokens: 400,
          maxInFlightTokens: 700,
          available: 300,
          requested: 400,
        },
      },
    });

    const usage = first.token.reportUsage(
      { input: 100, output: 10 },
      { remainingOutputTokens: 50, safetyMarginTokens: 10 },
    );
    expect(usage).toMatchObject({ admissionClass: "standard", held: 60 });
    expect(b.stats().admissionClasses!.classes.standard).toMatchObject({
      inFlightTokens: 60,
      totalReserved: 400,
      totalRefunded: 340,
    });

    const second = await b.acquire(request, { admissionClass: "standard" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(b.stats().admissionClasses!.classes.standard!.inFlightTokens).toBe(
      460,
    );

    first.token.release({ input: 100, output: 10 });
    second.token.release({ input: 100, output: 20 });

    const stats = b.stats().admissionClasses!.classes.standard!;
    expect(stats.inFlight).toBe(0);
    expect(stats.inFlightTokens).toBe(0);
    expect(stats.released).toBe(2);
    expect(stats.totalConsumed).toBe(230);
  });

  it("distinguishes global and class capacity constraints", async () => {
    const b = classed({ maxConcurrent: 1, budget: 4_000 });
    const first = await b.acquire(request, { admissionClass: "premium" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const result = b.wouldAdmit(request, {
      admissionClass: "standard",
      detail: true,
    });
    expect(result).toMatchObject({
      admit: false,
      reason: "concurrency_limit",
      detail: {
        constraint: "global",
        inFlight: 1,
        maxConcurrent: 1,
        admissionClass: { id: "standard", inFlight: 0 },
      },
    });

    first.token.release();
  });

  it("atomically reconfigures the fixed class keys and shrinks by attrition", async () => {
    const b = classed();
    expect(b.limits()).toEqual({
      revision: 0,
      maxConcurrent: 4,
      maxQueue: 0,
      tokenBudget: { budget: 2_000, highPriorityReserve: 0 },
      admissionClasses: {
        premium: { maxConcurrent: 2, maxInFlightTokens: 1_200 },
        standard: { maxConcurrent: 1, maxInFlightTokens: 800 },
      },
    });
    expect(Object.isFrozen(b.limits().admissionClasses)).toBe(true);
    expect(Object.isFrozen(b.limits().admissionClasses!.premium)).toBe(true);

    expect(() =>
      b.applyLimits({
        revision: 1,
        maxConcurrent: 4,
        maxQueue: 0,
        tokenBudget: { budget: 2_000, highPriorityReserve: 0 },
        admissionClasses: {
          premium: { maxConcurrent: 2, maxInFlightTokens: 1_200 },
        },
      }),
    ).toThrow(/exactly the construction-time class keys/);

    expect(() =>
      b.applyLimits({
        revision: 1,
        maxConcurrent: 4,
        maxQueue: 0,
        tokenBudget: { budget: 2_000, highPriorityReserve: 0 },
        admissionClasses: {
          premium: { maxConcurrent: 2, maxInFlightTokens: 1_200 },
          standard: { maxConcurrent: 1, maxInFlightTokens: 800 },
          dynamicTenant: { maxConcurrent: 1 },
        },
      }),
    ).toThrow(/exactly the construction-time class keys/);

    const beforeInvalidUpdate = b.limits();
    expect(() =>
      b.applyLimits({
        revision: 1,
        maxConcurrent: 99,
        maxQueue: 99,
        tokenBudget: { budget: 99, highPriorityReserve: 0 },
        admissionClasses: {
          premium: { maxConcurrent: 2, maxInFlightTokens: 1_200 },
          standard: { maxConcurrent: -1, maxInFlightTokens: 800 },
        },
      }),
    ).toThrow(/maxConcurrent/);
    expect(b.limits()).toEqual(beforeInvalidUpdate);

    expect(() =>
      b.applyLimits({
        revision: 1,
        maxConcurrent: 4,
        maxQueue: 0,
        tokenBudget: { budget: 2_000, highPriorityReserve: 0 },
        admissionClasses: {
          premium: {
            protectedConcurrent: 3,
            maxConcurrent: 3,
            protectedInFlightTokens: 1_200,
            maxInFlightTokens: 1_200,
          },
          standard: {
            protectedConcurrent: 2,
            maxConcurrent: 2,
            protectedInFlightTokens: 900,
            maxInFlightTokens: 900,
          },
        },
      }),
    ).toThrow(/protectedConcurrent sum/);
    expect(b.limits()).toEqual(beforeInvalidUpdate);

    const first = await b.acquire(request, { admissionClass: "premium" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const applied = b.applyLimits({
      revision: 1,
      maxConcurrent: 4,
      maxQueue: 0,
      tokenBudget: { budget: 2_000, highPriorityReserve: 0 },
      admissionClasses: {
        premium: { maxConcurrent: 0, maxInFlightTokens: 0 },
        standard: { maxConcurrent: 1, maxInFlightTokens: 800 },
      },
    });
    expect(applied).toMatchObject({ applied: true });
    expect(b.stats().admissionClasses!.classes.premium!.inFlight).toBe(1);

    const blocked = await b.acquire(request, { admissionClass: "premium" });
    expect(blocked).toMatchObject({
      ok: false,
      reason: "budget_limit",
      detail: { constraint: "admission_class" },
    });

    first.token.release();
    expect(b.stats().admissionClasses!.classes.premium!.inFlight).toBe(0);
  });

  it("partitions deduplication by class and validates every caller", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 4,
      tokenBudget: { budget: 4_000, estimator: fixedEstimator },
      admissionClasses: {
        defaultClass: "standard",
        classes: {
          premium: { maxConcurrent: 2, maxInFlightTokens: 1_600 },
          standard: { maxConcurrent: 2, maxInFlightTokens: 1_600 },
        },
      },
      deduplication: true,
    });

    const gates = new Map<string, () => void>();
    let calls = 0;
    const dedupEvents: LLMEventMap["dedup"][] = [];
    b.on("dedup", (event) => dedupEvents.push(event));

    const call = (label: string, admissionClass: string) =>
      b.run(
        request,
        async () => {
          calls++;
          await new Promise<void>((resolve) => gates.set(label, resolve));
          return label;
        },
        { admissionClass, dedupScope: "tenant-a" },
      );

    const waitForCalls = async (expected: number) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (calls === expected) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`expected ${expected} provider calls, saw ${calls}`);
    };

    const premiumLeader = call("premium-result", "premium");
    await waitForCalls(1);
    const standardLeader = call("standard-result", "standard");
    await waitForCalls(2);

    const premiumFollower = call("unused", "premium");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    expect(dedupEvents).toEqual([
      expect.objectContaining({ admissionClass: "premium" }),
    ]);

    await expect(
      b.run(request, async () => "bad", {
        admissionClass: "unknown",
        dedupScope: "tenant-a",
      }),
    ).rejects.toThrow(/unknown admissionClass/);
    expect(calls).toBe(2);

    gates.get("premium-result")!();
    gates.get("standard-result")!();
    await expect(premiumLeader).resolves.toBe("premium-result");
    await expect(premiumFollower).resolves.toBe("premium-result");
    await expect(standardLeader).resolves.toBe("standard-result");
  });

  it("rechecks class capacity after a queued request receives a global slot", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 1,
      maxQueue: 1,
      admissionClasses: {
        defaultClass: "standard",
        classes: {
          premium: { maxConcurrent: 1 },
          standard: { maxConcurrent: 1 },
        },
      },
    });

    const held = await b.acquire(request, { admissionClass: "premium" });
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    const waiting = b.acquire(request, { admissionClass: "standard" });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (b.stats().bulkhead.pending === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(b.stats().bulkhead.pending).toBe(1);

    b.applyLimits({
      revision: 1,
      maxConcurrent: 1,
      maxQueue: 1,
      admissionClasses: {
        premium: { maxConcurrent: 1 },
        standard: { maxConcurrent: 0 },
      },
    });

    held.token.release();
    await expect(waiting).resolves.toMatchObject({
      ok: false,
      reason: "concurrency_limit",
      detail: {
        constraint: "admission_class",
        admissionClass: { id: "standard", maxConcurrent: 0 },
      },
    });
    expect(b.stats().bulkhead).toMatchObject({ inFlight: 0, pending: 0 });
  });

  it("carries the class through events, run context, and observe bypasses", async () => {
    const b = classed();
    const admits: LLMEventMap["admit"][] = [];
    const releases: LLMEventMap["release"][] = [];
    const bypasses: LLMEventMap["bypass"][] = [];
    b.on("admit", (event) => admits.push(event));
    b.on("release", (event) => releases.push(event));
    b.on("bypass", (event) => bypasses.push(event));

    const value = await b.run(
      request,
      async (_signal, context) => {
        expect(context?.admissionClass).toBe("premium");
        return 42;
      },
      {
        admissionClass: "premium",
        getUsage: () => ({ input: 100, output: 20 }),
      },
    );
    expect(value).toBe(42);
    expect(admits[0]?.admissionClass).toBe("premium");
    expect(releases[0]?.admissionClass).toBe("premium");

    const held = await b.acquire(request);
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    const observed = await b.run(
      request,
      async (_signal, context) => {
        expect(context).toMatchObject({
          admission: "bypassed",
          admissionClass: "standard",
          bypassReason: "concurrency_limit",
        });
        return "observed";
      },
      { mode: "observe" },
    );
    expect(observed).toBe("observed");
    expect(bypasses[0]).toMatchObject({
      admissionClass: "standard",
      reason: "concurrency_limit",
      detail: { constraint: "admission_class" },
    });

    held.token.release();
  });

  it("validates protected floors against class and global limits", () => {
    expect(() =>
      createLLMBulkhead({
        model: "gpt-4o",
        maxConcurrent: 2,
        admissionClasses: {
          defaultClass: "premium",
          classes: {
            premium: { protectedConcurrent: 2, maxConcurrent: 1 },
          },
        },
      }),
    ).toThrow(/protectedConcurrent must be <=/);

    expect(() =>
      createLLMBulkhead({
        model: "gpt-4o",
        maxConcurrent: 2,
        admissionClasses: {
          defaultClass: "premium",
          classes: {
            premium: { protectedConcurrent: 2 },
            standard: { protectedConcurrent: 1 },
          },
        },
      }),
    ).toThrow(/protectedConcurrent sum/);

    expect(() =>
      createLLMBulkhead({
        model: "gpt-4o",
        maxConcurrent: 4,
        tokenBudget: { budget: 1_000, estimator: fixedEstimator },
        admissionClasses: {
          defaultClass: "premium",
          classes: {
            premium: { protectedInFlightTokens: 700 },
            standard: { protectedInFlightTokens: 400 },
          },
        },
      }),
    ).toThrow(/protectedInFlightTokens sum/);
  });

  it("protects class concurrency floors and accounts shared borrowing", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 4,
      admissionClasses: {
        defaultClass: "standard",
        classes: {
          premium: { protectedConcurrent: 2, maxConcurrent: 4 },
          standard: { protectedConcurrent: 1, maxConcurrent: 4 },
        },
      },
    });

    const premium: Array<Awaited<ReturnType<typeof b.acquire>>> = [];
    for (let i = 0; i < 3; i++) {
      const result = await b.acquire(request, { admissionClass: "premium" });
      expect(result.ok).toBe(true);
      premium.push(result);
    }

    const blocked = await b.acquire(request, { admissionClass: "premium" });
    expect(blocked).toMatchObject({
      ok: false,
      reason: "concurrency_limit",
      detail: {
        constraint: "admission_class_protection",
        sharedCapacity: {
          concurrency: {
            capacity: 1,
            inUse: 1,
            available: 0,
            requestedBorrowed: 1,
          },
        },
      },
    });

    const standard = await b.acquire(request, { admissionClass: "standard" });
    expect(standard.ok).toBe(true);

    const stats = b.stats().admissionClasses!;
    expect(stats.shared).toMatchObject({
      maxConcurrent: 1,
      inFlight: 1,
      availableConcurrent: 0,
    });
    expect(stats.classes.premium).toMatchObject({
      protectedConcurrentInUse: 2,
      borrowedConcurrent: 1,
      totalBorrowedAdmissions: 1,
    });
    expect(stats.classes.standard).toMatchObject({
      protectedConcurrentInUse: 1,
      borrowedConcurrent: 0,
    });

    for (const result of premium) {
      if (result.ok) result.token.release();
    }
    if (standard.ok) standard.token.release();
  });

  it("protects token floors and reports borrowed token reservations", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 10,
      tokenBudget: { budget: 2_000, estimator: fixedEstimator },
      admissionClasses: {
        defaultClass: "standard",
        classes: {
          premium: {
            protectedInFlightTokens: 400,
            maxInFlightTokens: 2_000,
          },
          standard: {
            protectedInFlightTokens: 800,
            maxInFlightTokens: 2_000,
          },
        },
      },
    });

    const premium: Array<Awaited<ReturnType<typeof b.acquire>>> = [];
    for (let i = 0; i < 3; i++) {
      const result = await b.acquire(request, { admissionClass: "premium" });
      expect(result.ok).toBe(true);
      premium.push(result);
    }

    const blocked = b.wouldAdmit(request, {
      admissionClass: "premium",
      detail: true,
    });
    expect(blocked).toMatchObject({
      admit: false,
      reason: "budget_limit",
      detail: {
        constraint: "admission_class_protection",
        sharedCapacity: {
          tokenBudget: {
            capacity: 800,
            inUse: 800,
            available: 0,
            requestedBorrowed: 400,
          },
        },
      },
    });

    const standard1 = await b.acquire(request, { admissionClass: "standard" });
    const standard2 = await b.acquire(request, { admissionClass: "standard" });
    expect(standard1.ok).toBe(true);
    expect(standard2.ok).toBe(true);

    expect(b.stats().admissionClasses!.classes.premium).toMatchObject({
      protectedTokensInUse: 400,
      borrowedInFlightTokens: 800,
      totalBorrowedTokensReserved: 800,
    });
    expect(b.stats().admissionClasses!.classes.standard).toMatchObject({
      protectedTokensInUse: 800,
      borrowedInFlightTokens: 0,
    });

    for (const result of [...premium, standard1, standard2]) {
      if (result.ok) result.token.release();
    }
  });

  it("restores raised floors by attrition without revoking active work", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 4,
      admissionClasses: {
        defaultClass: "standard",
        classes: {
          premium: { maxConcurrent: 4 },
          standard: { maxConcurrent: 4 },
        },
      },
    });

    const premium = await Promise.all(
      Array.from({ length: 3 }, () =>
        b.acquire(request, { admissionClass: "premium" }),
      ),
    );
    expect(premium.every((result) => result.ok)).toBe(true);

    b.applyLimits({
      revision: 1,
      maxConcurrent: 4,
      maxQueue: 0,
      admissionClasses: {
        premium: { protectedConcurrent: 1, maxConcurrent: 4 },
        standard: { protectedConcurrent: 2, maxConcurrent: 4 },
      },
    });

    expect(b.stats().admissionClasses!.classes.premium).toMatchObject({
      inFlight: 3,
      protectedConcurrentInUse: 1,
      borrowedConcurrent: 2,
    });

    await expect(
      b.acquire(request, { admissionClass: "premium" }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "concurrency_limit",
      detail: { constraint: "admission_class_protection" },
    });

    const standard1 = await b.acquire(request, { admissionClass: "standard" });
    expect(standard1.ok).toBe(true);
    const standardBlocked = await b.acquire(request, {
      admissionClass: "standard",
    });
    expect(standardBlocked).toMatchObject({
      ok: false,
      reason: "concurrency_limit",
      detail: { constraint: "global" },
    });

    const firstPremium = premium.find((result) => result.ok);
    if (firstPremium?.ok) firstPremium.token.release();
    const standard2 = await b.acquire(request, { admissionClass: "standard" });
    expect(standard2.ok).toBe(true);

    for (const result of premium) {
      if (result.ok && result !== firstPremium) result.token.release();
    }
    if (standard1.ok) standard1.token.release();
    if (standard2.ok) standard2.token.release();
  });

});
