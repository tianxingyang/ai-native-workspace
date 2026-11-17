# Offline Handbook preparation bridge

This opt-in, dormant seam joins the fixed Handbook collector and receipt ledger to a host-owned local mock model. It has no production factory, external model, public route, publisher, default network transport or automatic registration. Dependencies must be trusted offline doubles. The mode label is not a sandbox: never inject networked model/transport implementations into this fixture harness.

Tests create a natural group-chat request, use real participation and ControlState claim/currentRun admission, then prepare bound excerpts in the background. The local mock sees only fixture text and a random receipt ID, not tenant messages, work IDs, grant details or routing. Current controller authorization is checked before collection, before recording, after model completion and before returning. Timeout, cancellation, changed context, invalid claims and failed extraction produce no prepared output. Receipts are retired after every attempt. The total deadline includes collection and model waiting; a non-cooperative injected model cannot be forcibly terminated, but its late output cannot escape the aborted pipeline.

Output is explicitly **offline-handbook-fixture / prepared-not-published**, not ResearchResult. Existing synthetic publication validator rejects it. Citation verification is exact-substring integrity, not semantic truth. Extractor injection is a local pure function seam, not a completed safe HTML extraction implementation.

## Required next integration, after PR45

Do not bypass the current validator or relabel official URLs as synthetic fixtures. These changes need a new reviewed state/contract slice after PR45 lands:
1. Extend contracts.ts with a separate controller-owned verified-evidence variant and explicit per-run evidence policy. Existing WorkPackage synthetic-only constraints stay default. Allow exactly the fixed document under opt-in host policy; no URL field or network tool given to the model.
2. In control/state.ts own collection/admission/ledger lifecycle. Add an atomic publish method that rechecks read/send grants, run/source/context revisions and route, verifies ledger claims, then commits through existing resultKeys idempotency, message storage, event/audit and invalidation paths. Never accept a prepared object, arbitrary receipt metadata or worker-provided URL as authoritative.
3. Keep ledger verification valid through that atomic commit; this offline harness currently retires receipts on return and is intentionally not a publication token. Persist provenance/recovery rules or reject all outstanding receipts after restart.
4. In worker context/runtime tooling add only a typed fixed-source request/claim submission. Preserve budgets, cancellation and PR45 private-process constraints. Route is always copied from current control-owned work.
5. Extend rendering and persistence validators for the new variant, visibly distinguishing fixture, fetched source and limitations. Add hermetic full message→background→atomic publication tests, concurrent retry, grant revoke, membership/source/context edits, abort and restart regressions. Existing fixtures must remain unchanged.
6. Separately authorize and test live transport and safe HTML extraction. No live/paid model or tenant-data transmission is approved by this code.

Files potentially conflicting with PR45: contracts.ts, control/state.ts, worker/runtime.ts, worker/context-compiler.ts and private configuration. This slice changes none of them. A separate-files-only adapter cannot safely remove the atomic publication gap because publication authority/idempotency are private controller state. Sequence PR45 first, rebase this seam, then implement the reviewed contract/state integration.
