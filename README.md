# async-bulkhead-llm

Fail-fast **admission control for LLM workloads**, built on [async-bulkhead-ts](https://github.com/janbalangue/async-bulkhead-ts).

Designed for services that need to enforce **cost ceilings, concurrency limits, and backpressure** at the boundary of their LLM calls — before request fan-out, before hitting provider rate limits, before saturation cascades.

---

## Features

- ✅ Hard **max in-flight** concurrency (`maxConcurrent`)
- ✅ **Atomic versioned limit updates** — apply concurrency, queue, token budget, and priority reserve as one revisioned snapshot
- ✅ **Token-aware admission** — reserves against estimated input + max output tokens
- ✅ **Token refund** — reclaim unused budget capacity from actual usage post-completion
- ✅ **Model-aware estimation** — per-model character ratios for known providers
- ✅ **Per-request model** — mixed-model routing through a single bulkhead
- ✅ **Multimodal content** — text blocks counted; opaque blocks ignored by default or charged a configurable per-block reservation (`opaqueBlockTokens`)
- ✅ **Full-request estimation** — `system` prompts counted natively; `extraInputTokens` carries caller-computed costs (tool schemas, provider-priced media)
- ✅ **Per-call reservation override** — gateways with their own estimate can bypass the estimator via `reservation` on `acquire()`/`run()`/`wouldAdmit()`
- ✅ **Fail-fast by default** — shed load early, never silently queue
- ✅ **Observe/shadow mode** — measure capacity-policy impact while still executing selected would-be-rejected calls
- ✅ **Opinionated profiles** — `'interactive'` and `'batch'` presets with escape hatch
- ✅ **In-flight deduplication** — identical requests share one LLM call; hashed keys, whole-request equality
- ✅ **Custom dedup key + per-tenant scope** — bring your own equivalence function; `dedupScope` isolates tenants
- ✅ **Streaming-safe deduplication** — single-consumer results are never silently shared; `shareResult` fan-out hook + per-call `dedup: false` opt-out
- ✅ **Exact reservation preview** — `estimate()` exposes the reservation admission will use, and its result can be passed back verbatim as the per-call `reservation`
- ✅ **Adaptive estimation** — `createAdaptiveTokenEstimator()` self-calibrates per-model input estimates from observed usage
- ✅ **Advisory capacity snapshots** — `wouldAdmit(request, { detail: true })` returns the same capacity numbers rejections carry
- ✅ **Stable admission IDs** — correlate gateway requests, traces, usage, and release
- ✅ **Ordered usage events** — sequence-numbered hold changes for external coordinators
- ✅ **Event hooks** — admitted and bypassed lifecycles have separate telemetry events
- ✅ **Graceful shutdown** — `close()` + `drain()`, with an optional bounded wait: `drain({ timeoutMs })`
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
| **Observe/shadow rollout mode** | ✅ Yes | ❌ No | ❌ No | ❌ No | ❌ No |
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

## What's New in v3.10 — Atomic, versioned admission limits

v3.10 makes `async-bulkhead-llm` safer to operate from gateways and distributed
control-plane agents. All mutable admission limits can now be replaced in one
validated, revisioned snapshot instead of being updated independently.

### Highlights

- **Atomic updates:** `maxConcurrent`, `maxQueue`, token budget, and
  high-priority reserve change together or not at all.
- **Stale-update protection:** every snapshot carries a strictly increasing
  `revision`; equal or older revisions are rejected without mutating state.
- **Shrink by attrition:** lowering limits never cancels in-flight work or
  already accepted queue waiters. New work is admitted only as capacity returns.
- **Immediate scale-up:** raising concurrency starts eligible queued work as soon
  as the new snapshot is applied.
- **Runtime kill switch:** setting `maxConcurrent` to `0` stops new admissions
  while existing work drains normally.
- **Observable state:** `limits()`, `stats().limits`, and the `reconfigure` event
  expose the active revision and previous/current snapshots.

```ts
const result = bulkhead.applyLimits({
  revision: 42,
  maxConcurrent: 12,
  maxQueue: 0,
  tokenBudget: {
    budget: 120_000,
    highPriorityReserve: 20_000,
  },
});

if (!result.applied) {
  // Equal and lower revisions are ignored without mutation.
  console.log(result.reason); // "stale_revision"
}
```

Use `initialRevision` when restoring persisted control-plane state. A configured
token budget must remain configured in every later snapshot; estimator and
output-cap policy remain construction-time settings. `setBudget()` is still
supported for local use, but distributed integrations should use
`applyLimits()` exclusively so a single authority owns the revision sequence.

---

## What's New in v3.9 — First-class observe mode

v3.9 adds an explicit rollout mode for measuring admission policy before fully
enforcing it. `run()` still attempts normal admission first. When a configured
capacity-related rejection occurs, observe mode executes the callback without
holding a concurrency slot or token reservation and records the bypass on a
separate telemetry surface.

```ts
const result = await bulkhead.run(
  request,
  async (signal, ctx) => {
    logger.info({
      admissionId: ctx?.admissionId,
      admission: ctx?.admission,          // "admitted" | "bypassed"
      bypassReason: ctx?.bypassReason,    // set only for bypassed work
      bypassDetail: ctx?.bypassDetail,    // capacity snapshot, when available
    });

    return callYourLLMProvider(request, {
      signal,
      onUsage: (usage) => ctx?.reportUsage(usage),
    });
  },
  { mode: "observe" },
);
```

By default, observe mode may bypass these capacity outcomes:

```ts
"budget_limit" | "concurrency_limit" | "queue_limit" | "timeout"
```

Shutdown, caller cancellation, and unsafe deduplication fan-out remain hard
failures. Observe mode is therefore not a global "ignore every rejection"
switch.

### Restrict which outcomes may be bypassed

Use `shadowReasons` to roll out one policy at a time:

```ts
await bulkhead.run(request, fn, {
  mode: "observe",
  shadowReasons: ["budget_limit"],
});
```

An empty `shadowReasons` array keeps normal enforcement while still exposing
`ctx.admission === "admitted"` to callbacks.

### Admitted and bypassed callback context

Normally admitted calls receive the same context with:

```ts
ctx.admission === "admitted"
ctx.bypassReason === undefined
```

Bypassed calls receive a `shadow-`-prefixed `admissionId`, the exact evaluated
reservation, the bypass reason, and the associated capacity detail. Their
`reportUsage()` snapshots always report `held: 0`, because observed work does
not consume bulkhead accounting capacity.

### Separate observe telemetry

Bypassed work does not increment normal `admit`/`release` counters. It is
reported through:

```ts
bulkhead.on("bypass", listener);
bulkhead.on("bypassUsage", listener);
bulkhead.on("bypassRelease", listener);

const observe = bulkhead.stats().observe;
// {
//   bypassed,
//   raceBypassed,
//   bypassedByReason,
//   usageReported,
//   totalInputTokens,
//   totalOutputTokens,
// }
```

`raceBypassed` counts calls whose advisory check passed but whose authoritative
acquisition later rejected—for example, a queued request that timed out while
capacity changed. This makes preview-to-admission races visible instead of
silently merging them into ordinary bypasses.

> Observe mode intentionally allows work to proceed without capacity
> protection. Use it for policy calibration, migration, and audit periods—not
> as the steady-state overload posture of a saturated service.

---

## What's New in v3.8 — Feedback and shutdown ergonomics

### Bounded drain

`drain()` without arguments is unchanged (`Promise<void>`). With a deadline,
it always *resolves* — never rejects — with what happened:

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

### Capacity detail from `wouldAdmit()`

Routing layers choosing between pools want the numbers, not just the boolean:

```ts
const { admit, reason, detail } = bulkhead.wouldAdmit(request, {
  detail: true,
});
// detail is the same LLMRejectDetail snapshot real rejections carry,
// present on admit: true as well (detail.tokenBudget.requested is the
// reservation this request needs).
```

Omitted by default, so existing callers see the exact v3.7 result shape.

### `estimate()` round-trips as the reservation override

The frozen object returned by `estimate()` can now be passed straight back:

```ts
const preview = bulkhead.estimate(request);
await bulkhead.run(request, fn, {
  ...(preview !== null ? { reservation: preview } : {}),
});
```

When the override carries a `reserved` field it is validated as a
consistency check (`reserved === input + maxOutput`), catching hand-built
overrides whose cached total drifted from edited parts. Plain
`{ input, maxOutput }` overrides are unchanged.

### Adaptive estimation

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
multiplies future *input* estimates by that factor — clamped, and only
after `minSamples` observations. Output reservations are never corrected
(`max_tokens` is a ceiling, not an estimate). Observations always measure
against the *uncorrected* base estimate, so the loop cannot compound
through its own corrections. Calibration is in-memory, per-instance, and
bounded to `maxModels` tracked models.

---

## What's New in v3.6 — Gateway coordination seams

### Exact reservation preview

`estimate()` runs the same estimator and validation path as admission without
reserving capacity. This is useful when a gateway must acquire an external
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

### Stable admission identity

Every successful admission receives a UUID available on the acquire result,
token, run context, and lifecycle events:

```ts
const result = await bulkhead.acquire(request);
if (result.ok) {
  console.log(result.admissionId);
  console.log(result.token.admissionId);
  result.token.release();
}

await bulkhead.run(request, async (_signal, ctx) => {
  trace.setAttribute('llm.admission_id', ctx!.admissionId);
  return callYourLLMProvider(request);
});
```

### Ordered usage-change events

Effective cumulative `reportUsage()` updates emit a sequence-numbered event.
Stale or duplicate reports are clamped as before and do not emit:

```ts
bulkhead.on('usage', (event) => {
  // External stores can ignore an update whose sequence is not newer.
  distributedLedger.adjust({
    admissionId: event.admissionId,
    sequence: event.sequence,
    heldTokens: event.heldTokens,
  });
});
```

The event includes previous/current hold, delta, cumulative usage, priority,
output-cap state, and over-reservation status. Listeners remain synchronous;
enqueue network or storage work rather than blocking inside the callback.
For admission-critical distributed enforcement, use the returned report and
await the external update in the gateway's stream loop:

```ts
const report = ctx!.reportUsage(cumulativeUsage);
await distributedLedger.setHold({
  admissionId: report.admissionId,
  sequence: report.sequence,
  heldTokens: report.held,
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

The default key covers the entire request object with stable key ordering.
Return an empty string to opt a specific request out.

### Event Hooks

```ts
const off = bulkhead.on('release', ({ reservedTokens, refundedTokens, usage }) => {
  metrics.histogram('llm.tokens.reserved', reservedTokens);
  metrics.histogram('llm.tokens.refunded', refundedTokens);
});

// Later:
off(); // unsubscribe
```

Events: `'admit'`, `'reject'`, `'usage'`, `'release'`, `'reconfigure'`, `'dedup'`.

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

// Self-calibrating wrapper (v3.8) — see "What's New in v3.8"
const adaptive = createAdaptiveTokenEstimator({ defaultModel: 'gpt-4o' });
adaptive.estimator;                    // pass as tokenBudget.estimator
adaptive.observe(request, usage);      // feed actual usage (release event)
adaptive.corrections();                // per-model calibration snapshot
adaptive.reset();                      // clear calibration
```

### Atomic Runtime Reconfiguration

`applyLimits(snapshot)` is the preferred runtime control surface for gateways
and distributed control-plane agents. The snapshot is complete rather than
partial, so concurrency, queue, budget, and reserve values cannot drift across
separate setter calls.

```ts
const bulkhead = createLLMBulkhead({
  model: 'claude-sonnet-4',
  maxConcurrent: 10,
  maxQueue: 0,
  initialRevision: 100,
  tokenBudget: {
    budget: 200_000,
    highPriorityReserve: 25_000,
  },
});

const update = bulkhead.applyLimits({
  revision: 101,
  maxConcurrent: 6,
  maxQueue: 20,
  tokenBudget: {
    budget: 90_000,
    highPriorityReserve: 15_000,
  },
});
```

Semantics:

* **Strictly increasing revision.** Equal or lower revisions return a stale
  result and do not mutate any limit.
* **Full validation before mutation.** Invalid higher-revision snapshots throw
  while the previous revision remains active.
* **Shrink by attrition.** In-flight work and accepted queue waiters are never
  revoked. New admissions obey the lower ceilings immediately.
* **Immediate expansion.** Raising `maxConcurrent` pumps accepted waiters in
  the same synchronous update, after the complete LLM-layer snapshot is active.
* **Zero-concurrency kill switch.** `maxConcurrent: 0` rejects new callers with
  `"concurrency_limit"` instead of queueing them.
* **Budget reserve may exceed a shrunken budget.** The normal-priority ceiling
  is clamped to 0 while high-priority traffic is checked against the full
  budget, preserving the existing degraded-priority behavior.
* **Budget feature shape is fixed at construction.** A bulkhead created with
  `tokenBudget` requires `tokenBudget` in every update. A bulkhead created
  without it must omit that field; estimator policy is not hot-swapped.

```ts
const current = bulkhead.limits();
// { revision, maxConcurrent, maxQueue, tokenBudget? }

bulkhead.on('reconfigure', ({ previous, current }) => {
  publishAppliedRevision(previous.revision, current.revision);
});
```

#### Compatibility: `setBudget(tokens)`

`setBudget(tokens)` remains available for existing callers. It now applies a
complete budget-only update at `currentRevision + 1`. Do not mix it with an
external revision authority; distributed integrations should use
`applyLimits()` exclusively.


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

### Streaming results (v3.5)

Dedup shares the leader's resolved value with every follower **by
reference**. For plain JSON results that is correct. For streaming
results it is not: a `ReadableStream`, Node `Readable`, async iterable,
or `Response` body can only be consumed once — whichever caller reads
first wins, and the rest get a locked or drained stream.

The bulkhead now refuses to do that silently. When a follower's shared
result is detected as single-consumer, that follower rejects with
`LLMBulkheadRejectedError("unshareable_result")`. The **leader always
receives its original result unaffected**. Detection is shallow — only
the result value itself is inspected, so a stream nested inside a
wrapper object is still shared by reference.

You have two ways to make streaming and dedup coexist:

**1. `shareResult` — make sharing work.** A fan-out hook called once per
follower with the leader's result; its return value is what that
follower receives. It runs for *every* follower delivery (safe results
included) and bypasses the single-consumer detection — the hook owns
fan-out policy. A throwing hook rejects that follower with the thrown
error; leader and other followers are unaffected.

```ts
// fetch Response: each follower gets an independent clone.
// clone() is called at resolution time, before any body is consumed.
deduplication: {
  shareResult: (r) => (r as Response).clone(),
}
```

For raw streams, `tee()`/replay choreography is provider-specific, which
is why this is a hook rather than built in.

**2. `dedup: false` — skip dedup for streaming calls.** A per-call
opt-out on `run()` options: the call neither joins an existing in-flight
call nor registers as joinable. Use it on streaming routes of a bulkhead
where dedup is otherwise useful, instead of encoding the exemption in a
bulkhead-wide `keyFn`. (`dedup: true` cannot enable deduplication when
it is disabled at the bulkhead level.)

```ts
bulkhead.run(request, streamFromProvider, { dedup: false });
```

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

console.log(`Admission: ${r.admissionId}`);

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

s.limits.revision
s.limits.maxConcurrent
s.limits.maxQueue
s.limits.tokenBudget?.budget
s.limits.tokenBudget?.highPriorityReserve

s.bulkhead.inFlight
s.bulkhead.pending
s.bulkhead.maxConcurrent
s.bulkhead.maxQueue
s.bulkhead.closed                    // true after close()

s.llm.admitted
s.llm.released
s.llm.rejected
s.llm.rejectedByReason?.budget_limit

s.observe?.bypassed                 // v3.9: callbacks run without capacity
s.observe?.raceBypassed             // advisory admit raced with rejection
s.observe?.bypassedByReason
s.observe?.usageReported
s.observe?.totalInputTokens
s.observe?.totalOutputTokens

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
  limits: LLMAdmissionLimits;
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
  observe?: {
    bypassed: number;
    raceBypassed: number;
    bypassedByReason: Partial<Record<
      'budget_limit' | 'concurrency_limit' | 'queue_limit' | 'timeout',
      number
    >>;
    usageReported: number;
    totalInputTokens: number;
    totalOutputTokens: number;
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
const off = bulkhead.on('admit', ({ admissionId, reservedTokens }) => {
  console.log(`${admissionId}: ${reservedTokens} tokens reserved`);
});

// Unsubscribe
off();
```

| Event     | Payload |
|-----------|---------|
| `admit`   | `{ request, admissionId, priority, reservedTokens }` |
| `reject`  | `{ request, reason, detail? }` |
| `usage`   | `{ request, admissionId, priority, sequence, reservedTokens, previousHeldTokens, heldTokens, deltaTokens, usage, outputCap, outputRemaining, overReservation }` |
| `release` | `{ request, admissionId, priority, reservedTokens, heldTokens, refundedTokens, usageSequence, usage? }` |
| `bypass` | `{ request, admissionId, priority, reason, detail?, reservation, raced }` |
| `bypassUsage` | `{ request, admissionId, priority, reason, sequence, reservation, usage, outputCap, outputRemaining, overReservation }` |
| `bypassRelease` | `{ request, admissionId, priority, reason, reservation, usageSequence, usage? }` |
| `reconfigure` | `{ previous, current }` |
| `dedup`   | `{ request }` |

Listeners are synchronous and fire-and-forget. Exceptions are silently caught.
Do not perform blocking network I/O in a listener; enqueue telemetry or lease
updates for asynchronous delivery.

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
  initialRevision?: number; // non-negative safe integer; default 0
  maxQueue?:      number;
  timeoutMs?:     number; // integer >= 0
  profile?:       'interactive' | 'batch' | LLMBulkheadPreset;
  tokenBudget?: {
    budget:               number; // non-negative integer; 0 rejects all budget-gated admissions
    estimator?:           TokenEstimator;
    outputCap?:           number; // integer >= 0
    highPriorityReserve?: number; // integer >= 0 and <= initial budget
  };
  deduplication?: boolean | DeduplicationOptions;
};

type DeduplicationOptions = {
  keyFn?:       (request: LLMRequest) => string;
  shareResult?: (result: unknown) => unknown; // per-follower fan-out (v3.5)
};
```

### `bulkhead.run(request, fn, options?)`

```ts
run<T>(
  request:  LLMRequest,
  fn:       (signal?: AbortSignal, ctx?: LLMRunContext) => Promise<T>,
  options?: {
    signal?:     AbortSignal;
    timeoutMs?:  number; // integer >= 0
    priority?:   'normal' | 'high';
    getUsage?:   (result: T) => TokenUsage | undefined;
    mode?:       'enforce' | 'observe'; // default: 'enforce' (v3.9)
    shadowReasons?: readonly (
      | 'budget_limit'
      | 'concurrency_limit'
      | 'queue_limit'
      | 'timeout'
    )[];
    dedupScope?: string;  // dedup isolation scope (e.g. tenant / API key)
    dedup?:      boolean; // false = opt this call out of dedup (v3.5)
  },
): Promise<T>
```

`ctx.admissionId` is the stable execution identifier. In observe-mode
bypasses it uses a `shadow-` prefix. `ctx.reservation` is the exact evaluated
reservation (or `null` when token budgeting is disabled),
`ctx.admission` distinguishes `"admitted"` from `"bypassed"`, and
`ctx.bypassReason` / `ctx.bypassDetail` describe a bypass.
`ctx.reportUsage()` reports cumulative streaming usage; bypassed usage is
recorded for telemetry but never changes bulkhead capacity accounting.

### `bulkhead.estimate(request)`

```ts
estimate(request: LLMRequest): LLMReservationEstimate | null

type LLMReservationEstimate = {
  readonly input: number;
  readonly maxOutput: number;
  readonly reserved: number;
};
```

Runs the same estimator and validation path as admission but does not reserve
capacity. Returns `null` when `tokenBudget` is not configured.

### `bulkhead.acquire(request, options?)`

```ts
acquire(
  request:  LLMRequest,
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number; // integer >= 0
    priority?: 'normal' | 'high';
  },
): Promise<LLMAcquireResult>

type LLMAcquireResult =
  | {
      ok: true;
      admissionId: string;
      reservation: LLMReservationEstimate | null;
      token: LLMToken;
    }
  | { ok: false; reason: LLMRejectReason };

type LLMToken = {
  readonly admissionId: string;
  readonly reservation: LLMReservationEstimate | null;
  reportUsage(usage: TokenUsage): UsageReport;
  release(usage?: TokenUsage): void;
};
```

### `bulkhead.stats()`

### `bulkhead.limits()`

```ts
limits(): LLMAdmissionLimits
```

Returns a frozen copy of the currently applied complete snapshot.

### `bulkhead.applyLimits(snapshot)`

```ts
applyLimits(snapshot: LLMAdmissionLimits): LLMApplyLimitsResult

type LLMAdmissionLimits = {
  readonly revision: number;
  readonly maxConcurrent: number; // runtime 0 = fail-fast kill switch
  readonly maxQueue: number;
  readonly tokenBudget?: {
    readonly budget: number;
    readonly highPriorityReserve: number;
  };
};
```

Applies only strictly higher revisions. See
[Atomic Runtime Reconfiguration](#atomic-runtime-reconfiguration).

### `bulkhead.setBudget(tokens)`

```ts
setBudget(tokens: number): void
```

Applies a complete budget-only update and advances the local revision by one.
Throws if `tokenBudget` was not configured at construction or if `tokens` is
not a non-negative integer. Externally managed callers should use
`applyLimits()` instead.

### `bulkhead.close()`


### `bulkhead.drain(opts?)`

```ts
drain(): Promise<void>;
drain(opts: { timeoutMs: number }): Promise<LLMDrainResult>;

type LLMDrainResult = {
  drained: boolean;   // true: everything completed within the deadline
  inFlight: number;   // outstanding at the deadline (0 when drained)
  pending: number;    // queued waiters at the deadline (0 when drained)
};
```

Resolves when all in-flight work and pending waiters have completed. With
`timeoutMs`, always resolves (never rejects) by the deadline with an
`LLMDrainResult`; the deadline does not cancel in-flight work.

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
type LLMReservationEstimate = TokenEstimate & { reserved: number };
type TokenEstimator = (request: LLMRequest) => TokenEstimate;
type TokenUsage     = { input: number; output: number };
type UsageReport = {
  admissionId: string;
  sequence: number;
  reserved: number;
  held: number;
  consumed: number;
  outputCap: number | null;
  outputRemaining: number | null;
  overReservation: boolean;
};

type LLMRejectReason =
  | 'concurrency_limit'
  | 'queue_limit'
  | 'budget_limit'
  | 'timeout'
  | 'aborted'
  | 'shutdown'
  | 'unshareable_result';
```

---

## Migration

### v3.9 → v3.10

Existing admission calls require no changes. `stats()` gains a `limits` block,
`LLMEventType` gains `"reconfigure"`, and `setBudget()` now advances the local
revision. Code that exhaustively enumerates event types should add the new
case. Control-plane integrations should move from `setBudget()` to complete
`applyLimits()` snapshots.

### v3.5 → v3.6

No call-site changes are required. `admit` and `release` event payloads gained
additional fields, and `usage` is a new event type. Code that exhaustively
enumerates `LLMEventType` should add the new `usage` case.

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

## Source Layout

The implementation is split into focused modules under `src/`; the package
entry point (`src/index.ts`) is a barrel that re-exports the public API.
Deep-importing the internal modules is not supported — the package
`exports` map exposes only the entry point.

| Module | Contents |
|---|---|
| `types.ts` | Public request, result, options, stats, and event types (declarations only) |
| `errors.ts` | `LLMBulkheadRejectedError` |
| `profiles.ts` | `PROFILES` presets + `LLMBulkheadPreset` |
| `estimators.ts` | `naiveTokenEstimator`, `createModelAwareTokenEstimator`, `opaqueBlockTokens` handling, `extractTextLength`, built-in ratio table |
| `adaptive.ts` | `createAdaptiveTokenEstimator` (v3.8 self-calibration) |
| `dedup.ts` | Deduplication internals: default whole-request key, scope-aware hashing, single-consumer result detection |
| `validation.ts` | Internal numeric/estimate/usage guards (not re-exported) |
| `bulkhead.ts` | `createLLMBulkhead`: admission, token budget + refund accounting, streaming usage reports, events, stats, shutdown |

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