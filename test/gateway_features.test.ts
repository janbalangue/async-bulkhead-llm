import { describe, it, expect } from "vitest";
import {
  createLLMBulkhead,
  LLMBulkheadRejectedError,
  type LLMRequest,
  type TokenEstimate,
} from "../src/index.js";

// Fixed estimator: every request reserves input=100 + maxOutput=1000 = 1100.
const fixedEstimator = (): TokenEstimate => ({ input: 100, maxOutput: 1000 });

const req = (text = "x"): LLMRequest => ({
  messages: [{ role: "user", content: text }],
  max_tokens: 1000,
});

function makeBulkhead(
  budget: number,
  extra: { highPriorityReserve?: number; maxConcurrent?: number } = {},
) {
  return createLLMBulkhead({
    model: "claude-sonnet-4",
    maxConcurrent: extra.maxConcurrent ?? 10,
    tokenBudget: {
      budget,
      estimator: fixedEstimator,
      ...(extra.highPriorityReserve !== undefined
        ? { highPriorityReserve: extra.highPriorityReserve }
        : {}),
    },
  });
}

describe("reportUsage — streaming budget enforcement", () => {
  it("early-refunds input over-estimate immediately, freeing admission capacity", async () => {
    // Budget fits exactly one 1100-token reservation.
    const b = makeBulkhead(1200);

    const r1 = await b.acquire(req("a"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Second request cannot be admitted: 1100 held, 100 available.
    const r2 = await b.acquire(req("b"));
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe("budget_limit");

    // Stream starts: actual input was only 20 tokens (estimated 100).
    // Hold shrinks 1100 -> 20 + 1000 = 1020, refunding 80.
    const snap = r1.token.reportUsage({ input: 20, output: 5 });
    expect(snap.reserved).toBe(1100);
    expect(snap.held).toBe(1020);
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(1020);
    expect(b.stats().tokenBudget!.totalRefunded).toBe(80);

    // Available is now 180 — still not enough for another 1100 request,
    // but a smaller request (via a different estimator path) would fit.
    expect(b.stats().tokenBudget!.available).toBe(180);

    r1.token.release();
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(0);
  });

  it("expands the hold on output overrun and blocks new admissions", async () => {
    const b = makeBulkhead(2400); // fits two 1100 reservations (2200)

    const r1 = await b.acquire(req("a"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Stream blows past its output reservation: output=1400 > maxOut=1000.
    // Hold: 100(input est is replaced by reported 100) + max(1000, 1400) = 1500.
    const snap = r1.token.reportUsage({ input: 100, output: 1400 });
    expect(snap.held).toBe(1500);
    expect(snap.overReservation).toBe(true);
    expect(snap.outputRemaining).toBe(0);
    expect(b.stats().tokenBudget!.totalOverrun).toBe(400);
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(1500);

    // 2400 - 1500 = 900 available: a 1100 request must now be rejected,
    // even though pre-overrun it would have fit.
    const r2 = await b.acquire(req("b"));
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe("budget_limit");

    r1.token.release({ input: 100, output: 1400 });
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(0);
    // No refund: actual (1500) === held (1500).
    expect(b.stats().tokenBudget!.totalRefunded).toBe(0);
  });

  it("clamps stale (decreasing) reports — cumulative usage never shrinks", async () => {
    const b = makeBulkhead(5000);
    const r = await b.acquire(req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    r.token.reportUsage({ input: 50, output: 300 });
    // Stale report with lower output must not shrink accounting.
    const snap = r.token.reportUsage({ input: 50, output: 200 });
    expect(snap.consumed).toBe(350); // 50 + max(300, 200)
    r.token.release();
  });

  it("release() without usage falls back to the last reported usage for refund", async () => {
    const b = makeBulkhead(5000);
    const r = await b.acquire(req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    r.token.reportUsage({ input: 100, output: 250 });
    r.token.release(); // no explicit usage

    const tb = b.stats().tokenBudget!;
    expect(tb.totalConsumed).toBe(350);
    // Hold at release was 100 + max(1000, 250) = 1100; refund = 1100 - 350.
    expect(tb.totalRefunded).toBe(750);
    expect(tb.inFlightTokens).toBe(0);
  });

  it("explicit usage at release overrides mid-flight reports", async () => {
    const b = makeBulkhead(5000);
    const r = await b.acquire(req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    r.token.reportUsage({ input: 100, output: 100 });
    r.token.release({ input: 100, output: 900 });
    expect(b.stats().tokenBudget!.totalConsumed).toBe(1000);
  });

  it("reportUsage after release performs no accounting", async () => {
    const b = makeBulkhead(5000);
    const r = await b.acquire(req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    r.token.release({ input: 10, output: 10 });
    const before = b.stats().tokenBudget!.inFlightTokens;
    r.token.reportUsage({ input: 500, output: 500 });
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(before);
  });

  it("works without a token budget (snapshot fields null, no accounting, no crash)", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 2,
    });
    const r = await b.acquire(req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const snap = r.token.reportUsage({ input: 10, output: 20 });
    expect(snap.reserved).toBe(0);
    expect(snap.held).toBe(0);
    expect(snap.consumed).toBe(30);
    expect(snap.outputCap).toBeNull();
    expect(snap.outputRemaining).toBeNull();
    expect(snap.overReservation).toBe(false);
    r.token.release();
  });

  it("run() exposes reportUsage via the run context", async () => {
    const b = makeBulkhead(1200);

    await b.run(req("stream"), async (_signal, ctx) => {
      expect(ctx).toBeDefined();
      const snap = ctx!.reportUsage({ input: 20, output: 5 });
      expect(snap.held).toBe(1020);
      // Early refund is observable mid-run.
      expect(b.stats().tokenBudget!.totalRefunded).toBe(80);
      return "done";
    });

    expect(b.stats().tokenBudget!.inFlightTokens).toBe(0);
  });

  it("invariant: inFlightTokens returns to zero across mixed report/release traffic", async () => {
    const b = makeBulkhead(50_000, { maxConcurrent: 20 });
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      jobs.push(
        b
          .run(req(`job-${i}`), async (_s, ctx) => {
            ctx!.reportUsage({ input: 30 + (i % 5), output: i * 3 });
            ctx!.reportUsage({ input: 30 + (i % 5), output: i * 7 });
            return i;
          })
          .catch(() => undefined),
      );
    }
    await Promise.all(jobs);
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(0);
    expect(b.stats().bulkhead.inFlight).toBe(0);
  });
});

describe("priority admission — highPriorityReserve", () => {
  it("rejects normal priority once available <= reserve, admits high priority", async () => {
    // budget 2400, reserve 400 -> normal ceiling 2000 (one 1100 fits, two don't).
    const b = makeBulkhead(2400, { highPriorityReserve: 400 });

    const r1 = await b.acquire(req("a")); // normal: 1100 <= 2000 ✓
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Second normal: 1100 + 1100 = 2200 > 2000 ✗
    const r2 = await b.acquire(req("b"));
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe("budget_limit");

    // Same request at high priority: 2200 <= 2400 ✓
    const r3 = await b.acquire(req("b"), { priority: "high" });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;

    r1.token.release();
    r3.token.release();
  });

  it("priority defaults to normal and rejects invalid values", async () => {
    const b = makeBulkhead(2400, { highPriorityReserve: 400 });
    const r1 = await b.acquire(req("a"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    await expect(
      // @ts-expect-error — invalid priority value
      b.acquire(req("b"), { priority: "urgent" }),
    ).rejects.toThrow(/priority/);
    r1.token.release();
  });

  it("validates highPriorityReserve <= budget at construction", () => {
    expect(() =>
      createLLMBulkhead({
        model: "m",
        maxConcurrent: 1,
        tokenBudget: { budget: 100, highPriorityReserve: 101 },
      }),
    ).toThrow(/highPriorityReserve/);
  });

  it("stats reports the configured reserve", () => {
    const b = makeBulkhead(2400, { highPriorityReserve: 400 });
    expect(b.stats().tokenBudget!.highPriorityReserve).toBe(400);
    const noReserve = makeBulkhead(2400);
    expect(noReserve.stats().tokenBudget!.highPriorityReserve).toBe(0);
  });
});

describe("rejection detail", () => {
  it("budget_limit rejections carry a priority-adjusted capacity snapshot", async () => {
    const b = makeBulkhead(2400, { highPriorityReserve: 400 });
    const r1 = await b.acquire(req("a"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = await b.acquire(req("b"));
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.detail).toBeDefined();
    expect(r2.detail!.tokenBudget).toEqual({
      budget: 2400,
      inFlightTokens: 1100,
      effectiveBudget: 2000,
      available: 900,
      requested: 1100,
    });
    r1.token.release();
  });

  it("concurrency_limit rejections carry slot info; run() throws with detail", async () => {
    const b = createLLMBulkhead({ model: "m", maxConcurrent: 1 });
    const r1 = await b.acquire(req("a"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    let caught: unknown;
    try {
      await b.run(req("b"), async () => "x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LLMBulkheadRejectedError);
    const e = caught as LLMBulkheadRejectedError;
    expect(e.reason).toBe("concurrency_limit");
    expect(e.detail).toBeDefined();
    expect(e.detail!.inFlight).toBe(1);
    expect(e.detail!.maxConcurrent).toBe(1);
    expect(e.detail!.tokenBudget).toBeUndefined(); // no budget configured

    r1.token.release();
  });

  it("reject events include detail", async () => {
    const b = makeBulkhead(1100);
    const seen: unknown[] = [];
    b.on("reject", (p) => seen.push(p.detail));

    const r1 = await b.acquire(req("a"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    await b.acquire(req("b")); // rejected
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ maxConcurrent: 10 });
    r1.token.release();
  });
});

describe("wouldAdmit — advisory routing check", () => {
  it("mirrors admission outcomes without reserving", async () => {
    const b = makeBulkhead(1200);
    expect(b.wouldAdmit(req())).toEqual({ admit: true });

    const r1 = await b.acquire(req("a"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    expect(b.wouldAdmit(req("b"))).toEqual({
      admit: false,
      reason: "budget_limit",
    });
    // wouldAdmit itself must not have reserved anything.
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(1100);

    r1.token.release();
    expect(b.wouldAdmit(req("b"))).toEqual({ admit: true });
  });

  it("reports concurrency_limit, priority-sensitivity, and shutdown", async () => {
    const b = makeBulkhead(5000, {
      maxConcurrent: 1,
      highPriorityReserve: 4000,
    });
    // Normal ceiling is 1000 < 1100 needed -> budget_limit even when idle.
    expect(b.wouldAdmit(req())).toEqual({
      admit: false,
      reason: "budget_limit",
    });
    expect(b.wouldAdmit(req(), { priority: "high" })).toEqual({ admit: true });

    const r1 = await b.acquire(req("a"), { priority: "high" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    // 1100 + 1100 = 2200 <= 5000: budget passes at high priority;
    // the binding constraint is the single slot.
    expect(b.wouldAdmit(req("b"), { priority: "high" })).toEqual({
      admit: false,
      reason: "concurrency_limit",
    });
    r1.token.release();

    b.close();
    expect(b.wouldAdmit(req())).toEqual({ admit: false, reason: "shutdown" });
  });
});

describe("setBudget — runtime budget mutation", () => {
  it("throws when tokenBudget was never configured", () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 5 });
    expect(() => b.setBudget(1000)).toThrow(/tokenBudget/);
  });

  it("validates: rejects negative, non-integer, NaN, and Infinity", () => {
    const b = makeBulkhead(1200);
    expect(() => b.setBudget(-1)).toThrow();
    expect(() => b.setBudget(1.5)).toThrow();
    expect(() => b.setBudget(Number.NaN)).toThrow();
    expect(() => b.setBudget(Number.POSITIVE_INFINITY)).toThrow();
    // Budget must be left untouched by rejected calls.
    expect(b.stats().tokenBudget!.budget).toBe(1200);
  });

  it("accepts zero as a valid budget (fully closed)", () => {
    const b = makeBulkhead(1200);
    b.setBudget(0);
    expect(b.stats().tokenBudget!.budget).toBe(0);
    expect(b.wouldAdmit(req())).toEqual({
      admit: false,
      reason: "budget_limit",
    });
  });

  it("raising the budget takes effect immediately on the next admission", async () => {
    const b = makeBulkhead(1100);

    const r1 = await b.acquire(req("a"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Budget exhausted: next request rejected.
    const r2 = await b.acquire(req("b"));
    expect(r2.ok).toBe(false);

    // Raise the ceiling — no release, no waiting.
    b.setBudget(2200);
    expect(b.stats().tokenBudget!.budget).toBe(2200);

    // Immediately admits without any in-flight work being touched.
    const r3 = await b.acquire(req("c"));
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;

    expect(b.stats().tokenBudget!.inFlightTokens).toBe(2200);

    r1.token.release();
    r3.token.release();
  });

  it("lowering below inFlightTokens is legal — shrink by attrition (pinned semantics)", async () => {
    const b = makeBulkhead(1200);

    // Fill inFlightTokens to 1100.
    const r1 = await b.acquire(req("a"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(1100);

    // Lower the ceiling below current in-flight usage. Must not throw,
    // must not revoke/release the in-flight reservation.
    expect(() => b.setBudget(500)).not.toThrow();
    expect(b.stats().tokenBudget!.budget).toBe(500);
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(1100); // unchanged
    expect(b.stats().bulkhead.inFlight).toBe(1); // in-flight work not revoked

    // New admissions reject until the pool drains below the new ceiling.
    const r2 = await b.acquire(req("b"));
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe("budget_limit");

    // wouldAdmit reflects the same shrunk ceiling.
    expect(b.wouldAdmit(req("c"))).toEqual({
      admit: false,
      reason: "budget_limit",
    });

    // Draining brings inFlightTokens to 0, below the new (still low) ceiling.
    // Since the new ceiling (500) is itself below a single request's cost
    // (1100), admission still correctly rejects — the ceiling was lowered,
    // not the estimator.
    r1.token.release();
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(0);
    const r3 = await b.acquire(req("d"));
    expect(r3.ok).toBe(false);

    // Raising the ceiling again to fit a request demonstrates the pool
    // has genuinely drained and is ready to admit under the new ceiling.
    b.setBudget(1100);
    const r4 = await b.acquire(req("e"));
    expect(r4.ok).toBe(true);
    if (r4.ok) r4.token.release();
  });


  it("propagates through rejection detail (effectiveBudget/available)", async () => {
    const b = makeBulkhead(1100);
    const r1 = await b.acquire(req("a"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const rejected = await b.acquire(req("b"));
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.detail!.tokenBudget).toMatchObject({
      budget: 1100,
      effectiveBudget: 1100,
      inFlightTokens: 1100,
      available: 0,
    });

    b.setBudget(3300);

    const rejected2 = await b.acquire(req("b"));
    // Now admits: no longer rejected, so detail path differs.
    expect(rejected2.ok).toBe(true);
    if (rejected2.ok) {
      expect(b.stats().tokenBudget!.inFlightTokens).toBe(2200);
      rejected2.token.release();
    }
    r1.token.release();
  });

  it("interacts correctly with highPriorityReserve after mutation", async () => {
    const b = makeBulkhead(2400, { highPriorityReserve: 400 });
    // Normal ceiling: 2400 - 400 = 2000. Room for exactly 1 request (1100)
    // plus partial headroom, but not two (2200 > 2000).
    const r1 = await b.acquire(req("a"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = await b.acquire(req("b"));
    expect(r2.ok).toBe(false); // normal ceiling exceeded (2200 > 2000)

    // Raise budget: normal ceiling becomes 4800 - 400 = 4400.
    b.setBudget(4800);
    const r3 = await b.acquire(req("c"));
    expect(r3.ok).toBe(true);
    if (r3.ok) r3.token.release();
    r1.token.release();
  });
});

