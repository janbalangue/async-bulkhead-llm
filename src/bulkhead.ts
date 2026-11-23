/**
 * `createLLMBulkhead`: the entry point of the admission engine.
 *
 * This file validates the options, builds the engine's parts, wires them
 * together and returns the public API. The parts live in `src/engine`,
 * one concern per file.
 *
 * Owners. Each limit or counter is written in exactly one of these files,
 * and every other part reads or changes it through that owner. An
 * admission class is always passed around as its id:
 *
 * - `limits.ts`           — revision, token budget, high-priority reserve,
 *                           the class limits and the stop policy
 * - `token-ledger.ts`     — token counters, for the pool and per class
 * - `class-slots.ts`      — slot counts per class (the global slot count
 *                           stays in `reconfigurable-bulkhead.ts`)
 * - `admission-counts.ts` — admitted, released, rejected, abandoned and
 *                           stopped counts, global and per class
 * - `running-calls.ts`    — the admitted calls still running, and the
 *                           order in which they would be stopped
 * - `observe-stats.ts`    — observe-mode counters
 * - `dedup-flow.ts`       — the in-flight deduplication map and hit count
 *
 * Decisions and flows:
 *
 * - `options.ts`, `class-limits.ts`          — option validation
 * - `admission-request.ts`, `reservation.ts` — what one call asks for
 * - `shared-usage.ts`, `capacity.ts`         — does it fit; reserve it
 * - `reject-detail.ts`, `would-admit.ts`     — capacity snapshots and the
 *                                              advisory dry run
 * - `acquire.ts`                             — the admission sequence
 * - `admitted-token.ts`, `usage-report.ts`   — the admitted token and its
 *                                              usage reports
 * - `run.ts`, `run-options.ts`, `admitted-run.ts`, `bypass.ts` — `run()`
 * - `stop.ts`, `limit-fit.ts`, `stop-policy.ts` — when admitted work is
 *                                              stopped, and which calls
 * - `stats.ts`, `events.ts`, `shutdown.ts`
 */
import type {
  Listener,
  LLMAdmissionLimits,
  LLMApplyLimitsResult,
  LLMAcquireOptions,
  LLMAcquireResult,
  LLMBulkheadOptions,
  LLMDrainResult,
  LLMEventType,
  LLMPriority,
  LLMRequest,
  LLMReservationEstimate,
  LLMReservationOverride,
  LLMRunContext,
  LLMRunOptions,
  LLMStats,
  LLMWouldAdmitResult,
} from "./types.js";
import { createReconfigurableBulkhead } from "./reconfigurable-bulkhead.js";
import { createAcquire } from "./engine/acquire.js";
import { createAdmissionCounts } from "./engine/admission-counts.js";
import { createAdmissionResolver } from "./engine/admission-request.js";
import { createTokenWrapper } from "./engine/admitted-token.js";
import { createBypass } from "./engine/bypass.js";
import { createCapacity } from "./engine/capacity.js";
import { createClassSlots } from "./engine/class-slots.js";
import { createDedup } from "./engine/dedup-flow.js";
import { createEventHub } from "./engine/events.js";
import { createLimits } from "./engine/limits.js";
import { createObserveStats } from "./engine/observe-stats.js";
import { resolveOptions } from "./engine/options.js";
import { createRejectDetail } from "./engine/reject-detail.js";
import { createReservations } from "./engine/reservation.js";
import { createRun } from "./engine/run.js";
import { createRunningCalls } from "./engine/running-calls.js";
import type { BulkheadSignal } from "./engine/shared.js";
import { createSharedUsage } from "./engine/shared-usage.js";
import { createShutdown } from "./engine/shutdown.js";
import { createStats } from "./engine/stats.js";
import { createStopper } from "./engine/stop.js";
import { createTokenLedger } from "./engine/token-ledger.js";
import { createWouldAdmit } from "./engine/would-admit.js";

// ────────────────────────────────────────────
// createLLMBulkhead
// ────────────────────────────────────────────

export function createLLMBulkhead(opts: LLMBulkheadOptions) {
  // ---- Validate and resolve options ----
  const config = resolveOptions(opts);

  // ---- Internal reconfigurable concurrency bulkhead ----
  const concurrency = createReconfigurableBulkhead({
    maxConcurrent: opts.maxConcurrent,
    maxQueue: config.maxQueue,
  });

  // ---- Token budget: accounting is on when `tokenBudget` is set ----
  const budget = opts.tokenBudget;
  const budgetEnabled = Boolean(budget);
  const reservations = createReservations(budget, opts);
  const events = createEventHub();

  // ---- Owners: every limit and counter has exactly one of these ----
  const admissionLimits = createLimits(config, budget, concurrency, events);
  const classIds = admissionLimits.classIds;
  const owners = {
    budgetEnabled,
    concurrency,
    events,
    limits: admissionLimits,
    ledger: createTokenLedger(budgetEnabled, classIds),
    slots: createClassSlots(classIds),
    counts: createAdmissionCounts(classIds),
    observeStats: createObserveStats(),
    running: createRunningCalls(),
  };
  const dedup = createDedup({ ...owners, options: opts.deduplication });

  // ---- Capacity decisions: they read the owners and keep no state ----
  const usage = createSharedUsage(owners);
  const capacity = createCapacity({ ...owners, usage });
  const buildRejectDetail = createRejectDetail({ ...owners, usage });
  const resolveAdmission = createAdmissionResolver(
    admissionLimits,
    reservations,
  );
  const wouldAdmitResolved = createWouldAdmit({
    concurrency,
    capacity,
    buildRejectDetail,
  });

  // ---- Admission, execution, stopping, stats and shutdown ----
  // The stopper decides which calls to stop; the token wrapper, built
  // just below, is what stops one.
  const stopper = createStopper({
    ...owners,
    stop: (call, cause) => tokens.stop(call, cause),
  });
  const shutdown = createShutdown(
    concurrency,
    owners.counts,
    stopper.stopForDrain,
  );
  const tokens = createTokenWrapper({
    ...owners,
    holdGrew: stopper.holdGrew,
    settleDrainWaiters: shutdown.settleDrainWaiters,
  });
  const admit = createAcquire({
    ...owners,
    capacity,
    buildRejectDetail,
    resolveAdmission,
    wrapToken: tokens.wrap,
    timeoutMs: config.timeoutMs,
  });
  const runBypassed = createBypass({ ...owners, buildRejectDetail });
  const readStats = createStats({ ...owners, usage, dedup });

  // ---- Public API ----

  /**
   * Preview the exact token reservation that admission will calculate.
   *
   * This calls the same estimator and validation path as `acquire()`,
   * `run()`, and `wouldAdmit()`. It does not reserve capacity. Returns
   * `null` when `tokenBudget` is disabled because admission does not hold
   * tokens in that mode.
   *
   * Custom estimators should be deterministic: if either the request or
   * estimator output changes between `estimate()` and admission, the later
   * admission will correctly use the newly calculated value.
   *
   * A per-call `reservation` override passed to `acquire()` / `run()` /
   * `wouldAdmit()` bypasses the estimator and is NOT reflected here —
   * `estimate()` always previews the estimator path.
   */
  function estimate(request: LLMRequest): LLMReservationEstimate | null {
    return reservations.estimate(request);
  }

  /**
   * Acquire a slot manually.
   *
   * The returned token accepts optional `TokenUsage` at release time
   * to trigger the refund mechanism. For most use cases, prefer `run()`.
   */
  async function acquire(
    request: LLMRequest,
    ao: LLMAcquireOptions = {},
  ): Promise<LLMAcquireResult> {
    return admit(request, ao);
  }

  /**
   * Primary API. Acquire → call `fn` → release, automatically.
   *
   * Throws `LLMBulkheadRejectedError` on rejection.
   *
   * When `getUsage` is provided in options, it is called with the result
   * of `fn` to extract actual token usage. The refund mechanism then
   * returns the difference between the reservation and actual consumption
   * to the budget.
   *
   * Deduplication (when enabled) applies to `run()` only; `acquire()`
   * never deduplicates. A caller that joins an existing in-flight call
   * is capped only by its own `signal` and an *explicitly passed*
   * per-call `timeoutMs` — the bulkhead-level `timeoutMs` (a queue-wait
   * timeout) does not apply to that wait.
   */
  const run: <T>(
    request: LLMRequest,
    fn: (signal?: BulkheadSignal, ctx?: LLMRunContext) => Promise<T>,
    ao?: LLMRunOptions<T>,
  ) => Promise<T> = createRun({
    limits: admissionLimits,
    dedup,
    resolveAdmission,
    wouldAdmitResolved,
    acquire: admit,
    runBypassed,
  });

  /**
   * Advisory dry-run: would a request of this shape be admitted right
   * now at the given priority?
   *
   * This is a snapshot for routing decisions (e.g. pick a different
   * model pool). It does NOT reserve anything — the answer can change
   * before a subsequent `acquire()`/`run()` lands. Never treat `true`
   * as a guarantee.
   *
   * Accepts the same per-call `reservation` override as `acquire()` /
   * `run()` (v3.7); pass the identical value to both for a consistent
   * preview.
   *
   * v3.8: pass `detail: true` to also receive the same capacity
   * snapshot (`LLMRejectDetail`) that real rejections carry — including
   * on an `admit: true` answer, where it describes the capacity the
   * request would be admitted against. Routing layers choosing between
   * pools usually want these numbers, not just the boolean. Omitted by
   * default so the result shape (and its cost) is unchanged for
   * existing callers.
   *
   * v3.8: the request (and any `reservation` override) is validated
   * before the shutdown check, matching `acquire()` — an invalid
   * request now throws even when the bulkhead is closed.
   */
  function wouldAdmit(
    request: LLMRequest,
    opts: {
      priority?: LLMPriority;
      admissionClass?: string;
      reservation?: LLMReservationOverride;
      detail?: boolean;
    } = {},
  ): LLMWouldAdmitResult {
    return wouldAdmitResolved(resolveAdmission(request, opts), opts.detail === true);
  }

  /** Runtime stats. Optional fields are present only when the feature is enabled. */
  function stats(): LLMStats {
    return readStats();
  }

  /** Return a detached snapshot of the currently applied limits. */
  function limits(): LLMAdmissionLimits {
    return admissionLimits.snapshot();
  }

  /**
   * Atomically apply a complete, higher-revision admission-limit snapshot.
   *
   * All fields are validated before any state changes. Equal or lower
   * revisions are rejected as stale without mutation. Lower concurrency,
   * queue, or token ceilings use shrink-by-attrition: in-flight work and
   * already accepted waiters are not canceled. Raising concurrency pumps
   * accepted waiters immediately after the complete snapshot is installed.
   *
   * v3.18: a snapshot may carry an opt-in `stop` policy. With
   * `stop.takeBackGraceMs`, running work the snapshot leaves above the new
   * limits is stopped once the grace period ends, instead of being waited
   * out. Accepted waiters are still never canceled. A snapshot without
   * `stop` has no policy, whatever the previous revision said, and any
   * applied snapshot replaces a take-back that is still waiting.
   */
  function applyLimits(next: LLMAdmissionLimits): LLMApplyLimitsResult {
    const result = admissionLimits.apply(next);
    if (result.applied) stopper.limitsApplied();
    return result;
  }

  /**
   * Backward-compatible budget-only setter.
   *
   * This is implemented as a complete local reconfiguration at
   * `currentRevision + 1`. Externally managed deployments should use
   * `applyLimits()` exclusively so one authority owns the revision stream.
   * The applied stop policy, if any, is carried into the new revision.
   */
  function setBudget(tokens: number): void {
    admissionLimits.setBudget(tokens);
    stopper.limitsApplied();
  }

  /**
   * Stop admission permanently. All pending waiters in the underlying
   * bulkhead are rejected with `'shutdown'`. Future `acquire`/`run`
   * calls reject immediately. In-flight work is not interrupted.
   */
  function close(): void {
    shutdown.close();
  }

  /**
   * Returns a promise that resolves when all in-flight work and
   * pending waiters have completed. Works with or without `close()`.
   * Compose as `close()` → `drain()` for graceful shutdown.
   *
   * v3.17: an admission remains in-flight here until final token
   * settlement, even if `abandonBorrowedConcurrency()` already returned
   * its local slot. A manual `acquire()` caller must eventually call
   * `release()`; otherwise an unbounded `drain()` intentionally remains
   * pending. Use `{ timeoutMs }` when shutdown itself must be bounded.
   *
   * v3.8: pass `{ timeoutMs }` to bound the wait. The returned promise
   * then always *resolves* (never rejects) with an `LLMDrainResult`:
   * `{ drained: true, inFlight: 0, pending: 0 }` if everything
   * completed within the deadline, or `{ drained: false, ... }` with
   * the outstanding counts at the moment the deadline elapsed —
   * letting a shutdown path log what it is abandoning and proceed. The
   * deadline does not cancel or interrupt in-flight work, and the
   * bulkhead's accounting is untouched: work that finishes later still
   * releases normally. `timeoutMs` must be a non-negative integer;
   * `0` is an immediate snapshot ("is it drained right now?"). Each
   * timed-out call leaves one internal already-resolved-later waiter
   * behind until the bulkhead actually drains — harmless, but poll
   * with `stats()` rather than in a tight `drain({ timeoutMs: 0 })`
   * loop.
   *
   * v3.18: add `stopOnTimeout: true` to stop every call still running at
   * the deadline, with cause `"drain_deadline"`. The result then carries
   * `stopped`, the number of calls it stopped. Their slots return at once,
   * but they stay in `inFlight` until their callbacks settle, so a later
   * `drain()` still waits for them. Queue waiters are never stopped; call
   * `close()` first so the freed slots are not handed to them. A callback
   * is aborted only if a stop policy was active when it was admitted;
   * otherwise only its caller's promise rejects.
   */
  function drain(): Promise<void>;
  function drain(opts: {
    timeoutMs: number;
    stopOnTimeout?: boolean;
  }): Promise<LLMDrainResult>;
  function drain(opts?: {
    timeoutMs?: number;
    stopOnTimeout?: boolean;
  }): Promise<void> | Promise<LLMDrainResult> {
    return shutdown.drain(opts);
  }

  /**
   * Subscribe to a bulkhead lifecycle event.
   * Returns an unsubscribe function.
   *
   * Listeners are called synchronously from the bulkhead's internal
   * control flow. They must not throw — exceptions are silently caught.
   */
  function on<K extends LLMEventType>(
    event: K,
    listener: Listener<K>,
  ): () => void {
    return events.on(event, listener);
  }

  return {
    estimate,
    acquire,
    run,
    wouldAdmit,
    stats,
    limits,
    applyLimits,
    setBudget,
    close,
    drain,
    on,
  };
}


export type LLMBulkhead = ReturnType<typeof createLLMBulkhead>;
