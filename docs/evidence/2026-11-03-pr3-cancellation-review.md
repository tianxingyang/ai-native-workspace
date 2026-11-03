# PR #3 cancellation review regression

Review: https://github.com/tianxingyang/ai-native-workspace/pull/3#discussion_r4452364200

Baseline: `d436c95ed33bb061c459c8acdddf5486be493fc9`. The cancellation endpoint returns only a status and published receipt identifier. Replacing a cached Run with that acknowledgement removed its source-message association and execution events.

The client now applies the acknowledged status/receipt to the existing Run, renders immediately, and retains identity and evidence. Snapshots started before an acknowledgement are discarded and retried by the normal polling loop. A delayed cancellation acknowledgement also preserves a terminal state already observed by polling.

## Validation (2026-11-03 UTC)

Windows, Node 24.14.0, npm 11.9.0, Playwright 1.58.2 with the existing Chromium installation. Tests use disposable local HTTP/SQLite and fake/mock workers; no real model or deployed service was used.

- Before the fix, both new refresh-failure/in-flight-poll regressions failed because the source-associated task card was missing (2/2 reproduced).
- After the fix, those two targeted regressions passed (2/2).
- Complete `npm test`: 46/46 passed, including TypeScript build (08:35 UTC).
- Complete `npm run test:browser`: 11/11 passed, including TypeScript build (08:35–08:36 UTC). This includes the original eight scenarios plus refresh failure, a stale in-flight poll, and a delayed acknowledgement after the stopped receipt arrives.
- `npm run check:web` and `git diff --check`: passed.

The regressions check that the card retains its original run/source identity, cancellation acceptance remains distinct from confirmed stopping, stale polling does not roll back cancellation, reconnection restores the real stopped evidence, and delayed acknowledgements preserve observed terminal evidence without page errors.

Browser tests required execution outside the sandbox because its Chromium localhost requests returned `ERR_NETWORK_ACCESS_DENIED`; `PLAYWRIGHT_BROWSERS_PATH` selected the already installed browser. An interrupted dependency install was confirmed failed before retrying successfully. Neither failure is counted as a product regression result.

Dependency versions and lockfile are unchanged. No changes from the parallel PR #2/#4/#5 fixes are included. Their eventual stack integration must preserve this client behavior and rerun the relevant suites.
