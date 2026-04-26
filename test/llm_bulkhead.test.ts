import { describe, it, expect, vi } from "vitest";
import {
  createLLMBulkhead,
  naiveTokenEstimator,
  createModelAwareTokenEstimator,
  extractTextLength,
  LLMBulkheadRejectedError,
  PROFILES,
  type ContentBlock,
  type LLMRequest,
  type TokenUsage,
  type LLMEventMap,
} from "../src/index";
import type { AcquireOptions } from "async-bulkhead-ts";


type TestAbortController = {
  signal: NonNullable<AcquireOptions["signal"]>;
  abort(reason?: unknown): void;
};

function makeAbortController(): TestAbortController {
  const AbortControllerCtor = (
    globalThis as typeof globalThis & {
      AbortController: new () => TestAbortController;
    }
  ).AbortController;
  return new AbortControllerCtor();
}

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function randInt(maxExclusive: number) {
  return Math.floor(Math.random() * maxExclusive);
}

async function isSettled(p: Promise<unknown>, withinMs = 5) {
  let settled = false;
  p.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await sleep(withinMs);
  return settled;
}

function makeRequest(
  content: string | ContentBlock[] = "hello world",
  max_tokens?: number,
  model?: string,
): LLMRequest {
  const messages =
    typeof content === "string"
      ? [{ role: "user", content }]
      : [{ role: "user", content }];
  const request: LLMRequest = { messages };
  if (max_tokens !== undefined) request.max_tokens = max_tokens;
  if (model !== undefined) request.model = model;
  return request;
}

function makeMultimodalRequest(
  textContent: string,
  max_tokens?: number,
): LLMRequest {
  return makeRequest(
    [
      { type: "text", text: textContent },
      { type: "image", source: { type: "base64", data: "abc123==" } },
    ],
    max_tokens,
  );
}

function isLLMBulkheadRejection(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as Record<string, unknown>;
  if (err.code === "LLM_BULKHEAD_REJECTED") return true;
  if (err.name === "LLMBulkheadRejectedError") return true;
  return (
    typeof err.reason === "string" &&
    [
      "concurrency_limit",
      "queue_limit",
      "timeout",
      "aborted",
      "budget_limit",
      "shutdown",
    ].includes(err.reason)
  );
}

async function swallowBulkheadRejection(p: Promise<void>): Promise<void> {
  try {
    await p;
  } catch (e) {
    if (isLLMBulkheadRejection(e)) return;
    throw e;
  }
}

// ── extractTextLength ────────────────────────────────────────

describe("extractTextLength", () => {
  it("returns length for a plain string", () => {
    expect(extractTextLength("hello")).toBe(5);
  });

  it("sums text blocks in a content array", () => {
    expect(
      extractTextLength([
        { type: "text", text: "hello" },
        { type: "text", text: " world" },
      ]),
    ).toBe(11);
  });

  it("ignores non-text blocks", () => {
    expect(
      extractTextLength([
        { type: "text", text: "hello" },
        { type: "image", source: { type: "base64", data: "abc" } },
      ]),
    ).toBe(5);
  });

  it("returns 0 for empty array", () => {
    expect(extractTextLength([])).toBe(0);
  });

  it("returns 0 for array with only non-text blocks", () => {
    expect(
      extractTextLength([
        { type: "image", source: { type: "base64", data: "abc" } },
      ]),
    ).toBe(0);
  });
});

// ── naiveTokenEstimator ──────────────────────────────────────

describe("naiveTokenEstimator", () => {
  it("estimates input as ceil(chars / 4)", () => {
    const r = makeRequest("x".repeat(400));
    const est = naiveTokenEstimator(r);
    expect(est.input).toBe(100);
  });

  it("uses max_tokens as maxOutput when present", () => {
    const r = makeRequest("hi", 1024);
    expect(naiveTokenEstimator(r).maxOutput).toBe(1024);
  });

  it("defaults maxOutput to 2048 when max_tokens is absent", () => {
    const r = makeRequest("hi");
    expect(naiveTokenEstimator(r).maxOutput).toBe(2_048);
  });

  it("sums content across multiple messages", () => {
    const r: LLMRequest = {
      messages: [
        { role: "user", content: "x".repeat(200) },
        { role: "assistant", content: "x".repeat(200) },
      ],
    };
    expect(naiveTokenEstimator(r).input).toBe(100);
  });

  it("handles empty messages array", () => {
    const r: LLMRequest = { messages: [] };
    const est = naiveTokenEstimator(r);
    expect(est.input).toBe(0);
    expect(est.maxOutput).toBe(2_048);
  });

  it("ceils fractional token counts", () => {
    const r = makeRequest("x".repeat(401));
    expect(naiveTokenEstimator(r).input).toBe(101);
  });

  it("handles multimodal content (text blocks only)", () => {
    const r = makeMultimodalRequest("x".repeat(400));
    const est = naiveTokenEstimator(r);
    expect(est.input).toBe(100); // image block ignored
  });
});

// ── createModelAwareTokenEstimator ───────────────────────────

describe("createModelAwareTokenEstimator", () => {
  it("uses a known built-in ratio for a recognised model prefix", () => {
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "claude-sonnet-4-20260101" },
    );
    const result = est(makeRequest("x".repeat(390), 512));
    expect(result.input).toBe(100); // 390 / 3.9 = 100
  });

  it("longest prefix wins when multiple prefixes match", () => {
    const est = createModelAwareTokenEstimator(
      { "claude-3": 3.0 },
      { defaultModel: "claude-3-5-haiku-20250101" },
    );
    expect(est(makeRequest("x".repeat(380))).input).toBe(100); // 380 / 3.8
  });

  it("exact override beats prefix match", () => {
    const est = createModelAwareTokenEstimator(
      { "claude-sonnet-4-custom": 2.0 },
      { defaultModel: "claude-sonnet-4-custom" },
    );
    expect(est(makeRequest("x".repeat(200))).input).toBe(100); // 200 / 2.0
  });

  it("exact override is case-insensitive (lowercased fallback)", () => {
    const est = createModelAwareTokenEstimator(
      { "my-model": 2.0 },
      { defaultModel: "MY-MODEL" },
    );
    expect(est(makeRequest("x".repeat(200))).input).toBe(100);
  });

  it("prefix scan is case-insensitive", () => {
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "CLAUDE-SONNET-4-20260101" },
    );
    expect(est(makeRequest("x".repeat(390))).input).toBe(100);
  });

  it("falls back to 4.0 ratio for unknown model", () => {
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "unknown-model-xyz" },
    );
    expect(est(makeRequest("x".repeat(400))).input).toBe(100);
  });

  it("fires onUnknownModel for unknown model", () => {
    const onUnknownModel = vi.fn();
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "totally-unknown", onUnknownModel },
    );
    est(makeRequest("hi"));
    expect(onUnknownModel).toHaveBeenCalledOnce();
    expect(onUnknownModel).toHaveBeenCalledWith("totally-unknown");
  });

  it("does not fire onUnknownModel for known model", () => {
    const onUnknownModel = vi.fn();
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "claude-sonnet-4", onUnknownModel },
    );
    est(makeRequest("hi"));
    expect(onUnknownModel).not.toHaveBeenCalled();
  });

  it("respects custom outputCap", () => {
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "claude-sonnet-4", outputCap: 512 },
    );
    expect(est(makeRequest("hi")).maxOutput).toBe(512);
  });

  it("request max_tokens overrides outputCap", () => {
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "claude-sonnet-4", outputCap: 512 },
    );
    expect(est(makeRequest("hi", 1024)).maxOutput).toBe(1_024);
  });

  // ── v2: per-request model ──

  it("uses request.model over defaultModel when present", () => {
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "unknown-model" }, // would fall back to 4.0
    );
    // request.model = claude-sonnet-4, ratio 3.9
    const r = makeRequest("x".repeat(390), 512, "claude-sonnet-4");
    expect(est(r).input).toBe(100); // 390 / 3.9
  });

  it("falls back to defaultModel when request.model is absent", () => {
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "claude-sonnet-4" },
    );
    const r = makeRequest("x".repeat(390), 512); // no model on request
    expect(est(r).input).toBe(100);
  });

  // ── v2: multimodal ──

  it("handles multimodal content blocks", () => {
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "claude-sonnet-4" },
    );
    const r = makeMultimodalRequest("x".repeat(390), 512);
    expect(est(r).input).toBe(100); // image block ignored, 390 / 3.9
  });

  // ── v2: new model families ──

  it("recognises claude-haiku-4-5 prefix", () => {
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "claude-haiku-4-5-20260301" },
    );
    expect(est(makeRequest("x".repeat(380))).input).toBe(100); // 380 / 3.8
  });

  it("recognises gpt-4.1 prefix", () => {
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "gpt-4.1-mini" },
    );
    expect(est(makeRequest("x".repeat(370))).input).toBe(100); // 370 / 3.7
  });

  it("recognises gemini-2.5 prefix", () => {
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "gemini-2.5-pro" },
    );
    expect(est(makeRequest("x".repeat(380))).input).toBe(100); // 380 / 3.8
  });
});

// ── PROFILES ─────────────────────────────────────────────────

describe("PROFILES", () => {
  it("interactive profile has maxQueue 0", () => {
    expect(PROFILES.interactive.maxQueue).toBe(0);
  });

  it("batch profile has maxQueue 20 and timeoutMs 30000", () => {
    expect(PROFILES.batch.maxQueue).toBe(20);
    expect(PROFILES.batch.timeoutMs).toBe(30_000);
  });
});

// ── createLLMBulkhead — validation ───────────────────────────

describe("createLLMBulkhead validation", () => {
  it("throws if model is empty", () => {
    expect(() => createLLMBulkhead({ model: "", maxConcurrent: 1 })).toThrow(
      "model",
    );
  });

  it("throws if maxConcurrent is not a positive integer", () => {
    expect(() =>
      createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 0 }),
    ).toThrow("maxConcurrent");
    expect(() =>
      createLLMBulkhead({ model: "gpt-4o", maxConcurrent: -1 }),
    ).toThrow("maxConcurrent");
    expect(() =>
      createLLMBulkhead({ model: "gpt-4o", maxConcurrent: 1.5 }),
    ).toThrow("maxConcurrent");
  });
});

// ── Profile / preset resolution ──────────────────────────────

describe("profile / preset resolution", () => {
  it("no profile => fail-fast default (maxQueue: 0)", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 1 });

    const rP = b.run(makeRequest(), async () => {
      await sleep(50);
      return "a";
    });
    const r2 = await b.acquire(makeRequest());
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("concurrency_limit");
    await rP;
  });

  it("profile: 'batch' enables a queue", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      profile: "batch",
    });

    const rP = b.run(makeRequest(), async () => {
      await sleep(50);
      return "a";
    });
    const r2P = b.acquire(makeRequest());
    expect(await isSettled(r2P, 5)).toBe(false);

    await rP;
    const r2 = await r2P;
    expect(r2.ok).toBe(true);
    if (r2.ok) r2.token.release();
  });

  it("explicit maxQueue overrides profile default", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      profile: "batch",
      maxQueue: 0,
    });

    const rP = b.run(makeRequest(), async () => {
      await sleep(50);
      return "a";
    });
    const r2 = await b.acquire(makeRequest());
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("concurrency_limit");
    await rP;
  });

  it("profile as plain object (escape hatch) is respected", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      profile: { maxQueue: 2 },
    });

    const rP = b.run(makeRequest(), async () => {
      await sleep(50);
      return "a";
    });
    const r2P = b.acquire(makeRequest());
    expect(await isSettled(r2P, 5)).toBe(false);

    await rP;
    const r2 = await r2P;
    expect(r2.ok).toBe(true);
    if (r2.ok) r2.token.release();
  });
});

// ── Token budget ─────────────────────────────────────────────

describe("token budget", () => {
  it("admits when tokens are available", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: { budget: 10_000 },
    });

    const r = await b.acquire(makeRequest("x".repeat(40), 100));
    expect(r.ok).toBe(true);
    if (r.ok) r.token.release();
  });

  it("rejects with budget_limit when token ceiling is exceeded", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 10,
      tokenBudget: {
        budget: 200,
        estimator: () => ({ input: 150, maxOutput: 100 }),
      },
    });

    const r = await b.acquire(makeRequest());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("budget_limit");
  });

  it("budget_limit is fail-fast even with queue headroom", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      profile: "batch",
      tokenBudget: {
        budget: 50,
        estimator: () => ({ input: 30, maxOutput: 30 }),
      },
    });

    const r = await b.acquire(makeRequest());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("budget_limit");
    expect(b.stats().bulkhead.pending).toBe(0);
  });

  it("token reservation is released when request completes via run()", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 200,
        estimator: () => ({ input: 50, maxOutput: 50 }),
      },
    });

    await b.run(makeRequest(), async () => "done");
    const s = b.stats();
    expect(s.tokenBudget?.inFlightTokens).toBe(0);
    expect(s.tokenBudget?.available).toBe(200);
  });

  it("token reservation is released when run() fn throws", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 200,
        estimator: () => ({ input: 50, maxOutput: 50 }),
      },
    });

    await expect(
      b.run(makeRequest(), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const s = b.stats();
    expect(s.tokenBudget?.inFlightTokens).toBe(0);
    expect(s.tokenBudget?.available).toBe(200);
  });

  it("multiple in-flight requests accumulate token reservations", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 1_000,
        estimator: () => ({ input: 50, maxOutput: 50 }),
      },
    });

    const r1 = await b.acquire(makeRequest());
    const r2 = await b.acquire(makeRequest());
    const r3 = await b.acquire(makeRequest());

    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(300);

    if (r1.ok) r1.token.release();
    if (r2.ok) r2.token.release();
    if (r3.ok) r3.token.release();

    expect(b.stats().tokenBudget?.inFlightTokens).toBe(0);
  });

  it("stats.tokenBudget is absent when tokenBudget is not configured", () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 5 });
    expect(b.stats().tokenBudget).toBeUndefined();
  });

  it("budget_limit rejection does not leak token reservation", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 100,
        estimator: () => ({ input: 60, maxOutput: 60 }),
      },
    });

    for (let i = 0; i < 5; i++) {
      const r = await b.acquire(makeRequest());
      expect(r.ok).toBe(false);
    }
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(0);
  });

  it("uses custom estimator when provided in tokenBudget", async () => {
    const customEstimator = vi
      .fn()
      .mockReturnValue({ input: 10, maxOutput: 10 });

    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: { budget: 1_000, estimator: customEstimator },
    });

    const r = await b.acquire(makeRequest());
    expect(customEstimator).toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (r.ok) r.token.release();
  });
});

// ── Token budget refund (v2) ─────────────────────────────────

describe("token budget refund", () => {
  it("release(usage) refunds unused tokens to the budget", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 1_000,
        estimator: () => ({ input: 100, maxOutput: 400 }), // reserves 500
      },
    });

    const r = await b.acquire(makeRequest());
    expect(r.ok).toBe(true);
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(500);

    // Actual usage was 100 input + 50 output = 150 (350 refunded)
    if (r.ok) r.token.release({ input: 100, output: 50 });

    const s = b.stats();
    expect(s.tokenBudget?.inFlightTokens).toBe(0);
    expect(s.tokenBudget?.totalRefunded).toBe(350);
  });

  it("release() without usage performs no refund (backward compat)", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 1_000,
        estimator: () => ({ input: 100, maxOutput: 400 }),
      },
    });

    const r = await b.acquire(makeRequest());
    if (r.ok) r.token.release(); // no usage

    expect(b.stats().tokenBudget?.totalRefunded).toBe(0);
  });

  it("does not refund when actual usage exceeds reservation", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 1_000,
        estimator: () => ({ input: 50, maxOutput: 50 }), // reserves 100
      },
    });

    const r = await b.acquire(makeRequest());
    if (r.ok) r.token.release({ input: 80, output: 80 }); // 160 > 100

    const s = b.stats();
    expect(s.tokenBudget?.totalRefunded).toBe(0);
    expect(s.tokenBudget?.inFlightTokens).toBe(0);
  });

  it("run() with getUsage applies refund on success", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 1_000,
        estimator: () => ({ input: 100, maxOutput: 400 }),
      },
    });

    const result = await b.run(
      makeRequest(),
      async () => ({ text: "hello", usage: { input: 80, output: 40 } }),
      { getUsage: (r) => r.usage },
    );

    expect(result.text).toBe("hello");
    const s = b.stats();
    expect(s.tokenBudget?.inFlightTokens).toBe(0);
    expect(s.tokenBudget?.totalRefunded).toBe(380); // 500 - 120
  });

  it("run() without getUsage performs no refund", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 1_000,
        estimator: () => ({ input: 100, maxOutput: 400 }),
      },
    });

    await b.run(makeRequest(), async () => "result");
    expect(b.stats().tokenBudget?.totalRefunded).toBe(0);
  });

  it("run() does not call getUsage on fn error", async () => {
    const getUsage = vi.fn();
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 1_000,
        estimator: () => ({ input: 50, maxOutput: 50 }),
      },
    });

    await expect(
      b.run(
        makeRequest(),
        async () => { throw new Error("boom"); },
        { getUsage },
      ),
    ).rejects.toThrow("boom");

    expect(getUsage).not.toHaveBeenCalled();
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(0);
  });

  it("bad getUsage does not break release", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 1_000,
        estimator: () => ({ input: 50, maxOutput: 50 }),
      },
    });

    await b.run(
      makeRequest(),
      async () => "result",
      {
        getUsage: () => {
          throw new Error("bad extractor");
        },
      },
    );

    expect(b.stats().tokenBudget?.inFlightTokens).toBe(0);
    expect(b.stats().tokenBudget?.totalRefunded).toBe(0);
  });

  it("cumulative refund tracks across multiple requests", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 10_000,
        estimator: () => ({ input: 100, maxOutput: 400 }), // 500 each
      },
    });

    for (let i = 0; i < 3; i++) {
      const r = await b.acquire(makeRequest());
      if (r.ok) r.token.release({ input: 80, output: 20 }); // actual 100, refund 400
    }

    expect(b.stats().tokenBudget?.totalRefunded).toBe(1_200);
  });
});

// ── Token budget cumulative counters (v3.1) ──────────────────

describe("token budget cumulative counters", () => {
  it("totalReserved increments on each successful admission", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 10_000,
        estimator: () => ({ input: 100, maxOutput: 400 }), // 500 each
      },
    });

    expect(b.stats().tokenBudget?.totalReserved).toBe(0);

    const r1 = await b.acquire(makeRequest());
    expect(b.stats().tokenBudget?.totalReserved).toBe(500);

    const r2 = await b.acquire(makeRequest());
    expect(b.stats().tokenBudget?.totalReserved).toBe(1_000);

    if (r1.ok) r1.token.release();
    if (r2.ok) r2.token.release();

    // totalReserved is monotonic — release does not decrement it.
    expect(b.stats().tokenBudget?.totalReserved).toBe(1_000);
  });

  it("totalReserved does not increment on rejected admissions", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 600,
        estimator: () => ({ input: 100, maxOutput: 400 }), // 500 each
      },
    });

    const r1 = await b.acquire(makeRequest());
    expect(r1.ok).toBe(true);
    expect(b.stats().tokenBudget?.totalReserved).toBe(500);

    // Second admission would exceed budget (500 + 500 > 600) — rejected.
    const r2 = await b.acquire(makeRequest());
    expect(r2.ok).toBe(false);
    expect(b.stats().tokenBudget?.totalReserved).toBe(500);
  });

  it("totalConsumed increments by usage.input + usage.output when usage is reported", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 10_000,
        estimator: () => ({ input: 100, maxOutput: 400 }), // 500 reserved
      },
    });

    const r = await b.acquire(makeRequest());
    expect(r.ok).toBe(true);
    if (r.ok) r.token.release({ input: 80, output: 20 });

    expect(b.stats().tokenBudget?.totalConsumed).toBe(100);
  });

  it("totalConsumed stays at 0 when release() is called without usage", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 10_000,
        estimator: () => ({ input: 100, maxOutput: 400 }),
      },
    });

    const r = await b.acquire(makeRequest());
    if (r.ok) r.token.release(); // no usage

    expect(b.stats().tokenBudget?.totalConsumed).toBe(0);
  });

  it("totalConsumed reports actual usage even when it exceeds reserved (no clamping)", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 10_000,
        estimator: () => ({ input: 100, maxOutput: 400 }), // 500 reserved
      },
    });

    const r = await b.acquire(makeRequest());
    if (r.ok) r.token.release({ input: 300, output: 400 }); // actual 700 > reserved 500

    expect(b.stats().tokenBudget?.totalConsumed).toBe(700);
    // Refund stays at 0 since actual > reserved.
    expect(b.stats().tokenBudget?.totalRefunded).toBe(0);
  });

  it("totalReserved == totalConsumed + totalRefunded when getUsage is wired and no over-consumption", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 10_000,
        estimator: () => ({ input: 100, maxOutput: 400 }), // 500 reserved per call
      },
    });

    // Three releases, each with usage strictly less than reserved.
    for (let i = 0; i < 3; i++) {
      const r = await b.acquire(makeRequest());
      if (r.ok) r.token.release({ input: 80, output: 20 }); // actual 100, refund 400
    }

    const tb = b.stats().tokenBudget!;
    expect(tb.totalReserved).toBe(1_500);
    expect(tb.totalConsumed).toBe(300);
    expect(tb.totalRefunded).toBe(1_200);
    expect(tb.totalReserved).toBe(tb.totalConsumed + tb.totalRefunded);
  });

  it("run() with getUsage drives both totalConsumed and totalRefunded", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 10_000,
        estimator: () => ({ input: 100, maxOutput: 400 }),
      },
    });

    await b.run(
      makeRequest(),
      async () => ({ usage: { input: 50, output: 50 } as TokenUsage }),
      { getUsage: (r) => r.usage },
    );

    const tb = b.stats().tokenBudget!;
    expect(tb.totalReserved).toBe(500);
    expect(tb.totalConsumed).toBe(100);
    expect(tb.totalRefunded).toBe(400);
  });

  it("counters are absent when tokenBudget is not configured", () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 5 });
    expect(b.stats().tokenBudget).toBeUndefined();
  });
});

// ── Concurrency ──────────────────────────────────────────────

describe("concurrency limits", () => {
  it("admits up to maxConcurrent simultaneously", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 3 });

    const r1 = await b.acquire(makeRequest());
    const r2 = await b.acquire(makeRequest());
    const r3 = await b.acquire(makeRequest());
    const r4 = await b.acquire(makeRequest());

    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.reason).toBe("concurrency_limit");

    if (r1.ok) r1.token.release();
    if (r2.ok) r2.token.release();
    if (r3.ok) r3.token.release();
  });

  it("restores capacity after release", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 1 });

    const r1 = await b.acquire(makeRequest());
    expect(r1.ok).toBe(true);
    if (r1.ok) r1.token.release();

    const r2 = await b.acquire(makeRequest());
    expect(r2.ok).toBe(true);
    if (r2.ok) r2.token.release();
  });

  it("stats reflects inFlight accurately", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 3 });

    const r1 = await b.acquire(makeRequest());
    const r2 = await b.acquire(makeRequest());

    expect(b.stats().bulkhead.inFlight).toBe(2);
    if (r1.ok) r1.token.release();
    if (r2.ok) r2.token.release();
    expect(b.stats().bulkhead.inFlight).toBe(0);
  });
});

// ── Queue / waiting ──────────────────────────────────────────

describe("queue and waiting", () => {
  it("queues a request when batch profile is active", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      profile: "batch",
    });

    const r1 = await b.acquire(makeRequest());
    expect(r1.ok).toBe(true);

    const r2P = b.acquire(makeRequest());
    expect(await isSettled(r2P, 5)).toBe(false);

    if (r1.ok) r1.token.release();
    const r2 = await r2P;
    expect(r2.ok).toBe(true);
    if (r2.ok) r2.token.release();
  });

  it("rejects with queue_limit when queue is full", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      maxQueue: 1,
    });

    const r1 = await b.acquire(makeRequest());
    const r2P = b.acquire(makeRequest());
    const r3 = await b.acquire(makeRequest());

    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toBe("queue_limit");

    if (r1.ok) r1.token.release();
    const r2 = await r2P;
    if (r2.ok) r2.token.release();
  });

  it("profile timeoutMs times out a waiting request", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      maxQueue: 5,
      timeoutMs: 20,
    });

    const r1 = await b.acquire(makeRequest());
    const r2 = await b.acquire(makeRequest());
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("timeout");
    if (r1.ok) r1.token.release();
  });

  it("abort cancels a waiting request and frees queue slot", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      maxQueue: 1,
    });

    const r1 = await b.acquire(makeRequest());
    const ac = makeAbortController();
    const r2P = b.acquire(makeRequest(), { signal: ac.signal });
    expect(await isSettled(r2P, 5)).toBe(false);

    ac.abort();
    const r2 = await r2P;
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("aborted");
    expect(b.stats().bulkhead.pending).toBe(0);
    if (r1.ok) r1.token.release();
  });
});

// ── run() ────────────────────────────────────────────────────

describe("run()", () => {
  it("returns fn result on success", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 2 });
    const result = await b.run(makeRequest(), async () => "hello");
    expect(result).toBe("hello");
  });

  it("releases slot even when fn throws", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 1 });

    await expect(
      b.run(makeRequest(), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(b.stats().bulkhead.inFlight).toBe(0);
  });

  it("throws LLMBulkheadRejectedError on concurrency rejection", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 1 });

    const p1 = b.run(makeRequest(), async () => {
      await sleep(50);
      return "a";
    });
    await expect(b.run(makeRequest(), async () => "b")).rejects.toThrow(
      LLMBulkheadRejectedError,
    );
    await p1;
  });

  it("LLMBulkheadRejectedError has correct code and reason", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 1 });

    const p1 = b.run(makeRequest(), async () => {
      await sleep(50);
      return "a";
    });

    let err: LLMBulkheadRejectedError | undefined;
    try {
      await b.run(makeRequest(), async () => "b");
    } catch (e) {
      err = e as LLMBulkheadRejectedError;
    }

    expect(err).toBeInstanceOf(LLMBulkheadRejectedError);
    expect(err?.code).toBe("LLM_BULKHEAD_REJECTED");
    expect(err?.reason).toBe("concurrency_limit");
    await p1;
  });

  it("passes AbortSignal through to fn", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 1 });
    const ac = makeAbortController();
    let receivedSignal: AcquireOptions["signal"] | undefined;

    await b.run(
      makeRequest(),
      async (signal) => {
        receivedSignal = signal;
      },
      { signal: ac.signal },
    );

    expect(receivedSignal).toBe(ac.signal);
  });

  it("run() with a queued request eventually resolves", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      maxQueue: 1,
    });

    const p1 = b.run(makeRequest(), async () => {
      await sleep(20);
      return "first";
    });
    const p2 = b.run(makeRequest(), async () => "second");

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("first");
    expect(r2).toBe("second");
    expect(b.stats().bulkhead.inFlight).toBe(0);
  });
});

// ── Deduplication ────────────────────────────────────────────

describe("deduplication", () => {
  it("identical in-flight requests share one slot", async () => {
    let callCount = 0;
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      deduplication: true,
    });

    const req = makeRequest("same content");
    const p1 = b.run(req, async () => {
      callCount++;
      await sleep(20);
      return "result";
    });
    const p2 = b.run(req, async () => {
      callCount++;
      return "result";
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("result");
    expect(r2).toBe("result");
    expect(callCount).toBe(1);
  });

  it("dedup hit increments stats counter", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 2,
      deduplication: true,
    });

    const req = makeRequest("same content");
    const p1 = b.run(req, async () => {
      await sleep(20);
      return "a";
    });
    await sleep(0);
    const p2 = b.run(req, async () => "b");

    await Promise.all([p1, p2]);
    expect(b.stats().deduplication?.hits).toBe(1);
  });

  it("different content is not deduplicated", async () => {
    let callCount = 0;
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 2,
      deduplication: true,
    });

    await Promise.all([
      b.run(makeRequest("content A"), async () => { callCount++; return "a"; }),
      b.run(makeRequest("content B"), async () => { callCount++; return "b"; }),
    ]);

    expect(callCount).toBe(2);
  });

  it("after first call settles, subsequent identical request is new", async () => {
    let callCount = 0;
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 2,
      deduplication: true,
    });

    const req = makeRequest("same");
    await b.run(req, async () => { callCount++; return "first"; });
    await b.run(req, async () => { callCount++; return "second"; });

    expect(callCount).toBe(2);
  });

  it("stats.deduplication is absent when deduplication is disabled", () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 1 });
    expect(b.stats().deduplication).toBeUndefined();
  });

  // ── v2: dedup key includes max_tokens ──

  it("requests with same messages but different max_tokens are NOT deduplicated", async () => {
    let callCount = 0;
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 2,
      deduplication: true,
    });

    const p1 = b.run(makeRequest("same", 256), async () => {
      callCount++;
      await sleep(20);
      return "a";
    });
    await sleep(0);
    const p2 = b.run(makeRequest("same", 1024), async () => {
      callCount++;
      return "b";
    });

    await Promise.all([p1, p2]);
    expect(callCount).toBe(2); // different max_tokens => different keys
  });

  it("requests with same messages AND same max_tokens ARE deduplicated", async () => {
    let callCount = 0;
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 2,
      deduplication: true,
    });

    const p1 = b.run(makeRequest("same", 256), async () => {
      callCount++;
      await sleep(20);
      return "a";
    });
    await sleep(0);
    const p2 = b.run(makeRequest("same", 256), async () => {
      callCount++;
      return "b";
    });

    await Promise.all([p1, p2]);
    expect(callCount).toBe(1);
  });

  // ── v2: custom keyFn ──

  it("custom keyFn controls deduplication", async () => {
    let callCount = 0;
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 2,
      deduplication: {
        keyFn: (req) => {
          const c = req.messages[0]?.content;
          return typeof c === "string" ? c.slice(0, 4) : "";
        },
      },
    });

    // Both start with "same" so they share a key
    const p1 = b.run(makeRequest("same-content-A"), async () => {
      callCount++;
      await sleep(20);
      return "a";
    });
    await sleep(0);
    const p2 = b.run(makeRequest("same-content-B"), async () => {
      callCount++;
      return "b";
    });

    await Promise.all([p1, p2]);
    expect(callCount).toBe(1);
  });

  it("keyFn returning empty string opts out of dedup", async () => {
    let callCount = 0;
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 2,
      deduplication: {
        keyFn: () => "", // always opts out
      },
    });

    const req = makeRequest("same");
    const p1 = b.run(req, async () => {
      callCount++;
      await sleep(20);
      return "a";
    });
    await sleep(0);
    const p2 = b.run(req, async () => {
      callCount++;
      return "b";
    });

    await Promise.all([p1, p2]);
    expect(callCount).toBe(2);
  });
});

// ── Event system (v2) ────────────────────────────────────────

describe("event system", () => {
  it("emits 'admit' on successful acquisition", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      tokenBudget: {
        budget: 1_000,
        estimator: () => ({ input: 50, maxOutput: 50 }),
      },
    });

    const events: LLMEventMap["admit"][] = [];
    b.on("admit", (e) => events.push(e));

    const r = await b.acquire(makeRequest("test"));
    expect(events).toHaveLength(1);
    expect(events[0]!.reservedTokens).toBe(100);
    if (r.ok) r.token.release();
  });

  it("emits 'reject' on budget_limit rejection", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      tokenBudget: {
        budget: 10,
        estimator: () => ({ input: 100, maxOutput: 100 }),
      },
    });

    const events: LLMEventMap["reject"][] = [];
    b.on("reject", (e) => events.push(e));

    await b.acquire(makeRequest());
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("budget_limit");
  });

  it("emits 'reject' on concurrency_limit rejection", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
    });

    const events: LLMEventMap["reject"][] = [];
    b.on("reject", (e) => events.push(e));

    const r1 = await b.acquire(makeRequest());
    await b.acquire(makeRequest());

    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("concurrency_limit");
    if (r1.ok) r1.token.release();
  });

  it("emits 'release' with usage and refund info", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      tokenBudget: {
        budget: 1_000,
        estimator: () => ({ input: 100, maxOutput: 400 }),
      },
    });

    const events: LLMEventMap["release"][] = [];
    b.on("release", (e) => events.push(e));

    const r = await b.acquire(makeRequest());
    if (r.ok) r.token.release({ input: 80, output: 40 });

    expect(events).toHaveLength(1);
    expect(events[0]!.reservedTokens).toBe(500);
    expect(events[0]!.refundedTokens).toBe(380);
    expect(events[0]!.usage).toEqual({ input: 80, output: 40 });
  });

  it("emits 'dedup' when a request is deduplicated", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 2,
      deduplication: true,
    });

    const events: LLMEventMap["dedup"][] = [];
    b.on("dedup", (e) => events.push(e));

    const req = makeRequest("same");
    const p1 = b.run(req, async () => {
      await sleep(20);
      return "a";
    });
    await sleep(0);
    const p2 = b.run(req, async () => "b");

    await Promise.all([p1, p2]);
    expect(events).toHaveLength(1);
  });

  it("unsubscribe stops listener", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 5 });

    let count = 0;
    const off = b.on("admit", () => { count++; });

    await b.run(makeRequest(), async () => "a");
    expect(count).toBe(1);

    off(); // unsubscribe

    await b.run(makeRequest(), async () => "b");
    expect(count).toBe(1); // not incremented
  });

  it("throwing listener does not break bulkhead", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 5 });

    b.on("admit", () => {
      throw new Error("bad listener");
    });

    // Should not throw
    const result = await b.run(makeRequest(), async () => "ok");
    expect(result).toBe("ok");
  });
});

// ── close / drain (v2) ───────────────────────────────────────

describe("close and drain", () => {
  it("close() rejects future acquire calls with shutdown", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 5 });
    b.close();

    const r = await b.acquire(makeRequest());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("shutdown");
  });

  it("close() rejects future run() calls with shutdown", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 5 });
    b.close();

    await expect(
      b.run(makeRequest(), async () => "x"),
    ).rejects.toThrow(LLMBulkheadRejectedError);
  });

  it("close() rejects pending waiters", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      profile: "batch",
    });

    const r1 = await b.acquire(makeRequest());
    const r2P = b.acquire(makeRequest()); // waiting

    b.close();

    const r2 = await r2P;
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("shutdown");

    if (r1.ok) r1.token.release();
  });

  it("close() does not interrupt in-flight work", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 1 });

    const p = b.run(makeRequest(), async () => {
      await sleep(30);
      return "completed";
    });

    b.close();

    const result = await p;
    expect(result).toBe("completed");
  });

  it("drain() resolves immediately when empty", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 5 });
    await b.drain(); // should not hang
  });

  it("drain() resolves when in-flight work completes", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 1 });

    const p = b.run(makeRequest(), async () => {
      await sleep(20);
      return "done";
    });

    await sleep(0); // let run start
    await b.drain();
    await p;

    expect(b.stats().bulkhead.inFlight).toBe(0);
  });

  it("close() + drain() composes for graceful shutdown", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 2 });

    const p1 = b.run(makeRequest(), async () => {
      await sleep(20);
      return "a";
    });
    const p2 = b.run(makeRequest(), async () => {
      await sleep(30);
      return "b";
    });

    await sleep(0);

    b.close();
    await b.drain();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("a");
    expect(r2).toBe("b");
    expect(b.stats().bulkhead.inFlight).toBe(0);
  });
});

// ── TokenUsage type ──────────────────────────────────────────

describe("TokenUsage type", () => {
  it("is exported and satisfies the expected shape", () => {
    const usage: TokenUsage = { input: 100, output: 200 };
    expect(usage.input).toBe(100);
    expect(usage.output).toBe(200);
  });
});

// ── Stats ────────────────────────────────────────────────────

describe("stats()", () => {
  it("base stats fields are namespaced under bulkhead", () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 5 });
    const s = b.stats();
    expect(typeof s.bulkhead.inFlight).toBe("number");
    expect(typeof s.bulkhead.pending).toBe("number");
    expect(s.bulkhead.maxConcurrent).toBe(5);
    expect(s.bulkhead.maxQueue).toBe(0);
  });

  it("tracks LLM-layer counters separately from base bulkhead counters", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 2,
      tokenBudget: {
        budget: 10,
        estimator: () => ({ input: 8, maxOutput: 0 }),
      },
    });

    const [r1, r2] = await Promise.all([
      b.acquire(makeRequest("a")),
      b.acquire(makeRequest("b")),
    ]);

    expect(r1.ok || r2.ok).toBe(true);
    expect(r1.ok && r2.ok).toBe(false);

    const rejected = r1.ok ? r2 : r1;
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toBe("budget_limit");

    const s = b.stats();
    expect(s.bulkhead.totalAdmitted).toBe(2);
    expect(s.llm.admitted).toBe(1);
    expect(s.llm.rejected).toBe(1);
    expect(s.llm.rejectedByReason.budget_limit).toBe(1);

    if (r1.ok) r1.token.release();
    if (r2.ok) r2.token.release();
   });
   
  it("drains to zero after all work completes", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 3,
      tokenBudget: { budget: 10_000 },
      deduplication: true,
    });

    await Promise.all([
      b.run(makeRequest("a"), async () => { await sleep(10); return 1; }),
      b.run(makeRequest("b"), async () => { await sleep(10); return 2; }),
      b.run(makeRequest("c"), async () => { await sleep(10); return 3; }),
    ]);

    const s = b.stats();
    expect(s.bulkhead.inFlight).toBe(0);
    expect(s.bulkhead.pending).toBe(0);
    expect(s.tokenBudget?.inFlightTokens).toBe(0);
    expect(s.deduplication?.active).toBe(0);
  });

  it("totalRefunded field is present on tokenBudget stats", () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      tokenBudget: { budget: 1_000 },
    });
    expect(b.stats().tokenBudget?.totalRefunded).toBe(0);
  });
});

// ── Token budget + abort interaction ─────────────────────────

describe("token budget + abort interaction", () => {
  it("queued request abort does not leak token reservation", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      maxQueue: 1,
      tokenBudget: {
        budget: 1_000,
        estimator: () => ({ input: 50, maxOutput: 50 }),
      },
    });

    const r1 = await b.acquire(makeRequest());
    expect(r1.ok).toBe(true);

    const ac = new AbortController();
    const r2P = b.acquire(makeRequest(), { signal: ac.signal });
    expect(await isSettled(r2P, 5)).toBe(false);
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(100);

    ac.abort();
    const r2 = await r2P;
    expect(r2.ok).toBe(false);
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(100); // only r1

    if (r1.ok) r1.token.release();
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(0);
  });
});

// ── Stress / soak ────────────────────────────────────────────

describe("async-bulkhead-llm v2 stress", () => {
  it(
    "soak: invariants hold under churn with refund, dedup, events, and close/drain",
    { timeout: 30_000 },
    async () => {
      const maxConcurrent = 15;
      const maxQueue = 30;
      const tokenBudget = 50_000;
      const errors: unknown[] = [];
      const track = (p: Promise<void>) =>
        p.catch((e) => { errors.push(e); });

      const eventCounts = { admit: 0, reject: 0, release: 0, dedup: 0 };

      const b = createLLMBulkhead({
        model: "claude-sonnet-4",
        maxConcurrent,
        maxQueue,
        tokenBudget: {
          budget: tokenBudget,
          estimator: () => ({
            input: 50 + randInt(200),
            maxOutput: 100 + randInt(500),
          }),
        },
        deduplication: true,
      });

      b.on("admit", () => { eventCounts.admit++; });
      b.on("reject", () => { eventCounts.reject++; });
      b.on("release", () => { eventCounts.release++; });
      b.on("dedup", () => { eventCounts.dedup++; });

      const durationMs = 4_000;
      const endAt = Date.now() + durationMs;

      let maxInFlightObserved = 0;
      let maxPendingObserved = 0;
      let maxInFlightTokensObserved = 0;
      let granted = 0;
      let rejected = 0;

      const work: Promise<void>[] = [];

      while (Date.now() < endAt) {
        const burst = 3 + randInt(10);

        for (let i = 0; i < burst; i++) {
          const mode = randInt(10);
          const req = makeRequest(
            "x".repeat(200 + randInt(400)),
            256 + randInt(512),
          );

          if (mode === 0) {
            // Abort path
            const ac = new AbortController();
            work.push(
              track(
                swallowBulkheadRejection(
                  (async () => {
                    const rP = b.acquire(req, { signal: ac.signal });
                    const rPSettled = rP.then(
                      (value) => ({ ok: true as const, value }),
                      (error) => ({ ok: false as const, error }),
                    );
                    await sleep(randInt(3));
                    ac.abort();
                    const settled = await rPSettled;
                    if (!settled.ok) throw settled.error;
                    const r = settled.value;
                    if (r.ok) {
                      granted++;
                      try { await sleep(1 + randInt(8)); }
                      finally { r.token.release({ input: 30, output: 20 }); }
                    } else {
                      rejected++;
                    }
                  })(),
                ),
              ),
            );
          } else if (mode === 1) {
            // Timeout path
            work.push(
              track(
                swallowBulkheadRejection(
                  (async () => {
                    const r = await b.acquire(req, {
                      timeoutMs: 5 + randInt(10),
                    });
                    if (r.ok) {
                      granted++;
                      try { await sleep(1 + randInt(8)); }
                      finally { r.token.release({ input: 40, output: 30 }); }
                    } else {
                      rejected++;
                    }
                  })(),
                ),
              ),
            );
          } else if (mode === 2) {
            // run() with getUsage path
            work.push(
              track(
                swallowBulkheadRejection(
                  (async () => {
                    try {
                      await b.run(
                        req,
                        async () => {
                          await sleep(1 + randInt(8));
                          return { usage: { input: 30, output: 20 } };
                        },
                        { getUsage: (r) => r.usage },
                      );
                      granted++;
                    } catch (e) {
                      if (isLLMBulkheadRejection(e)) {
                        rejected++;
                        return;
                      }
                      throw e;
                    }
                  })(),
                ),
              ),
            );
          } else {
            // acquire() path
            work.push(
              track(
                swallowBulkheadRejection(
                  (async () => {
                    const r = await b.acquire(req);
                    if (!r.ok) {
                      rejected++;
                      return;
                    }
                    granted++;
                    try { await sleep(1 + randInt(8)); }
                    finally { r.token.release(); }
                  })(),
                ),
              ),
            );
          }

          // Observe invariants
          const s = b.stats();
          if (s.bulkhead.inFlight > maxInFlightObserved)
            maxInFlightObserved = s.bulkhead.inFlight;
          if (s.bulkhead.pending > maxPendingObserved)
            maxPendingObserved = s.bulkhead.pending;
          const iT = s.tokenBudget?.inFlightTokens ?? 0;
          if (iT > maxInFlightTokensObserved)
            maxInFlightTokensObserved = iT;

          expect(s.bulkhead.inFlight).toBeLessThanOrEqual(maxConcurrent);
          expect(s.bulkhead.pending).toBeLessThanOrEqual(maxQueue);
          if (s.tokenBudget) {
            expect(s.tokenBudget.inFlightTokens).toBeLessThanOrEqual(
              tokenBudget,
            );
            expect(s.tokenBudget.available).toBeGreaterThanOrEqual(0);
          }
        }

        await sleep(randInt(3));
      }

      await Promise.all(work);
      if (errors.length) throw errors[0];

      const final = b.stats();
      expect(final.bulkhead.inFlight).toBe(0);
      expect(final.bulkhead.pending).toBe(0);
      expect(final.tokenBudget?.inFlightTokens).toBe(0);
      expect(final.tokenBudget?.available).toBe(tokenBudget);

      // System was exercised
      expect(granted + rejected).toBeGreaterThan(0);
      expect(maxInFlightObserved).toBeLessThanOrEqual(maxConcurrent);
      expect(maxPendingObserved).toBeLessThanOrEqual(maxQueue);

      // Events fired
      expect(eventCounts.admit).toBeGreaterThan(0);
      expect(eventCounts.release).toBeGreaterThan(0);
      // admit count should equal release count
      expect(eventCounts.admit).toBe(eventCounts.release);
      // refunds were tracked
      expect(final.tokenBudget?.totalRefunded).toBeGreaterThan(0);
    },
  );
});