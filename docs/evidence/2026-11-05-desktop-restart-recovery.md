# Native restart recovery evidence — 2026-11-05

Base: main `bde9256` (PR #36). Local branch: `feat/vit127-desktop-recovery`.
See [design, protection and remaining acceptance](../desktop-restart-recovery.md).

## Passed

- Node 24.14.0: `npm test`, **220/220**. Includes 4 new native bootstrap/sidecar process tests. Initial sandbox runs were blocked by loopback `EACCES`; the successful full run used authorized local network access.
- Focused Chromium: **55/55** (`sync-recovery`, `sync-store`, `pending-recovery`, `read-denial`).
- Rust: **8/8**, including strict native bootstrap validation; `cargo fmt`, offline locked build and `cargo clippy -- -D warnings` passed. Cargo reported an environmental incremental-cache hard-link fallback, not a code diagnostic.
- `check:web` and shared/desktop language resource consistency passed.
- Real Windows native loose executable + Node sidecar + WebView2, **two completely separate native launches**, 09:58:32–09:58:37 UTC. PIDs **46808 → 25812**. WebView **Edg/156.0.4314.58**. Debug executable SHA-256 **c7a3dea754374b9d5977effe08a6a4558702868c25081000ac7ea8b8c284d67a**. This is a locally compiled debug executable, not an installed release or signed installer.

Native assertions passed:

1. First native process, sidecar and its WebView inspection endpoint exited while the independently owned synthetic service remained alive.
2. Scanning the closed profile found no UTF-8/UTF-16 plaintext credential, server-issued recovery key or synthetic message bodies.
3. A different native process loaded the saved consumption cursor. Before connecting, and while current scope sync was offline, cached messages remained invisible.
4. Retraction during shutdown was reflected without showing the old text. The saved reading target resumed at the previously observed message; the newer background message was not marked read.
5. A send accepted by the server before its response was lost was reconciled by an explicit receipt check after restart. Same client event ID, one server message, no extra send request.
6. Explicit logout removed checkpoint ciphertext. The second native process and inspection endpoint exited. The test profile was removed after process shutdown; service/worker cleanup completed.

Machine-readable local report: `.local/desktop-restart/run-v8vLYD/report.json`. Its retained executable is the hash above; its profile has been removed. Repository-local logs: `.local-tests-authorized.log`, `.local-browser-final.log`, `.local-rust.log`, `.local-clippy.log`, `.local-native.log` (ignored by Git). The final browser run is after the autofill changes.

## Failure found and fixed during verification

The first naive persistent-profile implementation passed functional restart, but a new disk scan found the synthetic composed message in WebView2's plaintext `Default/Web Data` autofill database. The final code disables native general autofill and password autosave before showing the window or enabling authenticated IPC, fails closed on unsupported/failed settings, and adds autocomplete opt-outs to message forms. The successful native result above is after that fix. An intermediate scan also hit a disappearing WebView shutdown lockfile; the harness now waits for the dedicated profile process to exit and tolerates already-deleted files.

## Not claimed

At the time of this November 5 record, no installer was built or installed, no installed release was upgraded, no service was deployed or renewed, no actual grants were changed, and no public push/PR/merge was performed. Subsequent installed-candidate results are recorded in [the November 6 follow-up](2026-11-06-installed-desktop-recovery.md). The default ephemeral demo still does not resume across processes; restart support is explicitly selected using a launcher-owned stable loopback service and a fresh bounded native bootstrap. Production authentication provisioning is separate.

VIT-127 and VIT-124 remained **In Progress** at this checkpoint. The follow-up records completed installation checks and the remaining notification-card acceptance.

## Independent review

Independent review used the standard service tier; no global speed settings were changed. Raw review logs remain local.

- Initial review found one P2 in the acceptance harness: a disappearing WebView profile lockfile could make `readFile` throw ENOENT. It raised no other product findings. The final harness already included the fix by the time this review completed.
- Focused independent re-review inspected the current harness and successful native report, and confirmed **the previous P2 is resolved**: process exit is awaited; only ENOENT is ignored; other file/directory errors still fail the scan. No remaining actionable finding was reported.
- Logs: `.local-review-first.log`, `.local-review-final.log`. No code changes followed the focused re-review; only this evidence record was finalized.
