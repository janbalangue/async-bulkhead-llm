# Changelog

All notable changes to this project will be documented in this file.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adheres to [Semantic Versioning](https://semver.org/).

---

## [3.6.0] - 2026-07-19

### Added

* **Exact reservation preview via `bulkhead.estimate(request)`.** The new
  method runs the same estimator and validation path used by
  `acquire()`, `run()`, and `wouldAdmit()`, returning
  `{ input, maxOutput, reserved }` without acquiring capacity. It returns
  `null` when token-budget admission is disabled. This gives gateways and
  external capacity coordinators one authoritative reservation calculation
  instead of forcing them to duplicate estimator logic.

* **Stable admission IDs.** Every successful admission now receives a
  process-unique UUID exposed on the successful `acquire()` result,
  `LLMToken`, `LLMRunContext`, and the `admit` / `release` lifecycle events.
  Admission events also expose the resolved priority, and release events now
  include the pre-release held-token count plus the final usage-event
  sequence. These fields let gateways correlate HTTP requests, traces,
  distributed leases, usage updates, and release records without maintaining
  fragile side maps.

* **Ordered `usage` lifecycle events.** Effective cumulative
  `reportUsage()` updates now emit an event containing the admission ID,
  priority, monotonically increasing per-admission sequence, previous/current
  hold, hold delta, cumulative usage, output-cap state, and over-reservation
  status. Duplicate or stale reports that do not increase either cumulative
  usage field are suppressed. Sequence numbers allow external coordinators to
  reject duplicate or out-of-order updates safely. The returned `UsageReport`
  now also includes `admissionId` and the current `sequence`, so a gateway can
  await an external absolute-hold update before forwarding more streamed data.

### Changed

* `LLMEventMap["admit"]` and `LLMEventMap["release"]` include additional
  correlation and accounting fields. Existing listener behavior is unchanged;
  the additions are backward-compatible for consumers that read only the
  previous fields.

* `request.max_tokens` validation is centralized in the shared reservation
  path, so `estimate()`, `wouldAdmit()`, `acquire()`, and `run()` now validate
  it consistently even when a custom estimator ignores that field.

---

## [3.5.0] - 2026-07-19

### Fixed

* **Deduplication no longer silently hands followers a single-consumer
  result.** Dedup shares the leader's resolved value with every follower
  by reference. For plain JSON results that is correct, but for streaming
  results — `ReadableStream`, Node `Readable`, async iterables, `Response`
  bodies — the shared object can only be consumed once: whichever caller
  read first won, and the rest received a locked or drained stream, with
  no error at the bulkhead. Followers whose shared result is detected as
  single-consumer now reject with
  `LLMBulkheadRejectedError("unshareable_result")` (new reject reason,
  counted in `stats().llm.rejectedByReason` and emitted via the `reject`
  event, without capacity detail — like other dedup-wait rejections).
  The **leader is never affected** and always receives the original
  result. Detection is deliberately shallow: only the result value itself
  is inspected, so a stream nested inside a wrapper object is still
  shared by reference as before.

### Added

* **`deduplication.shareResult` fan-out hook.** Called once per follower
  with the leader's resolved result; its return value is what that
  follower receives. This is the seam for making streaming dedup
  *work* rather than merely fail loudly — e.g.
  `shareResult: (r) => (r as Response).clone()` for `fetch` responses, or
  a tee/replay of your provider stream. When provided, the hook runs for
  every follower delivery (safe results included) and the
  single-consumer detection is bypassed — the hook owns fan-out policy.
  A throwing hook rejects that follower with the thrown error as-is;
  leader and other followers are unaffected.

* **Per-call `dedup: false` on `run()` options.** Opts a single call out
  of deduplication entirely — it neither joins an existing in-flight
  call nor registers as joinable. Intended for streaming routes on a
  bulkhead where dedup is otherwise useful, replacing the previous
  workaround of encoding exemptions in a bulkhead-wide `keyFn`.
  `dedup: true` cannot enable deduplication when it is disabled at the
  bulkhead level and is treated as omitted.

---

## [3.4.1] - 2026-07-18

> **Note:** This release is identical in content to what was intended to be
> published as `3.4.0`. That version was published to npm and then
> unpublished, and npm's registry policy prevents re-publishing a version
> number once it has been unpublished. This release republishes the same
> changes as `3.4.1`.

### Changed


* **Default deduplication key now covers the entire request.** The old key
  serialized only `{messages, max_tokens, model}`, silently conflating
  requests that differed in any other field — identical messages with
  `temperature: 0` vs `temperature: 1` shared one call, and the second
  caller received a response generated under the first caller's parameters.
  The default key is now a key-order-stable serialization of the whole
  request object, so any own enumerable property difference prevents
  conflation. Tradeoff: volatile per-request fields (request IDs,
  timestamps) now also defeat deduplication — supply a custom `keyFn` that
  omits them if your requests carry such fields. Missing a dedup
  opportunity is cheap; serving a wrong-parameters response is a
  correctness bug, so the default errs entirely toward non-conflation.
  Dedup **hit rates may drop** for callers whose requests carry extra
  fields; admission behavior is otherwise unchanged.

* **Dedup keys are SHA-256 hashed before storage.** The in-flight map
  previously held full serialized prompt text as its keys — unbounded
  per-entry key memory, and prompt content resident for the lifetime of
  the entry. Keys are now hashed (scope + `\0` + raw key), bounding key
  size and keeping prompt text out of the map. `keyFn` semantics are
  unchanged: it still returns a plain string, and `""` still opts out.

* **Bulkhead-level `timeoutMs` no longer applies to dedup followers.**
  `timeoutMs` is documented as a *queue-wait* timeout, but it was also
  being applied to a follower's wait on an already-running shared call.
  Under the `batch` profile (30s default), any LLM call slower than the
  timeout caused every follower to reject with `"timeout"` while the
  leader succeeded — defeating deduplication exactly when calls are long.
  Followers are now capped only by their own `signal` and an *explicitly
  passed* per-call `timeoutMs`. Callers who relied on the bulkhead
  default bounding follower waits should pass `timeoutMs` per call.

* **`reportUsage()` after `release()` now reports `held: 0`.** The token's
  internal hold counter was not zeroed at release, so post-release
  snapshots reported the stale pre-release hold while
  `stats().tokenBudget.inFlightTokens` correctly showed the tokens
  returned. Budget accounting was always correct; only the snapshot lied.
  `reserved` continues to report the historical pre-admission reservation.

### Added

* **`dedupScope` option on `run()`.** Requests deduplicate only within the
  same scope; different scopes never share an in-flight call even with
  identical keys. Intended for multi-tenant gateways: the default key has
  no tenant dimension, so without a scope (or a tenant-aware `keyFn`),
  two tenants sending byte-identical requests would share one response.
  Default: `""` (single global scope — prior behavior).

* Documented explicitly: deduplication applies to `run()` only;
  `acquire()` never deduplicates. (Existing behavior, previously
  undocumented.)

---

## [3.3.1] - 2026-07-17

### Changed


* **`effectiveBudget("normal")` now clamps to `0` instead of going negative.**
  Construction validates `0 <= highPriorityReserve <= budget` (a startup check
  that catches config typos), but `setBudget()` does not re-run that
  validation — a runtime budget update (e.g. driven by a lease-renewal
  ledger) is trusted as-is, since rejecting the ledger's grant would be
  incorrect. This means `currentBudget` can legitimately drop below
  `highPriorityReserve` after `setBudget()`. Previously, the normal-priority
  ceiling (`currentBudget - highPriorityReserve`) could go negative in that
  state, which was surfaced as a negative `effectiveBudget`/`available` in
  `stats()` and rejection `detail`. It is now `Math.max(0, currentBudget -
  highPriorityReserve)`.
  * **Behavioral consequence (unchanged, now made explicit):** when the
    budget grant drops below the reserve, normal-priority requests are
    fully rejected with `"budget_limit"` while `priority: "high"` requests
    are still checked against the full (shrunk) `currentBudget` and can
    keep admitting whatever capacity remains. This is the intended degraded
    behavior — `highPriorityReserve` exists specifically to protect
    interactive traffic when capacity is scarce, and capacity is never
    scarcer than when the grant itself falls below the reserve.
  * Admission decisions were already correct in this scenario (a negative
    ceiling already rejected every normal-priority request); this change
    only corrects the *reported* numbers (`stats().tokenBudget`, rejection
    `detail.tokenBudget`) from negative to `0`.
  * Construction-time validation (`highPriorityReserve <= budget`) is
    unchanged.

---


## [3.3.0] - 2026-07-17

### Changed

* **`tokenBudget.budget: 0` is now accepted at construction.** Previously,
  `createLLMBulkhead({ tokenBudget: { budget: 0 } })` threw because `budget`
  was validated as a positive integer. A budget of `0` is a legitimate state
  — e.g. a lease ledger reporting pool exhaustion for the current cycle — and
  the bulkhead now represents it as "reject all budget-gated admissions"
  rather than an invalid configuration. `budget` is now validated as a
  non-negative integer, matching the existing validation already used by
  `setBudget()`. Admission behavior is unaffected for any `budget > 0`; a
  `budget: 0` bulkhead rejects every admission that needs `> 0` tokens with
  `"budget_limit"`, and admits requests whose estimator produces a `0`-token
  reservation, consistent with `effectiveBudget()`/`tryReserveTokens()`
  semantics already in place for runtime-lowered budgets.

### Added

* **`bulkhead.setBudget(tokens)`** — mutate the token budget ceiling at
  runtime. All admission math (`acquire`/`run`, `wouldAdmit`, rejection

  `detail`, `stats()`) reads the ceiling dynamically, so a call to
  `setBudget()` propagates immediately with no other behavioral changes.
  * **Raising takes effect immediately** — the very next admission check
    sees the new headroom.
  * **Lowering below `inFlightTokens` is legal — shrink by attrition.**
    No in-flight work is revoked or cancelled. New admissions reject with
    `"budget_limit"` until enough in-flight work releases to bring
    `inFlightTokens` back under the new ceiling. This is consistent with
    the library's existing overrun tolerance (`inFlightTokens` can already
    exceed `budget` via `reportUsage()` overrun) and is pinned with a
    dedicated test.
  * **Throws if `tokenBudget` was never configured** at construction — an
    explicit error beats a silent no-op.
  * **Validates `tokens`** as a non-negative integer (`0` is valid and
    fully closes admission).

### Notes

* Purely additive: existing `tokenBudget.budget` behavior is unchanged for
  bulkheads that never call `setBudget()`.

---

## [3.2.0] - 2026-07-14


Gateway-readiness release. All changes are additive (semver-minor).

### Added

* **`LLMToken.reportUsage(usage)` / run-context `ctx.reportUsage(usage)`** —
  mid-flight cumulative usage reporting for streaming workloads.
  * Input over-estimates are refunded to the budget immediately (the full
    output reservation is retained until release).
  * Consumption beyond the hold `expands it (overrun), which can push
    `inFlightTokens` above `budget` and correctly blocks new admissions
    until the overrunning request releases.
  * Reports are clamped monotonically non-decreasing per field.
  * `release()` without explicit usage falls back to the last reported
    usage for the final refund.
  * Returns a `UsageReport` snapshot (`reserved`, `held`, `consumed`,
    `outputCap`, `outputRemaining`, `overReservation`).
* **Priority admission** — `tokenBudget.highPriorityReserve` plus per-call
  `priority: "high" | "normal"` on `acquire()`/`run()`. Normal-priority
  admission is checked against `budget - highPriorityReserve`; high-priority
  against the full budget.
* **Rejection detail** — failed `acquire()` results, `reject` events, and
  `LLMBulkheadRejectedError` now carry an optional `detail: LLMRejectDetail`
  capacity snapshot (slots, queue, priority-adjusted budget numbers).
* **`wouldAdmit(request, { priority })`** — advisory, non-reserving dry-run
  for routing decisions. Documented as racy.
* **Stats** — `tokenBudget.totalOverrun` and `tokenBudget.highPriorityReserve`.
* New exported types: `UsageReport`, ``LLMRunContext`, `LLMPriority`,
  `LLMRejectDetail`, `LLMAcquireOptions`.

### Changed

* `run()` callbacks now receive an optional second argument
  (`LLMRunContext`). Existing single-argument callbacks are unaffected.
* Release-event semantics when `reportUsage()` was used: `refundedTokens`
  on the `release` event reflects the refund *at release* (against the
  current hold); early refunds from `reportUsage()` are already included
  in `stats().tokenBudget.totalRefunded` as they occur. When
  `reportUsage()` is never called, behavior is byte-identical to 3.1.x.

### Notes

* Single-process by design: distributed budget coordination across replicas
  is explicitly out of scope (see README "Scope note").
* Backward compatible: the full 3.1.x test suite passes unmodified.

---

## [3.1.2] — 2026-05-11
`
### Fixed

* **Hardened token accounting input validation.** `tokenBudget.budget`, `tokenBudget.outputCap`, `request.max_tokens`, estimator output, and reported `TokenUsage` are now validated as finite non-negative integer token counts, with `tokenBudget.budget` required to be positive. Invalid usage passed to `release()` still releases capacity before surfacing the validation error.
* **Avoided duplicate estimator calls during admission.** Token reservation is now estimated once per acquisition attempt, then rechecked against the current budget after the underlying bulkhead slot is acquired.
* **Deduped caller cancellation.** Callers that join an existing in-flight deduplicated request now honor their own `AbortSignal` and `timeoutMs` while leaving the shared provider call running for other waiters.
* **CJS source maps after rename.** The CommonJS rename script now rewrites `sourceMappingURL` trailers and source map `file` fields from `.js` to `.cjs`.
* **Coverage setup.** Added the missing V8 coverage provider and a `test:coverage` script so `vitest run --coverage` works from a clean install.
* **Release checks.** Added stricter release scripts for lint, deterministic test runs, coverage, package smoke checks, and `npm pack --dry-run`.
* **Reduced build noise.** The CommonJS rename script no longer writes routine diagnostics during build or pack.
* **Security policy.** Updated supported versions to the current `3.x` line and removed the placeholder security email.
* **Deduplication docs.** Fixed the public JSDoc for the default deduplication key to include `model`, matching the implementation and README.

### Tests

* Added coverage for invalid token options, invalid request `max_tokens`, invalid estimator output, invalid usage reporting, one-estimation-per-acquire behavior, deduped abort/timeout behavior, and packaged ESM/CJS smoke checks.

### Notes

* Patch release: this is a hardening and packaging maintenance release. It rejects invalid numeric inputs that previously produced undefined or unsafe accounting states, but does not intentionally change supported valid API usage.

---

## [3.1.1] — 2026-05-06

### Fixed

* **`createModelAwareTokenEstimator({ defaultModel })` typing.** The estimator factory now accepts an options object as the first argument when it includes `defaultModel`, matching external call-site expectations and avoiding the previous TypeScript error where `defaultModel` was interpreted as a numeric ratio override.

### Notes

* Backward-compatible patch release. Existing `createModelAwareTokenEstimator(overrides, opts)` calls continue to work.
* Single-argument ratio overrides remain supported.
* No runtime changes to token estimation, admission, release, refund, deduplication, event, or shutdown semantics.

---

## [3.1.0] — 2026-04-26
 
### Added
 
* **`stats().tokenBudget.totalReserved`** — cumulative tokens reserved at admission across all successful admissions. Monotonically increasing. Useful as the numerator companion to `inFlightTokens`/`available` for rate and saturation analysis over time.
* **`stats().tokenBudget.totalConsumed`** — cumulative actual tokens consumed (`usage.input + usage.output`), summed across releases that reported `TokenUsage` via `token.release(usage)` or `run({ getUsage })`. Releases without usage contribute 0 — `totalConsumed` is meaningful only when `getUsage` is wired up consistently. Not clamped: over-consumption (actual > reserved) is reported as-is.
When `getUsage` is wired consistently and no over-consumption occurs, the invariant `totalReserved == totalConsumed + totalRefunded` holds after all in-flight requests settle.
 
### Changed
 
* No changes to admission, release, refund, deduplication, event, or shutdown semantics.
* **Documentation:** expanded the `release` event JSDoc to document the per-request consumption math (`usage ? usage.input + usage.output : null`) and the `null` vs `0` distinction for unreported usage. Pure docstring change — no API or behavior change.

### Notes
 
* Strict superset of the existing `totalRefunded` field — no breaking changes.
* Both new fields are present whenever `tokenBudget` is configured (alongside `totalRefunded`); both are absent when `tokenBudget` is omitted.
* These counters are designed for the library's existing scope: saturation tracking, throughput analysis, and refund-efficiency tuning (e.g., `totalRefunded / totalReserved` to surface overly generous `max_tokens` settings).
* For accurate cost accounting, the `release` event remains the right primitive — it preserves the input/output split from `TokenUsage`, which `totalConsumed` collapses into a single sum. Token estimation in this library is approximate and intentionally suited to load-shedding, not finance-grade reconciliation.

---

## [3.0.0] — 2026-04-15

### Breaking Changes

* **`LLMStats` shape changed.** `bulkhead.stats()` no longer returns base `Stats` fields at the top level.
  Base bulkhead stats now live under `stats().bulkhead`, and LLM-layer counters now live under
  `stats().llm`.
* Code that previously accessed:
  * `stats().inFlight`
  * `stats().pending`
  * `stats().maxConcurrent`
  * `stats().maxQueue`
  * `stats().closed`
  
  must now read:
  * `stats().bulkhead.inFlight`
  * `stats().bulkhead.pending`
  * `stats().bulkhead.maxConcurrent`
  * `stats().bulkhead.maxQueue`
  * `stats().bulkhead.closed`

### Added

* `stats().llm` block with LLM-layer request counters:
  * `admitted`
  * `released`
  * `rejected`
  * `rejectedByReason`

### Changed

* The `run()` callback signal type now derives from `AcquireOptions["signal"]`
  instead of referring to the global `AbortSignal` type directly.
* Test utilities now avoid direct dependency on ambient `AbortController` globals.
* Bumped `async-bulkhead-ts` to `^0.4.1`.

### Migration Guide

**From v2 → v3, update stats access only.**

Before:

```ts
const s = bulkhead.stats();
s.inFlight;
s.pending;
```

After:

```ts
const s = bulkhead.stats();
s.bulkhead.inFlight;
s.bulkhead.pending;
```

LLM-layer counters are now separate:

```ts
const s = bulkhead.stats();
s.llm.admitted;
s.llm.rejected;
s.llm.rejectedByReason.budget_limit;
```

### Notes

* No change to admission semantics, token budget semantics, deduplication behavior,
  or graceful shutdown behavior.
* This release separates underlying bulkhead telemetry from LLM-layer request telemetry.

---

## [2.0.0] — 2026-03-03

### Breaking Changes

* **Multimodal content:** `LLMMessage.content` is now `string | ContentBlock[]`. Plain strings remain valid — no changes required for text-only callers. Code that assumed `content` is always a `string` (e.g. `m.content.length`) must be updated to use `extractTextLength()` or handle both shapes.
* **Deduplication key:** the default key now includes `max_tokens` and `model` in addition to message content. Requests with identical messages but different `max_tokens` are no longer treated as duplicates (they were in v1). This is a behavioral change with no API signature change.
* **`LLMToken` replaces `Token`:** the token returned by `acquire()` now accepts optional `TokenUsage` at release time: `token.release(usage?)`. Callers that call `release()` with no arguments are unaffected.
* **`LLMStats.tokenBudget` shape:** added `totalRefunded` field to the token budget stats block.

### Added

* **Token refund mechanism.** When `TokenUsage` is passed to `token.release(usage)` or extracted via `getUsage` in `run()`, the bulkhead returns the difference between the pre-admission reservation and actual consumption to the budget immediately. This dramatically improves budget utilization — requests that use fewer output tokens than `max_tokens` no longer hold phantom capacity.
* **`run()` `getUsage` option.** `run(request, fn, { getUsage })` accepts a function that extracts `TokenUsage` from the result of `fn`. The refund is applied automatically on successful completion.
* **Per-request model override.** `LLMRequest.model` is now an optional field. When present, the model-aware estimator uses it for ratio lookup instead of the bulkhead-level `defaultModel`. Supports A/B testing, canary deployments, and mixed-model routing.
* **Multimodal content blocks.** `LLMMessage.content` accepts `ContentBlock[]` with typed `TextContentBlock` and `OpaqueContentBlock` variants. Built-in estimators extract text from text blocks and ignore non-text blocks. `extractTextLength()` is exported as a utility.
* **Custom deduplication key.** `deduplication` now accepts `DeduplicationOptions` with a `keyFn` property. The default key function includes `messages`, `max_tokens`, and `model`. Return an empty string from `keyFn` to opt a specific request out of deduplication.
* **Event system.** `bulkhead.on(event, listener)` subscribes to lifecycle events: `'admit'`, `'reject'`, `'release'`, `'dedup'`. Returns an unsubscribe function. Listeners are called synchronously; exceptions are silently caught.
* **Graceful shutdown.** `bulkhead.close()` stops admission permanently. `bulkhead.drain()` returns a promise that resolves when all in-flight work completes. Compose as `close()` → `drain()` for clean shutdown. Both are forwarded from `async-bulkhead-ts`.
* **Expanded model ratios.** Built-in ratio table now includes: `claude-haiku-4`, `claude-sonnet-4-5`, `claude-opus-4-5`, `claude-haiku-4-5`, `gpt-4.1`, `o4-mini`, `gemini-2.5`.
* **`LLMStats.tokenBudget.totalRefunded`** — cumulative tokens returned to the budget via the refund mechanism.

### Changed

* `createModelAwareTokenEstimator` now checks `request.model` before `defaultModel` for ratio lookup.
* Default deduplication key includes `max_tokens` and `model` (see Breaking Changes).
* Prefix matching in the estimator now uses an iterative longest-match scan instead of `filter + sort`, avoiding an allocation per call.
* `LLMBulkhead` return type now includes `close`, `drain`, and `on` methods.

### Removed

* Nothing removed. All v1 public types remain exported.

### Migration Guide

**From v1 → v2, most callers need zero changes.** The common path — `createLLMBulkhead(opts)` → `bulkhead.run(request, fn)` — is fully backward-compatible for text-only requests.

Changes required only if you:

1. **Access `content` directly on `LLMMessage`:** replace `m.content.length` with `extractTextLength(m.content)` or guard with `typeof m.content === 'string'`.
2. **Rely on dedup treating different `max_tokens` as identical:** pass a custom `keyFn` that omits `max_tokens`: `deduplication: { keyFn: (r) => JSON.stringify(r.messages) }`.
3. **Inspect `tokenBudget` stats structurally:** the new `totalRefunded` field is always present when `tokenBudget` is configured.

### Design Notes

* Token refund is opt-in and zero-cost when not used. Calling `release()` with no argument behaves identically to v1.
* `getUsage` is intentionally separated from `fn` to avoid coupling the LLM call signature to the bulkhead. The caller extracts usage from whatever their provider returns.
* The event system is deliberately minimal — synchronous, fire-and-forget, no async listeners. It's designed for metrics counters and logging, not for control flow.
* `close()` and `drain()` are thin forwards to `async-bulkhead-ts`. The LLM layer adds no new shutdown semantics — it inherits the base library's guarantees.
* Multimodal estimation is intentionally conservative. Non-text blocks contribute zero to the estimate. Callers who need accurate multimodal estimation should provide a custom `estimator`.

---

## [1.0.3] — 2026-02-26

### Changed

* Aligned package.json license field with the repository license (Apache-2.0)
* No runtime, API, or type changes

### Notes

* Metadata-only correction
* Fully compatible with 1.0.0–1.0.2
* Safe upgrade

---

## [1.0.2] — 2026-02-26

### Changed

* Corrected GitHub URLs in `package.json` (homepage, repository, bugs) to point to the canonical repository
* No runtime, API, or type changes

### Notes

* Packaging outputs (ESM, CJS, types) unchanged
* Fully compatible with `1.0.0` and `1.0.1`
* Safe upgrade — metadata-only correction

---

## [1.0.1] — 2026-02-26

### Changed

* Bumped `async-bulkhead-ts` to `^0.3.0`

### Notes

* No API changes
* No functional behavior changes in `async-bulkhead-llm`

---

## [1.0.0] — 2026-02-24

### Added

* Initial release of **async-bulkhead-llm**
* `createLLMBulkhead(options)` — fail-fast admission control for LLM workloads, wrapping `async-bulkhead-ts`
* `model` required at construction time — one bulkhead per model is the enforced deployment pattern
* `profile` option — `'interactive'` (fail-fast, default) and `'batch'` (bounded queue, 30s timeout) presets; escape hatch via plain `LLMBulkheadPreset` object; explicit options always override preset defaults
* Token-aware admission via `tokenBudget` — reserves `input + maxOutput` tokens pre-admission; fail-fast when the budget ceiling is hit, independent of concurrency headroom and profile
* `naiveTokenEstimator` — flat 4.0 character-per-token ratio; zero configuration; suitable for load-shedding
* `createModelAwareTokenEstimator` — per-model character ratios for known model families across Anthropic, OpenAI, and Google; longest-prefix match; exact caller overrides checked before prefix scan; `onUnknownModel` hook; falls back to 4.0 ratio for unknown models
* In-flight request deduplication via `deduplication: true` — identical requests (keyed on `JSON.stringify(messages)`) share one in-flight LLM call; dedup hits tracked in `stats()`
* `bulkhead.run(request, fn, options?)` — primary API; acquire + release handled automatically; throws `LLMBulkheadRejectedError` on rejection
* `bulkhead.acquire(request, options?)` — manual acquire / release for advanced control flow; returns typed result object
* `LLMBulkheadRejectedError` — typed error with `code: 'LLM_BULKHEAD_REJECTED'` and `reason: LLMRejectReason`
* `LLMRejectReason` — extends base `RejectReason` from `async-bulkhead-ts` with `'budget_limit'`
* `TokenUsage` type — exported as a forward-looking type for v2 refund support; not acted on in v1
* `bulkhead.stats()` — returns `LLMStats` extending the base `Stats` type with optional `tokenBudget` and `deduplication` blocks; optional blocks are absent when the feature is disabled
* `PROFILES` exported — named presets available for direct inspection and composition
* AbortSignal and `timeoutMs` cancellation — threaded through to `fn` via `run()`; waiting-only timeout semantics inherited from `async-bulkhead-ts`
* ESM and CommonJS builds
* Full TypeScript typings
* Vitest test suite covering estimation, admission, token budget, deduplication, cancellation, profile resolution, and a 4-second soak test validating all invariants under churn

### Design Notes

* Fail-fast is the opinionated default — `maxQueue: 0` unless overridden via `profile` or explicit option
* Token budget admission is always fail-fast, independent of queue configuration — budget is a cost ceiling, not a scheduling constraint
* One bulkhead per model is enforced by design; `model` is a required constructor argument and does not appear on `LLMRequest`; multi-model routing is documented as a README recipe
* Token estimation is intentionally approximate — suitable for load-shedding, not cost accounting
* Refund mechanism (correcting reservations against actual post-call usage) is deferred to v2; `TokenUsage` type is exported now to allow call sites to be written correctly ahead of v2
* Multimodal content (images, structured blocks) is a known v1 limitation — `content` must be a plain string; estimators ignore non-string content; documented on `LLMRequest`
* Deduplication key is `JSON.stringify(messages)` in v1 — requests with identical messages but different `max_tokens` are treated as duplicates; key design improvements deferred to v2
* `tryAcquire()` from the base library is not exposed — synchronous non-blocking admission is not meaningful for LLM workloads where token budget requires the full request object
* Zero dependencies beyond `async-bulkhead-ts`

---