# Changelog

All notable changes to this project will be documented in this file.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adheres to [Semantic Versioning](https://semver.org/).

---

## [3.0.0] —

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
* Bumped `async-bulkhead-ts` to `^0.4.1`. :contentReference[oaicite:1]{index=1}

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