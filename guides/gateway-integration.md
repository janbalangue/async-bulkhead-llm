---
title: Gateway integration
---

# Gateway integration

This library is designed to sit inside an AI gateway. The seams below exist
so a gateway or control plane can own policy while the bulkhead owns the
local admission decision.

## Advisory routing checks

`wouldAdmit()` is a dry-run for routing decisions ("try another model pool").
It reserves nothing and is inherently racy — never treat `true` as a
guarantee.

```ts
const { admit, reason, detail } = bulkhead.wouldAdmit(request, {
  detail: true,
});
// detail is the same LLMRejectDetail snapshot real rejections carry,
// present on admit: true as well (detail.tokenBudget.requested is the
// reservation this request needs).
```

`detail` is omitted by default, so callers that only need the boolean see the
smaller result shape.

## Stable admission identity

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

## External leases

Use `estimate()` to size an external lease before entering the local
bulkhead, and release the lease if local admission then fails. See
[Reservation preview](token-budget.md).

## Control-plane grants

Use `applyLimits()` with a strictly increasing revision as the single control
surface, and construct with `maxConcurrent: 0` so the process starts
fail-closed. See
[Runtime limits and reconfiguration](runtime-limits.md).

## Informative rejections

Failed acquisitions, `reject` events, and `LLMBulkheadRejectedError` carry a
capacity snapshot (`detail`) — slots, queue, and priority-adjusted budget
numbers — so gateways can emit informative 429/503 responses. No fabricated
`Retry-After` is provided: a fail-fast bulkhead has no honest ETA.

```ts
import { LLMBulkheadRejectedError } from 'async-bulkhead-llm';

try {
  await bulkhead.run(request, async () => callLLM(request));
} catch (err) {
  if (err instanceof LLMBulkheadRejectedError) {
    return respond503(`Shed: ${err.reason}`, err.detail);
  }
  throw err;
}
```

## Scope note

This library is single-process by design. Distributed budget coordination
across gateway replicas requires shared state and an async admission path; it
is out of scope here. For multi-replica deployments, partition the budget per
replica or coordinate above this layer.
