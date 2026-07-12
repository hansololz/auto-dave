# Auto Dave

Recurring jobs, done exactly the same way every time. A macOS desktop app: describe a job in
plain words, a connected AI agent (Claude Code, Gemini CLI, Codex, OpenCode, or local Ollama)
writes it as human-readable Python step scripts, and Auto Dave runs them on a schedule — entirely
on your Mac.

`SPEC.md` is the source of truth for the whole app. `design/` holds the interactive design
prototype the UI recreates.

## Components

- **Python backend** (`backend/`) — long-lived local service (launchd LaunchAgent): file-first
  YAML storage, scheduler, execution engine, Keychain secrets, AI-agent drafting, localhost
  HTTP + WebSocket API.
- **Python engine** (`backend/autodave/engine.py` + `runner.py`) — runs an automation's steps as
  subprocesses with the `autodave` script SDK; streams status and logs.
- **CLI** (`autodave`) — headless client of the same API: list/run automations, tail executions,
  manage secrets, agents, and the launchd service.
- **Electron app** (`app/`) — the UI (React + Vite + TypeScript), plus the menu-bar panel.

## Quick start (dev)

```bash
./scripts/dev.sh            # fast launch with hot reloading (Vite HMR + real backend service)
./scripts/dev.sh --fresh    # wipe the (isolated) data dir first — fresh onboarding
./scripts/prod.sh           # production distribution: signed Auto Dave.app + DMG under build/
```

Manual pieces, if you need them separately:

```bash
# backend + tests
python3.12 -m venv .venv && .venv/bin/pip install -e "backend[dev]"
.venv/bin/python -m pytest tests/

# isolated backend (real agent CLIs, real Keychain; starts empty)
AUTODAVE_HOME=/tmp/ad-home AUTODAVE_PORT=8799 .venv/bin/autodave-backend

# build the renderer bundle, then the Electron shell (loads app/dist)
cd app && npm install && npm run build && npm run app
```

See `SPEC.md` §18 for the full dev workflow and §15 for every dev/test knob.
Dev runs the release code paths — there is no mock mode and no seed data; the
app always starts the way a released install would. The only dev convenience is
delivery: dev.sh serves the same renderer source through Vite for hot reloading.
