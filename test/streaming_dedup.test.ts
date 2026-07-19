import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import {
  createLLMBulkhead,
  LLMBulkheadRejectedError,
  type LLMRequest,
  type LLMRejectReason,
} from "../src/index.js";

const req = (text = "q"): LLMRequest => ({
  messages: [{ role: "user", content: text }],
});

function makeDedupBulkhead(
  opts: Partial<Parameters<typeof createLLMBulkhead>[0]> = {},
) {
  return createLLMBulkhead({
    model: "claude-sonnet-4",
    maxConcurrent: 10,
    deduplication: true,
    ...opts,
  });
}

/** A fresh web ReadableStream emitting the given chunks. */
function makeStream(chunks: string[] = ["a", "b"]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += value;
  }
}

/**
 * Start a leader whose fn blocks until `resolveLeader` is called, then
 * attach a follower on the same request. Returns both promises plus the
 * leader trigger. `calls` counts actual fn executions.
 */
function leaderFollower<T>(
  b: ReturnType<typeof createLLMBulkhead>,
  request: LLMRequest,
  followerOpts: Parameters<ReturnType<typeof createLLMBulkhead>["run"]>[2] = {},
) {
  let calls = 0;
  let resolveLeaderInner!: (v: T) => void;
  let started!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  const leader = b.run(request, () => {
    calls++;
    started();
    return new Promise<T>((r) => (resolveLeaderInner = r));
  });
  const follower = b.run(
    request,
    async () => {
      calls++;
      return undefined as never;
    },
    followerOpts,
  );
  return {
    leader,
    follower,
    // fn runs a microtask after admission; defer until it has started
    // so resolveLeaderInner is assigned.
    resolveLeader: (v: T) => void startedP.then(() => resolveLeaderInner(v)),
    calls: () => calls,
  };
}

// ────────────────────────────────────────────
// Detection: followers must not receive single-consumer values
// ────────────────────────────────────────────

describe("dedup + streaming — single-consumer results are not shared by reference", () => {
  it("ReadableStream result: follower rejects with unshareable_result, leader gets the stream intact", async () => {
    const b = makeDedupBulkhead();
    const rejects: LLMRejectReason[] = [];
    b.on("reject", (p) => rejects.push(p.reason));

    const { leader, follower, resolveLeader, calls } = leaderFollower<
      ReadableStream<string>
    >(b, req());

    // Follower must be a dedup join, not a second call.
    expect(b.stats().deduplication!.hits).toBe(1);

    resolveLeader(makeStream(["x", "y"]));

    await expect(follower).rejects.toMatchObject({
      name: "LLMBulkheadRejectedError",
      code: "LLM_BULKHEAD_REJECTED",
      reason: "unshareable_result",
    });
    // Leader is unaffected and can consume its stream fully.
    expect(await readAll(await leader)).toBe("xy");
    expect(calls()).toBe(1);

    const stats = b.stats();
    expect(stats.llm.rejectedByReason.unshareable_result).toBe(1);
    expect(rejects).toEqual(["unshareable_result"]);
  });

  it("detection also applies on the signal/timeout wait path", async () => {
    const b = makeDedupBulkhead();
    const { follower, resolveLeader } = leaderFollower<ReadableStream<string>>(
      b,
      req(),
      { timeoutMs: 60_000 }, // forces the race-path wait, generous enough to never fire
    );
    resolveLeader(makeStream());
    await expect(follower).rejects.toMatchObject({
      reason: "unshareable_result",
    });
  });

  it("Node Readable and async iterables are detected; Response with a body is detected", async () => {
    // Direct-value detection, exercised through real follower delivery.
    const cases: Array<[string, unknown]> = [
      ["node readable", Readable.from(["a"])],
      [
        "async generator",
        (async function* () {
          yield "a";
        })(),
      ],
      ["response with body", new Response("hello")],
    ];
    for (const [label, value] of cases) {
      const b = makeDedupBulkhead();
      const { follower, resolveLeader } = leaderFollower<unknown>(
        b,
        req(label),
      );
      resolveLeader(value);
      await expect(follower, label).rejects.toMatchObject({
        reason: "unshareable_result",
      });
    }
  });

  it("safe results still share by reference: objects, arrays, strings, null, bodyless Response", async () => {
    const cases: Array<[string, unknown]> = [
      ["plain object", { id: "msg_1", content: [{ type: "text", text: "hi" }] }],
      ["array", [1, 2, 3]],
      ["string", "plain text completion"],
      ["null", null],
      ["response without body", new Response(null)],
    ];
    for (const [label, value] of cases) {
      const b = makeDedupBulkhead();
      const { leader, follower, resolveLeader, calls } = leaderFollower<unknown>(
        b,
        req(label),
      );
      resolveLeader(value);
      // Same reference delivered to both; one underlying call.
      expect(await follower, label).toBe(await leader);
      expect(calls(), label).toBe(1);
      expect(
        b.stats().llm.rejectedByReason.unshareable_result ?? 0,
        label,
      ).toBe(0);
    }
  });

  it("detection is shallow (pinned): a stream nested in a wrapper object is shared by reference", async () => {
    const b = makeDedupBulkhead();
    const { leader, follower, resolveLeader } = leaderFollower<{
      stream: ReadableStream<string>;
    }>(b, req());
    resolveLeader({ stream: makeStream() });
    // Documented limitation: only the direct value is inspected.
    expect(await follower).toBe(await leader);
  });
});

// ────────────────────────────────────────────
// shareResult — caller-supplied fan-out
// ────────────────────────────────────────────

describe("deduplication.shareResult — fan-out hook", () => {
  it("lets streaming dedup work: each follower receives an independent stream", async () => {
    // The hook re-issues a fresh stream per follower (tee/replay is the
    // caller's business; here a factory stands in for it).
    const b = makeDedupBulkhead({
      deduplication: {
        shareResult: () => makeStream(["s", "hared"]),
      },
    });

    let resolveLeader!: (v: ReadableStream<string>) => void;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const leader = b.run(req(), () => {
      started();
      return new Promise<ReadableStream<string>>((r) => (resolveLeader = r));
    });
    const f1 = b.run(req(), async () => makeStream());
    const f2 = b.run(req(), async () => makeStream());
    expect(b.stats().deduplication!.hits).toBe(2);

    const leaderStream = makeStream(["lead", "er"]);
    void startedP.then(() => resolveLeader(leaderStream));

    // Leader receives its original stream, untouched by the hook.
    const got = await leader;
    expect(got).toBe(leaderStream);
    expect(await readAll(got)).toBe("leader");
    // Followers each get their own independent stream.
    const [s1, s2] = await Promise.all([f1, f2]);
    expect(s1).not.toBe(s2);
    expect(await readAll(s1)).toBe("shared");
    expect(await readAll(s2)).toBe("shared");
    expect(b.stats().llm.rejectedByReason.unshareable_result ?? 0).toBe(0);
  });

  it("is applied to safe results too — general fan-out policy", async () => {
    const b = makeDedupBulkhead({
      deduplication: {
        shareResult: (r) => structuredClone(r),
      },
    });
    const { leader, follower, resolveLeader } = leaderFollower<{
      text: string;
    }>(b, req());
    resolveLeader({ text: "ok" });
    const l = await leader;
    const f = await follower;
    expect(f).toEqual(l);
    expect(f).not.toBe(l); // follower got a clone, leader the original
  });

  it("a throwing shareResult rejects that follower with the thrown error; leader unaffected", async () => {
    const boom = new Error("hook exploded");
    const b = makeDedupBulkhead({
      deduplication: {
        shareResult: () => {
          throw boom;
        },
      },
    });
    const { leader, follower, resolveLeader } = leaderFollower<string>(
      b,
      req(),
    );
    resolveLeader("fine");
    await expect(follower).rejects.toBe(boom);
    expect(await leader).toBe("fine");
    // Hook errors are the caller's own, not bulkhead rejections.
    expect(b.stats().llm.rejectedByReason.unshareable_result ?? 0).toBe(0);
  });

  it("composes with a custom keyFn", async () => {
    const b = makeDedupBulkhead({
      deduplication: {
        keyFn: (r) => JSON.stringify(r.messages),
        shareResult: () => "copy",
      },
    });
    const { leader, follower, resolveLeader } = leaderFollower<string>(
      b,
      req(),
    );
    resolveLeader("original");
    expect(await leader).toBe("original");
    expect(await follower).toBe("copy");
  });
});

// ────────────────────────────────────────────
// Per-call dedup: false
// ────────────────────────────────────────────

describe("run() dedup: false — per-call opt-out", () => {
  it("neither joins nor registers: two identical calls both execute", async () => {
    const b = makeDedupBulkhead();
    let calls = 0;
    let releaseLeader!: (v: number) => void;

    const p1 = b.run(
      req(),
      () => {
        calls++;
        return new Promise<number>((r) => (releaseLeader = r));
      },
      { dedup: false },
    );
    const p2 = b.run(
      req(),
      async () => {
        calls++;
        return 2;
      },
      { dedup: false },
    );

    expect(await p2).toBe(2);
    releaseLeader(1);
    expect(await p1).toBe(1);
    expect(calls).toBe(2);
    expect(b.stats().deduplication!.hits).toBe(0);
    expect(b.stats().deduplication!.active).toBe(0);
  });

  it("an opted-out call does not join an existing dedupable leader", async () => {
    const b = makeDedupBulkhead();
    let calls = 0;
    let releaseLeader!: (v: string) => void;

    const leader = b.run(req(), () => {
      calls++;
      return new Promise<string>((r) => (releaseLeader = r));
    });
    // Streaming route: opts out, so it must run independently even
    // though a matching call is in flight.
    const independent = b.run(
      req(),
      async () => {
        calls++;
        return "independent";
      },
      { dedup: false },
    );
    // A third, non-opted-out call still joins the leader.
    const follower = b.run(req(), async () => {
      calls++;
      return "never";
    });

    expect(await independent).toBe("independent");
    releaseLeader("led");
    expect(await leader).toBe("led");
    expect(await follower).toBe("led");
    expect(calls).toBe(2);
    expect(b.stats().deduplication!.hits).toBe(1);
  });

  it("dedup: true cannot enable dedup on a bulkhead with deduplication disabled", async () => {
    const b = createLLMBulkhead({
      model: "claude-sonnet-4",
      maxConcurrent: 10,
      // deduplication omitted
    });
    let calls = 0;
    let releaseLeader!: (v: number) => void;
    const p1 = b.run(
      req(),
      () => {
        calls++;
        return new Promise<number>((r) => (releaseLeader = r));
      },
      { dedup: true },
    );
    const p2 = b.run(
      req(),
      async () => {
        calls++;
        return 2;
      },
      { dedup: true },
    );
    expect(await p2).toBe(2);
    releaseLeader(1);
    await p1;
    expect(calls).toBe(2);
    expect(b.stats().deduplication).toBeUndefined();
  });
});

// ────────────────────────────────────────────
// Error type coherence
// ────────────────────────────────────────────

describe("unshareable_result error shape", () => {
  it("is an LLMBulkheadRejectedError without capacity detail (dedup-wait rejection)", async () => {
    const b = makeDedupBulkhead();
    const { follower, resolveLeader } = leaderFollower<ReadableStream<string>>(
      b,
      req(),
    );
    resolveLeader(makeStream());
    let caught: unknown;
    try {
      await follower;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LLMBulkheadRejectedError);
    const e = caught as LLMBulkheadRejectedError;
    expect(e.reason).toBe("unshareable_result");
    expect(e.detail).toBeUndefined();
    expect(e.message).toBe("LLM bulkhead rejected: unshareable_result");
  });
});
