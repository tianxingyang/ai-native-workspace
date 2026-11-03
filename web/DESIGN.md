---
name: CoSeat 同席 — Team IM
description: Team messenger where people and agents sit at one table as named peers; reused by the Windows Tauri client and the local browser demo. Market, default locale and initially supported languages remain undecided.
colors:
  card-white: "#ffffff"
  table: "#f5f7f5"
  quiet-fill: "#edf1ee"
  hairline: "#dfe5e0"
  strong-rule: "#c9d1cb"
  control-edge: "#858f89"
  muted-ink: "#5f6b64"
  secondary-ink: "#3f4a44"
  ink: "#17201b"
  felt: "#1f4337"
  felt-raised: "#29503f"
  felt-deep: "#193a2f"
  felt-ink: "#eef4f0"
  felt-mute: "#b4cbbf"
  felt-focus: "#9fd8bf"
  accent: "#1d6a50"
  accent-soft: "#e2eee7"
  focus: "#2e8a67"
  live: "#b87310"
  live-ink: "#865410"
  live-soft: "#fbf1de"
  live-rule: "#ead2a6"
  live-on-felt: "#f2c879"
  warn-ink: "#6b4307"
  warn-soft: "#fcf2df"
  warn-rule: "#ecd3a6"
  danger: "#b0281f"
typography:
  display:
    fontFamily: '"Segoe UI Variable Display", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-.01em"
  title:
    fontFamily: '"Segoe UI Variable Display", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.5
  meta:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.65
  caption:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif'
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.6
  data:
    fontFamily: '"Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace'
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  mark: "4px"
  card: "6px"
  panel: "8px"
  field: "10px"
  pill: "16px"
spacing:
  hair: "4px"
  tight: "8px"
  compact: "12px"
  base: "16px"
  gutter: "24px"
components:
  button-primary:
    backgroundColor: "{colors.felt}"
    textColor: "{colors.card-white}"
    rounded: "{rounded.card}"
    padding: "0 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.felt-deep}"
  button-outline:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "0 10px"
    height: "30px"
  button-quiet:
    textColor: "{colors.secondary-ink}"
    rounded: "{rounded.card}"
    padding: "0 10px"
    height: "32px"
  button-text:
    textColor: "{colors.accent}"
    typography: "{typography.meta}"
    height: "28px"
  room-default:
    textColor: "{colors.felt-ink}"
    rounded: "{rounded.card}"
    padding: "8px 10px"
  room-selected:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "8px 10px"
  seat-card:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "0 10px 0 4px"
    height: "30px"
  seat-card-live:
    backgroundColor: "{colors.live-soft}"
    textColor: "{colors.live-ink}"
  research-card:
    backgroundColor: "{colors.card-white}"
    rounded: "{rounded.card}"
    padding: "10px 12px"
  composer:
    backgroundColor: "{colors.card-white}"
    rounded: "{rounded.field}"
    padding: "8px 10px 8px 12px"
  composer-readonly:
    backgroundColor: "{colors.quiet-fill}"
  synthetic-label:
    textColor: "{colors.secondary-ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.mark}"
    padding: "0 6px"
  source-key:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    rounded: "{rounded.mark}"
    size: "18px"
  banner-warning:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn-ink}"
    padding: "8px 20px"
  input-credential:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "0 12px"
    height: "40px"
---

# Design System: CoSeat 同席 — Team IM

## Overview

**Creative North Star: "One table, named seats"（同席之桌）**

CoSeat keeps the skeleton every team-messenger user already knows: a conversation rail, one chronological stream, a composer at the bottom and an optional details pane on the right. The world on top of that skeleton is a meeting table. The rail is felt green, and the open conversation is the white card placed on it. Every member, human or agent, appears as a name-card tile with a word label for their kind. Your own name card sits on the composer and states your standing (出席 to speak, 列席 to read only) and when your speaking grant ends.

Work does not live in a dashboard. It arrives on the table as white cards that stand on a cool grey-green surface: a research card under its source message, with its state in a fixed first cell, and a result whose synthetic sources carry numbered keys. Message text itself is never boxed. Amber is reserved for things in flux, such as an agent researching, a cancellation awaiting its stop receipt, a lost connection or a grant about to expire. Dashed edges mark anything that is not fully real or not fully yours: synthetic results, demo notes, limitations and the read-only composer.

The density suits an Operate surface. Rail rows are compact, the in-app type ramp stays within 11–17px, and Windows system faces carry Chinese and Latin text. Motion only reports state: live marks breathe, the details pane slides in, the composer folds shut when speaking ends, and a result you jump to flashes. This record describes the built `web/` interface (index.html, style.css, app.js). Under PRODUCT.md these remain implementation decisions for this slice, not a ratified brand identity.

**Key Characteristics:**

- Familiar IM structure; the metaphor lives in identity, permission and expiry details.
- People and agents share one alignment; kind is a word plus a tile tint, never a different layout.
- White standing cards on a grey-green table; a felt-green rail and connection screen.
- State always in words beside a drawn mark; amber means in flux, green means done.
- Honest synthetic material: dashed labels, plain-text placeholder URLs, visible limitations.

## Colors

A restrained grey-green system with one committed field. Felt green owns the rail and the connection screen. Inside the reading area, green appears only as the accent for actions and completion.

### Primary

- **Felt Green** (`felt`): rail background, connection screen, primary buttons, the selected room's tile and the conversation tile in the header.
- **Raised Felt** (`felt-raised`): hover on rail rows and rail buttons.
- **Deep Felt** (`felt-deep`): rail footer band and primary-button hover.
- **Felt Ink / Felt Mute** (`felt-ink`, `felt-mute`): primary and secondary text on felt. Mute keeps at least 5.2:1 on every felt tone.
- **Felt Focus** (`felt-focus`): keyboard outline inside the rail.

### Secondary

- **Ledger Green** (`accent`): text actions (查看结果, 查看这条消息的讨论), completed marks and step dots, 出席 standing, available permissions, source keys and the summary text of the sources disclosure.
- **Pale Ledger** (`accent-soft`): agent tiles, source-key chips, the pressed members toggle and the flash on a jumped-to message.
- **Focus Green** (`focus`): the 2px keyboard outline everywhere outside the rail, and the composer's focus-within ring.

### Tertiary

- **Live Amber** (`live`): drawn marks only. Covers the running and cancel-requested state marks, live dots, the live seat's border and ring, and the current-step dot.
- **Live Ink** (`live-ink`): text for live states (调研中, the current step, an unknown result).
- **Live Wash / Live Rule** (`live-soft`, `live-rule`): fill of a live seat card and border of an in-flight research card.
- **Live on Felt** (`live-on-felt`): live preview text in an unselected rail row.

### Neutral

- **Card White** (`card-white`): every standing card, the header, the details pane and the composer.
- **Table** (`table`): the stream and composer surround; the app's ground.
- **Quiet Fill** (`quiet-fill`): message hover, quote blocks, the "你" chip and the read-only composer.
- **Hairline / Strong Rule** (`hairline`, `strong-rule`): card edges, dividers, step connectors and dashed demo rules.
- **Control Edge** (`control-edge`): field and synthetic-label strokes (3.3:1 on white).
- **Muted / Secondary / Ink** (`muted-ink`, `secondary-ink`, `ink`): meta text, supporting text and primary text. Muted keeps at least 4.8:1 on every neutral surface.

### Semantic

- **Warning trio** (`warn-soft`, `warn-ink`, `warn-rule`): sync-interruption banner, expiry notice, unconfirmed-send outbox. It shares the amber family on purpose, because these banners also mean "in flux, watch this".
- **Danger** (`danger`): request errors, failed marks and steps, and the invalid-credential field border.

**The One Ramp Rule.** Every neutral comes from the nine-step ramp `card-white` → `ink`. A new grey is a new token or a mistake.

**The Amber Means In-Flux Rule.** Amber marks work that is still moving or a deadline that is approaching. Completion is green, failure is red, and a confirmed stop is ink. Amber is never decoration.

**The State-in-Words Rule.** Every state pairs its mark or colour with words: 正在研究, 等待停止确认, 已停止, 已连接, 连接中断, 列席（只读）. Colour alone never carries a state at any width.

## Typography

**Display / Title Font:** Segoe UI Variable Display, falling back to Segoe UI, Microsoft YaHei UI, Microsoft YaHei, PingFang SC and system-ui.
**Body Font:** Segoe UI Variable Text, with the same CJK fallbacks plus Noto Sans CJK SC.
**Data Font:** Cascadia Mono or Consolas, used only for placeholder source URLs.

**Character:** The native Windows UI voice. Latin is set in Segoe, Chinese in YaHei UI, and leading is generous enough for CJK reading. The stack is deliberate. This is an Operate surface inside a Tauri WebView2 client, the CSP forbids remote fonts, and a bundled CJK face would add megabytes to the installer without helping any task. Font synthesis is disabled.

### Hierarchy

- **Display** (700, 22px, 1.35, -.01em): the connection-card heading only. The wordmark uses the same stack at 700 weight, 24px on the connection card and 20px in the rail, with -.02em tracking.
- **Title** (700, 17px, 1.3): the conversation title. Pane titles and your seat name use 15px at the same weight.
- **Body** (400, 14px, 1.7): message text, capped at 72ch, with whitespace preserved and wrapping anywhere. Base UI text is 14px at 1.6.
- **Label** (600, 13px): author names (14px/600), room names, run titles, the sources summary and permission rows. The run state cell is 13px/700.
- **Meta** (400, 12px, 1.65): timestamps (tabular numerals), thread names, previews, step labels, run notes, helper text and banners at 13px.
- **Caption** (400, 11px): the synthetic label, count badges, source keys, gutter times and rail times.

**The Weight-Not-Size Rule.** Inside the app, rank is carried by weight (400 / 600 / 700) on a tight 11–17px ramp. Only the connection card goes above 17px.

## Layout

The shell is a full-height grid: a 272px rail plus a fluid chat column. At 1180px and wider, opening the details pane adds a 360px third column. Below 1180px the pane overlays from the right (up to 380px) with a lifted shadow. Between 721px and 900px the rail narrows to 240px. At 720px and below, the shell becomes one column that switches between rail and chat, and the pane fills the window.

The chat column stacks a white header (at least 64px tall, hairline below), optional warning banners, the scrolling timeline on the table surface (padding 18 / 24 / 16px), and the composer area (padding 6 / 24 / 14px). At 720px and below, the horizontal gutters drop to 12px.

Each message row is a grid of a 36px tile and a fluid body with a 12px gap. Rows use 6–10px padding against matching negative margins, so the hover fill extends past the text edge. Consecutive messages from one author within five minutes share a header, and the time moves into a hover gutter. Results, and messages that carry a research card, always restart the header. Day dividers name 今天, 昨天 or the date. Text holds at 72ch; research cards and sources cap at 640px.

At 981px and wider the header shows a seating strip of full name cards. At 980px and below the seats collapse into 28px tiles that overlap by 6px. Their names stay in the accessibility tree, and a live agent's tile keeps its amber ring and dot. At 720px and below, the back control is icon-only, the members toggle shows an icon and a count, the connection status keeps its text, research steps stack vertically and the Enter hint is hidden.

Spacing follows 4 / 8 / 12 / 16 / 24px, with 6px and 10px as in-component steps.

## Elevation & Depth

Depth comes from two things together: tonal layers (felt rail, grey-green table, white cards) and one standing shadow that makes a card look placed on the table. Message text is never lifted.

### Shadow Vocabulary

- **Standing card** (`box-shadow: 0 1px 0 rgb(23 32 27 / .04), 0 3px 10px -5px rgb(23 32 27 / .3)`): tiles, seat cards, research cards, sources, composer, suggestion chips, the members' and your own seat card in the pane.
- **Card on felt** (`box-shadow: 0 1px 0 rgb(0 0 0 / .22), 0 8px 16px -10px rgb(0 0 0 / .55)`): the selected conversation on the rail.
- **Lifted pane** (`box-shadow: -12px 0 36px -18px rgb(23 32 27 / .45)`): the details pane while it overlays (below 1180px).
- **Floating pill** (`box-shadow: 0 6px 18px -8px rgb(23 32 27 / .45)`): the 查看新消息 button.
- **Connection card** (`box-shadow: 0 2px 0 rgb(0 0 0 / .14), 0 28px 60px -28px rgb(0 0 0 / .6)`): the card on the felt connection screen.

Focus is not elevation. Controls get a 2px `focus` outline at a 2px offset. The composer uses a 3px soft ring of the same green while focus is inside it.

**The Standing Card Rule.** Identities and artifacts stand on the table as white cards with a hairline edge and the standing shadow. Speech never does: no bubbles, no boxed message text.

## Shapes

Cards, tiles, buttons, rooms and seat cards share one gentle corner (6px). The composer field is softer (10px). The connection card and message hover rows use 8px. Marks, keys, badges and the synthetic label use 4px. Pills appear only for count badges and the new-messages button, and circles only for state dots.

Icons come from one authored inline SVG sprite: a 24-unit grid, 1.6 stroke, round caps and joins, sized 14–18px. State marks use a 16-unit grid: a hollow ring for queued, a filled dot for running, a ring with a square for cancel requested, a filled square for stopped, a check disc for completed, a cross disc for failed and a question ring for unknown.

**The Dashed Edge Rule.** A dashed edge says "not the real thing, or not available to you". It marks the synthetic-result label, the 本地演示 tag, the demo-note rule, the limitations block and the read-only composer. Nothing else is dashed.

## Components

### Buttons

- **Shape:** gentle corners (6px) everywhere.
- **Primary:** felt fill, white 600 text, 36px tall (40px on the connection card), 0 16px padding, an optional 16px icon. Hover deepens to `felt-deep`. Disabled turns `hairline` with muted text.
- **Outline:** white fill, strong-rule stroke, ink 600 text at 12px, 30px tall. Used for 取消研究 and 重试同一条消息.
- **Quiet:** secondary-ink 13px text on no fill, with `quiet-fill` on hover. Used for the members toggle and the mobile back control.
- **Text action:** ledger-green 12px/600 text with an optional 14px icon, underlined on hover with a 3px offset.
- **Rail button:** felt-mute 12px text with a 15px icon and raised felt on hover. Used for 退出连接 / 断开连接 / 退出应用.

### Conversation Rail

- Rows are at least 58px tall with a 36px tile, a two-line copy block (name + thread + time, then preview or live line + count badge) and an explicit accessible name (room, live state, local new-message count).
- **Selected:** becomes the white card on felt (card-on-felt shadow), with the tile in felt and white text.
- **Live:** the preview reads "{agent} 正在调研" after an amber dot.
- **New activity:** a felt-ink count badge counts messages from others since this page session last viewed the room. It is local only and never a read receipt.

### Seating Strip and Name Cards

- Each header seat is a 30px white card with a 22px tile, the name at 600 and the kind or "你" in muted text.
- A live agent's seat gets an amber border, a live wash, a breathing dot and the word 调研中.
- At 980px and below, seats become stacked 28px tiles with white rims, as described in Layout.

### Message Row

- A tile (white for people, pale ledger for agents), then author 600 + kind word + optional "你" chip + time, then the 14px body.
- Hover fills the row with `quiet-fill`. A jumped-to message flashes `accent-soft` and takes focus.

### Research Card (signature)

- A white standing card under its source message, at most 640px wide. In-flight states use a `live-rule` border.
- The first cell is fixed (at least 112px, divided from the rest by a hairline) and holds the state mark plus a 13px/700 label. The cell is followed by 调研 #N and the agent's name, with the outline cancel button at the right when the viewer may cancel.
- Progress steps come only from server events (已认领 → 开始执行 → 结果回到讨论, or 取消已受理 → 等待停止确认 / 已停止), with second-precision times. They stack vertically when narrow.
- The note states the receipt truth. Acceptance of a cancel is never shown as a stop.

### Sources Disclosure

- A native details element on a white standing card. The summary shows a chevron, "N 条合成来源与限制" and the key chips.
- Each source row shows its key, title (600), excerpt and the fixture URL in data type with 测试占位地址 wording. It is plain text, never a link.
- Limitations sit below a dashed rule under the heading 限制.

### Composer and Seat Card (signature)

- A white field card (10px corners) with the focus-within ring. Your seat card stands at its top-left as a white name card: tile, name, standing (出席 in ledger green) and "可发言至 HH:MM（剩 N 分钟）". It switches to warning ink inside the five-minute notice window.
- The textarea grows with content up to 40vh. The bottom row holds the Enter hint and the primary send button (icon + 发送 / 发送中…).
- **Read-only:** the input row folds shut (grid rows 1fr → 0fr over 280ms, instant under reduced motion). The field turns dashed on `quiet-fill`, and the seat card alone remains: a lock, 列席（只读）, and the reason (已于 HH:MM 到期, 已被收回 or 没有发言授权).

### Banners and Outbox

- Warning banners carry an icon, text in `warn-ink` and an optional outline-style action (立即重连).
- The expiry notice sits above the composer as a rounded banner.
- Unconfirmed sends appear in the outbox above the composer with retry copy. They are never shown as delivered messages.

### Details Pane

- A white column or overlay with a 64px header (15px/700 title and a close icon button).
- **Seating and permissions (座次与权限):** your own seat card with standing and a permission list (查看消息 / 发言 / 取消调研: 可用 · 至 HH:MM, 已于 HH:MM 到期, 已被收回 or 未授权), then the member list. It never shows other members' grants.
- **Discussion details (讨论详情):** the source message, its research runs (steps stack vertically) and the results with sources expanded.

### Connection Card

- A white card on full felt. The top band carries the wordmark and closes with a hairline fold. Below it come the 22px heading, the lede, the credential field and the primary button.
- A rejected credential puts the error directly under the field and marks the field with a danger border and `aria-invalid`. The desktop shell hides the field and offers 进入本地演示.

## Do's and Don'ts

### Do:

- **Do** keep the IM skeleton: rail, one chronological stream, bottom composer, details in the side pane.
- **Do** keep people and agents in the same alignment, with kind as a word label (人类 / Agent) plus a tile tint.
- **Do** put research state in the card's fixed first cell as mark + words, and derive progress only from server events.
- **Do** show standing (出席 / 列席) and the speaking deadline on the viewer's seat card, and fold the composer when speaking lapses.
- **Do** mark synthetic or unavailable material with dashed edges and words, and render fixture URLs as plain text.
- **Do** keep every neutral on the `card-white` → `ink` ramp and every card on the 6px corner with the standing shadow.

### Don't:

- **Don't** use amber for completion, emphasis or decoration; it means in flux or time-bound.
- **Don't** box or bubble message text, or move research into a dashboard away from its source message.
- **Don't** show other members' grants, presence, typing or read state. The session API does not provide them, and the new-message count stays local to the page session.
- **Don't** let colour alone carry a state at any width; the connection label stays visible on narrow windows.
- **Don't** load remote fonts, icons or images, or use inline style attributes; the CSP forbids them.
