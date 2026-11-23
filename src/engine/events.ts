/**
 * Lifecycle event listeners: registration and synchronous delivery.
 *
 * Listeners run inside the bulkhead's own control flow, so an exception
 * from one must never reach the caller that triggered the event.
 */
import type { Listener, LLMEventMap, LLMEventType } from "../types.js";

export function createEventHub() {
  const listeners: { [K in LLMEventType]: Set<Listener<K>> } = {
    admit: new Set(),
    borrowedConcurrencyAbandon: new Set(),
    stop: new Set(),
    reject: new Set(),
    release: new Set(),
    usage: new Set(),
    bypass: new Set(),
    bypassUsage: new Set(),
    bypassRelease: new Set(),
    reconfigure: new Set(),
    dedup: new Set(),
  };

  function emit<K extends LLMEventType>(
    event: K,
    payload: LLMEventMap[K],
  ): void {
    for (const fn of listeners[event]) {
      try {
        fn(payload);
      } catch {
        // listeners must not throw into the bulkhead
      }
    }
  }

  function on<K extends LLMEventType>(
    event: K,
    listener: Listener<K>,
  ): () => void {
    listeners[event].add(listener);
    return () => {
      listeners[event].delete(listener);
    };
  }

  return { emit, on };
}

export type EventHub = ReturnType<typeof createEventHub>;
