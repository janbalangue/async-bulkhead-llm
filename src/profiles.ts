/** Opinionated option presets (`profile: "interactive" | "batch"`). */
// ────────────────────────────────────────────
// Profile / preset
// ────────────────────────────────────────────

export type LLMBulkheadPreset = {
  maxQueue?: number;
  timeoutMs?: number;
};

/**
 * Built-in presets for common deployment patterns.
 * Explicit options always override preset defaults.
 */
export const PROFILES: Record<"interactive" | "batch", LLMBulkheadPreset> = {
  interactive: { maxQueue: 0 },
  batch: { maxQueue: 20, timeoutMs: 30_000 },
};
