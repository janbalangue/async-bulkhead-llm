# Changelog

All notable changes to this project will be documented in this file.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adheres to [Semantic Versioning](https://semver.org/).

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
