---
title: Token budget and estimation
---

# Token budget and estimation

```ts
const bulkhead = createLLMBulkhead({
  model:         'claude-sonnet-4',
  maxConcurrent: 10,
  tokenBudget: {
    budget: 200_000,
  },
});
```

Token reservations are calculated pre-admission from `input + maxOutput`.
Capacity is returned when each request completes. When `TokenUsage` is
provided at release, the refund reclaims unused capacity immediately.

A budget of `0` rejects all budget-gated admissions.

## What the budget is, and what it is not

The budget is a ceiling on tokens **reserved at the same time**. Admission
checks `inFlightTokens + reserved` against the budget, and the whole
reservation is released when the request finishes. It is a second admission
dimension alongside `maxConcurrent`, added because a slot count cannot
distinguish a 500-token request from a 100,000-token one.

It is **not** a spend cap:

- Nothing accumulates. A 200,000-token budget does not stop you at 200,000
  tokens; it stops you at 200,000 tokens *concurrently*. Total throughput over
  an hour is unbounded by this setting.
- Nothing is priced. The library has no notion of currency, rate cards, cached
  input, or per-model pricing.
- Reservations are estimates. Character-ratio estimation is approximate, and
  the refund path corrects it *after* the call, not before.
- The budget is per process. Two replicas with a 200,000 budget each commit up
  to 400,000 tokens between them.

If you need a spend ceiling, meter provider-reported usage in a system that
persists across requests, replicas, and restarts. This is not that system.

## How estimation works

The default estimator is `createModelAwareTokenEstimator` seeded with the
bulkhead's `model`. It uses per-model character-to-token ratios for known
model families, falling back to a flat `4.0` ratio for unknown models.

The estimator checks `request.model` first (when present), then falls back to
the bulkhead-level `defaultModel`.

Known model families: `claude-3-5-haiku`, `claude-3-5-sonnet`, `claude-3-*`,
`claude-sonnet-4`, `claude-opus-4`, `claude-haiku-4`, `claude-*-4-5`,
`gpt-4o`, `gpt-4-turbo`, `gpt-4.1`, `gpt-4`, `gpt-3.5`, `o1`, `o3`, `o4-mini`,
`gemini-1.5`, `gemini-2`, `gemini-2.5`.

## Token refund

v1 reserved `input + maxOutput` tokens and held that full reservation until
release. Most calls use far fewer output tokens than `max_tokens`. The refund
path reclaims the difference:

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

When usage is reported, the refund is
`reserved - (actual input + actual output)`. Budget capacity is returned
immediately. Without usage, the full reservation is held until release.

## Reservation preview

`estimate()` runs the same estimator and validation path as admission but does
not reserve capacity. This is useful when a gateway must acquire an external
lease before entering the local bulkhead:

```ts
const reservation = bulkhead.estimate(request);
const lease = reservation
  ? await redisLease.reserve(requestId, reservation.reserved)
  : undefined;

const result = await bulkhead.acquire(request);
if (!result.ok) {
  await lease?.release();
  return reject(result.reason);
}
```

The preview is advisory until admission occurs: do not mutate the request
between calls, and keep custom estimators deterministic. `null` means token
budgeting is disabled and the local bulkhead will reserve no tokens.

The frozen object returned by `estimate()` can be passed straight back as the
per-call reservation override:

```ts
const preview = bulkhead.estimate(request);
await bulkhead.run(request, fn, {
  ...(preview !== null ? { reservation: preview } : {}),
});
```

When the override carries a `reserved` field it is validated as a consistency
check (`reserved === input + maxOutput`), catching hand-built overrides whose
cached total drifted from edited parts. Plain `{ input, maxOutput }` overrides
are unchanged.

## Custom estimator

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

## Estimator utilities

```ts
import {
  naiveTokenEstimator,
  createModelAwareTokenEstimator,
  createAdaptiveTokenEstimator,
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

## Adaptive estimation

Character-ratio estimation is ±15% at best and drifts with content mix and
tokenizer changes. `createAdaptiveTokenEstimator()` closes the loop:

```ts
import {
  createAdaptiveTokenEstimator,
  createLLMBulkhead,
} from "async-bulkhead-llm";

const adaptive = createAdaptiveTokenEstimator({
  defaultModel: "claude-sonnet-4-5",
  opaqueBlockTokens: 2_048,
  // smoothing: 0.2, minSamples: 5,
  // minCorrection: 0.5, maxCorrection: 2, maxModels: 64,
});

const bulkhead = createLLMBulkhead({
  model: "claude-sonnet-4-5",
  maxConcurrent: 8,
  tokenBudget: { budget: 200_000, estimator: adaptive.estimator },
});

// Close the loop from actual usage:
bulkhead.on("release", (e) => {
  if (e.usage) adaptive.observe(e.request, e.usage);
});

adaptive.corrections(); // per-model { samples, factor, applied } for /stats
```

It maintains a per-model EWMA of `actual input / estimated input` and
multiplies future *input* estimates by that factor — clamped, and only after
`minSamples` observations. Output reservations are never corrected
(`max_tokens` is a ceiling, not an estimate). Observations always measure
against the *uncorrected* base estimate, so the loop cannot compound through
its own corrections. Calibration is in-memory, per-instance, and bounded to
`maxModels` tracked models.

## Multimodal content

`content` may be a plain string or an array of content blocks:

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

Built-in estimators extract text from text blocks. Opaque (non-text) blocks
are ignored by default, or charged a configurable per-block reservation via
`opaqueBlockTokens`. Token estimates for multimodal requests are otherwise a
lower bound — provide a custom `estimator` for accurate multimodal
estimation.

`system` prompts are counted natively, and `extraInputTokens` carries
caller-computed costs such as tool schemas or provider-priced media.

## Per-request model

Route multiple models through a single bulkhead with accurate per-model
estimation:

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

## Priority admission

`highPriorityReserve` reserves budget headroom that only `priority: "high"`
requests may use, so interactive traffic keeps admitting when batch traffic
saturates the pool:

```ts
const bulkhead = createLLMBulkhead({
  model: "claude-sonnet-4",
  maxConcurrent: 50,
  tokenBudget: { budget: 200_000, highPriorityReserve: 40_000 },
});

await bulkhead.run(request, callLLM, { priority: "high" });
```
