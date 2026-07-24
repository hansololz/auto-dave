# Autowright

> Describe the job once. Your Mac does it every day, exactly the same way, forever.

Autowright is a macOS desktop app for recurring personal automations. You describe a job in
plain words — *"Check the manga I follow for new chapters every morning at 8"* — a connected AI
agent (Claude Code, Gemini CLI, Codex, OpenCode, or a local Ollama model) writes it as
human-readable Python step scripts, and Autowright runs those scripts on a schedule, entirely on
your Mac.

## The problem

Everyone has a handful of small recurring chores a computer should be doing: checking a site for
updates, pulling a report, renaming and filing downloads, pinging an API and summarizing what
changed. Today your options are all bad in a different way:

- **Do it by hand** — reliable, but you are the cron daemon now.
- **Write a script + cron/launchd** — works, but you write it, debug it, schedule it, and babysit
  it yourself. Most chores never clear that bar.
- **Ask a chatbot every time** — the AI *can* do the task, but it re-improvises it on every run.
  Different steps, different output, different failures. And it usually runs in someone else's
  cloud.
- **Cloud automation platforms** — subscriptions, per-run pricing, connector lock-in, and your
  credentials living on somebody else's servers.

Autowright takes a different trade: **use AI once, at authoring time**. The agent writes the
automation; the automation is plain, inspectable Python; the scheduler executes those exact
scripts on every run. You get the ease of "just describe it" with the determinism of a script —
no re-prompting, no drift, no cloud.

## How it works

1. **Describe** — say what you want in plain words, plus when it should run.
2. **Draft** — your connected agent turns that into a spec and a set of small, readable Python
   step scripts against the `autowright` step SDK.
3. **Review** — you read exactly what will run. **Nothing executes until you approve it.**
4. **Run** — the local scheduler fires it on time, even with the app closed. Every execution
   streams per-step status and logs, and every result is kept.

Want a change later? Ask for the edit in plain words — the agent revises the scripts, you review
the diff, and the new version takes over. Old versions stay in history.

## Three promises

These are the product's core guarantees, verbatim from the app:

- **"Your automations execute only on this Mac"** — the scheduler, the engine, and your data are
  a local service on your machine. No Autowright cloud exists.
- **"Nothing executes until you review it"** — AI drafts; you approve. Scripts are
  human-readable on purpose.
- **"Passwords never leave your Keychain"** — secrets live in the macOS Keychain and are
  injected into steps at runtime, never stored in scripts or sent to the drafting agent.

## Features

- **Plain-words authoring and editing** — describe the job; describe the change. The AI does the
  scripting, you do the deciding.
- **Bring your own agent** — Claude Code, Gemini CLI, Codex, or OpenCode; OpenCode can drive a
  local Ollama model for fully offline drafting.
- **Real scheduling** — cron expressions (with per-trigger IANA timezones and DST handled), one-shot
  "run once at…" triggers, run-on-app-start, and manual "Execute now" from the app, menu bar, or CLI.
- **Runs with the app closed** — the backend is a launchd service. Quit the window; triggers keep
  firing. Missed-run policy covers sleep and downtime.
- **Versioned automations** — every approved edit is a new version with the old ones kept;
  drafts run in isolation before you promote them.
- **Persistent memory with snapshots** — automations can keep state between runs ("chapters I've
  already seen"), with automatic snapshots before risky moments and one-click restore.
- **Live execution view** — per-step status, streamed logs, and a full execution history for
  every automation.
- **Menu-bar surface** — glance at what's running and what's next, and fire jobs without opening
  the window.
- **Full CLI** — everything the UI does over the same local API: list and execute automations,
  tail executions, manage secrets, agents, and the service. Headless Macs are a supported mode,
  not an afterthought.
- **File-first storage** — your automations are YAML and Python files on disk. Read them, diff
  them, back them up. Export/import as portable `.autowright` archives.
- **No new runtime to install** — the app bundles its own Python; users install nothing.

## What it's not

- Not a cloud platform — there is no server component outside your Mac, which also means no
  cross-device sync.
- Not a chatbot — the AI writes and revises automations; it is not in the loop when they run.
- Not an enterprise workflow engine — it is built for personal, recurring jobs on one Mac.

## Components

- **Python backend** (`backend/`) — long-lived local service (launchd LaunchAgent): file-first
  YAML storage, scheduler, execution engine, Keychain secrets, AI-agent drafting, localhost
  HTTP + WebSocket API.
- **Python engine** (`backend/autowright/engine.py` + `executor.py`) — executes an automation's steps as
  subprocesses with the `autowright` script SDK; streams status and logs.
- **CLI** (`autowright`) — headless client of the same API: list/execute automations, tail executions,
  manage secrets, agents, and the launchd service.
- **Electron app** (`app/`) — the UI (React + Vite + TypeScript), plus the menu-bar panel.

`SPEC.md` is the source of truth for the whole app — detailed enough to rebuild it from scratch.

## Status

Unreleased and under active development, macOS only. There is no packaged download yet — build
from source below.

## Quick start (dev)

```bash
./scripts/dev.sh            # fast launch with hot reloading (Vite HMR + real backend service)
./scripts/dev.sh --fresh    # wipe the (isolated) data dir first — fresh onboarding
./scripts/prod.sh           # production distribution: signed Autowright.app + DMG under build/
```

Manual pieces, if you need them separately:

```bash
# backend + tests
python3.14 -m venv .venv && .venv/bin/pip install -e "backend[dev]"
.venv/bin/python -m pytest tests/

# isolated backend (real agent CLIs, real Keychain; starts empty)
AUTOWRIGHT_HOME=/tmp/ad-home AUTOWRIGHT_PORT=8799 .venv/bin/autowright-backend

# build the renderer bundle, then the Electron shell (loads app/dist)
cd app && npm install && npm run build && npm run app
```

See `SPEC.md` §18 for the full dev workflow and §15 for every dev/test knob.
Dev uses the release code paths — there is no mock mode and no seed data; the
app always starts the way a released install would. The only dev convenience is
delivery: dev.sh serves the same renderer source through Vite for hot reloading.
