import { describe, it, expect } from "vitest";
import { createLLMBulkhead, type LLMRequest } from "../src/index.js";

const req = (text = "q"): LLMRequest => ({
  messages: [{ role: "user", content: text }],
});

/** Attach extra generation params structurally (LLMRequest is a minimal shape). */
const withExtra = (extra: Record<string, unknown>, text = "q"): LLMRequest =>
  ({ ...req(text), ...extra }) as LLMRequest;

function makeDedupBulkhead(opts: Partial<Parameters<typeof createLLMBulkhead>[0]> = {}) {
  return createLLMBulkhead({
    model: "claude-sonnet-4",
    maxConcurrent: 10,
    deduplication: true,
    ...opts,
  });
}

// ────────────────────────────────────────────
// Fix 1: default dedup key covers the whole request
// ────────────────────────────────────────────

describe("default dedup key — full-request, stable, hashed", () => {
  it("requests differing only in fields outside {messages, max_tokens, model} do NOT dedup", async () => {
    const b = makeDedupBulkhead();
    let calls = 0;
    let releaseLeader!: (v: number) => void;

    const p1 = b.run(withExtra({ temperature: 0 }), () => {
      calls++;
      return new Promise<number>((r) => (releaseLeader = r));
    });
    // Same messages, different temperature — must be its own call.
    const p2 = b.run(withExtra({ temperature: 1 }), async () => {
      calls++;
      return 2;
    });

    expect(await p2).toBe(2);
    releaseLeader(1);
    expect(await p1).toBe(1);
    expect(calls).toBe(2);
    expect(b.stats().deduplication!.hits).toBe(0);
  });

  it("byte-identical requests still dedup, regardless of property insertion order", async () => {
    const b = makeDedupBulkhead();
    let calls = 0;
    let releaseLeader!: (v: string) => void;

    const a: LLMRequest = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "same" }],
      max_tokens: 100,
    };
    // Structurally identical, different key insertion order at every level.
    const shuffled = JSON.parse(
      '{"max_tokens":100,"messages":[{"content":"same","role":"user"}],"model":"claude-sonnet-4"}',
    ) as LLMRequest;

    const p1 = b.run(a, () => {
      calls++;
      return new Promise<string>((r) => (releaseLeader = r));
    });
    const p2 = b.run(shuffled, async () => {
      calls++;
      return "never";
    });

    // The leader's fn starts only after its async acquire completes.
    await new Promise((r) => setTimeout(r, 0));
    releaseLeader("shared");
    expect(await p1).toBe("shared");
    expect(await p2).toBe("shared");
    expect(calls).toBe(1);
    expect(b.stats().deduplication!.hits).toBe(1);
  });

  it("dedupScope isolates callers: same request, different scopes never share a call", async () => {
    const b = makeDedupBulkhead();
    let calls = 0;
    let releaseA!: (v: string) => void;

    // Tenant A leader.
    const pA1 = b.run(req("same"), () => {
      calls++;
      return new Promise<string>((r) => (releaseA = r));
    }, { dedupScope: "tenant-A" });

    // Tenant B, identical request — must NOT receive tenant A's response.
    const pB = b.run(req("same"), async () => {
      calls++;
      return "B-result";
    }, { dedupScope: "tenant-B" });

    // Second tenant A caller — joins A's in-flight call.
    const pA2 = b.run(req("same"), async () => {
      calls++;
      return "never";
    }, { dedupScope: "tenant-A" });

    expect(await pB).toBe("B-result");
    releaseA("A-result");
    expect(await pA1).toBe("A-result");
    expect(await pA2).toBe("A-result");
    expect(calls).toBe(2);
    expect(b.stats().deduplication!.hits).toBe(1);
  });

  it("keyFn returning \"\" still opts out, in any scope", async () => {
    const b = makeDedupBulkhead({ deduplication: { keyFn: () => "" } });
    let calls = 0;
    let releaseLeader!: (v: number) => void;

    const p1 = b.run(req("same"), () => {
      calls++;
      return new Promise<number>((r) => (releaseLeader = r));
    }, { dedupScope: "s" });
    const p2 = b.run(req("same"), async () => {
      calls++;
      return 2;
    }, { dedupScope: "s" });

    expect(await p2).toBe(2);
    releaseLeader(1);
    expect(await p1).toBe(1);
    expect(calls).toBe(2);
    expect(b.stats().deduplication!.active).toBe(0);
  });

  it("custom keyFn composes with dedupScope", async () => {
    const b = makeDedupBulkhead({
      deduplication: { keyFn: () => "constant-key" },
    });
    let calls = 0;
    let releaseLeader!: (v: string) => void;

    // Same custom key, different scopes → separate calls.
    const p1 = b.run(req("x"), () => {
      calls++;
      return new Promise<string>((r) => (releaseLeader = r));
    }, { dedupScope: "A" });
    const p2 = b.run(req("y"), async () => {
      calls++;
      return "B";
    }, { dedupScope: "B" });

    expect(await p2).toBe("B");
    releaseLeader("A");
    expect(await p1).toBe("A");
    expect(calls).toBe(2);
  });
});

// ────────────────────────────────────────────
// Fix 2: follower timeout semantics
// ────────────────────────────────────────────

describe("dedup follower timeouts", () => {
  it("bulkhead-level timeoutMs does NOT cap a follower's wait on the shared call", async () => {
    const b = makeDedupBulkhead({ timeoutMs: 30, maxQueue: 10 });
    let releaseLeader!: (v: string) => void;

    const leader = b.run(req("same"), () =>
      new Promise<string>((r) => (releaseLeader = r)),
    );
    const follower = b.run(req("same"), async () => "never");

    // Far longer than the 30ms bulkhead default.
    await new Promise((r) => setTimeout(r, 100));
    releaseLeader("done");

    expect(await leader).toBe("done");
    expect(await follower).toBe("done"); // previously rejected "timeout" here
  });

  it("an explicitly passed per-call timeoutMs still caps the follower's wait", async () => {
    const b = makeDedupBulkhead();
    let releaseLeader!: (v: string) => void;

    const leader = b.run(req("same"), () =>
      new Promise<string>((r) => (releaseLeader = r)),
    );
    let followerErr: unknown;
    const follower = b
      .run(req("same"), async () => "never", { timeoutMs: 30 })
      .catch((e: unknown) => {
        followerErr = e;
        return "rejected";
      });

    await new Promise((r) => setTimeout(r, 100));
    releaseLeader("done");

    expect(await leader).toBe("done");
    expect(await follower).toBe("rejected");
    expect((followerErr as { reason?: string }).reason).toBe("timeout");
  });
});

// ────────────────────────────────────────────
// Fix 3: post-release UsageReport is truthful
// ────────────────────────────────────────────

describe("post-release usage snapshots", () => {
  it("reportUsage after release reports held: 0 (matches budget state)", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      tokenBudget: {
        budget: 10_000,
        estimator: () => ({ input: 100, maxOutput: 1000 }),
      },
    });
    const r = await b.acquire(req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    r.token.release({ input: 50, output: 50 });
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(0);

    const snap = r.token.reportUsage({ input: 60, output: 60 });
    expect(snap.held).toBe(0); // previously reported the stale 1100 hold
    expect(snap.reserved).toBe(1100); // historical reservation is still reported
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(0); // and no accounting happened
  });

  it("mid-flight reportUsage before release is unaffected (hold still tracked)", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      tokenBudget: {
        budget: 10_000,
        estimator: () => ({ input: 100, maxOutput: 1000 }),
      },
    });
    const r = await b.acquire(req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const snap = r.token.reportUsage({ input: 20, output: 5 });
    expect(snap.held).toBe(1020); // 20 + max(1000, 5)
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(1020);

    r.token.release();
    expect(b.stats().tokenBudget!.inFlightTokens).toBe(0);
  });
});
