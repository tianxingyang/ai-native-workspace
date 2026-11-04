# Message invalidation increment — 2026-11-04

Base: `f0c1582c8cffe80ccb701e749b47200606e78547` (PR #6).

The increment connects authenticated, versioned message edits/retractions to durable thread context invalidation, stale output fences, cancellation reconciliation and replacement sessions. See [behavior and API boundaries](../message-changes.md).

## Validation

- Node 24.14.0: TypeScript build and all **87 backend/integration tests passed**.
- Chromium/Playwright 1.58.2: all **29 browser tests passed**. Added flows cover editing a running task, retracting published output, lost edit responses, concurrent version conflicts, and clearing the editor when its room loses read access. The final capability-copy adjustment also received the three targeted edit/retract browser checks.
- Rust: **3 unit tests passed**, including updated native route allowlist rejection cases. `cargo fmt --check`, web syntax and diff whitespace checks passed. Rust tests used an ignored, explicitly labeled resource placeholder because a full desktop bundle was not prepared. This does not constitute installer or installed-WebView acceptance.
- Visual inspection: the edit dialog, focus, action labels and updated capability copy were checked in the local browser capture. Captures are ignored local evidence, not published credentials or user data.

The first sandboxed HTTP test attempt failed because loopback connects were denied. The final above run used local synthetic services with working loopback access. No live models or external research calls were made.

## Independent review

An independent reviewer found and then verified fixes for three issues:

1. Completed runtime output could reveal withdrawn text through run APIs. Public stale-run views now filter content-bearing event data while retaining the internal replay ledger and stop evidence.
2. A removed room could make editor authorization fall back to another room. The editor now explicitly verifies its original room exists and still permits reading, then clears on loss.
3. New research requests during stop reconciliation could lose their intent. They now persist as queued work, while execution remains fenced until stale runs settle.

The reviewer independently reproduced the output filtering and queued-work gates and reported no remaining actionable findings in the corrected source diff. Final commit identity is recorded with the pull request.

## Limits

This is an engineering increment for VIT-109, not completion of the entire issue. Online membership/revocation management APIs, separate goal-edit semantics, search/index/long-term-summary deletion propagation and real-model/cross-device acceptance remain open. Internal audit/replay records are not physically erased. Existing external side effects cannot be undone by retraction. No deployment, real permission/network change, GitHub Approve review, license change or installer publication is included.
