---
name: verify
description: Build, launch, and drive Auto Dave (Electron + Python backend) to verify changes at the real UI.
---

# Verifying Auto Dave changes

## Handles

- `scripts/dev.sh` — fast dev loop with HMR: deps only, installs the real launchd service
  (`com.autodave.backend`, random port, real Keychain, data in
  `~/Library/Application Support/Auto Dave`), starts a Vite dev server, launches Electron
  foreground with `AUTODAVE_RENDERER_URL` pointing at it. Quitting Electron leaves the backend
  running; stop with `.venv/bin/autodave service uninstall`. Ctrl+C on dev.sh shuts everything
  down (Electron, Vite, and the backend). Setting any `AUTODAVE_*` env
  switches it to a direct-spawned isolated backend; `--fresh` needs `AUTODAVE_HOME`. NEVER
  point verification sessions at the real data dir — always isolate with `AUTODAVE_HOME`.
- For scripted verification, start pieces yourself (all backgroundable):
  1. Backend: `AUTODAVE_HOME=<dir> AUTODAVE_PORT=<port> .venv/bin/python -m autodave.main`
     - Backend always starts EMPTY (fresh onboarding). There is no seed command — demo data is a
       test fixture only (`tests/seed_data.py`); create data through the UI or API.
     - Agent calls shell out to the real CLIs (`claude`, etc.). For deterministic agent replies
       without a real AI, prepend the test fake to PATH: `PATH="$PWD/tests/bin:$PATH"` (same
       fake the pytest suite uses — real detect/invoke code path).
     - Secrets use the real macOS Keychain (service "Auto Dave") in every mode.
     - `backend.json` (port/token/pid) appears in `AUTODAVE_HOME`.
  2. Renderer: `cd app && npm run build` — release delivery; Electron loads `app/dist` unless
     `AUTODAVE_RENDERER_URL` points it at a Vite dev server.
  3. Drive Electron with playwright-core (`_electron.launch` with `cwd: app/`, env
     `AUTODAVE_HOME=<dir>`) — electron main reads `backend.json` from `AUTODAVE_HOME`.
     playwright-core resolves from `app/node_modules` — require it by absolute path if the
     driver lives outside `app/`.

## Gotchas

- **Onboarding only shows when the backend has zero automations AND `ad-onboarded` is absent
  from localStorage** (`store.ts` boot). Non-empty home → straight to app. Use an empty home on
  a second port.
- The onboarding install machines are REAL (§10/§19): clicking a "Set up …" suggestion card
  actually installs that CLI into `~/.local/bin` on this Mac, and sign-in help really opens
  Terminal/browser. Don't click them in automated runs unless that side effect is intended;
  found-card "Check connection" is safe (read-only readiness check).
- Flows drive fine headless-less on macOS; screenshot via `page.screenshot`.

## Worth driving

- Onboarding: step 1 self-check → step 2 detect/connect/install machines → Continue → step 3
  (Create flow) → Back (state must survive).
- Create flow with `PATH="$PWD/tests/bin:$PATH"` (fake claude envelope, no real AI needed).
