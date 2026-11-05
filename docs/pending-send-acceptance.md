# VIT-126: pending-send recovery acceptance

## Scope and evidence boundary

This acceptance builds on PR #32, merged as `fd260832783e32e22556bd00c531198c5da1053b`. It covers **one committed, unconfirmed send per conversation** in the same origin/browser profile, reauthenticated with the same still-authorized credential. Explicit retry uses the original ID, text, reply and text attachment. Receipt lookup never automatically resends a missing message.

The guarantee begins when IndexedDB commits the encrypted intent. Closing or crashing before that point can lose the unsaved composer contents, but cannot transmit that attempt. Clearing browser data, losing the profile or losing authorization can make an intent unrecoverable. This is not a guarantee to deliver every click on Send regardless of storage or permissions.

The tests use disposable local mock services and fake providers. There are no real model calls, real configuration changes or deployment steps. Chromium reload is exercised in the application; service restart is exercised separately against persisted SQLite state. These are complementary layers, not an installed WebView/process-crash or power-loss certification.

## Fault matrix

The test names below are searchable evidence in the linked source files. Existing PR #32 cases are retained; VIT-126 adds only gaps in the application interruption/cleanup and server restart matrix.

| Failure or transition | Required behavior | Automated evidence |
| --- | --- | --- |
| Reload before encryption/save commits | No POST, no stored intent, no recovered draft | New browser case `reload before the durable save commits sends nothing and does not promise draft recovery` |
| Reload after durable commit but before POST | Original ID/text restored; missing receipt remains unknown; manual receipt check sends nothing; explicit retry creates exactly one message | New browser case `reload after durable commit but before POST recovers the original id and waits for explicit retry` |
| POST fails before reaching service | Stored ciphertext survives reload; retry request equals the initial request exactly | Browser `encrypted unsent intent survives reload and only an explicit retry sends it` |
| Service accepts POST but response is lost | Reconnect checks receipt, displays current edited state, clears pending entry; no second POST | Browser `accepted send with lost response recovers its current receipt after reload without another POST` |
| Reply plus text attachment interrupted | Retry retains ID, body, reply target, attachment name/content and scope/membership/epoch fields | Browser `a recovered attachment and reply retain the original send identity` |
| Accepted reply/attachment, local acknowledgement deletion fails | Reload checks the existing receipt and eventually removes ciphertext; exactly one reply remains, attachment bytes unchanged | New browser case `accepted reply attachment survives failed local acknowledgement cleanup without a second message` |
| Normal service restart after successful send | Epoch/key retained, receipt retained, identical retry deduplicated | Server `ordinary restart preserves recovery binding and an uncertain successful send deduplicates` |
| Normal service restart before sending a prepared reply/attachment, then again after acceptance | Missing receipt stays missing until explicit POST; key/epoch/generation unchanged; accepted receipt and complete payload survive restart, retry deduplicated | New server case `an unsent reply attachment keeps its recovery binding across restart and deduplicates after acceptance` |
| Browser storage unavailable, crypto failure or capacity exhausted | Save rejects; application does not transmit; expired entries may be reclaimed | Browser `storage failure stops HTTP transmission and retains an honest pending state`; store `unavailable IndexedDB or encryption rejects saving without a silent memory fallback`, `storage capacity is bounded and expired entries are reclaimed before inserting a new slot` |
| Server storage fails | Message/receipt and epoch mutation roll back; later retry can succeed once | Server `failed storage writes roll back epoch changes and message receipts without changing the recovery key` |
| Two windows save different IDs; same ID changes payload | Transactional conflict; no overwrite; exact same-ID retries may share one slot | Store `two browser tabs cannot overwrite one another and exact concurrent retries recover safely`, `a pending id and payload are immutable; removal only accepts the matching operation` |
| Old cleanup overlaps a replacement | Conditional deletion preserves another instance's replacement | Store `bad-record cleanup cannot delete another tab replacement written while decryption was pending`, `forget only clears an observed row and delayed cleanup preserves a newly connected instance intent` |
| Send permission lost, read remains | Recovery and receipt lookup allowed; retry unavailable; held-save completion displays unconfirmed state, no POST | Browser `send permission loss still permits recovery and receipt checking but never automatic resend`, `send loss during a held save exposes receipt checking immediately even when sync is offline`; server deadline test |
| Read permission lost | Scope disappears; observed ciphertext cleanup attempted; other scopes remain usable | Browser `read revocation clears an observed record while other conversations remain usable`; server `recovery access follows read and credential deadlines while expired send still permits receipt lookup` |
| Credential shortened/expired, synchronization offline | Current server deadline clears observed content; expired credentials rejected by API | Browser `a shorter credential deadline clears observed pending content even while offline`; server deadline test |
| Credential/actor/scope changes; member removed/rejoined | Recovery material isolated; old member generation rejected | Browser `another credential cannot restore the encrypted intent, while the original credential still can`, `membership replacement cannot restore the old-generation encrypted send`; server binding and rejoin tests |
| Backup restore | Epoch/key rotate; old-epoch sends rejected before deduplication | Server `restored backup rotates recovery binding and refuses old-epoch sends before deduplication` |
| Logout or late save/decrypt completion | Local observed records cleaned conditionally; closed connection cannot restore or send late content | Browser logout, held encryption and delayed decrypt tests; store close/forget tests |
| Corrupt/tampered ciphertext or expired record | Authentication/schema/expiry failure removes only the observed invalid record | Store AAD/IV/ciphertext, bounded record schema and expiry tests |
| Local wall clock jumps | Server-adjusted deadlines used; valid intent is not incorrectly discarded | Browser `reconnection uses server expiry even after the local clock jumps forward`; store `server deadlines survive reload and local clock correction, then expire on the injected server clock` |
| Rejected reply cancellation cannot delete storage | Pending send remains locked/retryable until deletion succeeds | Browser `cancelling a rejected reply waits for durable deletion and remains retryable after storage failure` |

Sources: [application Chromium tests](../browser-test/pending-recovery.spec.mjs), [IndexedDB Chromium tests](../browser-test/pending-store.spec.mjs), [server recovery tests](../test/pending-recovery.test.ts), [implementation boundary](pending-send.md).

Logout is local UI cleanup, not cross-tab credential revocation. Cleanup may fail, and unobserved ciphertext from old credentials/scopes can remain until later access. No immediate physical erasure is claimed. Recovery keys and credentials are never stored by the client.

## Product decision and integration handoff

- VIT-101 / VIT-104: whether the first release needs multiple offline messages in one conversation remains **undecided**. This acceptance neither requires nor approves that expansion. The present single-pending-send flow is the only scope assessed here.
- VIT-124: validate the final integrated commit in the installed Windows WebView with a persistent service identity/profile: interrupt before and after IndexedDB commit, reload, restart the installed app, reauthenticate, check receipt and explicitly retry. Confirm accepted replies/attachments do not duplicate. Record the tested installer version, service version, WebView runtime and any missing scenarios there. No installed-WebView result is claimed here.
- VIT-125 / VIT-127 / VIT-128: this branch changes recovery tests and documentation only. Once their changes integrate, rerun the suites on that exact combined commit; this branch's result cannot certify future combined code.
- Unsubmitted drafts, background delivery, cross-device outbox, persisted credentials, multi-message queues, editing/retraction recovery and read/sync cursor persistence are outside this acceptance.

## Reproduce

Use the repository's Node 24 toolchain and locked dependencies, with Playwright Chromium installed:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run check:web
npx playwright test
git diff --check
```

For focused investigation after build: `node --test dist/test/pending-recovery.test.js` and `npx playwright test browser-test/pending-recovery.spec.mjs browser-test/pending-store.spec.mjs`. Focused results do not replace the final full-suite result. Exact candidate commit and validation counts are recorded in the PR and VIT-126 handoff.
