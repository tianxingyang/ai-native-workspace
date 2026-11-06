# Desktop process restart recovery (VIT-127 / VIT-124)

## Scope and baseline

Implementation base: main `bde9256` (PRs #33–#36). PR #34 already encrypts and atomically commits browser sync baselines/cursors and fixed observed reading targets. It quarantines restored content until current authentication and successful scope sync. Browser reload and a mocked native transport do not prove native process restart recovery.

The default desktop demo intentionally cannot resume: its WebView is incognito, its local service/SQLite directory is disposable, each process gets new tokens, and exit or the original 30-minute deadline destroys the service. Recovery keys include the server storage epoch, token, identity, scope and membership generation. Merely changing incognito to false would retain unusable ciphertext and would also enable WebView autofill of plaintext messages.

This change adds an explicit **local acceptance mode**, not a production login system or a persistent demo server. A launcher owns a stable, temporary loopback service while two separate native clients run. No actual security configuration, production service, credential lifetime, installer or installed application is changed.

## Native bootstrap and storage

Launch a loose native executable with `--recovery-acceptance`. Supply exactly one newline-terminated JSON object on its private stdin:

```json
{"url":"http://127.0.0.1:12345","ownerToken":"<64 lowercase hexadecimal characters>","expiresAt":0,"profileDirectory":"C:\\dedicated-test-directory\\profile"}
```

This is a schema illustration, not runnable credentials. `expiresAt` must be in the future and at most 30 minutes away, and never exceed the service's original authorization deadline. Only canonical IPv4 loopback HTTP origins with an explicit port are accepted: no remote hosts, paths, URL credentials, query strings, redirects or localhost DNS. The profile must be an absolute local path without parent components; use an exclusive, disposable directory owned by the launcher. Do not reuse a browser or another application's profile. Invalid bootstrap exits without fallback or echoing input.

The credential travels from native stdin to the sidecar over another private stdin pipe. It is not an argument, environment variable, file, WebView field or persisted login. The web IPC allowlist remains unchanged: web content cannot replace the endpoint, token or profile. The sidecar does authenticated HTTP, rejects redirects and checks the original deadline on every request. Exit stops the sidecar but leaves the externally owned service intact. Default launches still create and clean up their disposable demo as before.

The acceptance WebView retains only the existing encrypted IndexedDB sync checkpoints and pending send intents plus ordinary nonsecret WebView metadata. Native code disables **general autofill and password autosave** before showing the window or opening the request bridge; failure closes the application. HTML composer/edit forms additionally opt out of autocomplete. This is necessary: the first native disk scan found submitted synthetic message text in WebView2's plaintext `Default/Web Data` database even though IndexedDB was encrypted.

Every process begins at the disconnected screen. The user must connect again, and the current `/session` and scope `/sync` checks still gate restored text. Reauthentication here means supplying the still-valid service credential again through the launcher and revalidating it, not minting a new credential or granting access from local state. Credential rotation/server epoch reset may intentionally make old ciphertext inaccessible. The fixture keeps the service and credential stable across **client** process restarts; restarting the server or extending the trial is not part of this change.

Logout, read denial, membership replacement and observed expiry keep their existing invalidation/tombstone behavior. No full offline message display or additional offline send queue is introduced. Ciphertext from an unobserved expiry, removed identity or crashed process may remain until profile removal/ordinary store cleanup. These are logical deletion guarantees, not secure erase of SSDs, backups, swap, crash dumps or OS-managed memory. No claim is made against a compromised same-user process. The acceptance harness removes its own profile after closing the clients.

## Reproducible local verification

From a Windows x64 worktree with existing build tools and dependencies:

```powershell
npm test
npm run desktop:prepare
cargo test --locked --offline --manifest-path src-tauri/Cargo.toml
cargo build --locked --offline --manifest-path src-tauri/Cargo.toml
node scripts/desktop-restart-acceptance.mjs
```

Close any other CoSeat instance first; the existing single-instance plugin is unchanged. The harness copies the loose executable and prepared runtime to a unique worktree-local directory, launches temporary synthetic services, and sets a random loopback WebView2 inspection port only for each child process. It neither installs the application nor changes global WebView/system settings. The production binary does not enable an inspection port itself.

The native matrix covers separate executable PIDs, sidecar/WebView shutdown, a stable service and profile, recovered consumption cursor, quarantined offline baseline, retraction while closed, replay of only an already observed reading target, newer background messages remaining unread, a server-accepted send with lost response recovered by an explicit receipt check without resending, and logout ciphertext deletion. After the first process exits it scans profile bytes for UTF-8/UTF-16 plaintext token, recovery keys and synthetic message bodies. Reports contain PID/version/hash/check results, never credentials or keys. Node tests separately cover malformed bootstrap, request allowlist, original-deadline rejection for reading/sending/cancellation, duplicate send IDs and external-service ownership.

## Remaining acceptance

Successful loose-build native restart is stronger evidence than browser reload, but **is not installed release acceptance**. The candidate has subsequently been packaged and exercised in its actual installation location; version, hashes, signature state, installed restart and notification-protocol results are recorded in [the November 6 follow-up](evidence/2026-11-06-installed-desktop-recovery.md). Actual Windows notification-card presentation/click and other outstanding VIT-124 checks remain unverified, so these automated results do not establish full installed-release acceptance. A normal production authentication/provisioning flow and remote endpoint support remain separate work; this bounded launcher mode must not be presented as those features.

Installation acceptance used a fresh dedicated profile and synthetic service with its original deadline. It did not change actual grants, production services, OS notification settings or credential lifetimes. Installation reports, backups, credentials, profiles and raw machine-specific logs remain outside the public source tree.
