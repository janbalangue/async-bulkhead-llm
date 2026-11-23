/**
 * Internal types and constants shared by the engine modules.
 *
 * Nothing under `src/engine` is part of the public API: the package entry
 * point re-exports only what `src/index.ts` lists.
 */
import type { AcquireOptions } from "async-bulkhead-ts";
import type { LLMAdmissionStoppedError } from "../errors.js";
import type { createReconfigurableBulkhead } from "../reconfigurable-bulkhead.js";
import type {
  LLMAcquireResult,
  LLMAdmissionResources,
  LLMBorrowedConcurrencyAbandonCause,
  LLMCapacityConstraint,
  LLMPriority,
  LLMRejectReason,
  LLMReservationEstimate,
  LLMToken,
} from "../types.js";

/** Abort signal accepted by the underlying concurrency acquire. */
export type BulkheadSignal = NonNullable<AcquireOptions["signal"]>;

/**
 * The reconfigurable concurrency gate. It owns the global slot count and
 * the queue; the engine reads both through `stats()` and never mirrors
 * them.
 */
export type ConcurrencyGate = ReturnType<typeof createReconfigurableBulkhead>;

/** Estimate parts kept per-token so streaming reports can re-derive holds. */
export type ReservationParts = LLMReservationEstimate;

/**
 * What one call asks for, after its options are resolved.
 *
 * An admission class always travels as its id. The numbers that belong to
 * a class stay with the engine part that owns them.
 */
export type ResolvedAdmission = {
  priority: LLMPriority;
  admissionClass: string | undefined;
  parts: ReservationParts | null;
  reserved: number;
};

export type CapacityFailure = {
  reason: Extract<LLMRejectReason, "budget_limit" | "concurrency_limit">;
  constraint: LLMCapacityConstraint;
};

export type CapacityReservationResult =
  | { readonly ok: false; readonly failure: CapacityFailure }
  | { readonly ok: true; readonly resources: LLMAdmissionResources };

export const NO_ADMISSION_RESOURCES: LLMAdmissionResources = Object.freeze({
  borrowedConcurrency: false,
  borrowedTokens: 0,
});

/**
 * Internal view of a wrapped token. `run()` must attribute a lease expiry
 * distinctly from an application's own abandonment without widening the
 * public `LLMToken` surface, where a caller-supplied cause would be
 * unverifiable telemetry. The key is an engine-private symbol, never
 * exported from the package entry point, so the capability is unreachable
 * from a published token.
 */
export const ABANDON_WITH_CAUSE = Symbol("abandonBorrowedConcurrencyWithCause");

/**
 * How `run()` learns that the engine stopped its call. Engine-private for
 * the same reason as `ABANDON_WITH_CAUSE`: a published token must not let
 * a caller intercept or fake a stop.
 */
export const ON_STOP = Symbol("onStop");

export type WrappedLLMToken = LLMToken & {
  [ABANDON_WITH_CAUSE](cause: LLMBorrowedConcurrencyAbandonCause): boolean;
  /**
   * Register what to do when the engine stops this call. If the call was
   * already stopped, the handler is not kept and the stop error is
   * returned instead.
   */
  [ON_STOP](
    handler: (error: LLMAdmissionStoppedError) => void,
  ): LLMAdmissionStoppedError | undefined;
};

export type InternalAcquireResult =
  | (Extract<LLMAcquireResult, { ok: true }> & { token: WrappedLLMToken })
  | Extract<LLMAcquireResult, { ok: false }>;
