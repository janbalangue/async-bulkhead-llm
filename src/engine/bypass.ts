/**
 * Observe-mode bypass: run a callback that enforcement would have
 * rejected, without holding a slot or any tokens, and record what it
 * did. Bypassed work is invisible to concurrency and budget accounting;
 * only the observe counters and the `bypass*` events see it.
 *
 * Shutdown and caller cancellation are never bypassed.
 */
import { randomUUID } from "node:crypto";
import type {
  LLMRejectDetail,
  LLMRejectReason,
  LLMRequest,
  LLMRunContext,
  LLMRunOptions,
  LLMShadowableRejectReason,
  ProgressiveReconciliationOptions,
  TokenUsage,
  UsageReport,
} from "../types.js";
import { LLMBulkheadRejectedError } from "../errors.js";
import { validateTokenUsage } from "../validation.js";
import type { AdmissionCounts } from "./admission-counts.js";
import type { EventHub } from "./events.js";
import type { ObserveStats } from "./observe-stats.js";
import type { BuildRejectDetail } from "./reject-detail.js";
import {
  NO_ADMISSION_RESOURCES,
  type BulkheadSignal,
  type ConcurrencyGate,
  type ResolvedAdmission,
} from "./shared.js";
import {
  assertReconciliation,
  consumedTokens,
  mergeUsage,
  progressiveFields,
  usageChanged,
  usageSnapshot,
  type UsageCell,
} from "./usage-report.js";

type Deps = {
  concurrency: ConcurrencyGate;
  counts: AdmissionCounts;
  events: EventHub;
  observeStats: ObserveStats;
  buildRejectDetail: BuildRejectDetail;
};

/** One bypassed execution: its callback context and how to settle it. */
type BypassSession = {
  readonly context: LLMRunContext;
  /** Last cumulative usage the callback reported, if any. */
  reported(): TokenUsage | undefined;
  /** Settle once; later calls are ignored. */
  finish(usage: TokenUsage | undefined): void;
};

/** Reject with a hard reason that observe mode must not bypass. */
function rejectIfHardStopped(
  deps: Deps,
  request: LLMRequest,
  signal: BulkheadSignal | undefined,
  admission: ResolvedAdmission,
): void {
  const hardReason: Extract<LLMRejectReason, "aborted" | "shutdown"> | undefined =
    signal?.aborted
      ? "aborted"
      : deps.concurrency.stats().closed
        ? "shutdown"
        : undefined;
  if (hardReason === undefined) return;

  const hardDetail = deps.buildRejectDetail(
    admission.reserved,
    admission.priority,
    admission.admissionClass,
  );
  deps.counts.noteReject(admission.admissionClass, hardReason);
  deps.events.emit("reject", {
    request,
    reason: hardReason,
    limitRevision: hardDetail.limitRevision,
    detail: hardDetail,
    ...(admission.admissionClass !== undefined
      ? { admissionClass: admission.admissionClass }
      : {}),
  });
  throw new LLMBulkheadRejectedError(hardReason, hardDetail);
}

/** Count the bypass, announce it, and build the callback's context. */
function openBypass(
  deps: Deps,
  request: LLMRequest,
  admission: ResolvedAdmission,
  reason: LLMShadowableRejectReason,
  detail: LLMRejectDetail | undefined,
  limitRevision: number,
  raced: boolean,
): BypassSession {
  const { events } = deps;
  const admissionId = `shadow-${randomUUID()}`;
  const reservation =
    admission.parts === null ? null : Object.freeze({ ...admission.parts });
  const cell: UsageCell = { reported: undefined };
  let usageSequence = 0;
  let settled = false;

  deps.observeStats.noteBypass(reason, raced);

  const callFields = {
    request,
    admissionId,
    limitRevision,
    priority: admission.priority,
    ...(admission.admissionClass !== undefined
      ? { admissionClass: admission.admissionClass }
      : {}),
  };

  events.emit("bypass", {
    ...callFields,
    reason,
    ...(detail !== undefined && { detail }),
    reservation,
    raced,
  });

  const snapshot = (): UsageReport => {
    const consumed = consumedTokens(cell);
    const outputCap = admission.parts?.maxOutput ?? null;
    return usageSnapshot({
      admissionId,
      limitRevision,
      admissionClass: admission.admissionClass,
      parts: admission.parts,
      cell,
      consumed,
      outputCap,
      sequence: usageSequence,
      held: 0,
    });
  };

  const reportUsage = (
    usage: TokenUsage,
    reconciliation?: ProgressiveReconciliationOptions,
  ): UsageReport => {
    const valid = validateTokenUsage(usage);
    assertReconciliation(reconciliation, admission.parts);
    const previous = cell.reported;
    cell.reported = mergeUsage(previous, valid);
    const changed = usageChanged(cell, previous);
    if (!settled && changed) {
      usageSequence++;
      const current = snapshot();
      events.emit("bypassUsage", {
        ...callFields,
        reason,
        sequence: usageSequence,
        reservation,
        usage: { ...cell.reported! },
        outputCap: current.outputCap,
        outputRemaining: current.outputRemaining,
        overReservation: current.overReservation,
        ...progressiveFields(reconciliation),
      });
    }
    return snapshot();
  };

  const context: LLMRunContext = {
    admissionId,
    limitRevision,
    ...(admission.admissionClass !== undefined
      ? { admissionClass: admission.admissionClass }
      : {}),
    reservation,
    resources: NO_ADMISSION_RESOURCES,
    admission: "bypassed",
    bypassReason: reason,
    ...(detail !== undefined && { bypassDetail: detail }),
    reportUsage,
    abandonBorrowedConcurrency: () => false,
  };

  const finish = (usage: TokenUsage | undefined): void => {
    if (settled) return;
    settled = true;
    if (usage !== undefined) deps.observeStats.noteUsage(usage);
    events.emit("bypassRelease", {
      ...callFields,
      reason,
      reservation,
      usageSequence,
      ...(usage !== undefined && { usage }),
    });
  };

  return { context, reported: () => cell.reported, finish };
}

export function createBypass(deps: Deps) {
  /**
   * `raced` is true when the advisory check said "admit" and the real
   * admission then rejected.
   */
  return async function runBypassed<T>(
    request: LLMRequest,
    fn: (signal?: BulkheadSignal, ctx?: LLMRunContext) => Promise<T>,
    opts: Pick<LLMRunOptions<T>, "signal" | "getUsage">,
    admission: ResolvedAdmission,
    reason: LLMShadowableRejectReason,
    detail: LLMRejectDetail | undefined,
    limitRevision: number,
    raced: boolean,
  ): Promise<T> {
    rejectIfHardStopped(deps, request, opts.signal, admission);
    const session = openBypass(
      deps,
      request,
      admission,
      reason,
      detail,
      limitRevision,
      raced,
    );

    try {
      const result = await fn(opts.signal, session.context);
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
      session.finish(finalUsage ?? session.reported());
      return result;
    } catch (error) {
      session.finish(session.reported());
      throw error;
    }
  };
}

export type RunBypassed = ReturnType<typeof createBypass>;
