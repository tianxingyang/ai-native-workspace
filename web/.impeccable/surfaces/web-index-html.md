---
version: 1
slug: "web-index-html"
primary_target: "web/index.html"
related_targets: ["web/style.css","web/app.js","web/client.js"]
---

# Surface brief: CoSeat team IM (web/index.html)

## Scope and mode
Reusable IM shell in `web/` (index.html, style.css, app.js, client.js), hosted by the Windows Tauri client and by the local browser demo. Mode: Operate.

## Audience, job, constraints
- Team members on a Windows desktop in office daylight, IM open all day beside other work; narrow windows must still work. The current demo uses Chinese, but target market, default locale and initially supported languages remain undecided.
- Job: chat in authorized conversations with human and agent peers, notice when an agent takes up research, cancel it and see a confirmed stop, read the sourced result in the same thread, recover from disconnects, understand expiry.
- User constraint (2026-11-03): a complete redesign, but it must stay an IM at its base: conversation list, chronological message stream, bottom composer, familiar send/retry behavior. The metaphor lives in identity, permission and expiry details, never in replacing IM structure.
- Preserve every behavior: send/receive with idempotent retry, server permission checks, cancel acceptance vs stop receipt, synthetic sources labelled honestly, offline recovery, expiry feedback, desktop notification flow.
- No invented features (attachments, DMs, read receipts, new threads, other members' grants). CSP: no inline style attributes, no remote fonts or images.
- Type: the Windows platform CJK stack (Segoe UI Variable + Microsoft YaHei UI, PingFang/Noto fallbacks) is deliberate. This is an Operate surface inside a Tauri WebView2 client; the CSP forbids remote fonts, and a bundled CJK face would add megabytes to the installer with no task benefit. The wordmark stays in the same stack.
- The original redesign left backend/native implementation unchanged. Follow-up review fixes, integration of the reviewed main fixes, and local desktop verification are authorized; use a distinct 0.1.3 integration artifact and preserve 0.1.1/0.1.2. Production credentials, services and OS security settings remain outside scope.

## Direction contract
THESIS: People and agents hold name cards at one table; your seat card states what you may do here and until when. Refuses bolt-on bots and permissions that surface only as errors.
OWN-WORLD: Felt-green rail; white name cards, hairline edge, soft standing shadow, on one cool grey-green ramp; ink text; amber marks live agent work.
STORY: See who sits here, chat, watch research run beside its source, cancel to a confirmed stop, read keyed sources, always know 出席/列席 and expiry.
FIRST VIEWPORT: Felt rail, selected conversation a white card; header with title and seating strip; stream; composer under your seat card; details pane right.
FORM: Seating cards (席卡), list position 7, seed e953bc3e; IM structure stays standard.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Memorable moment
The agent's name card in the seating strip lights up while it researches; your own seat card counts down your speaking grant and folds the composer into 列席 when it ends.

## Unresolved
Dark theme is out of scope for this slice. The session API exposes only the viewer's own permissions, so other seats show identity and kind, never grants.
