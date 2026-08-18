---
title: Observe mode
---

# Observe mode

Observe mode is an explicit rollout mode for measuring admission policy before
fully enforcing it. `run()` still attempts normal admission first. When a
configured capacity-related rejection occurs, observe mode executes the
callback without holding a concurrency slot or token reservation, and records
the bypass on a separate telemetry surface.

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

## Restrict which outcomes may be bypassed

Use `shadowReasons` to roll out one policy at a time:

```ts
await bulkhead.run(request, fn, {
  mode: "observe",
  shadowReasons: ["budget_limit"],
});
```

An empty `shadowReasons` array keeps normal enforcement while still exposing
`ctx.admission === "admitted"` to callbacks.

## Admitted and bypassed callback context

Normally admitted calls receive the same context with:

```ts
ctx.admission === "admitted"
ctx.bypassReason === undefined
```

Bypassed calls receive a `shadow-`-prefixed `admissionId`, the exact evaluated
reservation, the bypass reason, and the associated capacity detail. Their
`reportUsage()` snapshots always report `held: 0`, because observed work does
not consume bulkhead accounting capacity.

## Separate observe telemetry

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

`raceBypassed` counts calls whose advisory check passed but whose
authoritative acquisition later rejected — for example, a queued request that
timed out while capacity changed. This makes preview-to-admission races
visible instead of silently merging them into ordinary bypasses.

> Observe mode intentionally allows work to proceed without capacity
> protection. Use it for policy calibration, migration, and audit periods —
> not as the steady-state overload posture of a saturated service.
