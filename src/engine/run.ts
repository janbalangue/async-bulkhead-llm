/**
 * `run()`: the order in which one call meets deduplication, observe mode,
 * admission and execution. Each of those lives in its own module; this
 * file only decides which one a call goes to next.
 *
 * The two `await`s here (following a shared call, and admission) are the
 * only points where `run()` itself yields. The helpers it calls either
 * finish synchronously or hand back a promise that is returned as is.
 */
import type {
  LLMRequest,
  LLMRunContext,
  LLMRunOptions,
  LLMWouldAdmitResult,
  TokenUsage,
} from "../types.js";
import { LLMBulkheadRejectedError } from "../errors.js";
import type { Acquire } from "./acquire.js";
import type { ResolveAdmission } from "./admission-request.js";
import { runAdmitted } from "./admitted-run.js";
import type { RunBypassed } from "./bypass.js";
import type { Dedup } from "./dedup-flow.js";
import type { Limits } from "./limits.js";
import { readRunOptions, shouldBypass } from "./run-options.js";
import type { BulkheadSignal, ResolvedAdmission } from "./shared.js";
import type { WouldAdmitResolved } from "./would-admit.js";

type Deps = {
  limits: Limits;
  dedup: Dedup;
  resolveAdmission: ResolveAdmission;
  wouldAdmitResolved: WouldAdmitResolved;
  acquire: Acquire;
  runBypassed: RunBypassed;
};

/** The two `run()` options a bypassed callback still needs. */
function bypassOptions<T>(
  ao: LLMRunOptions<T>,
  getUsage: ((result: T) => TokenUsage | undefined) | undefined,
): Pick<LLMRunOptions<T>, "signal" | "getUsage"> {
  return {
    ...(ao.signal !== undefined && { signal: ao.signal }),
    ...(getUsage !== undefined && { getUsage }),
  };
}

export function createRun(deps: Deps) {
  const { limits, dedup, resolveAdmission, runBypassed } = deps;

  // Returned as is to callers of the bulkhead: it is the public `run`.
  return async function run<T>(
    request: LLMRequest,
    fn: (signal?: BulkheadSignal, ctx?: LLMRunContext) => Promise<T>,
    ao: LLMRunOptions<T> = {},
  ): Promise<T> {
    const {
      getUsage,
      mode,
      shadowReasons,
      dedupScope,
      perCallDedup,
      borrowedConcurrencyDeadlineMs,
      acquireOpts,
    } = readRunOptions(ao);
    // Resolve before the dedup fast path so unknown class IDs cannot join an
    // existing call without validation. The resolved class also partitions
    // deduplication, preventing one policy class from inheriting another
    // class's admission decision or queue position.
    const selectedClass = limits.resolveClass(acquireOpts.admissionClass);

    // ---- Deduplication ----
    const dedupKey = dedup.keyFor(
      request,
      perCallDedup,
      dedupScope,
      selectedClass,
    );
    let lead: ReturnType<typeof dedup.lead<T>> | undefined;
    if (dedupKey !== "") {
      const existing = dedup.join<T>(dedupKey, request, selectedClass);
      if (existing) {
        try {
          return await dedup.follow(
            existing,
            request,
            acquireOpts,
            selectedClass,
          );
        } catch (error) {
          if (
            mode === "observe" &&
            error instanceof LLMBulkheadRejectedError &&
            dedup.isWaitRejection(error) &&
            shouldBypass(error.reason, shadowReasons)
          ) {
            return runBypassed(
              request,
              fn,
              bypassOptions(ao, getUsage),
              resolveAdmission(request, acquireOpts, selectedClass),
              error.reason,
              error.detail,
              error.detail?.limitRevision ?? limits.revision(),
              false,
            );
          }
          throw error;
        }
      }
      lead = dedup.lead<T>(dedupKey);
    }

    // A leader's followers settle with whatever the leader's work does.
    const publish = (work: Promise<T>): Promise<T> =>
      lead ? lead.publish(work) : work;

    try {
      let resolved: ResolvedAdmission | undefined;
      let advisory: LLMWouldAdmitResult | undefined;

      if (mode === "observe") {
        resolved = resolveAdmission(request, acquireOpts, selectedClass);
        advisory = deps.wouldAdmitResolved(resolved, true);
        if (
          !advisory.admit &&
          advisory.reason !== undefined &&
          shouldBypass(advisory.reason, shadowReasons)
        ) {
          return publish(
            runBypassed(
              request,
              fn,
              bypassOptions(ao, getUsage),
              resolved,
              advisory.reason,
              advisory.detail,
              advisory.detail?.limitRevision ?? limits.revision(),
              false,
            ),
          );
        }
      }

      const r = await deps.acquire(
        request,
        acquireOpts,
        resolved ?? resolveAdmission(request, acquireOpts, selectedClass),
        mode === "observe" ? shadowReasons : undefined,
      );
      if (!r.ok) {
        if (mode === "observe" && shouldBypass(r.reason, shadowReasons)) {
          return publish(
            runBypassed(
              request,
              fn,
              bypassOptions(ao, getUsage),
              resolved ??
                resolveAdmission(request, acquireOpts, selectedClass),
              r.reason,
              r.detail,
              r.detail?.limitRevision ?? limits.revision(),
              advisory?.admit === true,
            ),
          );
        }
        throw new LLMBulkheadRejectedError(r.reason, r.detail);
      }

      return publish(
        runAdmitted(
          r,
          fn,
          ao,
          getUsage,
          borrowedConcurrencyDeadlineMs,
          limits.stopPolicy() !== undefined,
        ),
      );
    } catch (err) {
      if (lead) return lead.fail(err);
      throw err;
    }
  };
}
