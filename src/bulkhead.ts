/**
 * `createLLMBulkhead`: admission (concurrency + token budget +
 * priority), reservation and refund accounting, streaming usage
 * reports, deduplication orchestration, events, stats, and shutdown.
 */
import type { AcquireOptions, Token } from "async-bulkhead-ts";
import { randomUUID } from "node:crypto";
import type {
  Listener,
  LLMAdmissionClassLimits,
  LLMAdmissionLimits,
  LLMApplyLimitsResult,
  LLMAcquireOptions,
  LLMAcquireResult,
  LLMAdmissionMode,
  LLMBulkheadOptions,
  LLMCapacityConstraint,
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
  LLMRunOptions,
  LLMShadowableRejectReason,
  LLMStats,
  LLMToken,
  LLMWouldAdmitResult,
  TokenUsage,
  UsageReport,
  ProgressiveReconciliationOptions,
} from "./types.js";
import { LLMBulkheadRejectedError } from "./errors.js";
import { PROFILES, type LLMBulkheadPreset } from "./profiles.js";
import { createModelAwareTokenEstimator } from "./estimators.js";
import {
  assertNonNegativeInteger,
  assertOptionalNonNegativeInteger,
  validateTokenEstimate,
  validateTokenUsage,
} from "./validation.js";
import { hashDedupKey, isUnsafeToShare, resolveDedup } from "./dedup.js";
import { createReconfigurableBulkhead } from "./reconfigurable-bulkhead.js";

type BulkheadSignal = NonNullable<AcquireOptions["signal"]>;

const DEFAULT_SHADOW_REASONS: readonly LLMShadowableRejectReason[] = [
  "budget_limit",
  "concurrency_limit",
  "queue_limit",
  "timeout",
];

const SHADOWABLE_REASONS = new Set<LLMShadowableRejectReason>(
  DEFAULT_SHADOW_REASONS,
);

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

type AdmissionClassState = {
  readonly id: string;
  maxConcurrent: number | undefined;
  maxInFlightTokens: number | undefined;
  inFlight: number;
  inFlightTokens: number;
  admitted: number;
  released: number;
  rejected: number;
  rejectedByReason: Partial<Record<LLMRejectReason, number>>;
  totalReserved: number;
  totalConsumed: number;
  totalRefunded: number;
  totalOverrun: number;
};

type CapacityFailure = {
  reason: Extract<LLMRejectReason, "budget_limit" | "concurrency_limit">;
  constraint: LLMCapacityConstraint;
};

function validateAdmissionClassId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function readAdmissionClassLimits(
  value: unknown,
  label: string,
  tokenBudgetEnabled: boolean,
): LLMAdmissionClassLimits {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const source = value as LLMAdmissionClassLimits;
  const maxConcurrent = source.maxConcurrent;
  const maxInFlightTokens = source.maxInFlightTokens;
  assertOptionalNonNegativeInteger(
    maxConcurrent,
    `${label}.maxConcurrent`,
  );
  assertOptionalNonNegativeInteger(
    maxInFlightTokens,
    `${label}.maxInFlightTokens`,
  );
  if (!tokenBudgetEnabled && maxInFlightTokens !== undefined) {
    throw new Error(
      `${label}.maxInFlightTokens requires tokenBudget to be configured`,
    );
  }
  return Object.freeze({
    ...(maxConcurrent !== undefined && { maxConcurrent }),
    ...(maxInFlightTokens !== undefined && { maxInFlightTokens }),
  });
}

// ────────────────────────────────────────────
// createLLMBulkhead
// ────────────────────────────────────────────

export function createLLMBulkhead(opts: LLMBulkheadOptions) {
  // ---- Validate ----
  if (typeof opts.model !== "string" || opts.model.trim() === "") {
    throw new Error("model must be a non-empty string");
  }
  assertNonNegativeInteger(opts.maxConcurrent, "maxConcurrent");
  const initialRevision = opts.initialRevision ?? 0;
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 0) {
    throw new Error("initialRevision must be a non-negative safe integer");
  }

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

  // ---- Bounded admission-class configuration ----
  const admissionClassOptions = opts.admissionClasses;
  let defaultAdmissionClass: string | undefined;
  const admissionClassStates = new Map<string, AdmissionClassState>();
  if (admissionClassOptions !== undefined) {
    defaultAdmissionClass = validateAdmissionClassId(
      admissionClassOptions.defaultClass,
      "admissionClasses.defaultClass",
    );
    const classes = admissionClassOptions.classes;
    if (typeof classes !== "object" || classes === null || Array.isArray(classes)) {
      throw new Error("admissionClasses.classes must be an object");
    }
    const entries = Object.entries(classes);
    if (entries.length === 0) {
      throw new Error("admissionClasses.classes must contain at least one class");
    }
    for (const [id, rawLimits] of entries) {
      validateAdmissionClassId(id, "admissionClasses class id");
      const limits = readAdmissionClassLimits(
        rawLimits,
        `admissionClasses.classes[${JSON.stringify(id)}]`,
        opts.tokenBudget !== undefined,
      );
      admissionClassStates.set(id, {
        id,
        maxConcurrent: limits.maxConcurrent,
        maxInFlightTokens: limits.maxInFlightTokens,
        inFlight: 0,
        inFlightTokens: 0,
        admitted: 0,
        released: 0,
        rejected: 0,
        rejectedByReason: {},
        totalReserved: 0,
        totalConsumed: 0,
        totalRefunded: 0,
        totalOverrun: 0,
      });
    }
    if (!admissionClassStates.has(defaultAdmissionClass)) {
      throw new Error(
        `admissionClasses.defaultClass ${JSON.stringify(defaultAdmissionClass)} ` +
          `must name a configured class`,
      );
    }
  }

  // ---- Internal reconfigurable concurrency bulkhead ----
  const bulkhead = createReconfigurableBulkhead({
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

  /** Current versioned admission-limit state. */
  let currentRevision = initialRevision;
  let currentBudget: number | undefined = budget?.budget;
  let currentHighPriorityReserve = budget?.highPriorityReserve ?? 0;

  let inFlightTokens = 0;

  let totalReserved = 0;
  let totalConsumed = 0;
  let totalRefunded = 0;
  let totalOverrun = 0;
  let llmAdmitted = 0;
  let llmReleased = 0;
  let llmRejected = 0;
  const llmRejectedByReason: Partial<Record<LLMRejectReason, number>> = {};
  let observeBypassed = 0;
  let observeRaceBypassed = 0;
  const observeBypassedByReason: Partial<
    Record<LLMShadowableRejectReason, number>
  > = {};
  let observeUsageReported = 0;
  let observeTotalInputTokens = 0;
  let observeTotalOutputTokens = 0;

  // ---- Deduplication state ----
  const dedup = resolveDedup(opts.deduplication);
  const dedupMap = new Map<string, Promise<unknown>>();
  const dedupWaitErrors = new WeakSet<LLMBulkheadRejectedError>();
  let dedupHits = 0;

  // ---- Event emitter state ----
  const listeners: { [K in LLMEventType]: Set<Listener<K>> } = {
    admit: new Set(),
    reject: new Set(),
    release: new Set(),
    usage: new Set(),
    bypass: new Set(),
    bypassUsage: new Set(),
    bypassRelease: new Set(),
    reconfigure: new Set(),
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

  function resolveAdmissionClass(
    requested: string | undefined,
  ): AdmissionClassState | undefined {
    if (defaultAdmissionClass === undefined) {
      if (requested !== undefined) {
        throw new Error(
          "admissionClass requires admissionClasses to be configured",
        );
      }
      return undefined;
    }
    const id =
      requested === undefined
        ? defaultAdmissionClass
        : validateAdmissionClassId(requested, "admissionClass");
    const state = admissionClassStates.get(id);
    if (state === undefined) {
      throw new Error(`unknown admissionClass ${JSON.stringify(id)}`);
    }
    return state;
  }

  function noteAdmissionClassReject(
    admissionClass: AdmissionClassState | undefined,
    reason: LLMRejectReason,
  ): void {
    if (admissionClass === undefined) return;
    admissionClass.rejected++;
    admissionClass.rejectedByReason[reason] =
      (admissionClass.rejectedByReason[reason] ?? 0) + 1;
  }

  function admissionClassLimitsSnapshot():
    | Readonly<Record<string, LLMAdmissionClassLimits>>
    | undefined {
    if (defaultAdmissionClass === undefined) return undefined;
    const entries: Array<[string, LLMAdmissionClassLimits]> = [];
    for (const [id, state] of admissionClassStates) {
      entries.push([
        id,
        Object.freeze({
          ...(state.maxConcurrent !== undefined && {
            maxConcurrent: state.maxConcurrent,
          }),
          ...(state.maxInFlightTokens !== undefined && {
            maxInFlightTokens: state.maxInFlightTokens,
          }),
        }),
      ]);
    }
    return Object.freeze(Object.fromEntries(entries));
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

  function resolveAdmissionMode(
    mode: LLMAdmissionMode | undefined,
  ): LLMAdmissionMode {
    if (mode === undefined) return "enforce";
    if (mode !== "enforce" && mode !== "observe") {
      throw new Error(`mode must be "enforce" or "observe"`);
    }
    return mode;
  }

  function resolveShadowReasons(
    reasons: readonly LLMShadowableRejectReason[] | undefined,
  ): ReadonlySet<LLMShadowableRejectReason> {
    if (reasons === undefined) return SHADOWABLE_REASONS;
    const resolved = new Set<LLMShadowableRejectReason>();
    for (const reason of reasons) {
      if (!SHADOWABLE_REASONS.has(reason)) {
        throw new Error(
          `shadowReasons may contain only budget_limit, concurrency_limit, ` +
            `queue_limit, or timeout`,
        );
      }
      resolved.add(reason);
    }
    return resolved;
  }

  type ResolvedAdmission = {
    priority: LLMPriority;
    admissionClass: AdmissionClassState | undefined;
    parts: ReservationParts | null;
    reserved: number;
  };

  function resolveAdmission(
    request: LLMRequest,
    ao: Pick<
      LLMAcquireOptions,
      "priority" | "reservation" | "admissionClass"
    >,
    resolvedAdmissionClass: AdmissionClassState | undefined =
      resolveAdmissionClass(ao.admissionClass),
  ): ResolvedAdmission {
    const priority = resolvePriority(ao.priority);
    const admissionClass = resolvedAdmissionClass;
    const parts = resolveReservation(request, ao.reservation);
    return {
      priority,
      admissionClass,
      parts,
      reserved: parts?.reserved ?? 0,
    };
  }

  /**
   * Budget ceiling applicable to a request at the given priority.
   *
   * Construction validates `0 <= highPriorityReserve <= budget` (see the
   * `tokenBudget` validation block above) — that check catches config
   * typos once, at startup. It intentionally does *not* run again here.
   *
   * `applyLimits()` or `setBudget()` can lower `currentBudget` below
   * `highPriorityReserve` at
   * runtime (e.g. a lease-renewal ledger reporting a shrunk grant), and
   * that is allowed, not re-validated. Rejecting a renewal-driven update
   * would be wrong: the ledger's grant is reality — the bulkhead has no
   * standing to refuse it. So `currentBudget` can legitimately end up
   * smaller than `highPriorityReserve`.
   *
   * Consequence, deliberately embraced: `currentBudget! - currentHighPriorityReserve`
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
      : Math.max(0, currentBudget! - currentHighPriorityReserve);
  }

  function checkAdmissionCapacity(
    reserved: number,
    priority: LLMPriority,
    admissionClass: AdmissionClassState | undefined,
  ): CapacityFailure | undefined {
    if (budget && inFlightTokens + reserved > effectiveBudget(priority)) {
      return { reason: "budget_limit", constraint: "global" };
    }
    if (
      admissionClass?.maxInFlightTokens !== undefined &&
      admissionClass.inFlightTokens + reserved >
        admissionClass.maxInFlightTokens
    ) {
      return { reason: "budget_limit", constraint: "admission_class" };
    }
    if (
      admissionClass?.maxConcurrent !== undefined &&
      admissionClass.inFlight >= admissionClass.maxConcurrent
    ) {
      return { reason: "concurrency_limit", constraint: "admission_class" };
    }
    return undefined;
  }

  /**
   * Atomically reserve every non-queue capacity layer after the global
   * concurrency slot is held. No counters are changed unless all checks pass.
   */
  function tryReserveCapacity(
    reserved: number,
    priority: LLMPriority,
    admissionClass: AdmissionClassState | undefined,
  ): CapacityFailure | undefined {
    const failure = checkAdmissionCapacity(
      reserved,
      priority,
      admissionClass,
    );
    if (failure !== undefined) return failure;

    if (budget) {
      inFlightTokens += reserved;
      totalReserved += reserved;
    }
    if (admissionClass !== undefined) {
      admissionClass.inFlight++;
      admissionClass.admitted++;
      if (budget) {
        admissionClass.inFlightTokens += reserved;
        admissionClass.totalReserved += reserved;
      }
    }
    return undefined;
  }

  function releaseCapacity(
    held: number,
    usage: TokenUsage | undefined,
    admissionClass: AdmissionClassState | undefined,
  ): number {
    let refunded = 0;
    if (usage && held > 0) {
      const actual = usage.input + usage.output;
      totalConsumed += actual;
      if (admissionClass !== undefined) {
        admissionClass.totalConsumed += actual;
      }
      if (actual < held) {
        refunded = held - actual;
        totalRefunded += refunded;
        if (admissionClass !== undefined) {
          admissionClass.totalRefunded += refunded;
        }
      }
    }
    inFlightTokens = Math.max(0, inFlightTokens - held);
    if (admissionClass !== undefined) {
      admissionClass.inFlightTokens = Math.max(
        0,
        admissionClass.inFlightTokens - held,
      );
      admissionClass.inFlight = Math.max(0, admissionClass.inFlight - 1);
      admissionClass.released++;
    }
    return refunded;
  }

  /** Capacity snapshot for rejection results, events, and errors. */
  function buildRejectDetail(
    requested: number,
    priority: LLMPriority,
    admissionClass: AdmissionClassState | undefined,
    constraint?: LLMCapacityConstraint,
  ): LLMRejectDetail {
    const base = bulkhead.stats();
    const detail: LLMRejectDetail = {
      limitRevision: currentRevision,
      ...(admissionClass !== undefined && constraint !== undefined
        ? { constraint }
        : {}),
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
    if (admissionClass !== undefined) {
      detail.admissionClass = {
        id: admissionClass.id,
        inFlight: admissionClass.inFlight,
        maxConcurrent: admissionClass.maxConcurrent ?? null,
        availableConcurrent:
          admissionClass.maxConcurrent === undefined
            ? null
            : Math.max(
                0,
                admissionClass.maxConcurrent - admissionClass.inFlight,
              ),
        ...(budget
          ? {
              tokenBudget: {
                inFlightTokens: admissionClass.inFlightTokens,
                maxInFlightTokens:
                  admissionClass.maxInFlightTokens ?? null,
                available:
                  admissionClass.maxInFlightTokens === undefined
                    ? null
                    : Math.max(
                        0,
                        admissionClass.maxInFlightTokens -
                          admissionClass.inFlightTokens,
                      ),
                requested,
              },
            }
          : {}),
      };
    }
    return detail;
  }

  function wouldAdmitResolved(
    admission: ResolvedAdmission,
    includeDetail: boolean,
  ): LLMWouldAdmitResult {
    const { priority, admissionClass, reserved } = admission;
    const withDetail = (
      result: LLMWouldAdmitResult,
      constraint?: LLMCapacityConstraint,
    ): LLMWouldAdmitResult => {
      if (includeDetail) {
        result.detail = buildRejectDetail(
          reserved,
          priority,
          admissionClass,
          constraint,
        );
      }
      return result;
    };
    const base = bulkhead.stats();
    if (base.closed) {
      return withDetail({ admit: false, reason: "shutdown" });
    }
    const capacityFailure = checkAdmissionCapacity(
      reserved,
      priority,
      admissionClass,
    );
    if (capacityFailure !== undefined) {
      return withDetail(
        { admit: false, reason: capacityFailure.reason },
        capacityFailure.constraint,
      );
    }
    if (base.inFlight < base.maxConcurrent) {
      return withDetail({ admit: true });
    }
    if (base.maxConcurrent === 0) {
      return withDetail(
        { admit: false, reason: "concurrency_limit" },
        "global",
      );
    }
    if (base.pending < base.maxQueue) {
      return withDetail({ admit: true });
    }
    return withDetail(
      {
        admit: false,
        reason: base.maxQueue > 0 ? "queue_limit" : "concurrency_limit",
      },
      "global",
    );
  }

  /** Return a detached snapshot of the currently applied limits. */
  function limits(): LLMAdmissionLimits {
    const base = bulkhead.stats();
    const classLimits = admissionClassLimitsSnapshot();
    const snapshot: LLMAdmissionLimits = {
      revision: currentRevision,
      maxConcurrent: base.maxConcurrent,
      maxQueue: base.maxQueue,
      ...(budget
        ? {
            tokenBudget: {
              budget: currentBudget!,
              highPriorityReserve: currentHighPriorityReserve,
            },
          }
        : {}),
      ...(classLimits !== undefined
        ? { admissionClasses: classLimits }
        : {}),
    };
    return Object.freeze({
      ...snapshot,
      ...(snapshot.tokenBudget
        ? { tokenBudget: Object.freeze({ ...snapshot.tokenBudget }) }
        : {}),
      ...(snapshot.admissionClasses
        ? { admissionClasses: snapshot.admissionClasses }
        : {}),
    });
  }

  /**
   * Atomically apply a complete, higher-revision admission-limit snapshot.
   *
   * All fields are validated before any state changes. Equal or lower
   * revisions are rejected as stale without mutation. Lower concurrency,
   * queue, or token ceilings use shrink-by-attrition: in-flight work and
   * already accepted waiters are not cancelled. Raising concurrency pumps
   * accepted waiters immediately after the complete snapshot is installed.
   */
  function applyLimits(next: LLMAdmissionLimits): LLMApplyLimitsResult {
    // Read each externally supplied property once. This prevents accessor
    // objects from returning one value during validation and another during
    // installation.
    const revision = next.revision;
    const maxConcurrent = next.maxConcurrent;
    const maxQueue = next.maxQueue;
    const nextTokenBudget = next.tokenBudget;
    const nextAdmissionClasses = next.admissionClasses;

    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error("limits.revision must be a non-negative safe integer");
    }
    if (revision <= currentRevision) {
      return {
        applied: false,
        reason: "stale_revision",
        current: limits(),
      };
    }

    assertNonNegativeInteger(maxConcurrent, "limits.maxConcurrent");
    assertNonNegativeInteger(maxQueue, "limits.maxQueue");

    let nextBudget: number | undefined;
    let nextHighPriorityReserve: number | undefined;
    if (budget) {
      if (nextTokenBudget === undefined) {
        throw new Error(
          "limits.tokenBudget is required because tokenBudget was configured at construction",
        );
      }
      nextBudget = nextTokenBudget.budget;
      nextHighPriorityReserve = nextTokenBudget.highPriorityReserve;
      assertNonNegativeInteger(nextBudget, "limits.tokenBudget.budget");
      assertNonNegativeInteger(
        nextHighPriorityReserve,
        "limits.tokenBudget.highPriorityReserve",
      );
    } else if (nextTokenBudget !== undefined) {
      throw new Error(
        "limits.tokenBudget must be omitted because tokenBudget was not configured at construction",
      );
    }

    let preparedAdmissionClassLimits:
      | Map<string, LLMAdmissionClassLimits>
      | undefined;
    if (defaultAdmissionClass !== undefined) {
      if (nextAdmissionClasses === undefined) {
        throw new Error(
          "limits.admissionClasses is required because admissionClasses was configured at construction",
        );
      }
      if (
        typeof nextAdmissionClasses !== "object" ||
        nextAdmissionClasses === null ||
        Array.isArray(nextAdmissionClasses)
      ) {
        throw new Error("limits.admissionClasses must be an object");
      }
      const suppliedKeys = Object.keys(nextAdmissionClasses);
      if (suppliedKeys.length !== admissionClassStates.size) {
        throw new Error(
          "limits.admissionClasses must contain exactly the construction-time class keys",
        );
      }
      preparedAdmissionClassLimits = new Map();
      for (const id of admissionClassStates.keys()) {
        if (!Object.prototype.hasOwnProperty.call(nextAdmissionClasses, id)) {
          throw new Error(
            "limits.admissionClasses must contain exactly the construction-time class keys",
          );
        }
        preparedAdmissionClassLimits.set(
          id,
          readAdmissionClassLimits(
            nextAdmissionClasses[id],
            `limits.admissionClasses[${JSON.stringify(id)}]`,
            budget !== undefined,
          ),
        );
      }
    } else if (nextAdmissionClasses !== undefined) {
      throw new Error(
        "limits.admissionClasses must be omitted because admissionClasses was not configured at construction",
      );
    }

    const previous = limits();

    // Install every LLM-layer value before pumping the concurrency queue.
    // Promise continuations from admitted waiters run only after this
    // synchronous operation returns, so they observe one coherent revision.
    currentRevision = revision;
    if (budget) {
      currentBudget = nextBudget!;
      currentHighPriorityReserve = nextHighPriorityReserve!;
    }
    if (preparedAdmissionClassLimits !== undefined) {
      for (const [id, nextLimits] of preparedAdmissionClassLimits) {
        const state = admissionClassStates.get(id)!;
        state.maxConcurrent = nextLimits.maxConcurrent;
        state.maxInFlightTokens = nextLimits.maxInFlightTokens;
      }
    }
    bulkhead.applyLimits({ maxConcurrent, maxQueue });

    const current = limits();
    emit("reconfigure", { previous, current });
    return { applied: true, previous, current };
  }

  /**
   * Backward-compatible budget-only setter.
   *
   * This is implemented as a complete local reconfiguration at
   * `currentRevision + 1`. Externally managed deployments should use
   * `applyLimits()` exclusively so one authority owns the revision stream.
   */
  function setBudget(tokens: number): void {
    if (!budget) {
      throw new Error(
        "setBudget requires tokenBudget to be configured at construction",
      );
    }
    assertNonNegativeInteger(tokens, "tokens");
    if (currentRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("cannot advance admission-limit revision beyond MAX_SAFE_INTEGER");
    }
    const current = limits();
    applyLimits({
      revision: currentRevision + 1,
      maxConcurrent: current.maxConcurrent,
      maxQueue: current.maxQueue,
      tokenBudget: {
        budget: tokens,
        highPriorityReserve: currentHighPriorityReserve,
      },
      ...(current.admissionClasses !== undefined
        ? { admissionClasses: current.admissionClasses }
        : {}),
    });
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
    admissionClass: AdmissionClassState | undefined,
  ): LLMBulkheadRejectedError {
    noteLLMReject(reason);
    noteAdmissionClassReject(admissionClass, reason);
    emit("reject", {
      request,
      reason,
      limitRevision: currentRevision,
      ...(admissionClass !== undefined
        ? { admissionClass: admissionClass.id }
        : {}),
    });
    const error = new LLMBulkheadRejectedError(reason);
    dedupWaitErrors.add(error);
    return error;
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
  function deliverShared<T>(
    value: T,
    request: LLMRequest,
    admissionClass: AdmissionClassState | undefined,
  ): T {
    if (dedup.shareResult) {
      return dedup.shareResult(value) as T;
    }
    if (isUnsafeToShare(value)) {
      throw noteDedupWaitRejection(
        request,
        "unshareable_result",
        admissionClass,
      );
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
    admissionClass: AdmissionClassState | undefined,
  ): Promise<T> {
    const signal = ao.signal;
    const effectiveTimeoutMs = ao.timeoutMs;
    if (effectiveTimeoutMs !== undefined) {
      assertNonNegativeInteger(effectiveTimeoutMs, "timeoutMs");
    }

    if (signal?.aborted) {
      return Promise.reject(
        noteDedupWaitRejection(request, "aborted", admissionClass),
      );
    }
    if (signal === undefined && effectiveTimeoutMs === undefined) {
      return shared.then((value) =>
        deliverShared(value, request, admissionClass),
      );
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
          reject(
            noteDedupWaitRejection(request, "aborted", admissionClass),
          );
        });
      };

      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (effectiveTimeoutMs !== undefined) {
        timeoutId = setTimeout(() => {
          settle(() => {
            reject(
              noteDedupWaitRejection(request, "timeout", admissionClass),
            );
          });
        }, effectiveTimeoutMs);
      }

      void shared.then(
        (value) =>
          settle(() => {
            try {
              resolve(deliverShared(value, request, admissionClass));
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
    limitRevision: number,
    priority: LLMPriority,
    admissionClass: AdmissionClassState | undefined,
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
        limitRevision,
        ...(admissionClass !== undefined
          ? { admissionClass: admissionClass.id }
          : {}),
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

    const reportUsage = (
      usage: TokenUsage,
      reconciliation?: ProgressiveReconciliationOptions,
    ): UsageReport => {
      const valid = validateTokenUsage(usage);
      if (reconciliation !== undefined) {
        assertNonNegativeInteger(
          reconciliation.remainingOutputTokens,
          "progressive reconciliation remainingOutputTokens",
        );
        assertOptionalNonNegativeInteger(
          reconciliation.safetyMarginTokens,
          "progressive reconciliation safetyMarginTokens",
        );
        if (
          parts !== null &&
          reconciliation.remainingOutputTokens > parts.maxOutput
        ) {
          throw new RangeError(
            "progressive reconciliation remainingOutputTokens must not exceed the reserved output cap",
          );
        }
      }
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
        // Legacy mode holds known input plus the full output reservation.
        // Progressive mode is opt-in and may be used only after prefill is
        // known complete: it holds the caller-declared future output plus an
        // explicit safety margin. Output beyond the configured cap is added
        // back as overrun protection.
        const outputOverrun = Math.max(0, reported.output - parts.maxOutput);
        const newHold =
          reconciliation === undefined
            ? reported.input + Math.max(parts.maxOutput, reported.output)
            : reconciliation.remainingOutputTokens +
              (reconciliation.safetyMarginTokens ?? 0) +
              outputOverrun;
        const delta = newHold - held;
        if (delta > 0) {
          inFlightTokens += delta;
          totalOverrun += delta;
          if (admissionClass !== undefined) {
            admissionClass.inFlightTokens += delta;
            admissionClass.totalOverrun += delta;
          }
        } else if (delta < 0) {
          const refund = -delta;
          inFlightTokens = Math.max(0, inFlightTokens - refund);
          totalRefunded += refund;
          if (admissionClass !== undefined) {
            admissionClass.inFlightTokens = Math.max(
              0,
              admissionClass.inFlightTokens - refund,
            );
            admissionClass.totalRefunded += refund;
          }
        }
        held = newHold;
      }
      const holdChanged = held !== previousHeldTokens;
      if (!released && (usageChanged || holdChanged)) {
        usageSequence++;
      }

      const report = snapshot();

      if (!released && (usageChanged || holdChanged)) {
        emit("usage", {
          request,
          admissionId,
          limitRevision,
          priority,
          ...(admissionClass !== undefined
            ? { admissionClass: admissionClass.id }
            : {}),
          sequence: usageSequence,
          reservedTokens: parts?.reserved ?? 0,
          previousHeldTokens,
          heldTokens: held,
          deltaTokens: held - previousHeldTokens,
          usage: { ...reported },
          outputCap: report.outputCap,
          outputRemaining: report.outputRemaining,
          overReservation: report.overReservation,
          ...(reconciliation === undefined
            ? {}
            : {
                progressive: true,
                remainingOutputTokens:
                  reconciliation.remainingOutputTokens,
                safetyMarginTokens:
                  reconciliation.safetyMarginTokens ?? 0,
              }),
        });
      }

      return report;
    };

    return {
      admissionId,
      limitRevision,
      ...(admissionClass !== undefined
        ? { admissionClass: admissionClass.id }
        : {}),
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
          const refunded = releaseCapacity(
            heldAtRelease,
            validUsage,
            admissionClass,
          );
          noteLLMRelease();
          emit("release", {
            request,
            admissionId,
            limitRevision,
            priority,
            ...(admissionClass !== undefined
              ? { admissionClass: admissionClass.id }
              : {}),
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
    resolved: ResolvedAdmission = resolveAdmission(request, ao),
  ): Promise<LLMAcquireResult> {
    const { priority, admissionClass, parts, reserved } = resolved;

    const rejectWith = (
      reason: LLMRejectReason,
      constraint?: LLMCapacityConstraint,
    ): LLMAcquireResult => {
      const detail = buildRejectDetail(
        reserved,
        priority,
        admissionClass,
        constraint,
      );
      noteLLMReject(reason);
      noteAdmissionClassReject(admissionClass, reason);
      emit("reject", {
        request,
        reason,
        limitRevision: detail.limitRevision,
        detail,
        ...(admissionClass !== undefined
          ? { admissionClass: admissionClass.id }
          : {}),
      });
      return { ok: false, reason, detail };
    };

    // Every class ceiling is fail-fast and checked before entering the global
    // queue. A second atomic check runs after the global slot is acquired.
    const precheck = checkAdmissionCapacity(
      reserved,
      priority,
      admissionClass,
    );
    if (precheck !== undefined) {
      return rejectWith(precheck.reason, precheck.constraint);
    }

    const mergedOptions = normalizeAcquireOptions(ao);

    const r = await bulkhead.acquire(mergedOptions);

    if (!r.ok) {
      const constraint: LLMCapacityConstraint | undefined =
        r.reason === "concurrency_limit" ||
        r.reason === "queue_limit" ||
        r.reason === "timeout"
          ? "global"
          : undefined;
      return rejectWith(r.reason, constraint);
    }

    // Post-admission: atomically reserve global token and class capacity.
    const postcheck = tryReserveCapacity(
      reserved,
      priority,
      admissionClass,
    );
    if (postcheck !== undefined) {
      r.token.release();
      return rejectWith(postcheck.reason, postcheck.constraint);
    }

    // Capture the revision at the admission linearization point: both the
    // concurrency slot and token reservation are held, and no listener or
    // callback has run yet. Later reconfiguration must not rewrite the
    // provenance of this admitted work.
    const limitRevision = currentRevision;
    const admissionId = randomUUID();
    const token = wrapToken(
      r.token,
      parts,
      request,
      admissionId,
      limitRevision,
      priority,
      admissionClass,
    );
    noteLLMAdmit();
    emit("admit", {
      request,
      admissionId,
      limitRevision,
      priority,
      ...(admissionClass !== undefined
        ? { admissionClass: admissionClass.id }
        : {}),
      reservedTokens: reserved,
    });
    return {
      ok: true,
      admissionId,
      limitRevision,
      ...(admissionClass !== undefined
        ? { admissionClass: admissionClass.id }
        : {}),
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
      admissionClass?: string;
      reservation?: LLMReservationOverride;
      detail?: boolean;
    } = {},
  ): LLMWouldAdmitResult {
    return wouldAdmitResolved(resolveAdmission(request, opts), opts.detail === true);
  }

  function shouldBypass(
    reason: LLMRejectReason,
    configured: ReadonlySet<LLMShadowableRejectReason>,
  ): reason is LLMShadowableRejectReason {
    return (
      SHADOWABLE_REASONS.has(reason as LLMShadowableRejectReason) &&
      configured.has(reason as LLMShadowableRejectReason)
    );
  }

  async function runBypassed<T>(
    request: LLMRequest,
    fn: (signal?: BulkheadSignal, ctx?: LLMRunContext) => Promise<T>,
    opts: Pick<LLMRunOptions<T>, "signal" | "getUsage">,
    admission: ResolvedAdmission,
    reason: LLMShadowableRejectReason,
    detail: LLMRejectDetail | undefined,
    limitRevision: number,
    raced: boolean,
  ): Promise<T> {
    const hardReason: Extract<LLMRejectReason, "aborted" | "shutdown"> | undefined =
      opts.signal?.aborted
        ? "aborted"
        : bulkhead.stats().closed
          ? "shutdown"
          : undefined;
    if (hardReason !== undefined) {
      const hardDetail = buildRejectDetail(
        admission.reserved,
        admission.priority,
        admission.admissionClass,
      );
      noteLLMReject(hardReason);
      noteAdmissionClassReject(admission.admissionClass, hardReason);
      emit("reject", {
        request,
        reason: hardReason,
        limitRevision: hardDetail.limitRevision,
        detail: hardDetail,
        ...(admission.admissionClass !== undefined
          ? { admissionClass: admission.admissionClass.id }
          : {}),
      });
      throw new LLMBulkheadRejectedError(hardReason, hardDetail);
    }

    const admissionId = `shadow-${randomUUID()}`;
    const reservation =
      admission.parts === null
        ? null
        : Object.freeze({ ...admission.parts });
    let reported: TokenUsage | undefined;
    let usageSequence = 0;
    let settled = false;

    observeBypassed++;
    if (raced) observeRaceBypassed++;
    observeBypassedByReason[reason] =
      (observeBypassedByReason[reason] ?? 0) + 1;

    emit("bypass", {
      request,
      admissionId,
      limitRevision,
      priority: admission.priority,
      ...(admission.admissionClass !== undefined
        ? { admissionClass: admission.admissionClass.id }
        : {}),
      reason,
      ...(detail !== undefined && { detail }),
      reservation,
      raced,
    });

    const snapshot = (): UsageReport => {
      const consumed = reported ? reported.input + reported.output : 0;
      const outputCap = admission.parts?.maxOutput ?? null;
      return {
        admissionId,
        limitRevision,
        ...(admission.admissionClass !== undefined
          ? { admissionClass: admission.admissionClass.id }
          : {}),
        sequence: usageSequence,
        reserved: admission.reserved,
        held: 0,
        consumed,
        outputCap,
        outputRemaining:
          outputCap === null
            ? null
            : Math.max(0, outputCap - (reported?.output ?? 0)),
        overReservation:
          admission.parts !== null && consumed > admission.parts.reserved,
      };
    };

    const reportUsage = (
      usage: TokenUsage,
      reconciliation?: ProgressiveReconciliationOptions,
    ): UsageReport => {
      const valid = validateTokenUsage(usage);
      if (reconciliation !== undefined) {
        assertNonNegativeInteger(
          reconciliation.remainingOutputTokens,
          "progressive reconciliation remainingOutputTokens",
        );
        assertOptionalNonNegativeInteger(
          reconciliation.safetyMarginTokens,
          "progressive reconciliation safetyMarginTokens",
        );
        if (
          admission.parts !== null &&
          reconciliation.remainingOutputTokens > admission.parts.maxOutput
        ) {
          throw new RangeError(
            "progressive reconciliation remainingOutputTokens must not exceed the reserved output cap",
          );
        }
      }
      const previous = reported;
      reported = previous
        ? {
            input: Math.max(previous.input, valid.input),
            output: Math.max(previous.output, valid.output),
          }
        : valid;
      const changed =
        previous === undefined ||
        reported.input !== previous.input ||
        reported.output !== previous.output;
      if (!settled && changed) {
        usageSequence++;
        const current = snapshot();
        emit("bypassUsage", {
          request,
          admissionId,
          limitRevision,
          priority: admission.priority,
          ...(admission.admissionClass !== undefined
            ? { admissionClass: admission.admissionClass.id }
            : {}),
          reason,
          sequence: usageSequence,
          reservation,
          usage: { ...reported },
          outputCap: current.outputCap,
          outputRemaining: current.outputRemaining,
          overReservation: current.overReservation,
          ...(reconciliation === undefined
            ? {}
            : {
                progressive: true,
                remainingOutputTokens:
                  reconciliation.remainingOutputTokens,
                safetyMarginTokens:
                  reconciliation.safetyMarginTokens ?? 0,
              }),
        });
      }
      return snapshot();
    };

    const context: LLMRunContext = {
      admissionId,
      limitRevision,
      ...(admission.admissionClass !== undefined
        ? { admissionClass: admission.admissionClass.id }
        : {}),
      reservation,
      admission: "bypassed",
      bypassReason: reason,
      ...(detail !== undefined && { bypassDetail: detail }),
      reportUsage,
    };

    const finish = (usage: TokenUsage | undefined): void => {
      if (settled) return;
      settled = true;
      if (usage !== undefined) {
        observeUsageReported++;
        observeTotalInputTokens += usage.input;
        observeTotalOutputTokens += usage.output;
      }
      emit("bypassRelease", {
        request,
        admissionId,
        limitRevision,
        priority: admission.priority,
        ...(admission.admissionClass !== undefined
          ? { admissionClass: admission.admissionClass.id }
          : {}),
        reason,
        reservation,
        usageSequence,
        ...(usage !== undefined && { usage }),
      });
    };

    try {
      const result = await fn(opts.signal, context);
      let finalUsage: TokenUsage | undefined;
      if (opts.getUsage !== undefined) {
        try {
          const extracted = opts.getUsage(result);
          finalUsage =
            extracted === undefined ? undefined : validateTokenUsage(extracted);
        } catch {
          // A bad extractor must not turn observed work into a failure.
        }
      }
      finish(finalUsage ?? reported);
      return result;
    } catch (error) {
      finish(reported);
      throw error;
    }
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
    ao: LLMRunOptions<T> = {},
  ): Promise<T> {
    const {
      getUsage,
      mode: requestedMode,
      shadowReasons: requestedShadowReasons,
      dedupScope,
      dedup: perCallDedup,
      ...acquireOpts
    } = ao;
    const mode = resolveAdmissionMode(requestedMode);
    const shadowReasons = resolveShadowReasons(requestedShadowReasons);
    // Resolve before the dedup fast path so unknown class IDs cannot join an
    // existing call without validation. The resolved class also partitions
    // deduplication, preventing one policy class from inheriting another
    // class's admission decision or queue position.
    const selectedAdmissionClass = resolveAdmissionClass(
      acquireOpts.admissionClass,
    );

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
        const effectiveScope =
          selectedAdmissionClass === undefined
            ? dedupScope ?? ""
            : JSON.stringify([dedupScope ?? "", selectedAdmissionClass.id]);
        dedupKey = hashDedupKey(effectiveScope, rawKey);
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
        emit("dedup", {
          request,
          ...(selectedAdmissionClass !== undefined
            ? { admissionClass: selectedAdmissionClass.id }
            : {}),
        });
        try {
          return await waitForSharedDedup(
            existing as Promise<T>,
            request,
            acquireOpts,
            selectedAdmissionClass,
          );
        } catch (error) {
          if (
            mode === "observe" &&
            error instanceof LLMBulkheadRejectedError &&
            dedupWaitErrors.has(error) &&
            shouldBypass(error.reason, shadowReasons)
          ) {
            return runBypassed(
              request,
              fn,
              {
                ...(ao.signal !== undefined && { signal: ao.signal }),
                ...(getUsage !== undefined && { getUsage }),
              },
              resolveAdmission(
                request,
                acquireOpts,
                selectedAdmissionClass,
              ),
              error.reason,
              error.detail,
              error.detail?.limitRevision ?? currentRevision,
              false,
            );
          }
          throw error;
        }
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

    const publish = (work: Promise<T>): Promise<T> => {
      if (deferred) {
        void work.then(
          (value) => deferred!.resolve(value),
          (error) => deferred!.reject(error),
        );
        return resultPromise!;
      }
      return work;
    };

    try {
      let resolved: ResolvedAdmission | undefined;
      let advisory: LLMWouldAdmitResult | undefined;

      if (mode === "observe") {
        resolved = resolveAdmission(
          request,
          acquireOpts,
          selectedAdmissionClass,
        );
        advisory = wouldAdmitResolved(resolved, true);
        if (
          !advisory.admit &&
          advisory.reason !== undefined &&
          shouldBypass(advisory.reason, shadowReasons)
        ) {
          return publish(
            runBypassed(
              request,
              fn,
              {
                ...(ao.signal !== undefined && { signal: ao.signal }),
                ...(getUsage !== undefined && { getUsage }),
              },
              resolved,
              advisory.reason,
              advisory.detail,
              advisory.detail?.limitRevision ?? currentRevision,
              false,
            ),
          );
        }
      }

      const r = await _acquire(
        request,
        acquireOpts,
        resolved ??
          resolveAdmission(request, acquireOpts, selectedAdmissionClass),
      );
      if (!r.ok) {
        if (mode === "observe" && shouldBypass(r.reason, shadowReasons)) {
          return publish(
            runBypassed(
              request,
              fn,
              {
                ...(ao.signal !== undefined && { signal: ao.signal }),
                ...(getUsage !== undefined && { getUsage }),
              },
              resolved ??
                resolveAdmission(
                  request,
                  acquireOpts,
                  selectedAdmissionClass,
                ),
              r.reason,
              r.detail,
              r.detail?.limitRevision ?? currentRevision,
              advisory?.admit === true,
            ),
          );
        }
        throw new LLMBulkheadRejectedError(r.reason, r.detail);
      }

      const ctx: LLMRunContext = {
        admissionId: r.admissionId,
        limitRevision: r.limitRevision,
        ...(r.admissionClass !== undefined
          ? { admissionClass: r.admissionClass }
          : {}),
        reservation: r.reservation,
        admission: "admitted",
        reportUsage: (usage, reconciliation) =>
          r.token.reportUsage(usage, reconciliation),
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

      return publish(work);
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
      limits: limits(),
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
        highPriorityReserve: currentHighPriorityReserve,
      };
    }

    if (observeBypassed > 0) {
      result.observe = {
        bypassed: observeBypassed,
        raceBypassed: observeRaceBypassed,
        bypassedByReason: { ...observeBypassedByReason },
        usageReported: observeUsageReported,
        totalInputTokens: observeTotalInputTokens,
        totalOutputTokens: observeTotalOutputTokens,
      };
    }

    if (dedup.enabled) {
      result.deduplication = {
        active: dedupMap.size,
        hits: dedupHits,
      };
    }

    if (defaultAdmissionClass !== undefined) {
      result.admissionClasses = {
        defaultClass: defaultAdmissionClass,
        classes: Object.fromEntries(
          Array.from(admissionClassStates, ([id, state]) => [
            id,
            {
              limits: {
                ...(state.maxConcurrent !== undefined && {
                  maxConcurrent: state.maxConcurrent,
                }),
                ...(state.maxInFlightTokens !== undefined && {
                  maxInFlightTokens: state.maxInFlightTokens,
                }),
              },
              inFlight: state.inFlight,
              inFlightTokens: state.inFlightTokens,
              admitted: state.admitted,
              released: state.released,
              rejected: state.rejected,
              rejectedByReason: { ...state.rejectedByReason },
              totalReserved: state.totalReserved,
              totalConsumed: state.totalConsumed,
              totalRefunded: state.totalRefunded,
              totalOverrun: state.totalOverrun,
            },
          ]),
        ),
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
    limits,
    applyLimits,
    setBudget,
    close,
    drain,
    on,
  };
}


export type LLMBulkhead = ReturnType<typeof createLLMBulkhead>;
