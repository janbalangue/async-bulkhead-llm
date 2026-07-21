/**
 * In-flight deduplication internals: the default whole-request key,
 * scope-aware key hashing, single-consumer result detection, and
 * bulkhead-option resolution. Not part of the public API.
 */
import { createHash } from "node:crypto";
import type { LLMBulkheadOptions, LLMRequest } from "./types.js";

export function resolveDedup(opt: LLMBulkheadOptions["deduplication"]): {
  enabled: boolean;
  keyFn: (request: LLMRequest) => string;
  shareResult: ((result: unknown) => unknown) | undefined;
} {
  if (!opt) {
    return { enabled: false, keyFn: defaultDedupKey, shareResult: undefined };
  }
  if (opt === true) {
    return { enabled: true, keyFn: defaultDedupKey, shareResult: undefined };
  }
  return {
    enabled: true,
    keyFn: opt.keyFn ?? defaultDedupKey,
    shareResult: opt.shareResult,
  };
}

/**
 * Shallow detection of single-consumer values that must not be handed
 * to more than one deduplication caller by reference:
 *
 * - Web `ReadableStream` (also matched structurally via `getReader`)
 * - Node streams (`pipe`)
 * - Async iterables (async generators, SDK stream wrappers) — plain
 *   arrays/strings/objects are sync-iterable at most, so they never match
 * - `Response` with a non-null body (`fetch` responses; the body is a
 *   `ReadableStream` and `.json()`/`.text()` can be called once)
 *
 * Deliberately shallow: only the value itself is inspected, never
 * nested properties. False negatives (a stream inside a wrapper
 * object) fall back to today's share-by-reference behavior; false
 * positives are limited to caller types that genuinely advertise
 * stream/iterator protocols.
 */
export function isUnsafeToShare(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<PropertyKey, unknown>;
  if (
    typeof globalThis.ReadableStream === "function" &&
    value instanceof globalThis.ReadableStream
  ) {
    return true;
  }
  if (typeof v["getReader"] === "function") return true;
  if (typeof v["pipe"] === "function") return true;
  if (Symbol.asyncIterator in v) return true;
  if (
    typeof globalThis.Response === "function" &&
    value instanceof globalThis.Response
  ) {
    return value.body !== null;
  }
  return false;
}

/**
 * JSON.stringify with recursively sorted object keys, so structurally
 * identical requests serialize identically regardless of property
 * insertion order.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
      return sorted;
    }
    return v;
  });
}

/**
 * Default deduplication key.
 *
 * v3.4: serializes the **entire request** (stable key order) instead of
 * only `{messages, max_tokens, model}`. The old key silently conflated
 * requests that differed in any other field — e.g. identical messages
 * with `temperature: 0` vs `temperature: 1` shared one call and one
 * response. Missing a dedup opportunity is cheap; serving a response
 * generated under different parameters is a correctness bug, so the
 * default now errs entirely toward non-conflation.
 */
function defaultDedupKey(request: LLMRequest): string {
  try {
    return stableStringify(request);
  } catch {
    return "";
  }
}

/**
 * Derive the map key actually stored for an in-flight entry:
 * `sha256(scope \0 rawKey)`. Hashing bounds per-entry key memory and
 * keeps prompt text out of the dedup map; the `\0` separator prevents
 * scope/key boundary ambiguity ("ab"+"c" vs "a"+"bc").
 */
export function hashDedupKey(scope: string, rawKey: string): string {
  const h = createHash("sha256");
  h.update(scope);
  h.update("\u0000");
  h.update(rawKey);
  return h.digest("hex");
}
