import { describe, it, expect } from "vitest";
import {
  createLLMBulkhead,
  createAdaptiveTokenEstimator,
  createModelAwareTokenEstimator,
  type LLMRequest,
} from "../src/index.js";

const req = (text = "x".repeat(400), max_tokens = 20): LLMRequest => ({
  messages: [{ role: "user", content: text }],
  max_tokens,
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ────────────────────────────────────────────
// drain({ timeoutMs })
// ────────────────────────────────────────────

describe("drain({ timeoutMs }) — bounded shutdown wait", () => {
  it("no-arg drain() keeps the v3.7 Promise<void> contract", async () => {
    const b = createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 1 });
    await expect(b.drain()).resolves.toBeUndefined();
  });

  it("resolves { drained: true } when work completes within the deadline", async () => {
    const b = createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 1 });
    const gate = deferred();
    const work = b.run(req(), async () => {
      await gate.promise;
      return "ok";
    });
    const drainP = b.drain({ timeoutMs: 5_000 });
    gate.resolve();
    await work;
    await expect(drainP).resolves.toEqual({
      drained: true,
      inFlight: 0,
      pending: 0,
    });
  });

  it("resolves { drained: false } with outstanding counts on deadline", async () => {
    const b = createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 1 });
    const gate = deferred();
    const work = b.run(req(), async () => {
      await gate.promise;
      return "ok";
    });

    const result = await b.drain({ timeoutMs: 20 });
    expect(result).toEqual({ drained: false, inFlight: 1, pending: 0 });

    // The deadline did not cancel or corrupt anything: the work still
    // completes and a subsequent unbounded drain resolves.
    gate.resolve();
    await work;
    await b.drain();
    expect(b.stats().bulkhead.inFlight).toBe(0);
  });

  it("timeoutMs: 0 on an idle bulkhead reports drained (microtask wins)", async () => {
    const b = createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 1 });
    await expect(b.drain({ timeoutMs: 0 })).resolves.toEqual({
      drained: true,
      inFlight: 0,
      pending: 0,
    });
  });

  it("rejects invalid timeoutMs values synchronously", () => {
    const b = createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 1 });
    expect(() => b.drain({ timeoutMs: -1 })).toThrow(/timeoutMs/);
    expect(() => b.drain({ timeoutMs: 1.5 })).toThrow(/timeoutMs/);
  });

  it("composes with close() for a bounded graceful shutdown", async () => {
    const b = createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 1 });
    const gate = deferred();
    const work = b.run(req(), async () => {
      await gate.promise;
      return "ok";
    });
    b.close();
    const first = await b.drain({ timeoutMs: 20 });
    expect(first.drained).toBe(false);
    expect(first.inFlight).toBe(1);
    gate.resolve();
    await work;
    await expect(b.drain({ timeoutMs: 1_000 })).resolves.toEqual({
      drained: true,
      inFlight: 0,
      pending: 0,
    });
  });
});

// ────────────────────────────────────────────
// reservation override: estimate() round-trip + reserved consistency
// ────────────────────────────────────────────

describe("reservation override — estimate() round-trip (v3.8)", () => {
  const makeBudgeted = () =>
    createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 4,
      tokenBudget: { budget: 10_000 },
    });

  it("accepts the frozen estimate() result verbatim as the override", async () => {
    const b = makeBudgeted();
    const request = req();
    const preview = b.estimate(request);
    expect(preview).not.toBeNull();

    const r = await b.acquire(request, { reservation: preview! });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reservation).toEqual(preview);
      expect(b.stats().tokenBudget?.inFlightTokens).toBe(preview!.reserved);
      r.token.release();
    }
  });

  it("wouldAdmit() also accepts the estimate() result", () => {
    const b = makeBudgeted();
    const request = req();
    const preview = b.estimate(request)!;
    expect(b.wouldAdmit(request, { reservation: preview })).toEqual({
      admit: true,
    });
  });

  it("throws on an inconsistent hand-built reserved field", async () => {
    const b = makeBudgeted();
    await expect(
      b.acquire(req(), {
        reservation: { input: 100, maxOutput: 20, reserved: 999 },
      }),
    ).rejects.toThrow(/reservation\.reserved \(999\) must equal/);
    // Nothing was reserved by the failed call.
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(0);
  });

  it("still accepts a plain { input, maxOutput } override (v3.7 shape)", async () => {
    const b = makeBudgeted();
    const r = await b.acquire(req(), {
      reservation: { input: 100, maxOutput: 20 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reservation?.reserved).toBe(120);
      r.token.release();
    }
  });
});

// ────────────────────────────────────────────
// wouldAdmit({ detail: true })
// ────────────────────────────────────────────

describe("wouldAdmit — opt-in capacity detail (v3.8)", () => {
  it("omits detail by default (v3.7 result shape unchanged)", () => {
    const b = createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 1 });
    expect(b.wouldAdmit(req())).toEqual({ admit: true });
  });

  it("includes a capacity snapshot on admit: true", () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 3,
      tokenBudget: { budget: 1_000 },
    });
    const request = req("x".repeat(40), 20);
    const preview = b.estimate(request)!;
    const result = b.wouldAdmit(request, { detail: true });
    expect(result.admit).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.detail).toEqual({
      inFlight: 0,
      pending: 0,
      maxConcurrent: 3,
      maxQueue: 0,
      tokenBudget: {
        budget: 1_000,
        inFlightTokens: 0,
        effectiveBudget: 1_000,
        available: 1_000,
        requested: preview.reserved,
      },
    });
  });

  it("includes detail on budget_limit with the requested reservation", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 4,
      tokenBudget: { budget: 100 },
    });
    const request = req("x".repeat(40), 80);
    const reserved = b.estimate(request)!.reserved; // ceil(40/3.7)+80 = 91
    const r = await b.acquire(request);
    expect(r.ok).toBe(true);
    const result = b.wouldAdmit(request, { detail: true });
    expect(result.admit).toBe(false);
    expect(result.reason).toBe("budget_limit");
    expect(result.detail?.tokenBudget?.inFlightTokens).toBe(reserved);
    expect(result.detail?.tokenBudget?.available).toBe(100 - reserved);
    expect(result.detail?.tokenBudget?.requested).toBe(reserved);
    if (r.ok) r.token.release();
  });

  it("includes detail on concurrency_limit and shutdown", async () => {
    const b = createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 1 });
    const r = await b.acquire(req());
    expect(r.ok).toBe(true);

    const full = b.wouldAdmit(req(), { detail: true });
    expect(full).toMatchObject({
      admit: false,
      reason: "concurrency_limit",
    });
    expect(full.detail).toMatchObject({ inFlight: 1, maxConcurrent: 1 });

    if (r.ok) r.token.release();
    b.close();
    const closed = b.wouldAdmit(req(), { detail: true });
    expect(closed).toMatchObject({ admit: false, reason: "shutdown" });
    expect(closed.detail).toMatchObject({ inFlight: 0, maxConcurrent: 1 });
  });

  it("validates the request before the shutdown check (matches acquire())", () => {
    const b = createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 1 });
    b.close();
    expect(() =>
      b.wouldAdmit({ messages: [], max_tokens: -1 }),
    ).toThrow(/max_tokens/);
  });
});

// ────────────────────────────────────────────
// createAdaptiveTokenEstimator
// ────────────────────────────────────────────

describe("createAdaptiveTokenEstimator (v3.8)", () => {
  const request = (chars: number, model?: string): LLMRequest => ({
    ...(model !== undefined ? { model } : {}),
    messages: [{ role: "user", content: "x".repeat(chars) }],
    max_tokens: 50,
  });

  it("matches the base model-aware estimate before minSamples", () => {
    const adaptive = createAdaptiveTokenEstimator({
      defaultModel: "gpt-4o",
      minSamples: 3,
    });
    const base = createModelAwareTokenEstimator({ defaultModel: "gpt-4o" });
    const r = request(370);
    expect(adaptive.estimator(r)).toEqual(base(r));

    // Two observations < minSamples: still uncorrected.
    adaptive.observe(r, { input: 200, output: 10 });
    adaptive.observe(r, { input: 200, output: 10 });
    expect(adaptive.estimator(r)).toEqual(base(r));
    expect(adaptive.corrections()[0]?.applied).toBe(1);
  });

  it("corrects a systematic underestimate after minSamples", () => {
    const adaptive = createAdaptiveTokenEstimator({
      defaultModel: "gpt-4o",
      minSamples: 3,
      smoothing: 1, // deterministic: factor == last observation
    });
    const r = request(370); // base input: ceil(370/3.7) = 100
    const baseInput = createModelAwareTokenEstimator({
      defaultModel: "gpt-4o",
    })(r).input;
    expect(baseInput).toBe(100);

    for (let i = 0; i < 3; i++) {
      adaptive.observe(r, { input: 150, output: 10 }); // actual = 1.5x
    }
    const corrected = adaptive.estimator(r);
    expect(corrected.input).toBe(150); // ceil(100 * 1.5)
    expect(corrected.maxOutput).toBe(50); // output never corrected

    const [c] = adaptive.corrections();
    expect(c).toEqual({
      model: "gpt-4o",
      samples: 3,
      factor: 1.5,
      applied: 1.5,
    });
  });

  it("clamps the applied factor to [minCorrection, maxCorrection]", () => {
    const adaptive = createAdaptiveTokenEstimator({
      defaultModel: "gpt-4o",
      minSamples: 1,
      smoothing: 1,
      minCorrection: 0.8,
      maxCorrection: 1.5,
    });
    const r = request(370); // base input 100
    adaptive.observe(r, { input: 1_000, output: 0 }); // observed 10x
    expect(adaptive.estimator(r).input).toBe(150); // clamped to 1.5x
    expect(adaptive.corrections()[0]).toMatchObject({
      factor: 10,
      applied: 1.5,
    });

    adaptive.reset();
    adaptive.observe(r, { input: 1, output: 0 }); // observed 0.01x
    expect(adaptive.estimator(r).input).toBe(80); // clamped to 0.8x
  });

  it("observes against the uncorrected base so feedback does not compound", () => {
    const adaptive = createAdaptiveTokenEstimator({
      defaultModel: "gpt-4o",
      minSamples: 1,
      smoothing: 1,
    });
    const r = request(370); // base input 100
    adaptive.observe(r, { input: 150, output: 0 });
    expect(adaptive.estimator(r).input).toBe(150);
    // Same true usage again: ratio is still 150/100, not 150/150.
    adaptive.observe(r, { input: 150, output: 0 });
    expect(adaptive.corrections()[0]?.factor).toBe(1.5);
    expect(adaptive.estimator(r).input).toBe(150); // stable fixed point
  });

  it("keeps per-model calibration independent and case-insensitive", () => {
    const adaptive = createAdaptiveTokenEstimator({
      defaultModel: "gpt-4o",
      minSamples: 1,
      smoothing: 1,
    });
    adaptive.observe(request(370, "gpt-4o"), { input: 200, output: 0 });
    adaptive.observe(request(380, "claude-sonnet-4-5"), {
      input: 50,
      output: 0,
    });

    // gpt-4o corrected up; case variant hits the same entry.
    expect(adaptive.estimator(request(370, "GPT-4o")).input).toBe(200);
    // claude corrected down independently: base ceil(380/3.9)=98 → *≈0.51.
    const claude = adaptive.estimator(request(380, "claude-sonnet-4-5"));
    expect(claude.input).toBeLessThan(98);
    expect(adaptive.corrections().map((c) => c.model).sort()).toEqual([
      "claude-sonnet-4-5",
      "gpt-4o",
    ]);
  });

  it("ignores observations with a zero base estimate", () => {
    const adaptive = createAdaptiveTokenEstimator({
      defaultModel: "gpt-4o",
      minSamples: 1,
    });
    adaptive.observe(
      { messages: [{ role: "user", content: "" }], max_tokens: 10 },
      { input: 500, output: 5 },
    );
    expect(adaptive.corrections()).toEqual([]);
  });

  it("evicts the oldest model at maxModels", () => {
    const adaptive = createAdaptiveTokenEstimator({
      defaultModel: "gpt-4o",
      minSamples: 1,
      maxModels: 2,
    });
    adaptive.observe(request(370, "model-a"), { input: 10, output: 0 });
    adaptive.observe(request(370, "model-b"), { input: 10, output: 0 });
    adaptive.observe(request(370, "model-c"), { input: 10, output: 0 });
    expect(adaptive.corrections().map((c) => c.model)).toEqual([
      "model-b",
      "model-c",
    ]);
  });

  it("reset(model) clears one model; reset() clears all", () => {
    const adaptive = createAdaptiveTokenEstimator({
      defaultModel: "gpt-4o",
      minSamples: 1,
    });
    adaptive.observe(request(370, "model-a"), { input: 10, output: 0 });
    adaptive.observe(request(370, "model-b"), { input: 10, output: 0 });
    adaptive.reset("MODEL-A");
    expect(adaptive.corrections().map((c) => c.model)).toEqual(["model-b"]);
    adaptive.reset();
    expect(adaptive.corrections()).toEqual([]);
  });

  it("validates construction options and observed usage", () => {
    expect(() => createAdaptiveTokenEstimator({ smoothing: 0 })).toThrow(
      /smoothing/,
    );
    expect(() => createAdaptiveTokenEstimator({ smoothing: 1.1 })).toThrow(
      /smoothing/,
    );
    expect(() => createAdaptiveTokenEstimator({ minSamples: 0 })).toThrow(
      /minSamples/,
    );
    expect(() =>
      createAdaptiveTokenEstimator({ minCorrection: 0 }),
    ).toThrow(/minCorrection/);
    expect(() =>
      createAdaptiveTokenEstimator({ minCorrection: 2, maxCorrection: 1 }),
    ).toThrow(/maxCorrection/);
    expect(() => createAdaptiveTokenEstimator({ maxModels: 0 })).toThrow(
      /maxModels/,
    );

    const adaptive = createAdaptiveTokenEstimator({ defaultModel: "gpt-4o" });
    expect(() =>
      adaptive.observe(request(370), { input: -1, output: 0 }),
    ).toThrow(/token usage/);
  });

  it("works end-to-end as a bulkhead tokenBudget estimator via release events", async () => {
    const adaptive = createAdaptiveTokenEstimator({
      defaultModel: "gpt-4o",
      minSamples: 2,
      smoothing: 1,
    });
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 2,
      tokenBudget: { budget: 100_000, estimator: adaptive.estimator },
    });
    b.on("release", (e) => {
      if (e.usage) adaptive.observe(e.request, e.usage);
    });

    const r = request(370); // base input 100
    const before = b.estimate(r)!;
    expect(before.input).toBe(100);

    // Two calls whose real input is double the estimate.
    for (let i = 0; i < 2; i++) {
      await b.run(r, async () => ({ usage: { input: 200, output: 5 } }), {
        getUsage: (res) => res.usage,
      });
    }

    const after = b.estimate(r)!;
    expect(after.input).toBe(200);
    expect(after.reserved).toBe(250); // 200 input + 50 max_tokens
  });
});
