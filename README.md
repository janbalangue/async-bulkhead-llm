# async-bulkhead-llm

Fail-fast **admission control for LLM workloads**, built on [async-bulkhead-ts](https://github.com/janbalangue/async-bulkhead-ts).

Designed for services that need to enforce **cost ceilings, concurrency limits, and backpressure** at the boundary of their LLM calls — before request fan-out, before hitting provider rate limits, before saturation cascades.

---

## Features

- ✅ Hard **max in-flight** concurrency (`maxConcurrent`)
- ✅ **Token-aware admission** — reserves against estimated input + max output tokens
- ✅ **Token refund** — reclaim unused budget capacity from actual usage post-completion
- ✅ **Model-aware estimation** — per-model character ratios for known providers
- ✅ **Per-request model** — mixed-model routing through a single bulkhead
- ✅ **Multimodal content** — text blocks counted, non-text blocks ignored
- ✅ **Fail-fast by default** — shed load early, never silently queue
- ✅ **Opinionated profiles** — `'interactive'` and `'batch'` presets with escape hatch
- ✅ **In-flight deduplication** — identical requests share one LLM call; hashed keys, whole-request equality
- ✅ **Custom dedup key + per-tenant scope** — bring your own equivalence function; `dedupScope` isolates tenants
- ✅ **Event hooks** — `on('admit' | 'reject' | 'release' | 'dedup', fn)`
- ✅ **Graceful shutdown** — `close()` + `drain()`
- ✅ Optional **AbortSignal** and **timeout** cancellation
- ✅ `bulkhead.run(request, fn)` — acquire + release handled automatically
- ✅ Zero dependencies beyond `async-bulkhead-ts`
- ✅ ESM + CJS
- ✅ Node.js **20+**

Non-goals (by design):

- ❌ No retries
- ❌ No provider SDK — bring your own client
- ❌ No distributed coordination
- ❌ No cost accounting — token estimation is for load-shedding only

---

## Competitive Matrix (LLM Workloads)

| Capability / Library | async-bulkhead-llm | LangChain / LlamaIndex | OpenAI SDK (raw) | p-limit / Bottleneck | cockatiel / polly |
|---------------------|--------------------|------------------------|------------------|---------------------|-------------------|
| **Primary goal** | LLM admission control (cost + concurrency) | Orchestration / pipelines | API client | Concurrency / scheduling | Resilience patterns |
| **Fail-fast by default** | ✅ Yes | ❌ No | ❌ No | ❌ No | ⚠️ Depends |
| **Token-aware admission** | ✅ Yes (pre-admission budget) | ❌ No | ❌ No | ❌ No | ❌ No |
| **Token refund (post-call correction)** | ✅ Yes | ❌ No | ❌ No | ❌ No | ❌ No |
| **Cost ceiling enforcement** | ✅ Yes (`tokenBudget`) | ❌ No | ❌ No | ❌ No | ❌ No |
| **Concurrency limits** | ✅ Yes | ⚠️ Indirect | ❌ No | ✅ Yes | ⚠️ Indirect |
| **Bounded queue (optional)** | ✅ Yes | ⚠️ Internal | ❌ No | ✅ Yes | ⚠️ Indirect |
| **Fail-fast overload handling** | ✅ Core feature | ❌ No | ❌ No | ❌ No | ⚠️ Indirect |
| **In-flight deduplication** | ✅ Yes | ⚠️ Partial caching | ❌ No | ❌ No | ❌ No |
| **Custom dedup key** | ✅ Yes | ❌ No | ❌ No | ❌ No | ❌ No |
| **Model-aware estimation** | ✅ Yes | ❌ No | ❌ No | ❌ No | ❌ No |
| **Per-request model routing** | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No | ❌ No |
| **Multimodal-aware estimation** | ✅ Yes (text-only counted) | ❌ No | ❌ No | ❌ No | ❌ No |
| **Abort / timeout (admission)** | ✅ Yes | ⚠️ Partial | ⚠️ SDK-level | ⚠️ Partial | ✅ Yes |
| **Event hooks (metrics/logging)** | ✅ Yes | ❌ No | ❌ No | ❌ No | ⚠️ Limited |
| **Graceful shutdown (drain/close)** | ✅ Yes | ❌ No | ❌ No | ❌ No | ❌ No |
| **Retries / fallback** | ❌ No | ⚠️ Yes | ❌ No | ❌ No | ✅ Yes |
| **LLM orchestration (chains/agents)** | ❌ No | ✅ Yes | ❌ No | ❌ No | ❌ No |

---

### Quick positioning

- **LangChain / LlamaIndex** → *what to run* (orchestration)  
- **OpenAI SDK** → *how to call the provider*  
- **p-limit / Bottleneck** → *how many tasks run*  
- **cockatiel / polly** → *what happens after failure*  
- **async-bulkhead-llm** → **whether a request should run at all**

---

### Rule of thumb

> If you want to **build LLM pipelines**, use LangChain.  
> If you want to **protect your system and budget under load**, use async-bulkhead-llm.

---

### Key differentiator

> **Most LLM tooling optimizes execution.  
> async-bulkhead-llm optimizes survival under load.**

It enforces:

- **concurrency ceilings**
- **token budget ceilings**
- **fail-fast admission**

before a request ever reaches your provider.

---

## Install

```bash
npm install async-bulkhead-llm
```

---

## Quick Start

```ts
import { createLLMBulkhead } from 'async-bulkhead-llm';

const bulkhead = createLLMBulkhead({
  model:          'claude-sonnet-4',
  maxConcurrent:  10,
});

const request = {
  messages: [{ role: 'user', content: 'Summarise this document...' }],
  max_tokens: 1024,
};

const result = await bulkhead.run(request, async () => {
  return callYourLLMProvider(request);
});
```

---

## What's New in v3.2 — Gateway readiness

v3.2 adds the admission-control primitives an AI gateway needs, all additive:

### Streaming budget enforcement (`reportUsage`)

Report *cumulative* usage as stream events arrive. Input over-estimates are
refunded to the budget immediately; output overruns expand the hold (blocking
new admissions until the runaway stream releases). The returned snapshot lets
a gateway decide to abort a stream:

```ts
await bulkhead.run(request, async (signal, ctx) => {
  for await (const event of providerStream(request, signal)) {
    const snap = ctx!.reportUsage({
      input: event.usage.input_tokens,
      output: event.usage.output_tokens, // cumulative
    });
    if (snap.outputRemaining === 0) {
      // stream has consumed its entire output reservation — abort policy here
    }
  }
  return final;
});
```

If `release()` is called without usage, the last reported usage drives the
final refund. Reports are clamped monotonically non-decreasing per field.

### Priority admission (`highPriorityReserve`)

Reserve budget headroom that only `priority: "high"` requests may use, so
interactive traffic keeps admitting when batch traffic saturates the pool:

```ts
const bulkhead = createLLMBulkhead({
  model: "claude-sonnet-4",
  maxConcurrent: 50,
  tokenBudget: { budget: 200_000, highPriorityReserve: 40_000 },
});

await bulkhead.run(request, callLLM, { priority: "high" });
```

### Rejection detail

Failed acquisitions, `reject` events, and `LLMBulkheadRejectedError` now carry
a capacity snapshot (`detail`) — slots, queue, and priority-adjusted budget
numbers — so gateways can emit informative 429/503 responses. No fabricated
`Retry-After` is provided: a fail-fast bulkhead has no honest ETA.

### `wouldAdmit(request, { priority })`

Advisory dry-run for routing decisions ("try another model pool"). It reserves
nothing and is inherently racy — never treat `true` as a guarantee.

### Scope note

This library remains single-process by design. Distributed budget
coordination across gateway replicas requires shared state and an async
admission path; it is out of scope here. For multi-replica deployments,
partition the budget per replica or coordinate above this layer.

---

## What's New in v3

### Stats are now namespaced

`bulkhead.stats()` now separates:

- underlying bulkhead stats → stats().bulkhead
- LLM-layer request stats → stats().llm

This avoids conflating base bulkhead slot lifecycle with higher-level LLM request outcomes
such as 'budget_limit'.

---

## What's New in v2

### Token Refund

v1 reserved `input + maxOutput` tokens and held that full reservation until release. Most calls use far fewer output tokens than `max_tokens`. v2 reclaims the difference:

```ts
// Via run() — extract usage from your provider's response
const result = await bulkhead.run(
  request,
  async () => callLLM(request),
  {
    getUsage: (response) => ({
      input:  response.usage.input_tokens,
      output: response.usage.output_tokens,
    }),
  },
);

// Via acquire() — pass usage at release time
const r = await bulkhead.acquire(request);
if (r.ok) {
  try {
    const response = await callLLM(request);
    return response;
  } finally {
    r.token.release({
      input:  response.usage.input_tokens,
      output: response.usage.output_tokens,
    });
  }
}
```

When usage is reported, the refund is `reserved - (actual input + actual output)`. Budget capacity is returned immediately. Without usage, behavior is identical to v1.

### Multimodal Content

`content` may now be a plain string or an array of content blocks:

```ts
const request = {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this image...' },
      { type: 'image', source: { type: 'base64', data: '...' } },
    ],
  }],
  max_tokens: 1024,
};
```

Built-in estimators extract text from text blocks and ignore non-text blocks. Token estimates for multimodal requests are a lower bound. Provide a custom `estimator` for accurate multimodal estimation.

### Per-Request Model

Route multiple models through a single bulkhead with accurate per-model estimation:

```ts
const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',  // default for estimation
  maxConcurrent: 20,
  tokenBudget:   { budget: 500_000 },
});

// Estimator uses request.model when present
await bulkhead.run(
  { model: 'claude-haiku-4-5', messages, max_tokens: 512 },
  async () => callLLM(request),
);
```

### Custom Dedup Key

```ts
const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 10,
  deduplication: {
    keyFn: (request) => {
      // Your own equivalence logic
      return hash(request.messages);
    },
  },
});
```

The default key now includes `messages`, `max_tokens`, and `model`. Return an empty string to opt a specific request out.

### Event Hooks

```ts
const off = bulkhead.on('release', ({ reservedTokens, refundedTokens, usage }) => {
  metrics.histogram('llm.tokens.reserved', reservedTokens);
  metrics.histogram('llm.tokens.refunded', refundedTokens);
});

// Later:
off(); // unsubscribe
```

Events: `'admit'`, `'reject'`, `'release'`, `'dedup'`.

### Graceful Shutdown

```ts
// In your SIGTERM handler:
bulkhead.close();       // reject all pending; block future admission
await bulkhead.drain(); // wait for in-flight work to complete
```

---

## Profiles

Two built-in presets cover the common cases. Explicit options always override preset defaults.

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

---

## Token Budget

```ts
const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 10,
  tokenBudget: {
    budget: 200_000,
  },
});
```

Token reservations are calculated pre-admission from `input + maxOutput`. Capacity is returned when each request completes. When `TokenUsage` is provided at release, the refund reclaims unused capacity immediately.

### How Estimation Works

The default estimator is `createModelAwareTokenEstimator` seeded with the bulkhead's `model`. It uses per-model character-to-token ratios for known model families, falling back to a flat `4.0` ratio for unknown models.

v2 checks `request.model` first (when present), then falls back to the bulkhead-level `defaultModel`.

Known model families: `claude-3-5-haiku`, `claude-3-5-sonnet`, `claude-3-*`, `claude-sonnet-4`, `claude-opus-4`, `claude-haiku-4`, `claude-*-4-5`, `gpt-4o`, `gpt-4-turbo`, `gpt-4.1`, `gpt-4`, `gpt-3.5`, `o1`, `o3`, `o4-mini`, `gemini-1.5`, `gemini-2`, `gemini-2.5`.

### Custom Estimator

```ts
import { Tiktoken } from 'tiktoken';

const enc = new Tiktoken(/* your model encoding */);

const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 10,
  tokenBudget: {
    budget:    200_000,
    estimator: (request) => ({
      input:     enc.encode(request.messages.map(m =>
        typeof m.content === 'string'
          ? m.content
          : m.content.filter(b => b.type === 'text').map(b => b.text).join('')
      ).join('')).length,
      maxOutput: request.max_tokens ?? 2_048,
    }),
  },
});
```

### Estimator Utilities

```ts
import {
  naiveTokenEstimator,
  createModelAwareTokenEstimator,
  extractTextLength,
} from 'async-bulkhead-llm';

// Flat 4.0 ratio, multimodal-safe
const est1 = naiveTokenEstimator(request);

// Per-model ratios
const estimate = createModelAwareTokenEstimator(
  { 'my-azure-deployment': 3.7 },
  {
    defaultModel:   'claude-sonnet-4',
    outputCap:      2_048,
    onUnknownModel: (model) => console.warn(`Unknown model: ${model}`),
  },
);

// Utility for multimodal content
const charCount = extractTextLength(message.content);
```

### Runtime Budget Adjustment

`setBudget(tokens)` mutates the token budget ceiling at runtime — useful for gateways that adjust cost limits based on external signals (billing tier changes, incident response, time-of-day throttling) without recreating the bulkhead.

```ts
const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 10,
  tokenBudget: { budget: 200_000 },
});

bulkhead.setBudget(300_000); // raise the ceiling
bulkhead.setBudget(50_000);  // shrink the ceiling
```

Semantics, pinned deliberately:

* **Raising takes effect immediately.** The very next `acquire()`/`run()`/`wouldAdmit()` call sees the new headroom — there is no caching to invalidate.
* **Lowering below `inFlightTokens` is legal — shrink by attrition.** No in-flight request is revoked or cancelled. New admissions reject with `"budget_limit"` until enough in-flight work releases to bring `stats().tokenBudget.inFlightTokens` back under the new ceiling. This is consistent with the library's existing overrun tolerance — `inFlightTokens` can already exceed `budget` via `reportUsage()` overrun, so an over-budget in-flight state is an established, intentional condition rather than an edge case.
* **Throws if `tokenBudget` was never configured at construction.** There is no ceiling to adjust, so an explicit error is raised instead of silently no-op'ing.
* **Validates `tokens` as a non-negative integer** (`0` is valid — it fully closes admission until either budget is raised or in-flight work drains and no further reservation exists).
* **Not re-validated against `highPriorityReserve`.** Construction requires `highPriorityReserve <= budget` (catches config typos), but `setBudget()` trusts the caller — a renewal-driven ledger grant is reality, and the bulkhead has no standing to refuse it even if it drops below the configured reserve. If that happens, the normal-priority ceiling (`budget - highPriorityReserve`) is clamped to `0`: normal-priority traffic is fully rejected with `"budget_limit"` while `priority: "high"` requests are still checked against the full (shrunk) budget and can keep admitting. This is the intended degraded behavior — protecting interactive traffic when capacity is scarcest is exactly what `highPriorityReserve` is for.


---

## Deduplication


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

**Default key (v3.4):** a key-order-stable serialization of the **entire
request object**, SHA-256 hashed before storage (the in-flight map never
retains prompt text). Any own enumerable property difference —
`temperature`, `tools`, `system`, not just `messages` / `max_tokens` /
`model` — prevents conflation. The tradeoff: volatile per-request fields
(request IDs, timestamps) also defeat deduplication; supply a `keyFn`
that omits them if your requests carry such fields.

Custom key:

```ts
deduplication: {
  keyFn: (request) => myStableKey(request.messages),
}
```

Return `""` from `keyFn` to opt a specific request out.

**Multi-tenant callers:** the default key has no tenant dimension — two
tenants sending byte-identical requests would share one response. Pass a
per-call `dedupScope` to isolate them; requests deduplicate only within
the same scope:

```ts
bulkhead.run(request, callLLM, { dedupScope: apiKeyId });
```

When a request joins an existing in-flight call through deduplication, the
underlying LLM call is shared and is not cancelled by later callers. Each
deduped caller still gets its own `AbortSignal`, and an *explicitly
passed* per-call `timeoutMs` caps its wait on the shared call: aborting
or timing out that caller rejects only that caller's `run()` promise while
the shared work continues for the original caller and any other waiters.
The bulkhead-level `timeoutMs` default does **not** apply to this wait —
it is a queue-wait timeout, and a follower is waiting on a call that is
already running, not queued.

---

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

---

## Manual Acquire / Release

```ts
const r = await bulkhead.acquire(request);

if (!r.ok) {
  // r.reason: 'concurrency_limit' | 'queue_limit' | 'budget_limit'
  //         | 'timeout' | 'aborted' | 'shutdown'
  return respond503(r.reason);
}

try {
  const response = await callLLM(request);
  return response;
} finally {
  // v2: pass usage for refund
  r.token.release({
    input:  response.usage.input_tokens,
    output: response.usage.output_tokens,
  });
}
```

---

## Handling Rejections

```ts
import { LLMBulkheadRejectedError } from 'async-bulkhead-llm';

try {
  await bulkhead.run(request, async () => callLLM(request));
} catch (err) {
  if (err instanceof LLMBulkheadRejectedError) {
    // err.reason: 'concurrency_limit' | 'queue_limit' | 'budget_limit'
    //           | 'timeout' | 'aborted' | 'shutdown'
    return respond503(`Shed: ${err.reason}`);
  }
  throw err;
}
```

---

## Stats

```ts
const s = bulkhead.stats();

s.bulkhead.inFlight
s.bulkhead.pending
s.bulkhead.maxConcurrent
s.bulkhead.maxQueue
s.bulkhead.closed                    // true after close()

s.llm.admitted
s.llm.released
s.llm.rejected
s.llm.rejectedByReason?.budget_limit                        // true after close()

s.tokenBudget?.budget
s.tokenBudget?.inFlightTokens
s.tokenBudget?.available
s.tokenBudget?.totalReserved        // v3.1: cumulative tokens reserved at admission
s.tokenBudget?.totalConsumed        // v3.1: cumulative actual tokens consumed (usage required)
s.tokenBudget?.totalRefunded         // v2: cumulative refunded tokens

s.deduplication?.active
s.deduplication?.hits
```

```ts
type LLMStats = {
  bulkhead: Stats;
  llm: {
    admitted: number;
    released: number;
    rejected: number;
    rejectedByReason: Partial<Record<LLMRejectReason, number>>;
  };
  tokenBudget?: {
    budget: number;
    inFlightTokens: number;
    available: number;
    totalReserved: number;
    totalConsumed: number;
    totalRefunded: number;
  };
  deduplication?: {
    active: number;
    hits: number;
  };
};
```

---

## Event Hooks

```ts
// Subscribe
const off = bulkhead.on('admit', ({ request, reservedTokens }) => {
  console.log(`Admitted: ${reservedTokens} tokens reserved`);
});

// Unsubscribe
off();
```

| Event     | Payload |
|-----------|---------|
| `admit`   | `{ request, reservedTokens }` |
| `reject`  | `{ request, reason }` |
| `release` | `{ request, reservedTokens, refundedTokens, usage? }` |
| `dedup`   | `{ request }` |

Listeners are synchronous and fire-and-forget. Exceptions are silently caught.

---

## Graceful Shutdown

```ts
bulkhead.close();        // stop admission, reject pending waiters
await bulkhead.drain();  // wait for in-flight work to finish
```

`close()` is synchronous, idempotent, and irreversible. `drain()` resolves when `inFlight` and `pending` both reach zero.

---

## API Reference

### `createLLMBulkhead(options)`

```ts
type LLMBulkheadOptions = {
  model:          string;
  maxConcurrent:  number;
  maxQueue?:      number;
  timeoutMs?:     number; // integer >= 0
  profile?:       'interactive' | 'batch' | LLMBulkheadPreset;
  tokenBudget?: {
    budget:      number; // non-negative integer; 0 rejects all budget-gated admissions
    estimator?:  TokenEstimator;

    outputCap?:  number; // integer >= 0
  };
  deduplication?: boolean | DeduplicationOptions;
};

type DeduplicationOptions = {
  keyFn?: (request: LLMRequest) => string;
};
```

### `bulkhead.run(request, fn, options?)`

```ts
run<T>(
  request:  LLMRequest,
  fn:       (signal?: AbortSignal) => Promise<T>,
  options?: {
    signal?:    AbortSignal;
    timeoutMs?: number; // integer >= 0
    getUsage?:  (result: T) => TokenUsage | undefined;
  },
): Promise<T>
```

### `bulkhead.acquire(request, options?)`

```ts
acquire(
  request:  LLMRequest,
  options?: { signal?: AbortSignal; timeoutMs?: number /* integer >= 0 */ },
): Promise<LLMAcquireResult>

type LLMAcquireResult =
  | { ok: true;  token: LLMToken }
  | { ok: false; reason: LLMRejectReason };

type LLMToken = { release(usage?: TokenUsage): void };
```

### `bulkhead.stats()`

### `bulkhead.setBudget(tokens)`

```ts
setBudget(tokens: number): void
```

Mutates the token budget ceiling at runtime. Throws if `tokenBudget` was not
configured at construction. Throws if `tokens` is not a non-negative integer.
See [Runtime Budget Adjustment](#runtime-budget-adjustment) for full semantics.

### `bulkhead.close()`


### `bulkhead.drain()`

### `bulkhead.on(event, listener)`

```ts
on<K extends keyof LLMEventMap>(
  event:    K,
  listener: (payload: LLMEventMap[K]) => void,
): () => void    // returns unsubscribe
```

### Types

```ts
type LLMRequest     = { model?: string; messages: LLMMessage[]; max_tokens?: number };
type LLMMessage     = { role: string; content: string | ContentBlock[] };
type ContentBlock   = TextContentBlock | OpaqueContentBlock;
type TextContentBlock  = { type: 'text'; text: string };
type OpaqueContentBlock = { type: string; [key: string]: unknown };

type TokenEstimate  = { input: number; maxOutput: number };
type TokenEstimator = (request: LLMRequest) => TokenEstimate;
type TokenUsage     = { input: number; output: number };

type LLMRejectReason =
  | 'concurrency_limit'
  | 'queue_limit'
  | 'budget_limit'
  | 'timeout'
  | 'aborted'
  | 'shutdown';
```

---

## Migration

### v2 → v3

Update stats access from top-level fields to the `bulkhead` block:

```ts
const s = bulkhead.stats();

// v2
s.inFlight;
s.pending;

// v3
s.bulkhead.inFlight;
s.bulkhead.pending;
```

LLM-layer counters are now available separately:

```ts
const s = bulkhead.stats();
s.llm.admitted;
s.llm.rejected;
s.llm.rejectedByReason?.budget_limit;
```

### v1 → v2

See [CHANGELOG](./CHANGELOG.md) for the v2 migration guide.

---

## Design Notes

This library enforces backpressure at the boundary of your LLM calls. It does not replace higher-level concerns:

- **Retries** — compose a retry library around the bulkhead, not inside it
- **Cost accounting** — use provider response metadata; estimation here is for gating only
- **Distributed rate limiting** — use a shared token bucket; bulkheads are per-process
- **Model selection** — route above the bulkhead layer; each bulkhead instance is model-specific

Token estimation is deliberately approximate. The refund mechanism improves budget utilization but does not make estimation exact — it corrects after the fact based on actual usage.

---

## Compatibility

- Node.js: 20+
- Module formats: ESM and CommonJS

---

## License

Apache License 2.0 © 2026
