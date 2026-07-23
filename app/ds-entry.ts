// Design-sync bundle entry (claude.ai/design import). Re-exports the shared
// UI primitives only — never the app shell (main.tsx mounts the app on import).
// Outside tsconfig "include" on purpose; consumed by .ds-sync/package-build.mjs.
export * from './src/ui'
export { Markdown, SpecMarkdown } from './src/result'
