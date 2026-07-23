# UI conventions (for page implementers)

Implement pages to SPEC.md — §9–§13 describe each screen, §14 is the authoritative token sheet.
Pages style with inline JSX `style={{…}}` objects using the exact spec values. Dark theme only.
All tokens exist as CSS vars (see `src/tokens.css`): use `var(--accent)`, `var(--bg-card)`,
`var(--text-2)`, `var(--mono)` etc. instead of raw hex where a token exists; keep exact
oklch/rgba values where no token fits.

## Data + state

- `useStore()` from `src/store.ts` — the central model:
  - data: `autos: Auto[]`, `execs: Exec[]`, `agents: Agent[]`, `secrets: SecretMeta[]`,
    `settings: Settings | null`, `version`
  - nav: `surface`, `page`, `autoId`, `execId`, `createFrom`; navigate with
    `go(page, {autoId?, execId?})` and `setSurface(surface, from?)`
  - `showToast(msg, ms?)`; `toast` is rendered by App — never render your own toast container.
  - `execFull: Record<execId, Exec>` — full execution (logs/result) cache; call
    `loadExec(id)` to (re)fetch; live `exec.log` / `exec.step` WS events are merged in
    automatically while the record is in `execFull`.
  - `loadAuto(id)` refetches one automation into `autos`.
  - `test: {testId, steps, lines, status, result, analyzing, issue} | null` +
    `beginTest(testId)` / `clearTest()` — §11 test stream (WS `test.*`).
- `api` from `src/api.ts` — typed §19 client (`api.executeNow`, `api.patchAuto`, `api.putSecret`, …).
  All mutations trigger WS `*.changed` events which refresh the store — after calling a mutation
  you usually only `showToast(...)`.
- Types in `src/types.ts` (`Auto`, `Exec`, `Step`, `ParamDef`, `SpecBlock`, `ExecResult`, …).

## Shared primitives (`src/ui.tsx`) — use these, don't reinvent

`P` (palette), `Badge status=…` (§4.6 vocabulary), `Chip`, `resultChipColors(result)`,
`Eyebrow`, `Spinner`, `Toggle`, `RadioRing`, `BtnPrimary`, `BtnGhost`,
`usePopover()` → `[open, setOpen, ref]` (closes on outside mousedown; wrap trigger+menu in
`<div ref={ref} style={{position:'relative'}}>`), `menuStyle`, `MenuRow`,
`paramSummary(p)`, `validUrl(s)`, `nextIn(auto)` (countdown; re-render every 30 s with a
`useEffect` interval), `ResultBody result=…` (paragraphs/bullets/steps + data table),
`ConfirmModal`, `PageTitle`, `CountPill`. App renders `Toast` globally.

## Behaviors that must match the spec

- Pages animate in with `animation: 'adFadeUp .4s ease'`, max-width 1200 (forms 620–720,
  settings 640), padding `26px 30px 70px` (detail pages `20px 30px 70px`).
- Icons: Font Awesome classes (`fa-solid fa-…`), already loaded.
- Status colors/labels only via `Badge`/`badgeOf`. Mono for timestamps/chips/eyebrows/metadata.
- Toast copy, warning copy, empty-state copy: use the exact strings from SPEC.md.
- Popovers close on outside mousedown (usePopover). Danger rows red.
- Never block on `window.confirm` — use `ConfirmModal`.
- `void`-call async api methods from event handlers; wrap in try/catch and
  `showToast(err.message)` on failure where the spec defines a message.

## Working style

Write ONLY your assigned file(s) under `app/src/pages/`. Default-export the page component.
After writing, check with `cd app && npx tsc --noEmit` and fix errors in YOUR files (ignore errors in
other pages — someone else owns them). Do not edit store.ts/ui.tsx/api.ts/App.tsx; if you're
blocked by a missing store field, work around it locally inside your component.
