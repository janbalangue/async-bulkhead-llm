import { describe, expect, it } from "vitest";
import {
  createLLMBulkhead,
  createModelAwareTokenEstimator,
  naiveTokenEstimator,
  type LLMRequest,
} from "../src/index.js";

// claude-sonnet-4 ratio is 3.9; naive ratio is 4.0.
const text = (n: number) => "x".repeat(n);

describe("LLMRequest.system", () => {
  it("naive estimator counts a string system prompt", () => {
    const withSystem: LLMRequest = {
      messages: [{ role: "user", content: text(4) }],
      system: text(8),
      max_tokens: 10,
    };
    // (4 + 8) chars / 4.0 = 3
    expect(naiveTokenEstimator(withSystem).input).toBe(3);
    // Without system: 4 / 4.0 = 1
    const withoutSystem: LLMRequest = {
      messages: withSystem.messages,
      max_tokens: 10,
    };
    expect(naiveTokenEstimator(withoutSystem).input).toBe(1);
  });

  it("model-aware estimator counts system content blocks", () => {
    const est = createModelAwareTokenEstimator({ defaultModel: "gpt-4o" });
    const req: LLMRequest = {
      messages: [{ role: "user", content: text(37) }],
      system: [
        { type: "text", text: text(37) },
        { type: "cache_control_marker", meta: true }, // opaque: 0 by default
      ],
      max_tokens: 5,
    };
    // (37 + 37) / 3.7 = 20
    expect(est(req)).toEqual({ input: 20, maxOutput: 5 });
  });
});

describe("LLMRequest.extraInputTokens", () => {
  it("both built-in estimators add it verbatim", () => {
    const req: LLMRequest = {
      messages: [{ role: "user", content: text(40) }],
      extraInputTokens: 500,
      max_tokens: 8,
    };
    expect(naiveTokenEstimator(req).input).toBe(10 + 500);
    const est = createModelAwareTokenEstimator({
      defaultModel: "totally-unknown-model", // falls back to 4.0
    });
    expect(est(req).input).toBe(10 + 500);
  });

  it("rejects negative and non-integer values", () => {
    for (const bad of [-1, 1.5, Number.NaN, Infinity]) {
      const req: LLMRequest = {
        messages: [{ role: "user", content: "hi" }],
        extraInputTokens: bad,
      };
      expect(() => naiveTokenEstimator(req)).toThrow(
        /request\.extraInputTokens/,
      );
    }
  });

  it("distinguishes otherwise-identical requests in the default dedup key", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 2,
      deduplication: true,
    });
    let calls = 0;
    const mk = (extra: number): LLMRequest => ({
      messages: [{ role: "user", content: "same" }],
      extraInputTokens: extra,
    });
    const slow = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return "v";
    };
    const p1 = b.run(mk(100), slow);
    await new Promise((r) => setTimeout(r, 0));
    const p2 = b.run(mk(200), slow); // different extraInputTokens: no conflation
    await Promise.all([p1, p2]);
    expect(calls).toBe(2);
  });
});

describe("opaqueBlockTokens", () => {
  const imageBlock = { type: "image", source: { data: "AAAA" } };
  const docBlock = { type: "document", source: { data: "BBBB" } };

  it("flat number form charges every opaque block", () => {
    const est = createModelAwareTokenEstimator({
      defaultModel: "claude-sonnet-4",
      opaqueBlockTokens: 2_048,
    });
    const req: LLMRequest = {
      messages: [
        { role: "user", content: [imageBlock, { type: "text", text: text(39) }] },
        { role: "user", content: [docBlock] },
      ],
      max_tokens: 7,
    };
    // 39 / 3.9 = 10 text tokens + 2 opaque blocks * 2048
    expect(est(req)).toEqual({ input: 10 + 4_096, maxOutput: 7 });
  });

  it("byType + default form resolves per block type", () => {
    const est = createModelAwareTokenEstimator({
      defaultModel: "claude-sonnet-4",
      opaqueBlockTokens: { default: 100, byType: { image: 1_500 } },
    });
    const req: LLMRequest = {
      messages: [{ role: "user", content: [imageBlock, docBlock] }],
      system: [{ type: "audio", data: "CCCC" }], // system blocks count too
      max_tokens: 1,
    };
    expect(est(req).input).toBe(1_500 + 100 + 100);
  });

  it("object form without default charges 0 for unlisted types", () => {
    const est = createModelAwareTokenEstimator({
      defaultModel: "claude-sonnet-4",
      opaqueBlockTokens: { byType: { image: 1_500 } },
    });
    const req: LLMRequest = {
      messages: [{ role: "user", content: [imageBlock, docBlock] }],
      max_tokens: 1,
    };
    expect(est(req).input).toBe(1_500);
  });

  it("treats a malformed text block as opaque (conservative)", () => {
    const est = createModelAwareTokenEstimator({
      defaultModel: "claude-sonnet-4",
      opaqueBlockTokens: 50,
    });
    const req: LLMRequest = {
      messages: [
        { role: "user", content: [{ type: "text", text: 123 as unknown as string }] },
      ],
      max_tokens: 1,
    };
    expect(est(req).input).toBe(50);
  });

  it("string content and well-formed text blocks are never surcharged", () => {
    const est = createModelAwareTokenEstimator({
      defaultModel: "claude-sonnet-4",
      opaqueBlockTokens: 9_999,
    });
    const req: LLMRequest = {
      messages: [
        { role: "user", content: text(39) },
        { role: "assistant", content: [{ type: "text", text: text(39) }] },
      ],
      max_tokens: 1,
    };
    expect(est(req).input).toBe(20); // 78 / 3.9, no surcharge
  });

  it("omitted option preserves the previous zero-surcharge behavior", () => {
    const est = createModelAwareTokenEstimator({ defaultModel: "claude-sonnet-4" });
    const req: LLMRequest = {
      messages: [{ role: "user", content: [imageBlock] }],
      max_tokens: 3,
    };
    expect(est(req)).toEqual({ input: 0, maxOutput: 3 });
  });

  it("validates values at estimator creation", () => {
    expect(() =>
      createModelAwareTokenEstimator({ opaqueBlockTokens: -1 }),
    ).toThrow(/opaqueBlockTokens/);
    expect(() =>
      createModelAwareTokenEstimator({ opaqueBlockTokens: { default: 1.5 } }),
    ).toThrow(/opaqueBlockTokens\.default/);
    expect(() =>
      createModelAwareTokenEstimator({
        opaqueBlockTokens: { byType: { image: -5 } },
      }),
    ).toThrow(/opaqueBlockTokens\.byType\["image"\]/);
  });
});

describe("per-call reservation override", () => {
  const req = (): LLMRequest => ({
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 10,
  });

  it("acquire() reserves the override verbatim and skips the estimator", async () => {
    let estimatorCalls = 0;
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 2,
      tokenBudget: {
        budget: 1_000,
        estimator: () => {
          estimatorCalls++;
          return { input: 1, maxOutput: 1 };
        },
      },
    });

    const r = await b.acquire(req(), {
      reservation: { input: 300, maxOutput: 400 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(estimatorCalls).toBe(0);
    expect(r.reservation).toEqual({ input: 300, maxOutput: 400, reserved: 700 });
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(700);
    r.token.release();
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(0);
  });

  it("run() honors the override for admission and refund", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      tokenBudget: {
        budget: 500,
        estimator: () => ({ input: 1, maxOutput: 1 }),
      },
    });

    await b.run(req(), async () => ({ ok: true }), {
      reservation: { input: 200, maxOutput: 200 },
      getUsage: () => ({ input: 150, output: 100 }),
    });
    const tb = b.stats().tokenBudget;
    expect(tb?.totalReserved).toBe(400);
    expect(tb?.totalConsumed).toBe(250);
    expect(tb?.totalRefunded).toBe(150);
    expect(tb?.inFlightTokens).toBe(0);
  });

  it("override participates in budget_limit rejection", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 100,
        estimator: () => ({ input: 1, maxOutput: 1 }),
      },
    });

    const r = await b.acquire(req(), {
      reservation: { input: 90, maxOutput: 20 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("budget_limit");
      expect(r.detail?.tokenBudget?.requested).toBe(110);
    }
  });

  it("wouldAdmit() accepts the same override", () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 5,
      tokenBudget: {
        budget: 100,
        estimator: () => ({ input: 1, maxOutput: 1 }),
      },
    });
    expect(b.wouldAdmit(req())).toEqual({ admit: true });
    expect(
      b.wouldAdmit(req(), { reservation: { input: 90, maxOutput: 20 } }),
    ).toEqual({ admit: false, reason: "budget_limit" });
  });

  it("estimate() still previews the estimator path, not the override", () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      tokenBudget: {
        budget: 1_000,
        estimator: () => ({ input: 5, maxOutput: 5 }),
      },
    });
    expect(b.estimate(req())).toEqual({ input: 5, maxOutput: 5, reserved: 10 });
  });

  it("rejects invalid override values", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      tokenBudget: { budget: 1_000 },
    });
    await expect(
      b.acquire(req(), { reservation: { input: -1, maxOutput: 10 } }),
    ).rejects.toThrow(/token estimator input/);
    await expect(
      b.run(req(), async () => "x", {
        reservation: { input: 1, maxOutput: 1.5 },
      }),
    ).rejects.toThrow(/token estimator maxOutput/);
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(0);
  });

  it("is ignored when tokenBudget is not configured", async () => {
    const b = createLLMBulkhead({ model: "claude-sonnet-4", maxConcurrent: 1 });
    const r = await b.acquire(req(), {
      reservation: { input: 999_999, maxOutput: 999_999 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reservation).toBeNull();
      r.token.release();
    }
  });
});

describe("gateway-shaped integration (the tyr use case)", () => {
  it("admits a real provider-shaped request without a synthetic projection", async () => {
    // What tyr previously did: serialize {system, messages, tools, ...} to
    // JSON, wrap in a fake message, and smuggle a media surcharge through a
    // Symbol + wrapper estimator. With v3.7 the same policy is expressed
    // directly on the request + estimator options.
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 4,
      tokenBudget: {
        budget: 50_000,
        estimator: createModelAwareTokenEstimator({
          defaultModel: "claude-sonnet-4",
          opaqueBlockTokens: 2_048, // tyr's OPAQUE_MEDIA_INPUT_TOKENS
        }),
      },
    });

    const request: LLMRequest = {
      model: "claude-sonnet-4-5",
      system: "You are a terse assistant.".padEnd(39, " "), // 39 chars
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image.".padEnd(39, " ") },
            { type: "image", source: { type: "base64", data: "…" } },
          ],
        },
      ],
      max_tokens: 1_024,
      // Tool schemas etc. counted out-of-band by the gateway:
      extraInputTokens: 350,
    };

    const est = b.estimate(request);
    // (39 + 39) chars / 3.9 = 20, + 2048 image + 350 extra = 2418 input
    expect(est).toEqual({ input: 2_418, maxOutput: 1_024, reserved: 3_442 });

    const r = await b.acquire(request);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reservation?.reserved).toBe(3_442);
      r.token.release({ input: 2_000, output: 500 });
    }
    expect(b.stats().tokenBudget?.inFlightTokens).toBe(0);
  });
});