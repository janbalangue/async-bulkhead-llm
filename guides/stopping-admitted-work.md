---
title: Stopping admitted work
---

# Stopping admitted work

By default the bulkhead never touches a call once it has admitted it. A
stream that reports more tokens than it reserved only widens its hold, a
bounded `drain()` only reports what is still running, and a limits snapshot
that lowers a ceiling waits for running calls to finish by themselves.

Since v3.18 you can opt in to stopping admitted work in those three
situations. Nothing here is on unless you ask for it.

## What a stop is

A stop means the same thing whatever triggered it:

- The signal passed to the `run()` callback is aborted. Its `reason` is the
  error below.
- The caller's promise rejects with `LLMAdmissionStoppedError`, which carries
  `admissionId` and `cause`.
- The concurrency slot returns immediately, so the next caller can use it.
- The token hold **stays charged until the callback settles**. Aborting a
  signal locally does not prove the provider stopped generating, so the
  tokens are not handed to someone else on that assumption. The borrowed-slot
  deadline follows the same rule.
- A `stop` event fires once for the call.

```ts
import { LLMAdmissionStoppedError } from 'async-bulkhead-llm';

try {
  await bulkhead.run(request, (signal) => callLLM(request, { signal }));
} catch (err) {
  if (err instanceof LLMAdmissionStoppedError) {
    // err.cause: 'overrun' | 'drain_deadline' | 'limits'
    return respond503(`Stopped: ${err.cause}`, err.admissionId);
  }
  throw err;
}
```

A stop is not an admission rejection. The call was admitted, and the provider
may already have done part or all of the work.

## Turning it on

The stop policy is part of the limits snapshot:

```ts
const current = bulkhead.limits();

bulkhead.applyLimits({
  ...current,
  revision: current.revision + 1,
  stop: {
    overrunAllowanceTokens: 500,
    takeBackGraceMs: 2_000,
  },
});
```

Like every other limit, the policy is **not inherited from the previous
revision**. A snapshot without `stop` has no policy, and nothing is stopped
under it. `limits()` returns the applied policy, so spreading `limits()` into
the next snapshot keeps it, and `setBudget()` carries it along. A control
plane that builds each snapshot from scratch has to state `stop` every time.

Each field turns on one trigger. `stop: {}` turns on neither, but it still
counts as a policy for the next section.

### Which callbacks can be aborted

`run()` gives the callback a signal the engine can abort only when a stop
policy is active **at the moment the call is admitted**. Without one, the
callback receives exactly what the caller passed, the same signal object or
nothing, as in every earlier release.

A call admitted without a policy can still be stopped later, by a drain or by
a policy that arrives afterward. Its caller is rejected and its slot returns,
but its callback is not aborted and runs on until it settles by itself. If you
want `drain({ stopOnTimeout: true })` to abort callbacks, apply at least
`stop: {}` before admitting work.

Under a policy, a caller's own signal still works: aborting it aborts the
callback's signal with the same reason. The engine never aborts the caller's
signal.

## The three triggers

### Overrun: `stop.overrunAllowanceTokens`

The allowance is how far a call's hold may grow above its reservation. One
token more stops the call with cause `"overrun"`.

```ts
// Reserved: 100 input + 1000 output = 1100. Allowance: 100.
ctx.reportUsage({ input: 100, output: 1100 }); // hold 1200: fine
ctx.reportUsage({ input: 100, output: 1101 }); // hold 1201: stopped
```

Setting the allowance also turns on ceiling fitting. When a usage report
raises a hold and leaves a class above its `maxInFlightTokens`, or the pool
above its budget, calls are stopped with the same cause until the holds of the
calls still running fit, even if no call passed its own allowance. If a class
is above its ceiling, only calls of that class are picked.

Two details keep this from doing more than you asked:

- Only a report that raises a hold can stop anything. A report that lowers a
  hold, or repeats the last one, never does.
- If a snapshot had already lowered a ceiling below what is running, a report
  only undoes its own growth. Bringing running work down to a lowered limit is
  the take-back's job, with its own grace period.

This trigger needs a token budget. Applying `overrunAllowanceTokens` to a
bulkhead built without `tokenBudget` throws.

### Drain: `drain({ timeoutMs, stopOnTimeout: true })`

```ts
bulkhead.close();
const result = await bulkhead.drain({
  timeoutMs: 10_000,
  stopOnTimeout: true,
});
// { drained: false, inFlight: 2, pending: 0, stopped: 2 }
```

Every call still running at the deadline is stopped with cause
`"drain_deadline"`, and the result gains `stopped`, the number of calls this
drain stopped. Stopped calls remain in `inFlight` until their callbacks
settle, so a later `drain()` still waits for them.

This trigger needs no stop policy, but see
[which callbacks can be aborted](#which-callbacks-can-be-aborted). Call
`close()` first: stopping frees slots, and without `close()` queue waiters
take them.

### Take-back: `stop.takeBackGraceMs`

When a snapshot leaves running work above the new limits, nothing is stopped
during the grace period, and calls that finish inside it are left alone. When
the grace period ends, enough calls are stopped to fit, with cause
`"limits"`.

```ts
bulkhead.applyLimits({
  ...bulkhead.limits(),
  revision: nextRevision,
  maxConcurrent: 4, // 6 calls are running
  stop: { takeBackGraceMs: 2_000 },
});
// Two seconds later, if 6 are still running, 2 are stopped.
```

"Above the new limits" covers the global concurrency ceiling, the token
budget, a class's own ceilings, and a class floor that was restored while
other classes were using that capacity.

Any snapshot that is applied afterward replaces a take-back that is still
waiting. If the newer snapshot fits the running work, or has no
`takeBackGraceMs`, nothing is stopped. If it still leaves work above the
limits, its own grace period starts from the moment it is applied. Snapshots
that keep arriving faster than the grace period therefore keep postponing the
take-back; choose a grace period shorter than the interval between revisions.

A grace period of `0` stops on the next timer tick, never inside
`applyLimits()` itself.

## Which calls are stopped first

Whenever the engine has to pick, the order is fixed:

1. Calls admitted on borrowed capacity (`resources.borrowedConcurrency`, or
   `resources.borrowedTokens` above zero).
2. Normal priority before high priority.
3. On a tie, the call admitted last.

A call that is already stopped is not counted or picked again.

These are never stopped:

- **Deduplication followers.** A follower holds no capacity. It gets the
  error its leader was stopped with.
- **Observe-mode bypasses.** They hold no capacity either.
- **Queue waiters.** They have not been admitted.

## `acquire()` tokens

A token from `acquire()` has no signal. It learns about a stop from the `stop`
event and from `stopped: true` on its usage reports, starting with the report
that caused the stop. Its slot has already been returned; its tokens stay
charged until `release()`.

```ts
const report = token.reportUsage(cumulativeUsage);
if (report.stopped) {
  await cancelUpstream();
  token.release(lastKnownUsage);
}
```

## Watching it

```ts
const s = bulkhead.stats();
s.llm.stopped;                  // absent until the first stop
s.llm.stoppedByCause?.overrun;
s.admissionClasses?.classes.batch?.stopped;

bulkhead.on('stop', ({ admissionId, cause, heldTokens, resources }) => {
  metrics.increment(`llm.stopped.${cause}`);
});
```

`llm.inFlight` minus `bulkhead.inFlight` is the number of admissions that
have given their slot back but still hold tokens: stopped calls whose
callbacks have not settled, plus abandoned borrowed slots.

## What a stop does not prove

A stop is a local decision. It returns the local slot at once and asks the
callback to end. It does not prove that a provider account, a model-side
queue, or an accelerator stopped work, which is why the tokens stay charged
until the callback settles. A callback that ignores its signal keeps its
tokens charged for as long as it runs. If the constrained resource is
upstream, keep an unlent floor or use a provider-side partition.
