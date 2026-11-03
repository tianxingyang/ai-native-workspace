---
name: CoSeat 同席 — Web IM
description: Chinese-first shared conversations for human and agent teammates, verified in a local browser demo.
colors:
  accent: "#14675f"
  accent-hover: "#0e514b"
  focus: "#268c80"
  ink: "#202d35"
  muted: "#586974"
  panel: "#f2f5f6"
  reading: "#fff"
  line: "#dce4e7"
  button-hover: "#e3ebed"
  room-selected: "#dfece8"
  role-surface: "#e1eae8"
  role-text: "#28574f"
  context-surface: "#f6f8f8"
  research-surface: "#f3f7f6"
  research-action: "#e2ede9"
  source-filter: "#edf5f2"
  source-border: "#bdd8cd"
  human-surface: "#e7edf2"
  human-ink: "#3f596b"
  agent-surface: "#dfece6"
  agent-ink: "#285c4b"
  danger: "#a33a30"
  warning-surface: "#fff3e4"
  warning-ink: "#74480d"
  synthetic-surface: "#fbf1d9"
  synthetic-ink: "#7b591e"
  input-border: "#9daeb5"
  composer-border: "#bccdce"
typography:
  headline:
    fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "-.02em"
  title:
    fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "19px"
    fontWeight: 650
  body:
    fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "14px"
    lineHeight: 1.85
  label:
    fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "13px"
  caption:
    fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "11px"
  role:
    fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "11px"
    fontWeight: 500
rounded:
  badge: "4px"
  control: "8px"
  mobile-avatar: "9px"
  room: "10px"
  avatar: "11px"
  container: "12px"
spacing:
  tight: "4px"
  small: "8px"
  compact: "12px"
  inset: "14px"
  medium: "16px"
  desktop-gutter: "30px"
  wide-gutter: "50px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.reading}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-quiet:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-research:
    backgroundColor: "{colors.research-action}"
    textColor: "{colors.accent}"
    rounded: "{rounded.control}"
    padding: "5px 10px"
  input-credential:
    backgroundColor: "{colors.reading}"
    rounded: "{rounded.control}"
    padding: "12px"
    width: "100%"
  room-selected:
    backgroundColor: "{colors.room-selected}"
    rounded: "{rounded.room}"
    padding: "14px 12px"
    width: "100%"
  role-badge:
    backgroundColor: "{colors.role-surface}"
    textColor: "{colors.role-text}"
    typography: "{typography.role}"
    rounded: "{rounded.badge}"
    padding: "3px 6px"
  research-card:
    backgroundColor: "{colors.research-surface}"
    rounded: "{rounded.container}"
    padding: "14px 16px"
  composer:
    backgroundColor: "{colors.reading}"
    rounded: "{rounded.container}"
    padding: "12px 14px"
---

# Design System: CoSeat 同席 — Web IM

## Overview

**Creative North Star: "同席讨论，工作紧随来源"**

A familiar team messenger keeps people, agents and their work in one chronological conversation. Ink text, pale slate navigation, a white reading surface and deep teal actions support Chinese-first office use. Initial avatars align peers consistently; research stays attached to its source message instead of moving into a separate dashboard.

This is a source-derived record of the current `web/` interface, based on `index.html`, `style.css`, `app.js` and the product context in `../PRODUCT.md`. The North Star paraphrases the existing body direction contract; it is an implementation assumption, not a newly approved brand identity. This boundary is reusable UI currently verified in a browser local demo. A desktop framework, installer and production service are not implemented by this design record. `../docs/design.md` remains the separate product architecture document.

**Key Characteristics:**

- Chinese-first, familiar conversation navigation.
- Shared message alignment for human and agent peers.
- Flat surfaces separated by tone, whitespace and thin rules.
- Source-linked research with explicit state and synthetic-result labels.
- Native text, CSS and inline SVG; no raster UI assets.

## Colors

Deep teal provides the action accent; slate and white organize the reading environment. Frontmatter records observed CSS values, including extracted repeated literals; only `accent`, `muted`, `line`, `panel`, `danger` and the container radius currently exist as CSS custom properties. This document does not imply a runtime theme API or dark theme.

### Primary

- **Deep teal** (`accent`): primary actions, research status, message-source actions and source disclosure.
- **Deep teal hover** (`accent-hover`): primary-button hover only.
- **Focus teal** (`focus`): the visible keyboard outline, independent of selection.

### Neutral

- **Ink / muted slate** (`ink`, `muted`): message content versus timestamps, supporting labels and secondary controls.
- **Pale slate / reading white** (`panel`, `reading`): navigation and page surround versus chat content.
- **Fine slate rule** (`line`): header, member and footer boundaries.
- **Soft gray hover** (`button-hover`): generic button hover.
- **Selected sage** (`room-selected`): the current conversation; selection is also exposed through `aria-current`.
- **Quiet context / research surfaces** (`context-surface`, `research-surface`): context strip and research blocks; research actions and source filters have their own existing pale green fills.
- **Human and agent avatar pairs** (`human-surface`, `human-ink`, `agent-surface`, `agent-ink`): distinguish member kind without changing message alignment or prominence. Text badges also identify kind.
- **Role badge pair** (`role-surface`, `role-text`): short role and local-demo labels.

### Semantic States

- **Danger red** (`danger`): connection and request errors.
- **Warm warning pair** (`warning-surface`, `warning-ink`): sync interruption and unconfirmed outbound messages.
- **Synthetic result pair** (`synthetic-surface`, `synthetic-ink`): marks simulated research output explicitly.
- **Input / composer rules** (`input-border`, `composer-border`): resting field edges; the composer border switches to the accent when focus is inside.

**The State-in-Words Rule.** Status text must carry the meaning; color alone never establishes success, failure, role or a confirmed stop.

## Typography

One system font stack serves headings, body copy and controls. Segoe UI and Microsoft YaHei are preferred, then platform sans-serif. There is no downloaded display or mono font. Font synthesis is disabled; installed font availability can change the rendered face.

- **Headline:** connection-page heading; the recorded bold weight is the native heading default. Narrow screens reduce its size to (26px).
- **Title:** room heading, reduced to (17px) on narrow screens. The sidebar section title and conversation name use (14px); conversation names use weight (600).
- **Body:** message text uses the recorded generous leading and a maximum line measure of (75ch). Whitespace is preserved and long content can wrap anywhere.
- **Labels:** message names and research titles use (13px); author names use weight (650), research titles (600). Secondary room/thread metadata commonly uses (12px).
- **Captions:** timestamps, scope notes and status badges sit at the smaller end of the observed scale. Timestamps use tabular numerals.
- **Wordmark:** text only, size (24px), weight (750), tracking (-.025em); the rail uses (23px). The adjacent Chinese name is smaller and muted.

Keep ordinary Chinese case and short descriptive action labels. There is no uppercase label system or fixed mathematical type ratio.

## Layout

The desktop shell fills the dynamic viewport height and is centered with a maximum width of (1700px). A fixed conversation rail (280px) sits beside a flexible chat column. The chat uses a flex column: room header, optional members, context and state strips, independently scrollable timeline, then composer. This is a messaging workspace, not a grid of interchangeable cards.

The header has a minimum height of (89px). The timeline uses vertical padding (28px / 12px) and the desktop horizontal gutter from the spacing tokens. At viewport widths of at least (1400px), timeline and composer horizontal gutters increase to the wide-gutter value. Message rows have maximum width (880px), an avatar column (36px), a gap (12px) and bottom spacing (26px). Research blocks cap at (660px); source details at (680px).

At widths up to (720px), the shell becomes one column. It shows either the room list or the chat; the “会话列表” control switches views. Selecting a room returns to chat and focuses the room title. Returning to the list focuses the selected room. The chat header becomes at least (78px) high with tighter padding; timeline and composer use horizontal gutters (16px). Avatars shrink to (30px), message gaps to (10px), and message bottom spacing to (24px). Research headers and context content wrap when necessary.

The connection surface is centered with padding (24px) and a panel width capped at (440px). It is an unboxed form rather than an elevated card. Spacing values are extracted from the current implementation, not an enforced universal spacing scale.

## Elevation & Depth

There are no box shadows. Surface tones, one-pixel boundaries and whitespace establish hierarchy. Source highlighting uses a two-pixel outline with an offset (8px); keyboard focus uses a three-pixel outline with an offset (3px), while the textarea uses an offset (5px). These marks convey location and focus, not elevation.

The only authored animation is the selected source's background fading from its highlight color to the research surface over (1s), using `ease-out`. It runs only when `prefers-reduced-motion: no-preference` matches. There are no general hover transitions or loading spinners to reuse.

## Shapes

Controls have gently rounded corners; badges are compact, slightly rounded rectangles. The radius tokens preserve the actual distinctions between controls, selected rooms, avatars and larger containers. Avatars are initial tiles, not circular photos. Research blocks and the composer share the container radius. Dividers are fine solid rules; there are no decorative gradients or raster textures in this implementation.

Room icons are authored inline SVG speech bubbles with a stroke weight (1.5), displayed at (21px) inside a tile (38px). Preserve the inline, current-color icon treatment when reusing this pattern.

## Components

### Buttons

Primary buttons have a deep teal fill, white text and weight (600). Base buttons have minimum height (40px), and the send action has minimum width (76px). Quiet buttons use muted text and the same base geometry. Generic hover adds a soft gray fill; primary hover uses its darker teal variant. Disabled buttons have opacity (.55) and a default cursor.

Compact research cancellation controls use a pale research-action fill, accent text, font size (12px), minimum height (32px) and padding (5px 10px). Message-source actions are lighter text controls with padding (4px 0), font size (12px) and minimum height (30px). Their existing selector specificity keeps their own fill or text treatment; do not infer a new active-state animation.

Buttons, inputs, textarea, disclosure summaries and focusable timeline/title elements receive the shared visible keyboard outline. Dynamic updates preserve focus on message actions using action identifiers; if an action disappears, focus returns to the timeline.

### Inputs / Composer

The credential field uses a white surface, one-pixel border, control radius and padding (12px). Its password value is retained only in page memory, and the connection screen explains the local-demo credential scope.

The composer is a bordered container with an unbordered, non-resizable textarea. The textarea uses font size (14px), leading (1.75), preserved content and an accent caret. The bottom row holds keyboard help and send. Enter sends; Shift + Enter inserts a line break. Composition events protect Chinese input. Empty, pending or unauthorized sends disable the action; a pending request also disables editing. Read-only state changes the helper copy.

### Conversation Navigation

Full-width room buttons have minimum height (76px), an icon tile, a strong conversation name and a smaller thread identifier. Long navigation text truncates with ellipses. Current room selection uses a sage fill and `aria-current`; ordinary hover uses the generic button fill. The bottom identity and disconnect controls remain separated by a rule. Narrow layouts use the room/chat switch described above rather than an overlay drawer.

### Badges / Members

Role badges label “人类” or “Agent”; their text stays on one line. The member list is a wrapping row revealed by a button with `aria-expanded`. A separate warm badge identifies simulated research results. Role and result badges are informational, not interactive filter chips.

### Message Stream / Research Card

Messages share one left-aligned grid regardless of author kind. Initial avatar, author, role and time precede text. Research cards sit below the source message with a title, textual status, supporting explanation and an authorized cancellation control when applicable. States distinguish queued, running, cancellation requested, completed, failed, stopped and unknown; requested cancellation is not displayed as a confirmed stop.

Results disclose synthetic sources and limitations in native `details` / `summary`. Placeholder source addresses are visibly labeled as unusable evidence rather than rendered as genuine evidence links. Source-view controls narrow the displayed messages to the source and its related discussion; the composer still sends to the preset thread. Preserve that scope explanation.

### Feedback / Empty States

Sync interruption retains the last synchronized records and offers reconnection in a warm strip. Unconfirmed sends appear above the composer with retry copy; they are not silently presented as delivered messages. A new-message control preserves reading position when the reader is away from the bottom. Loading and empty conversations have different copy. Live regions announce connection and action outcomes without replacing the chronological record.

## Do's and Don'ts

### Do:

- **Do** retain Chinese-first labels, composition-safe input and readable message leading.
- **Do** keep human and agent messages in the same alignment, with explicit kind labels.
- **Do** keep research status, results and source disclosure beside the originating message.
- **Do** preserve visible keyboard focus through navigation and asynchronous updates.
- **Do** reuse the existing flat surfaces, token roles and responsive room/chat switch.
- **Do** label synthetic output and uncertain outcomes in words.

### Don't:

- **Don't** describe the current browser demo as an installed desktop or production client.
- **Don't** promote provisional colors, metaphor or spacing into a newly approved brand commitment.
- **Don't** replace this messenger's shared message stream with a dashboard layout.
- **Don't** make role, request acceptance or execution completion depend on color alone.
- **Don't** introduce raster assets or remote icon/font dependencies when reproducing this current interface.
- **Don't** imply attachments, direct-message creation, message editing, unread receipts or arbitrary new threads exist in this slice.
