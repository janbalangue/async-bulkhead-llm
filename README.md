# async-bulkhead-llm

**Decide whether an LLM call should run — before it runs.**

[![npm](https://img.shields.io/npm/v/async-bulkhead-llm.svg)](https://www.npmjs.com/package/async-bulkhead-llm)
[![CI](https://github.com/janbalangue/async-bulkhead-llm/actions/workflows/ci.yml/badge.svg)](https://github.com/janbalangue/async-bulkhead-llm/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/async-bulkhead-llm.svg)](https://github.com/janbalangue/async-bulkhead-llm/blob/main/LICENSE)

📖 **[Full documentation →](https://janbalangue.github.io/async-bulkhead-llm/)**

---

## What it does

You wrap your LLM calls in a bulkhead. Before each call runs, the bulkhead
decides whether it *should* run — based on how many calls are already in
flight and how many tokens are already committed. If the answer is no, you get
a fast, typed rejection instead of a request that piles onto an already
saturated provider.

That's it. It's one decision, made in-process, in microseconds, before any
bytes leave your service.

```ts
await bulkhead.run(request, () => callYourProvider(request));
//     ^ throws LLMBulkheadRejectedError instead of making things worse
```

## Should you use it?

**Probably yes if:** you call an LLM provider from a service that takes
concurrent traffic, and you've either already watched a burst turn into a 429
storm or a saturation cascade — or you'd rather not.

**Probably not if:** you're building a CLI, a notebook, or anything where one
request happens at a time. There's nothing to protect.

**Not a replacement for:** LangChain (orchestration), your provider SDK (the
actual calls), or a retry library (what happens after a failure). This sits
underneath all of them and answers a different question. See
[How it compares](guides/comparison.md).

## Install

```bash
npm install async-bulkhead-llm
```

Node.js 20+. ESM and CommonJS. TypeScript types included. One dependency
([`async-bulkhead-ts`](https://github.com/janbalangue/async-bulkhead-ts)).

## Quick start

```ts
import { createLLMBulkhead, LLMBulkheadRejectedError } from 'async-bulkhead-llm';

const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 10,
});

const request = {
  messages:   [{ role: 'user', content: 'Summarise this document...' }],
  max_tokens: 1024,
};

try {
  const result = await bulkhead.run(request, async () => {
    return callYourLLMProvider(request);
  });
} catch (err) {
  if (err instanceof LLMBulkheadRejectedError) {
    // Shed on purpose. err.reason tells you which limit was hit.
    return respond503(err.reason);
  }
  throw err;
}
```

Ten calls run at once. The eleventh is rejected immediately with
`reason: 'concurrency_limit'` — it does not wait, and it does not reach your
provider. That is the whole idea: **fail fast beats fail slow.**

If you'd rather queue than shed, add `maxQueue: 20`. If you want queued
callers to give up after a while, add `timeoutMs: 5_000`. Both are off by
default, deliberately.

## Limit tokens, not just requests

`maxConcurrent` counts requests. It cannot tell a 500-token request from a
100,000-token one — ten of each look identical to it. `tokenBudget` adds the
second dimension:

```ts
const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 10,
  tokenBudget:   { budget: 200_000 },
});
```

Each request now also reserves `estimated input + max_tokens` before it runs.
When the budget is committed, further requests are rejected with
`budget_limit`.

**This is an in-flight ceiling, not a spend cap.** The budget limits how many
tokens may be reserved *at the same time*; every reservation is returned when
its request completes. A 200,000-token budget does not mean you will spend
200,000 tokens — it means no more than that much work is ever committed at
once. It is a load-shedding control, not a billing control.

Reservations are estimates, so give the budget back when you know the truth:

```ts
await bulkhead.run(request, () => callLLM(request), {
  getUsage: (response) => ({
    input:  response.usage.input_tokens,
    output: response.usage.output_tokens,
  }),
});
```

The unused portion returns to the in-flight budget immediately. Most calls use
far fewer output tokens than `max_tokens`, so this frees real admission
capacity.

→ [Token budget and estimation](guides/token-budget.md)

## Handling rejections

Every rejection is typed and carries a capacity snapshot, so you can return
something useful instead of a generic 500:

```ts
const r = await bulkhead.acquire(request);

if (!r.ok) {
  // r.reason: 'concurrency_limit' | 'queue_limit' | 'budget_limit'
  //         | 'timeout' | 'aborted' | 'shutdown'
  // r.detail: slots, queue depth, priority-adjusted budget numbers
  return respond429(r.reason, r.detail);
}
```

No `Retry-After` is fabricated — a fail-fast bulkhead has no honest ETA. If
you need one, your gateway knows more than the bulkhead does.

## Watching it work

```ts
const s = bulkhead.stats();
s.bulkhead.inFlight;              // slots in use
s.llm.rejectedByReason;           // why you're shedding
s.tokenBudget?.available;         // budget headroom

bulkhead.on('reject', ({ reason, detail }) => metrics.increment(reason));
```

→ [Stats and events](guides/telemetry.md)

## Shutting down cleanly

```ts
// In your SIGTERM handler:
bulkhead.close();                             // stop admitting
await bulkhead.drain({ timeoutMs: 10_000 });  // wait, but not forever
```

`drain()` with a deadline always resolves and tells you what it abandoned, so
one stuck upstream stream can't hold your deploy hostage.

---

## Documentation

| Guide | What's in it |
|---|---|
| [How admission works](guides/concepts.md) | The decision path, `run()` vs `acquire()`, profiles, cancellation, shutdown |
| [Token budget and estimation](guides/token-budget.md) | Reservations, refunds, estimators, adaptive calibration, priority reserve |
| [Streaming and reconciliation](guides/streaming.md) | `reportUsage()`, progressive holds, ordered usage events |
| [Admission classes](guides/admission-classes.md) | Per-class floors and ceilings, shared capacity, borrowing |
| [Runtime limits and reconfiguration](guides/runtime-limits.md) | `applyLimits()`, revisions, fail-closed startup, kill switch |
| [Observe mode](guides/observe-mode.md) | Measure a policy before you enforce it |
| [Deduplication](guides/deduplication.md) | In-flight dedup, tenant scoping, streaming results |
| [Gateway integration](guides/gateway-integration.md) | `wouldAdmit()`, admission IDs, external leases, control planes |
| [Stats and events](guides/telemetry.md) | Every counter and every event payload |
| [How it compares](guides/comparison.md) | Against LangChain, p-limit, cockatiel, and raw SDKs |
| [Migration](guides/migration.md) | Upgrade notes for every release since v2 |

The **[full API reference](https://janbalangue.github.io/async-bulkhead-llm/)**
is generated from the source types on every push to `main`, so it is never out
of date with the code. Release-by-release detail lives in the
[changelog](./CHANGELOG.md).

## What it deliberately doesn't do

- **No retries.** Compose a retry library *around* the bulkhead, not inside it.
- **No provider SDK.** Bring your own client.
- **No distributed coordination.** Bulkheads are per-process. Partition the
  budget per replica, or coordinate above this layer.
- **No cost accounting or spend caps.** Token estimation is for load-shedding,
  not billing. Nothing here tracks cumulative spend or stops you reaching a
  dollar figure.

Each of those is a deliberate boundary, not a missing feature. A bulkhead that
also retried would defeat its own purpose.

## Compatibility

- **Node.js:** 20+
- **Module formats:** ESM and CommonJS
- **Types:** shipped, generated from source
- **Public API:** only the package entry point. Deep imports into `src/`
  internals are not supported.

## Contributing and security

Issues and pull requests are welcome at
[github.com/janbalangue/async-bulkhead-llm](https://github.com/janbalangue/async-bulkhead-llm/issues).
For security reports, see the
[security policy](https://github.com/janbalangue/async-bulkhead-llm/security/policy).

## License

Apache License 2.0 © 2026
