# Project: worker-forge

## Rules

- For any feature change, capture it in `SPEC.md`. `SPEC.md` is the source of truth and must hold enough detail to
  rebuild the entire app from scratch. Update `SPEC.md` **before** starting the code change; amending it again after
  the code change starts is fine.
- Always communicate using the `/cavemen` skill with `lite` settings. Keep it active for every response in the session,
  and in particular whenever updating the `SPEC.md` or `.claude/CLAUDE.md` doc.
- The app is unreleased: do not worry about backward compatibility. When changing a feature, just make the code
  change — no legacy-code handlers, migration shims, or deprecated fallbacks.
- Developer mode and production mode must behave the same: no mocked data in developer mode, and no separate
  dev-only code paths. Both modes execute the same real code.
- Never execute anything under `scripts/`. All project scripts are strictly for the developer to
  run by hand in a terminal (`scripts/uninstall/` additionally removes the harness CLIs and
  Ollama). Agents may read and edit them when asked, but must never run them. To verify changes,
  launch the app pieces directly per the `verify` skill (backend module, `npm run build`,
  playwright-driven Electron).