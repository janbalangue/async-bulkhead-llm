---
title: Admission classes
---

# Admission classes

Admission classes add a statically bounded policy layer beneath the global
bulkhead. Each class may define strict protected floors, hard ceilings, or
both. A request must satisfy its class policy as well as the enclosing global
concurrency and token limits.

```ts
const bulkhead = createLLMBulkhead({
  model: 'gpt-4o',
  maxConcurrent: 20,
  tokenBudget: { budget: 50_000 },
  admissionClasses: {
    defaultClass: 'standard',
    classes: {
      latencySensitive: {
        protectedConcurrent: 8,
        maxConcurrent: 14,
        protectedInFlightTokens: 20_000,
        maxInFlightTokens: 36_000,
      },
      standard: {
        protectedConcurrent: 3,
        maxConcurrent: 8,
        protectedInFlightTokens: 8_000,
        maxInFlightTokens: 20_000,
      },
      background: {
        maxConcurrent: 4,
        maxInFlightTokens: 10_000,
      },
    },
  },
});

await bulkhead.run(request, callProvider, {
  admissionClass: 'latencySensitive',
});
```

## Floors and ceilings

`protectedConcurrent` and `protectedInFlightTokens` reserve capacity for the
owning class. The sum of concurrency floors must not exceed `maxConcurrent`;
the sum of token floors must not exceed `tokenBudget.budget`. A floor may not
exceed the same class's hard ceiling. Invalid construction or reconfiguration
snapshots throw before any limit is installed.

After all floors are subtracted, the remaining capacity is shared. A class
uses its protected capacity first, then borrows from the shared remainder.
Borrowing remains subject to `maxConcurrent`, `maxInFlightTokens`, the global
limits, and the priority-adjusted token budget. A rejection required to keep
another class's floor available reports
`constraint: 'admission_class_protection'`.

Floors are deliberately strict: an idle class's protected capacity is not
automatically lent to another class. A gateway or control plane may implement
demand-aware lending by atomically applying a newer snapshot with adjusted
floors. Raising a floor does not cancel work that is already active. Existing
borrowers drain normally, while new shared-capacity admissions pause until the
new floor is restored by attrition.

## Resource-specific restoration

Borrowing can consume more than one constrained resource, and one restoration
mechanism must not be presented as stronger than it is. Every successful
admission exposes immutable `resources` attribution on its result, token, run
context, and lifecycle events:

```ts
const result = await bulkhead.acquire(request, {
  admissionClass: "background",
});

if (result.ok && result.resources.borrowedConcurrency) {
  result.token.abandonBorrowedConcurrency();
}
```

`abandonBorrowedConcurrency()` is idempotent and succeeds only for an admission
whose local concurrency came from shared capacity. It returns that slot
immediately but retains the token reservation until `release()`. The separate
`borrowedConcurrencyAbandon` event and counters make that state visible.

The event carries a `cause` of `manual` or `deadline`, and
`llm.borrowedConcurrencyAbandonedByCause` counts each separately. The split
matters operationally: deliberate shedding by the application and a lease that
is configured too tight produce identical slot returns, and only the second is
a signal to raise `borrowedConcurrencyDeadlineMs`.

For automatic wall-clock enforcement, pass a deadline to `run()`:

```ts
await bulkhead.run(request, callProvider, {
  admissionClass: "background",
  borrowedConcurrencyDeadlineMs: 30_000,
});
```

The deadline starts only after successful admission and only when the local
slot is borrowed. Expiry aborts the callback signal, returns the local slot,
and rejects the caller with `LLMBorrowedConcurrencyDeadlineError`. The
underlying callback remains responsible for final token settlement; `drain()`
continues to count it until that happens.

The same rule applies to manual `acquire()`: after abandoning borrowed
concurrency, the caller must eventually call `token.release()`. Otherwise
`drain()` without a timeout remains pending because the admission still owns a
token hold. Use bounded drain when shutdown must proceed despite an unsettled
caller.

This is an enforceable restoration bound for the in-process admission slot.
It is not evidence that an upstream provider stopped generating. If remote
cancellation is best-effort, token accounting after the local callback settles
is still only an accounting view. A hard upstream guarantee requires capacity
that is never lent for that resource (an unlent floor) or an authoritative
provider-side cancellation/partition mechanism.

Omitting a floor is equivalent to zero. Omitting a hard ceiling means that
dimension is governed only by the global bulkhead. Zero is valid for either a
floor or ceiling. Class checks remain fail-fast; `maxQueue` is still one
global queue and does not create per-class waiter queues.

### Worked example

```ts
const bulkhead = createLLMBulkhead({
  model: "gpt-4o",
  maxConcurrent: 12,
  tokenBudget: { budget: 24_000 },
  admissionClasses: {
    defaultClass: "standard",
    classes: {
      premium: {
        protectedConcurrent: 6,
        maxConcurrent: 10,
        protectedInFlightTokens: 12_000,
        maxInFlightTokens: 20_000,
      },
      standard: {
        protectedConcurrent: 2,
        maxConcurrent: 6,
        protectedInFlightTokens: 4_000,
        maxInFlightTokens: 10_000,
      },
    },
  },
});
```

Eight concurrency slots and 16,000 tokens are protected. The remaining four
slots and 8,000 tokens are shared. Premium may exceed its floor by borrowing
from that shared remainder, but it cannot consume the two slots or 4,000
tokens protected for standard.

## Ceilings only

Floors are optional. A class table with ceilings alone gives you hard
isolation without reservations:

```ts
const bulkhead = createLLMBulkhead({
  model: "gpt-4o",
  maxConcurrent: 12,
  tokenBudget: { budget: 24_000 },
  admissionClasses: {
    defaultClass: "standard",
    classes: {
      premium:  { maxConcurrent: 8, maxInFlightTokens: 18_000 },
      standard: { maxConcurrent: 4, maxInFlightTokens: 6_000 },
    },
  },
});

await bulkhead.run(request, callProvider, {
  admissionClass: "premium",
  dedupScope: trustedTenantId,
});
```

## Scope and trust model

The class table is fixed at construction, which bounds runtime state and
metric cardinality. Unknown IDs throw instead of creating unbounded state.
`applyLimits()` may update class numbers atomically, but every snapshot must
contain exactly the construction-time class keys.

Map authenticated tenants or applications to these trusted policy buckets
instead of using arbitrary identity values as class IDs. Admission classes are
intentionally policy buckets, not raw tenant IDs. The library does not
authenticate callers, assign identities, implement weighted fairness, or
coordinate capacity across processes. Those responsibilities remain in the
gateway and control plane.

When in-flight deduplication is enabled, the selected admission class is an
automatic deduplication partition. Identical requests in `premium` and
`standard` therefore execute independently rather than sharing the first
class's admission decision or queue position. `dedupScope` remains necessary
for tenant-level isolation inside a class.

## Telemetry

- `stats().admissionClasses.shared` for the shared concurrency/token remainder.
- Per-class protected and borrowed in-flight usage.
- Cumulative admissions whose concurrency came from shared capacity.
- Cumulative reservation tokens placed in shared capacity at admission.
- Cumulative borrowed concurrency abandonments globally and per class, split
  globally by `manual` versus `deadline` cause.
- `resources.borrowedConcurrency` and `resources.borrowedTokens` attribution
  on admission, final release, tokens, and run contexts.
- Rejection details showing protected, borrowed, and available shared
  capacity, and whether the binding constraint was `global` or
  `admission_class`.

Lifecycle results, run contexts, tokens, usage reports, capacity details, and
telemetry events carry `admissionClass` when configured.
