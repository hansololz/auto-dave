// One central model drives everything (§4 top-level, §9 navigation).
import { create } from 'zustand'
import { api, connectInfo, openWs } from './api'
import type { Agent, Auto, Blocker, Exec, ExecResult, LogLine, SecretMeta, Settings, StateSnapshot } from './types'

export type Surface = 'onboard' | 'app' | 'create' | 'menubar'
export type Page =
  | 'automations' | 'automation' | 'executions' | 'execution'
  | 'agents' | 'agentNew' | 'secrets' | 'settings'

export type CreateFrom = 'app' | 'onboard' | 'edit' | null

// §12 agent status badge — cached for the app session so the Agents page
// doesn't re-check on every visit.
export type AgentCheck = 'checking' | 'connecting' | 'ready' | 'needs'

interface NavSnap {
  surface: Surface; page: Page; autoId: string | null; execId: string | null
  // §4.4/§11: without this, browser-back into the editor would restore
  // surface 'create' with createFrom null — the wrong editor mode.
  createFrom: CreateFrom
}

export interface Model {
  connected: boolean | null
  version: string
  autos: Auto[]
  execs: Exec[]
  agents: Agent[]
  secrets: SecretMeta[]
  settings: Settings | null
  // §4.4 pending create-mode slot — drives the §9.1 Resume draft button
  pendingDraft: { name: string; updatedAt: string | null } | null

  surface: Surface
  page: Page
  autoId: string | null
  execId: string | null
  createFrom: CreateFrom

  toast: string | null
  execFull: Record<string, Exec>
  // §19 lazy logs, per execution: logKey(step, attempt) → fetched lines,
  // extended live by matching exec.log events (deduped by seq)
  execLogs: Record<string, Record<string, LogLine[]>>
  // §11 test — live state fed by the §19 test.* WS events. `analyzing` is
  // the window between a failed test and its §8 issue-analysis result; `issue`
  // holds the analysis blockers until CreateFlow consumes them into its panel.
  test: {
    testId: string
    steps: { name: string; status: string }[]
    lines: { t?: string; k: string; text: string }[]
    status: 'executing' | 'succeeded' | 'failed' | 'cancelled'
    result: ExecResult | null
    analyzing: boolean
    issue: Blocker[] | null
  } | null
  ollamaPull: { model: string; line: string; done: boolean; ok?: boolean } | null
  // §19 harness.install stream, latest event per provider id
  harnessInstall: Record<string, { line?: string; pct?: number; done: boolean; ok?: boolean; error?: string }>
  // §12 session cache of agent status checks, keyed by agent id
  agentChecks: Record<string, AgentCheck>

  boot(): Promise<void>
  runAgentCheck(id: string, pending?: AgentCheck): Promise<'ready' | 'needs'>
  disconnect(): void
  refresh(): Promise<void>
  applyEvent(msg: Record<string, unknown>): void
  go(page: Page, ids?: { autoId?: string | null; execId?: string | null }): void
  setSurface(s: Surface, from?: CreateFrom): void
  showToast(msg: string, ms?: number): void
  loadExec(execId: string): Promise<void>
  loadExecLogs(execId: string, step?: number, attempt?: number): Promise<void>
  loadAuto(autoId: string): Promise<void>
  beginTest(testId: string): void
  clearTest(): void
  consumeTestIssue(): void
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
let bootTimer: ReturnType<typeof setTimeout> | undefined
let closeWs: (() => void) | null = null
let passedOnboard = false
let restoring = false

// '/app?auto=<uuid>' — the §13 menu-bar row deep link.
function autoIdFromHash(hash: string): string | null {
  const m = hash.match(/auto=([0-9a-f-]{36})/)
  return m ? m[1] : null
}

export const useStore = create<Model>((set, get) => ({
  connected: null,
  version: '',
  autos: [],
  execs: [],
  agents: [],
  secrets: [],
  settings: null,
  pendingDraft: null,
  surface: 'app',
  page: 'automations',
  autoId: null,
  execId: null,
  createFrom: null,
  toast: null,
  execFull: {},
  execLogs: {},
  test: null,
  ollamaPull: null,
  harnessInstall: {},
  agentChecks: {},

  // §12: the one place a status check runs — badge goes to `pending` while the
  // real §19 /agents/{id}/check call is in flight, result lands in the cache.
  async runAgentCheck(id, pending = 'checking') {
    set({ agentChecks: { ...get().agentChecks, [id]: pending } })
    let st: 'ready' | 'needs'
    try {
      const r = await api.checkAgent(id)
      st = r.status === 'ready' ? 'ready' : 'needs'
    } catch { st = 'needs' }
    set({ agentChecks: { ...get().agentChecks, [id]: st } })
    return st
  },

  async boot() {
    // One retry chain only: a re-entrant boot (StrictMode re-mount) must not
    // leave a second timer chain hammering discovery in parallel.
    clearTimeout(bootTimer)
    const ok = await connectInfo()
    if (!ok) { set({ connected: false }); bootTimer = setTimeout(() => get().boot(), 1200); return }
    try {
      const s: StateSnapshot = await api.state()
      // Existing autos do NOT bypass onboarding: step 1 always shows; with
      // prior data its Continue goes straight to the app (§10).
      const onboarded = localStorage.getItem('ad-onboarded') === '1'
      const hash = location.hash
      const deepAuto = onboarded ? autoIdFromHash(hash) : null
      set({
        connected: true, version: s.version, autos: s.autos, execs: s.execs,
        agents: s.agents, secrets: s.secrets, settings: s.settings,
        pendingDraft: s.pendingDraft,
        surface: hash.includes('menubar') ? 'menubar' : onboarded ? 'app' : 'onboard',
        ...(deepAuto ? { page: 'automation' as const, autoId: deepAuto } : {}),
      })
      if (onboarded) passedOnboard = true
      // Exactly one live socket: a re-entrant boot (StrictMode re-mount,
      // backend restart) must not stack subscriptions — every stacked socket
      // applies each event once more (duplicate log lines, double toasts).
      closeWs?.()
      closeWs = openWs((msg) => get().applyEvent(msg))
      updateTrayAlert(s.autos)
    } catch {
      set({ connected: false })
      bootTimer = setTimeout(() => get().boot(), 1200)
    }
  },

  disconnect() {
    clearTimeout(bootTimer)
    closeWs?.()
    closeWs = null
  },

  async refresh() {
    try {
      const s = await api.state()
      set({ autos: s.autos, execs: s.execs, agents: s.agents, secrets: s.secrets, settings: s.settings, pendingDraft: s.pendingDraft })
      updateTrayAlert(s.autos)
    } catch { /* backend restarting; ws reconnect will re-trigger */ }
  },

  applyEvent(msg) {
    const ev = msg.ev as string
    const m = get()
    if (ev === 'ws.open') { void m.refresh(); return }
    if (ev === 'exec.started' || ev === 'exec.finished') {
      const ej = msg.exec_json as Exec | undefined
      if (ej) {
        const rest = m.execs.filter((e) => e.id !== ej.id)
        set({ execs: [ej, ...rest].sort((a, b) => b.startedMs - a.startedMs) })
        const full = m.execFull[ej.id]
        // ej is a header (no steps/result) — merging keeps the full record's body
        if (full) set({ execFull: { ...m.execFull, [ej.id]: { ...full, ...ej } } })
        if (ev === 'exec.started' && full) void m.loadExec(ej.id) // §7 retry re-publish: re-fetch steps/attempts
        if (ev === 'exec.finished') {
          void m.refresh()
          // Refresh the body only when someone has opened this execution —
          // unviewed executions would otherwise accumulate a full record each.
          if (full) void m.loadExec(ej.id)
          // §7: the finished execution gets a summary toast (prototype pattern:
          // "<name> finished — <chip>."). Cancelled executions are user-initiated — no toast.
          if (ej.status === 'succeeded' || ej.status === 'failed') {
            const aj = msg.auto_json as Auto | null | undefined
            const name = aj?.name ?? m.autos.find((a) => a.id === ej.autoId)?.name ?? 'Automation'
            m.showToast(ej.status === 'failed'
              ? `${name} failed — needs attention.`
              : aj?.resultChip ? `${name} finished — ${aj.resultChip}.` : `${name} finished.`)
          }
        } else {
          void m.refresh()
        }
      }
      return
    }
    if (ev === 'exec.step') {
      // Steps live only on the full record (§19: list headers carry none).
      const execId = msg.execId as string
      const idx = msg.index as number
      const step = msg.step as NonNullable<Exec['steps']>[number]
      const full = m.execFull[execId]
      if (full?.steps) {
        set({
          execFull: {
            ...m.execFull,
            [execId]: { ...full, steps: full.steps.map((s, i) => (i === idx ? step : s)) },
          },
        })
      }
      return
    }
    if (ev === 'exec.log') {
      const execId = msg.execId as string
      const key = logKey(msg.stepIndex as number | null, msg.attempt as number | null)
      const buckets = m.execLogs[execId]
      const bucket = buckets?.[key]
      if (bucket) {
        const line = msg.line as LogLine
        // seq dedupe: a line already covered by a fetched snapshot is dropped
        const last = bucket.length ? bucket[bucket.length - 1].seq : 0
        if (line.seq > last) {
          set({ execLogs: { ...m.execLogs, [execId]: { ...buckets, [key]: [...bucket, line] } } })
        }
      }
      return
    }
    // §19 test.* — ignore events for a test we aren't showing (stale/cancelled)
    if (ev === 'test.step' || ev === 'test.log' || ev === 'test.done' || ev === 'test.issue') {
      const t = m.test
      if (!t || t.testId !== msg.testId) return
      if (ev === 'test.step') {
        const i = msg.i as number
        const step = { name: msg.name as string, status: msg.status as string }
        const steps = [...t.steps]
        steps[i] = step
        set({ test: { ...t, steps } })
      } else if (ev === 'test.log') {
        const line = msg.line as { t?: string; k: string; text: string }
        set({ test: { ...t, lines: [...t.lines, line] } })
      } else if (ev === 'test.done') {
        const status = msg.status as 'succeeded' | 'failed' | 'cancelled'
        set({
          test: {
            ...t, status, result: (msg.result as ExecResult | undefined) ?? null,
            analyzing: status === 'failed', // §11: the issue-analysis call follows a failure
          },
        })
      } else {
        set({ test: { ...t, analyzing: false, issue: (msg.blockers as Blocker[]) ?? [] } })
      }
      return
    }
    if (ev === 'harness.install') {
      const id = msg.id as string
      set({
        harnessInstall: {
          ...get().harnessInstall,
          [id]: {
            line: msg.line as string | undefined, pct: msg.pct as number | undefined,
            done: !!msg.done, ok: msg.ok as boolean | undefined, error: msg.error as string | undefined,
          },
        },
      })
      return
    }
    if (ev === 'ollama.pull') {
      set({
        ollamaPull: {
          model: msg.model as string, line: msg.line as string,
          done: !!msg.done, ok: msg.ok as boolean | undefined,
        },
      })
      return
    }
    if (ev === 'auto.changed' || ev === 'agents.changed' || ev === 'secrets.changed' || ev === 'settings.changed' || ev === 'draft.changed') {
      void m.refresh()
    }
  },

  go(page, ids = {}) {
    // Page nav always lands in the app shell — leaving the create/edit
    // surface here is what lets sidebar tabs escape the editor (§9).
    const leavingCreate = get().surface === 'create'
    set({
      page,
      autoId: ids.autoId !== undefined ? ids.autoId : get().autoId,
      execId: ids.execId !== undefined ? ids.execId : get().execId,
      ...(leavingCreate ? { surface: 'app' as const, createFrom: null } : {}),
    })
    syncHistory(get())
  },

  setSurface(surface, from = null) {
    if (surface !== 'onboard') passedOnboard = true
    if (surface === 'app' && get().surface === 'onboard') localStorage.setItem('ad-onboarded', '1')
    set({ surface, createFrom: from })
    syncHistory(get())
  },

  showToast(msg, ms = 2800) {
    set({ toast: msg })
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { if (get().toast === msg) set({ toast: null }) }, ms)
  },

  async loadExec(execId) {
    try {
      const e = await api.getExec(execId)
      set({ execFull: { ...get().execFull, [execId]: e } })
    } catch { /* deleted */ }
  },

  async loadExecLogs(execId, step, attempt) {
    try {
      const { lines } = await api.getExecLogs(execId, step, attempt)
      const all = get().execLogs
      const buckets = all[execId] ?? {}
      const key = logKey(step ?? null, attempt ?? null)
      const bucket = buckets[key]
      // keep WS lines that streamed in past the fetched snapshot
      const seq = lines.length ? lines[lines.length - 1].seq : 0
      const tail = bucket ? bucket.filter((l) => l.seq > seq) : []
      set({ execLogs: { ...all, [execId]: { ...buckets, [key]: [...lines, ...tail] } } })
    } catch { /* deleted */ }
  },

  async loadAuto(autoId) {
    try {
      const a = await api.getAuto(autoId)
      const autos = get().autos
      set({
        autos: autos.some((x) => x.id === autoId)
          ? autos.map((x) => (x.id === autoId ? a : x))
          : [...autos, a],
      })
    } catch { /* deleted */ }
  },

  beginTest(testId) {
    set({ test: { testId, steps: [], lines: [], status: 'executing', result: null, analyzing: false, issue: null } })
  },

  clearTest() { set({ test: null }) },

  consumeTestIssue() {
    const t = get().test
    if (t) set({ test: { ...t, issue: null } })
  },
}))

// §19 log buckets: step+attempt select an attempt file, null/null the execution log.
export function logKey(step: number | null, attempt: number | null) {
  return step === null ? 'x.0' : `${step}.${attempt ?? 1}`
}

function updateTrayAlert(autos: Auto[]) {
  void window.autowright?.trayAlert(autos.some((a) => a.lastStatus === 'failed'))
}

// ---------- history (§9: back works, never re-enters onboarding) ----------
let lastNav: NavSnap | null = null

function navSame(a: NavSnap | null, b: NavSnap | null) {
  return !!a && !!b && a.surface === b.surface && a.page === b.page
    && a.autoId === b.autoId && a.execId === b.execId && a.createFrom === b.createFrom
}

function syncHistory(m: Model) {
  if (restoring) return
  const s: NavSnap = {
    surface: m.surface, page: m.page, autoId: m.autoId, execId: m.execId,
    createFrom: m.createFrom,
  }
  if (navSame(s, lastNav)) return
  lastNav = s
  try { history.pushState({ adNav: s }, '') } catch { /* file:// quirks */ }
}

window.addEventListener('popstate', (e) => {
  const s = (e.state && (e.state as { adNav?: NavSnap }).adNav) || null
  if (!s) return
  if (s.surface === 'onboard' && passedOnboard) {
    try { history.pushState({ adNav: lastNav }, '') } catch { /* ignore */ }
    return
  }
  restoring = true
  useStore.setState({
    surface: s.surface, page: s.page, autoId: s.autoId, execId: s.execId,
    createFrom: s.createFrom ?? null,
  })
  lastNav = s
  restoring = false
})

// §13: main pushes the menu-bar row's target here when the window already
// exists (a reload would drop the WS); fresh windows carry it in the hash.
window.autowright?.onOpenTarget?.((hash) => {
  const m = useStore.getState()
  if (m.surface === 'onboard' || m.surface === 'menubar') return
  const autoId = autoIdFromHash(hash)
  if (autoId) m.go('automation', { autoId })
})
