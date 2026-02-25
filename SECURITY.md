# Security Policy

## Supported Versions

Only the latest release receives security fixes.

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |

---

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report privately via GitHub's [Security Advisory](../../security/advisories/new) feature,
or email **security@your-org.example** with:

- A description of the vulnerability
- Steps to reproduce or a minimal proof of concept
- The version(s) affected
- Your assessment of severity and exploitability

You will receive an acknowledgement within **48 hours** and a resolution
timeline within **7 days** of triage.

---

## Threat Surface

This library is a concurrency and admission-control primitive. It holds no
secrets, makes no network calls, and performs no cryptography. Its security
exposure is narrow:

**In scope — please report:**

- Admission bypass: a request is granted a slot despite `maxConcurrent` or
  `tokenBudget.budget` being exceeded, allowing resource exhaustion
- Token budget under-reservation: the estimator systematically reserves far
  fewer tokens than a request consumes, undermining the cost ceiling in a
  way an attacker could exploit deliberately (e.g. via crafted input)
- Denial-of-service via the queue: a caller can cause unbounded memory growth
  or starvation of legitimate requests despite `maxQueue` being set
- Incorrect settle behaviour: a waiter is resolved more than once (ghost
  admission), causing `inFlight` to be miscounted and effective concurrency
  to exceed the configured limit
- Dependency vulnerability: a transitive dependency introduces a CVE that
  affects consumers of this library

**Out of scope — not actionable here:**

- Vulnerabilities in your LLM provider's API or SDK
- The accuracy of token estimation for billing or cost accounting — estimation
  is intentionally approximate and documented as such
- Resource exhaustion caused by misconfiguration (e.g. `maxConcurrent: 10000`)
- Issues in Node.js itself or the JavaScript runtime

---

## Dependencies

`async-bulkhead-llm` has one runtime dependency: `async-bulkhead-ts`.
Both libraries are zero-dependency relative to the broader npm ecosystem.

If a vulnerability is found in `async-bulkhead-ts`, please report it to that
project directly. If the vulnerability affects `async-bulkhead-llm` consumers
and requires a coordinated release, report it here as well.

---

## Disclosure Policy

We follow [responsible disclosure](https://en.wikipedia.org/wiki/Responsible_disclosure).
Once a fix is available we will:

1. Publish a patched release
2. Credit the reporter in the CHANGELOG (unless anonymity is requested)
3. File a GitHub Security Advisory with CVE details where applicable
