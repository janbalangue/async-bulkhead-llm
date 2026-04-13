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
- ✅ **In-flight deduplication** — identical requests share one LLM call
- ✅ **Custom dedup key** — bring your own equivalence function
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

v2 default key: `JSON.stringify({ m: request.messages, t: request.max_tokens, o: request.model })`. Requests with different `max_tokens` or `model` are not conflated.

Custom key:

```ts
deduplication: {
  keyFn: (request) => myHash(request.messages),
}
```

Return `""` from `keyFn` to opt a specific request out.

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

s.inFlight
s.pending
s.maxConcurrent
s.maxQueue
s.closed                             // true after close()

s.tokenBudget?.budget
s.tokenBudget?.inFlightTokens
s.tokenBudget?.available
s.tokenBudget?.totalRefunded         // v2: cumulative refunded tokens

s.deduplication?.active
s.deduplication?.hits
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
  timeoutMs?:     number;
  profile?:       'interactive' | 'batch' | LLMBulkheadPreset;
  tokenBudget?: {
    budget:      number;
    estimator?:  TokenEstimator;
    outputCap?:  number;
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
    timeoutMs?: number;
    getUsage?:  (result: T) => TokenUsage | undefined;
  },
): Promise<T>
```

### `bulkhead.acquire(request, options?)`

```ts
acquire(
  request:  LLMRequest,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<LLMAcquireResult>

type LLMAcquireResult =
  | { ok: true;  token: LLMToken }
  | { ok: false; reason: LLMRejectReason };

type LLMToken = { release(usage?: TokenUsage): void };
```

### `bulkhead.stats()`

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

## Migration from v1

Most callers need zero changes. See [CHANGELOG](./CHANGELOG.md) for a detailed migration guide.

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
