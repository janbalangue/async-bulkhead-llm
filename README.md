# async-bulkhead-llm

Fail-fast **admission control for LLM workloads**, built on [async-bulkhead-ts](https://github.com/janbalangue/async-bulkhead-ts).

Designed for services that need to enforce **cost ceilings, concurrency limits, and backpressure** at the boundary of their LLM calls — before request fan-out, before hitting provider rate limits, before saturation cascades.

---

## Features

- ✅ Hard **max in-flight** concurrency (`maxConcurrent`)
- ✅ **Token-aware admission** — reserves against estimated input + max output tokens
- ✅ **Model-aware estimation** — per-model character ratios for known providers
- ✅ **Fail-fast by default** — shed load early, never silently queue
- ✅ **Opinionated profiles** — `'interactive'` and `'batch'` presets with escape hatch
- ✅ **In-flight deduplication** — identical requests share one LLM call
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

// Acquire + release handled automatically.
// Throws LLMBulkheadRejectedError on rejection.
const result = await bulkhead.run(request, async () => {
  return callYourLLMProvider(request);
});
```

---

## Profiles

Two built-in presets cover the common cases. Explicit options always override preset defaults.

```ts
// Interactive — fail-fast, no waiting (default)
const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 10,
  profile:       'interactive',   // maxQueue: 0
});

// Batch — bounded queue, 30s timeout
const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 4,
  profile:       'batch',         // maxQueue: 20, timeoutMs: 30_000
});

// Escape hatch — plain object, same shape as the options
const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 4,
  profile:       { maxQueue: 5, timeoutMs: 5_000 },
});
```

If no profile is set, the default is fail-fast (`maxQueue: 0`).

---

## Token Budget

Enforce a ceiling on total tokens in-flight simultaneously. Admission is always **fail-fast** when the ceiling is hit, regardless of profile or concurrency headroom.

```ts
const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 10,
  tokenBudget: {
    budget:    200_000,  // max tokens in-flight at once
  },
});
```

Token reservations are calculated pre-admission from `input + maxOutput`. Capacity is returned when each request completes.

### How estimation works

The default estimator is `createModelAwareTokenEstimator` seeded with the bulkhead's `model`. It uses per-model character-to-token ratios for known model families, falling back to a flat `4.0` ratio for unknown models.

Known model families: `claude-3-5-haiku`, `claude-3-5-sonnet`, `claude-3-*`, `claude-sonnet-4`, `claude-opus-4`, `gpt-4o`, `gpt-4-turbo`, `gpt-4`, `gpt-3.5`, `o1`, `o3`, `gemini-1.5`, `gemini-2`.

**Accuracy:** ±15% for known models on English prose. Underestimates for code and non-Latin scripts.
**Suitable for:** load-shedding and cost ceilings.
**Not suitable for:** cost accounting or billing.

### Custom estimator

Bring your own for higher accuracy, or to support Azure deployment names and other non-standard model strings:

```ts
import { Tiktoken } from 'tiktoken';

const enc = new Tiktoken(/* your model encoding */);

const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 10,
  tokenBudget: {
    budget:    200_000,
    estimator: (request) => ({
      input:     enc.encode(request.messages.map(m => m.content).join('')).length,
      maxOutput: request.max_tokens ?? 2_048,
    }),
  },
});
```

### Estimator utilities

Both estimators are exported for use outside the bulkhead — in logging, pre-flight checks, or request routing:

```ts
import { naiveTokenEstimator, createModelAwareTokenEstimator } from 'async-bulkhead-llm';

// Flat 4.0 ratio, zero configuration
const est1 = naiveTokenEstimator(request);

// Per-model ratios, optional override map
const estimate = createModelAwareTokenEstimator(
  { 'my-azure-deployment': 3.7 },     // exact overrides
  {
    defaultModel:   'claude-sonnet-4',
    outputCap:      2_048,
    onUnknownModel: (model) => console.warn(`Unknown model: ${model}`),
  },
);
```

`onUnknownModel` fires when neither an override nor a built-in prefix matches. Use it to log, alert, or throw in strict environments.

---

## Deduplication

When enabled, requests with identical message content that arrive while a matching call is already in-flight share that call — only one LLM request is made.

```ts
const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 10,
  deduplication: true,
});

// Both callers get the same result; only one LLM call is made.
const [r1, r2] = await Promise.all([
  bulkhead.run(request, async () => callLLM(request)),
  bulkhead.run(request, async () => callLLM(request)), // deduped
]);
```

**v1 key:** `JSON.stringify(request.messages)`. Requests with different `max_tokens` but identical messages are treated as duplicates. Key design is a known limitation in v1.

Deduplication stats are tracked:

```ts
bulkhead.stats().deduplication
// { active: 2, hits: 5 }
```

---

## Cancellation

Cancel waiting or in-flight requests with an `AbortSignal`:

```ts
const ac = new AbortController();

await bulkhead.run(
  request,
  async (signal) => callLLM(request, { signal }),
  { signal: ac.signal },
);

// Somewhere else:
ac.abort(); // cancels if still waiting; signals fn if already in-flight
```

The signal is passed through to your function. The bulkhead does not forcibly terminate in-flight work — your function is responsible for observing the signal.

Bound waiting time independently with `timeoutMs`:

```ts
await bulkhead.run(request, async () => callLLM(request), { timeoutMs: 5_000 });
```

`timeoutMs` applies to the waiting period only. It has no effect when `maxQueue` is 0.

---

## Manual Acquire / Release

For cases where `run()` doesn't fit your control flow:

```ts
const r = await bulkhead.acquire(request);

if (!r.ok) {
  // r.reason: 'concurrency_limit' | 'queue_limit' | 'budget_limit' | 'timeout' | 'aborted'
  return respond503(r.reason);
}

try {
  return await callLLM(request);
} finally {
  r.token.release();
}
```

You must call `token.release()` exactly once if acquisition succeeds.

> **v1 note:** Token budget reservations are not correctable after admission when using `acquire()` directly — the refund mechanism (adjusting reservations based on actual usage) is deferred to v2. For accurate budget accounting, prefer `run()`.

---

## Handling Rejections

`run()` throws `LLMBulkheadRejectedError` on rejection:

```ts
import { LLMBulkheadRejectedError } from 'async-bulkhead-llm';

try {
  await bulkhead.run(request, async () => callLLM(request));
} catch (err) {
  if (err instanceof LLMBulkheadRejectedError) {
    // err.code   === 'LLM_BULKHEAD_REJECTED'
    // err.reason === 'concurrency_limit' | 'queue_limit' | 'budget_limit'
    //             | 'timeout' | 'aborted'
    return respond503(`Shed: ${err.reason}`);
  }
  throw err;
}
```

`acquire()` returns a result object instead of throwing — check `r.ok` before using the token.

---

## Stats

```ts
const s = bulkhead.stats();

s.inFlight       // requests currently executing
s.pending        // requests waiting in queue
s.maxConcurrent  // configured limit
s.maxQueue       // configured queue depth

// Present only when tokenBudget is configured:
s.tokenBudget?.budget           // total ceiling
s.tokenBudget?.inFlightTokens   // currently reserved
s.tokenBudget?.available        // remaining headroom

// Present only when deduplication is enabled:
s.deduplication?.active   // distinct in-flight keys
s.deduplication?.hits     // cumulative dedup hits
```

---

## Multi-Model Routing

One bulkhead per model is the recommended pattern. Different models have different cost profiles, latency characteristics, and provider rate limits — a unified ceiling can't express those correctly.

For fallback routing, A/B testing, or canary deployments, compose multiple bulkheads with a thin routing layer:

```ts
const bulkheads = {
  sonnet: createLLMBulkhead({ model: 'claude-sonnet-4', maxConcurrent: 10 }),
  haiku:  createLLMBulkhead({ model: 'claude-haiku-3',  maxConcurrent: 40 }),
};

async function callWithFallback(request, isPriority: boolean) {
  const bulkhead = isPriority ? bulkheads.sonnet : bulkheads.haiku;
  try {
    return await bulkhead.run(request, () => callLLM(request));
  } catch (err) {
    if (err instanceof LLMBulkheadRejectedError && !isPriority) {
      // Haiku is saturated — shed rather than escalate to Sonnet.
      throw err;
    }
    throw err;
  }
}
```

---

## API Reference

### `createLLMBulkhead(options)`

```ts
type LLMBulkheadOptions = {
  model:          string;              // required; one bulkhead per model
  maxConcurrent:  number;              // required
  maxQueue?:      number;              // default: 0 (fail-fast)
  timeoutMs?:     number;              // waiting timeout; no effect if maxQueue is 0
  profile?:       'interactive'        // maxQueue: 0 (default behaviour)
                | 'batch'              // maxQueue: 20, timeoutMs: 30_000
                | LLMBulkheadPreset;   // escape hatch: plain options object
  tokenBudget?: {
    budget:      number;
    estimator?:  TokenEstimator;       // default: createModelAwareTokenEstimator
    outputCap?:  number;               // default: 2048
  };
  deduplication?: boolean;             // default: false
};
```

Explicit options always override profile defaults.

### `bulkhead.run(request, fn, options?)`

Primary API. Acquires a slot, calls `fn`, releases on completion or error.

```ts
run<T>(
  request:  LLMRequest,
  fn:       (signal?: AbortSignal) => Promise<T>,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<T>
```

Throws `LLMBulkheadRejectedError` on rejection.

### `bulkhead.acquire(request, options?)`

Advanced. Returns a result object; you manage the token lifecycle.

```ts
acquire(
  request:  LLMRequest,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<
  | { ok: true;  token: { release(): void } }
  | { ok: false; reason: LLMRejectReason }
>
```

### `bulkhead.stats()`

Returns current runtime state. See [Stats](#stats) above.

### `naiveTokenEstimator(request)`

Plain function. Flat `4.0` character-per-token ratio. No configuration.

### `createModelAwareTokenEstimator(overrides?, options?)`

Factory. Per-model ratios, longest-prefix match, exact overrides checked first.

```ts
createModelAwareTokenEstimator(
  overrides?: Record<string, number>,  // exact-match; caller values win
  options?: {
    defaultModel?:   string;
    outputCap?:      number;
    onUnknownModel?: (model: string) => void;
  },
): TokenEstimator
```

### Types

```ts
type LLMRequest     = { messages: LLMMessage[]; max_tokens?: number };
type LLMMessage     = { role: string; content: string };
type TokenEstimate  = { input: number; maxOutput: number };
type TokenEstimator = (request: LLMRequest) => TokenEstimate;

// Forward-looking: not acted on in v1, useful for annotating provider responses.
type TokenUsage     = { input: number; output: number };

type LLMRejectReason =
  | 'concurrency_limit'
  | 'queue_limit'
  | 'budget_limit'
  | 'timeout'
  | 'aborted';
```

---

## Design Notes

This library enforces backpressure at the boundary of your LLM calls. It does not replace higher-level concerns:

- **Retries** — compose a retry library around the bulkhead, not inside it
- **Cost accounting** — use provider response metadata; estimation here is for gating only
- **Distributed rate limiting** — use a shared token bucket; bulkheads are per-process
- **Model selection** — route above the bulkhead layer; each bulkhead instance is model-specific

Token estimation is deliberately approximate. The estimator's job is to prevent gross over-admission — not to predict your invoice. An estimator that's wrong by 20% still prevents the most common cost explosion: a burst of large-context requests all admitted simultaneously.

The refund mechanism (correcting reservations based on actual usage after a call completes) is on the roadmap for v2. In v1, reservations are based on `input + maxOutput` and held until release.

---

## Multimodal

`content` must be a plain string in v1. Multimodal content (images, documents, tool results as structured blocks) is not supported by the built-in estimators — non-string content is ignored, causing underestimation. Treat token budget results as a lower bound for multimodal requests.

Full multimodal support is planned for v2.

---

## Compatibility

- Node.js: 20+ (24 LTS recommended)
- Module formats: ESM and CommonJS

---

## License

Apache License 2.0 © 2026
