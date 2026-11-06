# Installed desktop recovery verification — 2026-11-06

Implementation snapshot: `6d009b1b7cf881873b5cb72cef3740cad451b4ac`, based on main `bde92567f8cc77a27186a21d6ea6fcb3e72cfcd7`. The publication copy adds sanitized documentation and a test-window selector correction; application/runtime sources match the tested implementation snapshot.

## Candidate and installation

- CoSeat Demo **0.1.3**, Windows x64, current-user NSIS installation, **unsigned**. The version is unchanged from earlier candidates; identify this candidate by its hashes.
- Installer: **25,868,487 bytes**, SHA-256 `e87705b866aab1b4a6ffb1ee04e4ad2880398ea94653794a6e09f9e482ce1b77`.
- Installed executable: SHA-256 `1d853993f705bfd21dfacc993630d018130dffa992aeae0685766b61f8b23262`. All **477** shipped runtime files matched the prepared runtime.
- WebView2: **156.0.4314.58**. Existing application and WebView data were backed up before the same-version reinstall. Unrelated local trial files remained unchanged.
- Tauri temporarily changes the executable's bundle marker from `UNK` to `NSS` for NSIS packaging, then restores the loose binary. Byte comparison found only those three differing bytes. Both variants passed the native restart matrix.

## Validation

| Check | Result |
| --- | --- |
| Development Node 24.14.0 | 220/220 |
| Bundled Node 24.22.2 | 220/220 |
| Focused Chromium recovery regressions | 55/55 |
| Rust unit tests | 8/8 |
| Clippy with warnings denied; Rust formatting | Passed |
| Web syntax, language/resource consistency, diff whitespace | Passed |
| Windows x64 release and NSIS build | Passed |
| Installed executable launched in place for two-process restart | Passed |
| Installed IM smoke | Passed |
| Windows notification history and real registered-protocol activation | Passed |
| Repeated activation; disconnected/unknown-reference rejection | Passed |
| Second activation during delayed empty native IPC response | Passed |

The installed restart run used the executable and runtime from the installation directory, without copying them into a loose-build fixture. Separate native processes recovered the consumption cursor and fixed observed reading target. Cached content stayed hidden before current authentication/sync, retracted text stayed absent, newer background messages were not marked read, and the lost send response was reconciled by receipt without another send. A closed-profile scan found no UTF-8/UTF-16 plaintext token, recovery key or synthetic message body. Explicit logout removed checkpoint ciphertext; the dedicated profile and owned test services were cleaned up.

The installed IM smoke covered real send, duplicate submission, synthetic source display, cancellation and actual stopped receipt, room/draft isolation, scope denial, native/network privilege boundaries and reload/reconnect. Notification-protocol tests restored a hidden window to its freshly authorized source and left repeated activation usable. All testing used synthetic local data and the existing bounded authorization deadline.

## Test-helper correction

An initial notification failure was induced by the test helper. When the actual UI was already hidden, `Process.MainWindowHandle` selected the zero-sized single-instance event window. Sending a second `WM_CLOSE` to that handle destroyed the notification activation target.

`scripts/desktop-test-window.ps1` now restricts selection to the expected test executable's actual `Tauri Window`, requires exactly one such window, and treats an already hidden UI as a no-op. The installed test repeated the already-hidden case with that selector and passed notification recovery. The candidate executable did not change.

## Remaining acceptance and cleanup

**Actual Windows banner/notification-center card display and click remain unverified.** Keyboard, taskbar automation and verified physical-pointer attempts did not expose an interactable CoSeat card. The cause was not established, and OS notification/security settings were not changed. Notification history and registered-protocol activation are separate evidence and must not be counted as a card click.

Other outstanding VIT-124 checks, including tray-menu interaction, natural thirty-minute expiry and cold-start stale notifications, are not claimed by this record. Default demo launches remain ephemeral; installed restart validation still uses a launcher-owned bounded loopback service and a dedicated profile. Production login/provisioning and remote endpoints remain separate work.

The installed candidate was retained. Test clients, sidecars, the installer and temporary inspection listener exited normally. WebView updated runtime state during use and cleaned two old BrowserMetrics files; the complete pre-install backup remains local. No public release assets, machine-specific reports, screenshots, profiles, credentials or backups are included in this source change. No merge, deployment, real grant change or live-service renewal was performed.
