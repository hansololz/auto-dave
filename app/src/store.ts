// One central model drives everything (§4 top-level, §9 navigation).
import { create } from 'zustand'
import { api, connectInfo, openWs } from './api'
import type { Agent, Auto, Exec, SecretMeta, Settings, StateSnapshot } from './types'

export type Surface = 'onboard' | 'app' | 'create' | 'menubar'
export type Page =
  | 'automations' | 'automation' | 'executions' | 'execution'
  | 'agents' | 'agentNew' | 'secrets' | 'settings'

interface NavSnap { surface: Surface; page: Page; autoId: string | null; execId: string | null }

export interface Model {
  connected: boolean | null
  version: string
  autos: Auto[]
  execs: Exec[]
  agents: Agent[]
  secrets: SecretMeta[]
  settings: Settings | null

  surface: Surface
  page: Page
  autoId: string | null
  execId: string | null
  createFrom: 'app' | 'onboard' | 'edit' | null

  toast: string | null
  execFull: Record<string, Exec>
  dryrun: { lines: { kind: string; text: string }[]; done: boolean } | null
  ollamaPull: { model: string; line: string; done: boolean; ok?: boolean } | null

  boot(): Promise<void>
  refresh(): Promise<void>
  applyEvent(msg: Record<string, unknown>): void
  go(page: Page, ids?: { autoId?: string | null; execId?: string | null }): void
  setSurface(s: Surface, from?: 'app' | 'onboard' | 'edit' | null): void
  showToast(msg: string, ms?: number): void
  loadExec(execId: string): Promise<void>
  loadAuto(autoId: string): Promise<void>
  clearDryrun(): void
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
let passedOnboard = false
let restoring = false

export const useStore = create<Model>((set, get) => ({
  connected: null,
  version: '',
  autos: [],
  execs: [],
  agents: [],
  secrets: [],
  settings: null,
  surface: 'app',
  page: 'automations',
  autoId: null,
  execId: null,
  createFrom: null,
  toast: null,
  execFull: {},
  dryrun: null,
  ollamaPull: null,

  async boot() {
    const ok = await connectInfo()
    if (!ok) { set({ connected: false }); setTimeout(() => get().boot(), 1200); return }
    try {
      const s: StateSnapshot = await api.state()
      // Existing autos do NOT bypass onboarding: step 1 always shows; with
      // prior data its Continue goes straight to the app (§10).
      const onboarded = localStorage.getItem('ad-onboarded') === '1'
      const hash = location.hash
      set({
        connected: true, version: s.version, autos: s.autos, execs: s.execs,
        agents: s.agents, secrets: s.secrets, settings: s.settings,
        surface: hash.includes('menubar') ? 'menubar' : onboarded ? 'app' : 'onboard',
      })
      if (onboarded) passedOnboard = true
      openWs((msg) => get().applyEvent(msg))
      updateTrayAlert(s.autos)
    } catch {
      set({ connected: false })
      setTimeout(() => get().boot(), 1200)
    }
  },

  async refresh() {
    try {
      const s = await api.state()
      set({ autos: s.autos, execs: s.execs, agents: s.agents, secrets: s.secrets, settings: s.settings })
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
        if (full) set({ execFull: { ...m.execFull, [ej.id]: { ...full, ...ej, logs: full.logs, result: full.result } } })
        if (ev === 'exec.finished') {
          void m.refresh()
          void m.loadExec(ej.id)
          // §7: the finished run gets a summary toast (prototype pattern:
          // "<name> finished — <chip>."). Cancelled runs are user-initiated — no toast.
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
      const execId = msg.execId as string
      const idx = msg.index as number
      const step = msg.step as Exec['steps'][number]
      const patchSteps = (e: Exec) => ({ ...e, steps: e.steps.map((s, i) => (i === idx ? step : s)) })
      set({
        execs: m.execs.map((e) => (e.id === execId ? patchSteps(e) : e)),
        execFull: m.execFull[execId]
          ? { ...m.execFull, [execId]: patchSteps(m.execFull[execId]) }
          : m.execFull,
      })
      return
    }
    if (ev === 'exec.log') {
      const execId = msg.execId as string
      const full = m.execFull[execId]
      if (full) {
        const line = msg.line as NonNullable<Exec['logs']>[number]
        set({ execFull: { ...m.execFull, [execId]: { ...full, logs: [...(full.logs ?? []), line] } } })
      }
      return
    }
    if (ev === 'dryrun.line') {
      const cur = m.dryrun ?? { lines: [], done: false }
      set({ dryrun: { lines: [...cur.lines, { kind: msg.kind as string, text: msg.text as string }], done: false } })
      return
    }
    if (ev === 'dryrun.done') {
      const cur = m.dryrun ?? { lines: [], done: false }
      set({ dryrun: { ...cur, done: true } })
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
    if (ev === 'auto.changed' || ev === 'agents.changed' || ev === 'secrets.changed' || ev === 'settings.changed') {
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

  clearDryrun() { set({ dryrun: null }) },
}))

function updateTrayAlert(autos: Auto[]) {
  void window.autodave?.trayAlert(autos.some((a) => a.lastStatus === 'failed'))
}

// ---------- history (§9: back works, never re-enters onboarding) ----------
let lastNav: NavSnap | null = null

function navSame(a: NavSnap | null, b: NavSnap | null) {
  return !!a && !!b && a.surface === b.surface && a.page === b.page
    && a.autoId === b.autoId && a.execId === b.execId
}

function syncHistory(m: Model) {
  if (restoring) return
  const s: NavSnap = { surface: m.surface, page: m.page, autoId: m.autoId, execId: m.execId }
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
  useStore.setState({ surface: s.surface, page: s.page, autoId: s.autoId, execId: s.execId })
  lastNav = s
  restoring = false
})
