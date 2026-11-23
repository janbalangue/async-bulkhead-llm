---
title: Runtime limits and reconfiguration
---

# Runtime limits and reconfiguration

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
  admissionClasses: {
    defaultClass: 'standard',
    classes: {
      premium: { maxConcurrent: 7, maxInFlightTokens: 140_000 },
      standard: { maxConcurrent: 3, maxInFlightTokens: 60_000 },
    },
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

if (!update.applied) {
  // Equal and lower revisions are ignored without mutation.
  console.log(update.reason); // "stale_revision"
}
```

## Semantics

* **Strictly increasing revision.** Equal or lower revisions return a stale
  result and do not mutate any limit.
* **Full validation before mutation.** Invalid higher-revision snapshots throw
  while the previous revision remains active.
* **Shrink by attrition, unless you opt out.** New admissions obey the lower
  ceilings immediately. In-flight work is left to finish by itself unless the
  snapshot carries `stop.takeBackGraceMs` (v3.18, below). Accepted queue
  waiters are never revoked either way.
* **Immediate expansion.** Raising `maxConcurrent` pumps accepted waiters in
  the same synchronous update, after the complete LLM-layer snapshot is
  active.
* **Zero-concurrency kill switch.** `maxConcurrent: 0` rejects new callers with
  `"concurrency_limit"` instead of queueing them.
* **Budget reserve may exceed a shrunken budget.** The normal-priority ceiling
  is clamped to 0 while high-priority traffic is checked against the full
  budget, preserving the existing degraded-priority behavior.
* **Feature shapes are fixed at construction.** A bulkhead created with
  `tokenBudget` requires `tokenBudget` in every update. A bulkhead created
  without it must omit that field; estimator policy is not hot-swapped. The
  same rule applies to `admissionClasses`, whose complete fixed key set must be
  present in every update.
* **Nothing is inherited.** Every field describes the whole new state. That
  includes the optional `stop` policy: a snapshot without it has no stop
  policy, whatever the previous revision said.
* **Admission provenance is immutable.** `acquire()` results, tokens,
  `LLMRunContext`, usage reports, and lifecycle events retain the revision
  captured when the slot and token reservation were successfully acquired.
  A later `applyLimits()` call cannot relabel already admitted work.

```ts
const current = bulkhead.limits();
// { revision, maxConcurrent, maxQueue, tokenBudget?, admissionClasses?, stop? }

bulkhead.on('reconfigure', ({ previous, current }) => {
  publishAppliedRevision(previous.revision, current.revision);
});
```

Use `initialRevision` when restoring persisted control-plane state.

## Fail-closed startup

`maxConcurrent: 0` is legal at construction time. A gateway managed by an
external control plane can open its listener and health endpoint without
admitting requests before its first valid grant arrives.

```ts
const bulkhead = createLLMBulkhead({
  model: "gpt-4o",
  maxConcurrent: 0,
  maxQueue: 0,
  initialRevision: 0,
});

// Later, after a validated control-plane grant:
bulkhead.applyLimits({
  revision: 1,
  maxConcurrent: 8,
  maxQueue: 0,
});
```

A zero-capacity instance rejects new work with `concurrency_limit`; it does
not queue work unless `maxQueue` is explicitly greater than zero.

## Admission provenance

Every capacity decision is traceable to the exact immutable limit revision
that produced it. The revision is captured at the admission or rejection
decision itself, so a concurrent reconfiguration cannot relabel work that was
evaluated under an earlier snapshot.

- Successful `acquire()` results, `LLMToken`, and `LLMRunContext` expose
  `limitRevision`.
- `admit`, `usage`, `release`, `bypass`, `bypassUsage`, and `bypassRelease`
  events retain that same revision for the full lifetime of the execution.
- `LLMRejectDetail.limitRevision` records the snapshot used for a capacity
  rejection, and every `reject` event includes a top-level `limitRevision`.
- Gateways do not need to call `limits()` after admission, which could observe
  a newer revision than the one that actually authorized the request.

```ts
const acquired = await bulkhead.acquire(request);

if (acquired.ok) {
  console.log(acquired.admissionId);
  console.log(acquired.limitRevision);
  console.log(acquired.token.limitRevision); // same immutable revision
  acquired.token.release();
}

await bulkhead.run(request, async (_signal, ctx) => {
  auditLog({
    admissionId: ctx?.admissionId,
    limitRevision: ctx?.limitRevision,
  });

  return callYourLLMProvider(request);
});

bulkhead.on('reject', ({ reason, limitRevision, detail }) => {
  auditLog({ reason, limitRevision, capacity: detail });
});
```

The revision identifies the library limit snapshot, not an external control
plane grant by itself. A gateway can associate that revision with its own
immutable grant metadata to provide end-to-end admission provenance.

## Taking capacity back

A snapshot can state how long running work may stay above the new limits:

```ts
bulkhead.applyLimits({
  revision: 102,
  maxConcurrent: 4,
  maxQueue: 20,
  tokenBudget: { budget: 60_000, highPriorityReserve: 15_000 },
  stop: { takeBackGraceMs: 2_000 },
});
```

If the snapshot leaves running work above the new limits, nothing is stopped
for two seconds, and calls that finish in that time are left alone. Then
enough calls are stopped to fit, each rejecting with
`LLMAdmissionStoppedError` and cause `"limits"`. This covers a lower
`maxConcurrent`, a lower token budget, lower class ceilings, and a restored
class floor.

A later snapshot replaces a take-back that is still waiting, and starts its
own grace period if it still leaves work above the limits. The same `stop`
object can also carry `overrunAllowanceTokens`. Both are described in
[Stopping admitted work](stopping-admitted-work.md).

## Compatibility: `setBudget(tokens)`

`setBudget(tokens)` remains available for existing callers. It applies a
complete budget-only update at `currentRevision + 1`, carrying the applied
`stop` policy along. Do not mix it with an external revision authority;
distributed integrations should use `applyLimits()` exclusively so a single
authority owns the revision sequence.
