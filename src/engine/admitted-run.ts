/**
 * Running a callback that was admitted: build its context, call it, and
 * release its token with whatever usage is known. Also the two ways the
 * caller can get its answer before the callback settles: the wall-clock
 * deadline that takes back a borrowed concurrency slot, and a stop by the
 * engine.
 */
import type { LLMRunContext, LLMRunOptions, TokenUsage } from "../types.js";
import { LLMBorrowedConcurrencyDeadlineError } from "../errors.js";
import { validateTokenUsage } from "../validation.js";
import {
  ABANDON_WITH_CAUSE,
  ON_STOP,
  type BulkheadSignal,
  type InternalAcquireResult,
} from "./shared.js";

type Admitted = Extract<InternalAcquireResult, { ok: true }>;

/**
 * Race admitted work against the borrowed-slot deadline.
 *
 * On expiry the borrowed slot is returned, the callback's signal is
 * aborted and the caller gets `LLMBorrowedConcurrencyDeadlineError`. The
 * callback keeps running and still settles its own token hold.
 */
function withBorrowedDeadline<T>(
  work: Promise<T>,
  r: Admitted,
  deadlineMs: number,
  callbackAbort: AbortController,
  cleanup: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let publicSettled = false;
    const settle = (fn: () => void): void => {
      if (publicSettled) return;
      publicSettled = true;
      fn();
    };
    const deadline = setTimeout(() => {
      const error = new LLMBorrowedConcurrencyDeadlineError(
        deadlineMs,
        r.admissionId,
        r.resources,
        r.admissionClass,
      );
      if (!r.token[ABANDON_WITH_CAUSE]("deadline")) return;
      callbackAbort.abort(error);
      settle(() => reject(error));
    }, deadlineMs);

    void work.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    ).finally(() => {
      clearTimeout(deadline);
      cleanup();
    });
  });
}

/**
 * Start the callback of an admitted call and return the promise the
 * caller should see. Not `async` on purpose: the callback starts
 * synchronously, exactly where `run()` asks for it.
 *
 * `stoppable` is true when a stop policy was active at admission. Only
 * then, or under a borrowed-slot deadline, does the callback get a signal
 * the engine can abort. Otherwise it gets exactly what the caller passed,
 * the same object or nothing, and a stop can only reject the caller.
 */
export function runAdmitted<T>(
  r: Admitted,
  fn: (signal?: BulkheadSignal, ctx?: LLMRunContext) => Promise<T>,
  ao: Pick<LLMRunOptions<T>, "signal">,
  getUsage: ((result: T) => TokenUsage | undefined) | undefined,
  borrowedConcurrencyDeadlineMs: number | undefined,
  stoppable: boolean,
): Promise<T> {
  const ctx: LLMRunContext = {
    admissionId: r.admissionId,
    limitRevision: r.limitRevision,
    ...(r.admissionClass !== undefined
      ? { admissionClass: r.admissionClass }
      : {}),
    reservation: r.reservation,
    resources: r.resources,
    admission: "admitted",
    reportUsage: (usage, reconciliation) =>
      r.token.reportUsage(usage, reconciliation),
    abandonBorrowedConcurrency: () =>
      r.token.abandonBorrowedConcurrency(),
  };

  // The deadline applies only to a slot that came from shared capacity.
  const deadlineMs =
    borrowedConcurrencyDeadlineMs !== undefined &&
    r.resources.borrowedConcurrency
      ? borrowedConcurrencyDeadlineMs
      : undefined;
  const callbackAbort =
    deadlineMs !== undefined || stoppable ? new AbortController() : undefined;
  const sourceSignal = ao.signal;
  let removeSourceAbortListener: (() => void) | undefined;
  if (callbackAbort !== undefined && sourceSignal !== undefined) {
    const forwardAbort = () => callbackAbort.abort(sourceSignal.reason);
    if (sourceSignal.aborted) {
      forwardAbort();
    } else {
      sourceSignal.addEventListener("abort", forwardAbort, { once: true });
      removeSourceAbortListener = () =>
        sourceSignal.removeEventListener("abort", forwardAbort);
    }
  }

  // `work` settles on the same microtask as an `async` function around
  // the callback would. It is built by hand so that a stop can reject it
  // early; the callback's own settlement still releases the token later.
  const work = new Promise<T>((resolve, reject) => {
    const stoppedBeforeStart = r.token[ON_STOP]((error) => {
      callbackAbort?.abort(error);
      reject(error);
    });
    if (stoppedBeforeStart !== undefined) {
      // Stopped between admission and this point: nothing was started,
      // so nothing is left to hold tokens for.
      removeSourceAbortListener?.();
      r.token.release();
      reject(stoppedBeforeStart);
      return;
    }

    let started: Promise<T>;
    try {
      started = fn(callbackAbort?.signal ?? ao.signal, ctx);
    } catch (err) {
      removeSourceAbortListener?.();
      r.token.release(); // no usage on error
      reject(err);
      return;
    }

    void Promise.resolve(started).then(
      (result) => {
        removeSourceAbortListener?.();
        // Extract usage for refund.
        let usage: TokenUsage | undefined;
        if (getUsage) {
          try {
            const extracted = getUsage(result);
            usage =
              extracted === undefined
                ? undefined
                : validateTokenUsage(extracted);
          } catch {
            // bad getUsage must not break release
          }
        }
        try {
          r.token.release(usage);
        } catch (err) {
          reject(err);
          return;
        }
        resolve(result);
      },
      (err) => {
        removeSourceAbortListener?.();
        try {
          r.token.release(); // no usage on error
        } catch (releaseError) {
          reject(releaseError);
          return;
        }
        reject(err);
      },
    );
  });

  if (deadlineMs === undefined || callbackAbort === undefined) return work;

  return withBorrowedDeadline(work, r, deadlineMs, callbackAbort, () =>
    removeSourceAbortListener?.(),
  );
}
