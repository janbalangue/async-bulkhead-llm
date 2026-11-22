import { describe, expect, it } from "vitest";
import {
  createLLMBulkhead,
  LLMBulkheadRejectedError,
  type LLMAdmissionClassStats,
  type LLMStats,
  type LLMRequest,
  type LLMToken,
  type TokenEstimate,
} from "../src/index.js";

/**
 * Every counter that exists once for the whole bulkhead and once per
 * admission class must add up: the class values, summed, equal the global
 * value. These tests drive admissions through the public API and read
 * `stats()` only, so they hold for any internal layout of the counters.
 */

const request: LLMRequest = {
  messages: [{ role: "user", content: "class counters stay in step" }],
  max_tokens: 300,
};

/** Every call reserves 100 input + 300 output = 400 tokens. */
const fixedEstimator = (): TokenEstimate => ({ input: 100, maxOutput: 300 });

const TOKEN_COUNTERS = [
  "inFlightTokens",
  "totalReserved",
  "totalConsumed",
  "totalRefunded",
  "totalOverrun",
] as const;

const REQUEST_COUNTERS = [
  "admitted",
  "released",
  "rejected",
  "borrowedConcurrencyAbandoned",
] as const;

function expectClassTotalsToMatchGlobal(stats: LLMStats, step: string): void {
  const classes = Object.values(stats.admissionClasses!.classes);
  const sum = (pick: (cls: LLMAdmissionClassStats) => number): number =>
    classes.reduce((total, cls) => total + pick(cls), 0);

  for (const counter of TOKEN_COUNTERS) {
    expect(sum((cls) => cls[counter]), `${step}: ${counter}`).toBe(
      stats.tokenBudget![counter],
    );
  }
  for (const counter of REQUEST_COUNTERS) {
    expect(sum((cls) => cls[counter]), `${step}: ${counter}`).toBe(
      stats.llm[counter],
    );
  }

  const reasons = new Set<string>(Object.keys(stats.llm.rejectedByReason));
  for (const cls of classes) {
    for (const reason of Object.keys(cls.rejectedByReason)) reasons.add(reason);
  }
  const byReason = (counts: Partial<Record<string, number>>, reason: string) =>
    counts[reason] ?? 0;
  for (const reason of reasons) {
    expect(
      sum((cls) => byReason(cls.rejectedByReason, reason)),
      `${step}: rejectedByReason.${reason}`,
    ).toBe(byReason(stats.llm.rejectedByReason, reason));
  }

  // Slots have no shared owner (the global count belongs to the
  // concurrency gate), but between calls every held slot still belongs to
  // exactly one class.
  expect(sum((cls) => cls.inFlight), `${step}: inFlight`).toBe(
    stats.bulkhead.inFlight,
  );
  expect(
    sum((cls) => cls.admitted - cls.released),
    `${step}: unsettled admissions`,
  ).toBe(stats.llm.inFlight);
}

function classedBulkhead(budget = 10_000) {
  return createLLMBulkhead({
    model: "gpt-4o",
    maxConcurrent: 4,
    tokenBudget: { budget, estimator: fixedEstimator },
    admissionClasses: {
      defaultClass: "standard",
      classes: {
        premium: { protectedConcurrent: 1, protectedInFlightTokens: 500 },
        standard: {},
      },
    },
  });
}

async function admit(
  bulkhead: ReturnType<typeof classedBulkhead>,
  admissionClass: string,
): Promise<LLMToken> {
  const result = await bulkhead.acquire(request, { admissionClass });
  if (!result.ok) throw new Error(`expected admission, got ${result.reason}`);
  return result.token;
}

describe("class counters add up to the global counters", () => {
  it("through a reserve, growing and shrinking reports, and a release", async () => {
    const bulkhead = classedBulkhead();
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "idle");

    // Reserve: one admission in each class.
    const premium = await admit(bulkhead, "premium");
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "premium reserved");
    const standard = await admit(bulkhead, "standard");
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "standard reserved");
    expect(bulkhead.stats().tokenBudget).toMatchObject({
      inFlightTokens: 800,
      totalReserved: 800,
    });

    // Growing report: output passes the 300-token cap, so the hold widens
    // from 400 to 100 + 900 = 1000 and the extra 600 is overrun.
    premium.reportUsage({ input: 100, output: 900 });
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "premium overrun");
    expect(bulkhead.stats().tokenBudget).toMatchObject({
      inFlightTokens: 1_400,
      totalOverrun: 600,
    });
    expect(bulkhead.stats().admissionClasses!.classes.premium).toMatchObject({
      inFlightTokens: 1_000,
      totalOverrun: 600,
    });

    // Shrinking report: input came in under the estimate, so 60 tokens
    // go back early.
    standard.reportUsage({ input: 40, output: 10 });
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "standard early refund");
    expect(bulkhead.stats().tokenBudget).toMatchObject({
      inFlightTokens: 1_340,
      totalRefunded: 60,
    });

    // Progressive reconciliation shrinks an overrun hold: 50 remaining +
    // 10 margin + 600 already over the cap = 660, down from 1000.
    premium.reportUsage(
      { input: 100, output: 900 },
      { remainingOutputTokens: 50, safetyMarginTokens: 10 },
    );
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "premium reconciled");
    expect(bulkhead.stats().tokenBudget).toMatchObject({
      inFlightTokens: 1_000,
      totalRefunded: 400,
    });

    // A hold that shrank can grow again.
    standard.reportUsage({ input: 40, output: 500 });
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "standard overrun");
    expect(bulkhead.stats().tokenBudget).toMatchObject({
      inFlightTokens: 1_200,
      totalOverrun: 800,
    });

    // Release with final usage, then release that falls back to the last
    // report.
    premium.release({ input: 100, output: 950 });
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "premium released");
    standard.release();
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "standard released");

    const settled = bulkhead.stats();
    expect(settled.tokenBudget).toMatchObject({
      inFlightTokens: 0,
      totalReserved: 800,
      totalConsumed: 1_050 + 540,
      totalRefunded: 400,
      totalOverrun: 800,
    });
    expect(settled.llm).toMatchObject({ inFlight: 0, admitted: 2, released: 2 });
  });

  it("through rejections, run(), abandonment and a limits update", async () => {
    const bulkhead = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 2,
      tokenBudget: { budget: 1_200, estimator: fixedEstimator },
      admissionClasses: {
        defaultClass: "background",
        classes: {
          interactive: { protectedConcurrent: 1, protectedInFlightTokens: 400 },
          background: { maxInFlightTokens: 800 },
        },
      },
    });

    // Two background calls: the first sits on shared capacity, the second
    // would have to take the slot protected for `interactive`.
    const first = await admit(bulkhead, "background");
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "background admitted");
    const refused = await bulkhead.acquire(request, {
      admissionClass: "background",
    });
    expect(refused.ok).toBe(false);
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "background refused");

    // run() with mid-flight usage and final usage extraction.
    await bulkhead.run(
      request,
      async (_signal, ctx) => {
        ctx!.reportUsage({ input: 90, output: 700 });
        expectClassTotalsToMatchGlobal(bulkhead.stats(), "inside run");
        return { usage: { input: 90, output: 720 } };
      },
      { admissionClass: "interactive", getUsage: (r) => r.usage },
    );
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "run settled");

    // A callback that throws releases without usage.
    await expect(
      bulkhead.run(
        request,
        async () => {
          throw new Error("provider failed");
        },
        { admissionClass: "interactive" },
      ),
    ).rejects.toThrow("provider failed");
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "run failed");

    // The borrowed slot goes back early; the tokens stay held.
    expect(first.abandonBorrowedConcurrency()).toBe(true);
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "slot abandoned");

    // Lowering the budget below what is held rejects new work globally.
    const limits = bulkhead.stats().limits;
    bulkhead.applyLimits({
      ...limits,
      revision: limits.revision + 1,
      tokenBudget: { budget: 400, highPriorityReserve: 0 },
    });
    await expect(
      bulkhead.run(request, async () => "unreachable", {
        admissionClass: "interactive",
      }),
    ).rejects.toBeInstanceOf(LLMBulkheadRejectedError);
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "over budget");

    first.release({ input: 100, output: 20 });
    expectClassTotalsToMatchGlobal(bulkhead.stats(), "all released");

    const settled = bulkhead.stats();
    expect(settled.llm.inFlight).toBe(0);
    expect(settled.llm.rejected).toBe(2);
    expect(settled.llm.borrowedConcurrencyAbandoned).toBe(1);
    expect(settled.tokenBudget!.inFlightTokens).toBe(0);
  });

  it("after every step of a seeded random walk", async () => {
    // Deterministic generator: no Math.random and no wall-clock time.
    let seed = 0x5eed1e55;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const int = (min: number, max: number): number =>
      min + Math.floor(random() * (max - min + 1));
    const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;

    const bulkhead = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 6,
      tokenBudget: { budget: 4_000, highPriorityReserve: 300 },
      admissionClasses: {
        defaultClass: "bronze",
        classes: {
          gold: { protectedConcurrent: 1, protectedInFlightTokens: 400 },
          silver: { maxConcurrent: 3, maxInFlightTokens: 2_500 },
          bronze: {},
        },
      },
    });
    const live: Array<{ token: LLMToken; maxOutput: number }> = [];
    const usage = () => ({ input: int(0, 400), output: int(0, 1_200) });

    for (let step = 0; step < 600; step++) {
      const roll = random();
      let action: string;
      if (roll < 0.4 || live.length === 0) {
        action = "acquire";
        const reservation = { input: int(0, 300), maxOutput: int(0, 600) };
        const result = await bulkhead.acquire(request, {
          admissionClass: pick(["gold", "silver", "bronze"] as const),
          priority: pick(["high", "normal"] as const),
          reservation,
        });
        if (result.ok) {
          live.push({ token: result.token, maxOutput: reservation.maxOutput });
        }
      } else if (roll < 0.7) {
        action = "report";
        const { token, maxOutput } = pick(live);
        if (random() < 0.3) {
          token.reportUsage(usage(), {
            remainingOutputTokens: int(0, maxOutput),
            safetyMarginTokens: int(0, 50),
          });
        } else {
          token.reportUsage(usage());
        }
      } else if (roll < 0.78) {
        action = "abandon";
        pick(live).token.abandonBorrowedConcurrency();
      } else if (roll < 0.95) {
        action = "release";
        const [entry] = live.splice(int(0, live.length - 1), 1);
        entry!.token.release(random() < 0.5 ? usage() : undefined);
      } else {
        action = "limits";
        const limits = bulkhead.stats().limits;
        bulkhead.applyLimits({
          ...limits,
          revision: limits.revision + 1,
          maxConcurrent: int(2, 8),
          tokenBudget: {
            budget: int(1_500, 6_000),
            highPriorityReserve: int(0, 500),
          },
        });
      }
      expectClassTotalsToMatchGlobal(bulkhead.stats(), `step ${step} ${action}`);
    }

    for (const { token } of live) token.release();
    const settled = bulkhead.stats();
    expectClassTotalsToMatchGlobal(settled, "drained");
    expect(settled.llm.inFlight).toBe(0);
    expect(settled.tokenBudget!.inFlightTokens).toBe(0);

    // The walk has to reach every kind of counter movement to mean anything.
    expect(settled.tokenBudget!.totalOverrun).toBeGreaterThan(0);
    expect(settled.tokenBudget!.totalRefunded).toBeGreaterThan(0);
    expect(settled.tokenBudget!.totalConsumed).toBeGreaterThan(0);
    expect(settled.llm.rejected).toBeGreaterThan(0);
    expect(settled.llm.borrowedConcurrencyAbandoned).toBeGreaterThan(0);
  });
});
