# Autowright — SPEC

Source of truth. Holds enough detail to rebuild the app from scratch, including the pixel-exact
values where they matter (colors, spacing, typography) — §14 is the authoritative design-token
sheet, implemented in code by `app/src/tokens.css`.

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

## 1. Product overview

Autowright is a macOS desktop app for recurring personal automations. The user describes a job in
plain words ("Check the manga I follow for new chapters every morning at 8"); a connected AI agent
(Claude Code, Gemini CLI, Codex, or OpenCode — the latter optionally driving a local Ollama
model) writes it as human-readable
scripts; Autowright executes those scripts on a schedule, entirely on the user's Mac, and shows results.

Core promises (exact UI copy, repeated in the onboarding footer):
- "Your automations execute only on this Mac"
- "Nothing executes until you review it"
- "Passwords never leave your Keychain"

## 2. Architecture

Four components (per top-level README):

- **Electron desktop app** — the UI (dark theme only; visual language in §14). One window plus
  a menu-bar (tray) surface. Talks to the backend over a local API.
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
`Autowright.app` with the bundled relocatable Python in `Contents/Resources/python/` plus a DMG,
Developer-ID-signed with hardened runtime when `CODESIGN_IDENTITY` is set (ad-hoc otherwise).
Still not implemented: notarization submission, `SMAppService` registration from the app, and the
launch-time version-compare/re-register flow — today the only registration path is
`autowright service install`, whose plist points at the current interpreter (`sys.executable`), so
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
  `~/Library/Application Support/Autowright/backend.json` (0600); UI and CLI read it to connect.
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
  Autowright does not hold a permanent assertion.

**Headless mode (decided; CLI implementation may land later).** The backend and CLI must work with
no GUI ever launched:

- **API parity** — every operation the UI performs goes through the backend API; the UI holds no
  private logic. The CLI is a second client of the same API and can reach full coverage without
  backend changes.
- **Bootstrap** — `autowright service install` registers the backend by writing a launchd plist to
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
`automation.yaml` and are matched by name and kind at execution/restore time (§5). The
value-merged serialization (the automation JSON's `params`, execution records) is the full
definition — `default` included — plus the resolved value field, so definitions survive a
round-trip through the editor (edit mode seeds the draft's params from the automation JSON;
a stripped default would make a §11 test resolve an unset param to empty instead of its
default).

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
  Opening the create flow creates the slot's container first — `draft/` with an empty
  `memory/` (`POST /draft/open`, §19) — before any drafting; §11 create-mode tests execute
  as test execution records in the executions tree, not inside the slot. Leaving the create
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
id: uuid, autoId: uuid ("" on a create-mode test — no automation record exists yet),
ver ("v3", "Draft", or "Test" — §11 test executions), status,
test: bool — §11 test executions; excluded from the Executions list, the detail page's
  RECENT EXECUTIONS, an automation's execution-derived display state (lastStatus / latest
  result / live), and the scheduler's retry-once rule; deleted when the draft settles and
  by starting the next test
trigger: Manual | Menu bar | Cron | Once | App start | Test (future: Discord | iMessage |
  Pub/Sub) — the label of what started the execution (§4.3 kinds map cron → "Cron",
  time → "Once", app_start → "App start"; §11 tests are always "Test")
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
{ id: uuid, name, desc, harness: Claude Code | Gemini CLI | Codex | OpenCode,
  mode: default | ollama | custom, model }
```
`desc` is an optional free-text description ("What this agent is for — shown on the Agents
page and given to the drafting agent"), rendered as the detail line on the agent card and
carried into the §8 grants yaml so the drafting agent knows what each enabled agent is for.
`model` is null when `mode` is `default` and required otherwise. Mode `custom` is valid with
every harness: the user types the model as a free-text string and the app passes it verbatim
to the harness CLI as `--model <model>` (§6, §19); the string is never validated by the app —
a wrong name surfaces as a harness error at invoke time. Mode `ollama`: `model` names the
local Ollama model. Mode
`ollama` is valid **only with the OpenCode harness** — Ollama is not a harness of its own; it
is purely the local-model runtime OpenCode drives (`opencode run --model ollama/<model>`,
§19). A null model means the app never picks or passes a model — the harness uses whatever
model it is already configured with. Display shows "Default model" when the model is null. One agent is
the app default; deleting an agent reassigns the default and warns which automations use it.
All four harnesses are selectable. The app can install any of them (plus Ollama, for the
local-model mode) and help the user sign in when the harness needs an account (§10 step 2,
§19 install/login endpoints).

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
login: bool        — "Launch at login" ("Autowright starts quietly in the menu bar.")
mbIcon: bool       — "Show in the menu bar" ("The quickest way to execute an automation.")
notif: attention | all — "Only when something needs attention" / "After every execution"
days: int ≥ 1 (default 90) — history retention; keepForever: bool disables cleanup
devMode: bool (default false) — "Developer mode" ("Logs every backend request and every AI
  request — including the full prompt — to the backend log.") — gates request logging (§5)
dataPath (default ~/Library/Application Support/Autowright/executions), dataSize
```
Show in Finder (everywhere it appears) opens the target directory itself in Finder when the
path is an existing directory (e.g. Execution data opens the executions dir, not its parent), and
falls back to selecting the item in its parent folder otherwise.
Execution-data section: Change then Show in Finder; Change opens the native macOS folder picker and the chosen
directory simply becomes the execution-data location — no move/cancel UI and no data migration: all
execution state lives inside the executions dir, so changing the path just points Autowright at
the new location (the old dir stays where it was).
The "Keep executions for" days row is hidden (not just disabled) while "Keep execution history forever" is
on. One **ON THIS MAC** card holds two rows: **"Automations & settings"** (the fixed path
`~/Library/Application Support/Autowright` with its own Show in Finder button — this location
is not changeable) above the **Execution data** row. A **DEVELOPER** card sits last on the page with
the single **Developer mode** toggle row (devMode above).

## 5. Storage (decided)

**File-first everywhere: YAML/markdown files are the persistence. Each execution's full record
lives in `executions.yaml` inside its execution directory — the directory is fully
self-contained (record + logs + workspace + result). A SQLite database
(`<dataPath>/executions/executions.db`) exists only as a list/filter index over the execution
headers; the yaml is authoritative. All derived state lives in memory and is rebuilt from disk
at every startup.**

On-disk layout under `~/Library/Application Support/Autowright/`:

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
                               # (with an empty memory/) the moment the create flow opens,
                               # deleted when Create or Start over settles it; same
                               # container shape as automations/<uuid>/draft/ below, plus
                               # create-only identity keys in its automation/automation.yaml
                               # (name, agent_id, enabled_agents, triggers, created_at,
                               # updated_at — no automation record exists yet to hold them):
  automation/                  #   the working copy (version-folder shape)
  memory/                      #   scratch memory copied by §11 tests; starts empty
  test.yaml                    #   §11 last-test summary — same shape as the edit-mode one
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
    test.yaml                  # §11 last-test summary: status (succeeded | failed),
                               # finished-at ISO timestamp, and the test execution's id —
                               # written when a test ends, wiped at each test start, deleted
                               # with the draft; lets a resumed draft's Test card show the
                               # last outcome and link to the test's execution page. The
                               # test's workspace/result/logs live on its execution record
                               # (§4.5 test executions), not in this container.
  versions/vN/                 # one folder per version — immutable once written
    automation.yaml            # when, note, desc, param definitions (§4.2: name, kind,
                               # label, help, default, …) + ordered steps manifest:
                               # steps: [{file, name, desc, agent?, agent_id, why}]
                               # + declared packages (§6.2, absent when none):
                               # packages: [{pip: pandas, import: pandas}]
    spec.md                    # the version's spec as plain markdown (h1/h2/li/p blocks)
    instructions.md            # user's free-text instructions to the agent (§4.1 instr),
                               # plain markdown; absent when none were given
    NN-name.py                 # step scripts as real files, beside the manifest —
                               # agent- and human-editable
```

**Logs live outside the data dir**, at `~/Library/Logs/Autowright/` (macOS convention;
Console.app picks them up): `app.log` (backend application log), `backend.out.log` /
`backend.err.log` (launchd stdout/stderr), and dev.sh's `vite.log`. With `AUTOWRIGHT_HOME` set
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
stdout, so `backend.out.log` under launchd) and every agent request — one `autowright.harness`
INFO line per `harness.invoke()` with the harness, the model (agent's, else the literal
"configured default"), and the full prompt (stderr, so `backend.err.log`). `./scripts/logs.sh` (§18)
follows both plus `app.log`/`vite.log`. Implemented as a logging filter that reads the live setting on
every record, so flipping the toggle applies immediately with no backend restart; while off,
only WARNING+ prints. The filter rides in on uvicorn's `log_config` handlers (uvicorn's own
dictConfig would wipe a filter attached to its loggers beforehand) and on the root handler for
`autowright.*` logs.

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
                               #     version ("v3"/"Draft"/"Test"), status, trigger,
                               #     test (0/1 — §4.5 test executions), started_at /
                               #     finished_at (epoch ms; finished_at NULL while executing),
                               #     dur_ms, note, chip / chip_status (§4.5 — NULL when the
                               #     execution set no chip), error_step / error_message /
                               #     error_reason (§4.5 — NULL unless failed; denormalized
                               #     mirrors so list surfaces render without a yaml read)
                               #   indexes: (started_at DESC, id), (automation_id, started_at),
                               #     (status, started_at)
  <execution-uuid>/
    executions.yaml            # the full execution record (§4.5): header fields (incl. the
                               # test flag) plus params (snapshot), redacted_secrets, error,
                               # note, and steps[] with per-step attempts[] ({n, status,
                               # started_at, dur_ms, error? on failed attempts}); rewritten
                               # atomically (temp+rename) on every transition
    steps/                     # §11 test executions only: the sent draft's step scripts as
                               # executed — a real version folder serves that role for
                               # ordinary executions
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
`test` records (§4.5) never count either — a draft test must not change what the automation's
list row, detail page, or menu bar report about real executions.

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
  respect robots.txt; user agent "Autowright/1.0".
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
  `codex exec --sandbox read-only --skip-git-repo-check`; Gemini CLI and OpenCode expose no
  tool-disable flag for one-shot invocations and are
  invoked bare (documented limitation; a custom-model agent — mode `custom`, §4.7 — adds
  `--model <model>` to the harness command, the same flag on all four CLIs; an OpenCode
  agent with a local model adds `--model ollama/<model>`). Every harness CLI child
  (drafting and runtime alike)
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

### 6.1 The `autowright` step SDK (decided)

Each step executes in its own subprocess (the bundled interpreter, cwd = the execution `workspace/`).
The engine's executor injects these globals — scripts may also `import autowright` for the same names:

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
processes a step spawns can self-identify: `AUTOWRIGHT_AUTOMATION_ID`, `AUTOWRIGHT_AUTOMATION_NAME`,
`AUTOWRIGHT_EXECUTION_ID`, `AUTOWRIGHT_STEP_INDEX`, `AUTOWRIGHT_STEP_NAME`, `AUTOWRIGHT_TRIGGER`,
`AUTOWRIGHT_WORKSPACE`, `AUTOWRIGHT_MEMORY_DIR`, `AUTOWRIGHT_RESULT_DIR`. Param values, secret values,
and agent config never enter the environment; the executor never reads env as input.
`sys.exit()` in a step follows the CPython convention: no code / `0` is an ordinary early exit
(the step succeeds), an integer fails the step with that exit code, and `sys.exit("message")`
fails it with the author's message preserved as the error (`SystemExit: message`).

### 6.2 Curated & declared packages (decided)

Step scripts may import: Python stdlib, `autowright`, and the curated packages: `requests`, `httpx`,
`beautifulsoup4` (`bs4`), `lxml`, `feedparser`, `python-dateutil` (`dateutil`), `PyYAML` (`yaml`).
The curated list ships with the app (installed in the bundled interpreter) and is included
verbatim in the §8 contract preamble.

**Declared packages.** When a task genuinely needs a library beyond the curated list (the
task-solving ladder still prefers stdlib + curated first), the drafting agent declares it in
`manifest.yaml` (§8): `packages: [{ pip: pandas, import: pandas }]` — one entry per
distribution, the bare distribution name (PEP 503 name only — **no version specifier**; the
installed distribution is the single source of truth for the version, see the install model
below) plus the top-level module it provides. Python transitive dependencies are pip's job and
are never declared; what
must be declared is every **runtime companion** the task's usage needs beyond that — optional
extras and binary-bundling wheels (e.g. yt-dlp merging streams needs ffmpeg → declare
`imageio-ffmpeg` alongside it and wire its path in the step). The §8 contract instructs the
drafting agent to declare the complete set a task needs, so an execution never discovers a
missing companion at runtime. Declared packages extend the import allowlist for that version's steps only:
§8 validation and the executor's runtime re-check both accept stdlib + curated + `autowright` +
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
operation shared by every call site: a fast installed-check first (distribution present in the
directory, **any** version — the installed version is never compared against the manifest,
which carries no version), pip runs only for missing distributions (installing the newest
compatible wheel at that moment), and one process-wide lock serializes pip runs. An installed
distribution is never touched by ensure — upgrades happen only through the explicit §11 Update
button — so an unattended automation never changes behavior because a library released
overnight. Ensure happens at two moments through the same code path:

- right after a §8 steps call validates (job stage "Installing the packages"; per-package
  statuses ride the draft payload and render in the §11 Packages card) — the user learns about
  an install failure while still on the edit page, not when a trigger fires;
- before an execution's first step (§7) — self-healing after an app update, a cleared
  directory, or a save that skipped a failed install.

An install failure never blocks saving (§11); at execution time it fails the execution before
step 1 with the §7 category. The shared directory holds one version of each distribution,
shared by every automation declaring it (accepted: single-user app; if a real conflict ever
shows up the fix is per-automation target dirs, not user-facing knobs). Because manifests are
version-free, restoring an older automation version never changes any installed package, and
a wiped directory self-heals to the newest compatible wheels rather than an exact snapshot.

**Updating packages — the app checks, the user decides.** The installed version only changes
through the explicit per-row **Update** button (§11). On load the edit page's Packages card
asks PyPI for updates (§19 `POST /packages/outdated`, read-only: per package, the newest
stable non-yanked version that has a wheel compatible with the bundled interpreter — the
wheels-only rule applies to the check too; a network failure just leaves the badges off),
comparing against the **installed** version. An update runs `pip install --upgrade <name>`
into the shared directory (§19 `POST /packages/update`) — no manifest is touched, because
manifests carry no version; every automation declaring the distribution picks up the new
version at its next execution automatically.

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
  a sys log line ("installing packages: `pandas`…"). An install failure fails the
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
started · duration. A §4.5 `test` execution additionally shows a **"Draft test"** chip in the
title row, never shows the "(deleted)" marker (a create-mode test has no automation by
design), and hides Retry and Execute again — iteration on a draft happens from the editor's
Test card; Cancel and Skip step still work while it is live. Body stacks top to bottom: the
failure notice (failed executions only), a full-width **RESULT card**, then a single
**execution card** that joins the **STEPS rail** (left) and the **LOGS pane** (right) with an
internal divider — one card, since the rail's selection drives the pane. Beneath the steps the
rail holds the **PARAMETERS block** — per param: label, its help description, and the §4.2
one-line summary value ("Values as used by this execution."). The STEPS rail's rows are **selectable**: each row shows the status dot (pulsing
while executing), name, a right-aligned attempt-count chip ("×2", mono, faint — only when the
step has more than one attempt) and the latest attempt's duration — rows carry no actions;
skipping lives in the header's Skip-step button. Above step 1 sits a **"Setup log"**
pseudo-row (terminal icon in place of a status dot) selecting the execution-scoped log.
Selecting any row changes which log the LOGS pane shows. While the
execution is live the selection auto-follows the executing step until the user selects a row
themselves (reset when navigating to another execution); when a failed execution loads, the
failed step's latest attempt is auto-selected. On a failed
execution a **failure notice** sits above the RESULT card: red-tinted card, "Failed at step
`<name>`", the §4.5 possible reason as plain text when present, and the error message in mono.
The LOGS pane shows the selected step's log (header: step name, or "Setup log" for the
pseudo-row, plus the redaction note "secrets redacted: `<name>`"); when the selected step has
more than one attempt, a segmented **attempt control** sits in the header — one status-tinted
pill per attempt ("Attempt 2 · Failed · 3s"), latest selected by default. The pane is the
color-coded log view (kinds sys/out/wrn/err); logs load lazily per selected step/attempt
(§19) and live lines stream in over WS (deduped by `seq`), with live auto-scroll and the
blinking cursor on the live attempt. Empty states: "No logs — this execution never
started." when the execution has no steps; an empty Setup log shows "No setup events —
installs, retries, and failures would appear here."; an empty step attempt shows "No log
lines here." The RESULT card, when the execution has no result, is a dashed placeholder ("No result") with a
status-specific reason (still executing / failed before a result was built / cancelled / no
result produced); with a result it is a collapsible **Results section** holding a stack of individually
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

**Executions list:** all executions across automations — except §4.5 `test` executions, which
are reachable only from the §11 Test card's View-run button; each row shows the automation name with
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
(`claude -p`, `gemini -p`, `codex exec`, `opencode run` — with `--model ollama/<model>` for a
local-model agent), and
parse one text response each. Everything below is harness-independent; adapters only translate
"send prompt, receive text." Agents never touch the data directory — the backend writes files
only after validation passes.

**Instruction files** (markdown next to the code, loaded at import — never inline in Python;
also served to the create/edit page via §19 `GET /instructions`):

- `backend/autowright/instructions/framework-instructions.md` — the contract preamble that travels
  with **every** call, written as structured markdown (headings, fenced code blocks for the
  envelopes and SDK reference, a table for parameter kinds): the agent's role, the generic
  file-block envelope (the per-call TASK directive
  names the exact files), the blocker envelope and when to use it, the task-solving ladder
  (deterministic code with curated libraries first; an agent step only when judgment is truly
  needed, its prompt kept small enough for a local model — narrow question, strict output
  format, reply validated in code), the `autowright` SDK reference with worked examples (a typical
  memory-diff last step; a validated `agent.ask` call), the curated package list, the parameter
  kinds table (§4.2), trigger- and step-design duties, the **failure-diagnostics duty** (a step
  that can't proceed raises an exception whose message names what it was doing, the exact input
  involved — URL, file, param — and what it expected vs found; HTTP failures include the status
  code; progress is logged as work proceeds so a failure's log tail shows the lead-up; never
  swallow exceptions or exit silently — the engine records the exception and shows it to the
  user, §7), and all five §6 policy sections. The §11
  Framework-instructions card renders this file as markdown.
- `backend/autowright/instructions/default-build-instructions.md` — the default best-practice
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
(call 2 only: regenerate steps to match the provided spec; the spec itself must not change) ·
`question` (one read-only Q&A call — the §11 Ask panel; see "Question call" below).

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
   packages:                         # §6.2 declared packages — beyond curated only, bare
     - { pip: pandas, import: pandas }   # distribution name, no version; omit the key when none are needed
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
4. Every step file passes `ast.parse`; imports ⊆ stdlib + curated packages + `autowright` + the
   manifest's declared package imports (§6.2).
5. `packages` is optional: a list of `{ pip, import }` entries — `pip` a bare distribution
   name (PEP 503 name only, no version specifier, ranges, or extras), `import` a valid module
   name that is not already stdlib or curated (declaring one that is, is a validation error —
   the list stays meaningful). After validation the job enters stage "Installing the packages"
   and runs the §6.2 ensure; per-package results ride the draft payload as
   `packages: [{ pip, import, status: installed | failed, version?, error? }]`. An install
   failure does **not** fail the job — the draft lands with the failure visible in the §11
   Packages card.
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
text still comes from the terminal `result` event, falling back to the joined deltas), and the
other CLIs are read line-by-line from stdout as they print.
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

**Question call (§11 Ask panel).** `question` mode makes exactly one call and never writes
anything — it exists so the user can ask about the workflow in plain words ("why does step 3
need my Keychain?") and read an answer. The prompt is the ordinary context stack:
`framework-instructions.md`, the call-2 grants context, the build instructions, the in-editor
spec (as markdown), every current step (file, name, code — the same rendering the sync call's
CURRENT sections use), and a closing `=== QUESTION ===` section with the user's text, followed
by a TASK directive: answer the QUESTION about this automation in plain markdown prose for the
user — **no file blocks, no envelope, no yaml** — grounded in the spec and steps above.
The raw response text, trimmed, **is** the answer; there is no envelope parsing, no blocker
path, and no repair round — the only failure is an empty response ("The agent returned an
empty answer.") or a harness error. The answer rides the job payload as `draft: { answer }`.
Stage label: "Answering the question"; the streamed `detail` line is `Thinking…` until text
arrives, then `Writing the answer · N lines` (same 1 s throttle). Same 5-minute cap, same
cancel semantics, same app-log logging as every drafting call. A question job never touches
the draft container, the dirty flag, or any stored file.

**Issue-analysis call (§11 Test).** When the user asks after a failed test (§11 "Analyze
the failure" — never automatically), the backend makes one more call with the same drafting
agent: `framework-instructions.md` + the spec + the failing
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
(`no-drag` on buttons/links/inputs). 212 px fixed sidebar: logo + "Autowright", nav
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
spinner appears with "Connecting…" (or "Waiting for the Autowright backend…" once a connection
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
a square accent-filled **inline execute button** per card (rounded square, solid accent/orange
background with a dark play icon — same fill treatment as the primary button; hover brightens;
while that automation is executing it swaps to a spinner, dims, and is disabled — tooltip
explains why). The card carries no last-execution label — `lastExecLabel` appears on the detail page and in the
menu bar. Empty state (dashed card):
"No automations yet. Describe a job in plain words — your AI writes it as scripts you can read,
and Autowright executes them on your schedule." with accent CTA "Create your first automation".

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
then a live self-check card "Getting Autowright ready" with three steps (Checking your settings,
Loading your automations, Starting the execution engine) with pulsing dots and durations, ending in a "READY / All set"
well with chips (Settings created, Folders in place, plus "Agent found" if an agent is already
configured and "Automations found" if automations already exist). Continue appears only when
done; its label is "Continue →" when prior data exists (going straight to the app), otherwise
"Connect your AI →".

**Step 2 — Connect your AI.** A searching spinner ("Looking for an AI already on this Mac…",
shown ≥1.9 s), then the §19 `GET /agents/detect` result rendered as cards. Detection reports
the four harnesses (Claude Code / Codex / Gemini CLI / OpenCode) with real installed
and signed-in state; installed harnesses render as "FOUND ON THIS MAC" cards (detail line =
real version plus sign-in state, e.g. "1.0.24 · signed in" / "1.0.24 · not signed in yet"),
and every harness that is
**not** installed renders as a suggestion card alongside (the app helps install all four).
Ollama is never a card of its own — the local path lives entirely in the "Free local AI"
card below (a suggestion card, unless every piece is already present — then it renders in
the found section).
Suggestion cards use the same full-width row anatomy as found cards — a single vertical list
(no tile grid), title plus one-line detail on the left, the action slot on the right; busy
states (install/pull progress, sign-in wait, install failure) stack full-width below the title
line. When at least one provider was found, the suggestion list sits behind its own neutral
eyebrow "OR TRY SOMETHING NEW" (neutral text color — accent stays reserved for the detected
section), which acts as a collapse toggle with a chevron icon: the list starts minimized
(collapsed) and clicking the eyebrow expands/collapses it. The expanded/collapsed state
persists across step navigation like the rest of onboarding state. When nothing is detected,
there is no eyebrow and no collapse — the list is always visible, with a note card above it:
"No AI app was found on this Mac — here are some suggestions for moving forward."

Every card resolves inside itself — there is no page-level Continue button, no radio selection,
and no multi-ready banner. All step-2 cards keep the neutral card border in every state —
no accent tint and no "Connected" label on connect; the Continue button alone is the
success signal (the accent "FOUND ON THIS MAC" eyebrow alone marks the detected section). Each card carries a single
action slot that advances through its states in place. All machines are real — backend installs,
real sign-in checks; no simulation in any mode:
- **Found card, signed in** — the connection check runs automatically as soon as
  the cards land; the user never has to ask for it. The card starts on an inline spinner
  "Checking connection…" (real §19 `POST /agents/check-harness`) → a primary
  "Continue with `<name>` →" button in the same card. A failed check shows amber
  "Not ready — `<reason>`" with a "Check again" button.
- **Found card, not signed in** — skips the auto-check (it would fail); sign-in help only
  when necessary: amber "Sign in" button →
  §19 `POST /agents/login` → waiting state (amber pulsing dot; copy matches the login method
  the backend reports: browser for Codex — "We opened your browser — sign in there and come
  back. We'll notice on our own."; Terminal for the others — "We opened Terminal — finish
  signing in there and come back. We'll notice on our own."), with "Cancel" returning to idle.
  The UI polls §19 `GET /agents/signin/{id}` every 2 s; once signed in the card runs the
  connection check automatically and lands on Connected + Continue.
- **Setup status line** — once every found card's auto-check has settled (none still
  checking), a line under the found section says whether the user can move on: "You're
  ready — continue with a connected AI, or set up another below." when at least one found
  card is connected, otherwise amber "More setup needed — finish the steps above before
  continuing."
- **Suggestion card** (one per missing harness) — "Claude" ("Set up Claude Code") /
  "Codex" / "Gemini" / "OpenCode" (each "Set up `<name>`"): install via §19
  `POST /agents/install` → labelled progress ("Installing `<name>`…"; determinate bar when the
  `harness.install` stream carries a percent, indeterminate otherwise) → then the sign-in flow
  above **only if the provider needs an account and isn't signed in** → connected:
  "Continue with `<name>` →" alone. An install failure shows red
  "Install failed — `<first error line>`" with "Try again". There is no sudo step: every
  install lands in user-writable locations (§19 channels), so macOS never prompts for an
  admin password.
- **Free local AI card** — always shown regardless of what was detected: OpenCode driving a
  local model through Ollama (title "Free local AI"). The card owns three pieces: OpenCode
  installed (from detection), Ollama serving, and a model installed (both from §19
  `GET /ollama/status`) — **any** installed model counts: the first model from
  `GET /ollama/status` becomes the card's model, and `qwen3:8b` is only the download
  fallback when none is installed. The card is the last suggestion card — except when all
  three pieces are already present at detection, in which case it renders as the last
  "FOUND ON THIS MAC" card instead (same card and machine; the found-section status line
  counts it like any found card, and its body reads "OpenCode with Ollama and `<model>` —
  local to this Mac, works offline."). Placement is decided once at detection and never
  moves mid-flow — the qwen3:8b recovery download below keeps the card in the found
  section. With no model found the body reads "Sets up
  OpenCode with Ollama and Qwen3 8B. Local to this Mac, works offline." and the button
  "Download and install · 5.2 GB"; with a model found the body reads "Sets up OpenCode with
  Ollama and `<model>`, already on this Mac. Works offline." and the button "Set up local AI"
  (only the still-missing pieces install — no model download). When every piece is already
  present as the cards land, the card skips the install button and runs the connection check
  automatically (§19 `POST /agents/check-harness` with harness OpenCode and the card's
  model) → "Continue with local AI →". A failed check shows the amber not-ready line (the
  model-missing reason names the card's model) with "Check again" — plus, when the check ran
  against a found model, a "Download Qwen3 8B · 5.2 GB" button that discards the found model
  and pulls `qwen3:8b` instead (recovery for installed models that can't chat, e.g.
  embedding-only ones). Otherwise the install button runs only the **missing** pieces, in
  order — OpenCode (§19 install), Ollama (§19 install), the model (`POST /ollama/pull` of
  `qwen3:8b`, real percent from the pull stream, continues in the background) — labelled
  "Step k of n — Installing OpenCode… / Installing Ollama… / Downloading Qwen3 8B…" where n
  counts the missing pieces, then lands on the same connection check → connected. A failure
  at any piece shows red "Install failed — `<first error line>`" with "Try again", which
  resumes at the still-missing pieces.

Clicking a card's Continue is what picks the provider: it becomes the default agent, all
connected/ready cards are committed as agent records — a harness card as
`{ name: null, harness, mode: default, model: null }`, the Free local AI card as
`{ name: null, harness: OpenCode, mode: ollama, model: <the card's model> }` — the found
model, or `qwen3:8b` after a download (a null name always falls
back to the harness name for display, so agent labels read harness · model, e.g.
"OpenCode · qwen3:8b" — never the model twice) — and any existing
automations get the chosen default agent. While committing, all Continue buttons are disabled. "Skip for now" always
available (commits any connected providers, goes to the app). Persistent footer: the three
green-dot promises (§1).

**Step 3 — First automation.** The Create flow (§11) labeled "Step 3 of 3", skippable.

Onboarding state persists across steps: Back from step 3 returns to step 2 with detection
results, connect states, and the chosen provider intact (no re-search). Installs and model
downloads run in the backend, so an in-flight install survives the step-3 remount — on return
the UI reattaches via §19 `GET /agents/install/{id}` and the live `harness.install` /
`ollama.pull` streams; the model download "finishes in the background" as promised. Installs
never need admin rights (§19 channels are all user-writable), so there is no sudo or
permission-declined state anywhere in the flow.

## 11. Create / edit flow

Entry: New button, onboarding step 3, or Edit on a detail page. If no agents exist (outside
onboarding), redirect to Agents with toast "No agent yet — add one here first. Creating and
editing automations needs an AI."

**Ask.** 620 px column, "What should Autowright do for you?", 4-row textarea, then an
"OR START FROM AN EXAMPLE" eyebrow over icon-led example chips (fa icon + label; accent-tinted
border/background on hover, 1 px press-down on :active): Track manga chapters (fa-book-open) /
Back up a folder every night (fa-box-archive) / Email me a weekly report (fa-envelope) / Watch a
product's price (fa-tag) / Tidy my screenshots folder (fa-broom). "Written by `<agent>`" dropdown
(footer: "Autowright still executes everything"), CTA "Draft the automation". Empty text blocks with
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
from the agent's answer; the user edits any of them (usually the fix). Card look: an amber
left accent bar, and — only when the list has several blockers — a "BLOCKER N" eyebrow header.
The fields are auto-growing textareas (ask-box pattern: sized to their content, never
scrolling, no manual resize handle) with comfortable minimum heights — roughly two text lines
for Reason and Details and three for How to fix, the main editing target, whose box also draws
a slightly brighter border. A focused field shows an amber border. Where the cards appear
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
  renderer. Both body states are height-stable: the rendered view and the in-place editor
  each size to their content and share the same max height (440 px) with inner scrolling —
  the editor is an auto-growing textarea (ask-box pattern, no manual resize handle), so
  toggling Edit/Cancel/Save never jumps the card height. Also an
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
  paragraph; the edit state is an auto-growing textarea (ask-box pattern, no manual resize
  handle, comfortable ~3-line minimum) sized to its content like the rendered view, so
  toggling view/edit doesn't jump the card height; edit placeholder "Markdown — one rule per line: 'Prefer
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
  §6.2 package update below.
  One row per §6.2 declared package — the distribution name in mono, followed by the
  **installed version** (from the §19 check — the real version in the shared directory, never
  a manifest value) in faint mono, plus a status chip:
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
  (§19 `POST /packages/outdated`, advisory — a failure leaves badges off; the comparison
  baseline is the installed version). An outdated row shows an accent-tinted "→ x.y.z" badge
  after the installed version and an **Update** button on the row; two or more
  outdated rows add an **Update all** row above the footer. The header appends "· K updates"
  while any row is outdated (count hidden at zero). Clicking updates via §19
  `POST /packages/update` — `pip install --upgrade` in the shared directory, no manifest
  writes; the affected rows show the installing spinner, then the fresh installed version and
  status. Since the directory is shared, the new version applies to every automation using
  the package. Updates never force the card open and never gate Save.
- **Framework instructions** — read-only card showing `framework-instructions.md` **rendered
  as markdown** (the shared §4.5 Markdown component — full GFM; max-height 420 px with inner
  scroll). The file content itself is untouched —
  what is rendered is byte-for-byte what the agent receives. Content comes from §19
  `GET /instructions` (fetched once per app session and cached); the same response carries
  `default-build-instructions.md` as the fallback pre-fill for the Build instructions card.
  Collapsed hint and footer copy: built-in instructions the AI reads before writing anything,
  word for word — they update with the app, nothing for the user to maintain.
- **Test** — executes the draft's **real steps** as a **test execution record** (§4.5:
  `test: true`, `ver: "Test"`, `trigger: "Test"`) through the exact engine path a real
  execution takes (there is no simulation mode): the record and its `steps/` (the sent
  draft's scripts), `workspace/`, `result/`, and per-step-attempt logs all live under
  `executions/<uuid>/`, progress streams over the ordinary `exec.*` WS events, and the
  result, failure diagnostics, and secret redaction work exactly as in §7. The card's
  header button reads **"Test the draft"** ("Test again" once a test outcome exists;
  Cancel while a test is executing) — never "Execute", which is reserved for real
  executions (§4.4 "Execute draft", §7 "Execute again"). A test uses: in-editor param
  values and grants (never the stored automation's), and **scratch memory** — copied to a
  temp dir from the draft container's `memory/` when it exists (edit mode falls back to
  the automation's memory dir; create mode to empty) and discarded when the test ends, so
  a test can never poison the memory the deployed version reads (§4.1). What distinguishes
  a test record from a real execution: it never touches the automation's derived display
  state or the one-execution-at-a-time gate (§5), it is excluded from the Executions list
  and the §6 retry-once rule, it cannot be retried or re-executed from its execution page,
  and its lifetime is the draft's — starting a new test deletes the previous test record
  (one per draft container, and one **live** test per container: §19 answers 409), and a
  settled draft (discard, save as vN+1, Create, Start over) deletes its test records.
  Deleting the automation deletes them too.
  **Test parameter values (create and edit mode):** when the draft has params,
  the card offers a collapsed "Set parameter values for this test" affordance; expanding it
  shows one editor per param (§4.2 kinds), prefilled in edit mode with the automation's
  current values (draft default when a param is new) and in create mode with the draft
  defaults. The edited values ride the §19 `paramValues` body field and apply to this test
  only — nothing is stored, and the read-only Parameters card is untouched. Left collapsed,
  the test uses the automation's stored values (edit) or the draft defaults (create), exactly
  like executing the draft. The collapse button reads "Use current values" in edit mode and
  "Use defaults" in create mode. The resolved values are snapshotted on the test record, so
  its execution page shows them like any execution's. Side effects outside memory are real
  (emails send, files move, notifications post per settings) and the card says so plainly.
  **The card itself stays compact — status + progress, no logs:** while the test executes it
  shows a status line ("Executing — step 2 of 5 · <step name>"), a progress bar (terminal
  steps over total), and a **"View run"** button opening the test's §7 execution page, where
  the live step timeline, streaming logs, and (when finished) the full result views are the
  ordinary execution-page surfaces — one run UI everywhere instead of a second, smaller one
  in the card. When the test finishes the card shows the outcome line ("Test succeeded" green /
  "Test failed" amber / "Test cancelled" faint) with the same View-run button. Navigating
  away from the editor no longer cancels a live test — it is a real record, visible and
  cancellable from its execution page; re-entering the editor re-attaches the card to a
  still-executing test. **The outcome is never thrown away with the editing session:** a
  finished test writes the last-test summary `test.yaml` (§5 — status succeeded | failed,
  finished-at, and the test execution's id) into the draft container, wiped at the next test
  start and deleted with the draft. It rides the draft payload as `test` ({ status, when:
  §4.1 started-label, execId }) — on the automation's `draft` object and on `GET /draft` —
  and a resumed draft's Test card renders it in place of the empty hint: a status line
  ("Last test succeeded — <when>" green / "Last test failed — <when>" amber) plus the
  View-run button while the record still exists (retention may outlive it — the button
  hides when the record is gone); the header button reads "Test again". A live test always
  takes over the card. **On failure nothing analyzes by itself:** the card shows the "Test
  failed" line plus an **"Analyze the failure"** button beside View run — the §8
  issue-analysis call (log tails read from the record's log files) runs only when the user
  asks (§19 `POST /tests/{execId}/analyze`). While it runs the card shows "Analyzing the
  failure…" (agent label). The resulting blockers render **inline in the Test card — never
  a modal**: headline "The test hit an issue", the Blocker modal's editable reason/fix/details
  fields rendered bare — no card border around them, the Test card already provides the
  frame — the "Previously resolved" list, a quiet Dismiss, and the primary button
  **"Apply to the spec & sync the steps"**, which amends the in-editor spec (same
  `## Constraints & resolutions` rule) and starts a §8 sync — build-time blockers and
  execution-time issues stay one convergent repair loop, with the build-time entry keeping
  its modal. If the analysis call itself fails, the inline block still appears with the
  failing step's raw error as the reason and an empty fix for the user to fill in. A test
  that fails before any step (missing/disallowed secret, package install) analyzes
  deterministically — the block appears at once with the §4.5 error message as the reason
  and the plain-word §7 reason as the fix, no agent call. Advisory: a failed test never
  blocks saving.

**Ask panel (Review only).** A question-and-answer surface for the workflow being edited —
strictly read-only, powered by the §8 `question` job.

- **Entry:** a fixed **Ask button** floating at the Review page's bottom-right (24 px margins,
  above the content, `no-drag`): a rounded-square quiet/bordered button — same shape language
  as the §9.1 inline execute button but never accent-filled, so it doesn't compete with the
  primary Create/Save — with a chat-bubble icon (fa-comment) and tooltip "Ask about this
  workflow". Its background is **opaque** (the card background) with a soft shadow — it floats
  over scrolling content, so it must never be transparent. It renders only on Review with a
  loaded draft, and hides while the panel is open.
- **Panel:** a right slide-over, 400 px wide, from below the 18 px drag strip to the window
  bottom; card background, 1 px left hairline, soft shadow; it **overlays** the content —
  the 1800 px review grid never reflows. Deliberate exception to the §9 popover rule: it does
  **not** close on outside mousedown — the point is reading an answer while editing behind
  it. It closes only via its header × or Esc. Header: `ASK` eyebrow + a mono agent tag (the
  selected drafting agent, `name · model`) + the × button. **Motion:** enters sliding in from
  the right (~14 px offset + fade, .18s ease both) and exits with the mirror slide-out (.12s
  ease both — exits faster than entrances, like the Modal). Every dismissal path (× and Esc)
  plays the exit through one close routine — the Modal's animated-close pattern: a closing
  state, unmount on `animationend` (guarded to the panel element) with a timeout fallback for
  reduced-motion setups. The Ask button reappears only after the exit completes.
- **Thread:** scrolling body, newest at the bottom, auto-scrolled on new content. Each entry
  is the question (quiet plain text) followed by its answer rendered through the shared §4.5
  Markdown renderer, `.ad-copy` selectable. Empty state: "Ask anything about this workflow —
  the steps, the spec, why the AI chose something." The thread is **editor state only** —
  never serialized into the draft, gone on leaving the page (same lifetime as the spec-undo
  snapshot).
- **Input:** footer with an auto-growing textarea (ask-box pattern: Enter sends, Shift+Enter
  newline, no resize handle, never scrolls). Sending starts one §8 `question` job with the
  selected drafting agent and the in-editor draft as `current` (spec + steps + instructions,
  §19) plus the in-editor grant arrays — answers match what's on screen, unsaved edits
  included. While the job runs, the pending thread entry shows the one spinner plus the live
  §8 `detail` line ("Thinking…" / "Writing the answer · N lines"); the send slot shows only a
  ghost Cancel (`DELETE /drafts/{jobId}`) — no second spinner there — and cancelling drops the
  pending entry and returns the question text to the input. One agent job at a time overall: while any drafting job is in flight
  (spec/steps/sync/edit or another question), the input is disabled with the hint "Wait for
  the current job to finish."; equally, a pending question blocks the other ask boxes through
  the same busy gating.
- **Failure:** the entry's answer slot shows a red-tinted line with the error message; the
  question text stays visible in the thread. No blocker path (§8 question call has none).
- A question never touches the draft, never marks the workflow out of sync, and never
  interacts with Dirty gating or Save.

Create (new) → version 1, `lastStatus: none`, navigate to detail, toast "Created — nothing has
executed yet. Press Execute now when you're ready." Save (edit) → §4.4.

## 12. Agents & Secrets pages

**Agents.** Tile grid of agent cards — same grid as the Automations list (§9.1,
`repeat(auto-fill, minmax(310px, 1fr))`), not a vertical list; each card's action row sticks to
the card bottom so tiles in a row align. Badge states Checking (cyan) / Connecting / Ready (green) /
Needs setup (amber). Statuses are cached in the renderer for the app session: each agent is
checked once, staggered, on the first Agents page visit that sees it (new agents get checked on
the next visit); later visits render the cached badge with no re-check. The cache entry for an
agent updates when its edit form saves ("Connecting" until the fresh result lands, §4.7 check
re-run right after the save) and when the reconnect flow's check answers (§12 form banner).
Each card shows the agent's `desc` detail line — the real §4.7 desc only, never
generated marketing copy (the desc is drafting input, §8 grants yaml); when the desc is empty
the line reads "No description yet — add one in Edit to tell the drafting AI what this agent
is for." —
and a **USED BY** row of clickable automation chips (fallback "Not used by any automation yet.").
USED BY means actual reference, not permission: an automation is listed when the agent is its
writer (`agent_id`) or a current-version step carries the agent's `agent_id`. The
`enabled_agents` grant alone never counts — same rule as secrets, whose usage is step-code
references, not `allowed_secrets` (§12 Secrets).
There is no Edit button —
the whole card is clickable (same hover treatment as the Automations list tiles) and opens the
§12 edit form; a Needs-setup card opens it with the reconnect banner. Clicks on the overflow
menu and on USED BY chips do not navigate. The card's overflow (ellipsis) menu
button sits at the card's top right, on the title row, visible in every badge state (while a
check is in flight only "Remove agent…" is offered); its popover opens right-aligned. The
overflow menu holds, for
ready agents, "Check connection" — a real §19 `/agents/{id}/check` call timed by the
renderer: the badge returns to Checking while it runs, success toasts "`<name>` answered in
X.X s — ready.", failure flips the badge to Needs setup and toasts "`<name>` didn't answer —
needs setup." — and, when not default, "Make default"; for every agent it holds
"Remove agent…" (red, confirm modal). Default status is indicated by the absent "Make default"
menu row — no chip. Empty state (dashed card): "No agents yet. Existing automations still execute on
schedule — but you need an agent to create or edit them." + CTA "Add your first agent".

**New / Edit agent** form (720 px, one form — title and submit label switch to "Edit agent" /
"Save changes" when editing): pick harness (Claude Code / Gemini CLI / Codex / OpenCode —
all four selectable, §4.7), mode (default model vs. a specific model vs. local Ollama model —
the specific-model option renders for every harness; the local-model
option renders only when the harness is OpenCode, §4.7),
model (required for specific-model and local-model modes — the specific-model mode shows a
mono free-text input with a per-harness placeholder: Claude Code "e.g. claude-opus-4-8",
Gemini CLI "e.g. gemini-2.5-pro", Codex "e.g. gpt-5-codex", OpenCode
"e.g. anthropic/claude-opus-4-8"; OpenCode expects the provider/model form), name
(required), optional description ("What this agent is for — shown on the Agents page and given
to the drafting agent"). The
submit button renders disabled-styled until valid but stays clickable: submitting with a missing
name shows an inline red error "A name is required — give this agent a name before saving." (red
input border, clears on typing); missing Ollama toasts "Install Ollama first."; otherwise "Pick
a harness and a model first." Success toasts: "`<name>` added — ready to write automations." /
"Changes saved — `<name>` is ready." When editing a signed-out agent, the form shows a reconnect
banner: "This agent is signed out — reconnect it to create or edit automations." + Reconnect
button. The local-model mode is gated on Ollama being
installed and ready. Inline install flow: button "Install Ollama" starts a real §19
`POST /agents/install` for Ollama; the label "Installing Ollama…" renders a determinate bar
when the `harness.install` stream carries a percent (indeterminate otherwise), and failure
shows "Install failed — `<first error line>`" with the button returning to "Install Ollama".
**LOCAL MODEL** picker: radio list of installed Ollama models with
size metadata, empty state "No local models installed yet — download one below and it will show
up here." Model pulls: one at a time — the backend streams raw `ollama pull` output over the
`ollama.pull` WS event and the UI parses the percent out of it (right column shows "N%";
determinate bar when a percent is present, indeterminate otherwise — real `ollama pull` output
may not yield a percent); suggested-model
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
(blur), header row with "AUTOWRIGHT" eyebrow left and aggregate status right (mono 11 px; "All good
· N automation(s)" — pluralized by count — or "N need(s) attention" in red), one row per automation (7 px status dot —
pulsing while executing, name, mono sub-line colored by state: cyan "Executing now…" / red when failed
/ accent for a result chip / faint otherwise, bordered execute button at 35 % opacity that goes fully
opaque on hover (accent hover border), relative time right-aligned in a 56 px column). Row click opens the app on that automation; execute
button triggers a "Menu bar" execution. Footer: accent "Open Autowright" link + version. Click-outside
closes.

**Deep-link mechanism:** a row click sends the target `'/app?auto=<id>'` to the main process.
With no main window, the window is created loading that hash and the renderer's boot reads
`auto=<id>` to land on the automation's detail page. With an existing window, main pushes the
target over IPC (`open-target`) and the renderer navigates in place — never a page reload,
which would drop the WebSocket and all renderer state. The footer link sends plain `'/app'`
(focus only). Deep links are ignored while onboarding hasn't completed.

## 14. Design tokens (authoritative — `app/src/tokens.css` implements them)

- Dark theme only. Fonts: IBM Plex Sans 400/500/600/700 (all UI text; `--sans`), IBM Plex Mono
  400/500/600 (timestamps, version labels, chips, eyebrows, counts, technical metadata;
  `--mono`), bundled via `@fontsource`. `-webkit-font-smoothing: antialiased`.
- Type scale: base UI 13 px; page titles 20 px/600 (26–30 px in onboarding/create); card titles
  15 px/600; body 13–13.5 px/400, line-height 1.55–1.6; secondary 12–12.5 px; metadata/mono
  10.5–12 px; eyebrows 9.5–10 px/600 mono uppercase, letter-spacing `.09em`. Headings tighten
  letter-spacing (`-.01em` to `-.02em`).
- Backgrounds: window `#0b0e12` (`--bg-window`), content `#0e1116`, sidebar `#0a0d11`, cards
  `#12151c` (`--bg-card`; selectable/hovered cards `#14181f` `--bg-card-sel`), inset/result
  wells `#0d1015` (`--bg-inset`), popover menus `#161a22` (`--bg-menu`), toast `#1b202a`
  (`--bg-toast`). Menu-bar panel: `rgba(25,28,35,.94)`, 334 px wide, radius 12,
  border `rgba(255,255,255,.1)`.
- Text: primary `#e9ecf1` (`--text`), secondary `#a8b0bc` (`--text-2`), emphasized secondary
  `#c6cdd6` / `#dfe4ea` (`--text-2em`/`--text-2emx`), muted `#8a93a0`, faint `#67707c`,
  faintest `#4f5763`.
- Borders (white at alpha): hairlines `.06` (`--hairline`), cards `.07`, inputs `.10`,
  buttons `.11`, hover `.25` (`--border-hover`).
- Accent (brand orange): `oklch(0.74 0.155 52)`; hover `oklch(0.79 0.155 52)`; tint backgrounds
  `--accent-bg` `/ .15`, `--accent-chip-bg` `/ .13`, `--accent-hint-bg` `/ .08`; text on accent
  `#16100a` (`--on-accent`); link hover `oklch(0.82 0.14 60)`; `::selection` accent `/ .35`.
- Status colors (oklch; tint backgrounds at the alpha shown): green `oklch(0.76 0.15 150)`
  `/ .13`, cyan `oklch(0.78 0.12 210)` `/ .13`, red `oklch(0.7 0.19 25)` `/ .13`, amber
  `oklch(0.8 0.13 85)` `/ .14`, magenta `oklch(0.72 0.16 340)` `/ .13`, gray `#98a1ad` /
  `rgba(152,161,173,.13)`. One extra chip color: orange `oklch(0.72 0.15 60)` `/ .13` for
  attention-flavored result chips (e.g. "5 of 6 checked").
- Radii: buttons/inputs 8 px, chips 6–7 px, cards 12 px, pills 16–20 px,
  popover menus 10 px, toast 9 px. Cards are flat (border only); floating surfaces get large
  soft shadows — popovers `0 18px 44px rgba(0,0,0,.5)`, toast `0 10px 30px rgba(0,0,0,.4)`,
  modal `0 24px 60px rgba(0,0,0,.5)`, menu-bar panel `0 18px 50px rgba(0,0,0,.55)`.
- Selection allowlist: app chrome is unselectable (`user-select: none` on body); content
  surfaces (logs, results, spec text, scripts, paths) opt in with `.ad-copy`; inputs and
  textareas always selectable. `.ad-drag` marks the hiddenInset title-bar drag region
  (interactive children opt out with `no-drag`).
- All hover and focus states are CSS classes in `tokens.css` — never JS mouse-state (a JS hover
  flag sticks when a re-render or layout shift moves the node under the cursor). Buttons:
  `.ad-btn-primary`, `.ad-btn-ghost`, `.ad-btn-soft`, `.ad-btn-text`[`.dim`], `.ad-btn-pill`,
  `.ad-btn-dashed`, `.ad-btn-x`, `.ad-btn-accent-ghost` (accent-tinted ghost: Execute once/draft,
  Add trigger), `.ad-btn-danger-ghost` (red-tinted confirm), `.ad-btn-text.danger` (red text
  button), `.ad-btn-link` (accent link-styled button), `.ad-chip-btn`, `.ad-menu-row`.
  Surfaces: `.ad-hover-row` (clickable list/table rows), `.ad-card-click` (clickable cards),
  `.ad-link-title` (clickable titles), `.ad-nav-row` (sidebar nav). Text fields use `.ad-input`
  (border + accent focus ring; `.amber` variant on amber notice cards). Classes own colors,
  interaction, **and size** — call sites never override button padding/font-size/radius inline
  (layout-only styles such as `flex`, `whiteSpace`, margins are fine). All action buttons share
  one size: 13 px font, radius 8 px, padding 8 px 15 px on bordered buttons (`.ad-btn-ghost`,
  `.ad-btn-soft`, `.ad-btn-dashed`, `.ad-btn-accent-ghost`, `.ad-btn-danger-ghost`) and
  9 px 16 px on the borderless filled `.ad-btn-primary` — same rendered box. Borderless text
  buttons (`.ad-btn-text`, `.ad-btn-link`) are 500 13 px with 6 px 4 px padding. Non-action
  controls keep their own scale: `.ad-btn-pill` (mono metadata pill), `.ad-chip-btn`
  (example-prompt chip), `.ad-btn-x` (row-remove ✕), `.ad-btn-exec` (square icon button).
- Derived tokens beyond the base palette: `--red-hover`, `--red-text`, `--accent-sel`
  (selected-card border), `--hairline-dim` (in-card row dividers; `--hairline` stays for card
  borders/headers), `--bg-code` + `--code-text` (script/log wells). Recurring fragments are
  `ui.tsx` primitives: `MiniBadge` (uppercase mono chip; status `Badge` maps onto it),
  `ProgressBar`, `GreenCheck`, `Spinner` (optional `color`), `PageTitle`, `Eyebrow`.
- Icons: Font Awesome 6.5.2. App mark: accent rounded square with a hammer glyph (`fa-solid fa-hammer`).
  The same mark is the macOS dock icon (`app/electron/appIcon.png`, 1024 px, mark at ~80% of canvas,
  generated by `scripts/gen_app_icon.cjs`; set at startup via `app.dock.setIcon` in
  `app/electron/main.cjs` so dev sessions don't show the default Electron icon).
- Motion (keyframes in `tokens.css`: `adFadeUp`, `adFadeOutDown`, `adFadeIn`, `adFadeOut`,
  `adSpin`, `adPulse`, `adBlink`, `adBarSlide`): fade-up entrances (.3–.5 s; popovers .18 s),
  spinners .8–.9 s, amber "waiting on you" pulse 1.2 s.
  Modals (shared `Modal` shell in `ui.tsx`: backdrop + card, used by the secret add/edit modal
  and `ConfirmModal`) animate both ways — enter .18 s fade-up, exit .12 s fade-down — and every
  dismissal path (backdrop click, Escape, Cancel, save/confirm) plays the exit before unmount;
  confirm actions fire after the exit finishes.
- Layout: sidebar 212 px fixed; page gutter 30–32 px, max width 1200 px (Review page 1800 px,
  forms 620–720 px, settings 640 px); card padding 15–22 px; control padding 9–10 px vertical /
  14–18 px horizontal.
- Scroll chaining: inner scroll panels embedded in the page flow (spec viewer, execution log
  pane, etc.) chain to the page — reaching their bottom continues scrolling the page (browser
  default; no `overscroll-behavior: contain`). Only floating surfaces (popovers, dropdowns,
  modals) may contain overscroll.
- Scroll chrome: overlay scrollbars everywhere — they draw on top of the content and take
  zero layout space, so content never shifts when one appears. Electron main enables
  Chromium's `OverlayScrollbar` feature (`app.commandLine.appendSwitch('enable-features',
  'OverlayScrollbar')`) — required because macOS "Automatic"/"Always" system scrollbar
  settings otherwise force classic space-taking bars. No `::-webkit-scrollbar` styling
  anywhere (custom rules would force classic bars back). The root declares
  `color-scheme: dark` so the overlay thumb renders light on the dark background.
  Textarea resize grip (`::-webkit-resizer`) is an inline-SVG grip icon — two rounded
  diagonal strokes, white 28 % — so it stays crisp instead of WebKit's light default square.

## 15. Dev/test knobs

**Dev/release parity rule:** dev and release share the SAME code paths — there are no mock modes,
no alternate backends, no dev-only branches in app code. The only knobs that exist are pure
configuration (they relocate or re-tune the same behavior, never select different behavior).
Every knob defaults to the release value and is developer opt-in; the single knob dev.sh sets
itself is `AUTOWRIGHT_RENDERER_URL` (below — same renderer source, served with HMR instead of
pre-bundled). Dev sessions use the real app-support dir, real Keychain, real agent CLIs, random
port, request logging via the §4.9 devMode setting (§5), and the real launchd service (§18
dev.sh).

Frontend state (localStorage/URL — production mechanisms, not dev branches): `ad-onboarded`
(persisted onboarding completion; clearing it replays onboarding), `#menubar` URL hash (selects
the menu-bar surface — how the tray panel window loads). The renderer discovers the backend only
via `backend.json` through the Electron preload bridge; there is no browser-dev URL-param
fallback.

Backend env knobs (configuration only):

- `AUTOWRIGHT_HOME` — overrides the app-support root (isolated dev/test homes); logs move to
  `<home>/logs/` (§5).
- `AUTOWRIGHT_PORT` — fixed port instead of a random free one.
- `AUTOWRIGHT_OLLAMA_URL` — Ollama HTTP endpoint override (default `http://localhost:11434`).
- `AUTOWRIGHT_STEP_TIMEOUT` — per-step timeout in seconds (default 900).

Electron env knob (configuration only):

- `AUTOWRIGHT_RENDERER_URL` — when set, Electron `loadURL`s the renderer from this origin (with
  the same `#/app` / `#/menubar` hashes) instead of `loadFile`-ing `app/dist/index.html`. It
  points at a Vite dev server serving the identical `app/src` source — HMR delivery of the same
  code, not a different code path (the preload bridge, `backend.json` discovery, and backend
  are untouched; the backend's open CORS covers the http origin). Set by `dev.sh` (§18);
  release never sets it.

Test doubles live in `tests/` only: a fake `claude` CLI at `tests/bin/claude` (conftest prepends
`tests/bin` to `PATH`, so the real detect/invoke/subprocess path is exercised against it) and conftest
fixtures that monkeypatch `keychain` (in-memory dict) and `notify.post` (no-op). Removed knobs —
do not reintroduce: `AUTOWRIGHT_MOCK_AGENT`, `AUTOWRIGHT_KEYRING`, `AUTOWRIGHT_NO_NOTIFY`,
`ad-sudo-denied`, `?port=&token=` (the renderer dev server returned as `AUTOWRIGHT_RENDERER_URL`,
above — `VITE_DEV`/`npm run dev:app` themselves stay gone).

## 16. Seed / demo data (tests only)

The shipped app has NO seed path: a fresh install always starts empty (onboarding), and there is
no CLI or API to populate demo data. The seed fixture lives in `tests/seed_data.py` and is
applied only by tests calling `seed(store)` (it refuses to seed when any automations exist).

The fixture ships four demo automations: "Track manga
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

- `backend/` — Python package `autowright`: storage, engine (+`executor.py` step SDK,
  `imports_check.py` shared §6.2 import allowlist), scheduler, drafting, harness adapters,
  FastAPI API (`api.py`), launchd service (`service.py`), CLI (`cli.py`).
  `autowright/instructions/` holds the §8 prompt texts as markdown (packaged via
  `[tool.setuptools.package-data]`): `framework-instructions.md` (contract preamble) and
  `default-build-instructions.md` (default build instructions seeded into new automations).
  `pyproject.toml` defines the `autowright` / `autowright-backend` entry points.
- `app/` — Electron app: `electron/main.cjs` + `preload.cjs` (window, tray panel, backend.json
  bridge), Vite + React + TS renderer under `src/` (`store.ts` central model, `api.ts` client,
  `ui.tsx` shared primitives, `tokens.css` design tokens, `pages/` one file per screen).
  `UI-GUIDE.md` records the renderer conventions.
- `scripts/` — project scripts (`dev.sh`, `build.sh`, `prod.sh`, `logs.sh`, `clean.sh` — §18;
  `uninstall/` — developer-only uninstall scripts for the harness CLIs and Ollama, §18;
  `gen_tray_icon.py` renders the tray template PNGs;
  `gen_app_icon.cjs` renders the dock icon `app/electron/appIcon.png` via Electron —
  invoked from `app/` as `./node_modules/.bin/electron ../scripts/gen_app_icon.cjs`;
  `commit` stages all uncommitted changes, generates a commit message via
  `claude --model claude-opus-4-8 -p` from the staged diff, and commits;
  `knowledge.sh` regenerates `knowledge.md`, §18).
- `tests/` — pytest suite for the backend (storage, drafting, engine, schedule, API), plus the
  test doubles: `tests/bin/claude` (fake agent CLI) and `tests/seed_data.py` (§16 fixture).
- `LICENSE` — MIT, copyright David Zhang (also `"license": "MIT"` in `app/package.json`).

## 18. Commands

Everything under `scripts/` is developer-only: run by hand in a terminal, never by an agent.
`.claude/settings.json` enforces this with PreToolUse hooks (commands in
`.claude/hooks/guard_bash.py` + `guard_paths.py`): the Bash hook blocks any command referencing
the repo's `scripts/` directory (bare `scripts/`, `./scripts/`, `cd scripts`, or the
`$CLAUDE_PROJECT_DIR` absolute path) or the repo-root `knowledge.md`; the path hook
(`Read|Edit|Write|Grep|Glob`) blocks tool calls targeting the repo-root `knowledge.md`.
Both are scoped to exactly those repo-root paths — same-named files or `scripts/` directories
anywhere else (other repos, `node_modules`, subdirectories) are unaffected. Deterministic
harness-level block, independent of model compliance; agents may still read/edit the `scripts/`
files via the non-Bash tools. Agents verify
changes by launching the app pieces directly (backend module, `npm run build`, Electron via
playwright — see `.claude/skills/verify`).

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
  cached in `build/cache/`, URL overridable via `AUTOWRIGHT_PBS_URL`), pip-installs the backend
  + curated packages into it (inside the bundle the backend/CLI execute as
  `python3 -m autowright.main` / `-m autowright.cli` — pip's `bin/` entry scripts carry absolute
  staging-path shebangs), renders `appIcon.icns` from `app/electron/appIcon.png`
  (sips + iconutil), packages `Autowright.app` with `@electron/packager` (bundle id
  `com.autowright.app`; ships only `electron/`, `dist/`, and `package.json` — the renderer is
  fully bundled and main/preload use Electron builtins only, so no `node_modules`), copies
  the interpreter to `Contents/Resources/python/`, codesigns (Developer ID + hardened runtime
  on every Mach-O when `CODESIGN_IDENTITY` is set — notarization itself not performed; ad-hoc
  otherwise, local use only), smoke-checks that the bundled interpreter imports `autowright` +
  every curated package from inside the bundle, and produces
  `build/Autowright-<version>-<arch>.dmg` (hdiutil UDZO).
- **`./scripts/dev.sh`** — fastest dev loop, with hot reloading: invokes `build.sh --deps` only
  (no renderer bundle); shuts down lingering processes from previous sessions — backend by
  command-line pattern (`[Pp]ython -m autowright` — ps shows the venv python's resolved binary,
  never the `.venv/bin/python` path; SIGTERM, 5 s grace, then SIGKILL — backends can hang in
  graceful shutdown while uvicorn waits on open WebSockets), stale Electron, and stale Vite;
  then (re)installs the real launchd LaunchAgent (`autowright service uninstall` +
  `service install`, `com.autowright.backend`, §3) so the backend behaves exactly as in release:
  launchd-managed, RunAtLoad/KeepAlive, cwd `/`, minimal launchd PATH, random free port,
  macOS Keychain, devMode-gated request logging (§5) to `backend.out.log`/`backend.err.log`
  under the logs
  dir (§5), data in `~/Library/Application Support/Autowright` (starts empty on a fresh
  machine); starts a Vite dev server on a random free port (`npx vite --strictPort`, log
  `vite.log` under the logs dir, killed on script exit); waits for a fresh `backend.json`
  (rewritten with new pid/token
  each start) plus `/health` and for Vite to answer, then launches Electron in the foreground
  with `AUTOWRIGHT_RENDERER_URL=http://127.0.0.1:<vite port>` (§15) — renderer edits under
  `app/src` hot-reload live; backend edits need a dev.sh restart. Quitting Electron normally
  (Cmd+Q) leaves the backend running (release semantics — automations keep firing; stop it with
  `.venv/bin/autowright service uninstall`). Ctrl+C in the dev.sh terminal instead shuts the
  whole app down: Electron dies with the terminal's SIGINT, the exit trap kills Vite, and an
  INT/TERM trap stops the backend — `autowright service uninstall` first (launchd KeepAlive
  would otherwise respawn it), then the same SIGTERM → 5 s grace → SIGKILL escalation as the
  startup stale-process sweep (a plain SIGTERM leaves uvicorn hanging in graceful shutdown);
  the script exits 130. The SIGKILL path leaves a stale `backend.json` behind, which the next
  startup already tolerates (fresh-file compare).
  Isolated mode: setting any `AUTOWRIGHT_*` knob (§15) switches dev.sh to spawning the backend
  directly with that env instead of via launchd (the plist carries no env) — detached, cwd `/`,
  launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), same log filenames under the chosen home.
  `--fresh` wipes the data dir first and is refused unless `AUTOWRIGHT_HOME` is set (never wipes
  the real app data).
- **`./scripts/logs.sh`** — follows all log streams in one terminal (`tail -n 25 -F`):
  `backend.err.log`, `backend.out.log`, `app.log`, plus `vite.log` when present. Resolves the
  logs dir exactly like dev.sh (`~/Library/Logs/Autowright`, or `<home>/logs` when
  `AUTOWRIGHT_HOME` is set, §5); creates missing backend logs so `tail` starts clean.
  **`--clear`** truncates the logs in place first (`: >` — writers keep their open
  append-mode handles), then follows.
- **`./scripts/clean.sh`** — resets the repo to a pre-build state so the next `build.sh`/`dev.sh`
  rebuilds from scratch. First stops anything running (deleting `.venv` under the live launchd
  KeepAlive service would otherwise break): `autowright service uninstall`, then the same
  kill_stale patterns as dev.sh for the backend, Electron, and Vite. Then deletes the build
  artifacts: `.venv` (incl. the `.backend-stamp`), `app/node_modules`, `app/dist`, and the
  contents of `build/` except `build/cache/` (the pinned CPython tarball, expensive to
  re-download); **`--cache`** drops the cache too, removing `build/` entirely. Never touches the
  data dir (`~/Library/Application Support/Autowright` or `AUTOWRIGHT_HOME`) or the logs dir
  (`logs.sh --clear` handles logs).
- Backend: `python3.14 -m venv .venv && .venv/bin/pip install -e "backend[dev]"`; test with
  `.venv/bin/python -m pytest tests/`; dev.sh launches the backend via `python -m autowright.main`
  (equivalent to the `autowright-backend` entry point); start an isolated backend (real agent CLIs,
  real Keychain, empty home) with `AUTOWRIGHT_HOME=<dir> AUTOWRIGHT_PORT=8799 .venv/bin/autowright-backend`.
- App: `cd app && npm install`; typecheck+bundle with `npm run build`; `npm run app` launches
  Electron against the built bundle (release delivery; dev.sh instead serves the same source
  via Vite + `AUTOWRIGHT_RENDERER_URL`, §15).
- **`./scripts/uninstall/<tool>.sh`** (`claude-code.sh`, `codex.sh`, `gemini.sh`,
  `opencode.sh`, `ollama.sh`) — developer-only reversal of the §19 installers, run manually by a
  developer in a terminal. Default removes the tool's binary from `~/.local/bin` (Gemini via
  `npm uninstall -g --prefix ~/.local @google/gemini-cli` plus its `~/.local/lib/node_modules`
  tree; Ollama stops the running server first; OpenCode prefers the CLI's own
  `opencode uninstall --force` — with `--keep-config --keep-data` unless purging — then removes
  any leftover paths). **`--purge`** also deletes the tool's
  config/auth/data dirs (`~/.claude` + `~/.claude.json*` and `~/.local/share/claude`;
  `~/.codex`; `~/.gemini`; `~/.config`/`~/.local/share`/`~/.local/state`/`~/.cache`
  `opencode` dirs; `~/.ollama` incl. models). Never invoked by the app, the backend, or any
  agent — each script guards itself (shared `_lib.sh`): exits if agent env markers are present
  (`CLAUDECODE`), exits without an interactive TTY on stdin+stdout, and requires the developer
  to type the tool name to confirm.
- **`./scripts/knowledge.sh`** — regenerates `knowledge.md` at the repo root: a gitignored,
  developer-only orientation doc (concise, diagram-heavy — mermaid architecture + per-action
  sequence diagrams, annotated file tree, data-model and key-file tables). Invokes
  `claude --model claude-opus-4-8 -p` with read-only tools (`Read`, `Glob`, `Grep`, and
  read-only Bash: `ls`/`tree`/`git ls-files`/`git log`/`wc`/`head`/`cat`) to explore the repo
  (SPEC.md as primary source, verified against code), prepends a generated-at header, and
  writes atomically (temp file + `mv`). Purely for developer reading — never read by agents,
  never used to build the app; no other file references it. The §18 PreToolUse hooks reject
  any Bash command or `Read|Edit|Write|Grep|Glob` call targeting the repo-root `knowledge.md`
  (only that exact path — same-named files elsewhere are unaffected).
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
- `POST /draft/open` — §4.4: make the pending slot's container (`draft/` with an empty
  `memory/`) exist, never touching contents already there; the create flow calls it on
  open so the slot exists before any drafting or test
- `POST /automations/{id}/restore` `{ v }` — copy vX to vN+1 (§5)
- `POST /automations/{id}/memory/clear` — §6.3 pre-clear snapshot, then empty the §4.1 memory
  directory (backs §9.2 "Clear memory")
- `POST /automations/{id}/memory/snapshots` `{ name? }` — §6.3 manual snapshot (409 while
  live, 422 when memory is empty) · `PATCH /automations/{id}/memory/snapshots/{sid}`
  `{ name }` — rename; null/"" clears · `POST /automations/{id}/memory/snapshots/{sid}/restore`
  — §6.3 restore (409 while live) · `DELETE /automations/{id}/memory/snapshots/{sid}` —
  delete the snapshot; unknown `sid` answers 404
- `POST /tests` `{ autoId?, draft, enabledAgents?, allowedSecrets?, paramValues? }`
  → `{ execId }` — the §11 Test: starts a §4.5 **test execution record** of the sent draft's
  steps (`test: true`, `ver: "Test"`, `trigger: "Test"`; a stale `autoId` answers 404; 409
  while a test for the same draft container is executing; starting a test deletes the
  container's previous test record). Scratch memory is copied to a temp dir — when `autoId`
  is given, from its `draft/memory/` if present else its memory dir, else from the pending
  slot's `memory/` if present else empty — and discarded at test end. Grant arrays as in
  `/drafts`; param resolution uses the automation's stored values when `autoId` is given
  (else the draft's defaults), with `paramValues` (name → value, §5 matching rules) overriding
  on top for this test only — never stored; the resolved values are snapshotted on the
  record. Progress, logs, and the result flow over the ordinary `exec.*` events and
  `/executions/*` endpoints; cancel and skip-step are `POST /executions/{id}/cancel` and
  `/skip-step` like any execution (retry answers 409 — the draft may have changed). A
  failed test is **not** analyzed automatically — `POST /tests/{execId}/analyze`
  `{ draft, agentId? }` starts the §8 issue-analysis call on demand (`agentId` with the
  default-agent fallback; the sent draft supplies the spec and step code, log tails read from the
  record's log files; a failure before any step synthesizes the blocker from the record's
  §4.5 error with no agent call) and emits the blockers in `test.issue`
  (`{ execId, blockers }`); it answers 404 for an unknown or non-test record and 409
  unless the record's status is failed. A finished test writes the §11 last-test summary
  (`test.yaml`, §5) into the draft container; it rides the draft payload as `test`
  ({ status: succeeded | failed, when, execId }) on the automation's `draft` object and on
  `GET /draft`.
- `POST /packages/check` `{ packages: [{ pip, import }] }` → `{ packages: [{ pip, import,
  status: installed | missing, version? }] }` — the fast §6.2 installed-check, never runs
  pip; `version` is the real installed version, present when installed (backs the §11
  Packages card's page-load check) · `POST /packages/install` (same body) →
  `{ packages: [{ pip, import, status: installed | failed, version?, error? }] }` — the §6.2
  ensure, blocking; installs only what's missing, one pip run at a time process-wide (backs
  the §11 Install/Retry button) · `POST /packages/outdated` (same body) → `{ packages:
  [{ pip, import, latest? }] }` — read-only PyPI query (§6.2: newest stable non-yanked
  version with a compatible wheel); `latest` present only when newer than the **installed**
  version, absent when not installed or on any lookup failure (backs the §11 page-load update
  check) · `POST /packages/update` `{ packages: [{ pip, import }] }` → `{ packages: [{ pip,
  import, status: installed | failed, version?, error? }] }` — `pip install --upgrade` for
  each named distribution in the shared directory (§6.2: wheels only, serialized); no
  manifest writes; a malformed name → 422
- `POST /drafts` `{ mode: create|edit|sync|question, autoId?, text?, spec?, current?, agentId?,
  enabledAgents?, allowedSecrets? }` → `{ jobId }` — `question` requires a nonempty `text`
  (422 otherwise) and its terminal payload is `draft: { answer }` (§8 question call); the
  grant arrays, when present, override
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
- `GET/POST /agents` · `PATCH/DELETE /agents/{id}` · `POST /agents/{id}/check` (health/badge)
  and `POST /agents/check-harness` `{ harness, mode?, model? }` (the same check before an agent
  record exists — onboarding's found-card auto-check) — one shared readiness check
  (`harness.check_ready`) decides ready vs. needs-setup everywhere: the harness binary must
  resolve (rule below). A custom-model agent (mode `custom`, §4.7) checks exactly like a
  default-mode one — the typed model string is never validated by the check (§4.7); a wrong
  name surfaces at invoke time. A local-model agent (OpenCode with mode `ollama`, §4.7) additionally
  needs Ollama's server answering **and the agent's model installed** (the model appears in
  `/api/tags`; a bare name without a tag matches its `:latest` variant) — and needs **no**
  sign-in: a local model needs no account. Every default-mode check instead requires the
  harness to be signed in, by the per-harness rule below.
- **Sign-in state, per harness** (shared by `check_ready`, detection, and the signin poll):
  Claude Code — `claude auth status` exits 0 · Codex — `codex login status` exits 0 ·
  Gemini CLI — `~/.gemini/oauth_creds.json` exists (or `GEMINI_API_KEY` is set in the
  backend's environment) · OpenCode — `~/.local/share/opencode/auth.json` exists and holds a
  non-empty JSON object. Ollama is not a sign-in provider (no account; `POST /agents/login`
  answers 409 for it).
- `GET /agents/detect` (§10 detection) → one entry per harness, **all four always present**:
  `{ id, name, installed, signedIn, detail }` — `signedIn` is `true`/`false` by the rule
  above; `detail` is the real version/sign-in line rendered on §10 cards
  (never a fabricated "signed in" claim). Ollama state is not part of detection — the §10
  Free local AI card reads it from `GET /ollama/status`.
- **Install** — `POST /agents/install` `{ id }` starts a background install of that provider
  (409 while one is already running for the same id) and streams `harness.install` WS events
  `{ id, line, pct?, done, ok?, error? }` (determinate UI bar only when `pct` is present);
  `GET /agents/install/{id}` → `{ state: idle | running | done | failed, pct?, line?, error? }`
  lets a remounted UI reattach. Channels, per provider — official vendor channels only, all
  into user-writable locations (no sudo), never Homebrew:
  Claude Code — the official installer script (`curl -fsSL https://claude.ai/install.sh |
  bash`), lands in `~/.local/bin/claude`, indeterminate ·
  Codex — the latest GitHub release binary tarball for the Mac's architecture
  (`codex-{aarch64|x86_64}-apple-darwin.tar.gz`) unpacked to `~/.local/bin/codex`, determinate
  (Content-Length) ·
  Gemini CLI — `npm install -g --prefix ~/.local @google/gemini-cli` (bin lands in
  `~/.local/bin`); Gemini ships only through npm, so without `npm` on this Mac the install
  fails fast with "Gemini CLI needs Node.js — install it from nodejs.org first, then try
  again."; npm runs with the augmented PATH below so its `#!/usr/bin/env node` shebang
  resolves; indeterminate ·
  OpenCode — the official installer script (`curl -fsSL https://opencode.ai/install | bash`)
  with `OPENCODE_INSTALL_DIR=~/.local/bin`, indeterminate ·
  Ollama — the latest GitHub release standalone CLI (`ollama-darwin.tgz`) unpacked to
  `~/.local/bin/ollama`, determinate; the server then starts via the `/ollama/status`
  autostart below. Ollama installs only as a piece of the local-model setup (§10 Free local
  AI card, §12 local-model mode) — it is never a harness.
- **Sign-in help** — `POST /agents/login` `{ id }` → `{ ok, method: browser | terminal }`,
  only for harnesses that need an account and aren't signed in (409 otherwise): Codex — the
  backend spawns `codex login` detached (the CLI opens the browser and completes on its OAuth
  callback), method `browser` · Claude Code / Gemini CLI / OpenCode — their login flows are
  interactive TUIs, so the backend opens Terminal.app via `osascript` running the harness's
  login command (`claude /login` / `gemini` / `opencode auth login`), method `terminal`.
  The Terminal command `cd`s into the empty `harness-cwd/` dir (§6) first — Terminal shells
  otherwise start in `~`, and the CLI's startup scan must not walk the home folder.
  `GET /agents/signin/{id}` → `{ installed, signedIn }` is the cheap poll (§10 waits on it
  every 2 s) — it runs only that provider's sign-in rule, never version lookups.
- Ollama: `GET /ollama/status` → `{ ready, installed,
  models }`, `POST /ollama/pull`. All CLI lookups (detection and harness invocation alike)
  resolve the binary via PATH plus the usual macOS install locations (`~/.local/bin`,
  `~/.opencode/bin`, `/opt/homebrew/bin`, `/usr/local/bin`; Ollama additionally `Ollama.app`),
  because a GUI-launched backend gets a minimal PATH — e.g. `claude` installs to `~/.local/bin`
  by default. Invocation uses the resolved absolute path, and every provider child the backend
  spawns (harness invocations, installs, version/status probes, login helpers, `ollama` pulls)
  runs with PATH prepended with those same install locations plus the resolved binary's own
  directory — otherwise `#!/usr/bin/env node` launchers (`npm`, `gemini`) fail with
  `env: node: No such file or directory` under the GUI minimal PATH even when Node is
  installed. If Ollama is installed but its server isn't
  answering (and `AUTOWRIGHT_OLLAMA_URL` is local), `/ollama/status` starts `ollama serve`
  once per backend process and waits briefly for it to come up — so an installed Ollama
  reads as ready instead of prompting a fresh download. Before every OpenCode local-model
  use (readiness checks and invocations alike), the backend syncs the Ollama provider entry
  into `~/.config/opencode/opencode.json` (merge, never overwrite: provider `ollama` via npm
  `@ai-sdk/openai-compatible`, `baseURL` = `AUTOWRIGHT_OLLAMA_URL` + `/v1`, the agent's model
  listed under `models`) so `opencode run --model ollama/<model>` resolves.
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
  or discarded — clients re-`GET /state`), `draft.progress`, `test.issue`
  (`{ execId, blockers }` — the §8 issue-analysis blockers, after a user-requested
  `POST /tests/{execId}/analyze` finishes; §11 test executions otherwise stream over the
  ordinary `exec.*` events),
  `ollama.pull` (model-pull progress). Clients re-`GET /state` on
  reconnect.
