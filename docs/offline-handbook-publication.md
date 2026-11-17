# Explicit offline publication harness

This controller-owned opt-in class bridges natural-message research claims to the existing synchronous ControlState.publish, without changing state.ts, contracts, worker behavior, service routes or defaults. It accepts only trusted offline model/transport doubles and requires explicit configuration of OFFLINE_HANDBOOK_SOURCE.

The user-visible source is **Synthetic Handbook comparison fixture (not fetched)** at **https://fixtures.invalid/handbook/comparison**, with synthetic-fixture evidence and an explicit no-live-web/no-external-model limitation. Internal receipt metadata about the fixed collector URL is never published or treated as public-source attestation. The mapper accepts exactly one verified excerpt equal to the controller-configured constant, never a model-provided source ID, title, URL or route.

Natural group chat → real participation decision/claim → background fixture preparation → fresh controller admission → existing atomic same-thread publication is tested with a numbered two-point mock summary. This is an offline harness, not an automatically registered production workflow or real-source end-to-end integration.

## Concurrency and failure

Each bridge caches at most128 run attempts, including failed attempts. It never evicts/reopens attempts and seals new work on exhaustion. Same-run concurrent calls share preparation; all successful callers pass current authorization and reach existing controller resultKeys idempotency. An aborted secondary waiter does not cancel the original caller's authorized work. Cancellation of the originating attempt fails all waiters. Grants/revisions and current work are checked again before the synchronous publication call, which performs its own checks. No await separates this check from the commit.

A newly constructed/restarted bridge rejects already-recorded runs before collection. Existing control reads can retrieve the persisted message; this bridge does not reconstitute receipt authority or silently rerun a completed job. Unpublished interrupted work still relies on existing controller run reconciliation and must not be automatically replayed by an integrator.

Tests cover exact fixture mapping/mismatch, grant revoke before commit and after cached success, edit, abort, wrong actor, concurrent/later retry, bridge restart, and unchanged existing synthetic publication.

## Remaining boundary

No changes to PR45 files: new control/offline-handbook.ts, test/offline-handbook-publication.test.ts and this doc only, atop the separate preparation seam/fix commits. Rebase and run cross-branch tests after PR45. Public-source receipt persistence, safe HTML extraction, explicit evidence-policy contracts and atomic live-evidence publication remain separate work described in handbook-preparation.md. Do not wire a real transport/model into this fixture mapper or imply official evidence verification.
