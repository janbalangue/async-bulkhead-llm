/**
 * Owner of the admission limits that change at runtime: the limit
 * revision, the token budget, the high-priority reserve, and each class's
 * floors and ceilings.
 *
 * The two concurrency ceilings (`maxConcurrent`, `maxQueue`) live in the
 * concurrency gate; this module installs them there as the last step of
 * one synchronous update. Nothing outside this file writes a limit.
 */
import type {
  LLMAdmissionClassLimits,
  LLMAdmissionLimits,
  LLMApplyLimitsResult,
  LLMPriority,
  TokenBudgetOptions,
} from "../types.js";
import { assertNonNegativeInteger } from "../validation.js";
import {
  readAdmissionClassLimitsUpdate,
  validateAdmissionClassId,
  validateProtectedCapacity,
} from "./class-limits.js";
import type { EventHub } from "./events.js";
import type { ResolvedOptions } from "./options.js";
import type { ConcurrencyGate } from "./shared.js";

/** One class's limits with the protected floors defaulted to 0. */
export type ClassLimits = {
  protectedConcurrent: number;
  maxConcurrent: number | undefined;
  protectedInFlightTokens: number;
  maxInFlightTokens: number | undefined;
};

/** The properties of a caller-supplied limits snapshot, each read once. */
type LimitsRead = {
  revision: number;
  maxConcurrent: number;
  maxQueue: number;
  tokenBudget: LLMAdmissionLimits["tokenBudget"];
  admissionClasses: LLMAdmissionLimits["admissionClasses"];
};

/** A limits snapshot that passed validation and is ready to install. */
type PreparedLimits = {
  revision: number;
  maxConcurrent: number;
  maxQueue: number;
  budget: number | undefined;
  highPriorityReserve: number | undefined;
  classLimits: Map<string, LLMAdmissionClassLimits> | undefined;
};

/** Public shape of one class's limits: unset floors and ceilings are omitted. */
function publicClassLimits(
  state: Readonly<ClassLimits>,
): LLMAdmissionClassLimits {
  return {
    ...(state.protectedConcurrent > 0 && {
      protectedConcurrent: state.protectedConcurrent,
    }),
    ...(state.maxConcurrent !== undefined && {
      maxConcurrent: state.maxConcurrent,
    }),
    ...(state.protectedInFlightTokens > 0 && {
      protectedInFlightTokens: state.protectedInFlightTokens,
    }),
    ...(state.maxInFlightTokens !== undefined && {
      maxInFlightTokens: state.maxInFlightTokens,
    }),
  };
}

/**
 * Read each externally supplied property once. This prevents accessor
 * objects from returning one value during validation and another during
 * installation.
 */
function readLimits(next: LLMAdmissionLimits): LimitsRead {
  const revision = next.revision;
  const maxConcurrent = next.maxConcurrent;
  const maxQueue = next.maxQueue;
  const tokenBudget = next.tokenBudget;
  const admissionClasses = next.admissionClasses;

  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("limits.revision must be a non-negative safe integer");
  }
  return { revision, maxConcurrent, maxQueue, tokenBudget, admissionClasses };
}

/** Validate a snapshot that was already read, without changing anything. */
function validateLimits(
  read: LimitsRead,
  budget: TokenBudgetOptions | undefined,
  classIds: readonly string[] | undefined,
): PreparedLimits {
  const { revision, maxConcurrent, maxQueue } = read;
  const nextTokenBudget = read.tokenBudget;

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

  const classLimits = readAdmissionClassLimitsUpdate(
    read.admissionClasses,
    classIds,
    budget !== undefined,
  );
  if (classLimits !== undefined) {
    validateProtectedCapacity(
      classLimits.values(),
      maxConcurrent,
      nextBudget,
      "limits.admissionClasses",
    );
  }

  return {
    revision,
    maxConcurrent,
    maxQueue,
    budget: nextBudget,
    highPriorityReserve: nextHighPriorityReserve,
    classLimits,
  };
}

/**
 * The per-class half of the limits: each class's floors and ceilings,
 * keyed by class id. The class keys are fixed at construction; only the
 * numbers change, and only through `install`.
 */
function createClassLimitTable(config: ResolvedOptions) {
  const defaultClass = config.defaultClass;
  const table = new Map<string, ClassLimits>();
  for (const [id, limits] of config.classLimits) {
    table.set(id, {
      protectedConcurrent: limits.protectedConcurrent ?? 0,
      maxConcurrent: limits.maxConcurrent,
      protectedInFlightTokens: limits.protectedInFlightTokens ?? 0,
      maxInFlightTokens: limits.maxInFlightTokens,
    });
  }
  const ids: readonly string[] = [...table.keys()];

  function protectedConcurrentTotal(): number {
    let total = 0;
    for (const state of table.values()) {
      total += state.protectedConcurrent;
    }
    return total;
  }

  function protectedTokensTotal(): number {
    let total = 0;
    for (const state of table.values()) {
      total += state.protectedInFlightTokens;
    }
    return total;
  }

  /**
   * Resolve the class a call belongs to, as its id. `undefined` means the
   * bulkhead has no classes; a class named without a table, or a name
   * outside the table, is a configuration error and throws.
   */
  function resolve(requested: string | undefined): string | undefined {
    if (defaultClass === undefined) {
      if (requested !== undefined) {
        throw new Error(
          "admissionClass requires admissionClasses to be configured",
        );
      }
      return undefined;
    }
    const id =
      requested === undefined
        ? defaultClass
        : validateAdmissionClassId(requested, "admissionClass");
    if (!table.has(id)) {
      throw new Error(`unknown admissionClass ${JSON.stringify(id)}`);
    }
    return id;
  }

  function snapshot():
    | Readonly<Record<string, LLMAdmissionClassLimits>>
    | undefined {
    if (defaultClass === undefined) return undefined;
    const entries: Array<[string, LLMAdmissionClassLimits]> = [];
    for (const [id, state] of table) {
      entries.push([id, Object.freeze(publicClassLimits(state))]);
    }
    return Object.freeze(Object.fromEntries(entries));
  }

  /**
   * Replace every class's numbers with an already validated snapshot. The
   * records are updated in place, so a read-only view handed out by `get`
   * stays current.
   */
  function install(next: Map<string, LLMAdmissionClassLimits>): void {
    for (const [id, nextLimits] of next) {
      const state = table.get(id)!;
      state.protectedConcurrent = nextLimits.protectedConcurrent ?? 0;
      state.maxConcurrent = nextLimits.maxConcurrent;
      state.protectedInFlightTokens =
        nextLimits.protectedInFlightTokens ?? 0;
      state.maxInFlightTokens = nextLimits.maxInFlightTokens;
    }
  }

  return {
    defaultClass,
    ids,
    get: (id: string): Readonly<ClassLimits> => table.get(id)!,
    publicLimit: (id: string): LLMAdmissionClassLimits =>
      publicClassLimits(table.get(id)!),
    protectedConcurrentTotal,
    protectedTokensTotal,
    resolve,
    snapshot,
    install,
  };
}

export function createLimits(
  config: ResolvedOptions,
  /** `tokenBudget` as supplied. Token accounting is on when it is set. */
  budget: TokenBudgetOptions | undefined,
  concurrency: ConcurrencyGate,
  events: EventHub,
) {
  const classes = createClassLimitTable(config);

  /** Current versioned admission-limit state. */
  let currentRevision = config.initialRevision;
  let currentBudget: number | undefined = budget?.budget;
  let currentHighPriorityReserve = budget?.highPriorityReserve ?? 0;

  /**
   * Budget ceiling applicable to a request at the given priority.
   *
   * Construction validates `0 <= highPriorityReserve <= budget` — that
   * check catches config typos once, at startup. It intentionally does
   * *not* run again here.
   *
   * `apply()` or `setBudget()` can lower `currentBudget` below
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

  /** Return a detached snapshot of the currently applied limits. */
  function snapshot(): LLMAdmissionLimits {
    const base = concurrency.stats();
    const admissionClasses = classes.snapshot();
    const current: LLMAdmissionLimits = {
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
      ...(admissionClasses !== undefined ? { admissionClasses } : {}),
    };
    return Object.freeze({
      ...current,
      ...(current.tokenBudget
        ? { tokenBudget: Object.freeze({ ...current.tokenBudget }) }
        : {}),
      ...(current.admissionClasses
        ? { admissionClasses: current.admissionClasses }
        : {}),
    });
  }

  /**
   * Apply a complete, higher-revision limits snapshot as one synchronous
   * step: validate everything, then install everything, then let the
   * concurrency gate admit queued waiters. A stale revision changes
   * nothing. The public contract is documented on `applyLimits()`.
   */
  function apply(next: LLMAdmissionLimits): LLMApplyLimitsResult {
    const read = readLimits(next);
    // A stale snapshot is refused before the rest of it is validated.
    if (read.revision <= currentRevision) {
      return {
        applied: false,
        reason: "stale_revision",
        current: snapshot(),
      };
    }
    const prepared = validateLimits(
      read,
      budget,
      classes.defaultClass === undefined ? undefined : classes.ids,
    );

    const previous = snapshot();

    // Install every LLM-layer value before pumping the concurrency queue.
    // Promise continuations from admitted waiters run only after this
    // synchronous operation returns, so they observe one coherent revision.
    currentRevision = prepared.revision;
    if (budget) {
      currentBudget = prepared.budget!;
      currentHighPriorityReserve = prepared.highPriorityReserve!;
    }
    if (prepared.classLimits !== undefined) {
      classes.install(prepared.classLimits);
    }
    concurrency.applyLimits({
      maxConcurrent: prepared.maxConcurrent,
      maxQueue: prepared.maxQueue,
    });

    const current = snapshot();
    events.emit("reconfigure", { previous, current });
    return { applied: true, previous, current };
  }

  /**
   * Budget-only setter, implemented as a complete local reconfiguration
   * at `currentRevision + 1` so it goes through the same single step as
   * `apply()`.
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
    const current = snapshot();
    apply({
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

  return {
    /** Class used when a call omits `admissionClass`. */
    defaultClass: classes.defaultClass,
    /** The fixed class table, in construction order. */
    classIds: classes.ids,
    /** Read-only view of one class's current limits. */
    classLimit: classes.get,
    /** One class's limits in their public shape. */
    publicClassLimit: classes.publicLimit,
    revision: (): number => currentRevision,
    /** Current budget ceiling; `undefined` when no token budget is configured. */
    budget: (): number | undefined => currentBudget,
    highPriorityReserve: (): number => currentHighPriorityReserve,
    effectiveBudget,
    protectedConcurrentTotal: classes.protectedConcurrentTotal,
    protectedTokensTotal: classes.protectedTokensTotal,
    resolveClass: classes.resolve,
    snapshot,
    apply,
    setBudget,
  };
}

export type Limits = ReturnType<typeof createLimits>;
