import { describe, expect, it } from "vitest";
import {
  createLLMBulkhead,
  LLMBulkheadRejectedError,
  type LLMAcquireResult,
  type LLMRequest,
} from "../src/index.js";

/**
 * Calls that start in the same tick must get the same answers as the same
 * calls made one at a time. A granted concurrency slot belongs to its
 * class from the moment it is granted, so a call that sits inside its
 * class floor is never counted as a borrower of shared capacity.
 */

const request: LLMRequest = {
  messages: [{ role: "user", content: "same-tick admission" }],
  max_tokens: 10,
};

/** 4 slots: 2 protected for premium, 2 shared. */
function floored(maxConcurrent = 4, maxQueue = 0) {
  return createLLMBulkhead({
    model: "gpt-4o",
    maxConcurrent,
    maxQueue,
    admissionClasses: {
      defaultClass: "standard",
      classes: {
        premium: { protectedConcurrent: 2 },
        standard: {},
      },
    },
  });
}

const outcome = (result: LLMAcquireResult): string =>
  result.ok
    ? "admitted"
    : `${result.reason}/${result.detail.constraint ?? "none"}`;

function releaseAll(results: LLMAcquireResult[]): void {
  for (const result of results) {
    if (result.ok) result.token.release();
  }
}

describe("same-tick admission under class floors", () => {
  it("admits a mixed burst that capacity covers", async () => {
    const b = floored();
    const results = await Promise.all(
      ["premium", "premium", "standard", "standard"].map((admissionClass) =>
        b.acquire(request, { admissionClass }),
      ),
    );

    expect(results.map(outcome)).toEqual([
      "admitted",
      "admitted",
      "admitted",
      "admitted",
    ]);
    expect(
      results.map((result) => result.ok && result.resources.borrowedConcurrency),
    ).toEqual([false, false, true, true]);
    expect(b.stats().admissionClasses!.shared).toMatchObject({
      inFlight: 2,
      availableConcurrent: 0,
    });
    releaseAll(results);
  });

  it("gives the same answers in every arrival order", async () => {
    const orders = [
      ["standard", "premium", "standard", "premium"],
      ["standard", "standard", "premium", "premium"],
      ["premium", "standard", "premium", "standard"],
    ];
    for (const order of orders) {
      const b = floored();
      const results = await Promise.all(
        order.map((admissionClass) => b.acquire(request, { admissionClass })),
      );
      expect(results.map(outcome), order.join(",")).toEqual([
        "admitted",
        "admitted",
        "admitted",
        "admitted",
      ]);
      releaseAll(results);
    }
  });

  it("admits the same burst through run()", async () => {
    const b = floored();
    const settled = await Promise.allSettled(
      ["premium", "premium", "standard", "standard"].map((admissionClass) =>
        b.run(request, async () => admissionClass, { admissionClass }),
      ),
    );

    expect(settled.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    expect(
      settled.some(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof LLMBulkheadRejectedError,
      ),
    ).toBe(false);
  });

  it("still keeps a floor free when borrowers arrive first", async () => {
    const b = floored();
    const results = await Promise.all(
      ["standard", "standard", "standard", "standard", "premium", "premium"].map(
        (admissionClass) => b.acquire(request, { admissionClass }),
      ),
    );

    expect(results.map(outcome)).toEqual([
      "admitted",
      "admitted",
      "concurrency_limit/admission_class_protection",
      "concurrency_limit/admission_class_protection",
      "admitted",
      "admitted",
    ]);
    expect(b.stats().bulkhead.inFlight).toBe(4);
    releaseAll(results);
  });

  it("reports advisory reads correctly before the acquire is awaited", async () => {
    // 3 slots: 2 protected for premium, 1 shared.
    const b = floored(3);
    const pending = b.acquire(request, { admissionClass: "premium" });

    expect(b.stats().admissionClasses!.shared).toMatchObject({
      inFlight: 0,
      availableConcurrent: 1,
    });
    expect(b.stats().admissionClasses!.classes.premium).toMatchObject({
      inFlight: 1,
      protectedConcurrentInUse: 1,
      borrowedConcurrent: 0,
    });
    expect(
      b.wouldAdmit(request, { admissionClass: "standard" }),
    ).toMatchObject({ admit: true });

    const first = await pending;
    const second = b.acquire(request, { admissionClass: "premium" });
    const standard = b.acquire(request, { admissionClass: "standard" });
    expect(
      b.wouldAdmit(request, { admissionClass: "standard" }),
    ).toMatchObject({ admit: false });

    releaseAll([first, await second, await standard]);
    expect(b.stats().bulkhead.inFlight).toBe(0);
  });

  it("credits queued waiters that are granted together", async () => {
    // Two standard calls fill an unfloored bulkhead; a standard and a
    // premium call queue behind them.
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 2,
      maxQueue: 2,
      admissionClasses: {
        defaultClass: "standard",
        classes: { premium: {}, standard: {} },
      },
    });
    const running = await Promise.all([
      b.acquire(request, { admissionClass: "standard" }),
      b.acquire(request, { admissionClass: "standard" }),
    ]);
    const queuedStandard = b.acquire(request, { admissionClass: "standard" });
    const queuedPremium = b.acquire(request, { admissionClass: "premium" });
    expect(b.stats().bulkhead.pending).toBe(2);

    // 5 slots, 2 protected for premium, 3 shared: the two running standard
    // calls and the queued one fit in shared, the premium call in its floor.
    b.applyLimits({
      revision: 1,
      maxConcurrent: 5,
      maxQueue: 2,
      admissionClasses: {
        premium: { protectedConcurrent: 2 },
        standard: {},
      },
    });
    expect(b.stats().admissionClasses!.shared).toMatchObject({
      inFlight: 3,
      availableConcurrent: 0,
    });

    const granted = [await queuedStandard, await queuedPremium];
    expect(granted.map(outcome)).toEqual(["admitted", "admitted"]);
    expect(granted.map((result) => result.ok && result.limitRevision)).toEqual([
      1, 1,
    ]);
    expect(
      granted.map((result) => result.ok && result.resources.borrowedConcurrency),
    ).toEqual([true, false]);
    releaseAll([...running, ...granted]);
  });

  it("frees the slot of a queued waiter that no longer fits", async () => {
    const b = createLLMBulkhead({
      model: "gpt-4o",
      maxConcurrent: 2,
      maxQueue: 2,
      admissionClasses: {
        defaultClass: "standard",
        classes: { premium: {}, standard: {} },
      },
    });
    const running = await Promise.all([
      b.acquire(request, { admissionClass: "standard" }),
      b.acquire(request, { admissionClass: "standard" }),
    ]);
    const queuedStandard = b.acquire(request, { admissionClass: "standard" });
    const queuedPremium = b.acquire(request, { admissionClass: "premium" });

    // 4 slots, 2 protected for premium, 2 shared: shared is already full
    // with the two running calls, so the queued standard call must be
    // rejected without being counted as a borrower in the meantime.
    b.applyLimits({
      revision: 1,
      maxConcurrent: 4,
      maxQueue: 2,
      admissionClasses: {
        premium: { protectedConcurrent: 2 },
        standard: {},
      },
    });
    expect(b.stats().admissionClasses!.shared).toMatchObject({ inFlight: 2 });
    expect(b.stats().admissionClasses!.classes.standard!.inFlight).toBe(2);

    const granted = [await queuedStandard, await queuedPremium];
    expect(granted.map(outcome)).toEqual([
      "concurrency_limit/admission_class_protection",
      "admitted",
    ]);
    expect(b.stats().bulkhead.inFlight).toBe(3);
    releaseAll([...running, ...granted]);
    expect(b.stats().bulkhead.inFlight).toBe(0);
  });
});
