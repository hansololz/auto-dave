# Handoff: Autowright — macOS automation app

## Overview
Autowright is a macOS desktop app for recurring personal automations. The user describes a job in plain words ("Check the manga I follow for new chapters every morning at 8"); a connected AI agent (Claude Code, Gemini CLI, Codex, or a local Ollama model) writes it as human-readable scripts; Autowright runs those scripts on a schedule, entirely on the user's Mac, and shows results. Nothing runs before the user reviews it. The design covers onboarding, the main app (automations, executions, agents, secrets, settings), a creation/review flow, and a macOS menu-bar surface.

## About the Design Files
The files in this bundle are **design references created in HTML** — an interactive prototype showing intended look and behavior, not production code to copy directly. The task is to **recreate this design in the target codebase's existing environment** (Swift/AppKit, Electron/React, Tauri, etc.) using its established patterns and libraries — or, if no codebase exists yet, choose the most appropriate stack for a macOS desktop app and implement the design there.

`Autowright.dc.html` is the entire prototype: markup first (all styles inline on elements), then a single JavaScript logic class at the bottom of the file that holds the full data model, state transitions, and simulated flows. `support.js` is only the prototype runtime — ignore it for implementation.

## Fidelity
**High-fidelity.** Colors, typography, spacing, copy, and interaction states are final intent. Recreate the UI pixel-perfectly using the codebase's component library. All measurements below are exact values from the prototype.

## Design Tokens

### Typography
- Primary: **IBM Plex Sans** (400/500/600/700) — all UI text.
- Secondary: **IBM Plex Mono** (400/500/600) — timestamps, version labels, status chips, section eyebrows, counts, technical metadata.
- Scale: page titles 20px/600 (26–30px in onboarding/create); card titles 15px/600; body 13–13.5px/400, line-height 1.55–1.6; secondary 12–12.5px; metadata/mono 10.5–12px; eyebrow labels 9.5–10px/600 mono, letter-spacing .09em, uppercase.
- Headings use letter-spacing -.01em to -.02em. Base UI font-size is 13px. `-webkit-font-smoothing: antialiased`.

### Colors (dark theme only)
Backgrounds:
- App/window background: `#0b0e12`; content pane: `#0e1116`; sidebar: `#0a0d11`
- Cards/panels: `#12151c` (default), `#14181f` (selectable cards), `#0d1015` (inset/result wells)
- Popover menus: `#161a22`; toast: `#1b202a`
- Menu-bar panel: `rgba(25,28,35,.94)` + 30px backdrop blur

Text:
- Primary `#e9ecf1`; body-secondary `#a8b0bc`; emphasized-secondary `#c6cdd6` / `#dfe4ea`; muted `#8a93a0`; faint `#67707c`; faintest `#4f5763`

Borders: `rgba(255,255,255,.06)` hairlines, `.07` cards, `.10–.11` inputs/buttons, `.25` hover.

Accent + status (oklch; keep exact):
- **Accent (brand orange): `oklch(0.74 0.155 52)`**, hover `oklch(0.79 0.155 52)`, tint bg `/ .15` (chips `.13`, hints `.07`–`.1`). Text on accent: `#16100a`.
- Green (success): `oklch(0.76 0.15 150)`, bg `/ .13`
- Cyan (running): `oklch(0.78 0.12 210)`, bg `/ .13`
- Red (failure): `oklch(0.7 0.19 25)`, bg `/ .13`
- Amber (attention/waiting): `oklch(0.8 0.13 85)`, bg `/ .14`
- Magenta (interrupted): `oklch(0.72 0.16 340)`, bg `/ .13`
- Gray (neutral status): `#98a1ad`, bg `rgba(152,161,173,.13)`
- Links: accent color, hover `oklch(0.82 0.14 60)` + underline. Selection bg: accent `/ .35`.

### Radii
Buttons/inputs 8px; small chips 6px; pill chips 16–20px; cards 12px; menus/toasts 9–10px; result tables inherit card.

### Shadows
Popovers: `0 18px 44px rgba(0,0,0,.5)`. Toast: `0 10px 30px rgba(0,0,0,.4)`. Menu-bar panel: `0 18px 50px rgba(0,0,0,.55)`. Cards are flat (border only).

### Spacing
Page gutter 30–32px; page max-width 1200px (forms 620–720px, settings 640px); card padding 15–22px; control padding 9–10px vertical / 14–18px horizontal; sidebar 212px fixed.

### Iconography
Font Awesome 6.5.2 solid/regular/brands. App mark: 26–32px rounded square (radius 8–9px) in accent orange with a hammer glyph (`fa-solid fa-hammer`), color `#0b0d11`.

### Motion
- `adFadeUp`: fade + 8px rise, .3–.5s ease — page/section entrances, popover open (.18s)
- `adSpin`: .8–.9s linear spinner (2–2.5px ring, top arc in accent)
- `adPulse`: 1.2s opacity pulse — "waiting on you" amber dots
- Toggles/radios: .18s ease transforms; progress bars: width .12s linear

## Status Vocabulary
Runs and steps use one badge system (mono 10.5–12px, uppercase chips, tint bg + solid fg): Queued (gray), Running (cyan), Succeeded (green), Failed (red), Cancelled/Skipped/Reused (gray), Interrupted (magenta), Not run yet (gray).

## Screens / Views
All screens live in one window: 100vh, dark, with macOS traffic lights (12px circles: #ff5f57 / #febc2e / #28c840) drawn top-left.

### 1. Onboarding (3 steps, step label top-right in mono)
- **Step 1 — Welcome.** Centered 720px column. Logo + wordmark, 30px headline "Recurring jobs, done exactly the same way every time.", subhead, then a live self-check card ("Getting Autowright ready") that runs setup steps with pulsing dots and durations, ending in a "READY / All set" result well with chips and a paragraph. Continue button appears only when done ("Setting things up…" mono note while running).
- **Step 2 — Connect your AI.** Headline "Connect your AI". First a searching spinner ("Looking for an AI already on this Mac…"), then either a "FOUND ON THIS MAC" list of detected apps (radio-select cards) or a "no AI found" note plus two suggestion cards in an auto-fit grid (min 280px):
  - **Use Claude** — requires Claude Code + Pro account. Flow states: idle (accent CTA "Set up Claude Code") → installing (labelled 4px progress bar with % in mono) → macOS sudo prompt (amber pulsing dot, "Autowright never sees your password") → optionally denied ("Install paused — permission was declined", retry) → waiting for browser sign-in (reopen/cancel links) → connected (green check).
  - **Use a free local AI** — Ollama + Qwen3 8B, "Download and install · 5.2 GB", two-step progress (install Ollama → download model, continues in background), same sudo/denied states, ends "Ready to go."
  - Cards select via 16px radio rings (accent when selected, dot scales .4→1). "Skip for now" ghost link always available. Persistent footer with three green-dot reassurances: "Everything runs on this Mac", "Nothing runs until you review it", "Passwords stay in your Keychain".
- **Step 3 — First automation.** Reuses the Create flow (below) with "Step 3 of 3" label and skip option.

### 2. App shell
212px sidebar (`#0a0d11`, right hairline): traffic lights, logo + "Autowright" (16px/600), then nav items (Automations, Executions, Agents, Secrets, Settings) — 13px/500 rows, 7px radius, accent-tinted bg when active, count pills (mono 10.5px, 20px radius) for live counts. Content pane scrolls independently.

### 3. Create automation (also onboarding step 3 and edit mode)
- **Ask:** 620px column, "What should Autowright do for you?", 4-row textarea (focus ring: accent at 60%), example-prompt chips (pill buttons), a "Written by <agent>" mono dropdown (chooses which agent writes the spec; footer note: "Autowright still runs everything"), primary CTA "Draft the automation".
- **Building:** centered spinner + staged checklist (icons turn green as stages complete) + agent label.
- **Review:** 1200px page. Title row: automation name, version dropdown (edit mode; lists versions, restore), agent picker, "Start over" ghost, primary Create/Save (disabled state with amber hint when blocked). Lede: "Read what your AI wrote. Change anything — nothing runs until you create it." Below: editable spec — schedule, parameters (toggle/list/kv/number/text kinds with one-line read-only summaries), and readable step scripts with per-step agent menus. Viewing an old version shows an accent-tinted banner.

### 4. Automations list
1200px page, "Automations" 20px title + New button; cards/rows per automation with status badge, schedule chip, last-result summary. Empty and populated states.

### 5. Automation detail
Back link ("‹ Automations"), title row: name, version chip dropdown (old versions can "Run once" without changing schedule — explanatory footer in menu), status badge, then Run now (accent), Edit, and an ellipsis menu (Delete automation… in red). Below: schedule chip; optional **Draft banner** (dashed accent border: Draft chip, info, Run draft / Resume editing / Discard); **LATEST RESULT** card — status chip + metadata chips, result body rendered as paragraphs / bulleted lists / numbered steps (640px measure), optional data table (grid with mono uppercase headers, e.g. MANGA / LATEST CHAPTER / UPDATED / NEW / READ); then run history and step breakdown.

### 6. Executions list
1200px page listing runs across automations with status badges, timestamps, durations; filters at top.

### 7. Run page
Back link, title row with status badge and metadata chips; per-step timeline with statuses, expandable logs/output, result body like Latest Result.

### 8. Agents
List of connected agents (harness, model — shows "Default model" when using the harness default) + "New agent" form (720px): pick harness (Claude Code / Gemini CLI / Codex / Ollama / OpenCode), mode, model (required for Ollama), name. Add is disabled until valid; Ollama options are gated on Ollama being ready.

### 9. Secrets
1200px page; list of named secrets with add/edit modal (name + value with show/hide). Values masked at rest.

### 10. Settings
640px single column, grouped sections with toggles (36×21px track, 15px knob travel, accent when on).

### 11. Menu bar surface
Full-screen macOS desktop mock: 30px translucent menu bar (Desktop / File / Edit…, clock), an Autowright circle-play icon button with red alert dot when something failed. Clicking opens a 334px translucent panel (blur 30px): "AUTO DAVE" eyebrow + aggregate status, one row per automation (status dot — pulsing when running, name, mono sub-line, hover-revealed run button, relative time), footer with "Open Autowright" link + version. Click-outside closes.

## Interactions & Behavior
- **Navigation** is state-driven (surface → page → detail ids). Back buttons and browser/OS back both work; once past onboarding, back never returns into it.
- **Popovers** (version, agent, actions menus) close on outside mousedown.
- **Toasts**: bottom-center, ~2.8s, for confirmations (created, deleted, run started…).
- **Simulated long tasks** (installs, downloads, runs) advance on timers with visible progress; recreate with real async state machines.
- **Live runs** stream step-by-step: queued → running (cyan pulse) → terminal status; menu-bar rows and sidebar count pills update in step.
- **Hovers** throughout: ghost text `#67707c → #a8b0bc`, borders `.11 → .25`, accent buttons lighten to `oklch(0.79 0.155 52)`, menu rows get `rgba(255,255,255,.04–.06)` bg.
- **Validation**: URL lists validate `https?://…` per line and count "N links"; new-agent form gates the Add button; blocked saves show an amber hint next to a disabled button.

## State Management
One central model drives everything:
- `surface` (onboard | app | create | menubar), `page`, `autoId`, `execId`
- Onboarding: step, self-check progress, detection results, per-provider connect state (idle/installing/sudo/denied/waiting/connected), chosen provider
- Automations: id, name, versions (current + history + optional draft), schedule (dow/hour/min → "next in Xd Xh" countdown), parameters, steps, run history
- Runs: id, automation, version, status, per-step statuses, result body (text/list/steps blocks + optional table), chips, timing
- Agents (harness/mode/model/name), secrets, settings toggles
- UI: open menus, modals, toast, confirm states

Prototype knobs (useful as dev/test flags): start surface (Onboarding / App / Menu bar), agent already configured, sudo denied, and which AIs are detected (Claude / Ollama / Codex).

## Assets
- Fonts: IBM Plex Sans + IBM Plex Mono (Google Fonts)
- Icons: Font Awesome 6.5.2 (CDN) — solid, regular, brands (hammer logo glyph)
- No raster images.

## Files
- `Autowright.dc.html` — the complete prototype. Markup (with inline styles and `data-screen-label` markers for every screen) is at the top; the full logic/data model is the `class Component` script at the bottom of the file. Open it in a browser to click through every flow.
- `support.js` — prototype runtime only; not part of the design.
