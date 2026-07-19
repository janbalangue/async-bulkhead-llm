import { describe, expect, it } from "vitest";
import {
  createLLMBulkhead,
  type LLMEventMap,
  type LLMRequest,
  type TokenEstimate,
} from "../src/index.js";

const request: LLMRequest = {
  model: "claude-sonnet-4",
  messages: [{ role: "user", content: "coordinate this request" }],
  max_tokens: 1_000,
};

const fixedEstimator = (): TokenEstimate => ({
  input: 100,
  maxOutput: 1_000,
});

function makeBulkhead() {
  return createLLMBulkhead({
    model: "claude-sonnet-4",
    maxConcurrent: 4,
    tokenBudget: {
      budget: 10_000,
      estimator: fixedEstimator,
    },
  });
}

describe("reservation preview", () => {
  it("uses the exact admission estimator and validation path", async () => {
    const b = makeBulkhead();
    const preview = b.estimate(request);

    expect(preview).toEqual({
      input: 100,
      maxOutput: 1_000,
      reserved: 1_100,
    });

    const admits: LLMEventMap["admit"][] = [];
    b.on("admit", (event) => admits.push(event));

    const result = await b.acquire(request, { priority: "high" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.reservation).toEqual(preview);
    expect(result.token.reservation).toEqual(preview);
    expect(admits[0]!.reservedTokens).toBe(preview!.reserved);
    expect(admits[0]!.priority).toBe("high");

    result.token.release();
  });

  it("returns null when token-budget admission is disabled", () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
    });

    expect(b.estimate(request)).toBeNull();
  });

  it("validates request.max_tokens the same way as admission", async () => {
    const b = makeBulkhead();
    const invalid = { ...request, max_tokens: -1 };

    expect(() => b.estimate(invalid)).toThrow(/request\.max_tokens/);
    await expect(b.acquire(invalid)).rejects.toThrow(/request\.max_tokens/);
  });
});

describe("stable admission identity", () => {
  it("correlates acquire result, token, admit event, and release event", async () => {
    const b = makeBulkhead();
    const admits: LLMEventMap["admit"][] = [];
    const releases: LLMEventMap["release"][] = [];
    b.on("admit", (event) => admits.push(event));
    b.on("release", (event) => releases.push(event));

    const result = await b.acquire(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.admissionId).toBeTruthy();
    expect(result.token.admissionId).toBe(result.admissionId);
    expect(admits[0]!.admissionId).toBe(result.admissionId);
    expect(admits[0]!.priority).toBe("normal");

    result.token.release({ input: 80, output: 20 });

    expect(releases[0]!.admissionId).toBe(result.admissionId);
    expect(releases[0]!.priority).toBe("normal");
    expect(releases[0]!.heldTokens).toBe(1_100);
    expect(releases[0]!.usageSequence).toBe(0);
  });

  it("provides the same admission identity and reservation to run callbacks", async () => {
    const b = makeBulkhead();
    let admittedId = "";
    let releasedId = "";
    b.on("admit", (event) => {
      admittedId = event.admissionId;
    });
    b.on("release", (event) => {
      releasedId = event.admissionId;
    });

    let callbackId = "";
    await b.run(request, async (_signal, ctx) => {
      expect(ctx).toBeDefined();
      callbackId = ctx!.admissionId;
      expect(ctx!.reservation).toEqual(b.estimate(request));
      return "ok";
    });

    expect(callbackId).toBe(admittedId);
    expect(releasedId).toBe(admittedId);
  });

  it("generates a unique identifier for each successful admission", async () => {
    const b = makeBulkhead();
    const first = await b.acquire(request);
    const second = await b.acquire({
      ...request,
      messages: [{ role: "user", content: "a different request" }],
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.admissionId).not.toBe(second.admissionId);
    first.token.release();
    second.token.release();
  });
});

describe("ordered usage-change events", () => {
  it("emits monotonic sequences for effective updates and suppresses stale reports", async () => {
    const b = makeBulkhead();
    const usageEvents: LLMEventMap["usage"][] = [];
    const releases: LLMEventMap["release"][] = [];
    b.on("usage", (event) => usageEvents.push(event));
    b.on("release", (event) => releases.push(event));

    const result = await b.acquire(request, { priority: "high" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const firstReport = result.token.reportUsage({ input: 50, output: 10 });
    const staleReport = result.token.reportUsage({ input: 40, output: 5 });
    const secondReport = result.token.reportUsage({ input: 50, output: 20 });
    const thirdReport = result.token.reportUsage({ input: 50, output: 1_200 });

    expect(firstReport).toMatchObject({
      admissionId: result.admissionId,
      sequence: 1,
      held: 1_050,
    });
    expect(staleReport.sequence).toBe(1);
    expect(secondReport.sequence).toBe(2);
    expect(thirdReport.sequence).toBe(3);

    expect(usageEvents).toHaveLength(3);
    expect(usageEvents.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(usageEvents.every((event) => event.admissionId === result.admissionId)).toBe(
      true,
    );
    expect(usageEvents.every((event) => event.priority === "high")).toBe(true);

    expect(usageEvents[0]).toMatchObject({
      reservedTokens: 1_100,
      previousHeldTokens: 1_100,
      heldTokens: 1_050,
      deltaTokens: -50,
      usage: { input: 50, output: 10 },
      outputCap: 1_000,
      outputRemaining: 990,
      overReservation: false,
    });
    expect(usageEvents[1]).toMatchObject({
      previousHeldTokens: 1_050,
      heldTokens: 1_050,
      deltaTokens: 0,
      usage: { input: 50, output: 20 },
    });
    expect(usageEvents[2]).toMatchObject({
      previousHeldTokens: 1_050,
      heldTokens: 1_250,
      deltaTokens: 200,
      usage: { input: 50, output: 1_200 },
      outputRemaining: 0,
      overReservation: true,
    });

    result.token.release();
    expect(releases[0]!.usageSequence).toBe(3);
    expect(releases[0]!.heldTokens).toBe(1_250);

    result.token.reportUsage({ input: 100, output: 2_000 });
    expect(usageEvents).toHaveLength(3);
  });

  it("also emits usage telemetry when token-budget accounting is disabled", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
    });
    const events: LLMEventMap["usage"][] = [];
    b.on("usage", (event) => events.push(event));

    const result = await b.acquire(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.token.reportUsage({ input: 3, output: 4 });
    expect(events[0]).toMatchObject({
      admissionId: result.admissionId,
      sequence: 1,
      reservedTokens: 0,
      previousHeldTokens: 0,
      heldTokens: 0,
      deltaTokens: 0,
      outputCap: null,
      outputRemaining: null,
      overReservation: false,
    });

    result.token.release();
  });
});
