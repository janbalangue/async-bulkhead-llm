---
title: How admission works
---

# How admission works

`async-bulkhead-llm` sits between your code and your LLM provider and answers
one question per request: **should this run right now?**

Every call goes through the same three checks, in this order, and each one is
fail-fast — nothing is silently queued unless you explicitly configure a queue.

## 1. Concurrency

`maxConcurrent` is a hard ceiling on in-flight calls. When it is full, a
request is rejected with `concurrency_limit` — unless `maxQueue` is greater
than zero, in which case it waits for a slot (bounded by `maxQueue`, and by
`timeoutMs` if set). A full queue rejects with `queue_limit`.

`maxConcurrent: 0` is legal both at construction and at runtime. It is a
fail-closed posture: the process can open its listener and health endpoint
without admitting work, and a control plane can use it as a kill switch. A
zero-capacity instance rejects with `concurrency_limit`; it does not queue
unless `maxQueue` is explicitly greater than zero.

## 2. Token budget (optional)

If you configure `tokenBudget`, admission also reserves tokens. The
reservation is computed **before** the call runs, from the request itself:

```text
reserved = estimated input tokens + max output tokens
```

If the reservation does not fit in the remaining budget, the request is
rejected with `budget_limit`, before any bytes are sent.

The budget is a ceiling on tokens reserved *at the same time* — each
reservation is returned when its request completes — so it bounds how much
work is in flight, not how much you spend over time. It exists because
`maxConcurrent` cannot distinguish a small request from a very large one: ten
concurrent 100,000-token prompts and ten concurrent 500-token prompts look
identical to a slot count. It is not a spend cap and does not track
cumulative usage.

The reservation is an estimate, deliberately. See
[Token budget and estimation](token-budget.md) for how it is calculated, how
to replace the estimator, and how the reservation is corrected afterwards
from real usage.

## 3. Admission class (optional)

If you configure `admissionClasses`, the request must also satisfy its class
policy — floors, ceilings, or both — in addition to the global limits above.
See [Admission classes](admission-classes.md).

## What happens on success

A successful admission produces a `LLMToken` (from `acquire()`) or an
`LLMRunContext` (passed to your `run()` callback). Both carry:

- `admissionId` — a stable UUID for this execution, for tracing and
  correlation.
- `limitRevision` — the exact immutable limit snapshot that authorized the
  request. A concurrent reconfiguration cannot relabel work that was
  evaluated under an earlier snapshot.
- `reservation` — the exact evaluated reservation, or `null` when token
  budgeting is disabled.
- `admissionClass` — the selected policy class, when classes are configured.

Capacity is returned when the request completes. If you supply actual usage,
the unused portion of the reservation is refunded immediately.

## What happens on rejection

`run()` throws `LLMBulkheadRejectedError`; `acquire()` returns
`{ ok: false, reason, detail? }`. Both carry a capacity snapshot in `detail`
— slots, queue, and priority-adjusted budget numbers — so a gateway can emit
an informative 429 or 503.

No `Retry-After` is fabricated: a fail-fast bulkhead has no honest ETA.

```ts
type LLMRejectReason =
  | 'concurrency_limit'
  | 'queue_limit'
  | 'budget_limit'
  | 'timeout'
  | 'aborted'
  | 'shutdown'
  | 'unshareable_result';
```

## `run()` vs `acquire()`

`run()` handles acquire and release for you and is what you want most of the
time. `acquire()` gives you the token and makes release your responsibility —
use it when the work does not fit inside a single callback, for example when
you must take an external lease first.

```ts
const r = await bulkhead.acquire(request);

if (!r.ok) {
  return respond503(r.reason);
}

try {
  const response = await callLLM(request);
  return response;
} finally {
  r.token.release({
    input:  response.usage.input_tokens,
    output: response.usage.output_tokens,
  });
}
```

Deduplication applies to `run()` only — `acquire()` never deduplicates.

## Profiles

Two built-in presets cover the common cases. Explicit options always override
preset defaults.

```ts
// Interactive — fail-fast, no waiting (default)
const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 10,
  profile:       'interactive',
});

// Batch — bounded queue, 30s timeout
const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 4,
  profile:       'batch',
});

// Escape hatch — plain object
const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 4,
  profile:       { maxQueue: 5, timeoutMs: 5_000 },
});
```

## Cancellation

```ts
const ac = new AbortController();

await bulkhead.run(
  request,
  async (signal) => callLLM(request, { signal }),
  { signal: ac.signal },
);

ac.abort();
```

Bound waiting time:

```ts
await bulkhead.run(request, async () => callLLM(request), { timeoutMs: 5_000 });
```

## Graceful shutdown

```ts
bulkhead.close();        // stop admission, reject pending waiters
await bulkhead.drain();  // wait for in-flight work to finish
```

`close()` is synchronous, idempotent, and irreversible. `drain()` resolves
when base concurrency, pending waiters, and LLM token settlement all reach
zero. Returning a borrowed local slot with `abandonBorrowedConcurrency()` does
not settle the admission. If a manual `acquire()` caller abandons that slot but
never calls `release()`, no-timeout `drain()` intentionally keeps waiting.

With a deadline, `drain()` always *resolves* — never rejects — with what
happened:

```ts
bulkhead.close();
const result = await bulkhead.drain({ timeoutMs: 10_000 });
if (!result.drained) {
  log.warn("abandoning shutdown wait", {
    inFlight: result.inFlight,
    pending: result.pending,
  });
}
```

The deadline never cancels or interrupts in-flight work and leaves the
bulkhead's accounting untouched — work that finishes later still releases
normally. It exists so a shutdown path can log what it is abandoning and
proceed, instead of parking forever behind one stuck upstream stream.
`timeoutMs: 0` is an immediate "is it drained right now?" snapshot.

## Design boundaries

This library enforces backpressure at the boundary of your LLM calls. It does
not replace higher-level concerns:

- **Retries** — compose a retry library around the bulkhead, not inside it
- **Cost accounting** — use provider response metadata; estimation here is for
  gating only
- **Distributed rate limiting** — use a shared token bucket; bulkheads are
  per-process
- **Model selection** — route above the bulkhead layer; each bulkhead instance
  is model-specific

Token estimation is deliberately approximate. The refund mechanism improves
budget utilization but does not make estimation exact — it corrects after the
fact based on actual usage.
