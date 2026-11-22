/**
 * Construction-time option validation and resolution for
 * `createLLMBulkhead`.
 *
 * Runs once, before any engine part exists, and throws on the first
 * invalid option. The order of the checks decides which error a caller
 * sees when several options are wrong, so it is part of the behavior.
 */
import type {
  LLMAdmissionClassLimits,
  LLMBulkheadOptions,
} from "../types.js";
import { PROFILES, type LLMBulkheadPreset } from "../profiles.js";
import {
  assertNonNegativeInteger,
  assertOptionalNonNegativeInteger,
} from "../validation.js";
import {
  readAdmissionClassLimits,
  validateAdmissionClassId,
  validateProtectedCapacity,
} from "./class-limits.js";

export type ResolvedOptions = {
  readonly maxQueue: number;
  /** Bulkhead-level queue-wait timeout, applied when a call passes none. */
  readonly timeoutMs: number | undefined;
  readonly initialRevision: number;
  /** Class used when a call omits `admissionClass`. */
  readonly defaultClass: string | undefined;
  /** The fixed class table in construction order; empty without classes. */
  readonly classLimits: ReadonlyMap<string, LLMAdmissionClassLimits>;
};

function resolvePreset(
  profile: LLMBulkheadOptions["profile"],
): LLMBulkheadPreset {
  if (!profile) return {};
  if (typeof profile === "string") return PROFILES[profile];
  return profile;
}

function assertTokenBudgetOptions(opts: LLMBulkheadOptions): void {
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
}

/** Validate the bounded admission-class table, if one was configured. */
function readAdmissionClasses(opts: LLMBulkheadOptions): {
  defaultClass: string | undefined;
  classLimits: Map<string, LLMAdmissionClassLimits>;
} {
  const admissionClassOptions = opts.admissionClasses;
  const classLimits = new Map<string, LLMAdmissionClassLimits>();
  if (admissionClassOptions === undefined) {
    return { defaultClass: undefined, classLimits };
  }
  const defaultClass = validateAdmissionClassId(
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
    classLimits.set(
      id,
      readAdmissionClassLimits(
        rawLimits,
        `admissionClasses.classes[${JSON.stringify(id)}]`,
        opts.tokenBudget !== undefined,
      ),
    );
  }
  if (!classLimits.has(defaultClass)) {
    throw new Error(
      `admissionClasses.defaultClass ${JSON.stringify(defaultClass)} ` +
        `must name a configured class`,
    );
  }
  validateProtectedCapacity(
    classLimits.values(),
    opts.maxConcurrent,
    opts.tokenBudget?.budget,
    "admissionClasses",
  );
  return { defaultClass, classLimits };
}

export function resolveOptions(opts: LLMBulkheadOptions): ResolvedOptions {
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
  assertTokenBudgetOptions(opts);

  // ---- Bounded admission-class configuration ----
  const { defaultClass, classLimits } = readAdmissionClasses(opts);

  return {
    maxQueue,
    timeoutMs,
    initialRevision,
    defaultClass,
    classLimits,
  };
}
