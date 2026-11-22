/**
 * In-flight deduplication for `run()`: one caller leads a shared call and
 * later identical callers follow it instead of asking for capacity.
 *
 * Owner of the in-flight map and of the `dedupHits` count; nothing
 * outside this file touches either. The pure key and share-safety
 * helpers live in `src/dedup.ts`.
 */
import type { AcquireOptions } from "async-bulkhead-ts";
import type {
  LLMBulkheadOptions,
  LLMRejectReason,
  LLMRequest,
} from "../types.js";
import { hashDedupKey, isUnsafeToShare, resolveDedup } from "../dedup.js";
import { LLMBulkheadRejectedError } from "../errors.js";
import { assertNonNegativeInteger } from "../validation.js";
import type { AdmissionCounts } from "./admission-counts.js";
import type { EventHub } from "./events.js";
import type { Limits } from "./limits.js";

type Deps = {
  options: LLMBulkheadOptions["deduplication"];
  limits: Limits;
  counts: AdmissionCounts;
  events: EventHub;
};

type WaitRejectReason = Extract<
  LLMRejectReason,
  "aborted" | "timeout" | "unshareable_result"
>;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
 *
 * `deliver` hands the shared value to this follower; `rejection` records
 * and builds the error for a wait that ended early.
 */
function waitForShared<T>(
  shared: Promise<T>,
  ao: AcquireOptions,
  deliver: (value: T) => T,
  rejection: (reason: "aborted" | "timeout") => LLMBulkheadRejectedError,
): Promise<T> {
  const signal = ao.signal;
  const effectiveTimeoutMs = ao.timeoutMs;
  if (effectiveTimeoutMs !== undefined) {
    assertNonNegativeInteger(effectiveTimeoutMs, "timeoutMs");
  }

  if (signal?.aborted) {
    return Promise.reject(rejection("aborted"));
  }
  if (signal === undefined && effectiveTimeoutMs === undefined) {
    return shared.then((value) => deliver(value));
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
        reject(rejection("aborted"));
      });
    };

    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (effectiveTimeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        settle(() => {
          reject(rejection("timeout"));
        });
      }, effectiveTimeoutMs);
    }

    void shared.then(
      (value) =>
        settle(() => {
          try {
            resolve(deliver(value));
          } catch (err) {
            reject(err);
          }
        }),
      (err) => settle(() => reject(err)),
    );
  });
}

export function createDedup(deps: Deps) {
  const { limits, counts, events } = deps;
  const dedup = resolveDedup(deps.options);
  const dedupMap = new Map<string, Promise<unknown>>();
  const dedupWaitErrors = new WeakSet<LLMBulkheadRejectedError>();
  let dedupHits = 0;

  function noteWaitRejection(
    request: LLMRequest,
    reason: WaitRejectReason,
    classId: string | undefined,
  ): LLMBulkheadRejectedError {
    counts.noteReject(classId, reason);
    events.emit("reject", {
      request,
      reason,
      limitRevision: limits.revision(),
      ...(classId !== undefined ? { admissionClass: classId } : {}),
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
    classId: string | undefined,
  ): T {
    if (dedup.shareResult) {
      return dedup.shareResult(value) as T;
    }
    if (isUnsafeToShare(value)) {
      throw noteWaitRejection(request, "unshareable_result", classId);
    }
    return value;
  }

  /**
   * The in-flight map key for a call, or `""` when the call does not take
   * part in deduplication. The class id is part of the scope, so one
   * policy class never inherits another class's admission decision or
   * queue position.
   */
  function keyFor(
    request: LLMRequest,
    perCallDedup: boolean | undefined,
    dedupScope: string | undefined,
    classId: string | undefined,
  ): string {
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
          classId === undefined
            ? dedupScope ?? ""
            : JSON.stringify([dedupScope ?? "", classId]);
        dedupKey = hashDedupKey(effectiveScope, rawKey);
      }
    }
    return dedupKey;
  }

  /** The shared call already in flight for this key, counted as a hit. */
  function join<T>(
    key: string,
    request: LLMRequest,
    classId: string | undefined,
  ): Promise<T> | undefined {
    const existing = dedupMap.get(key);
    if (!existing) return undefined;
    dedupHits++;
    events.emit("dedup", {
      request,
      ...(classId !== undefined ? { admissionClass: classId } : {}),
    });
    return existing as Promise<T>;
  }

  /** Follow a shared call until it settles or this follower gives up. */
  function follow<T>(
    shared: Promise<T>,
    request: LLMRequest,
    ao: AcquireOptions,
    classId: string | undefined,
  ): Promise<T> {
    return waitForShared(
      shared,
      ao,
      (value) => deliverShared(value, request, classId),
      (reason) => noteWaitRejection(request, reason, classId),
    );
  }

  /** Become the leader for this key until the published work settles. */
  function lead<T>(key: string) {
    const deferred = createDeferred<T>();
    dedupMap.set(key, deferred.promise);

    const cleanup = () => {
      try {
        const p = dedupMap.get(key);
        if (p === deferred.promise) dedupMap.delete(key);
      } catch {
        // never throw from cleanup
      }
    };
    void deferred.promise.then(cleanup, cleanup);

    return {
      /** Followers settle with `work`; the leader gets the shared promise. */
      publish(work: Promise<T>): Promise<T> {
        void work.then(
          (value) => deferred.resolve(value),
          (error) => deferred.reject(error),
        );
        return deferred.promise;
      },
      /** The leader failed before it had work to publish. */
      fail(err: unknown): Promise<T> {
        deferred.reject(err);
        return deferred.promise;
      },
    };
  }

  return {
    keyFor,
    join,
    follow,
    lead,
    /** True for errors raised because a follower's own wait ended early. */
    isWaitRejection: (error: LLMBulkheadRejectedError): boolean =>
      dedupWaitErrors.has(error),
    /** Detached counts; `undefined` when deduplication is disabled. */
    stats: (): { active: number; hits: number } | undefined =>
      dedup.enabled ? { active: dedupMap.size, hits: dedupHits } : undefined,
  };
}

export type Dedup = ReturnType<typeof createDedup>;
