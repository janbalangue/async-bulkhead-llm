/**
 * Shutdown: closing admission and waiting for work to finish.
 *
 * `drain()` waits for two things: the concurrency gate to empty, and every
 * admitted call to reach final settlement. The second matters because a
 * call that abandoned its borrowed slot no longer holds one, yet still
 * holds tokens until it releases.
 */
import type { LLMDrainResult } from "../types.js";
import { assertNonNegativeInteger } from "../validation.js";
import type { AdmissionCounts } from "./admission-counts.js";
import type { ConcurrencyGate } from "./shared.js";

export function createShutdown(
  concurrency: ConcurrencyGate,
  counts: AdmissionCounts,
) {
  const llmDrainWaiters = new Set<() => void>();

  /** Wake drain callers once the last admitted call has settled. */
  function settleDrainWaiters(): void {
    if (counts.unsettled() !== 0) return;
    for (const resolve of llmDrainWaiters) resolve();
    llmDrainWaiters.clear();
  }

  function waitForLLMDrain(): Promise<void> {
    if (counts.unsettled() === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      llmDrainWaiters.add(resolve);
    });
  }

  function close(): void {
    concurrency.close();
  }

  function drain(opts?: {
    timeoutMs?: number;
  }): Promise<void> | Promise<LLMDrainResult> {
    const timeoutMs = opts?.timeoutMs;
    const completeDrain = async (): Promise<void> => {
      await Promise.all([concurrency.drain(), waitForLLMDrain()]);
    };
    if (timeoutMs === undefined) {
      return completeDrain();
    }
    assertNonNegativeInteger(timeoutMs, "timeoutMs");
    return new Promise<LLMDrainResult>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const base = concurrency.stats();
        resolve({
          drained: false,
          inFlight: Math.max(base.inFlight, counts.unsettled()),
          pending: base.pending,
        });
      }, timeoutMs);
      void completeDrain().then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ drained: true, inFlight: 0, pending: 0 });
      });
    });
  }

  return { settleDrainWaiters, close, drain };
}

export type Shutdown = ReturnType<typeof createShutdown>;
