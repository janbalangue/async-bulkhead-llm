/**
 * The admission sequence for one call:
 *
 *   1. fail-fast precheck against every class ceiling and the budget
 *   2. wait for a global concurrency slot (the only step that can queue)
 *   3. reserve every other capacity layer atomically, now that the slot
 *      is held; give the slot back if that fails
 *   4. hand out the wrapped token
 *
 * It also measures the admission decision, keeping queue wait separate
 * from the synchronous decision work.
 */
import type { AcquireOptions } from "async-bulkhead-ts";
import { randomUUID } from "node:crypto";
import type {
  LLMAcquireOptions,
  LLMAcquireResult,
  LLMCapacityConstraint,
  LLMEventMap,
  LLMRejectReason,
  LLMRequest,
  LLMShadowableRejectReason,
} from "../types.js";
import { assertNonNegativeInteger } from "../validation.js";
import type { AdmissionCounts } from "./admission-counts.js";
import type { ResolveAdmission } from "./admission-request.js";
import type { WrapToken } from "./admitted-token.js";
import type { Capacity } from "./capacity.js";
import type { EventHub } from "./events.js";
import type { Limits } from "./limits.js";
import type { BuildRejectDetail } from "./reject-detail.js";
import type {
  ConcurrencyGate,
  InternalAcquireResult,
  ResolvedAdmission,
} from "./shared.js";

type Deps = {
  concurrency: ConcurrencyGate;
  limits: Limits;
  capacity: Capacity;
  counts: AdmissionCounts;
  events: EventHub;
  buildRejectDetail: BuildRejectDetail;
  resolveAdmission: ResolveAdmission;
  wrapToken: WrapToken;
  /** Bulkhead-level queue-wait timeout, used when a call passes none. */
  timeoutMs: number | undefined;
};

function normalizeAcquireOptions(
  ao: AcquireOptions,
  defaultTimeoutMs: number | undefined,
): AcquireOptions {
  const normalized: AcquireOptions = {};
  if (ao.signal !== undefined) normalized.signal = ao.signal;
  const effectiveTimeoutMs = ao.timeoutMs ?? defaultTimeoutMs;
  if (effectiveTimeoutMs !== undefined) {
    assertNonNegativeInteger(effectiveTimeoutMs, "timeoutMs");
    normalized.timeoutMs = effectiveTimeoutMs;
  }
  return normalized;
}

/**
 * Admission timing deliberately separates synchronous decision work from
 * the awaited concurrency acquire. Exact accounting requires four
 * monotonic clock reads on paths that reach the acquire: decision start,
 * wait start, wait end, and decision end. Precheck rejects use two reads.
 */
function startDecisionClock() {
  const decisionStartedNs = process.hrtime.bigint();
  let waitStartedNs = 0n;
  let waitEndedNs = 0n;
  let queueWaitNs = 0;
  return {
    /** Decision time of a precheck reject, which never reaches the wait. */
    sinceStartNs: (): number =>
      Number(process.hrtime.bigint() - decisionStartedNs),
    startWait(): void {
      waitStartedNs = process.hrtime.bigint();
    },
    endWait(): void {
      waitEndedNs = process.hrtime.bigint();
      queueWaitNs = Number(waitEndedNs - waitStartedNs);
    },
    /** Synchronous decision time so far, excluding the awaited acquire. */
    decisionDurationNs: (): number =>
      Number(
        waitStartedNs -
          decisionStartedNs +
          (process.hrtime.bigint() - waitEndedNs),
      ),
    queueWaitNs: (): number => queueWaitNs,
  };
}

export function createAcquire(deps: Deps) {
  const { concurrency, limits, capacity, counts, events } = deps;

  /**
   * `untimedRejectReasons` names the rejections observe mode will turn
   * into a bypass. Those are not admission decisions, so they carry no
   * timing.
   */
  return async function acquire(
    request: LLMRequest,
    ao: LLMAcquireOptions,
    resolved: ResolvedAdmission = deps.resolveAdmission(request, ao),
    untimedRejectReasons?: ReadonlySet<LLMShadowableRejectReason>,
  ): Promise<InternalAcquireResult> {
    const { priority, admissionClass, parts, reserved } = resolved;
    const clock = startDecisionClock();
    const isTimed = (reason: LLMRejectReason): boolean =>
      untimedRejectReasons === undefined ||
      !untimedRejectReasons.has(reason as LLMShadowableRejectReason);

    const rejectWith = (
      reason: LLMRejectReason,
      constraint?: LLMCapacityConstraint,
      precheckDecisionDurationNs?: number,
    ): Extract<LLMAcquireResult, { ok: false }> => {
      const detail = deps.buildRejectDetail(
        reserved,
        priority,
        admissionClass,
        constraint,
      );
      const decisionDurationNs = isTimed(reason)
        ? precheckDecisionDurationNs ?? clock.decisionDurationNs()
        : undefined;
      counts.noteReject(admissionClass, reason);
      const event: LLMEventMap["reject"] = {
        request,
        reason,
        limitRevision: detail.limitRevision,
        detail,
        ...(admissionClass !== undefined ? { admissionClass } : {}),
      };
      if (decisionDurationNs !== undefined) {
        event.decisionDurationNs = decisionDurationNs;
        event.queueWaitNs = clock.queueWaitNs();
      }
      events.emit("reject", event);
      return { ok: false, reason, detail };
    };

    // Every class ceiling is fail-fast and checked before entering the global
    // queue. A second atomic check runs after the global slot is acquired.
    const precheck = capacity.check(reserved, priority, admissionClass);
    if (precheck !== undefined) {
      const precheckDecisionDurationNs = isTimed(precheck.reason)
        ? clock.sinceStartNs()
        : undefined;
      return rejectWith(
        precheck.reason,
        precheck.constraint,
        precheckDecisionDurationNs,
      );
    }

    const mergedOptions = normalizeAcquireOptions(ao, deps.timeoutMs);

    clock.startWait();
    const r = await concurrency.acquire(mergedOptions);
    clock.endWait();

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
    const postcheck = capacity.tryReserve(reserved, priority, admissionClass);
    if (!postcheck.ok) {
      r.token.release();
      return rejectWith(postcheck.failure.reason, postcheck.failure.constraint);
    }

    // Capture the revision at the admission linearization point: both the
    // concurrency slot and token reservation are held, and no listener or
    // callback has run yet. Later reconfiguration must not rewrite the
    // provenance of this admitted work.
    const limitRevision = limits.revision();
    const admissionId = randomUUID();
    const token = deps.wrapToken({
      base: r.token,
      parts,
      request,
      admissionId,
      limitRevision,
      priority,
      admissionClass,
      resources: postcheck.resources,
    });
    const decisionDurationNs = clock.decisionDurationNs();
    counts.noteAdmit(admissionClass);
    events.emit("admit", {
      request,
      admissionId,
      limitRevision,
      priority,
      ...(admissionClass !== undefined ? { admissionClass } : {}),
      reservedTokens: reserved,
      resources: postcheck.resources,
      decisionDurationNs,
      queueWaitNs: clock.queueWaitNs(),
    });
    return {
      ok: true,
      admissionId,
      limitRevision,
      ...(admissionClass !== undefined ? { admissionClass } : {}),
      reservation: token.reservation,
      resources: token.resources,
      token,
    };
  };
}

export type Acquire = ReturnType<typeof createAcquire>;
