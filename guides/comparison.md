---
title: How it compares
---

# How it compares

`async-bulkhead-llm` answers one question: **should this request run right
now, given the work this process already has in flight?** Most tools you may
already use answer a different question. This page says which question each
kind of tool answers, where it overlaps with this library, and where it does
more.

Other projects are described from their own public documentation as of
November 2026, and each one links to the page the description comes from.
They change quickly. If something here is out of date, please
[open an issue](https://github.com/janbalangue/async-bulkhead-llm/issues).

## At a glance

| Kind of tool | The question it answers | What this library adds |
|---|---|---|
| Concurrency limiters: p-limit, p-queue, Bottleneck, cockatiel | How many calls run at once? | Request size, as a second limit alongside the count |
| LLM rate limiters: ai-sdk-rate-limiter, `@aid-on/llm-throttle` | How many requests and tokens may start per minute? | A ceiling on work in flight, which a per-minute window does not bound |
| AI gateways: LiteLLM, Kong, Azure API Management, Agent Router, Portkey, Telnyx, Gravitee | Who may use how many tokens per window, across the fleet? | A size-aware decision made in-process, inside the gateway or the service behind it |
| Inference schedulers: llm-d, GKE Inference Gateway, vLLM | Which waiting request does a model server take next? | Nothing on the server side. It bounds what one calling service sends |
| Provider service tiers: Amazon Bedrock, OpenAI | How does the provider treat a request it has received? | The decision not to send it |
| Orchestration frameworks, provider SDKs, retry libraries | What to run, how to call it, and what to do after it fails | Whether it should run at all |

These are complements more often than substitutes. A typical stack runs an
orchestration framework above the bulkhead, a retry library around it, and a
gateway or a provider quota beyond it.

## Per-minute limits and in-flight limits

Most of the tools below limit a **rate**: requests or tokens per minute. This
library limits **work in flight**: the calls and reserved tokens that are
open at the same moment. They are different controls.

- A per-minute limit bounds how much work *starts* in a window. When a
  provider slows down, calls stay open longer, the window keeps admitting new
  ones, and the work in flight grows. That is the overload case this library
  is built for.
- An in-flight limit does not keep you under a provider's tokens-per-minute
  quota, and it is not a spend cap. If a quota or a budget is what you need
  to enforce, use a rate limiter or a gateway.

Many services want both: a window limit for the quota, and a bulkhead for
overload.

## Concurrency limiters

| | async-bulkhead-llm | p-limit, p-queue | Bottleneck | cockatiel |
|---|---|---|---|---|
| Caps calls in flight | Yes | Yes | Yes | Yes, `bulkhead` |
| Counts a call by its size | Yes, in tokens | — | By hand, with job `weight` | — |
| When the cap is reached | Rejects. A bounded queue is opt-in | Waits | Waits. Drops by strategy once `highWater` is set | Rejects, after an optional bounded queue |
| Per-minute rate limits | No | p-queue: tasks per interval | Yes, `minTime` and `reservoir` | — |
| Classes of traffic | Protected floors and ceilings per class | p-queue: priority order | Priority order | — |
| Shared across processes | No, per process by design | — | Yes, Redis | — |

In this table and the next, "—" means the project's documentation does not
describe it.

[p-limit](https://www.npmjs.com/package/p-limit) and
[p-queue](https://www.npmjs.com/package/p-queue) cap how many calls run at
once, and calls beyond the cap wait. Neither documents a bound on the waiting
queue. For a service taking live traffic, an unbounded queue turns a provider
slowdown into callers that wait a long time to fail.

[Bottleneck](https://www.npmjs.com/package/bottleneck) is the closest
general-purpose tool. A job's `weight` counts against `maxConcurrent`, so
passing a token estimate as the weight approximates a size-aware limit, and
`highWater` with a drop strategy bounds the queue. This library adds what is
specific to LLM calls: the estimate itself, refunds from reported usage, a
call limit and a token limit in the same decision, and admission classes.

[cockatiel](https://www.npmjs.com/package/cockatiel) has the same pattern by
count: `bulkhead(limit, queue)` runs `limit` calls, queues `queue` more, and
throws `BulkheadRejectedError` beyond that. It also provides retry, circuit
breaker, timeout, and fallback policies, which this library does not. Use
them together: cockatiel's retry and circuit breaker go around the bulkhead.

## LLM rate limiters

| | async-bulkhead-llm | ai-sdk-rate-limiter | `@aid-on/llm-throttle` |
|---|---|---|---|
| What it limits | Calls and tokens in flight | Requests, input tokens, and output tokens per minute. Optionally, calls in flight | Requests and tokens per minute |
| Sizes a request for you | Yes: per-model input estimate plus `max_tokens` | Yes: input estimate from the prompt text | No, the caller supplies it |
| Corrects to actual usage | Yes, at release and mid-stream | Yes, after the response | Yes, when the caller reports it |
| When a limit is reached | Rejects. A bounded queue is opt-in | Queues | Rejects |
| Classes of traffic | Protected floors and ceilings per class | Priority order, per-tenant windows | — |
| Shared across processes | No, per process by design | Yes, Redis for the window counters | — |

[ai-sdk-rate-limiter](https://www.npmjs.com/package/ai-sdk-rate-limiter)
wraps the Vercel AI SDK and several provider SDKs. It tracks requests, input
tokens, and output tokens per model in a 60-second sliding window. It
reserves an input estimate before each call, replaces it with actual usage
afterward, and queues calls that do not fit. It also has per-tenant scopes
and a Redis store that shares the window counters between processes.

[`@aid-on/llm-throttle`](https://www.npmjs.com/package/@aid-on/llm-throttle)
is a token-bucket limiter for requests and tokens per minute. The caller
supplies the token estimate and later adjusts it to actual usage. A call that
does not fit is refused at once.

Reach for one of those two when the goal is to stay under a provider's
published per-minute limits. Reach for this library when the goal is to shed
load before a slow provider turns into a pile of open calls. They stack: the
rate limiter decides whether the quota allows the call, and the bulkhead
decides whether the service can afford one more.

Beyond these tables, this library also has typed rejection reasons with a
capacity snapshot, limit changes at runtime under a revision number
([Runtime limits and reconfiguration](runtime-limits.md)), an
[observe mode](observe-mode.md) for measuring a policy before enforcing it,
in-flight [deduplication](deduplication.md), `close()` and `drain()` for
shutdown, and an opt-in policy for
[stopping admitted work](stopping-admitted-work.md).

## AI gateways

A gateway sits in the request path for many services and attaches limits to
keys, teams, and tenants. Its token limits are per window:

| Gateway | Token limits | Is a request sized before it is sent? |
|---|---|---|
| [LiteLLM](https://docs.litellm.ai/docs/proxy/users) | Tokens and requests per minute, per key, team, user, and model. A `max_parallel_requests` setting. With an Enterprise license, [priority reservations](https://docs.litellm.ai/docs/proxy/dynamic_rate_limit) that lend idle capacity | Yes for standard token limits: reserved before the call and reconciled after. Priority reservations record tokens after each response |
| [Kong AI Gateway](https://developer.konghq.com/plugins/ai-rate-limiting-advanced/) | Tokens or cost per window, with counters kept locally, in Kong's data store, or in Redis | No. Counted from the provider's response, so concurrent requests can exceed the limit |
| [Azure API Management](https://learn.microsoft.com/azure/api-management/llm-token-limit-policy) | Tokens per minute and token quotas, per counter key | Prompt tokens can be estimated first. Concurrent requests can temporarily exceed the limit |
| [Agent Router](https://theagentrouter.ai/docs/capabilities/traffic/usage-based-ratelimiting) (formerly Envoy AI Gateway) | Token budgets per window, with counters in Redis | No. Charged after the response completes |
| [Portkey](https://portkey.ai/docs/product/ai-gateway/virtual-keys/rate-limits) (now Prisma AIRS AI Gateway) | Requests or tokens per minute, hour, or day, per provider | Not documented |
| [Telnyx AI Gateway](https://developers.telnyx.com/docs/inference/ai-gateway/controls) | Tokens and requests per rolling minute, budgets, and a `max_parallel_requests` cap | Yes. Reserves an upper bound from input size and output allowance, then settles to actual cost |
| [Gravitee](https://documentation.gravitee.io/agent-management/build/llm-proxies/configure-an-llm-proxy/design/add-the-token-rate-limit-policy) | Tokens per rolling or calendar period | Optional. A fixed or adaptive reservation, reconciled after the response |

What a gateway does that this library does not: limits shared across
replicas, limits attached to an identity, spend budgets, and routing and
fallback between providers.

What this library adds, inside a gateway you build or in a service behind
one:

- **A ceiling on tokens in flight.** The limits above are per window. LiteLLM
  and Telnyx also cap in-flight requests by count. None of the pages linked
  above describes a ceiling on tokens committed at the same moment. Here a
  request reserves an input estimate plus its full `max_tokens` before it
  runs. See [Token budget and estimation](token-budget.md).
- **A decision made in-process.** Admission is checked against local state
  before any bytes leave your service. No counter store sits on the request
  path.
- **Reservations that shrink while a stream runs.** `reportUsage()` can
  release the part of a reservation a stream no longer needs before the call
  ends. See [Streaming and reconciliation](streaming.md).
- **Protected capacity per class.** Floors and ceilings apply to both slots
  and tokens, and an opt-in policy can stop admitted work to restore a floor.
  See [Admission classes](admission-classes.md). LiteLLM's priority
  reservations are the nearest equivalent, for per-minute rates.

This library does not replace a gateway. It is designed to sit inside one:
see [Gateway integration](gateway-integration.md). Bulkheads are per process,
so with several replicas you partition the limits per replica or coordinate
above this layer.

## Inference schedulers

If you run the model servers yourself, the scheduler in front of them can see
what a caller cannot: the queue and KV-cache pressure on each replica.

- **llm-d flow control** holds requests in a queue at its endpoint picker and
  releases them by priority band, with fairness between tenants inside a
  band. Dispatch is gated on a saturation signal built from model-server
  queue and KV-cache pressure. Red Hat
  [describes it](https://developers.redhat.com/articles/2026/08/27/llm-d-flow-control-priority-queuing-for-shared-gpu-inference)
  as generally available in Red Hat AI Inference 3.5, and Google's
  [GKE Inference Gateway](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/about-gke-inference-gateway)
  is built on the llm-d Router.
- **vLLM** can order its own queue by a per-request priority instead of
  arrival order. See its
  [scheduler configuration](https://docs.vllm.ai/en/latest/api/vllm/config/scheduler.html).

This library has no view of a model server. For a pool you host, use a
scheduler that does. A bulkhead in each calling service still bounds what
that service sends. In front of a hosted provider there is no server-side
scheduler you control, so the caller's side is where admission has to happen.

DataRobot has also
[announced TokenGrid](https://www.datarobot.com/blog/llm-inference-rate-limiting-tokengrid/),
a token-aware capacity scheduler that sits in the admission path alongside
existing gateways. It was in private preview as of August 2026.

## Provider service tiers

Providers sell different treatment for the requests they receive.
[Amazon Bedrock](https://aws.amazon.com/bedrock/service-tiers/) has Priority,
Standard, Flex, and Reserved tiers, and during high traffic it processes Flex
requests after Standard ones. OpenAI has
[Flex processing](https://developers.openai.com/api/docs/guides/flex-processing),
which is cheaper and can return a `429 Resource Unavailable` error when
capacity is short, and
[Fast mode](https://developers.openai.com/api/docs/guides/priority-processing)
(called priority processing until July 2026), which is faster at a per-token
premium.

A tier changes what happens to a request after the provider has it. It does
not stop your service from sending more than it can afford to have open. The
two work well together: send a background admission class to a cheaper tier,
and keep a protected floor for interactive traffic. See
[Admission classes](admission-classes.md).

## Frameworks, SDKs, and retry libraries

- **Orchestration frameworks** such as LangChain and LlamaIndex decide what
  to run. Put the bulkhead around the model call they make.
- **Provider SDKs** make the call. Check what yours does on failure: the
  OpenAI Node SDK [retries](https://github.com/openai/openai-node#retries)
  rate-limit, timeout, and server errors twice by default, and under overload
  those retries add load. A rejection from the bulkhead happens before the
  SDK is called, so the SDK never retries it.
- **Retry and resilience libraries** decide what happens after a failure.
  Compose them around the bulkhead, not inside it.

## Rule of thumb

- To stay under a provider's per-minute quota, use a rate limiter or your
  gateway's token limits.
- To share limits across keys, teams, and replicas, use a gateway.
- To schedule a pool of model servers you host, use llm-d or the engine's own
  scheduler.
- To keep one service standing when a provider slows down, use this library,
  alone or underneath any of the above.

It enforces concurrency ceilings, in-flight token ceilings, and fail-fast
admission before a request ever reaches your provider. None of that is a cost
control. The token budget limits concurrent commitment, not cumulative
spend. See [Token budget and estimation](token-budget.md).

## What it deliberately does not do

- ❌ No retries
- ❌ No provider SDK — bring your own client
- ❌ No distributed coordination
- ❌ No cost accounting or spend caps — token estimation is for load-shedding only
