---
title: Stats and events
---

# Stats and events

## `stats()`

```ts
const s = bulkhead.stats();

s.limits.revision
s.limits.maxConcurrent
s.limits.maxQueue
s.limits.tokenBudget?.budget
s.limits.tokenBudget?.highPriorityReserve
s.limits.admissionClasses?.premium?.maxConcurrent

s.bulkhead.inFlight
s.bulkhead.pending
s.bulkhead.maxConcurrent
s.bulkhead.maxQueue
s.bulkhead.closed                    // true after close()

s.llm.admitted
s.llm.released
s.llm.rejected
s.llm.rejectedByReason?.budget_limit

s.observe?.bypassed                 // callbacks run without capacity
s.observe?.raceBypassed             // advisory admit raced with rejection
s.observe?.bypassedByReason
s.observe?.usageReported
s.observe?.totalInputTokens
s.observe?.totalOutputTokens

s.tokenBudget?.budget
s.tokenBudget?.inFlightTokens
s.tokenBudget?.available
s.tokenBudget?.totalReserved        // cumulative tokens reserved at admission
s.tokenBudget?.totalConsumed        // cumulative actual tokens consumed (usage required)
s.tokenBudget?.totalRefunded        // cumulative refunded tokens

s.admissionClasses?.defaultClass
s.admissionClasses?.classes.premium?.inFlight
s.admissionClasses?.classes.premium?.inFlightTokens
s.admissionClasses?.classes.premium?.rejectedByReason

s.deduplication?.active
s.deduplication?.hits
```

Stats are namespaced: underlying bulkhead slot lifecycle lives in
`stats().bulkhead`, and higher-level LLM request outcomes such as
`budget_limit` live in `stats().llm`.

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
  admissionClasses?: {
    defaultClass: string;
    shared: {
      maxConcurrent: number;
      inFlight: number;
      availableConcurrent: number;
      tokenBudget?: {
        budget: number;
        inFlightTokens: number;
        available: number;
      };
    };
    classes: Record<string, LLMAdmissionClassStats>;
  };
  deduplication?: {
    active: number;
    hits: number;
  };
};
```

## Events

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
| `admit`   | `{ request, admissionId, limitRevision, priority, admissionClass?, reservedTokens }` |
| `reject`  | `{ request, reason, limitRevision, admissionClass?, detail? }` |
| `usage`   | `{ request, admissionId, limitRevision, priority, admissionClass?, sequence, reservedTokens, previousHeldTokens, heldTokens, deltaTokens, usage, outputCap, outputRemaining, overReservation }` |
| `release` | `{ request, admissionId, limitRevision, priority, admissionClass?, reservedTokens, heldTokens, refundedTokens, usageSequence, usage? }` |
| `bypass` | `{ request, admissionId, limitRevision, priority, admissionClass?, reason, detail?, reservation, raced }` |
| `bypassUsage` | `{ request, admissionId, limitRevision, priority, admissionClass?, reason, sequence, reservation, usage, outputCap, outputRemaining, overReservation }` |
| `bypassRelease` | `{ request, admissionId, limitRevision, priority, admissionClass?, reason, reservation, usageSequence, usage? }` |
| `reconfigure` | `{ previous, current }` |
| `dedup`   | `{ request }` |

Listeners are synchronous and fire-and-forget. Exceptions are silently caught.
Do not perform blocking network I/O in a listener; enqueue telemetry or lease
updates for asynchronous delivery.

```ts
const off = bulkhead.on('release', ({ reservedTokens, refundedTokens, usage }) => {
  metrics.histogram('llm.tokens.reserved', reservedTokens);
  metrics.histogram('llm.tokens.refunded', refundedTokens);
});
```
