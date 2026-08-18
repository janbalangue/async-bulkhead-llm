---
title: How it compares
---

# How it compares

| Capability / Library | async-bulkhead-llm | LangChain / LlamaIndex | OpenAI SDK (raw) | p-limit / Bottleneck | cockatiel / polly |
|---------------------|--------------------|------------------------|------------------|---------------------|-------------------|
| **Primary goal** | LLM admission control (cost + concurrency) | Orchestration / pipelines | API client | Concurrency / scheduling | Resilience patterns |
| **Fail-fast by default** | ✅ Yes | ❌ No | ❌ No | ❌ No | ⚠️ Depends |
| **Token-aware admission** | ✅ Yes (pre-admission budget) | ❌ No | ❌ No | ❌ No | ❌ No |
| **Token refund (post-call correction)** | ✅ Yes | ❌ No | ❌ No | ❌ No | ❌ No |
| **In-flight token ceiling** | ✅ Yes (`tokenBudget`) | ❌ No | ❌ No | ❌ No | ❌ No |
| **Concurrency limits** | ✅ Yes | ⚠️ Indirect | ❌ No | ✅ Yes | ⚠️ Indirect |
| **Bounded queue (optional)** | ✅ Yes | ⚠️ Internal | ❌ No | ✅ Yes | ⚠️ Indirect |
| **Fail-fast overload handling** | ✅ Core feature | ❌ No | ❌ No | ❌ No | ⚠️ Indirect |
| **Observe/shadow rollout mode** | ✅ Yes | ❌ No | ❌ No | ❌ No | ❌ No |
| **In-flight deduplication** | ✅ Yes | ⚠️ Partial caching | ❌ No | ❌ No | ❌ No |
| **Custom dedup key** | ✅ Yes | ❌ No | ❌ No | ❌ No | ❌ No |
| **Model-aware estimation** | ✅ Yes | ❌ No | ❌ No | ❌ No | ❌ No |
| **Per-request model routing** | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No | ❌ No |
| **Multimodal-aware estimation** | ✅ Yes (text-only counted) | ❌ No | ❌ No | ❌ No | ❌ No |
| **Abort / timeout (admission)** | ✅ Yes | ⚠️ Partial | ⚠️ SDK-level | ⚠️ Partial | ✅ Yes |
| **Event hooks (metrics/logging)** | ✅ Yes | ❌ No | ❌ No | ❌ No | ⚠️ Limited |
| **Graceful shutdown (drain/close)** | ✅ Yes | ❌ No | ❌ No | ❌ No | ❌ No |
| **Retries / fallback** | ❌ No | ⚠️ Yes | ❌ No | ❌ No | ✅ Yes |
| **LLM orchestration (chains/agents)** | ❌ No | ✅ Yes | ❌ No | ❌ No | ❌ No |

## Quick positioning

- **LangChain / LlamaIndex** → *what to run* (orchestration)
- **OpenAI SDK** → *how to call the provider*
- **p-limit / Bottleneck** → *how many tasks run*
- **cockatiel / polly** → *what happens after failure*
- **async-bulkhead-llm** → **whether a request should run at all**

## Rule of thumb

> If you want to **build LLM pipelines**, use LangChain.
> If you want to **keep your service standing under load**, use
> async-bulkhead-llm.

These are complements, not substitutes. A typical stack runs LangChain above
the bulkhead and a retry library around it.

## Key differentiator

> **Most LLM tooling optimizes execution.
> async-bulkhead-llm optimizes survival under load.**

It enforces concurrency ceilings, in-flight token ceilings, and fail-fast
admission before a request ever reaches your provider.

None of that is a cost control. The token budget limits concurrent commitment,
not cumulative spend — see
[Token budget and estimation](token-budget.md).

## What it deliberately does not do

- ❌ No retries
- ❌ No provider SDK — bring your own client
- ❌ No distributed coordination
- ❌ No cost accounting or spend caps — token estimation is for load-shedding only
