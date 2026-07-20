# Auto Dave — SPEC

Source of truth. Holds enough detail to rebuild the app from scratch. The interactive design
prototype lives in `design/` (`Auto Dave.dc.html` + `design/README.md`); this spec captures its
behavior and data model as requirements. Where pixel-exact values matter (colors, spacing,
typography), `design/README.md` is the authoritative token sheet — the summary in §14 is a digest.
The spec follows the prototype as closely as possible; every place it deliberately overrides the
prototype is listed in §20 — anything else that differs from the prototype is a spec bug.

**Section map** — ordered so later sections build on earlier ones:

- **Foundations:** §1 product · §2 components · §3 packaging & process lifecycle
- **Data:** §4 data model (entities) · §5 storage (files on disk)
- **Runtime:** §6 engine contract & framework policies (incl. §6.1 step SDK · §6.2 curated
  packages) · §7 execution lifecycle · §19 backend API
- **AI:** §8 agent drafting contract
- **UI:** §9 shell & navigation (incl. §9.1 automations list · §9.2 automation detail) ·
  §10 onboarding · §11 create/edit flow · §12 agents & secrets pages · §13 menu bar ·
  §14 design tokens
- **Dev:** §15 dev/test knobs · §16 test seed data · §17 repository · §18 commands
- **Appendix:** §20 deliberate divergences from the design prototype

## 1. Product overview

Auto Dave is a macOS desktop app for recurring personal automations. The user describes a job in
plain words ("Check the manga I follow for new chapters every morning at 8"); a connected AI agent
(Claude Code, Gemini CLI, Codex, OpenCode, or a local Ollama model) writes it as human-readable
scripts; Auto Dave executes those scripts on a schedule, entirely on the user's Mac, and shows results.

Core promises (exact UI copy, repeated in the onboarding footer):
- "Everything executes on this Mac"
- "Nothing executes until you review it"
- "Passwords stay in your Keychain"

## 2. Architecture

Four components (per top-level README):

- **Electron desktop app** — the UI. Recreates the design prototype pixel-faithfully (dark theme
  only). One window plus a menu-bar (tray) surface. Talks to the backend over a local API.
- **Python backend** — long-lived local service: owns the data store (automations, versions,
  executions, agents, settings), the scheduler (fires triggers even when the app window is closed),
  Keychain access for secrets, and orchestration of AI agents that draft/edit automation specs
  and step scripts.
- **Python engine** — executes an automation's steps as scripts, streams per-step status and logs,
  enforces the framework policies (§6), injects secrets at runtime, persists execution results.
- **CLI** — command-line access to the same backend: list/execute automations, tail executions, manage
  secrets and agents. Headless operation is a supported mode (§3), not just a debug aid.

**Stack (decided):** the Electron renderer is React 18 + TypeScript + Vite (state: one zustand
store mirroring the §4 model; markdown rendering is react-markdown + remark-gfm — see §4.5). The backend is Python 3.14 + FastAPI/uvicorn (PyYAML, keyring for
Keychain; request/response bodies are plain dicts — pydantic is not used directly). Transport is localhost HTTP (JSON) plus one WebSocket for live events —
the full API surface is §19. Packaging is decided — see §3. Storage is decided — see §5.

## 3. Packaging & process lifecycle (decided)

**The Python backend runs as a per-user launchd LaunchAgent, independent of the Electron app.**
Primary use case: a Mac left running unattended for days must keep firing triggers with no UI
open.

**Implementation status:** the launchd/CLI/discovery half is implemented (`service.py`, `cli.py`,
`backend.json`). The distributable build is implemented (`./scripts/prod.sh`, §18):
`Auto Dave.app` with the bundled relocatable Python in `Contents/Resources/python/` plus a DMG,
Developer-ID-signed with hardened runtime when `CODESIGN_IDENTITY` is set (ad-hoc otherwise).
Still not implemented: notarization submission, `SMAppService` registration from the app, and the
launch-time version-compare/re-register flow — today the only registration path is
`autodave service install`, whose plist points at the current interpreter (`sys.executable`), so
the packaged app does not yet register its bundled backend itself.

- The backend binary ships inside the Electron `.app` bundle; the app registers it as a
  LaunchAgent via `SMAppService` (ServiceManagement framework) during onboarding step 1. No sudo
  required.
- **Bundled Python (decided):** the app ships its own relocatable CPython (python-build-standalone
  builds) inside the bundle (`Contents/Resources/python/`). The backend, the engine, and every
  step script execute on this one interpreter. The system/user Python is never used, never required,
  and never installed — users install nothing, and every Mac gets the identical interpreter
  version. The launchd plist points at the bundled interpreter with `PYTHONHOME` set by the
  launcher (no absolute paths baked in). Packaging must codesign every Mach-O in the Python tree
  (binary + all `.so`/`.dylib`) with hardened runtime for notarization.
- launchd keeps it alive: `RunAtLoad` + `KeepAlive` (restart on crash). launchd also guarantees a
  single backend instance — the UI and CLI are always clients, never owners.
- Quitting the Electron app (window and menu bar) never stops the backend; the scheduler keeps
  running. The §4.9 `login` setting controls only whether the UI starts at login — the backend
  service stays registered regardless once onboarding completes.
- Discovery: the backend listens on localhost and writes its port + auth token to
  `~/Library/Application Support/Auto Dave/backend.json` (0600); UI and CLI read it to connect.
  Every backend start binds a fresh port and token, so the renderer re-reads `backend.json`
  (via the preload bridge) before each WebSocket reconnect attempt — a backend restart never
  strands the UI on a dead address.
- **One app process** (`requestSingleInstanceLock`): a second launch (a login item racing a
  manual open, `open -n`) quits immediately and focuses the existing window via the
  `second-instance` event — never a second tray icon, never a second §6 `POST /app-started`.
- Updates: on launch, the app compares its bundled backend version with the running service and,
  on mismatch, re-registers and restarts the service (never mid-execution — it waits for live
  executions to finish or marks them `interrupted`).
- Sleep: launchd does not prevent sleep. The backend holds a power assertion for the duration of
  an active execution, implemented as a `caffeinate -i` subprocess (prevents idle sleep mid-execution;
  forced sleep — lid close, low battery — can still suspend an execution); outside executions, normal macOS energy settings
  apply and missed occurrences follow the §6 missed-execution policy. For the always-on use case, the
  Mac's energy settings (or a "Prevent sleep" note in Settings docs) keep the machine awake —
  Auto Dave does not hold a permanent assertion.

**Headless mode (decided; CLI implementation may land later).** The backend and CLI must work with
no GUI ever launched:

- **API parity** — every operation the UI performs goes through the backend API; the UI holds no
  private logic. The CLI is a second client of the same API and can reach full coverage without
  backend changes.
- **Bootstrap** — `autodave service install` registers the backend by writing a launchd plist to
  `~/Library/LaunchAgents/` directly (same service the app registers via `SMAppService`; the two
  paths are equivalent and mutually exclusive — install detects and adopts an existing
  registration). `service uninstall`, `service status`, and `service restart` accompany it.
- **Keychain constraint** — secrets live in the login Keychain, which is locked until the user
  session unlocks. Headless operation requires a logged-in (auto-login acceptable) session on the
  Mac; pure SSH-only operation without a login session cannot read secrets. Documented, not worked
  around.

## 4. Data model

**Identity rule: every entity id (automation, execution, agent — any `id` field anywhere) is a
UUID (v4, lowercase hyphenated string). No sequential or slug-derived ids.** Version numbers
(`v1`, `v2`…) are labels, not ids, and stay integers.

Single central model drives everything. Top-level:

```
surface: onboard | app | create | menubar
page: automations | automation | executions | execution | agents | agentNew | secrets | settings
autoId, execId: current selections
autos[], execs[], agents[], secrets[], settings, onboarding state, create state, transient UI state
```

The on-disk representation of these entities is §5.

### 4.1 Automation

```
id: uuid
name, desc: strings
version: int (current)
triggers: ordered trigger list (§4.3) — user-owned, never versioned; the cron subset is
  re-derived from the spec when an edit is saved (§4.3)
triggerChip: derived chip string (§4.3): one trigger → its short label, several → "N triggers",
  empty → "No triggers"
triggersOff: bool — derived: the list is nonempty and every trigger is off (drives the OFF tag)
nextAt: epoch ms of the next enabled occurrence across all triggers (§4.3) | null
instr: optional multiline free-text user instructions to the agent
lastStatus: succeeded | executing | failed | cancelled | interrupted | none
live: execution id while an execution is in progress, else null
resultChip: short summary chip ("2 new chapters") | null — the chip is optional: null when the
  last successful execution never called result.chip(); failed automations synthesize "Needs attention"
resultStatus: changes | ok | attention | null — tints resultChip with the §7 chip colors
  everywhere it appears (list rows included); null whenever resultChip is null; "attention" for
  failed automations
lastExecLabel: shared time label (below) | "executing…"
  Every relative time label in the app uses one shared scheme: "Today" | "Yesterday" | full
  weekday name ("Thursday", 2–6 days back) | the date in the user's locale format (year,
  month, day — e.g. "7/18/2026"). Labels that carry a clock time append it: "Today, 8:00 AM".
latest: last execution's result object + when-label, for the detail page
params: parameter list (§4.2)
memory: { size, updated } — per-automation memory directory between executions (any files/formats)
snapshots: [{ id, name, reason, when, version, size, files }] — the §6.3 memory snapshots,
  newest-first; name = user label | null, reason ∈ manual | pre-clear | pre-version |
  pre-restore, when = humanized time label, version = "vN" current at capture (pre-version:
  the version about to execute), size = humanized byte label, files = file count
snapshotSettings: { preVersion, preClear, preRestore } — booleans, the §6.3 automatic-snapshot
  toggles (all default true)
steps: [{ name, desc, code, agent?, agentId?, why? }] — code is human-readable script; agent marks
  a step that makes a query-only runtime model call (§6) — the script itself still does any changes
spec: block list [{ k: h1|h2|p|li, text }] — the human-readable spec
specMeta: "v3 · updated Yesterday" (shared time label)
versions: [{ v, when, note, spec, steps, instr, params }] — prior-version history, newest-first
  (the current version is not repeated in this list)
draft: unsaved edit snapshot (create-flow shape) | null
agentId: agent that writes/edits this automation
stepAgents, allowedSecrets: string[] — per-automation enablement (set on save)
```

### 4.2 Parameter kinds

| kind | fields | one-line summary | edit behavior |
|---|---|---|---|
| `toggle` | label, help, on | "On"/"Off" | switch |
| `list` | label, help, validate, lines[] | validate → "N links" (valid-URL count), else "N entries" | one input per line, add/remove; per-line URL validation (red border on invalid non-empty when validate); info line "N lines · G valid links[ · B needs attention]" |
| `kv` | label, help, rows[{k,v}] | "N entries" | key/value pairs, add/remove |
| `number` | label, help, value, min | value | digits-only; empty/below-min clamps to min |
| `text` | label, help, value, placeholder? | value or "Not set" | plain input |

Every edit saves automatically — there is no save or done action. Typing commits on a short
debounce (and on blur); toggle flips, row/line removals, and additions commit immediately. On
the automation detail page the `list`/`kv` editors are always fully shown — no
collapse/expand toggle (the one-line summary column still serves the execution page's
values-as-used block).

URL validity: `/^https?:\/\/\S+\.\S+/`.

Every definition carries a default: `toggle` → off, `number` → its `min`, `text`/`list`/`kv` →
empty. Definitions are versioned with the automation; values live in the top-level
`automation.yaml` and are matched by name and kind at execution/restore time (§5).

### 4.3 Triggers

An automation carries an ordered list of **triggers** — independent conditions that each start
an execution. Triggers are user-owned operational state (§5): editing them on the detail page
never mints a version and never involves the AI. The cron schedule additionally follows the
spec: **saving an edit (§4.4) replaces the list's cron subset with the draft's spec-derived
cron triggers** — a drafted entry that matches a stored cron on (`expr`, `tz`) keeps that
trigger's `id` and `off` state; other drafted entries arrive enabled with fresh ids; stored
cron triggers the draft no longer derives are dropped. `time` one-shots and `app_start`
triggers always survive a save untouched. Manual starts (Execute now, the menu bar, CLI) are
not triggers in this list — they always work, whatever the list holds.

Trigger shape: `{ id: uuid, kind, off: bool, …kind fields }` plus the backend-derived display
strings `label` and `short`. The backend assigns `id` to entries that arrive without one. Kinds:

| kind | fields | fires | label / short |
|---|---|---|---|
| `cron` | `expr`: 5-field cron expression · optional `tz` | at every match | humanized when simple (below), else the raw expression in mono |
| `time` | `at`: wall-clock ISO timestamp ("2026-07-20T15:00") · optional `tz` | once, then the trigger is consumed | "Once at Jul 20, 3:00 PM" / "Once Jul 20 15:00" |
| `app_start` | — | at every desktop-app launch (§6 firing path) | "On app start" / "App start" |
| `discord` · `imessage` · `pubsub` | — | future message triggers | — |

**Timezone (`tz`)** — optional IANA zone name (e.g. `Asia/Tokyo`) on `cron` and `time`
triggers. Absent → the machine's local time (labels unchanged). Present → `expr` matches and
`at` reads as wall clock **in that zone** (DST rules below apply in that zone); occurrences
convert to local time for `nextAt`, countdowns, and the scheduler. An unknown zone name is
rejected at the API (422), never stored. When `tz` is set, both display strings append the
zone's city — the last `/` segment of the IANA name, `_` → space — in parentheses:
"Daily at 8:00 (Tokyo)" / "Daily 8:00 (Tokyo)"; the raw-expression fallback and one-shot
labels get the same suffix.

Message triggers are reserved kinds only: they appear as "coming soon" in the UI (§9.2) and the
API rejects writing them with 422. Nothing else about them is specified yet.

**Cron dialect** (implemented in `schedule.py`, no new dependency): five whitespace-separated
fields — minute, hour, day-of-month, month, day-of-week (0–6, Sun = 0) — each `*` or a comma
list of numbers, ranges (`a-b`), and steps (`*/n`, `a-b/n`). Numbers only: no month/day names,
no `@daily` macros, no seconds field. Standard Vixie rule: when day-of-month and day-of-week are
both restricted, a date matching either one fires. Times are wall clock in the trigger's zone
(`tz`, default local); an occurrence erased by DST (spring forward) fires at the next valid
minute, and one repeated by fall-back fires once. Invalid expressions are rejected at the API
(422), never stored.

**Humanized cron labels** — exactly two shapes get words; everything else displays the raw
expression:
- `M H * * *` → "Daily at 8:00" / short "Daily 8:00"
- `M H * * D` (single day) → "Mondays at 9:00" / short "Mon 9:00"

**One-shot semantics** (`time`): `at` must be strictly in the future when saved (422 otherwise;
the check reads `at` in the trigger's `tz`).
The trigger is consumed — removed from the list — when it fires, and equally when its moment is
skipped (backend down when it passed, or superseded mid-execution, §6). It never lingers spent.

**App-start semantics** (`app_start`): fires when the desktop app launches — the Electron
process starting (§6 firing path), not a window reopening from the tray. No fields, no `tz`.
An automation holds at most one: a list carrying a second `app_start` answers 422 and nothing
is stored. It has no computable next occurrence — it never contributes to `nextAt` — and it
survives an edit save untouched (the cron-subset replace above only touches crons).

**Next occurrence:** each enabled (`off: false`) trigger computes its own next time — cron: the
next expression match strictly after now; time: `at`. The automation's `nextAt` is the minimum
across them, null when no enabled trigger has one. The countdown renders "next in Xd Xh" /
"Xh Xm" and refreshes every 30 s.

**Derived display:** `triggerChip` — one trigger in the list → its short label; several →
"N triggers"; empty list → "No triggers". `triggersOff` — nonempty list, every entry off; list
rows add an OFF tag to the chip (§9.1).

Detail-page trigger status line (under the §9.2 TRIGGERS rows):
- executing → "Executing now… the triggers are unchanged." (spinner icon)
- no triggers → "No triggers set — executes only when you press Execute now or use the menu
  bar." (pause icon)
- all off → "All triggers are off — won't execute on its own. Execute now and the menu bar
  still work." (pause icon)
- `nextAt` null but an enabled `app_start` exists → "Executes when this app next starts —
  Execute now and the menu bar still work." (clock icon); the detail-page trigger chip reads
  "`<triggerChip>` · on app start"
- `nextAt` null otherwise (e.g. an elapsed enabled one-shot not yet consumed) → "No upcoming
  occurrence — Execute now and the menu bar still work."; the chip shows just `triggerChip`,
  never a dangling countdown
- else → "Next execution in `<countdown>` (`<short label of the next trigger>`) · executes even
  when the app is closed." (clock icon)

### 4.4 Versions and drafts

- Saving an edit creates version N+1 (on disk: a fresh `versions/vN+1/` folder, then the
  `current_version` pointer flip, per §5), applies spec/steps/instr/stepAgents/allowedSecrets/
  agentId, replaces the automation's cron triggers with the draft's list (§4.3 cron-subset
  replace — triggers themselves stay unversioned), sets `specMeta` to "vN · updated Today".
  Prior versions are untouched.
- Leaving the editor with unsaved touched changes snapshots a **draft** onto the automation
  (toast: "Draft kept — resume or execute it from this automation anytime."). Every exit path
  persists it — the header back button, system back/forward navigation, anything that closes
  the editor — never just the header button. Discard draft and Save as vN+1 settle the draft:
  leaving after either writes nothing (a discarded or saved draft is never resurrected).
- The draft snapshot carries the **full working state**: spec, steps, instructions, params,
  packages, the editor's trigger list (stored as a draft-only `triggers` key — the §4.3
  merged preview, so a resumed draft keeps a synced schedule change), and the editor's
  step-agents + allowed-secrets grant selections (stored as
  draft-only `step_agents` / `allowed_secrets` keys in `draft/automation/automation.yaml`, §5).
  Resuming restores the grant checkboxes from the draft; the automation's live
  stepAgents/allowedSecrets stay untouched until the draft is saved as vN+1. A Draft
  execution honors the draft's grants when present, not the live ones.
- **Create-mode drafts persist too**, in the single pending slot `<root>/draft/` (§5).
  Opening the create flow creates the slot's container first — `draft/` with empty
  `memory/`, `workspace/`, `result/` (`POST /draft/open`, §19) — before any drafting, so
  §11 create-mode tests execute in `draft/workspace/` from the start. Leaving the create
  flow after a draft has landed (spec or steps present) keeps the full
  working state there — the same serialization as an edit-mode draft, plus the identity
  fields no automation record exists to hold yet (name, chosen agent, enabled agents,
  triggers). Opening the create flow while the slot exists resumes it straight on the
  Review page (toast: "Resumed your unsaved draft — Start over discards it."); the §9.1
  list header surfaces the slot as a Resume draft button, and its New automation button
  confirms then deletes the slot to start fresh. Start over
  (and Back to Ask) deletes the slot. Create consumes it: `versions/v1` is written from
  the sent draft and `<root>/draft/` is deleted — a settled draft is never resurrected.
  One pending draft at a time: every keep overwrites the slot. Leaving with nothing
  landed just leaves the empty container behind; the next open reuses it.
- In edit mode the review footer shows a **Keep draft** bordered button placed directly to
  the left of the Save as vN+1 button (only while there is something to keep: touched
  changes or a stored draft). It leaves the editor through the same keep path as the header
  back button — so keeping the draft is a visible choice, not an accident of which button
  you noticed.
- Editor version menu lists: Draft ("your working copy — unsaved"), current vN ("current · …"),
  each older vN (date · note). Loading an old version shows a banner: "Loaded vX from history.
  Saving restores it as vN+1 — your draft stays in the Version menu." with a bordered
  **Back to draft** button; Save label becomes "Restore vX as vN+1".
- Detail page: old versions can **Execute once** without touching the triggers (toast: "Executing vX
  once — triggers and Execute now stay on vN."). The detail-page version menu carries a footer
  explainer: "Executing an older version once doesn't change anything — triggers and Execute now
  always use the current version. To make an older version current, open Edit and restore it from
  the Version menu." Draft banner offers Execute draft / Resume editing / Discard.
- **Execute draft executes on the draft's own memory** (`draft/memory/`, §5): seeded as a copy
  of the automation's live memory the first time the draft executes, then reused by every later
  Draft execution — so a draft iterates on one stable memory — and kept across draft re-saves
  from the editor. It is deleted with the draft (discard, or save as vN+1: the new version
  continues from the live memory, which no Draft execution ever wrote).

### 4.5 Execution (the stored record of one occurrence of an automation)

```
id: uuid, autoId: uuid, ver ("v3" or "Draft"), status,
trigger: Manual | Menu bar | Cron | Once | App start (future: Discord | iMessage | Pub/Sub) —
  the label of what started the execution (§4.3 kinds map cron → "Cron", time → "Once",
  app_start → "App start")
dur, started ("Today, 8:00 AM"), startedMs — dur accumulates across in-place retry passes (§7);
  started never changes on retry
steps: [{ name, file, status, dur, attempts: [{ n, status, dur, startedMs }] }] — file is the
  version-folder script filename (keys the per-attempt log files, §5); a step's status equals
  its latest attempt's status, or queued when it has no attempts yet; attempt statuses use the
  step vocabulary (§4.6); dur is the latest attempt's duration. On disk each step also stores
  `sha`, a short hash of the script as executed — the §7 Draft-retry drift check compares it,
  since a re-saved draft can change a step's code without changing its name or file
result: result object | null
redact: secret names redacted in logs (joined string) | null
note: optional note ("previous execution still in progress", "Mac went to sleep") | null
error: { step, message, reason | null } | null — failed executions only: the failing step's
  name, its error message (redacted), and a plain-word possible reason when the engine can
  classify the failure (§7 failure diagnostics). The same error is also stored on the failing
  attempt ({ message, reason }); the execution-level field mirrors the latest failing attempt
  and is cleared by a retry pass that succeeds (attempt history keeps the old error)
```

Logs are not part of the record payload: they live as per-step-attempt NDJSON files in the
execution directory (§5) and are fetched lazily per selected step/attempt (§19).

Result object:
```
{ chip?, chipStatus?: changes|ok|attention — both only when the execution set a chip, chips[],
  values: [{ name, value }] — value is a string (paragraph, multiline OK) or a list of strings
        (bulleted); rendered as label/value rows in the Summary view (§7),
  files: [{ name, size }] — every file in the result dir (result.yaml included), plus the dir
        path for the "Show in Finder" button }
```

The chip is optional — an automation may choose not to use one. It is stored on the execution
record itself (`chip` + `chip_status` columns in `executions.db`, §5): the engine copies
`result.chip(...)`'s text and the execution's `result.status(...)` (default `ok`) onto the record at
execution end, with no synthesized fallback text — an execution that never calls `result.chip()` shows no
chip anywhere.

On disk the rest of the result is a directory: the engine writes `result/result.yaml` (chips,
values — only when either is non-empty) at execution end; the execution writes any other output files
directly into `result/` (result.md, result.html, images, CSVs, …). There is no manifest — the
file list is the directory listing. Renderable files get their own result views (§7): `.md`
rendered as GitHub-flavored markdown — one shared Markdown component (react-markdown +
remark-gfm, app-styled; output is React elements, never injected HTML, so no sanitizer is
needed) used everywhere the app renders markdown, with one standard styling for every
surface: result views, the Build-instructions and Framework-instructions cards, and the
Spec cards (create flow and automation page — no spec-specific look; markdown renders the
same there as anywhere else) — `.html` in a sandboxed iframe (no
scripts, no remote loads — preserves the §6 no-exfiltration guarantee) with the app's base
result stylesheet injected, so plain semantic HTML renders in app typography and colors (a
page's own inline CSS overrides it), images inline; every other format appears only in the
file list. Tables are markdown tables inside result.md — there is no bespoke table renderer.
Files are part of the execution record — deleted with it by retention, never required for
list rendering (loaded only when the execution is opened).

### 4.6 Statuses (single badge vocabulary, executions and steps)

queued (gray) · executing (cyan) · succeeded (green) · failed (red) · cancelled (gray) ·
skipped (gray) · interrupted (magenta) · none → "Not executed yet" (gray).

The same vocabulary applies to executions, steps, and step attempts. `skipped` on an
execution means the whole occurrence was skipped by the scheduler (§6); on a step it means
the user skipped that step mid-execution (§7).

### 4.7 Agent

```
{ id: uuid, name, desc, harness: Claude Code | Gemini CLI | Codex | OpenCode | Ollama,
  mode: default | ollama, model }
```
`desc` is an optional free-text description ("What this agent is for — shown on the Agents
page and given to the drafting agent"), rendered as the detail line on the agent card and
carried into the §8 grants yaml so the drafting agent knows what each enabled agent is for.
`model` is null unless `mode` is `ollama`, where it names the local Ollama model. A null model
means the app never picks or passes a model — the harness uses whatever model it is already
configured with. Display shows "Default configured model" when the model is null. One agent is
the app default; deleting an agent reassigns the default and warns which automations use it.
Only Claude Code and Ollama are selectable harnesses for now — Gemini CLI, Codex, and OpenCode
stay in the schema and the picker but are disabled (§12) until they're supported.

### 4.8 Secret

`{ name, desc, value, usedBy }`. Names uppercase, `[A-Z][A-Z0-9_]*` — sanitization (uppercase,
invalid chars → `_`) is UI input behavior; the backend validates strictly and rejects nonconforming
names with HTTP 422. `desc` is an optional free-text description ("What this secret is for — shown
on the Secrets page and given to the drafting agent"), stored next to the name in `secrets.yaml`
(never in the Keychain) and carried into the §8 grants yaml so the drafting agent knows which
secret to use. Values are arbitrary strings and may be multi-line (e.g. a PEM key). Values stored
in macOS Keychain, masked at rest; the API never returns secret values — show/hide applies to the
value being typed in the add/edit modal, not to stored values. Saving requires a value when the
name is new; saving an existing secret with a blank value keeps the stored value and updates only
the description. Step scripts reference them by name
(`secrets.NAME`); values are injected at runtime and redacted from logs. Because log lines are
redacted one at a time, each non-blank line of a multi-line value is redacted individually as well,
and the §6 agent-prompt scan likewise checks every non-blank line of a multi-line value, not just
the whole string. Deleting a secret in use warns: the automation "uses it by name and will stop
working."

### 4.9 Settings

```
login: bool        — "Launch at login" ("Auto Dave starts quietly in the menu bar.")
mbIcon: bool       — "Show in the menu bar" ("The quickest way to execute an automation.")
notif: attention | all — "Only when something needs attention" / "After every execution"
days: int ≥ 1 (default 90) — history retention; keepForever: bool disables cleanup
devMode: bool (default false) — "Developer mode" ("Logs every backend request and every AI
  request — including the full prompt — to the backend log.") — gates request logging (§5)
dataPath (default ~/Library/Application Support/Auto Dave/executions), dataSize
```
Show in Finder (everywhere it appears) opens the target directory itself in Finder when the
path is an existing directory (e.g. Execution data opens the executions dir, not its parent), and
falls back to selecting the item in its parent folder otherwise.
Execution-data section: Change then Show in Finder; Change opens the native macOS folder picker and the chosen
directory simply becomes the execution-data location — no move/cancel UI and no data migration: all
execution state lives inside the executions dir, so changing the path just points Auto Dave at
the new location (the old dir stays where it was).
The "Keep executions for" days row is hidden (not just disabled) while "Keep execution history forever" is
on. One **ON THIS MAC** card holds two rows: **"Automations & settings"** (the fixed path
`~/Library/Application Support/Auto Dave` with its own Show in Finder button — this location
is not changeable) above the **Execution data** row. A **DEVELOPER** card sits last on the page with
the single **Developer mode** toggle row (devMode above).

## 5. Storage (decided)

**File-first everywhere: YAML/markdown files are the persistence. Each execution's full record
lives in `executions.yaml` inside its execution directory — the directory is fully
self-contained (record + logs + workspace + result). A SQLite database
(`<dataPath>/executions/executions.db`) exists only as a list/filter index over the execution
headers; the yaml is authoritative. All derived state lives in memory and is rebuilt from disk
at every startup.**

On-disk layout under `~/Library/Application Support/Auto Dave/`:

```
settings.yaml
agents.yaml
secrets.yaml                   # names + metadata only; values live in the macOS Keychain
backend.json                   # port+token discovery handshake (§3), rewritten each backend start
electron/                      # Electron's Chromium profile (Cache, Cookies, Local Storage, …) —
                               # main.cjs redirects userData here so the root stays app data only
site-packages/                 # §6.2 declared packages, installed by the app via
                               # `pip install --target` — user-writable, survives app updates,
                               # safe to delete (re-ensured before the next execution)
harness-cwd/                   # empty cwd for harness CLI children (§6) — keeps their startup
                               # scans out of TCC-protected folders; never written to
draft/                         # THE pending create-mode draft (§4.4) — a single slot: created
                               # (with empty memory/workspace/result) the moment the create
                               # flow opens, deleted when Create or Start over settles it; same
                               # container shape as automations/<uuid>/draft/ below, plus
                               # create-only identity keys in its automation/automation.yaml
                               # (name, agent_id, enabled_agents, triggers, created_at,
                               # updated_at — no automation record exists yet to hold them):
  automation/                  #   the working copy (version-folder shape)
  memory/                      #   scratch memory copied by §11 tests; starts empty
  workspace/                   #   §11 create-mode test workspace — wiped per test
  result/                      #   §11 create-mode test result dir — wiped per test
automations/<uuid>/
  automation.yaml              # unversioned, mutable — user/operational state: id, name,
                               # current_version (pointer: current = versions/v<N>/),
                               # triggers [{id, kind, off, expr | at}], agent_id,
                               # enabled_agents, allowed_secrets,
                               # memory_snapshots {pre_version, pre_clear, pre_restore} —
                               # §6.3 automatic-snapshot toggles (absent keys default true),
                               # param_values {name: value} (user data, never pruned),
                               # created_at, updated_at
  memory/                      # memory directory carried between executions (engine contract, §6) — scripts
                               # store whatever files and formats they need; shared across
                               # versions
  memory-snapshots/<uuid>/     # §6.3 point-in-time memory copies, each self-describing:
                               # snapshot.yaml (id, name, reason, created_at, version, size,
                               # files) + memory/ (the recursive copy); no index file — the
                               # list is read from disk on demand; a dir without snapshot.yaml
                               # is a crash orphan (skipped, swept at the next creation)
  draft/                       # unsaved edit state — a container, not a version folder:
    automation/                # the working copy, same shape as a version folder; rewritten
                               # whole on every draft save; its automation.yaml also holds
                               # draft-only step_agents / allowed_secrets / triggers keys
                               # (§4.4 — the editor's grant selections and trigger list;
                               # never written for real versions)
    memory/                    # the draft's own working memory: created on the first Draft
                               # execution as a copy of memory/, reused by every later Draft
                               # execution and draft re-save, deleted with the draft — Draft
                               # executions never touch the live memory/ dir
    workspace/                 # the §11 test workspace: wiped at each test start, kept
                               # after the test for inspection, deleted with the draft
    result/                    # the §11 test result dir (output files + result.yaml,
                               # same shape as an execution's result/, §4.5): wiped at
                               # each test start, deleted with the draft
  versions/vN/                 # one folder per version — immutable once written
    automation.yaml            # when, note, desc, param definitions (§4.2: name, kind,
                               # label, help, default, …) + ordered steps manifest:
                               # steps: [{file, name, desc, agent?, agent_id, why}]
                               # + declared packages (§6.2, absent when none):
                               # packages: [{pip: "pandas==2.2.3", import: pandas}]
    spec.md                    # the version's spec as plain markdown (h1/h2/li/p blocks)
    instructions.md            # user's free-text instructions to the agent (§4.1 instr),
                               # plain markdown; absent when none were given
    NN-name.py                 # step scripts as real files, beside the manifest —
                               # agent- and human-editable
```

**Logs live outside the data dir**, at `~/Library/Logs/Auto Dave/` (macOS convention;
Console.app picks them up): `app.log` (backend application log), `backend.out.log` /
`backend.err.log` (launchd stdout/stderr), and dev.sh's `vite.log`. With `AUTODAVE_HOME` set
(§15) logs go to `<home>/logs/` instead, keeping dev/test sessions fully isolated.

**Agent-request framing in `app.log`:** every agent request (each `harness.invoke()` call —
drafting calls, repair rounds, and runtime agent steps alike) is written to `app.log` as one
framed block: a header line `>>>>> BEGIN YYYY-MM-DD HH:MM:SS TZ UUID <<<<<` when the request
is sent, then the request info (harness, model, prompt size) and the full prompt, then the
raw response (or the error, on failure/timeout), closed by a footer line
`>>>>> END YYYY-MM-DD HH:MM:SS TZ UUID <<<<<` when the request ends. `UUID` is one random
UUID (v4) per request, identical in a request's header and footer, so the pair can be matched
when concurrent requests interleave. Timestamps are US Pacific time (`America/Los_Angeles`,
so `PST`/`PDT` per season). The framing lives in `harness.invoke()` itself so no call site
can miss it.

**Request logging (behind the §4.9 `devMode` setting):** while Developer mode is on, the
backend logs to its console every HTTP request it serves (uvicorn access log at `info` level —
stdout, so `backend.out.log` under launchd) and every agent request — one `autodave.harness`
INFO line per `harness.invoke()` with the harness, the model (agent's, else the literal
"configured default"), and the full prompt (stderr, so `backend.err.log`). `./scripts/logs.sh` (§18)
follows both plus `app.log`/`vite.log`. Implemented as a logging filter that reads the live setting on
every record, so flipping the toggle applies immediately with no backend restart; while off,
only WARNING+ prints. The filter rides in on uvicorn's `log_config` handlers (uvicorn's own
dictConfig would wipe a filter attached to its loggers beforehand) and on the root handler for
`autodave.*` logs.

A version folder holds **what the agent wrote** (spec, instructions, steps + scripts, param
definitions, desc); the top-level `automation.yaml` holds **what the user owns and operates**
(identity, triggers, param values, agent choice, permission grants). Two consequences:

- **Permissions are never versioned.** `enabled_agents` and `allowed_secrets` are grants; they
  live only in the top-level file. Restoring or executing an old version must never silently
  re-grant a revoked secret or agent — a vX step needing a now-disabled agent/secret fails with
  the existing warnings (§11).
- **Params split into definitions (versioned) and values (top-level).** At execution/restore time
  they're matched by name and kind: match → current value; param since removed → last stored
  value (values are never pruned), else the definition's default; kind mismatch → default plus
  a `wrn` log line, never silent coercion. Every definition carries a default (§4.2).

There is no top-level copy of the "current" spec or steps: the current version is simply
`versions/v<current_version>/`, resolved through the `current_version` pointer in
`automation.yaml`. Saving an edit writes a fresh `versions/vN+1/` folder, then atomically
rewrites `automation.yaml` to flip the pointer (and apply any agent/secret/param changes) —
versions are append-only and never edited in place; only `automation.yaml` and `draft/` are
mutable. "Restore vX as vN+1" (§4.4) copies the vX folder to vN+1 and flips the pointer.

Executions live under `<dataPath>/executions/` (movable via Settings → Change data location;
automations stay put):

```
executions/
  executions.db                # SQLite (WAL) — a pure list/filter INDEX over execution
                               # headers; `executions.yaml` is authoritative, the engine
                               # writes both together (yaml first). One table:
                               #   executions: id (uuid PK), automation_id, automation_name
                               #     (snapshot at execution time — display fallback only),
                               #     version ("v3"/"Draft"), status, trigger, started_at /
                               #     finished_at (epoch ms; finished_at NULL while executing),
                               #     dur_ms, note, chip / chip_status (§4.5 — NULL when the
                               #     execution set no chip), error_step / error_message /
                               #     error_reason (§4.5 — NULL unless failed; denormalized
                               #     mirrors so list surfaces render without a yaml read)
                               #   indexes: (started_at DESC, id), (automation_id, started_at),
                               #     (status, started_at)
  <execution-uuid>/
    executions.yaml            # the full execution record (§4.5): header fields plus
                               # params (snapshot), redacted_secrets, error, note, and
                               # steps[] with per-step attempts[] ({n, status, started_at,
                               # dur_ms, error? on failed attempts}); rewritten atomically
                               # (temp+rename) on every transition
    logs/
      execution.ndjson         # execution-scoped log lines: package installs, secret
                               # failures, retry markers, the final failure line
      <stem>.a<n>.ndjson       # one log file per (step, attempt) — <stem> is the step's
                               # script file stem ("01-fetch-pages"), n the attempt number;
                               # line shape {ts, t, k: sys|out|wrn|err, seq, text}; seq is
                               # a per-file monotonic counter (renderer dedupe, §19); the
                               # file for (step, attempt) is derived by convention from
                               # executions.yaml — no index anywhere
    workspace/                 # cwd for every step of this execution — disposable per-execution
                               # scratch space, shared across steps (step 1 writes a file,
                               # step 2 reads it) and across retry passes (§7); deleted with
                               # the execution by retention
    result/
      result.yaml              # engine-written from builder calls: chips[],
                               # values[{name, value}] — only when either is non-empty
                               # (the chip itself lives on the execution record)
      <files>                  # any files the execution writes via result.path (result.md,
                               # result.html, images, CSVs, …) — no manifest, the dir
                               # listing is the file list
```

**Load model:** automations are **fully loaded at startup** — the backend walks `automations/`,
parses every top-level `automation.yaml` plus each `versions/vN/` folder (its `automation.yaml`
+ `spec.md` + `instructions.md` + step scripts), and serves all automation reads (lists,
detail, scheduler, menu bar) from memory. There is no automations table: the YAML files plus the
startup walk are the whole story. The id → path map, `has_draft`, and `nextAt` are derived
in memory during/after the walk; execution-derived display state (`last_status`,
`last_execution_at`, `live_execution_id`) is filled by one startup query for the latest execution
per `automation_id` and kept current as executions complete; `resultChip`/`resultStatus` read straight
off that latest execution's header (§4.5) — never from `result/`. `skipped` records never count as the
"latest" execution for this display state — they never ran, and §4.1's `lastStatus` vocabulary
excludes them (a mid-execution trigger skip must not shadow the live execution's final status/chip).

Executions load **headers-eagerly, bodies-lazily**: startup reads every header row from the
`executions.db` index into an in-memory `executions` table — one header per execution with
`id, automation_id, status, trigger, version_label, started_at, finished_at, dur_ms`, plus the
light display fields (`automation_name`, `note`, `chip`/`chip_status`, the §4.5 `error`
fields) — kept queryable by `trigger`, `status`, `automation_id`, and `started_at`; paths
resolve on demand from the id. The body (`executions.yaml` — steps, attempts, params,
redacted names — plus `result/` and log files) is read only when an execution is opened; the
live execution's in-memory record is the engine's own full record, so it needs no disk read.
The in-memory table is rebuilt from the DB at every launch. An automation folder whose
`versions/` is empty cannot resolve a current version and is skipped at startup with a
warning in the app log.

Rules:

- Every write goes disk-first (atomic temp-write + rename for files — `executions.yaml`
  included; a committed transaction for the `executions.db` index), then the in-memory state
  updates. A crash between the two self-heals at the next startup, since startup rebuilds
  everything from disk: after loading the DB index, startup scans `executions/` for
  directories the index doesn't know (crash between the yaml write and the DB upsert, or a
  DB schema wipe) and restores their header rows from `executions.yaml` — the yaml stays
  authoritative. Nothing exists only in memory.
- Retention cleanup (§4.9 `days`) deletes execution directories and DB rows, then their
  in-memory records.
- Changing the data location (§4.9) closes the DB connection first, updates `dataPath`, then
  reloads everything from the new directory. Nothing is moved — execution state is wholly
  contained in the executions dir, so there is no migration step.
- Logs stream as append-only NDJSON — nothing else written on the execution hot path; CLI can
  tail/grep them directly.
- Secret values never appear in any file — Keychain only, referenced by name.

**Terminology:** **execution** is the one and only term for a single occurrence of an
automation — in files, code, APIs, and UI copy alike. The verb form is **execute** ("Execute
now", "Executing", "Execute draft", "Execute once"). The word "run" is never used for this
concept anywhere; "running" survives only in its ordinary process sense (a daemon or the
backend being up).

**Directory naming:** automation directories are named by the automation's UUID — the same
`id` as in `automation.yaml`, so path and identity always agree, no collision handling exists,
and renaming an automation touches only the `name` field (the directory never moves). For
human browsability the folder name is intentionally traded away; the `name` inside
`automation.yaml` is the readable label. Execution directories are flat under `executions/`
and named by execution uuid; each execution record carries `automation_id` for the link back.

**Cross-references:** everything references an automation by `id` only — never by name.
The execution page resolves `automation_id` through the backend's in-memory automations to the
current path and current name (so renames show up everywhere immediately). The execution record also snapshots
`automation_name` at execution time as a display-only fallback: when the automation has been
deleted, its executions still render with the historical name (marked deleted). The snapshot is
never used for lookups.

## 6. Engine contract & framework policies (shown as reference in Review)

- **Scheduling & triggers** — one execution at a time per automation (the API answers 409; the
  toast copy is client UI). Enabled triggers fire independently; occurrences due at the same
  moment coalesce into one execution, and a trigger firing mid-execution is skipped, not queued
  (a one-shot `time` trigger is still consumed by that skip, §4.3). A failed trigger-fired
  execution is retried once after 5 minutes — once per failure streak, keyed on the automation:
  a retry that also fails is not retried again until a trigger-fired success resets it. The
  retry happens **in place** (§7 retry semantics): the same execution record re-executes from
  the failed step as a new attempt — not from scratch, and never as a new execution. **App-start firing:** the Electron main process calls §19
  `POST /app-started` once per app launch (on ready; while the backend isn't answering it
  re-reads `backend.json` and retries every 2 s for up to 60 s, then the occurrence lapses —
  no queue). The backend then starts one execution per automation holding an enabled
  `app_start` trigger; the mid-execution skip and the 5-minute failure retry apply as above.
  Reopening a window from the tray is not an app start.
- **Missed executions** — execute when possible: if a trigger's moment passes while the Mac is
  asleep (backend alive but suspended), the execution fires on wake. If the backend itself wasn't
  running when the moment passed, that occurrence is skipped entirely — no catch-up queue at
  startup; the next occurrence proceeds normally. At most one catch-up execution fires per wake
  regardless of how many occurrences — across all triggers — were slept through.
- **Reading web pages** — 10 s timeout; ≥ 2 s between requests to the same site; retry twice;
  respect robots.txt; user agent "AutoDave/1.0".
- **Workspace per execution** — every step executes with its cwd set to the execution's `workspace/`
  directory; scripts are executed in place from their version folder (or `draft/automation/`), never
  copied. All steps of an execution share the one workspace; it is disposable scratch space,
  not guaranteed to exist after the retention window.
- **Memory between executions** — one private `memory/` directory per automation, reachable from
  scripts via an injected path; scripts may store any files in any format there. Persists
  across executions and versions. Draft executions get `draft/memory/` instead (§4.4) — the
  live directory is never read (past the one-time seed copy) or written by a draft. Durable writes go to `memory/` (deliberate) or `result/`
  (output files via `result.path`) — the workspace is for everything else.
- **Notifications & results** — exactly one result per execution; at most one notification, at the end;
  notify only on changes (per the notifications setting). **Sender (decided):** the backend posts
  macOS notifications itself via `osascript -e 'display notification …'` — works headless with no
  UI process; the Electron app never posts.
- **Secrets & Keychain** — scripts reference secrets by name; values injected at runtime — each
  step receives only the secrets its own code references — and redacted from logs; a missing
  secret stops the execution before any step.
- **Agent steps are query-only.** A step's runtime agent call is a pure question → text-answer
  function; only step scripts make changes. The engine invokes the harness one-shot and
  non-interactive with the strongest tool-disabling flags each harness supports: Claude Code
  `claude -p --tools "" --strict-mcp-config --no-session-persistence`, Codex
  `codex exec --sandbox read-only --skip-git-repo-check`, Ollama via its local HTTP API (no
  tools by nature); Gemini CLI and OpenCode expose no tool-disable flag for one-shot invocations and are
  invoked bare (documented limitation). Every harness CLI child (drafting and runtime alike)
  runs with its cwd set to an empty `harness-cwd/` directory under Application Support: CLI
  startup project scans stay inside that empty folder and never enter TCC-protected locations
  (Photos, Music, Desktop, …), so macOS shows no permission prompts attributed to the backend.
  Secret values never enter a prompt: the engine
  redaction-scans the assembled prompt and fails the step (before sending) if any secret value
  appears. The reply is returned to the script as untrusted text/JSON — never executed or
  evaluated. Per-step timeout plus prompt- and output-size caps (200k chars each) apply; the full
  redacted prompt and response (up to those caps) are written to the step's attempt log
  file (§5) for audit.
  Worst-case prompt injection from fetched content is therefore a wrong answer in a result, never
  an action.

### 6.1 The `autodave` step SDK (decided)

Each step executes in its own subprocess (the bundled interpreter, cwd = the execution `workspace/`).
The engine's executor injects these globals — scripts may also `import autodave` for the same names:

- `params` — dict-like, values by param name (definitions merged with §5 value-resolution rules).
- `secrets` — attribute access by name (`secrets.SMTP_PASSWORD`); reading a missing/un-allowed
  secret raises and fails the execution (the missing-secret pre-check in §6 catches known references
  before step 1). Values never repr/print unredacted — the engine scans all log lines.
- `memory` — `pathlib.Path` of the automation's memory dir, plus `memory.load(name, default)` /
  `memory.save(name, obj)` YAML helpers.
- `execution` — read-only execution metadata: `execution.automation_id`, `execution.automation_name`,
  `execution.id`, `execution.step_index` (1-based), `execution.step_name`, `execution.trigger` (the execution's trigger label,
  e.g. `Manual` / `Cron`, §4.5). Assigning to any field raises.
- `log` — `log(text)` / `log.warn(text)` / `log.error(text)` → `out`/`wrn`/`err` NDJSON lines
  (`log.info` is an alias of `log`).
- `result` — builder used by the last step (any step may add): `result.chip(text)` (optional —
  an automation may not use a chip at all), `result.chips([...])`, `result.value(name, value)`
  (value: string or list of strings), `result.status('changes'|'ok'|'attention')` — at execution end
  the engine stores chip + status on the execution record (§4.5) and writes chips/values to
  `result/result.yaml`. `result.path` — `pathlib.Path` of the execution's result dir for direct file
  output (result.md, result.html, images, CSVs, …); any file dropped there is part of the
  result (§4.5), so there is no attach call, and tables are markdown tables in result.md.
- `notify(text)` — requests the end-of-execution notification (engine still applies the §4.9 setting
  and the one-notification rule). The notification title is the automation name, overridable by a
  param literally named `notification_title`.
- `agent.ask(prompt, data=None) -> str` — the §6 query-only runtime call, only in steps marked
  `agent: true`; executor invokes the step's harness one-shot, redaction-scans the prompt first.
  Convenience aliases `agent.read(data, prompt)` / `agent.write(data, prompt)` wrap it. Agent-step
  calls time out at 120 s (drafting calls use the §8 5-minute cap).
- `fetch_page(url) -> str` — HTTP GET honoring the §6 web policies (timeout, per-site spacing,
  retries, robots.txt, UA).

Executor↔engine protocol: stdout/stderr are captured line-by-line as `out`/`err`; structured calls
(log/result/notify) emit `@@AD@@{json}` control lines on stdout. Context (param values, secret
values, paths, agent config, execution metadata) arrives as JSON on stdin — never argv, never the
environment. The executor does export the non-secret pieces back out as env vars so child
processes a step spawns can self-identify: `AUTODAVE_AUTOMATION_ID`, `AUTODAVE_AUTOMATION_NAME`,
`AUTODAVE_EXECUTION_ID`, `AUTODAVE_STEP_INDEX`, `AUTODAVE_STEP_NAME`, `AUTODAVE_TRIGGER`,
`AUTODAVE_WORKSPACE`, `AUTODAVE_MEMORY_DIR`, `AUTODAVE_RESULT_DIR`. Param values, secret values,
and agent config never enter the environment; the executor never reads env as input.
`sys.exit()` in a step follows the CPython convention: no code / `0` is an ordinary early exit
(the step succeeds), an integer fails the step with that exit code, and `sys.exit("message")`
fails it with the author's message preserved as the error (`SystemExit: message`).

### 6.2 Curated & declared packages (decided)

Step scripts may import: Python stdlib, `autodave`, and the curated packages: `requests`, `httpx`,
`beautifulsoup4` (`bs4`), `lxml`, `feedparser`, `python-dateutil` (`dateutil`), `PyYAML` (`yaml`).
The curated list ships with the app (installed in the bundled interpreter) and is included
verbatim in the §8 contract preamble.

**Declared packages.** When a task genuinely needs a library beyond the curated list (the
task-solving ladder still prefers stdlib + curated first), the drafting agent declares it in
`manifest.yaml` (§8): `packages: [{ pip: "pandas==2.2.3", import: pandas }]` — one entry per
distribution, the exactly-pinned pip requirement (`name==version`, no ranges) plus the top-level
module it provides. Python transitive dependencies are pip's job and are never declared; what
must be declared is every **runtime companion** the task's usage needs beyond that — optional
extras and binary-bundling wheels (e.g. yt-dlp merging streams needs ffmpeg → declare
`imageio-ffmpeg` alongside it and wire its path in the step). The §8 contract instructs the
drafting agent to declare the complete set a task needs, so an execution never discovers a
missing companion at runtime. Declared packages extend the import allowlist for that version's steps only:
§8 validation and the executor's runtime re-check both accept stdlib + curated + `autodave` +
the version's declared imports (shared module `imports_check.py`, which takes the declared
names as an extra allowlist) and fail the step on anything else — the allowlist holds even for
hand-edited step files that never went through drafting.

**Install model — the user never runs pip.** Declared packages install into one shared,
user-writable directory, `<app-support>/site-packages` (§5), via the bundled interpreter's
`python -m pip install --target`, wheels only (`--only-binary :all:` — a source-only
distribution fails fast with pip's "no matching distribution" rather than hitting a compiler
users don't have). The bundle inside the .app is never written to (read-only,
replaced whole on update). The executor prepends this directory to `sys.path` for every step,
so deleting it (or an app update) is always recoverable. Installing is one idempotent "ensure"
operation shared by every call site: a fast installed-check first (distribution + exact version
present in the directory), pip runs only for missing or version-changed entries, and one
process-wide lock serializes pip runs. It happens at two moments through the same code path:

- right after a §8 steps call validates (job stage "Installing the packages"; per-package
  statuses ride the draft payload and render in the §11 Packages card) — the user learns about
  an install failure while still on the edit page, not when a trigger fires;
- before an execution's first step (§7) — self-healing after an app update, a cleared
  directory, or a save that skipped a failed install.

An install failure never blocks saving (§11); at execution time it fails the execution before
step 1 with the §7 category. The shared directory holds one version of each distribution — a
later automation's different pin upgrades it for all (accepted: single-user app; if a real
conflict ever shows up the fix is per-automation target dirs, not user-facing knobs).

**Updating pins — the app checks, the user decides.** Pins never change on their own: an
unattended automation must not change behavior because a library released overnight. On load
the edit page's Packages card asks PyPI for updates (§19 `POST /packages/outdated`, read-only:
per package, the newest stable non-yanked version that has a wheel compatible with the bundled
interpreter — the wheels-only rule applies to the check too; a network failure just leaves the
badges off). Installing an update stays behind an explicit per-row **Update** button (§11).
An update is manifest-first (§19 `POST /packages/update`): the new pin is written into the
current version's manifest and any draft of **every** automation declaring that distribution —
never just one, or the shared directory would ping-pong between pins at each pre-execution
ensure — and only then does the same ensure install it. The current version is edited in
place: a pin bump is not a behavioral edit, and creating a new version of N automations per
update would be worse. Older versions keep their pins, so restoring one restores its pin
under the same last-writer-wins rule above.

**Native tools (deliberately deferred).** System binaries (ffmpeg, tesseract, …) are not
installable — pip is the only channel. When a task needs one, the drafting agent prefers a pip
package that bundles a static binary (e.g. `imageio-ffmpeg` — binary ships inside the wheel;
the step passes its path to the tool) and returns a §8 blocker when no such wheel exists.
Future escalation, to build only when a real automation is blocked on a binary with no wheel:
a `tools:` manifest channel backed by a bundled micromamba installing exactly-pinned
conda-forge packages into `<app-support>/env/`, with the same ensure semantics (§8 install
stage, §7 pre-execution self-heal, §11 card rows) and `env/bin` prepended to step `PATH`.
Homebrew is never bundled (custom prefixes forfeit bottles → source builds on user machines).

### 6.3 Memory snapshots (decided)

Point-in-time copies of an automation's `memory/` directory, restorable from the §9.2 MEMORY
card. Memory is the app's only mutable state with no version history; snapshots make its
destructive moments recoverable.

- **Layout** — `memory-snapshots/<uuid4>/` beside `memory/` (§5 tree): `snapshot.yaml`
  (`id` = the dir name, `name` = user label | null, `reason`, `created_at` ISO-8601 local,
  `version` = "vN" label, `size` = total bytes, `files` = file count) plus `memory/`, the
  recursive copy. Each snapshot is self-describing; there is deliberately no index file. The
  list is read from disk on demand, newest `created_at` first — nothing cached, per the §5
  rebuild-from-disk model.
- **Reasons** — `manual` (MEMORY-card button, optional name); `pre-clear` (automatic, taken
  before §9.2 "Clear memory" empties the dir); `pre-version` (automatic, taken by the engine
  right before the first execution of a version with no recorded execution yet — real "vN"
  versions only, never Draft — a Draft execution runs on `draft/memory/` (§4.4) and can't
  touch the live dir; `version` in the meta is the version about to execute);
  `pre-restore` (automatic, current memory saved right before a restore replaces it).
- **Automatic-snapshot toggles** — every automatic reason has a per-automation on/off setting,
  edited on the §9.2 MEMORY card and stored top-level as
  `memory_snapshots: {pre_version, pre_clear, pre_restore}` (§5 — user-operational state,
  never versioned; absent keys default **on**). A reason toggled off skips its snapshot
  silently — the action itself (execution, clear, restore) still proceeds, it just leaves no
  snapshot behind, and the §9.2 confirm copy warns the step is then not undoable. Manual
  snapshots have no toggle — the button is the consent.
- **Empty memory is never snapshotted** — automatic reasons silently skip; a manual snapshot
  of empty memory answers 422.
- **Write order** — the `memory/` copy first, `snapshot.yaml` last. A dir without
  `snapshot.yaml` is a crash orphan: listing skips it, the next snapshot creation deletes it.
- **Restore** — 409 while an execution is live. Takes a `pre-restore` snapshot of current
  memory (when non-empty and the toggle is on), then replaces `memory/` with the snapshot's
  copy. The restored snapshot itself stays — restore is repeatable and, via `pre-restore`,
  undoable.
- **Manual snapshot** — 409 while live (a mid-execution copy could catch a half-written
  file). Automatic reasons never race an execution: `pre-version` runs before step 1,
  `pre-clear` rides the clear request (§7: one execution at a time per automation).
- **Retention** — at each creation, unnamed snapshots beyond the newest 5 are pruned. Named
  snapshots are never auto-deleted — naming pins one until the user deletes it (or the
  automation is deleted). Renaming to empty returns a snapshot to the unnamed pool.
- **Lifecycle** — snapshots live inside `automations/<uuid>/`, so deleting the automation
  removes them (the §9.2 delete copy — memory goes with it — already covers this). "Clear
  memory" empties `memory/` only; snapshots survive it by design.

## 7. Execution lifecycle

- One execution at a time per automation. Starting while live: toast "Already executing — one execution
  at a time. A trigger firing now would be skipped."
- Start: execution record created with all steps queued; automation gets live id, lastStatus
  executing, lastExecLabel "executing…"; the execution appears at top of Executions; sidebar counts
  and menu-bar rows update live.
- Before step 1 the engine ensures the version's declared packages (§6.2): the fast
  installed-check costs milliseconds when everything is present; anything missing installs with
  a sys log line ("installing packages: `pandas==2.2.3`…"). An install failure fails the
  execution before any step with the package category below.
- Streaming: each step queued → executing → terminal status with duration. Executing a step
  appends an **attempt** (`n = attempts+1`) to that step; the step's status always equals its
  latest attempt's status. Each attempt streams into its own log file (§5) — the sys opener
  "▸ Step N — `<name>`", the step's own output, and its timeout/cancel/skip lines all land
  there; execution-level lines (package installs, secret failures, retry markers, the final
  failure line) go to `logs/execution.ndjson`. Then the execution gets its final status,
  duration, result object; automation gets latest/resultChip/lastExecLabel "Today"; toast
  summarizes. An execution whose steps include `skipped` ones but no failures finishes
  `succeeded`.
- Cancel: kills timers/processes; execution cancelled, the executing attempt and its step
  cancelled, queued steps cancelled, sys log "execution cancelled by you — nothing else will
  happen".
- **Skip step:** while a step is executing, the user can skip it (§19
  `POST /executions/{id}/skip-step` with the step index — 409 unless that exact step is the
  one currently executing, closing the finished-while-clicking race). The engine kills the
  step's subprocess, marks the attempt and step `skipped` (no error recorded), writes the sys
  line "step skipped by you — continuing with the next step" to the attempt log, and
  continues with the next step. If the process exited successfully before the kill landed,
  the step stays `succeeded` (sys line "skip arrived after the step finished"). A cancel
  arriving with a pending skip wins. Skipped steps are terminal — a later retry never
  re-executes them.
- **Failure diagnostics:** when a step fails, the executor reports the exception as a structured
  control event (exception type + message) alongside the traceback err lines; the engine stores
  §4.5 `error` on the record — the failing step's name, the message ("`ExcType: message`",
  redacted like any log line), and a plain-word **possible reason** when the failure matches a
  known category, null otherwise. Categories (deterministic, from exit code / exception type /
  message — never an agent call): step timed out ("The step hit its `N` s time limit.") ·
  disallowed import ("The step imports a package outside the allowed list.") · package install
  failed ("A required package couldn't be installed — check your connection, then execute
  again or retry from the edit page.") · missing secret
  ("The script references a secret that doesn't exist.") · agent call failed ("The step's agent
  call failed — the agent may be unreachable or misconfigured.") · network failure —
  connection, DNS, timeout ("A network request failed — the site may be down, blocking, or
  unreachable.") · HTTP error status ("The site answered with an error (HTTP `nnn`).") ·
  unexpected data shape — KeyError/IndexError/AttributeError ("The data didn't have the
  expected shape — a page or file layout may have changed."). Engine-level failures (missing
  script file, agent step with no agent) set `error` the same way. Shown on the automation
  detail page (§9.2) and the execution page.
- **Retry (in place):** a failed execution can be retried — the same execution record
  re-executes from the failed step; no new execution is created. The failed step's status
  flips back to `queued` (its attempt history stays), the execution goes `status: executing`
  with `finished_at`/`error`/chip cleared, and the engine re-enters the step loop, which
  executes exactly the steps still `queued` — succeeded and skipped steps are never
  re-executed and keep their attempts. Each executed step appends the next attempt. Same
  workspace (earlier steps' outputs are already there — nothing is copied), same result dir
  (a failed pass's stale result files may remain until steps overwrite them), accumulated
  duration (`dur_ms` sums the passes; `started_at` never changes). `exec.finished` fires
  again per pass, so the end-of-execution toast repeats — intended. Retry is allowed only on
  terminal `failed` executions and answers 409 while the automation is live, when the
  version no longer resolves, or — for a Draft execution — when the draft's steps changed
  since the record (a re-saved draft would pair old step statuses with new scripts; execute
  it fresh instead). Manual retries are uncapped; the §6 trigger auto-retry uses
  this same mechanism, capped once per failure streak.
- **Header actions** on the execution page: while executing, **Skip step** (quiet bordered,
  tooltip "Skip this step — kills it and continues with the next one"; skips the currently
  executing step) beside **Cancel**. A failed execution
  gets a primary accent **Retry** (tooltip "Retries this execution from the failed step.
  Steps that already succeeded keep their results.") plus a quiet bordered "Execute again"
  (tooltip "Executes the automation again from the start" — a plain fresh execution).
  Succeeded / cancelled / interrupted executions get only the quiet "Execute again".
- Trigger labels: Manual, Menu bar, Cron, Once (§4.5). `interrupted` covers e.g. "Mac went to sleep" — applied
  by startup recovery when a restarted backend finds stale `executing` executions; a sleep the
  backend process survives simply resumes the execution. `skipped`/`cancelled` executions may carry a
  note ("previous execution still in progress").

**Execution page:** back link, title row with status badge and the header actions above;
below the title a mono metadata line: full execution id (copyable) · trigger · version ·
started · duration. Body is a two-column layout: a **STEPS sidebar** plus a parameters block —
per param: label, its help description, and the §4.2 one-line summary value ("Values as used
by this execution."), and a main pane with **Results / Logs tabs** (auto-select Logs when no
result). The STEPS sidebar's rows are **selectable**: each row shows the status dot (pulsing
while executing), name, a right-aligned attempt-count chip ("×2", mono, faint — only when the
step has more than one attempt) and the latest attempt's duration — rows carry no actions;
skipping lives in the header's Skip-step button. Above step 1 sits an **"Execution log"**
pseudo-row (terminal icon in place of a status dot) selecting the execution-scoped log.
Selecting any row switches the main pane to the Logs tab for that selection. While the
execution is live the selection auto-follows the executing step until the user selects a row
themselves (reset when navigating to another execution); when a failed execution loads, the
failed step's latest attempt is auto-selected. On a failed
execution a **failure notice** sits above the tabs: red-tinted card, "Failed at step
`<name>`", the §4.5 possible reason as plain text when present, and the error message in mono.
The Logs tab shows the selected step's log (header: step name, or "Execution" for the
pseudo-row, plus the redaction note "secrets redacted: `<name>`"); when the selected step has
more than one attempt, a segmented **attempt control** sits in the header — one status-tinted
pill per attempt ("Attempt 2 · Failed · 3s"), latest selected by default. The pane is the
color-coded log view (kinds sys/out/wrn/err); logs load lazily per selected step/attempt
(§19) and live lines stream in over WS (deduped by `seq`), with live auto-scroll and the
blinking cursor on the live attempt. Empty state "No logs — this execution never started." The Results tab is a collapsible **Results section** holding a stack of individually
collapsible **result views**, each with a chevron + title header and right-aligned mono meta
("4 values", "4.1 KB") — everything expanded by default, collapse state per-session only
(never persisted). The section header row carries the result chip when the execution set one — tinted
by its chip status (changes = accent, ok = green, attention = orange); an execution that set no chip
gets no chip here — plus metadata chips; the execution's
own status badge stays in the page title row, never here. View order: first the **Summary
view** (result.yaml `values` rendered as a two-column grid — label column left, wrapping for
long names; value right: paragraph for a string, bullets for a list; 620 px measure — the
Latest Result card on the detail page uses 640 px), then one **file view** per renderable
file in alphabetical order (`.md` markdown, `.html` sandboxed iframe, images inline; titled
by filename), then a collapsible **FILES footer** ("FILES · N" header): the result-dir path
in mono, every file as name + size rows, and a "Show in Finder" button opening the dir in
Finder. No values but files present (even if none renderable) → the section is just the footer.
No values and no files at all → the whole view stack (footer included) is replaced by a dashed
placeholder card: "The latest execution didn't produce any result files."
Deleted-automation handling: historical name, marked deleted.

**Executions list:** all executions across automations; each row shows the automation name with
the full execution id (mono) on a second line beneath it, status badge, a trigger column combining trigger and version
("Manual · v3"), timestamps, durations; filter All / Succeeded / Failed. Rows carry no note
text — skipped/cancelled notes appear on the detail page's RECENT EXECUTIONS rows and on the
execution page.

## 8. Agent drafting pipeline (decided)

Drafting is a **two-call pipeline**: the backend first asks the agent to write the **spec**,
then — in a second, independent call — to build the **steps, parameters, and triggers** from
that spec. Each mode makes the calls it needs (see Modes below); `edit` stops after the spec
call and `sync` makes only the steps call. Both calls carry the same two
instruction files, invoke the chosen agent harness headless through a per-harness adapter
(`claude -p`, `gemini -p`, `codex exec`, `opencode run`, Ollama via its local HTTP API), and
parse one text response each. Everything below is harness-independent; adapters only translate
"send prompt, receive text." Agents never touch the data directory — the backend writes files
only after validation passes.

**Instruction files** (markdown next to the code, loaded at import — never inline in Python;
also served to the create/edit page via §19 `GET /instructions`):

- `backend/autodave/instructions/framework-instructions.md` — the contract preamble that travels
  with **every** call, written as structured markdown (headings, fenced code blocks for the
  envelopes and SDK reference, a table for parameter kinds): the agent's role, the generic
  file-block envelope (the per-call TASK directive
  names the exact files), the blocker envelope and when to use it, the task-solving ladder
  (deterministic code with curated libraries first; an agent step only when judgment is truly
  needed, its prompt kept small enough for a local model — narrow question, strict output
  format, reply validated in code), the `autodave` SDK reference with worked examples (a typical
  memory-diff last step; a validated `agent.ask` call), the curated package list, the parameter
  kinds table (§4.2), trigger- and step-design duties, the **failure-diagnostics duty** (a step
  that can't proceed raises an exception whose message names what it was doing, the exact input
  involved — URL, file, param — and what it expected vs found; HTTP failures include the status
  code; progress is logged as work proceeds so a failure's log tail shows the lead-up; never
  swallow exceptions or exit silently — the engine records the exception and shows it to the
  user, §7), and all five §6 policy sections. The §11
  Framework-instructions card renders this file as markdown.
- `backend/autodave/instructions/default-build-instructions.md` — the default best-practice
  build instructions, written as a markdown bullet list (never delete files, write only to
  memory/workspace, small single-purpose steps, prefer existing libraries over hand-written
  code, prefer deterministic code over agent steps, fail loudly naming what was expected and
  what was found, quiet executions stay quiet,
  track seen items in memory). In `create` mode, when
  the user gave none, the backend seeds `instr` from this file; the validated create draft
  carries `instr` back so the Review card arrives pre-filled — the user edits or deletes the
  rules freely, and they version like any instructions.

**Modes:** `create` (both calls, from the user's description) · `edit` (call 1 only: apply a
change request — the Review page's "ask the agent" box — to the in-editor draft's spec and
return the rewritten spec; the steps are untouched and a later `sync` rebuilds them) · `sync`
(call 2 only: regenerate steps to match the provided spec; the spec itself must not change).

**Call 1 — write the spec** (`create`/`edit`; skipped on `sync`). Step code never travels in
this call; the prompt just asks to update the spec from the user request. Both calls open with
`framework-instructions.md` (the role) and close with the task material — role first, task
last. Every prompt section opens with a `=== NAME ===` header line — one dialect throughout,
visually distinct from the response envelope's `===FILE: …===`/`===END===` markers (spaces
around the name, plain words). Sections in order:

1. `framework-instructions.md` (verbatim).
2. **Available agents** — the enabled agents as a yaml list, one entry per agent with `name`
   (falling back to the harness name), `description` (the §4.7 desc, omitted when empty),
   `harness`, and `model` (the literal `harness default` when the §4.7 model is null). An empty
   list renders the literal `none`. The header states its intent for the spec call: these
   agents can power judgment steps when the automation is later built — the spec must not
   promise AI judgment when the list is empty — and instructs the agent to use the entries to
   decide which agents the automation should use. The same yaml rendering applies to the
   call-2 grants context.
3. **Available secrets** — the allowed secrets as a yaml list, one entry per secret with
   `name` and `description` (the §4.8 desc, omitted when empty) — never values, memory
   contents, or execution logs; empty list renders `none`. The header instructs the agent to
   use the entries to decide which secrets the automation should use. For both grant lists the
   §19 body's grant arrays (the in-editor toggles) win over the stored automation's; absent
   both, the drafting agent's own entry and no secrets.
4. **Build instructions** — the user's standing rules (or the seeded default), context only;
   the agent never returns this file.
5. **Original spec** (`edit` only) — the current `spec.md`.
6. **USER REQUEST** — the description (`create`) or the change request (`edit`).
7. **TASK directive** — update the SPEC based on the USER REQUEST and return exactly one file
   block, the full updated `spec.md` (markdown, `#` title first, plain words, no code/yaml/file
   names); keep everything the request doesn't touch unchanged; with no original spec, write it
   fresh from the request. Ends with a short example spec (a `#` title, two `##` sections with
   bullets) pinning the expected format and tone.

Response: exactly one file block, `spec.md`. Validation: block present with no extras; must
start with an `# title`; must have body content. The parsed §5 blocks become the draft's spec.
On `edit` the job ends here — its draft payload is just `{ spec }`.

**Call 2 — build the steps** (`create`/`sync`; `sync` starts here with the provided spec — a
`spec` in the §19 body wins over the stored version's). Prompt sections in order:

1. `framework-instructions.md` (verbatim).
2. **TASK directive** — build the automation that implements the SPEC: derive the triggers,
   every parameter (each with a default), and the steps from the spec; return `manifest.yaml`
   plus one file block per step, no `spec.md`. Includes the manifest shape:

   ```
   ===FILE: manifest.yaml===
   name: Suggested automation name   # create only (ignored on sync)
   desc: One-line description
   note: Version note for the history menu (§4.4)
   triggers:                         # cron entries only (§4.3 dialect); omit the whole key if
     - cron: "0 8 * * *"             # the spec names no time (no triggers — manual/menu bar only)
     - { cron: "0 9 * * 1", tz: Asia/Tokyo }   # tz optional — only when the spec names a zone
   params:                           # full definitions per §4.2, each with a default
     - { name: sources, kind: list, label: Manga URLs, help: ..., validate: true }
   packages:                         # §6.2 declared packages — beyond curated only, exactly
     - { pip: "pandas==2.2.3", import: pandas }   # pinned; omit the key when none are needed
   steps:                            # ordered; file names NN-name.py, two-digit, gapless
     - { file: 01-fetch.py, name: Fetch pages, desc: ... }
     - { file: 02-classify.py, name: Classify updates, desc: ..., agent: true,
         why: needs judgment on chapter titles }
   ===FILE: 01-fetch.py===
   ...python source...
   ===END===
   ```
3. **Grants** — one section: enabled agents and allowed secrets, both rendered as the same
   yaml lists as call 1 (`agent: true` steps allowed only if the agent list is nonempty;
   secrets referenced by `secrets.NAME`), closing with the instruction to use the entries to
   decide which agents and secrets the automation should use.
4. **Build instructions** — as in call 1.
5. **Mode** — `create`: include a suggested `name`; `sync`: current param
   definitions and step scripts travel as reference ("rewrite them to match the SPEC, changing
   no more than the spec demands").
6. **SPEC** — call 1's validated `spec.md` (`create`) or the provided spec (`sync`).
7. **Closing envelope reminder** — one final line restating the response shape (return
   `manifest.yaml` plus one file block per step, no `spec.md`, end with `===END===`), so the
   format sits at the end of the prompt as well as in the TASK directive near the top.

**Envelope + validation** (backend, deterministic, before anything is written to `draft/`):

1. The parser ignores any prose before the first `===FILE:` marker; block content is verbatim; a
   response without the terminal `===END===` marker is treated as truncated and invalid.
2. Call 2 must return `manifest.yaml` and every file listed in `steps` — a `spec.md` block in
   call 2 is a validation error (the spec is already settled).
3. `manifest.yaml` is schema-valid: kinds from §4.2 only, every param carries a default, steps
   nonempty, `steps[].file` ↔ file blocks match 1:1, filenames follow `NN-name.py` ordering.
4. Every step file passes `ast.parse`; imports ⊆ stdlib + curated packages + `autodave` + the
   manifest's declared package imports (§6.2).
5. `packages` is optional: a list of `{ pip, import }` entries — `pip` an exactly-pinned
   requirement (`name==version`, no ranges or extras), `import` a valid module name that is not
   already stdlib or curated (declaring one that is, is a validation error — the list stays
   meaningful). After validation the job enters stage "Installing the packages" and runs the
   §6.2 ensure; per-package results ride the draft payload as
   `packages: [{ pip, import, status: installed | failed, error? }]`. An install failure does
   **not** fail the job — the draft lands with the failure visible in the §11 Packages card.
6. Step code is scanned for `secrets.NAME` references → drives the Review-screen secret warnings
   (§11). Unknown or un-allowed secret references are Review warnings, not validation failures.
7. Steps carry only `agent: true` as the query-only marker (§6); the backend assigns `agent_id`
   from the automation's enabled agents. `why` is required when `agent` is true.
8. `triggers` is optional and cron-only: a list of `{ cron: expr }` or
   `{ cron: expr, tz: zone }` entries — expression valid per the §4.3 dialect, `tz` a known
   IANA zone included only when the spec names one. The agent derives them from the spec's
   words and omits the key when the spec names no time (no triggers — the automation executes
   only via Execute now / menu bar). Applied when creating (v1's triggers, each `off: false`,
   shown on Review) and, via the §4.3 cron-subset replace, when a synced edit is saved as
   vN+1: the editor merges each sync's drafted crons into its trigger list (matched entries
   keep `id`/`off`, §4.3) and the save applies that list. Between saves the stored triggers
   stay user-owned (§5). One-shot and
   message triggers are never drafted — the user adds those on the automation page (§9.2).

**Blocker response (either call).** When the task cannot be built as asked — a needed
capability, grant, or framework policy makes it impossible — the agent returns, instead of its
file blocks, a blocker envelope:

```
===BLOCKED===
blockers:
  - reason: One sentence naming the problem.
    fix: The suggested resolution, in plain words.
    details: Optional longer explanation.
===END===
```

Validation: YAML with a nonempty `blockers` list; every entry carries a nonempty `reason` and
`fix` (`details` optional); no file blocks alongside it. `framework-instructions.md` tells the
agent to use it only for genuine impossibility (never mere uncertainty), to report **all**
blockers in one response, and to write plain words. A valid blocker envelope ends the job in
its own terminal state **`blocked`** — not `failed`: there is nothing to repair, so the repair
round below is skipped and no error is raised. A malformed blocker envelope is an invalid
response like any other (repair round, then failure). The blockers ride the job payload (§19)
and are logged with the invocation like any response. UI handling is §11's Blockers &
clarifications.

**Failure policy:** one automatic repair round **per call** — the same prompt plus the previous
raw response and the machine-generated validation errors. A second invalid response fails the
draft, surfaced in the §11 drafting cards (spec call: "The spec didn't validate — try again or
rephrase."; steps call: "The steps didn't validate — …"). Per-call timeout 5 minutes; cancelling
the job (Start over, or an edit that supersedes an in-flight steps call, §11) kills the harness
process. The job's `stage` tracks the pipeline ("Writing the spec" → "Generating the steps" →
"Installing the packages" — the §11 drafting-card labels; sync jobs start at the second, edit
jobs end after the first, and the install stage only appears when the manifest declares
packages). On
a create job, call 1's validated spec rides the job payload as soon as the spec call completes
(§19), so the §11 spec card can render it while the steps call is still working. Every
invocation's full prompt and raw response are logged to the app log as a §5 BEGIN/END-framed
block (never to execution logs) for debugging.

**Live progress.** A drafting call can run for minutes, so the job also carries a `detail`
line — a finer live-progress message under the coarse `stage` — derived from the harness's
**streamed** partial response. Every adapter streams: Claude Code runs with `--output-format
stream-json --include-partial-messages --verbose` (text deltas as they generate; the returned
text still comes from the terminal `result` event, falling back to the joined deltas), the
other CLIs are read line-by-line from stdout as they print, and Ollama uses `stream: true`.
The drafting job scans the accumulated partial text for the envelope's `===FILE:` markers and
sets `detail` accordingly: `Thinking…` before the first marker; `Writing the spec · N lines`
during call 1; `Writing the manifest — name, triggers, parameters, step list` and then
`Writing step i of n — NN-name.py · N lines` during call 2 (`i of n` comes from the
already-streamed manifest block once it parses as yaml; without it, just the file name); on a
repair round, `The response didn't validate — asking for a corrected one…` and then the same
messages prefixed `Second try — `; during the install stage, `Installing <pip spec>…` per
package (the §6.2 ensure's progress hook). Line-count updates throttle to one publish per
second; marker changes publish immediately. `detail` rides the job (§19 `GET /drafts`, beside
`stage`) and every `draft.progress` WS event, and resets at each stage boundary. A harness
that buffers its whole output simply yields no `detail` — the coarse stage labels remain.

**Issue-analysis call (§11 Test).** When a test's step fails, the backend makes one
more call with the same drafting agent: `framework-instructions.md` + the spec + the failing
step's code + its error and log tail + earlier steps' log tails (the cause is often upstream)
→ TASK: analyze the failure and return a **blocker envelope** — the same `===BLOCKED===`
format, `reason` holding what happened. One envelope shape means one parser, one validation
rule, and one §11 panel for build-time refusals and execution-time failures alike. Validation and
the one-repair-round policy apply as above; if the second response is still invalid the
analysis is dropped and the §11 Issue panel opens with the step's raw error instead. Same
5-minute cap, same app-log logging. Secret values never travel: the log tail is the
already-redacted execution output (§6).

## 9. Navigation & app shell

One 100 vh dark window with macOS traffic lights. The window drags from its top edge, Apple
Music-style: a fixed 18 px full-width drag strip spans the whole window top (above sidebar and
content, z-index 100), the sidebar's top 44 px is also draggable, and shell-less surfaces keep
their own 40 px sticky drag strip. Interactive controls inside drag regions stay clickable
(`no-drag` on buttons/links/inputs). 212 px fixed sidebar: logo + "Auto Dave", nav
(Automations, Executions, Agents, Secrets, Settings) with live count pills; content pane scrolls
independently. Navigation is state-driven (`surface` → `page` → detail ids); browser/OS back works,
but once past onboarding back never re-enters it. Page navigation (`go()`) always lands in the app
shell: if the create/edit surface is active, it exits back to `surface: app` — so sidebar tabs work
while editing an automation. Popovers close on outside mousedown. Toasts:
bottom-center, ~2.8 s default (some 2.6–5.8 s). One toast at a time — a new message replaces the
current one and replays the fade-up entrance. Centering must not use `transform` (the fade-up
animation animates `transform` and would knock the toast off-center while it plays); it uses
`left/right: 0` + auto margins + fit-content width.

Text selection is an allowlist: chrome (nav, titles, badges, chips, buttons, clickable rows)
is unselectable via a global `user-select: none`; content surfaces opt in with the `.ad-copy`
class — log pane, execution-id chip, parameter values, result Summary values, markdown/file views,
FILES footer (paths + names), file-load error lines, step script `pre`s (detail + draft
editor), the SPEC panel (detail page, plus the edit page's SPEC and BUILD INSTRUCTIONS
read-mode views), and the memory info line. Inputs/textareas are always selectable; the
sandboxed result iframe is selectable (its own document). Copying is native: highlight, then
right-click — the Electron main process shows a context menu with Copy on any selection (both
windows); text fields get Cut/Copy/Paste/Select All. There are no in-UI copy buttons.

Boot gate: until the renderer connects to the backend and loads the state snapshot, only the
plain window background renders. If boot is still pending after 300 ms, a centered logo +
spinner appears with "Connecting…" (or "Waiting for the Auto Dave backend…" once a connection
attempt has failed; boot retries every 1.2 s). Fast boots therefore show no splash flash.

### 9.1 Automations list

1200 px page, "Automations" title + New button. When the §4.4 pending create-mode slot
holds a draft (`pendingDraft` on `GET /state`), the header shows two buttons: a bordered
**Resume draft** button (opens the create flow, which resumes the slot straight on Review)
to the left of the primary **New automation** button — which then starts fresh: a danger
confirm ("Start a new automation? — Your unsaved draft will be discarded. This can't be
undone.") deletes the slot (`DELETE /draft`) before opening the create flow. Without a
pending draft, the single New automation button opens the create flow directly. One card per automation: name, description,
status badge, trigger chip (`triggerChip`, plus an OFF tag when `triggersOff`), result-summary chip when
the last execution set one (tinted by `resultStatus` with the §7 chip colors — same tint as the detail
and execution pages), and
an **inline execute button** per card (disabled while that automation is executing, tooltip explains
why). The card carries no last-execution label — `lastExecLabel` appears on the detail page and in the
menu bar. Empty state (dashed card):
"No automations yet. Describe a job in plain words — your AI writes it as scripts you can read,
and Auto Dave executes them on your schedule." with accent CTA "Create your first automation".

### 9.2 Automation detail

Back link ("‹ Automations"), title row: name, version chip dropdown (§4.4 Execute once + footer
explainer), status badge, Execute now (accent), Edit, ellipsis menu (Delete automation… in red).
Sections top to bottom:

- Optional **Draft banner** (§4.4), then **LATEST RESULT** card — the execution's chip (if it set one)
  + metadata chips, then the full §7 result view stack for the latest execution (Summary view at 640 px
  measure, file views, FILES footer — same collapsible behavior and chip rules). When the latest
  execution **failed**, the card opens with a red-tinted **failure notice** ahead of any result
  views: "Failed at step `<name>`", the §4.5 possible reason as plain text when present, the
  error message in mono, and a "View execution" link to the execution page. No-executions empty
  state (dashed
  card): "No executions yet / Press Execute now — the first result will appear right here."
- **TRIGGERS** card — one row per trigger (kind icon — fa-clock for
  cron, fa-calendar-day for time, fa-rocket for app start; §4.3 `label`; per-row on/off toggle;
  remove ×), the §4.3
  status line beneath the rows, and an **"+ Add trigger"** button opening an inline editor:
  kind picker (Cron / One time / App start; Discord, iMessage, and Pub/Sub render as disabled
  "coming soon"
  options) then either a cron-expression input with a live preview line (the humanized label
  when simple, plus "next: `<time>`"; an invalid expression gets the red input border and
  blocks Add) or a native date+time input that must be in the future; App start shows no
  input — just the preview line "On app start — executes when you launch the app", and its
  picker chip renders disabled (title "Already added") while the list holds one. Cron and
  One time add a
  **timezone select** below the input — first option "Local time" (the default; stores no
  `tz`), then every IANA zone (`Intl.supportedValuesOf('timeZone')`); a non-local choice is
  stored as the trigger's §4.3 `tz`, and the preview line (labels and "next:") reflects it,
  with "next:" always shown in local time. Empty list renders a
  dashed "No triggers" row. Trigger edits apply immediately (§19 PATCH) — no version, no AI.
  No Execute-now button here — manual execution lives in the title row and the menu bar.
- **PARAMETERS** — directly editable here per the §4.2 edit behaviors; caption "Changes apply on
  the next execution — no new version, no AI involved." Row layout splits by control size:
  `toggle` and `number` rows keep label + control on one line — the label side flexes to the
  available width, the control sits vertically centered at the row's right edge, and the help
  text runs below the label at full width. `text`, `list`, and `kv` rows stack — label (with
  the amber NOT SET tag when a text param has no value) and full-width help on top, the editor
  underneath spanning the full card width (text inputs capped at 520px).
- **RECENT EXECUTIONS** — execution history rows (status, trigger·version, time, duration, note text when
  present), linking to execution pages.
- **MEMORY** card — mono size/updated info line; "Show in Finder", "Snapshot" and "Clear
  memory" buttons. Clear swaps the button row to an inline confirm: "Next execution starts
  fresh, like the first time. Current memory is snapshotted first." (pre-clear toggle off:
  "Next execution starts fresh, like the first time. Automatic snapshots are off — this
  can't be undone.") with red Clear / quiet Keep. Snapshot swaps it to a name input
  (placeholder "Name — optional", Enter saves) with
  Save / quiet Cancel; the button is disabled when memory is empty (title "Memory is empty").
  Below the info row, the §6.3 snapshot list (absent when there are none): one row per
  snapshot — title (the name, else "Snapshot"), mono meta "reason · version · size · files ·
  when", quiet row actions Restore / Rename / Delete. Restore swaps the row to an inline
  confirm "Replaces current memory — the current state is snapshotted first." (pre-restore
  toggle off: "Replaces current memory — automatic snapshots are off, so the current state
  is lost.") (accent
  Restore / quiet Keep; blocked while an execution is live — the 409 surfaces as a toast);
  Rename swaps to a name input (Save / Cancel; empty clears the name back to "Snapshot");
  Delete swaps to "Delete this snapshot?" (red Delete / quiet Keep). Toasts: "Snapshot
  saved." / "Memory restored — the next execution continues from the snapshot." / "Snapshot
  deleted."
  At the card's bottom, the "Automatic snapshots" section — the §6.3 toggles, one `Toggle`
  row per automatic reason, each with a plain-language explanation so users know exactly
  what they're switching off:
  - "Before a new version executes" — "Saves a copy of memory right before the first
    execution of a newly saved version, so you can restore how memory was if the new
    version mishandles it." (pre-version)
  - "Before clearing memory" — "Saves a copy right before Clear memory empties the
    directory, so a clear can be undone." (pre-clear)
  - "Before restoring a snapshot" — "Saves a copy of the current memory right before a
    restore replaces it, so a restore can be undone." (pre-restore)
  Edits apply immediately (§19 PATCH `snapshotSettings`) — no version, no AI.
- **STEPS** card — read-only step rows (number, name, desc, view/hide script with §11 `PyCode`
  highlighting; agent steps show the "Why an agent" note when expanded). Step tags are
  display-only — never menus: an agent step carries a tag with the assigned agent's name (robot
  icon, tooltip = the step's `why`; the step's `agentId` resolved against the agents list, name
  fallback "agent" if the agent no longer exists), and a step whose code references
  `secrets.NAME` carries one key-icon tag per secret name. Agents and secrets are changed on
  the edit page.
- **SPEC panel** — collapsible (expand/collapse header toggle), expanded by default; the automation's spec blocks rendered through the shared §4.5 Markdown renderer, footer: "The AI regenerates the steps from this
  document when you edit it. Every change mints a new version — older ones live in the Version
  menu on the edit page."

**Delete confirm modal** — "Delete this automation?" / "`<name>` will be deleted — its triggers
stop, and its versions and memory go with it. Past results stay in Executions." When an execution is
live an amber line is added: "An execution is in progress — deleting cancels it." (confirming cancels
the execution, then deletes). Buttons Cancel / red "Delete automation".

## 10. Onboarding (3 steps, step label top-right in mono)

Onboarding shows whenever `ad-onboarded` (§15) is unset — existing agents or automations do NOT
bypass it: step 1 always renders. When prior data exists (any agent or any automation), step 1's
Continue goes straight to the app shell instead of step 2.

**Step 1 — Welcome.** Logo, headline "Recurring jobs, done exactly the same way every time.",
then a live self-check card "Getting Auto Dave ready" with three steps (Checking your settings,
Loading your automations, Starting the execution engine) with pulsing dots and durations, ending in a "READY / All set"
well with chips (Settings created, Folders in place, plus "Agent found" if an agent is already
configured and "Automations found" if automations already exist). Continue appears only when
done; its label is "Continue →" when prior data exists (going straight to the app), otherwise
"Connect your AI →".

**Step 2 — Connect your AI.** A searching spinner ("Looking for an AI already on this Mac…",
shown ≥1.9 s), then detected apps as radio-select "FOUND ON THIS MAC" cards (Claude Code / Ollama /
Codex / Gemini CLI / OpenCode, each with a version/sign-in detail line — see §20 on the
prototype's smaller detection set), with suggestion cards for providers not found shown alongside
(e.g. the free-local card still appears when only Claude was detected). When nothing is detected,
a note card renders instead of the found list: "No AI app was found on this Mac — here are two
suggestions for moving forward." The two suggestion cards:
- **Use Claude** — state machine: idle → installing (labelled progress bar with %) → macOS sudo
  prompt (amber pulsing dot, "Auto Dave never sees your password") → waiting for browser
  sign-in (reopen / cancel) → connected.
- **Use a free local AI** — Ollama + Qwen3 8B, "Download and install · 5.2 GB": install Ollama →
  download model (two-step progress, continues in background), same sudo handling, ends
  "Ready to go."

If more than one AI ends up ready, radios pick which one Auto Dave uses ("N AIs are ready — pick
the one Auto Dave should use. You can switch anytime under Agents."); Continue label becomes
"Continue with `<name>` →". "Skip for now" always available. Persistent footer: the three green-dot
promises (§1). On continue, connected providers are committed as agent records and any existing
automations get the chosen default agent.

**Step 3 — First automation.** The Create flow (§11) labeled "Step 3 of 3", skippable.

Onboarding state persists across steps: Back from step 3 returns to step 2 with detection
results, connect states, and the chosen provider intact (no re-search), and any in-flight
install/download machine resumes where it left off — the model download "finishes in the
background" as promised. The prototype's denied branch ("Install paused — permission was
declined", retry) is deliberately not implemented: the install machines are simulated and
always grant sudo, so the state was unreachable dead UI; it returns when the installs become
real.

## 11. Create / edit flow

Entry: New button, onboarding step 3, or Edit on a detail page. If no agents exist (outside
onboarding), redirect to Agents with toast "No agent yet — add one here first. Creating and
editing automations needs an AI."

**Ask.** 620 px column, "What should Auto Dave do for you?", 4-row textarea, then an
"OR START FROM AN EXAMPLE" eyebrow over icon-led example chips (fa icon + label; accent-tinted
border/background on hover, 1 px press-down on :active): Track manga chapters (fa-book-open) /
Back up a folder every night (fa-box-archive) / Email me a weekly report (fa-envelope) / Watch a
product's price (fa-tag) / Tidy my screenshots folder (fa-broom). "Written by `<agent>`" dropdown
(footer: "Auto Dave still executes everything"), CTA "Draft the automation". Empty text blocks with
"Describe the job first — one sentence is enough."

**Drafting on Review — no separate building screen.** "Draft the automation" starts the §8
create job and navigates **straight to Review**, which renders in a drafting state and fills in
as the pipeline delivers, driven by the job's `stage` over `draft.progress`:

- **Title row** — name shows the placeholder "New automation…" until the spec lands, then the
  spec's `#` title as the provisional name; call 2's manifest `name` replaces it. The Start over
  ghost cancels any in-flight job and returns to Ask with the description intact.
- **Spec card** — force-open, spinner + "Writing the spec…" (agent label). The moment call 1
  validates, the spec renders — while the steps are still generating — and is readable and
  editable right away.
- **Right column** (steps, triggers, parameters) — skeleton cards: "Waiting for the spec…"
  during call 1, "Generating the steps…" during call 2. During call 1 the label is plain
  text with no spinner anywhere in the right column; the steps card shows its spinner only
  once call 2 is actually running.
- **Live progress** — the busy card shows the §8 `detail` line under its stage label (spec
  card during call 1, steps skeleton during call 2), so a minutes-long call never looks
  stuck. The sync panel's in-flight line and the ask box show the same detail line while a
  sync / edit job runs. No detail (a non-streaming harness) leaves just the stage label.
- **Editing while the steps generate** — any spec / build-instruction / agent-ask / grant change
  cancels the in-flight steps call (`DELETE /drafts/{jobId}`), keeps the landed spec, and marks
  the workflow out of sync; the standard sync panel rebuilds the steps. Catching a bad spec
  early costs nothing.
- **Failures** — a spec-call failure renders inside the spec card: the §8 spec headline,
  validation details beneath, **Try again** (new create job, same description) and **Back to
  the request** (Ask, description intact). A steps-call failure renders in the steps skeleton
  with the §8 steps headline and **"Rebuild the steps"**, which runs a §8 `sync` against the
  landed spec.
- **Saving** — blocked while any §8 job is in flight (Dirty gating below); a create draft
  cannot save until steps exist and are in sync.

**Blockers & clarifications.** When a §8 job ends `blocked`, the blockers render as cards —
headline "Your AI hit a blocker" ("… hit N blockers" when several), one card per blocker with
three labeled, editable text fields — **Reason** / **How to fix** / **Details** — pre-filled
from the agent's answer; the user edits any of them (usually the fix). Where the cards appear
and what the primary action does depend on which call blocked:

- **Spec call** (create) — the clarification case: the cards render **in place of the spec
  body inside the spec card**. The user answers by editing the fix text; primary **"Answer &
  rewrite the spec"** appends the cards to the description — one line per blocker,
  "`reason` — `fix`", using the edited text — and starts a new create job in place. Ghost
  **"Back to the request"** returns to Ask with the description preserved.
- **Steps call** (create) — the same Blocker modal over Review that `sync` uses (Dirty gating
  below): primary **"Apply to the spec & rebuild the steps"** writes each card into the landed
  draft spec under a `## Constraints & resolutions` section (created on first use, extended
  after), one bullet per blocker — "`reason` — `fix`" — then runs a §8 `sync` against the
  amended spec and the steps skeleton re-enters "Generating the steps". The resolutions live in
  the spec document itself, so they survive later edits and syncs and version like any spec
  text. If the rebuild blocks again the modal returns with the new blockers plus a muted
  "Previously resolved" list of this session's earlier resolutions, so a fix that didn't take
  is visible. Closing the modal leaves the workflow out of sync with the spec editable and the
  sync panel showing out of sync. No automatic loop cap — the cycle is user-driven and Start over/close always
  exits.

**Review.** 1800 px max-width page. Title row: name (single line, shrinks with ellipsis so a long name never pushes the
buttons out of the window), version dropdown (edit mode), agent picker, Start over ghost
(edit: "Discard draft"), primary Create/Save. Lede: "Read what your AI wrote. Change anything —
nothing executes until you create it." When an execution is live during an edit, a cyan pulsing banner
shows: "An execution is happening right now on vN. Saving won't interrupt it — that execution finishes on vN.
vN+1 takes over from the next execution (`<short label of the next trigger>`)." Sections (left column: spec, agents,
secrets, instructions, framework; right column: steps, triggers, parameters, packages, test):
- **Spec** — collapsible card (caret + `SPEC` header toggle; defaults open on create — it is
  the drafting surface — and on edit; force-open while the spec is writing, showing
  clarification cards, or being edited, and the Edit/Cancel/Save
  buttons + body + ask box hide when collapsed; collapsed, a faint one-line hint shows in their
  place — "What the automation should do, in plain words. The AI regenerates the steps from
  this document when it changes." — and clicking it expands the card, same as the other
  collapsed-section hints on this page). Editable as markdown-ish text (`#`, `##`, `-`,
  plain ↔ h1/h2/li/p blocks); the view state renders through the shared §4.5 Markdown
  renderer. Also an
  "ask the agent" box ("Edit with agent") — a multiline textarea (1 row min) that grows with
  its content, never scrolls (Enter sends, Shift+Enter inserts a newline) and starts one §8 `edit` job (spec call only) with the
  selected drafting agent (the automation's agent, falling back to the default agent): the agent
  receives the in-editor draft (spec + steps + build instructions) and the in-editor grants
  (enabled agent names, allowed secret names) and returns the rewritten spec. The steps are not
  touched: on success the spec is replaced and marked out of sync exactly like a manual spec
  edit (toast "Spec updated — the workflow is out of sync. Sync the steps before saving."), and
  the sync panel's "Sync now" rebuilds the steps later. While the job is in flight the ask box shows a
  spinner plus a ghost **Cancel** button that cancels the job (`DELETE /drafts/{jobId}`) — the
  draft is untouched and the request text returns to the ask box for editing (toast "Edit
  stopped — the spec is unchanged."); the Save hint reads "Rewriting the spec…"; on failure the backend's §8 error shows
  as a toast and the draft is untouched. A `blocked` outcome (§8) instead shows a persistent
  amber notice under the ask box — "Your AI hit a blocker: `<reason>` — `<fix>`" (one line per
  blocker, dismissible) — and the draft is untouched; the user rephrases the request. Spec/
  instructions/agent-ask edits are mutually exclusive (one edit at a time).
- **Spec undo** — one-level snapshot. Applying an agent rewrite (ask-box success) or an
  in-editor Save first stashes the previous spec blocks together with the dirty flags of that
  moment. While a snapshot exists, a ghost **Undo** button shows next to Edit in the spec-card
  header (hidden while the card is in an edit/busy/blocker/error state or a rewrite/sync job is
  in flight). Clicking it restores the snapshot's spec, clears the snapshot, and — only when the
  current out-of-sync cause is still the spec — restores the snapshot's dirty state too (so
  undoing the sole unsynced spec change unblocks Save; an intervening agent/secret change keeps
  its own out-of-sync state). Toast: "Last spec change undone." The snapshot is single-level —
  each new agent rewrite or in-editor Save replaces it — and it clears on a successful sync, on
  a repair-modal spec amend, and on loading a version from the Version menu. It lives only in
  editor state: it is not part of the serialized draft and does not survive leaving the page.
- **BUILD INSTRUCTIONS** — collapsible card holding the §4.1 `instr` free text, with view/edit
  states; the view state renders the text as markdown (same renderer as the Spec and
  Framework-instructions cards), first prefixing every bare line — one that starts no markdown
  block (heading, list item, table row, code fence) and sits outside any fence — with "- " so
  plain one-rule-per-line text still renders as a bullet list instead of collapsing into one
  paragraph; edit placeholder "Markdown — one rule per line: 'Prefer
  Python.' 'Never delete files — move them to the Trash.'", empty state "No instructions yet —
  press Edit to add standing rules." In
  create mode the card arrives pre-filled with the app's default best-practice rules (§8) —
  edit or delete them freely before saving.
- **Dirty gating** — any spec/instruction/agent-ask change marks the workflow out of sync and
  **blocks saving** until the sync panel's "Sync now" button makes one §8 `sync` call
  regenerating the steps ("Steps synced with the spec — review them, then save."). Grant
  toggles (agent enablement, secret allowance) never mark the workflow out of sync by
  themselves — grants are permissions (§5), not versioned content. Instead, grant sync state is
  **derived** from steps vs grants: the workflow is out of sync exactly while some step needs a
  grant it doesn't have — an agent step whose assigned agent (or, unassigned, any agent at all)
  isn't enabled, or step code referencing a Keychain secret that isn't allowed. Consequences:
  checking a grant no step uses, or unchecking an unused grant, leaves the workflow in sync and
  saves directly; check-then-uncheck is a no-op; unchecking a grant steps use locks saving, and
  either re-checking it (instant, no sync) or a sync (steps rewritten without it) unlocks.
  Checking an agent shows a passive hint toast ("`<agent>` is now available to steps — Sync
  with spec if the steps should be rewritten to use it."). One exception: a grant toggle while
  the steps are still generating cancels the in-flight steps call (see above) and therefore
  marks the workflow out of sync — the kept spec no longer has finished steps. While viewing an
  old version, grant gaps never lock Restore — permissions are not versioned (§5) and a vX step
  needing a now-revoked grant fails at execution time instead; the cards still warn. Sync state lives in a single **persistent sync panel** at the top of the right
  column, **above** the Steps card rather than inside it, because a sync rewrites the steps and
  the parameter definitions, not just the step list. The panel never disappears and uses the
  same card background as the other cards (`--bg-card` / `--border-card`); only its content
  changes with state: **in sync** — green dot, muted line "Steps are generated from the spec.",
  and a "Sync with spec" button that runs the same §8 `sync` call on demand; **out of sync** —
  amber dot, the reason line, the saving-is-locked explainer, and "Sync now"; **sync in
  flight** — spinner line "`<agent>` is rewriting the steps from your spec…" with the sync
  button replaced by a ghost Cancel button (a sync puts no spinner in the ask box — the ask box
  spinner belongs to the `edit` job only). Outside a sync the panel's sync button is disabled
  (never hidden) while any other §8 job is in flight, while drafting, while viewing an old
  version, and while the steps list is empty. **Inputs lock while rewriting** — while a sync
  or an agent-ask spec rewrite is in flight, every input on the review screen is disabled:
  the spec Edit and Undo buttons, the ask box and its "Edit with agent" button, the
  agent-enablement and secret-allowance checkbox rows (and the missing-secret add row), the
  build-instructions Edit button, the Test card's test-values editors and its "Test the draft"
  button, the version menu, the drafting-agent picker, and Discard draft / Start over. The only
  live control is the running job's Cancel button. Every disabled control shares one look:
  45 % opacity, default cursor, no hover response. The step list dims to the same 45 % opacity
  whenever it can't be trusted as-is: while the workflow is out of sync, while a sync is
  rewriting the steps, and while an agent spec rewrite is in flight. The Steps card header carries no in-sync badge (no "in sync with
  spec" check) — sync state lives only in the panel. The spinner carries
  a ghost **Cancel** button that cancels the in-flight sync (`DELETE /drafts/{jobId}`) no matter
  how it was started (sync panel, Blocker-modal apply, "Rebuild the steps"): the steps and spec
  are left untouched, the workflow stays out of sync, and the panel returns to its out-of-sync
  state (toast "Sync
  stopped — the workflow is still out of sync."). A `blocked` sync opens the Blocker modal (above): its
  primary button amends the in-editor spec (same `## Constraints & resolutions` rule) and
  repeats the sync; closing the modal leaves the workflow out of sync with
  the sync panel still showing it. Disabled Save shows an amber hint ("Sync and review the steps before saving." /
  "Finish editing the spec first…" / "Syncing steps…" / "Rewriting the spec…" /
  "Writing the spec…" / "Generating the steps…" / "Installing the packages…"); saving is also
  blocked while any §8 job is in flight, and the sync panel's button disables while one is.
  Disabling an enabled agent that steps still call locks saving
  through the derived grant gap above (toast "Steps X, Y are out of sync — `<agent>` is no
  longer available here. Re-enable it or sync the steps before saving."). The out-of-sync
  reason line names the cause: an agent gap ("steps call an agent that isn't enabled"), a
  secret gap ("steps use a secret that isn't allowed"), or a spec change ("these steps still
  match the old spec").
- **TRIGGERS** card — the editor's trigger list as §4.3 short-label chips + "Executes even when
  the app is closed. The schedule follows the spec — one-shots and on/off live on the
  automation page." Display-only: in create mode it shows call 2's drafted triggers (the ones
  v1 gets); in edit mode the saved triggers until a sync lands, then the §4.3 merged preview
  (drafted crons + surviving one-shots — what saving will store). Empty: "No triggers —
  executes only via Execute now and the menu bar."
- **PARAMETERS · YOUR AI ASKED FOR THESE** card — display-only in **both** create and edit
  mode, with a "READ-ONLY HERE" tag whenever the draft has params: each row shows the draft
  parameter's name, description, and a read-only **value summary** (the §4.2 one-line summary,
  right-aligned, ellipsized) — never inline editors. The summary's source: in create mode the
  drafted definition's default (the initial values v1 seeds — e.g. a URL the AI captured from
  the prompt); in edit mode the automation's live value, matched by name and kind (§5), so a
  drafted param without a stored match falls back to its default. Footer: "Values
  aren't part of a version — set them on the automation page after saving; for a test, set
  test-only values in the Test card." Value input lives on the §9.2 detail page (§4.2 edit
  behaviors) and, test-only, in the Test card panel below. Empty state:
  "No settings needed — your AI didn't ask for any."
- **Steps** — readable scripts with per-step read-only tags (same tag language as the §9.2
  detail page — never menus): an agent step shows a tag with its assigned agent's name (robot
  icon; the tag turns red when no enabled agent covers the step — it keeps the assigned
  agent's name when that agent still exists, and reads "no agent" only when no name can be
  resolved), a step whose code references
  `secrets.NAME` shows one key-icon tag per secret name, and a step that imports a declared
  §6.2 package (its top-level `import` name appears in the step's code) shows one box-icon tag
  per package, labeled with the import name. Which agent a step calls is decided by
  the draft's `agentId` (fallback: first enabled agent) — changing it happens through the
  agent-enablement card plus sync, not per step. An expanded step ("view script") renders its
  `code` with Python syntax highlighting — a self-contained tokenizer (`PyCode` in `ui.tsx`, no
  dependency) coloring keywords, constants, strings, numbers, comments, decorators, builtins,
  `def`/`class` names, and call names over the base mono `.ad-copy` `pre`. Language is always
  Python (§15); the same `PyCode` renders the detail page and the draft/create step editor. Agent steps without any enabled agent
  show a red warning ("Step N needs an agent, but none is enabled — the execution would fail there.
  Enable one below."). Per-automation agent enablement list with "X of Y enabled"; enabled
  agents called by steps show a "called by step N" note. The agents card is collapsible,
  defaults open, and is forced open while its warning shows.
- **Secrets** — step code is scanned for `secrets.NAME`; secrets in Keychain but not allowed, and
  secrets missing from Keychain, each produce warnings with fix affordances. A used-but-not-allowed
  secret is a grant gap (Dirty gating above): it locks saving until the secret is re-allowed or a
  sync rewrites the steps. A missing-from-Keychain secret only warns — adding the value through the
  fix row also allows it. "X of Y allowed". Collapsible card, defaults open, forced open while a
  warning shows.
- **PACKAGES** card — in the **right column**, below the Parameters card: display-only like
  Triggers and Parameters — the drafting pipeline owns the list; the user's only write is the
  §6.2 pin update below.
  One row per §6.2 declared package — the `pip` spec in mono plus a status chip:
  **installed** (green check) · **installing** (spinner) · **not installed** (amber — a
  saved automation whose packages went missing, found by the §19 check on page load) ·
  **failed** (red; the plain-word error beneath in mono, e.g. the §7 category wording with the
  pip stderr tail). Header counts "N of M installed" (no count when the list is empty). Amber
  and red rows share one **"Install" / "Retry"** button (the §19 install call; rows show
  spinners while it runs). Collapsible: defaults collapsed when everything is installed,
  forced open while any row is installing, not installed, or failed. Footer: "Your AI picked
  these Python packages for the steps. They install automatically — nothing for you to run."
  Empty state (like the Parameters card's): "No extra packages — the steps use only the
  built-in libraries." While drafting, the card shows the right-column stage label like
  Triggers/Parameters. In edit mode the page checks statuses once on load
  (§19 `POST /packages/check`); during a create/sync job the card fills from the job's draft
  payload statuses (§8). An install failure never blocks saving — executions self-heal (§7) —
  so the card carries the warning without gating Save.
  **Updates (§6.2 semantics):** on load the page also asks PyPI once per package list
  (§19 `POST /packages/outdated`, advisory — a failure leaves badges off). An outdated row
  shows an accent-tinted "→ x.y.z" badge after the pin and an **Update** button on the row; two or more
  outdated rows add an **Update all** row above the footer. The header appends "· K updates"
  while any row is outdated (count hidden at zero). Clicking updates via §19
  `POST /packages/update` — pin rewrite across every automation declaring the distribution,
  then install; the affected rows show the installing spinner, then the new pin with its
  fresh status, and a toast names how many automations were rewritten. Updates never force
  the card open and never gate Save.
- **Framework instructions** — read-only card showing `framework-instructions.md` **rendered
  as markdown** (the shared §4.5 Markdown component — full GFM; max-height 420 px with inner
  scroll). The file content itself is untouched —
  what is rendered is byte-for-byte what the agent receives. Content comes from §19
  `GET /instructions` (fetched once per app session and cached); the same response carries
  `default-build-instructions.md` as the fallback pre-fill for the Build instructions card.
  Collapsed hint and footer copy: built-in instructions the AI reads before writing anything,
  word for word — they update with the app, nothing for the user to maintain.
- **Test** — executes the draft's **real steps** through the same engine path as a real
  execution (there is no simulation mode). The card's header button reads **"Test the draft"**
  ("Test again" once a test has happened this editing session; Cancel while a test is
  executing) — never "Execute", which is reserved for real executions (§4.4 "Execute draft",
  §7 "Execute again"). A test uses: in-editor param values and grants; the draft's own
  directories — the same step executor as a real execution, pointed at the draft
  container's `workspace/` and `result/` (§5: `automations/<uuid>/draft/` in edit mode,
  the pending slot `<root>/draft/` in create mode) instead of an execution record's dirs,
  both wiped at each test start and kept after the test so the outcome can be inspected,
  deleted with the draft; and **scratch memory** — copied from the draft container's
  `memory/` when it exists (edit mode falls back to the automation's memory dir; create
  mode to empty) — the memory copy is discarded when the test ends, so a test can never
  poison the memory the deployed version reads (§4.1). **Test parameter values (create and edit mode):** when the draft has params,
  the card offers a collapsed "Set parameter values for this test" affordance; expanding it
  shows one editor per param (§4.2 kinds), prefilled in edit mode with the automation's
  current values (draft default when a param is new) and in create mode with the draft
  defaults. The edited values ride the §19 `paramValues` body field and apply to this test
  only — nothing is stored, and the read-only Parameters card is untouched. Left collapsed,
  the test uses the automation's stored values (edit) or the draft defaults (create), exactly
  like executing the draft. The collapse button reads "Use current values" in edit mode and
  "Use defaults" in create mode. Side effects outside memory are real (emails send, files move, notifications
  post per settings) and the card says so plainly. Step statuses (§4.6 vocabulary) and log
  lines (secret values redacted, §6) stream into the card live over the §19 `test.*` WS
  events; the test stops at the first failed step and is cancellable from the card. A test
  writes **no execution record** — it exists to iterate on the draft; the detail page's "Execute
  draft" (§4.4) remains the stored, `ver: Draft` path — but the result is produced exactly
  like a real execution's: the test writes `result/result.yaml` (chips/values, when either
  is non-empty) into `draft/result/`, and step scripts write output files there via
  `result.path` (§6.1). A succeeded test shows green plus its result summary in the card —
  chip + values, and the §4.5 files listing with the Show in Finder path (the draft
  container's `result/`) — with no agent call. On failure the card
  shows "Analyzing the failure…" (agent label) while the backend makes the §8 issue-analysis
  call, then opens the **Issue panel** — the same cards, fields, and editing as the Blocker
  modal, headline "The test hit an issue"; its primary button **"Apply to the spec & sync
  the steps"** amends the in-editor spec (same `## Constraints & resolutions` rule) and starts a
  §8 sync, and "Previously resolved" carries across rounds — build-time blockers and execution-time
  issues are one convergent repair loop with two entry points. If the analysis call itself
  fails, the panel still opens with the failing step's raw error as the reason and an empty
  fix for the user to fill in. Advisory: a failed test never blocks
  saving.

Create (new) → version 1, `lastStatus: none`, navigate to detail, toast "Created — nothing has
executed yet. Press Execute now when you're ready." Save (edit) → §4.4.

## 12. Agents & Secrets pages

**Agents.** List of agent cards with badge states Checking (cyan) / Connecting / Ready (green) /
Needs setup (amber). Statuses are cached in the renderer for the app session: each agent is
checked once, staggered, on the first Agents page visit that sees it (new agents get checked on
the next visit); later visits render the cached badge with no re-check. The cache entry for an
agent updates when its edit form saves ("Connecting" until the fresh result lands, §4.7 check
re-run right after the save) and when the reconnect flow's check answers (§12 form banner).
Each card shows the agent's `desc` detail line
and a **USED BY** row of clickable automation chips (fallback "Not used by any automation yet.").
Ready agents get inline "Check connection" — a real §19 `/agents/{id}/check` call timed by the
renderer: the badge returns to Checking while it runs, success toasts "`<name>` answered in
X.X s — ready.", failure flips the badge to Needs setup and toasts "`<name>` didn't answer —
needs setup." Ready agents also get an
inline "Edit" button and, when not default, an inline borderless "Make default" text button;
Needs-setup rows use an accent-primary "Edit" button instead. The row overflow menu holds only
"Remove agent…" (red, confirm modal). Default status is indicated by the absent "Make default"
button — no chip. Empty state (dashed card): "No agents yet. Existing automations still execute on
schedule — but you need an agent to create or edit them." + CTA "Add your first agent".

**New / Edit agent** form (720 px, one form — title and submit label switch to "Edit agent" /
"Save changes" when editing): pick harness (Claude Code / Gemini CLI / Codex / OpenCode /
Ollama — but Gemini CLI, Codex, and OpenCode are disabled for now: their cards render dimmed
with a gray "Not supported yet" badge, and clicking one toasts "`<name>` isn't supported yet.";
only Claude Code and Ollama are selectable, §4.7), mode (default model vs. local Ollama model),
model (required for Ollama mode), name
(required), optional description ("What this agent is for — shown on the Agents page and given
to the drafting agent"). The
submit button renders disabled-styled until valid but stays clickable: submitting with a missing
name shows an inline red error "A name is required — give this agent a name before saving." (red
input border, clears on typing); missing Ollama toasts "Install Ollama first."; otherwise "Pick
a harness and a model first." Success toasts: "`<name>` added — ready to write automations." /
"Changes saved — `<name>` is ready." When editing a signed-out agent, the form shows a reconnect
banner: "This agent is signed out — reconnect it to create or edit automations." + Reconnect
button. Ollama-dependent options (the Ollama harness, local-model mode) gated on Ollama being
installed and ready. Inline install flow: button "Install Ollama · 1.1 GB", installing label "Installing
Ollama… X.X GB of 1.1 GB". **LOCAL MODEL** picker: radio list of installed Ollama models with
size metadata, empty state "No local models installed yet — download one below and it will show
up here." Model pulls: one at a time — the backend streams raw `ollama pull` output over the
`ollama.pull` WS event and the UI parses the percent out of it (right column shows "N%";
determinate bar when a percent is present, indeterminate otherwise — see §20); suggested-model
chips fill the pull input (they don't start the pull); suggested models qwen3-coder:30b (19 GB,
"Best local coding model"), gemma4:e4b (9.6 GB, "Good local default"), deepseek-coder:6.7b
(3.8 GB, "Light and quick"). A suggestion chip is hidden when that model is already installed or
currently downloading; when no chips remain, the whole SUGGESTED section is hidden. Below the
pull input: link "Browse more models on Ollama ↗" (opens https://ollama.com/library).

**Secrets.** List with add/edit modal, masked values, delete confirm (§4.8). The list's NAME
cell shows the secret's `desc` as a muted sub-line when present. The name field is a
single-line input (Enter saves, Escape closes); its placeholder is a hint, not a literal example
value: "A short name, like MAIL_PASSWORD or CRM_API_KEY". Below the name sits an optional
single-line DESCRIPTION input (placeholder "What this secret is for — helps the drafting agent
pick the right secret"), pre-filled when editing. The value field is a 3-row vertically
resizable textarea (multi-line values allowed, §4.8) masked with `-webkit-text-security` unless
Show is toggled; Enter inserts a newline, Cmd/Ctrl+Enter saves, Escape closes; when editing, a
blank value keeps the stored one (§4.8) and the placeholder says so. The edit modal is titled
"Edit secret" with submit "Save changes"; add is "New secret" / "Save to Keychain". Toasts:
"Saved to your Keychain." / "Secret updated." / "Removed from your Keychain." When no secrets exist, the table is replaced by an
empty state (dashed card, same pattern as the Automations list): "No secrets yet. Add a password
or API key once, and your automations use it by name — the value never appears in a script or a
log." with an accent CTA "Add your first secret" that opens the add modal (all three empty-state
CTAs — automations, agents, secrets — are accent-primary; the page-header Add buttons on Agents
and Secrets are plain ghost buttons, no icons).

## 13. Menu-bar surface

Tray icon (circle-play) with red alert dot when any automation failed — implemented as a second,
non-template icon variant (`trayAlert.png`, mid-gray glyph + red dot, generated by
`scripts/gen_tray_icon.py`); the normal state uses the black template image. Panel: 334 px translucent
(blur), header row with "AUTO DAVE" eyebrow left and aggregate status right (mono 11 px; "All good
· N automation(s)" — pluralized by count — or "N need(s) attention" in red), one row per automation (7 px status dot —
pulsing while executing, name, mono sub-line colored by state: cyan "Executing now…" / red when failed
/ accent for a result chip / faint otherwise, bordered execute button at 35 % opacity that goes fully
opaque on hover (accent hover border), relative time right-aligned in a 56 px column). Row click opens the app on that automation; execute
button triggers a "Menu bar" execution. Footer: accent "Open Auto Dave" link + version. Click-outside
closes.

**Deep-link mechanism:** a row click sends the target `'/app?auto=<id>'` to the main process.
With no main window, the window is created loading that hash and the renderer's boot reads
`auto=<id>` to land on the automation's detail page. With an existing window, main pushes the
target over IPC (`open-target`) and the renderer navigates in place — never a page reload,
which would drop the WebSocket and all renderer state. The footer link sends plain `'/app'`
(focus only). Deep links are ignored while onboarding hasn't completed.

## 14. Design tokens (digest — `design/README.md` is authoritative)

- Dark theme only. Fonts: IBM Plex Sans (UI), IBM Plex Mono (timestamps, chips, eyebrows,
  metadata). Base UI 13 px; page titles 20 px/600; eyebrows 9.5–10 px mono uppercase.
- Backgrounds: window `#0b0e12`, content `#0e1116`, sidebar `#0a0d11`, cards `#12151c`.
  Text: primary `#e9ecf1`, secondary `#a8b0bc`, muted `#8a93a0`, faint `#67707c`.
- Accent (brand orange): `oklch(0.74 0.155 52)`; status colors green 150 / cyan 210 / red 25 /
  amber 85 / magenta 340 (oklch), tint backgrounds at ~13–15 % alpha. One extra chip color:
  orange `oklch(0.72 0.15 60)` for attention-flavored result chips (e.g. "5 of 6 checked").
- Radii: buttons/inputs 8 px, cards 12 px, pills 16–20 px. Cards flat (border only); popovers and
  toasts get large soft shadows.
- Button hover states come in two patterns. Shared chrome (`ui.tsx`, create/edit flow) uses CSS
  `:hover` classes in `tokens.css` (`.ad-btn-primary`, `.ad-btn-ghost`, `.ad-btn-soft`,
  `.ad-btn-text`[`.dim`], `.ad-btn-pill`, `.ad-btn-dashed`, `.ad-btn-x`, `.ad-chip-btn`,
  `.ad-menu-row`). Other pages (detail, lists, execution, menu bar, onboarding) use small local
  JS hover helpers — `useState` flag flipped by `onMouseEnter`/`onMouseLeave` (e.g. `HoverBtn`/
  `HoverRow` in `AutomationDetail.tsx`) — since pages may not edit `ui.tsx`. In JS `hoverStyle`
  overrides, set the full `border` shorthand (`border: '1px solid …'`), never `borderColor`
  alone — mixing shorthand base style with longhand hover override renders inconsistently.
- Icons: Font Awesome 6.5.2. App mark: accent rounded square with a hammer glyph (`fa-solid fa-hammer`).
  The same mark is the macOS dock icon (`app/electron/appIcon.png`, 1024 px, mark at ~80% of canvas,
  generated by `scripts/gen_app_icon.cjs`; set at startup via `app.dock.setIcon` in
  `app/electron/main.cjs` so dev sessions don't show the default Electron icon).
- Motion: fade-up entrances (.3–.5 s), spinners .8–.9 s, amber "waiting on you" pulse 1.2 s.
  Modals (shared `Modal` shell in `ui.tsx`: backdrop + card, used by the secret add/edit modal
  and `ConfirmModal`) animate both ways — enter .18 s fade-up, exit .12 s fade-down — and every
  dismissal path (backdrop click, Escape, Cancel, save/confirm) plays the exit before unmount;
  confirm actions fire after the exit finishes.
- Layout: page gutter 30–32 px, max width 1200 px (Review page 1800 px, forms 620–720 px,
  settings 640 px).
- Scroll chaining: inner scroll panels embedded in the page flow (spec viewer, test log
  pane, etc.) chain to the page — reaching their bottom continues scrolling the page (browser
  default; no `overscroll-behavior: contain`). Only floating surfaces (popovers, dropdowns,
  modals) may contain overscroll.
- Scroll chrome (`tokens.css`): 10 px WebKit scrollbars, white 10 % thumb (18 % hover),
  transparent track and corner; textarea resize grip (`::-webkit-resizer`) is an inline-SVG
  grip icon — two rounded diagonal strokes, white 28 % — so it stays crisp and never flips to
  WebKit's light default square when a scrollbar appears.

## 15. Dev/test knobs

**Dev/release parity rule:** dev and release share the SAME code paths — there are no mock modes,
no alternate backends, no dev-only branches in app code. The only knobs that exist are pure
configuration (they relocate or re-tune the same behavior, never select different behavior).
Every knob defaults to the release value and is developer opt-in; the single knob dev.sh sets
itself is `AUTODAVE_RENDERER_URL` (below — same renderer source, served with HMR instead of
pre-bundled). Dev sessions use the real app-support dir, real Keychain, real agent CLIs, random
port, request logging via the §4.9 devMode setting (§5), and the real launchd service (§18
dev.sh).

Frontend state (localStorage/URL — production mechanisms, not dev branches): `ad-onboarded`
(persisted onboarding completion; clearing it replays onboarding), `#menubar` URL hash (selects
the menu-bar surface — how the tray panel window loads). The renderer discovers the backend only
via `backend.json` through the Electron preload bridge; there is no browser-dev URL-param
fallback.

Backend env knobs (configuration only):

- `AUTODAVE_HOME` — overrides the app-support root (isolated dev/test homes); logs move to
  `<home>/logs/` (§5).
- `AUTODAVE_PORT` — fixed port instead of a random free one.
- `AUTODAVE_OLLAMA_URL` — Ollama HTTP endpoint override (default `http://localhost:11434`).
- `AUTODAVE_STEP_TIMEOUT` — per-step timeout in seconds (default 900).

Electron env knob (configuration only):

- `AUTODAVE_RENDERER_URL` — when set, Electron `loadURL`s the renderer from this origin (with
  the same `#/app` / `#/menubar` hashes) instead of `loadFile`-ing `app/dist/index.html`. It
  points at a Vite dev server serving the identical `app/src` source — HMR delivery of the same
  code, not a different code path (the preload bridge, `backend.json` discovery, and backend
  are untouched; the backend's open CORS covers the http origin). Set by `dev.sh` (§18);
  release never sets it.

Test doubles live in `tests/` only: a fake `claude` CLI at `tests/bin/claude` (conftest prepends
`tests/bin` to `PATH`, so the real detect/invoke/subprocess path is exercised against it) and conftest
fixtures that monkeypatch `keychain` (in-memory dict) and `notify.post` (no-op). Removed knobs —
do not reintroduce: `AUTODAVE_MOCK_AGENT`, `AUTODAVE_KEYRING`, `AUTODAVE_NO_NOTIFY`,
`ad-sudo-denied`, `?port=&token=` (the renderer dev server returned as `AUTODAVE_RENDERER_URL`,
above — `VITE_DEV`/`npm run dev:app` themselves stay gone).

## 16. Seed / demo data (tests only)

The shipped app has NO seed path: a fresh install always starts empty (onboarding), and there is
no CLI or API to populate demo data. The seed fixture lives in `tests/seed_data.py` and is
applied only by tests calling `seed(store)` (it refuses to seed when any automations exist).

The prototype ships four demo automations useful for tests: "Track manga
chapters" (cron `0 8 * * *`, list/toggle/number/text/kv params, result.md markdown table with a READ
column),
"Nightly folder backup" (cron `0 2 * * *`), "Weekly report email" (cron `0 9 * * 1`, failed, uses
`SMTP_PASSWORD`, retry-from-step), "Clean screenshots folder" (cron `0 21 * * 0`). Demo secrets:
`SMTP_PASSWORD`, `VAULT_DRIVE_KEY`. Twelve seed executions cover every terminal status including
skipped, cancelled ("previous execution still in progress") and interrupted ("Mac went to
sleep"); `executing` is inherently live and is not seeded. The fixture includes one execution
with a skipped step (execution still `succeeded`) and one failed-then-retried execution whose
failing step carries two attempts.

## 17. Repository structure

- `design/` — high-fidelity HTML prototype + design handoff README (authoritative tokens).
- `backend/` — Python package `autodave`: storage, engine (+`executor.py` step SDK,
  `imports_check.py` shared §6.2 import allowlist), scheduler, drafting, harness adapters,
  FastAPI API (`api.py`), launchd service (`service.py`), CLI (`cli.py`).
  `autodave/instructions/` holds the §8 prompt texts as markdown (packaged via
  `[tool.setuptools.package-data]`): `framework-instructions.md` (contract preamble) and
  `default-build-instructions.md` (default build instructions seeded into new automations).
  `pyproject.toml` defines the `autodave` / `autodave-backend` entry points.
- `app/` — Electron app: `electron/main.cjs` + `preload.cjs` (window, tray panel, backend.json
  bridge), Vite + React + TS renderer under `src/` (`store.ts` central model, `api.ts` client,
  `ui.tsx` shared primitives, `tokens.css` design tokens, `pages/` one file per screen).
  `UI-GUIDE.md` records the renderer conventions.
- `scripts/` — project scripts (`dev.sh`, `build.sh`, `prod.sh`, `logs.sh` — §18;
  `gen_tray_icon.py` renders the tray template PNGs;
  `gen_app_icon.cjs` renders the dock icon `app/electron/appIcon.png` via Electron —
  invoked from `app/` as `./node_modules/.bin/electron ../scripts/gen_app_icon.cjs`;
  `commit` stages all uncommitted changes, generates a commit message via
  `claude --model claude-opus-4-8 -p` from the staged diff, and commits).
- `tests/` — pytest suite for the backend (storage, drafting, engine, schedule, API), plus the
  test doubles: `tests/bin/claude` (fake agent CLI) and `tests/seed_data.py` (§16 fixture).
- `LICENSE` — MIT, copyright David Zhang (also `"license": "MIT"` in `app/package.json`).

## 18. Commands

Dev workflow:

- **`./scripts/build.sh`** — build only, no launch: creates the venv and `node_modules` if
  missing, re-installs deps when `backend/pyproject.toml` (stamp file `.venv/.backend-stamp`)
  or `app/package.json` changed, then typechecks + builds the renderer (`npm run build` →
  `app/dist`, the bundle Electron loads in release). Touches no processes and no data dir;
  safe to invoke anytime. **`--deps`** stops after the dependency step (no renderer bundle) —
  what dev.sh uses.
- **`./scripts/prod.sh`** — the production distribution (§3), under `build/` (gitignored).
  Invokes `build.sh` (full), then: downloads the pinned relocatable CPython
  (python-build-standalone `20260623` / CPython `3.14.6`, arch from `uname -m`, tarball
  cached in `build/cache/`, URL overridable via `AUTODAVE_PBS_URL`), pip-installs the backend
  + curated packages into it (inside the bundle the backend/CLI execute as
  `python3 -m autodave.main` / `-m autodave.cli` — pip's `bin/` entry scripts carry absolute
  staging-path shebangs), renders `appIcon.icns` from `app/electron/appIcon.png`
  (sips + iconutil), packages `Auto Dave.app` with `@electron/packager` (bundle id
  `com.autodave.app`; ships only `electron/`, `dist/`, and `package.json` — the renderer is
  fully bundled and main/preload use Electron builtins only, so no `node_modules`), copies
  the interpreter to `Contents/Resources/python/`, codesigns (Developer ID + hardened runtime
  on every Mach-O when `CODESIGN_IDENTITY` is set — notarization itself not performed; ad-hoc
  otherwise, local use only), smoke-checks that the bundled interpreter imports `autodave` +
  every curated package from inside the bundle, and produces
  `build/Auto Dave-<version>-<arch>.dmg` (hdiutil UDZO).
- **`./scripts/dev.sh`** — fastest dev loop, with hot reloading: invokes `build.sh --deps` only
  (no renderer bundle); shuts down lingering processes from previous sessions — backend by
  command-line pattern (`[Pp]ython -m autodave` — ps shows the venv python's resolved binary,
  never the `.venv/bin/python` path; SIGTERM, 5 s grace, then SIGKILL — backends can hang in
  graceful shutdown while uvicorn waits on open WebSockets), stale Electron, and stale Vite;
  then (re)installs the real launchd LaunchAgent (`autodave service uninstall` +
  `service install`, `com.autodave.backend`, §3) so the backend behaves exactly as in release:
  launchd-managed, RunAtLoad/KeepAlive, cwd `/`, minimal launchd PATH, random free port,
  macOS Keychain, devMode-gated request logging (§5) to `backend.out.log`/`backend.err.log`
  under the logs
  dir (§5), data in `~/Library/Application Support/Auto Dave` (starts empty on a fresh
  machine); starts a Vite dev server on a random free port (`npx vite --strictPort`, log
  `vite.log` under the logs dir, killed on script exit); waits for a fresh `backend.json`
  (rewritten with new pid/token
  each start) plus `/health` and for Vite to answer, then launches Electron in the foreground
  with `AUTODAVE_RENDERER_URL=http://127.0.0.1:<vite port>` (§15) — renderer edits under
  `app/src` hot-reload live; backend edits need a dev.sh restart. Quitting Electron normally
  (Cmd+Q) leaves the backend running (release semantics — automations keep firing; stop it with
  `.venv/bin/autodave service uninstall`). Ctrl+C in the dev.sh terminal instead shuts the
  whole app down: Electron dies with the terminal's SIGINT, the exit trap kills Vite, and an
  INT/TERM trap stops the backend — `autodave service uninstall` first (launchd KeepAlive
  would otherwise respawn it), then the same SIGTERM → 5 s grace → SIGKILL escalation as the
  startup stale-process sweep (a plain SIGTERM leaves uvicorn hanging in graceful shutdown);
  the script exits 130. The SIGKILL path leaves a stale `backend.json` behind, which the next
  startup already tolerates (fresh-file compare).
  Isolated mode: setting any `AUTODAVE_*` knob (§15) switches dev.sh to spawning the backend
  directly with that env instead of via launchd (the plist carries no env) — detached, cwd `/`,
  launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), same log filenames under the chosen home.
  `--fresh` wipes the data dir first and is refused unless `AUTODAVE_HOME` is set (never wipes
  the real app data).
- **`./scripts/logs.sh`** — follows all log streams in one terminal (`tail -n 25 -F`):
  `backend.err.log`, `backend.out.log`, `app.log`, plus `vite.log` when present. Resolves the
  logs dir exactly like dev.sh (`~/Library/Logs/Auto Dave`, or `<home>/logs` when
  `AUTODAVE_HOME` is set, §5); creates missing backend logs so `tail` starts clean.
  **`--clear`** truncates the logs in place first (`: >` — writers keep their open
  append-mode handles), then follows.
- Backend: `python3.14 -m venv .venv && .venv/bin/pip install -e "backend[dev]"`; test with
  `.venv/bin/python -m pytest tests/`; dev.sh launches the backend via `python -m autodave.main`
  (equivalent to the `autodave-backend` entry point); start an isolated backend (real agent CLIs,
  real Keychain, empty home) with `AUTODAVE_HOME=<dir> AUTODAVE_PORT=8799 .venv/bin/autodave-backend`.
- App: `cd app && npm install`; typecheck+bundle with `npm run build`; `npm run app` launches
  Electron against the built bundle (release delivery; dev.sh instead serves the same source
  via Vite + `AUTODAVE_RENDERER_URL`, §15).
- **`./scripts/commit`** — stages all uncommitted changes (`git add -A`), asks Claude
  (Opus 4.8, `claude --model claude-opus-4-8 -p`) for a commit message based on the staged diff
  (≤72-char imperative summary, whole message capped at 2-3 sentences), prints it, and commits. Exits 0 with no commit if
  the tree is clean; fails if message generation returns empty. Does not push.

Claude Code commands:

- `/commit` (`.claude/commands/commit.md`) — stage all changes and make one concise commit. Always
  delegated to a subagent via the Agent tool, always launched with `model: opus` (Opus 4.8). Never adds
  `Claude` as co-author. Does not push.

## 19. Backend API (decided)

Localhost JSON over HTTP + one WebSocket, both authenticated with the bearer token from
`backend.json` (§3). Entity JSON uses the §4 field names verbatim (`autos`-shaped automations,
`execs`-shaped executions) so UI state mirrors the model. UI and CLI use only this API (§3 parity).

- `GET /health` → `{ version, app }` (unauthenticated; used for discovery/liveness)
- `GET /state` → boot snapshot: automations (full), execution headers, agents, secret names +
  usedBy, settings, app version, `pendingDraft` (`{ name, updatedAt } | null` — the §4.4
  slot's identity summary; backs the §9.1 Resume draft button)
- `GET /instructions` → `{ framework, defaultBuild }` — the two §8 instruction files verbatim
  (backs the §11 Framework-instructions and Build-instructions cards)
- `GET /automations` · `GET /automations/{id}` · `DELETE /automations/{id}`
- `PATCH /automations/{id}` — user-owned fields only: name, triggers (the §4.3 list, replaced
  whole; entries keep their `id`, new entries get one assigned; cron/time/app_start kinds
  only — a message kind, an invalid cron expression, an unknown `tz`, a past `time`, or a
  second `app_start` answers 422 and nothing is stored), param
  values, agentId, stepAgents, allowedSecrets, snapshotSettings (the §6.3 automatic-snapshot
  toggles — partial object, sent keys merged over the stored ones)
- `POST /automations/{id}/execute` `{ version?: "vN" | "draft" (case-insensitive), trigger? }` →
  `{ execId }` (409 while live; a version label that doesn't resolve answers 404)
- `POST /app-started` → `{ fired }` — the §6 app-start firing path, called by the Electron
  main process once per app launch: starts an execution for every automation holding an
  enabled `app_start` trigger (one mid-execution gets a skipped record instead, §6); `fired`
  counts the executions started
- `POST /automations` `{ draft }` — create v1 from a validated draft; consumes the §4.4
  pending create-mode slot (`<root>/draft/` is deleted on success)
- `POST /automations/{id}/versions` `{ draft }` — save edit as vN+1; the draft's `triggers`
  list (when the key is sent) replaces the automation's trigger list whole, validated and
  normalized like the PATCH (422 aborts the save; entries keep their `id`, new ones get one)
- `PUT /automations/{id}/draft` · `DELETE /automations/{id}/draft` — the §4.4 draft snapshot;
  the payload's stepAgents/allowedSecrets/triggers are stored as draft-only keys and echoed
  back on the automation's `draft` object
- `GET /draft` → `{ draft: payload | null, agentId }` · `PUT /draft` `{ draft, agentId? }` ·
  `DELETE /draft` — the §4.4 pending create-mode slot (`<root>/draft/`): the same draft
  payload shape as `PUT /automations/{id}/draft` plus the identity fields (name, triggers
  ride the payload; agentId beside it); GET returns `draft: null` when the slot is empty
- `POST /draft/open` — §4.4: make the pending slot's container dirs (`draft/` with empty
  `memory/`, `workspace/`, `result/`) exist, never touching contents already there; the
  create flow calls it on open so the slot exists before any drafting or test
- `POST /automations/{id}/restore` `{ v }` — copy vX to vN+1 (§5)
- `POST /automations/{id}/memory/clear` — §6.3 pre-clear snapshot, then empty the §4.1 memory
  directory (backs §9.2 "Clear memory")
- `POST /automations/{id}/memory/snapshots` `{ name? }` — §6.3 manual snapshot (409 while
  live, 422 when memory is empty) · `PATCH /automations/{id}/memory/snapshots/{sid}`
  `{ name }` — rename; null/"" clears · `POST /automations/{id}/memory/snapshots/{sid}/restore`
  — §6.3 restore (409 while live) · `DELETE /automations/{id}/memory/snapshots/{sid}` —
  delete the snapshot; unknown `sid` answers 404
- `POST /tests` `{ autoId?, draft, agentId?, enabledAgents?, allowedSecrets?, paramValues? }`
  → `{ testId }` — the §11 Test: executes the sent draft's steps in the draft container's
  `workspace/`/`result/` (§11: `automations/<uuid>/draft/` when `autoId` is given, else the
  pending slot `<root>/draft/`; scratch memory copied, when `autoId` is given, from its
  `draft/memory/` if present else its memory dir, else from the pending slot's `memory/`
  if present else empty; no execution record); grant arrays
  as in `/drafts`; param resolution uses the automation's stored values when `autoId` is given
  (else the draft's defaults), with `paramValues` (name → value, §5 matching rules) overriding
  on top for this test only — never stored; progress via the `test.*` WS events; on failure the
  backend makes the §8 issue-analysis call with `agentId` (default-agent fallback) and emits its
  blockers in `test.issue`. `DELETE /tests/{testId}` cancels (kills the live step subprocess or
  the analysis harness process)
- `POST /packages/check` `{ packages: [{ pip, import }] }` → `{ packages: [{ pip, import,
  status: installed | missing }] }` — the fast §6.2 installed-check, never runs pip (backs the
  §11 Packages card's page-load check) · `POST /packages/install` (same body) →
  `{ packages: [{ pip, import, status: installed | failed, error? }] }` — the §6.2 ensure,
  blocking; installs only what's missing, one pip run at a time process-wide (backs the §11
  Install/Retry button) · `POST /packages/outdated` (same body) → `{ packages: [{ pip, import,
  latest? }] }` — read-only PyPI query (§6.2: newest stable non-yanked version with a
  compatible wheel); `latest` present only when newer than the pin, absent on any lookup
  failure (backs the §11 page-load update check) · `POST /packages/update`
  `{ packages: [{ pip, import }] }` with the **new** pins → `{ packages: [{ pip, import,
  status: installed | failed, error? }], updated: [automation names] }` — the §6.2
  manifest-first pin rewrite (current version + draft of every automation declaring the
  distribution, in place), then the blocking ensure; publishes `auto.changed` when any
  manifest was rewritten; a malformed pin → 422
- `POST /drafts` `{ mode: create|edit|sync, autoId?, text?, spec?, current?, agentId?,
  enabledAgents?, allowedSecrets? }` → `{ jobId }` — the grant arrays, when present, override
  the stored automation's for the §8 grants context; when `enabledAgents` is absent and no
  stored automation exists (create mode), the agents grant defaults to **all** configured
  agents — matching the all-enabled seed the Review page starts from; progress via
  WS; `GET /drafts/{jobId}` → state (`status`, `stage`, live §8 `detail` line) + validated §8
  draft payload — on a create job the payload
  carries call 1's validated spec as soon as the spec call completes (the §11 spec card renders
  it while the steps call is still working); a `blocked` job's state is
  `blocked` and it carries the §8 `blockers` list plus `blockedAt: spec | steps` (a create job
  blocked at the steps call keeps call 1's spec in its payload, so the §11 Blocker modal can
  amend and rebuild it); `DELETE /drafts/{jobId}` cancels
  (kills the harness process)
- `GET /executions?auto=&status=` (headers only — no steps) · `GET /executions/{id}` (steps
  with attempts + params + error + result — logs are lazy, never inline) ·
  `GET /executions/{id}/logs?step=&attempt=` → `{ lines: [{t, k, seq, text}] }` — both params
  select that step attempt's file, neither selects `logs/execution.ndjson`, a missing file
  answers empty lines ·
  `GET /executions/{id}/result/{name}` (raw result-dir file for the §7 file views; plain
  filenames only — no path traversal) · `POST /executions/{id}/cancel` ·
  `POST /executions/{id}/retry` (§7 in-place retry; 409 unless failed and not live) ·
  `POST /executions/{id}/skip-step` `{ index }` (§7 skip; 409 unless that step is executing)
- `GET/POST /agents` · `PATCH/DELETE /agents/{id}` · `POST /agents/{id}/check` (health/badge) —
  one shared readiness check (`harness.check_ready`) decides ready vs. needs-setup everywhere:
  the harness binary must resolve (rule below), Ollama's server must answer, and Claude Code
  must additionally be signed in (`claude auth status` exits 0 only when authenticated) ·
  `GET /agents/detect` (§10 detection) · Ollama: `GET /ollama/status` → `{ ready, installed,
  models }`, `POST /ollama/pull`. All CLI lookups (detection and harness invocation alike)
  resolve the binary via PATH plus the usual macOS install locations (`~/.local/bin`,
  `/opt/homebrew/bin`, `/usr/local/bin`; Ollama additionally `Ollama.app`), because a
  GUI-launched backend gets a minimal PATH — e.g. `claude` installs to `~/.local/bin` by
  default. Invocation uses the resolved absolute path. If Ollama is installed but its server isn't
  answering (and `AUTODAVE_OLLAMA_URL` is local), `/ollama/status` starts `ollama serve`
  once per backend process and waits briefly for it to come up — so an installed Ollama
  reads as found/ready instead of prompting a fresh download.
- `GET /secrets` (names + usedBy only) · `PUT /secrets/{name}` `{ value }` · `DELETE
  /secrets/{name}` — values go straight to the Keychain, never into responses or files
- `GET /settings` · `PATCH /settings` · `POST /settings/data-path` `{ path }` (sets the
  execution-data location; creates the dir, reloads from it, moves nothing; answers 409 while
  an execution is in progress — it still writes into the old location)
- `WS /ws?token=` — events, each `{ ev, ... }`: `exec.started` (also re-published when a
  failed execution retries in place — same execution id, updated record), `exec.step`
  (status change; carries the full step incl. its attempts), `exec.log` (one NDJSON line with
  `stepIndex`/`attempt` — null for execution-level lines — and the per-file `seq` for
  fetch-vs-stream dedupe), `exec.finished`, `auto.changed`, `agents.changed`,
  `secrets.changed`, `settings.changed`, `draft.changed` (the §4.4 pending slot was kept
  or discarded — clients re-`GET /state`), `draft.progress`, `test.step` (§11 test step
  status change), `test.log` (one redacted NDJSON line), `test.done` (`{ status, result? }` —
  result summary on success), `test.issue` (the §8 issue-analysis blockers, after a failed
  test's analysis finishes),
  `ollama.pull` (model-pull progress). Clients re-`GET /state` on
  reconnect.

## 20. Deliberate divergences from the design prototype

The spec follows `design/Auto Dave.dc.html` as closely as possible. These are the only places it
knowingly overrides the prototype — each for a reason the prototype (a simulation with fake data)
didn't have to face. Do not "fix" the app to match the prototype on these points:

- **Stored secret values are never shown.** The prototype's Secrets list has a per-row show/hide
  that reveals the stored value, and its edit modal pre-fills it. Real values live in the
  Keychain and the API never returns them (§4.8): the list shows a fixed mask, and the edit
  modal opens with an empty value field — show/hide applies only to what's being typed.
- **Entity ids are UUIDs.** The prototype uses slugs (`'claude'`, `'ag'+Date.now()`); §4's
  identity rule wins.
- **Detection covers all five providers.** The prototype's onboarding knobs can only simulate
  finding Claude Code / Ollama / Codex; the real detector (§19 `GET /agents/detect`) also finds
  Gemini CLI and OpenCode.
- **Seed executions.** The prototype seeds 11 executions including a permanently-`executing`
  one, covers `skipped` only as a step status, and has a `reused` step status that no longer
  exists (§4.6 — in-place retry replaced it). §16 seeds twelve, covers every terminal
  execution status, and never seeds `executing` (it is inherently live).
- **Framework-knowledge panel copy follows §6/§6.1.** The prototype panel says memory is "one
  JSON file" and shows `secret("smtp-password")`; the real panel must describe the memory
  directory and `secrets.NAME` references.
- **Seed step scripts use the real SDK.** Prototype scripts call `memory.last_seen`,
  `agent.do(...)`, `result.summary(...)` — none exist in §6.1; real seeds use
  `memory.load/save`, `agent.ask/read/write`, and the §6.1 result builder.
- **Deleted-automation executions keep the historical name.** The prototype falls back to "—";
  §5 snapshots `automation_name` so old executions render the real name, marked deleted.
- **Execution-page parameters are the values used by that execution.** The prototype renders the
  automation's current live params; the execution record snapshots the resolved values
  ("Values as used by this execution.").
- **Ollama pull bar has an indeterminate fallback.** The prototype always has a percent because
  it simulates the pull; real `ollama pull` output may not yield one.
- **`lastExecLabel` is always derived.** The prototype's seeds mostly omit it and the menu bar
  patches in hardcoded times; the real field is computed per §4.1 for every automation.
- **Multiple triggers.** The prototype models one daily/weekly schedule per automation
  (hour/min/dow plus a single on/off). §4.3 replaces it with a trigger list — cron expressions,
  one-shot times, reserved message kinds — so the schedule chips, the TRIGGERS card, and the
  Review-page card diverge accordingly (the prototype's "Message triggers — coming soon" chip
  becomes disabled kinds in the Add-trigger picker).
- **No separate building screen.** The prototype shows a spinner + staged-checklist surface
  between Ask and Review while the draft generates. The app navigates straight to Review, whose
  cards carry the drafting stages (§11): the spec is readable — and editable — the moment the
  spec call lands, clarifications happen inside the spec card, and steps-call blockers reuse
  the sync Blocker modal.
- **"Execution", never "run".** The prototype's copy and code say "Run now", "Running",
  "runs", `lastRunLabel`. The app uses a single term for one occurrence of an automation —
  see the §6 terminology rule ("Execute now", "Executing", `executing` status,
  `lastExecLabel`). `design/README.md` describes the prototype and keeps its original
  wording.
