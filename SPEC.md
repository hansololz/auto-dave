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
scripts; Auto Dave runs those scripts on a schedule, entirely on the user's Mac, and shows results.

Core promises (exact UI copy, repeated in the onboarding footer):
- "Everything runs on this Mac"
- "Nothing runs until you review it"
- "Passwords stay in your Keychain"

## 2. Architecture

Four components (per top-level README):

- **Electron desktop app** — the UI. Recreates the design prototype pixel-faithfully (dark theme
  only). One window plus a menu-bar (tray) surface. Talks to the backend over a local API.
- **Python backend** — long-lived local service: owns the data store (automations, versions,
  executions, agents, settings), the scheduler (runs jobs even when the app window is closed),
  Keychain access for secrets, and orchestration of AI agents that draft/edit automation specs
  and step scripts.
- **Python engine** — executes an automation's steps as scripts, streams per-step status and logs,
  enforces the framework policies (§6), injects secrets at runtime, persists run results.
- **CLI** — command-line access to the same backend: list/run automations, tail executions, manage
  secrets and agents. Headless operation is a supported mode (§3), not just a debug aid.

**Stack (decided):** the Electron renderer is React 18 + TypeScript + Vite (state: one zustand
store mirroring the §4 model). The backend is Python 3.12 + FastAPI/uvicorn (PyYAML, keyring for
Keychain; request/response bodies are plain dicts — pydantic is not used directly). Transport is localhost HTTP (JSON) plus one WebSocket for live events —
the full API surface is §19. Packaging is decided — see §3. Storage is decided — see §5.

## 3. Packaging & process lifecycle (decided)

**The Python backend runs as a per-user launchd LaunchAgent, independent of the Electron app.**
Primary use case: a Mac left running unattended for days must keep executing schedules with no UI
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
  step script run on this one interpreter. The system/user Python is never used, never required,
  and never installed — users install nothing, and every Mac runs the identical interpreter
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
- Updates: on launch, the app compares its bundled backend version with the running service and,
  on mismatch, re-registers and restarts the service (never mid-execution — it waits for live
  runs to finish or marks them `interrupted`).
- Sleep: launchd does not prevent sleep. The backend holds a power assertion for the duration of
  an active execution, implemented as a `caffeinate -i` subprocess (prevents idle sleep mid-run;
  forced sleep — lid close, low battery — can still suspend a run); outside runs, normal macOS energy settings
  apply and missed occurrences follow the §6 missed-run policy. For the always-on use case, the
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
schedule: display string ("Daily at 8:00", "Mondays at 9:00")
scheduleShort: chip string ("Daily 8:00", "Mon 9:00")
hour: 0–23; min: 0–59 (default 0); dow: 0–6 (Sun=0), absent = daily
schedOff: bool — schedule disabled (Run now + menu bar still work)
instr: optional multiline free-text user instructions to the agent
lastStatus: succeeded | running | failed | cancelled | interrupted | none
live: run id while a run is in progress, else null
resultChip: short summary chip ("2 new chapters") | null — failed automations synthesize
  "Needs attention"
lastRunLabel: "just now" | "Xm ago" | "Xh ago" | "yesterday" | "Jun 28" | "running…"
latest: last run's result object + when-label, for the detail page
params: parameter list (§4.2)
memory: { size, updated } — per-automation memory directory between runs (any files/formats)
steps: [{ name, desc, code, agent?, agentId?, why? }] — code is human-readable script; agent marks
  a step that makes a query-only runtime model call (§6) — the script itself still does any changes
spec: block list [{ k: h1|h2|p|li, text }] — the human-readable spec
specMeta: "v3 · updated 2 days ago"
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
| `number` | label, help, value, min | value | digits-only; blur clamps empty/below-min to min |
| `text` | label, help, value, placeholder? | value or "Not set" | plain input |

URL validity: `/^https?:\/\/\S+\.\S+/`.

Every definition carries a default: `toggle` → off, `number` → its `min`, `text`/`list`/`kv` →
empty. Definitions are versioned with the automation; values live in the top-level
`automation.yaml` and are matched by name and kind at run/restore time (§5).

### 4.3 Schedule

Countdown "next in Xd Xh" / "Xh Xm": next occurrence of `hour:min` (weekly if `dow` set, else
daily); if the target already passed today/this week, roll forward one day/week. Refresh display
every 30 s.

Detail-page schedule status line:
- running → "`<schedule>` · running now" / "Running now… the schedule is unchanged." (spinner icon)
- schedOff → "`<schedule>` · schedule off" / "Off — won't run on its own. Run now and the menu bar
  still work." (pause icon)
- else → "`<schedule>` · next in `<countdown>`" / "Next run in `<countdown>` · runs even when the
  app is closed." (clock icon)

### 4.4 Versions and drafts

- Saving an edit creates version N+1 (on disk: a fresh `versions/vN+1/` folder, then the
  `current_version` pointer flip, per §5), applies spec/steps/instr/stepAgents/allowedSecrets/
  agentId, sets `specMeta` to "vN · updated just now". Prior versions are untouched.
- Leaving the editor with unsaved touched changes snapshots a **draft** onto the automation
  (toast: "Draft kept — resume or run it from this automation anytime.").
- Editor version menu lists: Draft ("your working copy — unsaved"), current vN ("current · …"),
  each older vN (date · note). Loading an old version shows a banner: "Loaded vX from history.
  Saving restores it as vN+1 — your draft stays in the Version menu." with a bordered
  **Back to draft** button; Save label becomes "Restore vX as vN+1".
- Detail page: old versions can **Run once** without changing the schedule (toast: "Running vX
  once — the schedule and Run now stay on vN."). The detail-page version menu carries a footer
  explainer: "Running an older version once doesn't change anything — the schedule and Run now
  always use the current version. To make an older version current, open Edit and restore it from
  the Version menu." Draft banner offers Run draft / Resume editing / Discard.

### 4.5 Execution (the stored record of one run)

```
id: uuid, autoId: uuid, ver ("v3" or "Draft"), status, trigger: Manual | Schedule | Menu bar
dur, started ("Just now, 8:00 AM"), startedMs
steps: [{ name, status, dur }]
logs: [{ t, k: sys|out|wrn|err, text }]
result: result object | null
redact: secret names redacted in logs (joined string) | null
note: optional note ("previous run still in progress", "Mac went to sleep") | null
```

Result object:
```
{ status: changes|ok|attention, chip, chips[],
  body: [{k:text|list|steps, …}] or para,
  rows: optional table rows (e.g. manga: MANGA / LATEST CHAPTER / UPDATED / NEW / READ, per-row
        isNew flag and link),
  columns: ordered column keys for the table — "new" is a pseudo-column the UI renders from the
        per-row isNew flag; href/isNew are row metadata, never columns themselves }
```

On disk the result is a directory: `result/result.yaml` plus optional artifact files beside it
(images, CSVs, …) that the run attaches; `result.yaml` references them by relative filename.
Artifacts are part of the execution record — deleted with it by retention, never required for
list rendering (loaded only when the execution is opened).

### 4.6 Statuses (single badge vocabulary, executions and steps)

queued (gray) · running (cyan) · succeeded (green) · failed (red) · cancelled (gray) ·
skipped (gray) · reused (gray) · interrupted (magenta) · none → "Not run yet" (gray).

### 4.7 Agent

```
{ id: uuid, name, desc, harness: Claude Code | Gemini CLI | Codex | OpenCode | Ollama,
  mode: default | ollama, model }
```
`desc` is an optional free-text description ("What this agent is for — shown on the Agents
page"), rendered as the detail line on the agent card.
Default models per harness: Claude Code → "Claude Sonnet 4.5", Gemini CLI → "Gemini 2.5 Pro",
Codex → "GPT-5 Codex", else "Configured default". Display shows "Default configured model" when
the model equals the harness default. One agent is the app default; deleting an agent reassigns
the default and warns which automations use it.

### 4.8 Secret

`{ name, value, usedBy }`. Names uppercase, `[A-Z][A-Z0-9_]*` — sanitization (uppercase, invalid
chars → `_`) is UI input behavior; the backend validates strictly and rejects nonconforming names
with HTTP 422. Values are arbitrary strings and may be multi-line (e.g. a PEM key). Values stored
in macOS Keychain, masked at rest; the API never returns secret values — show/hide applies to the
value being typed in the add/edit modal, not to stored values. Step scripts reference them by name
(`secrets.NAME`); values are injected at runtime and redacted from logs. Because log lines are
redacted one at a time, each non-blank line of a multi-line value is redacted individually as well,
and the §6 agent-prompt scan likewise checks every non-blank line of a multi-line value, not just
the whole string. Deleting a secret in use warns: the automation "uses it by name and will stop
working."

### 4.9 Settings

```
login: bool        — "Launch at login" ("Auto Dave starts quietly in the menu bar.")
mbIcon: bool       — "Show in the menu bar" ("The quickest way to run an automation.")
notif: attention | all — "Only when something needs attention" / "After every run"
days: int ≥ 1 (default 90) — history retention; keepForever: bool disables cleanup
devMode: bool (default false) — "Developer mode" ("Logs every backend request and every AI
  request — including the full prompt — to the backend log.") — gates request logging (§5)
dataPath (default ~/Library/Application Support/Auto Dave/executions), dataSize
```
Run-data section: Change then Reveal in Finder; Change opens the native macOS folder picker and the chosen
directory simply becomes the run-data location — no move/cancel UI and no data migration: all
execution state lives inside the executions dir, so changing the path just points Auto Dave at
the new location (the old dir stays where it was).
The "Keep runs for" days row is hidden (not just disabled) while "Keep run history forever" is
on. One **ON THIS MAC** card holds two rows: **"Automations & settings"** (the fixed path
`~/Library/Application Support/Auto Dave` with its own Reveal in Finder button — this location
is not changeable) above the **Run data** row. A **DEVELOPER** card sits last on the page with
the single **Developer mode** toggle row (devMode above).

## 5. Storage (decided)

**File-first for automations: YAML/markdown files are their only persistence. Execution records
are the one exception — they live in a SQLite database (`<dataPath>/executions/executions.db`);
their logs, results, and workspaces stay as files. All derived state lives in memory and is
rebuilt from disk at every startup.**

On-disk layout under `~/Library/Application Support/Auto Dave/`:

```
settings.yaml
agents.yaml
secrets.yaml                   # names + metadata only; values live in the macOS Keychain
backend.json                   # port+token discovery handshake (§3), rewritten each backend start
electron/                      # Electron's Chromium profile (Cache, Cookies, Local Storage, …) —
                               # main.cjs redirects userData here so the root stays app data only
automations/<slug>/
  automation.yaml              # unversioned, mutable — user/operational state: id, name,
                               # current_version (pointer: current = versions/v<N>/),
                               # schedule, agent_id, enabled_agents, allowed_secrets,
                               # param_values {name: value} (user data, never pruned),
                               # created_at, updated_at
  memory/                      # run-to-run memory directory (engine contract, §6) — scripts
                               # store whatever files and formats they need; shared across
                               # versions
  draft/                       # unsaved edit working copy, same shape as a version folder
  versions/vN/                 # one folder per version — immutable once written
    automation.yaml            # when, note, desc, param definitions (§4.2: name, kind,
                               # label, help, default, …) + ordered steps manifest:
                               # steps: [{file, name, desc, agent?, agent_id, why}]
    spec.md                    # the version's spec as plain markdown (h1/h2/li/p blocks)
    instructions.md            # user's free-text instructions to the agent (§4.1 instr),
                               # plain markdown; absent when none were given
    NN-name.py                 # step scripts as real files, beside the manifest —
                               # agent- and human-editable
```

**Logs live outside the data dir**, at `~/Library/Logs/Auto Dave/` (macOS convention;
Console.app picks them up): `app.log` (backend application log), `backend.out.log` /
`backend.err.log` (launchd stdout/stderr), and dev.sh's `vite.log`. With `AUTODAVE_HOME` set
(§15) logs go to `<home>/logs/` instead, keeping dev/test runs fully isolated.

**Request logging (behind the §4.9 `devMode` setting):** while Developer mode is on, the
backend logs to its console every HTTP request it serves (uvicorn access log at `info` level —
stdout, so `backend.out.log` under launchd) and every agent request — one `autodave.harness`
INFO line per `harness.invoke()` with the harness, the model (agent's, else the harness
default), and the full prompt (stderr, so `backend.err.log`). `./scripts/logs.sh` (§18)
follows both plus `app.log`/`vite.log`. Implemented as a logging filter that reads the live setting on
every record, so flipping the toggle applies immediately with no backend restart; while off,
only WARNING+ prints. The filter rides in on uvicorn's `log_config` handlers (uvicorn's own
dictConfig would wipe a filter attached to its loggers beforehand) and on the root handler for
`autodave.*` logs.

A version folder holds **what the agent wrote** (spec, instructions, steps + scripts, param
definitions, desc); the top-level `automation.yaml` holds **what the user owns and operates**
(identity, schedule, param values, agent choice, permission grants). Two consequences:

- **Permissions are never versioned.** `enabled_agents` and `allowed_secrets` are grants; they
  live only in the top-level file. Restoring or running an old version must never silently
  re-grant a revoked secret or agent — a vX step needing a now-disabled agent/secret fails with
  the existing warnings (§11).
- **Params split into definitions (versioned) and values (top-level).** At run/restore time
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
  executions.db                # SQLite (WAL) — the execution records, source of truth:
                               #   executions: id (uuid PK), automation_id, automation_name
                               #     (snapshot at execution time — display fallback only),
                               #     version ("v3"/"Draft"), status, trigger, started_at /
                               #     finished_at (epoch ms; finished_at NULL while running),
                               #     dur_ms, note, redacted_secrets (JSON), params (JSON)
                               #   execution_steps: execution_id, idx, name, status, dur_ms
                               #   indexes: (started_at DESC, id), (automation_id, started_at),
                               #     (status, started_at)
  <execution-uuid>/
    logs.ndjson                # append-only {ts, t, step, k: sys|out|wrn|err, text} —
                               # step = owning step name, null for run-level lines
    workspace/                 # cwd for every step of this execution — disposable per-run
                               # scratch space, shared across steps (step 1 writes a file,
                               # step 2 reads it); deleted with the execution by retention
    result/
      result.yaml              # status, chip, chips[], body blocks (text/list/steps),
                               # table rows + columns
      <artifacts>              # optional extra files the run attaches to its result
                               # (images, CSVs, …), referenced from result.yaml by
                               # relative filename
```

**Load model:** automations are **fully loaded at startup** — the backend walks `automations/`,
parses every top-level `automation.yaml` plus each `versions/vN/` folder (its `automation.yaml`
+ `spec.md` + `instructions.md` + step scripts), and serves all automation reads (lists,
detail, scheduler, menu bar) from memory. There is no automations table: the YAML files plus the
startup walk are the whole story. The id → path map, `has_draft`, and `next_run_at` are derived
in memory during/after the walk; execution-derived display state (`last_status`, `result_chip`,
`last_execution_at`, `live_execution_id`) is filled by one startup query for the latest execution
per `automation_id` and kept current as runs complete. `skipped` records never count as the
"latest" execution for this display state — they never ran, and §4.1's `lastStatus` vocabulary
excludes them (a mid-run schedule skip must not shadow the live run's final status/chip).

Executions load **headers-eagerly, bodies-lazily**: startup reads every record from
`executions.db` into an in-memory `executions` table — one record per execution with
`id, automation_id, status, trigger, version_label, started_at, finished_at, dur_ms`, plus the
light display fields (`automation_name`, `note`, redacted names, the step list) — kept queryable
by `trigger`, `status`, `automation_id`, and `started_at`; paths resolve on demand from the id.
`result/` and `logs.ndjson` are read only when an execution is opened. The in-memory table is
rebuilt from the DB at every launch. An automation folder whose `versions/` is
empty cannot resolve a current version and is skipped at startup with a warning in the app log.

Rules:

- Every write goes disk-first (atomic temp-write + rename for files; a committed transaction for
  `executions.db`), then the in-memory state updates. A crash between the two self-heals at the
  next startup, since startup rebuilds everything from disk. Nothing exists only in memory.
- Retention cleanup (§4.9 `days`) deletes execution directories and DB rows, then their
  in-memory records.
- Changing the data location (§4.9) closes the DB connection first, updates `dataPath`, then
  reloads everything from the new directory. Nothing is moved — execution state is wholly
  contained in the executions dir, so there is no migration step.
- Logs stream as append-only NDJSON — nothing else written on the execution hot path; CLI can
  tail/grep them directly.
- Secret values never appear in any file — Keychain only, referenced by name.

**Terminology:** an **execution** is the stored record of one run of an automation — the entity
name used in files, code, and APIs. **Run** is the verb/action, and stays in UI copy as the
design specifies ("Run now", "Running", "Run draft", "Run once").

**Directory naming:** automation directories use a human-readable slug of the name (not a UUID) —
browsability by users and agents is the point of file-first storage. The `id` inside
`automation.yaml` is the sole identity; code never parses slugs, the backend's in-memory map
(built at startup) resolves id → path. On
slug collision, append a short id suffix — the first UUID segment (`track-manga-chapters-2f9a01cc`). Renaming an automation
renames its directory (atomic, same volume) and updates the in-memory map. Execution
directories are flat under `executions/` and named by execution uuid only — no slug, so
renames never touch them; each execution record carries `automation_id` for the link back.

**Cross-references:** everything references an automation by `id` only — never by slug or name.
The execution page resolves `automation_id` through the backend's in-memory automations to the
current path and current name (so renames show up everywhere immediately). The execution record also snapshots
`automation_name` at execution time as a display-only fallback: when the automation has been
deleted, its executions still render with the historical name (marked deleted). The snapshot is
never used for lookups.

## 6. Engine contract & framework policies (shown as reference in Review)

- **Scheduling & triggers** — one run at a time (the API answers 409; the toast copy is client
  UI); a schedule firing mid-run is skipped, not queued; a failed scheduled run is retried once
  after 5 minutes — once per failure streak, keyed on the automation: a retry that also fails is
  not retried again until a scheduled success resets it. The retry resumes from the failed step
  (§7 rerun semantics: earlier steps `reused`, workspace copied), not from scratch.
- **Missed runs** — run when possible: if the scheduled time passes while the Mac is asleep (backend
  alive but suspended), the run fires on wake. If the backend itself wasn't running when the time
  passed, that occurrence is skipped entirely — no catch-up queue at startup; the next scheduled
  occurrence proceeds normally. At most one catch-up run fires per wake regardless of how many
  occurrences were slept through.
- **Reading web pages** — 10 s timeout; ≥ 2 s between requests to the same site; retry twice;
  respect robots.txt; user agent "AutoDave/1.0".
- **Workspace per run** — every step runs with its cwd set to the execution's `workspace/`
  directory; scripts are executed in place from their version folder (or `draft/`), never
  copied. All steps of an execution share the one workspace; it is disposable scratch space,
  not guaranteed to exist after the retention window.
- **Memory between runs** — one private `memory/` directory per automation, reachable from
  scripts via an injected path; scripts may store any files in any format there. Persists
  across runs and versions. Durable writes go to `memory/` (deliberate) or `result/`
  (attachments) — the workspace is for everything else.
- **Notifications & results** — exactly one result per run; at most one notification, at the end;
  notify only on changes (per the notifications setting). **Sender (decided):** the backend posts
  macOS notifications itself via `osascript -e 'display notification …'` — works headless with no
  UI process; the Electron app never posts.
- **Secrets & Keychain** — scripts reference secrets by name; values injected at runtime — each
  step receives only the secrets its own code references — and redacted from logs; a missing
  secret stops the run before any step.
- **Agent steps are query-only.** A step's runtime agent call is a pure question → text-answer
  function; only step scripts make changes. The engine invokes the harness one-shot and
  non-interactive with the strongest tool-disabling flags each harness supports: Claude Code
  `claude -p --tools "" --strict-mcp-config --no-session-persistence`, Codex
  `codex exec --sandbox read-only --skip-git-repo-check`, Ollama via its local HTTP API (no
  tools by nature); Gemini CLI and OpenCode expose no tool-disable flag for one-shot runs and are
  invoked bare (documented limitation). Secret values never enter a prompt: the engine
  redaction-scans the assembled prompt and fails the step (before sending) if any secret value
  appears. The reply is returned to the script as untrusted text/JSON — never executed or
  evaluated. Per-step timeout plus prompt- and output-size caps (200k chars each) apply; the full
  redacted prompt and response (up to those caps) are written to `logs.ndjson` for audit.
  Worst-case prompt injection from fetched content is therefore a wrong answer in a result, never
  an action.

### 6.1 The `autodave` step SDK (decided)

Each step runs in its own subprocess (the bundled interpreter, cwd = the execution `workspace/`).
The engine's runner injects these globals — scripts may also `import autodave` for the same names:

- `params` — dict-like, values by param name (definitions merged with §5 value-resolution rules).
- `secrets` — attribute access by name (`secrets.SMTP_PASSWORD`); reading a missing/un-allowed
  secret raises and fails the run (the missing-secret pre-check in §6 catches known references
  before step 1). Values never repr/print unredacted — the engine scans all log lines.
- `memory` — `pathlib.Path` of the automation's memory dir, plus `memory.load(name, default)` /
  `memory.save(name, obj)` YAML helpers.
- `log` — `log(text)` / `log.warn(text)` / `log.error(text)` → `out`/`wrn`/`err` NDJSON lines
  (`log.info` is an alias of `log`).
- `result` — builder used by the last step (any step may add): `result.chip(text)`,
  `result.chips([...])`, `result.text(p)`, `result.list(items)`, `result.steps(items)`,
  `result.table(rows, columns)`, `result.attach(path)`, `result.status('changes'|'ok'|'attention')`.
- `notify(text)` — requests the end-of-run notification (engine still applies the §4.9 setting
  and the one-notification rule). The notification title is the automation name, overridable by a
  param literally named `notification_title`.
- `agent.ask(prompt, data=None) -> str` — the §6 query-only runtime call, only in steps marked
  `agent: true`; runner invokes the step's harness one-shot, redaction-scans the prompt first.
  Convenience aliases `agent.read(data, prompt)` / `agent.write(data, prompt)` wrap it. Agent-step
  calls time out at 120 s (drafting calls use the §8 5-minute cap).
- `fetch_page(url) -> str` — HTTP GET honoring the §6 web policies (timeout, per-site spacing,
  retries, robots.txt, UA).

Runner↔engine protocol: stdout/stderr are captured line-by-line as `out`/`err`; structured calls
(log/result/notify) emit `@@AD@@{json}` control lines on stdout. Context (param values, secret
values, paths, agent config) arrives as JSON on stdin — never argv, never the environment.

### 6.2 Curated packages (decided)

Step scripts may import: Python stdlib, `autodave`, and: `requests`, `httpx`,
`beautifulsoup4` (`bs4`), `lxml`, `feedparser`, `python-dateutil` (`dateutil`), `PyYAML` (`yaml`).
The list ships with the app (installed in the bundled interpreter) and is included verbatim in the
§8 contract preamble; §8 validation rejects any other import. The runner re-validates the step's
top-level imports at execution time with the same rule (shared module `imports_check.py`) and
fails the step on violation — the allowlist holds even for hand-edited step files that never went
through drafting.

## 7. Execution lifecycle

- One execution at a time per automation. Starting while live: toast "Already running — one run
  at a time. A schedule firing now would be skipped."
- Start: execution record created with all steps queued; automation gets live id, lastStatus
  running, lastRunLabel "running…"; the execution appears at top of Executions; sidebar counts
  and menu-bar rows update live.
- Streaming: each step queued → running (sys log "▸ Step N — `<name>`", then step logs) →
  terminal status with duration. Then the execution gets its final status, duration, result
  object; automation gets latest/resultChip/lastRunLabel "just now"; toast summarizes.
- Cancel: kills timers/processes; execution cancelled, all running/queued steps cancelled, sys
  log "run cancelled by you — nothing else will happen".
- **Run again** has two variants on the execution page. Failed executions get a primary accent
  "Run again" (tooltip "Runs the automation again. Steps that already succeeded are reused
  automatically.") starting from the failed step: earlier steps get status `reused`, only the
  failed step onward re-executes; the rerun copies the source execution's workspace so reused
  steps' outputs remain available. Other terminal executions get a quiet bordered "Run again"
  (tooltip "Runs the automation again from the start") — a plain fresh run.
- Triggers: Manual, Schedule, Menu bar. `interrupted` covers e.g. "Mac went to sleep" — applied
  by startup recovery when a restarted backend finds stale `running` executions; a sleep the
  backend process survives simply resumes the run. `skipped`/`cancelled` executions may carry a
  note ("previous run still in progress").

**Execution page:** back link, title row with status badge + metadata chips (incl. run id) and
Cancel / Run-again actions. Body is a two-column layout: a **STEPS sidebar** (per-step status
dot, name, duration — compact, no inline log expansion) plus a parameters block ("Values as used
by this run."), and a main pane with **Results / Logs tabs** (auto-select Logs when no result).
The Logs tab is one unified color-coded log pane (kinds sys/out/wrn/err, live auto-scroll) with
a redaction note ("secrets redacted: `<name>`") and empty state "No logs — this run never
started." The Results tab renders the result body as paragraphs / bullets / numbered steps
(620 px measure — the Latest Result card on the detail page uses 640 px) plus optional data
table. Deleted-automation handling: historical name, marked deleted.

**Executions list:** all executions across automations; each row shows the automation name plus
an 8-char run-id chip (mono), status badge, a trigger column combining trigger and version
("Manual · v3"), timestamps, durations; filter All / Succeeded / Failed. Rows carry no note
text — skipped/cancelled notes appear on the detail page's RECENT RUNS rows and on the
execution page.

## 8. Agent drafting pipeline (decided)

Every draft, edit, or step-sync of an automation is a **two-call pipeline**: the backend first
asks the agent to write the **spec**, then — in a second, independent call — to build the
**steps, parameters, and schedule** from that spec. Both calls open with the same two
instruction files, invoke the chosen agent harness headless through a per-harness adapter
(`claude -p`, `gemini -p`, `codex exec`, `opencode run`, Ollama via its local HTTP API), and
parse one text response each. Everything below is harness-independent; adapters only translate
"send prompt, receive text." Agents never touch the data directory — the backend writes files
only after validation passes.

**Instruction files** (markdown next to the code, loaded at import — never inline in Python;
also served to the create/edit page via §19 `GET /instructions`):

- `backend/autodave/instructions/framework-instructions.md` — the contract preamble that opens
  **every** call: the agent's role, the generic file-block envelope (the per-call TASK directive
  names the exact files), the `autodave` SDK reference, the curated package list, the parameter
  kinds table (§4.2), schedule- and step-design duties, and all five §6 policy sections. The §11
  Framework-instructions card shows this file verbatim.
- `backend/autodave/instructions/default-build-instructions.md` — the default best-practice
  build instructions (never delete files, write only to memory/workspace, small single-purpose
  steps, fail loudly, quiet runs stay quiet, track seen items in memory). In `create` mode, when
  the user gave none, the backend seeds `instr` from this file; the validated create draft
  carries `instr` back so the Review card arrives pre-filled — the user edits or deletes the
  rules freely, and they version like any instructions.

**Modes:** `create` (both calls, from the user's description) · `edit` (both calls, applying a
change request — typed edits or the Review page's "ask the agent" box — to the current version
or draft) · `sync` (call 2 only: regenerate steps to match the provided spec; the spec itself
must not change).

**Call 1 — write the spec** (`create`/`edit`; skipped on `sync`). Prompt sections in order:

1. `framework-instructions.md` (verbatim).
2. **TASK directive** — `create`: draft `spec.md` for a brand-new automation from the USER
   REQUEST (markdown, `#` title first, plain words, no code/yaml/file names); `edit`: apply the
   USER REQUEST to the CURRENT `spec.md` and return the full updated file, keeping everything
   the request doesn't touch unchanged.
3. **Grants context** — enabled agent names and allowed secret **names** (never values, memory
   contents, or execution logs).
4. **Build instructions** — the user's standing rules (or the seeded default), context only;
   the agent never returns this file.
5. **Current version** (`edit` only) — `spec.md` plus today's step scripts as context.
6. **USER REQUEST** — the description (`create`) or the change request (`edit`).

Response: exactly one file block, `spec.md`. Validation: block present with no extras; must
start with an `# title`; must have body content. The parsed §5 blocks become the draft's spec.

**Call 2 — build the steps** (every mode; `sync` starts here with the provided spec — a `spec`
in the §19 body wins over the stored version's). Prompt sections in order:

1. `framework-instructions.md` (verbatim).
2. **TASK directive** — build the automation that implements the SPEC: derive the schedule,
   every parameter (each with a default), and the steps from the spec; return `manifest.yaml`
   plus one file block per step, no `spec.md`. Includes the manifest shape:

   ```
   ===FILE: manifest.yaml===
   name: Suggested automation name   # create only (ignored on edit/sync)
   desc: One-line description
   note: Version note for the history menu (§4.4)
   schedule: { hour: 8, min: 0 }     # add dow: 0–6 (Sun=0) for weekly; omitted → daily 8:00
   params:                           # full definitions per §4.2, each with a default
     - { name: sources, kind: list, label: Manga URLs, help: ..., validate: true }
   steps:                            # ordered; file names NN-name.py, two-digit, gapless
     - { file: 01-fetch.py, name: Fetch pages, desc: ... }
     - { file: 02-classify.py, name: Classify updates, desc: ..., agent: true,
         why: needs judgment on chapter titles }
   ===FILE: 01-fetch.py===
   ...python source...
   ===END===
   ```
3. **Grants context** — as in call 1.
4. **Build instructions** — as in call 1.
5. **Mode line** — `create`: include a suggested `name`; `edit`/`sync`: current param
   definitions and step scripts travel as reference ("rewrite them to match the SPEC, changing
   no more than the spec demands").
6. **SPEC** — call 1's validated `spec.md` (`create`/`edit`) or the provided spec (`sync`).

**Envelope + validation** (backend, deterministic, before anything is written to `draft/`):

1. The parser ignores any prose before the first `===FILE:` marker; block content is verbatim; a
   response without the terminal `===END===` marker is treated as truncated and invalid.
2. Call 2 must return `manifest.yaml` and every file listed in `steps` — a `spec.md` block in
   call 2 is a validation error (the spec is already settled).
3. `manifest.yaml` is schema-valid: kinds from §4.2 only, every param carries a default, steps
   nonempty, `steps[].file` ↔ file blocks match 1:1, filenames follow `NN-name.py` ordering.
4. Every step file passes `ast.parse`; imports ⊆ stdlib + curated packages + `autodave`.
5. Step code is scanned for `secrets.NAME` references → drives the Review-screen secret warnings
   (§11). Unknown or un-allowed secret references are Review warnings, not validation failures.
6. Steps carry only `agent: true` as the query-only marker (§6); the backend assigns `agent_id`
   from the automation's enabled agents. `why` is required when `agent` is true.
7. `schedule` is validated (hour 0–23, min 0–59, dow 0–6); the agent picks the time from the
   spec's words (no time given → one that fits the job; fallback daily 8:00). It is applied only
   when creating (v1's schedule, pre-filled on Review); on edit/sync the saved schedule is
   user-owned (§5) and never changed by a draft.

**Failure policy:** one automatic repair round **per call** — the same prompt plus the previous
raw response and the machine-generated validation errors. A second invalid response fails the
draft, surfaced in the Building state (spec call: "The spec didn't validate — try again or
rephrase."; steps call: "The steps didn't validate — …"). Per-call timeout 5 minutes; cancelling
the Building screen kills the harness process. The job's `stage` tracks the pipeline ("Writing
the spec" → "Generating the steps" — the §11 Building screen's two checklist rows; sync jobs
start at the second). Every invocation's full prompt and raw response are logged to the app log
(never to execution logs) for debugging.

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
animation animates `transform` and would knock the toast off-center while it runs); it uses
`left/right: 0` + auto margins + fit-content width.

Boot gate: until the renderer connects to the backend and loads the state snapshot, only the
plain window background renders. If boot is still pending after 300 ms, a centered logo +
spinner appears with "Connecting…" (or "Waiting for the Auto Dave backend…" once a connection
attempt has failed; boot retries every 1.2 s). Fast boots therefore show no splash flash.

### 9.1 Automations list

1200 px page, "Automations" title + New button. One card per automation: name, description,
status badge, schedule chip (plus an OFF tag when the schedule is off), result-summary chip, and
an **inline run button** per card (disabled while that automation is running, tooltip explains
why). The card carries no last-run label — `lastRunLabel` appears on the detail page and in the
menu bar. Empty state (dashed card):
"No automations yet. Describe a job in plain words — your AI writes it as scripts you can read,
and Auto Dave runs them on your schedule." with accent CTA "Create your first automation".

### 9.2 Automation detail

Back link ("‹ Automations"), title row: name, version chip dropdown (§4.4 Run once + footer
explainer), status badge, Run now (accent), Edit, ellipsis menu (Delete automation… in red).
Sections top to bottom:

- Optional **Draft banner** (§4.4), then **LATEST RESULT** card — status chip + metadata chips,
  result body (640 px measure), optional data table (mono uppercase headers). No-runs empty
  state (dashed card): "No runs yet / Press Run now — the first result will appear right here."
- **WAYS TO RUN** card — schedule row (schedule chip + §4.3 status line) with an on/off toggle
  switch (drives `schedOff`), and a second row: bordered mono Run-now button, copy "Manual runs
  are always available — even when the schedule is off.", plus a disabled dashed chip "Message
  triggers (Discord, iMessage) — coming soon".
- **PARAMETERS** — directly editable here per the §4.2 edit behaviors; caption "Changes apply on
  the next run — no new version, no AI involved."
- **RECENT RUNS** — run history rows (status, trigger·version, time, duration, note text when
  present), linking to execution pages.
- **MEMORY** card — mono size/updated info line, "Reveal in Finder" and "Clear memory" buttons;
  Clear swaps to an inline confirm: "Next run starts fresh, like the first time." with red
  Clear / quiet Keep.
- **SPEC panel** — the automation's spec blocks, footer: "The AI regenerates the steps from this
  document when you edit it. Every change mints a new version — older ones live in the Version
  menu on the edit page."

**Delete confirm modal** — "Delete this automation?" / "`<name>` will be deleted — the schedule
stops, and its versions and memory go with it. Past results stay in Executions." When a run is
live an amber line is added: "A run is in progress — deleting cancels it." (confirming cancels
the run, then deletes). Buttons Cancel / red "Delete automation".

## 10. Onboarding (3 steps, step label top-right in mono)

Onboarding shows whenever `ad-onboarded` (§15) is unset — existing agents or automations do NOT
bypass it: step 1 always renders. When prior data exists (any agent or any automation), step 1's
Continue goes straight to the app shell instead of step 2.

**Step 1 — Welcome.** Logo, headline "Recurring jobs, done exactly the same way every time.",
then a live self-check card "Getting Auto Dave ready" running three steps (Checking settings,
Preparing folders, Loading data) with pulsing dots and durations, ending in a "READY / All set"
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
  prompt (amber pulsing dot, "Auto Dave never sees your password") → possibly denied ("Install
  paused — permission was declined", retry) → waiting for browser sign-in (reopen / cancel) →
  connected.
- **Use a free local AI** — Ollama + Qwen3 8B, "Download and install · 5.2 GB": install Ollama →
  download model (two-step progress, continues in background), same sudo/denied handling, ends
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
background" as promised. The denied branch UI is specified by the prototype but is not currently
reachable: the install machines are simulated and always grant sudo (there is no dev knob to
force denial); it becomes a real state when the installs become real.

## 11. Create / edit flow

Entry: New button, onboarding step 3, or Edit on a detail page. If no agents exist (outside
onboarding), redirect to Agents with toast "No agent yet — add one here first. Creating and
editing automations needs an AI."

**Ask.** 620 px column, "What should Auto Dave do for you?", 4-row textarea, then an
"OR START FROM AN EXAMPLE" eyebrow over icon-led example chips (fa icon + label; accent-tinted
border/background on hover, 1 px press-down on :active): Track manga chapters (fa-book-open) /
Back up a folder every night (fa-box-archive) / Email me a weekly report (fa-envelope) / Watch a
product's price (fa-tag) / Tidy my screenshots folder (fa-broom). "Written by `<agent>`" dropdown
(footer: "Auto Dave still runs everything"), CTA "Draft the automation". Empty text blocks with
"Describe the job first — one sentence is enough."

**Building.** Spinner + staged checklist ("Writing the spec" → "Generating the steps") driven by
the §8 job's `stage`, agent label; then Review. On failure the backend's error is the headline
(spec vs. steps message per §8) with validation details beneath, plus Back / Try again.

**Review.** 1400 px max-width page. Title row: name (single line, shrinks with ellipsis so a long name never pushes the
buttons out of the window), version dropdown (edit mode), agent picker, Start over ghost
(edit: "Discard draft"), primary Create/Save. Lede: "Read what your AI wrote. Change anything —
nothing runs until you create it." When a run is live during an edit, a cyan pulsing banner
shows: "A run is happening right now on vN. Saving won't interrupt it — that run finishes on vN.
vN+1 takes over from the next run (`<schedule>`)." Sections (left column: spec, agents,
secrets, instructions, framework; right column: steps, schedule, parameters, dry-run):
- **Spec** — editable as markdown-ish text (`#`, `##`, `-`, plain ↔ h1/h2/li/p blocks). Also an
  "ask the agent" box that appends a "Change (draft)" section. Spec/instructions/agent-ask edits
  are mutually exclusive (one edit at a time).
- **BUILD INSTRUCTIONS** — collapsible card holding the §4.1 `instr` free text, with view/edit
  states; edit placeholder "One rule per line — 'Prefer Python.' 'Never delete files — move them
  to the Trash.'", empty state "No instructions yet — press Edit to add standing rules." In
  create mode the card arrives pre-filled with the app's default best-practice rules (§8) —
  edit or delete them freely before saving.
- **Dirty gating** — any spec/instruction/agent-ask/agent-enablement/secret-allowance change
  marks the workflow out of sync and **blocks saving** until the sync banner's "Sync now" button
  runs one §8 `sync` call regenerating the steps ("Steps synced with the spec — review them,
  then save."). Disabled Save shows an amber hint ("Sync and review the steps before saving." /
  "Finish editing the spec first…" / "Syncing steps…"). Picking a different agent for a single
  step does **not** dirty the workflow — it only marks the draft touched (toast "Step N now
  calls `<agent>` · `<model>`."); disabling an enabled agent that steps still call does dirty it
  (toast "Steps X, Y are out of sync — `<agent>` is no longer available here. Sync the steps
  before saving.").
- **SCHEDULE** card — schedule chip + "Runs even when the app is closed."
- **PARAMETERS · YOUR AI ASKED FOR THESE** card — in create mode the definitions are editable
  inline (per-line URL rows with "NOT A VALID LINK" chips, toggle rows, "+ Add line"); in edit
  mode (when the automation has params) the card is read-only with a "READ-ONLY HERE" tag,
  one-line value summaries, and footer "Values aren't part of a version — change them on the
  automation page; they apply on the next run." (create-mode footer: "After creation these move
  to the automation page — changes there apply on the next run, no new version."). Empty state:
  "No settings needed — your AI didn't ask for any."
- **Steps** — readable scripts with per-step agent menus (menu empty state: "No agents enabled —
  turn one on under 'Agents · available to steps'."). Agent steps without any enabled agent
  show a red warning ("Step N needs an agent, but none is enabled — the run would fail there.
  Enable one below."). Per-automation agent enablement list with "X of Y enabled"; enabled
  agents called by steps show a "called by step N" note.
- **Secrets** — step code is scanned for `secrets.NAME`; secrets in Keychain but not allowed, and
  secrets missing from Keychain, each produce warnings with fix affordances. "X of Y allowed".
- **Framework instructions** — read-only card showing `framework-instructions.md` **verbatim**
  (mono, pre-wrap, max-height 420 px with inner scroll): the §8 contract preamble exactly as it
  is sent to the agent, nothing parsed or reformatted. Content comes from §19
  `GET /instructions` (fetched once per app session and cached); the same response carries
  `default-build-instructions.md` as the fallback pre-fill for the Build instructions card.
  Collapsed hint and footer copy: built-in instructions the AI reads before writing anything,
  word for word — they update with the app, nothing for the user to maintain.
- **Dry-run test** — streams check lines and ends in a done state. **Semantics (decided):** a
  dry run executes no step code and writes no execution record. The backend streams one check
  line per item over the §19 WebSocket: param values validate against definitions (URL counts
  per §4.2), each referenced secret exists and is allowed, each agent step has an enabled agent,
  memory dir status (size or "empty"), notification plan from the current setting, plus an HTTP
  `HEAD` reachability probe (5 s timeout, probes run concurrently) for each valid URL in
  `validate: true` list params. `number` params are checked numeric and ≥ min; `kv` reports entry
  count. Secret/agent checks use the in-editor (unsaved) grants — the renderer sends
  `enabledAgents`/`allowedSecrets` overrides (§19). Dry-run is available in both create and edit
  mode: edit mode uses `POST /automations/{id}/dryrun`; create mode (no saved id yet) uses
  `POST /dryrun` with the full draft, and the memory line reports "empty — new automation". Any
  failing line renders amber/red but never blocks saving — dry-run is advisory.

Create (new) → version 1, `lastStatus: none`, navigate to detail, toast "Created — nothing has
run yet. Press Run now when you're ready." Save (edit) → §4.4.

## 12. Agents & Secrets pages

**Agents.** List of agent cards with badge states Checking (cyan, staggered on page visit) /
Connecting / Ready (green) / Needs setup (amber). Each card shows the agent's `desc` detail line
and a **USED BY** row of clickable automation chips (fallback "Not used by any automation yet.").
Ready agents get inline "Check connection" (toasts "`<name>` answered in 0.4 s — ready."), an
inline "Edit" button, and, when not default, an inline borderless "Make default" text button;
Needs-setup rows use an accent-primary "Edit" button instead. The row overflow menu holds only
"Remove agent…" (red, confirm modal). Default status is indicated by the absent "Make default"
button — no chip. Empty state (dashed card): "No agents yet. Existing automations still run on
schedule — but you need an agent to create or edit them." + CTA "Add your first agent".

**New / Edit agent** form (720 px, one form — title and submit label switch to "Edit agent" /
"Save changes" when editing): pick harness (Claude Code / Gemini CLI / Codex / OpenCode /
Ollama), mode (default model vs. local Ollama model), model (required for Ollama mode), name
(required), optional description ("What this agent is for — shown on the Agents page"). The
submit button renders disabled-styled until valid but stays clickable: submitting with a missing
name shows an inline red error "A name is required — give this agent a name before saving." (red
input border, clears on typing); missing Ollama toasts "Install Ollama first."; otherwise "Pick
a harness and a model first." Success toasts: "`<name>` added — ready to write automations." /
"Changes saved — `<name>` is ready." When editing a signed-out agent, the form shows a reconnect
banner: "This agent is signed out — reconnect it to create or edit automations." + Reconnect
button. Ollama-dependent options gated on Ollama being installed and ready — this includes
the OpenCode harness ("OpenCode runs its models through Ollama, which isn't installed on this Mac
yet."). Inline install flow: button "Install Ollama · 1.1 GB", installing label "Installing
Ollama… X.X GB of 1.1 GB". **LOCAL MODEL** picker: radio list of installed Ollama models with
size metadata, empty state "No local models installed yet — download one below and it will show
up here." Model pulls: one at a time — the backend streams raw `ollama pull` output over the
`ollama.pull` WS event and the UI parses the percent out of it (right column shows "N%";
determinate bar when a percent is present, indeterminate otherwise — see §20); suggested-model
chips fill the pull input (they don't start the pull); suggested models qwen3:14b (9.3 GB, "Good
local default"), llama3.3:70b (43 GB, "Most capable local — needs 48 GB of memory"), gemma3:12b
(8.1 GB, "Light and quick"). Below the pull input: link "Browse more models on Hugging Face ↗".

**Secrets.** List with add/edit modal, masked values, delete confirm (§4.8). The name field is a
single-line input (Enter saves, Escape closes); its placeholder is a hint, not a literal example
value: "A short name, like MAIL_PASSWORD or CRM_API_KEY". The value field is a 3-row vertically
resizable textarea (multi-line values allowed, §4.8) masked with `-webkit-text-security` unless
Show is toggled; Enter inserts a newline, Cmd/Ctrl+Enter saves, Escape closes. Toasts: "Saved to your Keychain." / "Updated in your
Keychain." / "Removed from your Keychain." When no secrets exist, the table is replaced by an
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
pulsing while running, name, mono sub-line colored by state: cyan "Running now…" / red when failed
/ accent for a result chip / faint otherwise, bordered run button at 35 % opacity that goes fully
opaque on hover (accent hover border), relative time right-aligned in a 56 px column). Row click opens the app on that automation; run
button triggers a "Menu bar" run. Footer: accent "Open Auto Dave" link + version. Click-outside
closes.

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
- Button hover states are CSS `:hover` classes in `tokens.css` (`.ad-btn-primary`, `.ad-btn-ghost`,
  `.ad-btn-soft`, `.ad-btn-text`[`.dim`], `.ad-btn-pill`, `.ad-btn-dashed`, `.ad-btn-x`,
  `.ad-chip-btn`, `.ad-menu-row`), never JS mouse-enter/leave state — a JS hover flag sticks when
  a re-render or layout shift moves the element under the cursor.
- Icons: Font Awesome 6.5.2. App mark: accent rounded square with a hammer glyph (`fa-solid fa-hammer`).
  The same mark is the macOS dock icon (`app/electron/appIcon.png`, 1024 px, mark at ~80% of canvas,
  generated by `scripts/gen_app_icon.cjs`; set at startup via `app.dock.setIcon` in
  `app/electron/main.cjs` so dev runs don't show the default Electron icon).
- Motion: fade-up entrances (.3–.5 s), spinners .8–.9 s, amber "waiting on you" pulse 1.2 s.
  Modals (shared `Modal` shell in `ui.tsx`: backdrop + card, used by the secret add/edit modal
  and `ConfirmModal`) animate both ways — enter .18 s fade-up, exit .12 s fade-down — and every
  dismissal path (backdrop click, Escape, Cancel, save/confirm) plays the exit before unmount;
  confirm actions fire after the exit finishes.
- Layout: page gutter 30–32 px, max width 1200 px (Review page 1400 px, forms 620–720 px,
  settings 640 px).
- Scroll chrome (`tokens.css`): 10 px WebKit scrollbars, white 10 % thumb (18 % hover),
  transparent track and corner; textarea resize grip (`::-webkit-resizer`) is an inline-SVG
  grip icon — two rounded diagonal strokes, white 28 % — so it stays crisp and never flips to
  WebKit's light default square when a scrollbar appears.

## 15. Dev/test knobs

**Dev/release parity rule:** dev and release run the SAME code paths — there are no mock modes,
no alternate backends, no dev-only branches in app code. The only knobs that exist are pure
configuration (they relocate or re-tune the same behavior, never select different behavior).
Every knob defaults to the release value and is developer opt-in; the single knob dev.sh sets
itself is `AUTODAVE_RENDERER_URL` (below — same renderer source, served with HMR instead of
pre-bundled). Dev runs use the real app-support dir, real Keychain, real agent CLIs, random
port, request logging via the §4.9 devMode setting (§5), and the real launchd service (§18
dev.sh).

Frontend state (localStorage/URL — production mechanisms, not dev branches): `ad-onboarded`
(persisted onboarding completion; clearing it re-runs onboarding), `#menubar` URL hash (selects
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
`tests/bin` to `PATH`, so the real detect/invoke/subprocess path runs against it) and conftest
fixtures that monkeypatch `keychain` (in-memory dict) and `notify.post` (no-op). Removed knobs —
do not reintroduce: `AUTODAVE_MOCK_AGENT`, `AUTODAVE_KEYRING`, `AUTODAVE_NO_NOTIFY`,
`ad-sudo-denied`, `?port=&token=` (the renderer dev server returned as `AUTODAVE_RENDERER_URL`,
above — `VITE_DEV`/`npm run dev:app` themselves stay gone).

## 16. Seed / demo data (tests only)

The shipped app has NO seed path: a fresh install always starts empty (onboarding), and there is
no CLI or API to populate demo data. The seed fixture lives in `tests/seed_data.py` and is
applied only by tests calling `seed(store)` (it refuses to run when any automations exist).

The prototype ships four demo automations useful for tests: "Track manga
chapters" (daily 8:00, list/toggle/number/text/kv params, result table with a READ column),
"Nightly folder backup" (daily 2:00), "Weekly report email" (Mondays 9:00, failed, uses
`SMTP_PASSWORD`, retry-from-step), "Clean screenshots folder" (Sundays 21:00). Demo secrets:
`SMTP_PASSWORD`, `VAULT_DRIVE_KEY`. Twelve seed executions cover every terminal status including
skipped, reused, cancelled ("previous run still in progress") and interrupted ("Mac went to
sleep"); `running` is inherently live and is not seeded.

## 17. Repository structure

- `design/` — high-fidelity HTML prototype + design handoff README (authoritative tokens).
- `backend/` — Python package `autodave`: storage, engine (+`runner.py` step SDK,
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
  run from `app/` as `./node_modules/.bin/electron ../scripts/gen_app_icon.cjs`;
  `commit` stages all uncommitted changes, generates a commit message via
  `claude --model claude-opus-4-8 -p` from the staged diff, and commits).
- `tests/` — pytest suite for the backend (storage, drafting, engine, schedule, API), plus the
  test doubles: `tests/bin/claude` (fake agent CLI) and `tests/seed_data.py` (§16 fixture).

## 18. Commands

Dev workflow:

- **`./scripts/build.sh`** — build only, no launch: creates the venv and `node_modules` if
  missing, re-installs deps when `backend/pyproject.toml` (stamp file `.venv/.backend-stamp`)
  or `app/package.json` changed, then typechecks + builds the renderer (`npm run build` →
  `app/dist`, the bundle Electron loads in release). Touches no processes and no data dir;
  safe to run anytime. **`--deps`** stops after the dependency step (no renderer bundle) —
  what dev.sh runs.
- **`./scripts/prod.sh`** — the production distribution (§3), under `build/` (gitignored).
  Runs `build.sh` (full), then: downloads the pinned relocatable CPython
  (python-build-standalone `20250612` / CPython `3.12.11`, arch from `uname -m`, tarball
  cached in `build/cache/`, URL overridable via `AUTODAVE_PBS_URL`), pip-installs the backend
  + curated packages into it (inside the bundle the backend/CLI run as
  `python3 -m autodave.main` / `-m autodave.cli` — pip's `bin/` entry scripts carry absolute
  staging-path shebangs), renders `appIcon.icns` from `app/electron/appIcon.png`
  (sips + iconutil), packages `Auto Dave.app` with `@electron/packager` (bundle id
  `com.autodave.app`; ships only `electron/`, `dist/`, and `package.json` — the renderer is
  fully bundled and main/preload use Electron builtins only, so no `node_modules`), copies
  the interpreter to `Contents/Resources/python/`, codesigns (Developer ID + hardened runtime
  on every Mach-O when `CODESIGN_IDENTITY` is set — notarization itself not run; ad-hoc
  otherwise, local use only), smoke-checks that the bundled interpreter imports `autodave` +
  every curated package from inside the bundle, and produces
  `build/Auto Dave-<version>-<arch>.dmg` (hdiutil UDZO).
- **`./scripts/dev.sh`** — fastest dev loop, with hot reloading: runs `build.sh --deps` only
  (no renderer bundle); shuts down lingering processes from previous runs — backend by
  command-line pattern (`[Pp]ython -m autodave` — ps shows the venv python's resolved binary,
  never the `.venv/bin/python` path; SIGTERM, 5 s grace, then SIGKILL — backends can hang in
  graceful shutdown while uvicorn waits on open WebSockets), stale Electron, and stale Vite;
  then (re)installs the real launchd LaunchAgent (`autodave service uninstall` +
  `service install`, `com.autodave.backend`, §3) so the backend runs exactly as in release:
  launchd-managed, RunAtLoad/KeepAlive, cwd `/`, minimal launchd PATH, random free port,
  macOS Keychain, devMode-gated request logging (§5) to `backend.out.log`/`backend.err.log`
  under the logs
  dir (§5), data in `~/Library/Application Support/Auto Dave` (starts empty on a fresh
  machine); starts a Vite dev server on a random free port (`npx vite --strictPort`, log
  `vite.log` under the logs dir, killed on script exit); waits for a fresh `backend.json`
  (rewritten with new pid/token
  each start) plus `/health` and for Vite to answer, then launches Electron in the foreground
  with `AUTODAVE_RENDERER_URL=http://127.0.0.1:<vite port>` (§15) — renderer edits under
  `app/src` hot-reload live; backend edits need a dev.sh rerun. Quitting Electron normally
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
- Backend: `python3.12 -m venv .venv && .venv/bin/pip install -e "backend[dev]"`; run tests with
  `.venv/bin/python -m pytest tests/`; dev.sh launches the backend via `python -m autodave.main`
  (equivalent to the `autodave-backend` entry point); run an isolated backend (real agent CLIs,
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
  delegated to a subagent via the Agent tool, always run with `model: opus` (Opus 4.8). Never adds
  `Claude` as co-author. Does not push.

## 19. Backend API (decided)

Localhost JSON over HTTP + one WebSocket, both authenticated with the bearer token from
`backend.json` (§3). Entity JSON uses the §4 field names verbatim (`autos`-shaped automations,
`execs`-shaped executions) so UI state mirrors the model. UI and CLI use only this API (§3 parity).

- `GET /health` → `{ version, app }` (unauthenticated; used for discovery/liveness)
- `GET /state` → boot snapshot: automations (full), execution headers, agents, secret names +
  usedBy, settings, app version
- `GET /instructions` → `{ framework, defaultBuild }` — the two §8 instruction files verbatim
  (backs the §11 Framework-instructions and Build-instructions cards)
- `GET /automations` · `GET /automations/{id}` · `DELETE /automations/{id}`
- `PATCH /automations/{id}` — user-owned fields only: name, schedule (hour/min/dow/schedOff),
  param values, agentId, stepAgents, allowedSecrets
- `POST /automations/{id}/run` `{ version?: "vN" | "draft" (case-insensitive), trigger? }` →
  `{ execId }` (409 while live)
- `POST /automations` `{ draft }` — create v1 from a validated draft
- `POST /automations/{id}/versions` `{ draft }` — save edit as vN+1
- `PUT /automations/{id}/draft` · `DELETE /automations/{id}/draft` — the §4.4 draft snapshot
- `POST /automations/{id}/restore` `{ v }` — copy vX to vN+1 (§5)
- `POST /automations/{id}/memory/clear` — empty the §4.1 memory directory (backs §9.2 "Clear
  memory")
- `POST /automations/{id}/dryrun` `{ draft?, enabledAgents?, allowedSecrets? }` —
  streams §11 check lines as WS events; when the grant arrays are present (even empty) they
  replace the saved grants for the checks
- `POST /dryrun` `{ draft, enabledAgents?, allowedSecrets? }` — create-mode dry run against an
  unsaved draft (no automation id); same check lines and WS events, memory line reports empty
- `POST /drafts` `{ mode: create|edit|sync, autoId?, text?, spec? }` → `{ jobId }`; progress via
  WS; `GET /drafts/{jobId}` → state + validated §8 draft payload; `DELETE /drafts/{jobId}` cancels
  (kills the harness process)
- `GET /executions?auto=&status=` (headers) · `GET /executions/{id}` (steps + logs + result) ·
  `POST /executions/{id}/cancel` · `POST /executions/{id}/rerun` (§7 retry from failed step —
  earlier steps `reused`)
- `GET/POST /agents` · `PATCH/DELETE /agents/{id}` · `POST /agents/{id}/check` (health/badge) —
  one shared readiness check (`harness.check_ready`) decides ready vs. needs-setup everywhere:
  the harness binary must resolve (rule below), Ollama's server must answer, and Claude Code
  must additionally be signed in (`claude auth status` exits 0 only when authenticated) ·
  `GET /agents/detect` (§10 detection) · Ollama: `GET /ollama/status` → `{ ready, installed,
  models }`, `POST /ollama/pull`. All CLI lookups (detection and harness invocation alike)
  resolve the binary via PATH plus the usual macOS install locations (`~/.local/bin`,
  `/opt/homebrew/bin`, `/usr/local/bin`; Ollama additionally `Ollama.app`), because a
  GUI-launched backend gets a minimal PATH — e.g. `claude` installs to `~/.local/bin` by
  default. Invocation runs the resolved absolute path. If Ollama is installed but its server isn't
  answering (and `AUTODAVE_OLLAMA_URL` is local), `/ollama/status` starts `ollama serve`
  once per backend process and waits briefly for it to come up — so an installed Ollama
  reads as found/ready instead of prompting a fresh download.
- `GET /secrets` (names + usedBy only) · `PUT /secrets/{name}` `{ value }` · `DELETE
  /secrets/{name}` — values go straight to the Keychain, never into responses or files
- `GET /settings` · `PATCH /settings` · `POST /settings/data-path` `{ path }` (sets the
  run-data location; creates the dir, reloads from it, moves nothing)
- `WS /ws?token=` — events, each `{ ev, ... }`: `exec.started`, `exec.step` (status change),
  `exec.log` (one NDJSON line), `exec.finished`, `auto.changed`, `agents.changed`,
  `secrets.changed`, `settings.changed`, `draft.progress`, `dryrun.line`, `dryrun.done`,
  `ollama.pull` (model-pull progress). Clients re-`GET /state` on reconnect.

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
- **Seed executions.** The prototype seeds 11 executions including a permanently-`running` one
  and covers `skipped`/`reused` only as step statuses. §16 seeds twelve, covers every terminal
  execution status, and never seeds `running` (it is inherently live).
- **Framework-knowledge panel copy follows §6/§6.1.** The prototype panel says memory is "one
  JSON file" and shows `secret("smtp-password")`; the real panel must describe the memory
  directory and `secrets.NAME` references.
- **Seed step scripts use the real SDK.** Prototype scripts call `memory.last_seen`,
  `agent.do(...)`, `result.summary(...)` — none exist in §6.1; real seeds use
  `memory.load/save`, `agent.ask/read/write`, and the §6.1 result builder.
- **Deleted-automation executions keep the historical name.** The prototype falls back to "—";
  §5 snapshots `automation_name` so old runs render the real name, marked deleted.
- **Run-page parameters are the values used by that run.** The prototype renders the
  automation's current live params; the execution record snapshots the resolved values
  ("Values as used by this run.").
- **Ollama pull bar has an indeterminate fallback.** The prototype always has a percent because
  it simulates the pull; real `ollama pull` output may not yield one.
- **`lastRunLabel` is always derived.** The prototype's seeds mostly omit it and the menu bar
  patches in hardcoded times; the real field is computed per §4.1 for every automation.
