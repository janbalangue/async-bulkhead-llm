---
title: Streaming and reconciliation
---

# Streaming and reconciliation

A reservation made at admission is a guess about a request that has not run
yet. Streaming responses let you correct it while the call is still in flight.

## Reporting cumulative usage

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

## Progressive reconciliation

Gateways that receive cumulative streaming usage may opt into shrinking the
active hold before request completion:

```ts
const report = ctx!.reportUsage(
  { input: actualInput, output: cumulativeOutput },
  {
    remainingOutputTokens: Math.max(0, maxOutput - cumulativeOutput),
    safetyMarginTokens: 128,
  },
);
```

The progressive hold is:

```text
remainingOutputTokens + safetyMarginTokens + output overrun
```

This lets processed input and already-generated output stop occupying the
in-flight budget. The caller must use the option only after prefill is known
to be complete and must derive `remainingOutputTokens` from an authoritative
provider output cap. Omitting the second argument preserves the behavior of
retaining the full output reservation until release. Final `release()`
settlement remains authoritative.

Progressive updates share the existing sequence-numbered `usage` event. Events
include `progressive`, `remainingOutputTokens`, and `safetyMarginTokens` when
the progressive mode is used.

## Ordered usage-change events

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

## Streaming results and deduplication

Streaming results cannot be shared by reference between deduplicated callers.
See [Deduplication](deduplication.md) for `shareResult` and the per-call
`dedup: false` opt-out.
