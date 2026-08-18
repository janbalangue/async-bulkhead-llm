---
title: Migration
---

# Migration

Every release since v2 has been additive at the call site. The notes below
cover what changes if you assert exact object shapes.

For the full per-release record, see the
[changelog](../CHANGELOG.md).

## v3.14 → v3.15

No admission call-site changes are required. Configure `protectedConcurrent`
and/or `protectedInFlightTokens` only when a class needs a strict local
guarantee. The sum of floors must fit inside the corresponding global limit.
Floors are not automatically lent while idle; a control plane must adjust them
with `applyLimits()` to implement demand-aware lending.

`stats().admissionClasses` gains `shared`, protected/borrowed usage fields,
and cumulative borrowing counters. Rejection capacity details may now use
`constraint: 'admission_class_protection'` and include `sharedCapacity`. Code
that exhaustively asserts these additive object or union shapes must be
updated. Omitting both floor fields preserves v3.14 admission behavior.

## v3.13 → v3.14

No existing call-site changes are required. `admissionClasses` is opt-in and
all new lifecycle fields are optional when the feature is disabled. Code that
exhaustively asserts event, stats, limit-snapshot, token, run-context, usage,
or rejection-detail shapes should account for the additive class fields.
Gateways should pass only trusted, bounded policy-class IDs. Admission class
automatically partitions in-flight deduplication, while `dedupScope` remains
required for tenant-level isolation inside a shared class.

## v3.11.0 → v3.11.1

No code changes are required. Update the dependency to v3.11.1 and regenerate
your lockfile. The patch keeps the v3.11 API unchanged, replaces the
conflicting v3.11.0 package artifact, updates the development dependency
lockfile, and corrects the strict capacity-snapshot test expectation.

## v3.10 → v3.11

No admission call-site changes are required. Successful acquire results,
admission tokens, run contexts, usage reports, lifecycle events, and rejection
capacity details gain `limitRevision`. Code that uses exact deep equality on
these objects must add the field. Gateways should read the captured revision
from the result, token, context, event, or rejection detail instead of calling
`limits()` after the decision.

## v3.9 → v3.10

Existing admission calls require no changes. `stats()` gains a `limits` block,
`LLMEventType` gains `"reconfigure"`, and `setBudget()` now advances the local
revision. Code that exhaustively enumerates event types should add the new
case. Control-plane integrations should move from `setBudget()` to complete
`applyLimits()` snapshots.

## v3.5 → v3.6

No call-site changes are required. `admit` and `release` event payloads gained
additional fields, and `usage` is a new event type. Code that exhaustively
enumerates `LLMEventType` should add the new `usage` case.

## v2 → v3

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

## v1 → v2

See the [changelog](../CHANGELOG.md) for the v2 migration guide.
