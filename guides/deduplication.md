---
title: Deduplication
---

# Deduplication

Identical in-flight requests can share a single LLM call.

```ts
const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 10,
  deduplication: true,
});

const [r1, r2] = await Promise.all([
  bulkhead.run(request, async () => callLLM(request)),
  bulkhead.run(request, async () => callLLM(request)), // deduped
]);
```

Deduplication applies to `run()` only — `acquire()` never deduplicates.

## The default key

A key-order-stable serialization of the **entire request object**, SHA-256
hashed before storage (the in-flight map never retains prompt text). Any own
enumerable property difference — `temperature`, `tools`, `system`, not just
`messages` / `max_tokens` / `model` — prevents conflation. The tradeoff:
volatile per-request fields (request IDs, timestamps) also defeat
deduplication; supply a `keyFn` that omits them if your requests carry such
fields.

```ts
deduplication: {
  keyFn: (request) => myStableKey(request.messages),
}
```

Return `""` from `keyFn` to opt a specific request out.

## Multi-tenant callers

The default key has no tenant dimension — two tenants sending byte-identical
requests would share one response. Pass a per-call `dedupScope` to isolate
them; requests deduplicate only within the same scope:

```ts
bulkhead.run(request, callLLM, { dedupScope: apiKeyId });
```

Admission classes partition deduplication automatically, but `dedupScope`
remains required when tenants inside the same class must not share results.

## Cancellation of shared calls

When a request joins an existing in-flight call through deduplication, the
underlying LLM call is shared and is not cancelled by later callers. Each
deduped caller still gets its own `AbortSignal`, and an *explicitly passed*
per-call `timeoutMs` caps its wait on the shared call: aborting or timing out
that caller rejects only that caller's `run()` promise while the shared work
continues for the original caller and any other waiters. The bulkhead-level
`timeoutMs` default does **not** apply to this wait — it is a queue-wait
timeout, and a follower is waiting on a call that is already running, not
queued.

## Streaming results

Dedup shares the leader's resolved value with every follower **by reference**.
For plain JSON results that is correct. For streaming results it is not: a
`ReadableStream`, Node `Readable`, async iterable, or `Response` body can only
be consumed once — whichever caller reads first wins, and the rest get a
locked or drained stream.

The bulkhead refuses to do that silently. When a follower's shared result is
detected as single-consumer, that follower rejects with
`LLMBulkheadRejectedError("unshareable_result")`. The **leader always receives
its original result unaffected**. Detection is shallow — only the result value
itself is inspected, so a stream nested inside a wrapper object is still
shared by reference.

There are two ways to make streaming and dedup coexist.

### 1. `shareResult` — make sharing work

A fan-out hook called once per follower with the leader's result; its return
value is what that follower receives. It runs for *every* follower delivery
(safe results included) and bypasses the single-consumer detection — the hook
owns fan-out policy. A throwing hook rejects that follower with the thrown
error; leader and other followers are unaffected.

```ts
// fetch Response: each follower gets an independent clone.
// clone() is called at resolution time, before any body is consumed.
deduplication: {
  shareResult: (r) => (r as Response).clone(),
}
```

For raw streams, `tee()`/replay choreography is provider-specific, which is
why this is a hook rather than built in.

### 2. `dedup: false` — skip dedup for streaming calls

A per-call opt-out on `run()` options: the call neither joins an existing
in-flight call nor registers as joinable. Use it on streaming routes of a
bulkhead where dedup is otherwise useful, instead of encoding the exemption in
a bulkhead-wide `keyFn`. (`dedup: true` cannot enable deduplication when it is
disabled at the bulkhead level.)

```ts
bulkhead.run(request, streamFromProvider, { dedup: false });
```
