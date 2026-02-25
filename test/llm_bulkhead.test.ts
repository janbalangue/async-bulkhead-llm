import { describe, it, expect, vi } from "vitest";
import {
  createLLMBulkhead,
  naiveTokenEstimator,
  createModelAwareTokenEstimator,
  LLMBulkheadRejectedError,
  PROFILES,
  type LLMRequest,
  type TokenUsage,
} from "../src/index";

// ---- Helpers ----

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function randInt(maxExclusive: number) {
  return Math.floor(Math.random() * maxExclusive);
}

async function isSettled(p: Promise<unknown>, withinMs = 5) {
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await sleep(withinMs);
  return settled;
}

function makeRequest(content = "hello world", max_tokens?: number): LLMRequest {
  const request: LLMRequest = { messages: [{ role: "user", content }] };
  if (max_tokens !== undefined) {
    request.max_tokens = max_tokens;
  }
  return request;
}

function isLLMBulkheadRejection(e: unknown): boolean {
  const anyE = e as any;
  if (!anyE || typeof anyE !== "object") return false;

  // Vitest may serialize errors across worker boundaries; avoid instanceof.
  if (anyE.code === "LLM_BULKHEAD_REJECTED") return true;
  if (anyE.name === "LLMBulkheadRejectedError") return true;

  // Be permissive in tests: sometimes we only get { reason } with no message/stack.
  return (
    typeof anyE.reason === "string" &&
    [
      "concurrency_limit",
      "queue_limit",
      "timeout",
      "aborted",
      "budget_limit",
    ].includes(anyE.reason)
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

// ---- naiveTokenEstimator ----

describe("naiveTokenEstimator", () => {
  it("estimates input as ceil(chars / 4)", () => {
    const r = makeRequest("x".repeat(400));
    const est = naiveTokenEstimator(r);
    expect(est.input).toBe(100);
  });

  it("uses max_tokens as maxOutput when present", () => {
    const r = makeRequest("hi", 1024);
    const est = naiveTokenEstimator(r);
    expect(est.maxOutput).toBe(1024);
  });

  it("defaults maxOutput to 2048 when max_tokens is absent", () => {
    const r = makeRequest("hi");
    const est = naiveTokenEstimator(r);
    expect(est.maxOutput).toBe(2_048);
  });

  it("sums content across multiple messages", () => {
    const r: LLMRequest = {
      messages: [
        { role: "user", content: "x".repeat(200) },
        { role: "assistant", content: "x".repeat(200) },
      ],
    };
    const est = naiveTokenEstimator(r);
    expect(est.input).toBe(100); // 400 chars / 4
  });

  it("handles empty messages array", () => {
    const r: LLMRequest = { messages: [] };
    const est = naiveTokenEstimator(r);
    expect(est.input).toBe(0);
    expect(est.maxOutput).toBe(2_048);
  });

  it("ceils fractional token counts", () => {
    const r = makeRequest("x".repeat(401)); // 401 / 4 = 100.25 => 101
    const est = naiveTokenEstimator(r);
    expect(est.input).toBe(101);
  });
});

// ---- createModelAwareTokenEstimator ----

describe("createModelAwareTokenEstimator", () => {
  it("uses a known built-in ratio for a recognised model prefix", () => {
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "claude-sonnet-4-20260101" },
    );
    const result = est(makeRequest("x".repeat(390), 512)); // 390 / 3.9 = 100
    expect(result.input).toBe(100);
  });

  it("longest prefix wins when multiple prefixes match", () => {
    // Both 'claude-3' (hypothetical) and 'claude-3-5-haiku' would match
    // 'claude-3-5-haiku-20250101'. Longest prefix wins => ratio 3.8.
    const est = createModelAwareTokenEstimator(
      { "claude-3": 3.0 }, // shorter prefix, lower priority
      { defaultModel: "claude-3-5-haiku-20250101" },
    );
    // 380 chars / 3.8 = 100
    const result = est(makeRequest("x".repeat(380)));
    expect(result.input).toBe(100);
  });

  it("exact override beats prefix match", () => {
    // Built-in 'claude-sonnet-4' => 3.9; override exact key => 2.0
    const est = createModelAwareTokenEstimator(
      { "claude-sonnet-4-custom": 2.0 },
      { defaultModel: "claude-sonnet-4-custom" },
    );
    // 200 chars / 2.0 = 100
    const result = est(makeRequest("x".repeat(200)));
    expect(result.input).toBe(100);
  });

  it("exact override is case-insensitive (lowercased fallback)", () => {
    const est = createModelAwareTokenEstimator(
      { "my-model": 2.0 }, // override key is lowercase
      { defaultModel: "MY-MODEL" }, // defaultModel is uppercase
    );
    const result = est(makeRequest("x".repeat(200)));
    expect(result.input).toBe(100); // 200 / 2.0 = 100
  });

  it("prefix scan is case-insensitive", () => {
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "CLAUDE-SONNET-4-20260101" },
    );
    // ratio for claude-sonnet-4 = 3.9; 390 / 3.9 = 100
    const result = est(makeRequest("x".repeat(390)));
    expect(result.input).toBe(100);
  });

  it("falls back to 4.0 ratio for unknown model", () => {
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "unknown-model-xyz" },
    );
    // 400 chars / 4.0 = 100
    const result = est(makeRequest("x".repeat(400)));
    expect(result.input).toBe(100);
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
    const result = est(makeRequest("hi")); // no max_tokens on request
    expect(result.maxOutput).toBe(512);
  });

  it("request max_tokens overrides outputCap", () => {
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "claude-sonnet-4", outputCap: 512 },
    );
    const result = est(makeRequest("hi", 1024));
    expect(result.maxOutput).toBe(1_024);
  });

  it("empty defaultModel falls back to 4.0 and fires onUnknownModel", () => {
    const onUnknownModel = vi.fn();
    const est = createModelAwareTokenEstimator(
      {},
      { defaultModel: "", onUnknownModel },
    );
    const result = est(makeRequest("x".repeat(400)));
    expect(result.input).toBe(100);
    expect(onUnknownModel).toHaveBeenCalledWith("");
  });
});

// ---- PROFILES ----

describe("PROFILES", () => {
  it("interactive profile has maxQueue 0", () => {
    expect(PROFILES.interactive.maxQueue).toBe(0);
  });

  it("batch profile has maxQueue 20 and timeoutMs 30000", () => {
    expect(PROFILES.batch.maxQueue).toBe(20);
    expect(PROFILES.batch.timeoutMs).toBe(30_000);
  });
});

// ---- createLLMBulkhead — validation ----

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

// ---- Profile / preset resolution ----

describe("profile / preset resolution", () => {
  it("no profile => fail-fast default (maxQueue: 0)", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 1 });

    const rP = b.run(makeRequest(), async () => {
      await sleep(50);
      return "a";
    });
    // Second request: should fail fast, not queue
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

    expect(await isSettled(r2P, 5)).toBe(false); // waiting, not rejected

    await rP;
    const r2 = await r2P;
    expect(r2.ok).toBe(true);
    if (r2.ok) r2.token.release();
  });

  it("explicit maxQueue overrides profile default", async () => {
    // batch default is maxQueue: 20; override to 0
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

// ---- Token budget ----

describe("token budget", () => {
  it("admits when tokens are available", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: { budget: 10_000 },
    });

    const r = await b.acquire(makeRequest("x".repeat(40), 100)); // ~10 + 100 = ~110 tokens
    expect(r.ok).toBe(true);
    if (r.ok) r.token.release();
  });

  it("rejects with budget_limit when token ceiling is exceeded", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 10,
      tokenBudget: {
        budget: 200, // tiny budget
        estimator: () => ({ input: 150, maxOutput: 100 }), // 250 > 200
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
      profile: "batch", // maxQueue: 20
      tokenBudget: {
        budget: 50,
        estimator: () => ({ input: 30, maxOutput: 30 }), // 60 > 50
      },
    });

    const r = await b.acquire(makeRequest());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("budget_limit");

    const s = b.stats();
    expect(s.pending).toBe(0); // never queued
  });

  it("token reservation is released when request completes via run()", async () => {
    let _reserved = 0;
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 200,
        estimator: () => {
          _reserved += 100;
          return { input: 50, maxOutput: 50 };
        },
      },
    });

    await b.run(makeRequest(), async () => "done");

    const s = b.stats();
    expect(s.tokenBudget?.inFlightTokens).toBe(0);
    expect(s.tokenBudget?.available).toBe(200);
    expect(_reserved).toBeGreaterThan(0);
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

  it("token reservation is released when acquire() token is released manually", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 200,
        estimator: () => ({ input: 50, maxOutput: 50 }),
      },
    });

    const r = await b.acquire(makeRequest());
    expect(r.ok).toBe(true);

    const s1 = b.stats();
    expect(s1.tokenBudget?.inFlightTokens).toBe(100);

    if (r.ok) r.token.release();

    const s2 = b.stats();
    expect(s2.tokenBudget?.inFlightTokens).toBe(0);
    expect(s2.tokenBudget?.available).toBe(200);
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

    const s = b.stats();
    expect(s.tokenBudget?.inFlightTokens).toBe(300);

    if (r1.ok) r1.token.release();
    if (r2.ok) r2.token.release();
    if (r3.ok) r3.token.release();

    expect(b.stats().tokenBudget?.inFlightTokens).toBe(0);
  });

  it("second request is rejected when budget is fully consumed by first", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 100,
        estimator: () => ({ input: 60, maxOutput: 60 }), // 120 > 100
      },
    });

    const r1 = await b.acquire(makeRequest()); // 120 > 100 => rejected immediately
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("budget_limit");
  });

  it("stats.tokenBudget is absent when tokenBudget is not configured", () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 5 });
    const s = b.stats();
    expect(s.tokenBudget).toBeUndefined();
  });

  it("token budget is not affected by a budget_limit rejection (no reservation leak)", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 100,
        estimator: () => ({ input: 60, maxOutput: 60 }), // always exceeds budget
      },
    });

    // Fire multiple rejected requests
    for (let i = 0; i < 5; i++) {
      const r = await b.acquire(makeRequest());
      expect(r.ok).toBe(false);
    }

    // inFlightTokens must remain 0 — no reservation for rejected requests
    const s = b.stats();
    expect(s.tokenBudget?.inFlightTokens).toBe(0);
    expect(s.tokenBudget?.available).toBe(100);
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

    // acquire() does a pre-check + a post-admission reservation => 2 calls
    expect(customEstimator).toHaveBeenCalledTimes(2);

    expect(r.ok).toBe(true);
    if (r.ok) r.token.release();
  });
});

// ---- Concurrency ----

describe("concurrency limits", () => {
  it("admits up to maxConcurrent simultaneously", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 3 });

    const r1 = await b.acquire(makeRequest());
    const r2 = await b.acquire(makeRequest());
    const r3 = await b.acquire(makeRequest());
    const r4 = await b.acquire(makeRequest()); // should fail fast

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

    const s = b.stats();
    expect(s.inFlight).toBe(2);
    expect(s.maxConcurrent).toBe(3);

    if (r1.ok) r1.token.release();
    if (r2.ok) r2.token.release();
    expect(b.stats().inFlight).toBe(0);
  });
});

// ---- Queue / waiting ----

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

    const s = b.stats();
    expect(s.inFlight).toBe(1);
    expect(s.pending).toBe(1);

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
    const r2P = b.acquire(makeRequest()); // queued
    const r3 = await b.acquire(makeRequest()); // queue full

    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toBe("queue_limit");

    if (r1.ok) r1.token.release();
    const r2 = await r2P;
    expect(r2.ok).toBe(true);
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
    expect(r1.ok).toBe(true);

    const r2 = await b.acquire(makeRequest()); // waits, then times out
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
    expect(r1.ok).toBe(true);

    const ac = new AbortController();
    const r2P = b.acquire(makeRequest(), { signal: ac.signal });
    expect(await isSettled(r2P, 5)).toBe(false);

    ac.abort();
    const r2 = await r2P;
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("aborted");

    const s = b.stats();
    expect(s.pending).toBe(0);

    if (r1.ok) r1.token.release();
  });
});

// ---- run() ----

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

    const s = b.stats();
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(0);
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

  it("throws LLMBulkheadRejectedError with reason budget_limit", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 10,
        estimator: () => ({ input: 100, maxOutput: 100 }),
      },
    });

    let err: LLMBulkheadRejectedError | undefined;
    try {
      await b.run(makeRequest(), async () => "x");
    } catch (e) {
      err = e as LLMBulkheadRejectedError;
    }

    expect(err?.reason).toBe("budget_limit");
  });

  it("passes AbortSignal through to fn", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 1 });
    const ac = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    await b.run(
      makeRequest(),
      async (signal) => {
        receivedSignal = signal;
      },
      { signal: ac.signal },
    );

    expect(receivedSignal).toBe(ac.signal);
  });

  it("run() with a queued request eventually resolves after release", async () => {
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

    const s = b.stats();
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(0);
  });
});

// ---- Deduplication ----

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
    }); // should deduplicate

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("result");
    expect(r2).toBe("result");
    expect(callCount).toBe(1); // fn only called once
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
    await sleep(0); // ensure p1 is in-flight
    const p2 = b.run(req, async () => "b"); // dedup hit

    await Promise.all([p1, p2]);

    const s = b.stats();
    expect(s.deduplication?.hits).toBe(1);
  });

  it("different content is not deduplicated", async () => {
    let callCount = 0;
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 2,
      deduplication: true,
    });

    await Promise.all([
      b.run(makeRequest("content A"), async () => {
        callCount++;
        return "a";
      }),
      b.run(makeRequest("content B"), async () => {
        callCount++;
        return "b";
      }),
    ]);

    expect(callCount).toBe(2);
  });

  it("after first call settles, subsequent identical request is a new call", async () => {
    let callCount = 0;
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 2,
      deduplication: true,
    });

    const req = makeRequest("same");
    await b.run(req, async () => {
      callCount++;
      return "first";
    });
    await b.run(req, async () => {
      callCount++;
      return "second";
    });

    expect(callCount).toBe(2); // dedup map cleared after first settles
  });

  it("stats.deduplication is absent when deduplication is disabled", () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 1 });
    expect(b.stats().deduplication).toBeUndefined();
  });

  it("dedup active count reflects in-flight distinct keys", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      deduplication: true,
    });

    const p1 = b.run(makeRequest("A"), async () => {
      await sleep(30);
      return "a";
    });
    const p2 = b.run(makeRequest("B"), async () => {
      await sleep(30);
      return "b";
    });

    await sleep(5);
    const s = b.stats();
    expect(s.deduplication?.active).toBe(2);

    await Promise.all([p1, p2]);
    expect(b.stats().deduplication?.active).toBe(0);
  });
});

// ---- TokenUsage forward-looking type ----

describe("TokenUsage (forward-looking type)", () => {
  it("is exported and satisfies the expected shape", () => {
    const usage: TokenUsage = { input: 100, output: 200 };
    expect(usage.input).toBe(100);
    expect(usage.output).toBe(200);
  });
});

// ---- Stats ----

describe("stats()", () => {
  it("base stats fields are always present", () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 5 });
    const s = b.stats();
    expect(typeof s.inFlight).toBe("number");
    expect(typeof s.pending).toBe("number");
    expect(s.maxConcurrent).toBe(5);
    expect(s.maxQueue).toBe(0);
  });

  it("drains to zero after all work completes", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 3,
      tokenBudget: { budget: 10_000 },
      deduplication: true,
    });

    await Promise.all([
      b.run(makeRequest("a"), async () => {
        await sleep(10);
        return 1;
      }),
      b.run(makeRequest("b"), async () => {
        await sleep(10);
        return 2;
      }),
      b.run(makeRequest("c"), async () => {
        await sleep(10);
        return 3;
      }),
    ]);

    const s = b.stats();
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(0);
    expect(s.tokenBudget?.inFlightTokens).toBe(0);
    expect(s.deduplication?.active).toBe(0);
  });
});

// ---- Interaction: token budget + abort ----

describe("token budget + abort interaction", () => {
  it("queued request abort does not leak token reservation", async () => {
    // Use a budget large enough for one reservation but not two.
    // First acquire reserves tokens and holds the slot.
    // Second acquire: budget check passes, queues, then gets aborted.
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

    // r2 is queued — no token reservation is taken until admission
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(100); // only r1 reserved

    ac.abort();
    const r2 = await r2P;
    expect(r2.ok).toBe(false);

    // After abort, still only r1 reserved
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(100);

    if (r1.ok) r1.token.release();
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(0);
  });
});

// ---- Stress / soak ----

describe("async-bulkhead-llm stress", () => {
  it(
    "soak: inFlight/pending/inFlightTokens never exceed limits; system drains to zero",
    { timeout: 30_000 },
    async () => {
      const maxConcurrent = 15;
      const maxQueue = 30;
      const tokenBudget = 50_000;
      const errors: unknown[] = [];
      const track = (p: Promise<void>) =>
        p.catch((e) => {
          errors.push(e);
        });

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
                    if (!settled.ok) throw settled.error; // unexpected error

                    const r = settled.value;
                    if (r.ok) {
                      granted++;
                      try {
                        await sleep(1 + randInt(8));
                      } finally {
                        r.token.release();
                      }
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
                      try {
                        await sleep(1 + randInt(8));
                      } finally {
                        r.token.release();
                      }
                    } else {
                      rejected++;
                    }
                  })(),
                ),
              ),
            );
          } else if (mode === 2) {
            // run() path
            work.push(
              track(
                swallowBulkheadRejection(
                  (async () => {
                    try {
                      await b.run(req, async () => {
                        await sleep(1 + randInt(8));
                      });
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
                    try {
                      await sleep(1 + randInt(8));
                    } finally {
                      r.token.release();
                    }
                  })(),
                ),
              ),
            );
          }

          // Observe invariants continuously
          const s = b.stats();
          if (s.inFlight > maxInFlightObserved)
            maxInFlightObserved = s.inFlight;
          if (s.pending > maxPendingObserved) maxPendingObserved = s.pending;
          const iT = s.tokenBudget?.inFlightTokens ?? 0;
          if (iT > maxInFlightTokensObserved) maxInFlightTokensObserved = iT;

          expect(s.inFlight).toBeLessThanOrEqual(maxConcurrent);
          expect(s.pending).toBeLessThanOrEqual(maxQueue);
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
      expect(final.inFlight).toBe(0);
      expect(final.pending).toBe(0);
      expect(final.tokenBudget?.inFlightTokens).toBe(0);
      expect(final.tokenBudget?.available).toBe(tokenBudget);

      // Sanity: system was actually exercised
      expect(granted + rejected).toBeGreaterThan(0);
      expect(maxInFlightObserved).toBeLessThanOrEqual(maxConcurrent);
      expect(maxPendingObserved).toBeLessThanOrEqual(maxQueue);
    },
  );
});
