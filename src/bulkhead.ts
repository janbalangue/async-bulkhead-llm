/**
 * `createLLMBulkhead`: admission (concurrency + token budget +
 * priority), reservation and refund accounting, streaming usage
 * reports, deduplication orchestration, events, stats, and shutdown.
 */
import {
  createBulkhead,
  type AcquireOptions,
  type Token,
} from "async-bulkhead-ts";
import { randomUUID } from "node:crypto";
import type {
  Listener,
  LLMAcquireOptions,
  LLMAcquireResult,
  LLMBulkheadOptions,
  LLMDrainResult,
  LLMEventMap,
  LLMEventType,
  LLMPriority,
  LLMRejectDetail,
  LLMRejectReason,
  LLMRequest,
  LLMReservationEstimate,
  LLMReservationOverride,
  LLMRunContext,
  LLMStats,
  LLMToken,
  LLMWouldAdmitResult,
  TokenUsage,
  UsageReport,
} from "./types.js";
import { LLMBulkheadRejectedError } from "./errors.js";
import { PROFILES, type LLMBulkheadPreset } from "./profiles.js";
import { createModelAwareTokenEstimator } from "./estimators.js";
import {
  assertNonNegativeInteger,
  assertOptionalNonNegativeInteger,
  assertPositiveInteger,
  validateTokenEstimate,
  validateTokenUsage,
} from "./validation.js";
import { hashDedupKey, isUnsafeToShare, resolveDedup } from "./dedup.js";

type BulkheadSignal = NonNullable<AcquireOptions["signal"]>;

// ────────────────────────────────────────────
// Option resolution
// ────────────────────────────────────────────

function resolvePreset(
  profile: LLMBulkheadOptions["profile"],
): LLMBulkheadPreset {
  if (!profile) return {};
  if (typeof profile === "string") return PROFILES[profile];
  return profile;
}

// ────────────────────────────────────────────
// createLLMBulkhead
// ────────────────────────────────────────────

export function createLLMBulkhead(opts: LLMBulkheadOptions) {
  // ---- Validate ----
  if (typeof opts.model !== "string" || opts.model.trim() === "") {
    throw new Error("model must be a non-empty string");
  }
  assertPositiveInteger(opts.maxConcurrent, "maxConcurrent");

  // ---- Resolve profile defaults ----
  const preset = resolvePreset(opts.profile);
  const maxQueue = opts.maxQueue ?? preset.maxQueue ?? 0;
  const timeoutMs = opts.timeoutMs ?? preset.timeoutMs;
  assertNonNegativeInteger(maxQueue, "maxQueue");
  assertOptionalNonNegativeInteger(timeoutMs, "timeoutMs");
  if (opts.tokenBudget) {
    assertNonNegativeInteger(opts.tokenBudget.budget, "tokenBudget.budget");

    assertOptionalNonNegativeInteger(
      opts.tokenBudget.outputCap,
      "tokenBudget.outputCap",
    );
    assertOptionalNonNegativeInteger(
      opts.tokenBudget.highPriorityReserve,
      "tokenBudget.highPriorityReserve",
    );
    if (
      opts.tokenBudget.highPriorityReserve !== undefined &&
      opts.tokenBudget.highPriorityReserve > opts.tokenBudget.budget
    ) {
      throw new Error(
        "tokenBudget.highPriorityReserve must be <= tokenBudget.budget",
      );
    }
  }

  // ---- Internal bulkhead from async-bulkhead-ts ----
  const bulkhead = createBulkhead({
    maxConcurrent: opts.maxConcurrent,
    maxQueue,
  });

  // ---- Token budget state ----
  const budget = opts.tokenBudget;
  const estimator =
    budget?.estimator ??
    createModelAwareTokenEstimator(undefined, {
      defaultModel: opts.model,
      outputCap: budget?.outputCap,
    });

  const highPriorityReserve = budget?.highPriorityReserve ?? 0;

  /**
   * Mutable budget ceiling, initialized from `tokenBudget.budget`.
   * `undefined` when `tokenBudget` was never configured — `setBudget()`
   * throws in that case rather than silently no-op'ing.
   * Mutated only by `setBudget()`. All admission math reads this value
   * (via `effectiveBudget()`), not the frozen `opts.tokenBudget.budget`,
   * so budget changes take effect on the very next admission check.
   */
  let currentBudget: number | undefined = budget?.budget;

  let inFlightTokens = 0;

  let totalReserved = 0;
  let totalConsumed = 0;
  let totalRefunded = 0;
  let totalOverrun = 0;
  let llmAdmitted = 0;
  let llmReleased = 0;
  let llmRejected = 0;
  const llmRejectedByReason: Partial<Record<LLMRejectReason, number>> = {};

  // ---- Deduplication state ----
  const dedup = resolveDedup(opts.deduplication);
  const dedupMap = new Map<string, Promise<unknown>>();
  let dedupHits = 0;

  // ---- Event emitter state ----
  const listeners: { [K in LLMEventType]: Set<Listener<K>> } = {
    admit: new Set(),
    reject: new Set(),
    release: new Set(),
    usage: new Set(),
    dedup: new Set(),
  };

  function emit<K extends LLMEventType>(
    event: K,
    payload: LLMEventMap[K],
  ): void {
    for (const fn of listeners[event]) {
      try {
        fn(payload);
      } catch {
        // listeners must not throw into the bulkhead
      }
    }
  }

  function noteLLMAdmit(): void {
    llmAdmitted++;
  }

  function noteLLMRelease(): void {
    llmReleased++;
  }

  function noteLLMReject(reason: LLMRejectReason): void {
    llmRejected++;
    llmRejectedByReason[reason] =
      (llmRejectedByReason[reason] ?? 0) + 1;
  }
  // ---- Internal helpers ----

  function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Estimate parts kept per-token so streaming reports can re-derive holds. */
  type ReservationParts = LLMReservationEstimate;

  function estimateParts(request: LLMRequest): ReservationParts | null {
    return resolveReservation(request, undefined);
  }

  /**
   * Reservation used for admission: the caller's per-call `reservation`
   * override verbatim when provided, otherwise the estimator's output.
   * Both paths validate as non-negative integers. `null` when
   * `tokenBudget` is disabled (no reservation participates then, and
   * the override is deliberately ignored).
   */
  function resolveReservation(
    request: LLMRequest,
    override: LLMReservationOverride | undefined,
  ): ReservationParts | null {
    assertOptionalNonNegativeInteger(request.max_tokens, "request.max_tokens");
    if (!budget) return null;
    if (override !== undefined) {
      const reserved = validateTokenEstimate(override);
      // v3.8: `reserved`, when present (e.g. an `estimate()` result passed
      // back verbatim), is a consistency check — not an independent input.
      if (override.reserved !== undefined) {
        assertNonNegativeInteger(override.reserved, "reservation.reserved");
        if (override.reserved !== reserved) {
          throw new Error(
            `reservation.reserved (${override.reserved}) must equal ` +
              `reservation.input + reservation.maxOutput (${reserved})`,
          );
        }
      }
      return {
        input: override.input,
        maxOutput: override.maxOutput,
        reserved,
      };
    }
    const estimate = estimator(request);
    const reserved = validateTokenEstimate(estimate);
    return {
      input: estimate.input,
      maxOutput: estimate.maxOutput,
      reserved,
    };
  }

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
    const parts = estimateParts(request);
    return parts === null ? null : { ...parts };
  }

  function resolvePriority(priority: LLMPriority | undefined): LLMPriority {
    if (priority === undefined) return "normal";
    if (priority !== "high" && priority !== "normal") {
      throw new Error(`priority must be "high" or "normal"`);
    }
    return priority;
  }

  /**
   * Budget ceiling applicable to a request at the given priority.
   *
   * Construction validates `0 <= highPriorityReserve <= budget` (see the
   * `tokenBudget` validation block above) — that check catches config
   * typos once, at startup. It intentionally does *not* run again here.
   *
   * `setBudget()` can lower `currentBudget` below `highPriorityReserve` at
   * runtime (e.g. a lease-renewal ledger reporting a shrunk grant), and
   * that is allowed, not re-validated. Rejecting a renewal-driven update
   * would be wrong: the ledger's grant is reality — the bulkhead has no
   * standing to refuse it. So `currentBudget` can legitimately end up
   * smaller than `highPriorityReserve`.
   *
   * Consequence, deliberately embraced: `currentBudget! - highPriorityReserve`
   * would go negative in that state, so it is clamped to `0` here. That
   * means normal-priority admission is fully rejected (nothing fits under
   * a `0` ceiling) while high-priority admission is still checked against
   * the full (shrunk) `currentBudget` and can keep admitting whatever
   * capacity remains. That is exactly the right degraded behavior — the
   * entire purpose of `highPriorityReserve` is protecting interactive
   * traffic when capacity is scarce, and capacity has never been scarcer
   * than when the grant itself drops below the reserve.
   */
  function effectiveBudget(priority: LLMPriority): number {
    if (!budget) return Infinity;
    return priority === "high"
      ? currentBudget!
      : Math.max(0, currentBudget! - highPriorityReserve);
  }



  /**
   * Attempt token budget admission synchronously for a precomputed
   * reservation. Returns false if the priority-adjusted ceiling is
   * exceeded.
   */
  function tryReserveTokens(reserved: number, priority: LLMPriority): boolean {
    if (!budget) return true;
    if (inFlightTokens + reserved > effectiveBudget(priority)) return false;
    inFlightTokens += reserved;
    totalReserved += reserved;
    return true;
  }

  function releaseTokens(held: number, usage?: TokenUsage): number {
    let refunded = 0;
    if (usage && held > 0) {
      const actual = usage.input + usage.output;
      totalConsumed += actual;
      if (actual < held) {
        refunded = held - actual;
        totalRefunded += refunded;
      }
    }
    inFlightTokens = Math.max(0, inFlightTokens - held);
    return refunded;
  }

  /** Capacity snapshot for rejection results, events, and errors. */
  function buildRejectDetail(
    requested: number,
    priority: LLMPriority,
  ): LLMRejectDetail {
    const base = bulkhead.stats();
    const detail: LLMRejectDetail = {
      inFlight: base.inFlight,
      pending: base.pending,
      maxConcurrent: base.maxConcurrent,
      maxQueue: base.maxQueue,
    };
    if (budget) {
      const eff = effectiveBudget(priority);
      detail.tokenBudget = {
        budget: currentBudget!,
        inFlightTokens,
        effectiveBudget: eff,
        available: Math.max(0, eff - inFlightTokens),
        requested,
      };
    }
    return detail;
  }

  /**
   * Update the token budget ceiling at runtime.
   *
   * Semantics (deliberate, not incidental):
   *
   * - **Raising takes effect immediately.** The very next admission check
   *   reads the new ceiling via `effectiveBudget()` — no caching to
   *   invalidate, no in-flight work touched.
   * - **Lowering below `inFlightTokens` is legal — shrink by attrition.**
   *   No in-flight work is revoked or cancelled. New admissions reject
   *   with `"budget_limit"` until enough in-flight work releases to bring
   *   `inFlightTokens` back under the new ceiling. This mirrors the
   *   library's existing overrun tolerance (`inFlightTokens` can already
   *   exceed `budget` via `reportUsage()` overrun) — over-budget in-flight
   *   state is an established, intentional condition, not an invariant
   *   violation.
   * - **Throws if `tokenBudget` was never configured.** An explicit error
   *   beats a silent no-op — there is no budget ceiling to adjust.
   * - **Validation:** `tokens` must be a non-negative integer.
   */
  function setBudget(tokens: number): void {
    if (!budget) {
      throw new Error(
        "setBudget requires tokenBudget to be configured at construction",
      );
    }
    assertNonNegativeInteger(tokens, "tokens");
    currentBudget = tokens;
  }


  function normalizeAcquireOptions(ao: AcquireOptions): AcquireOptions {
    const normalized: AcquireOptions = {};
    if (ao.signal !== undefined) normalized.signal = ao.signal;
    const effectiveTimeoutMs = ao.timeoutMs ?? timeoutMs;
    if (effectiveTimeoutMs !== undefined) {
      assertNonNegativeInteger(effectiveTimeoutMs, "timeoutMs");
      normalized.timeoutMs = effectiveTimeoutMs;
    }
    return normalized;
  }

  function noteDedupWaitRejection(
    request: LLMRequest,
    reason: Extract<
      LLMRejectReason,
      "aborted" | "timeout" | "unshareable_result"
    >,
  ): LLMBulkheadRejectedError {
    noteLLMReject(reason);
    emit("reject", { request, reason });
    return new LLMBulkheadRejectedError(reason);
  }

  /**
   * Deliver a shared in-flight result to a deduplication follower.
   *
   * - With a `shareResult` hook: the hook decides what the follower
   *   receives (called for every follower, safe results included).
   *   Hook exceptions propagate to the follower as-is.
   * - Without a hook: single-consumer values (streams, `Response`
   *   bodies, async iterables) are refused with
   *   `"unshareable_result"` instead of being handed out by
   *   reference — a locked stream downstream is a silent correctness
   *   bug; a typed rejection at the bulkhead is actionable.
   *
   * The leader never passes through this function.
   */
  function deliverShared<T>(value: T, request: LLMRequest): T {
    if (dedup.shareResult) {
      return dedup.shareResult(value) as T;
    }
    if (isUnsafeToShare(value)) {
      throw noteDedupWaitRejection(request, "unshareable_result");
    }
    return value;
  }

  /**
   * Wait on another caller's in-flight shared call.
   *
   * v3.4: only an *explicitly passed* per-call `timeoutMs` caps this
   * wait. The bulkhead-level `timeoutMs` default is deliberately NOT
   * applied here — it is documented as a *queue-wait* timeout, and a
   * follower is not queued; it is waiting on a call that is already
   * running. Applying the default (e.g. the `batch` profile's 30s) made
   * every follower of a slow LLM call fail with `"timeout"` while the
   * leader succeeded, defeating deduplication exactly when calls are
   * long. `signal` continues to apply as before.
   */
  function waitForSharedDedup<T>(
    shared: Promise<T>,
    request: LLMRequest,
    ao: AcquireOptions,
  ): Promise<T> {
    const signal = ao.signal;
    const effectiveTimeoutMs = ao.timeoutMs;
    if (effectiveTimeoutMs !== undefined) {
      assertNonNegativeInteger(effectiveTimeoutMs, "timeoutMs");
    }

    if (signal?.aborted) {
      return Promise.reject(noteDedupWaitRejection(request, "aborted"));
    }
    if (signal === undefined && effectiveTimeoutMs === undefined) {
      return shared.then((value) => deliverShared(value, request));
    }

    return new Promise<T>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const cleanup = () => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        if (signal !== undefined) {
          signal.removeEventListener("abort", onAbort);
        }
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const onAbort = () => {
        settle(() => {
          reject(noteDedupWaitRejection(request, "aborted"));
        });
      };

      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (effectiveTimeoutMs !== undefined) {
        timeoutId = setTimeout(() => {
          settle(() => {
            reject(noteDedupWaitRejection(request, "timeout"));
          });
        }, effectiveTimeoutMs);
      }

      void shared.then(
        (value) =>
          settle(() => {
            try {
              resolve(deliverShared(value, request));
            } catch (err) {
              reject(err);
            }
          }),
        (err) => settle(() => reject(err)),
      );
    });
  }

  /**
   * Wraps a base Token so that release() also returns the token
   * reservation and optionally applies the refund, and so that
   * streaming callers can report cumulative usage mid-flight.
   */
  function wrapToken(
    base: Token,
    parts: ReservationParts | null,
    request: LLMRequest,
    admissionId: string,
    priority: LLMPriority,
  ): LLMToken {
    let released = false;
    /** Tokens currently held against the budget for this request. */
    let held = parts?.reserved ?? 0;
    /** Last reported cumulative usage (monotonically clamped). */
    let reported: TokenUsage | undefined;
    /** Monotonic sequence of effective pre-release usage updates. */
    let usageSequence = 0;
    /** Public copy: callers cannot mutate internal accounting parts. */
    const reservation = parts === null ? null : Object.freeze({ ...parts });

    const snapshot = (): UsageReport => {
      const consumed = reported
        ? reported.input + reported.output
        : 0;
      const outputCap = parts ? parts.maxOutput : null;
      return {
        admissionId,
        sequence: usageSequence,
        reserved: parts?.reserved ?? 0,
        held,
        consumed,
        outputCap,
        outputRemaining:
          outputCap === null
            ? null
            : Math.max(0, outputCap - (reported?.output ?? 0)),
        overReservation: parts ? consumed > parts.reserved : false,
      };
    };

    const reportUsage = (usage: TokenUsage): UsageReport => {
      const valid = validateTokenUsage(usage);
      const previousReported = reported;
      // Clamp to monotonic non-decreasing per field — cumulative
      // stream usage never shrinks; a lower report is stale.
      reported = previousReported
        ? {
            input: Math.max(previousReported.input, valid.input),
            output: Math.max(previousReported.output, valid.output),
          }
        : valid;

      const usageChanged =
        previousReported === undefined ||
        reported.input !== previousReported.input ||
        reported.output !== previousReported.output;
      const previousHeldTokens = held;

      // Accounting only applies pre-release with a budget configured.
      if (!released && parts && budget) {
        // Hold = known input + the larger of (output ceiling, actual output).
        // Keeps the full output reservation while refunding input
        // over-estimates immediately; expands on output overrun.
        const newHold =
          reported.input + Math.max(parts.maxOutput, reported.output);
        const delta = newHold - held;
        if (delta > 0) {
          inFlightTokens += delta;
          totalOverrun += delta;
        } else if (delta < 0) {
          const refund = -delta;
          inFlightTokens = Math.max(0, inFlightTokens - refund);
          totalRefunded += refund;
        }
        held = newHold;
      }
      if (!released && usageChanged) {
        usageSequence++;
      }

      const report = snapshot();

      if (!released && usageChanged) {
        emit("usage", {
          request,
          admissionId,
          priority,
          sequence: usageSequence,
          reservedTokens: parts?.reserved ?? 0,
          previousHeldTokens,
          heldTokens: held,
          deltaTokens: held - previousHeldTokens,
          usage: { ...reported },
          outputCap: report.outputCap,
          outputRemaining: report.outputRemaining,
          overReservation: report.overReservation,
        });
      }

      return report;
    };

    return {
      admissionId,
      reservation,
      reportUsage,
      release(usage?: TokenUsage) {
        if (released) return;
        released = true;

        let validUsage: TokenUsage | undefined;
        let usageError: unknown;
        if (usage !== undefined) {
          try {
            validUsage = validateTokenUsage(usage);
          } catch (err) {
            usageError = err;
          }
        }
        // Fall back to the last mid-flight report when no (valid)
        // explicit usage is provided at release.
        if (validUsage === undefined && reported !== undefined) {
          validUsage = reported;
        }

        try {
          base.release();
        } finally {
          // Zero `held` before returning tokens: nothing is held against
          // the budget after release, and post-release `reportUsage()`
          // snapshots must reflect that (previously they reported the
          // stale pre-release hold).
          const heldAtRelease = held;
          held = 0;
          const refunded = releaseTokens(heldAtRelease, validUsage);
          noteLLMRelease();
          emit("release", {
            request,
            admissionId,
            priority,
            reservedTokens: parts?.reserved ?? 0,
            heldTokens: heldAtRelease,
            refundedTokens: refunded,
            usageSequence,
            ...(validUsage !== undefined && { usage: validUsage }),
          });
        }

        if (usageError !== undefined) throw usageError;
      },
    };
  }

  // ---- Internal acquire ----

  async function _acquire(
    request: LLMRequest,
    ao: LLMAcquireOptions,
  ): Promise<LLMAcquireResult> {
    const priority = resolvePriority(ao.priority);
    const parts = resolveReservation(request, ao.reservation);
    const reserved = parts?.reserved ?? 0;

    const rejectWith = (reason: LLMRejectReason): LLMAcquireResult => {
      const detail = buildRejectDetail(reserved, priority);
      noteLLMReject(reason);
      emit("reject", { request, reason, detail });
      return { ok: false, reason, detail };
    };

    // Token budget: pre-check before entering the queue.
    if (budget && inFlightTokens + reserved > effectiveBudget(priority)) {
      return rejectWith("budget_limit");
    }

    const mergedOptions = normalizeAcquireOptions(ao);

    const r = await bulkhead.acquire(mergedOptions);

    if (!r.ok) {
      return rejectWith(r.reason);
    }

    // Post-admission: reserve the precomputed amount now.
    if (!tryReserveTokens(reserved, priority)) {
      r.token.release();
      return rejectWith("budget_limit");
    }

    const admissionId = randomUUID();
    const token = wrapToken(r.token, parts, request, admissionId, priority);
    noteLLMAdmit();
    emit("admit", { request, admissionId, priority, reservedTokens: reserved });
    return {
      ok: true,
      admissionId,
      reservation: token.reservation,
      token,
    };
  }

  // ---- Public API ----

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
    return _acquire(request, ao);
  }

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
      reservation?: LLMReservationOverride;
      detail?: boolean;
    } = {},
  ): LLMWouldAdmitResult {
    const priority = resolvePriority(opts.priority);
    const parts = resolveReservation(request, opts.reservation);
    const reserved = parts?.reserved ?? 0;
    const withDetail = (
      result: LLMWouldAdmitResult,
    ): LLMWouldAdmitResult => {
      if (opts.detail === true) {
        result.detail = buildRejectDetail(reserved, priority);
      }
      return result;
    };
    const base = bulkhead.stats();
    if (base.closed) {
      return withDetail({ admit: false, reason: "shutdown" });
    }
    if (budget && inFlightTokens + reserved > effectiveBudget(priority)) {
      return withDetail({ admit: false, reason: "budget_limit" });
    }
    if (base.inFlight < base.maxConcurrent) {
      return withDetail({ admit: true });
    }
    if (base.pending < base.maxQueue) {
      return withDetail({ admit: true });
    }
    return withDetail({
      admit: false,
      reason: base.maxQueue > 0 ? "queue_limit" : "concurrency_limit",
    });
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
  async function run<T>(
    request: LLMRequest,
    fn: (signal?: BulkheadSignal, ctx?: LLMRunContext) => Promise<T>,
    ao: LLMAcquireOptions & {
      getUsage?: (result: T) => TokenUsage | undefined;
      /**
       * Deduplication scope. Requests deduplicate only within the same
       * scope — calls with different scopes never share an in-flight
       * call, even with identical keys. Use this to carry the tenant /
       * API-key identity in multi-tenant gateways so responses are never
       * shared across tenants. Ignored when deduplication is disabled.
       * Default: `""` (single global scope).
       */
      dedupScope?: string;
      /**
       * Per-call deduplication opt-out (v3.5). Pass `false` to make
       * this call always execute independently — it neither joins an
       * existing in-flight call nor registers itself as joinable.
       *
       * Intended for streaming routes on a bulkhead where dedup is
       * otherwise useful: shared stream results are single-consumer
       * (see `deduplication.shareResult`), so streaming calls can skip
       * dedup here instead of encoding the exemption in a bulkhead-wide
       * `keyFn`.
       *
       * `true` is accepted but cannot enable deduplication when it is
       * disabled at the bulkhead level (the key function and shared
       * state live there); it is treated the same as omitting the
       * option. Ignored by `acquire()`, which never deduplicates.
       */
      dedup?: boolean;
    } = {},
  ): Promise<T> {
    const { getUsage, dedupScope, dedup: perCallDedup, ...acquireOpts } = ao;

    // ---- Deduplication ----
    let dedupKey = "";
    if (dedup.enabled && perCallDedup !== false) {
      let rawKey: string;
      try {
        rawKey = dedup.keyFn(request);
      } catch {
        rawKey = "";
      }
      // "" opts out; only real keys are scoped + hashed.
      if (rawKey !== "") {
        dedupKey = hashDedupKey(dedupScope ?? "", rawKey);
      }
    }

    let deferred:
      | {
          promise: Promise<T>;
          resolve: (v: T) => void;
          reject: (e?: unknown) => void;
        }
      | undefined;
    let resultPromise: Promise<T> | undefined;

    if (dedup.enabled && dedupKey !== "") {
      const existing = dedupMap.get(dedupKey);
      if (existing) {
        dedupHits++;
        emit("dedup", { request });
        return waitForSharedDedup(existing as Promise<T>, request, acquireOpts);
      }
      deferred = createDeferred<T>();
      resultPromise = deferred.promise;
      dedupMap.set(dedupKey, deferred.promise);

      const cleanup = () => {
        try {
          const p = dedupMap.get(dedupKey);
          if (p === deferred!.promise) dedupMap.delete(dedupKey);
        } catch {
          // never throw from cleanup
        }
      };
      void deferred.promise.then(cleanup, cleanup);
    }

    try {
      const r = await _acquire(request, acquireOpts);
      if (!r.ok) {
        throw new LLMBulkheadRejectedError(r.reason, r.detail);
      }

      const ctx: LLMRunContext = {
        admissionId: r.admissionId,
        reservation: r.reservation,
        reportUsage: (usage) => r.token.reportUsage(usage),
      };

      const work = (async () => {
        let result: T;
        try {
          result = await fn(ao.signal, ctx);
        } catch (err) {
          r.token.release(); // no usage on error
          throw err;
        }

        // Extract usage for refund.
        let usage: TokenUsage | undefined;
        if (getUsage) {
          try {
            const extracted = getUsage(result);
            usage =
              extracted === undefined ? undefined : validateTokenUsage(extracted);
          } catch {
            // bad getUsage must not break release
          }
        }
        r.token.release(usage);
        return result;
      })();

      if (deferred) {
        void work.then(
          (v) => deferred.resolve(v),
          (e) => deferred.reject(e),
        );
        return resultPromise!;
      }

      return work;
    } catch (err) {
      if (deferred) {
        deferred.reject(err);
        return resultPromise!;
      }
      throw err;
    }
  }

  /** Runtime stats. Optional fields are present only when the feature is enabled. */
  function stats(): LLMStats {
    const base = bulkhead.stats();
    const result: LLMStats = {
      bulkhead: base,
      llm: {
        admitted: llmAdmitted,
        released: llmReleased,
        rejected: llmRejected,
        rejectedByReason: { ...llmRejectedByReason },
      },
    };

    if (budget) {
      result.tokenBudget = {
        budget: currentBudget!,
        inFlightTokens,
        available: Math.max(0, currentBudget! - inFlightTokens),
        totalReserved,
        totalConsumed,
        totalRefunded,
        totalOverrun,
        highPriorityReserve,
      };
    }


    if (dedup.enabled) {
      result.deduplication = {
        active: dedupMap.size,
        hits: dedupHits,
      };
    }

    return result;
  }

  /**
   * Stop admission permanently. All pending waiters in the underlying
   * bulkhead are rejected with `'shutdown'`. Future `acquire`/`run`
   * calls reject immediately. In-flight work is not interrupted.
   */
  function close(): void {
    bulkhead.close();
  }

  /**
   * Returns a promise that resolves when all in-flight work and
   * pending waiters have completed. Works with or without `close()`.
   * Compose as `close()` → `drain()` for graceful shutdown.
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
   */
  function drain(): Promise<void>;
  function drain(opts: { timeoutMs: number }): Promise<LLMDrainResult>;
  function drain(opts?: {
    timeoutMs?: number;
  }): Promise<void> | Promise<LLMDrainResult> {
    const timeoutMs = opts?.timeoutMs;
    if (timeoutMs === undefined) {
      return bulkhead.drain();
    }
    assertNonNegativeInteger(timeoutMs, "timeoutMs");
    return new Promise<LLMDrainResult>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const base = bulkhead.stats();
        resolve({
          drained: false,
          inFlight: base.inFlight,
          pending: base.pending,
        });
      }, timeoutMs);
      void bulkhead.drain().then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ drained: true, inFlight: 0, pending: 0 });
      });
    });
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
    listeners[event].add(listener);
    return () => {
      listeners[event].delete(listener);
    };
  }

  return {
    estimate,
    acquire,
    run,
    wouldAdmit,
    stats,
    setBudget,
    close,
    drain,
    on,
  };
}


export type LLMBulkhead = ReturnType<typeof createLLMBulkhead>;
