// Onboarding surface (SPEC §10): step 1 (welcome + live self-check) and
// step 2 (connect your AI). Step 3 is the Create flow — on entry we mark
// onboarding done and hand off via setSurface('create', 'onboard').
import React, { useEffect, useReducer, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { RadioRing, Spinner } from '../ui'

interface Det { id: string; name: string; detail: string }

type ClState = 'idle' | 'installing' | 'sudo' | 'denied' | 'waiting' | 'connected'
type LoState = 'idle' | 'installing' | 'sudo' | 'denied' | 'downloading' | 'ready'

interface Ob {
  phase: 'welcome' | 'connect'
  smStarted: boolean
  smSteps: { name: string; status: 'pending' | 'executing' | 'done'; dur: string }[]
  smShowResult: boolean
  smDone: boolean
  det: 'searching' | 'cards'
  detStarted: boolean
  found: Det[]
  fuId: string | null
  fuState: 'idle' | 'busy' | 'connected'
  cl: ClState
  clPct: number
  lo: LoState
  loInsPct: number
  loPct: number
  chosen: 'claude' | 'local' | 'found' | null
  committing: boolean
}

// When the Create flow (step 3) navigates back into onboarding, resume at
// step 2 instead of repeating the welcome self-check.
let resumeAtConnect = false
// The prototype keeps onboarding state in its central model: back from step 3
// lands on step 2 with detection results, connect states, and the chosen
// provider intact. Persist the last state across this component's unmount.
let savedOb: Ob | null = null

function freshOb(): Ob {
  if (resumeAtConnect && savedOb) return { ...savedOb, phase: 'connect', committing: false }
  return {
    phase: resumeAtConnect ? 'connect' : 'welcome',
    smStarted: false,
    smSteps: [
      { name: 'Checking settings', status: 'pending', dur: '' },
      { name: 'Preparing folders', status: 'pending', dur: '' },
      { name: 'Loading data', status: 'pending', dur: '' },
    ],
    smShowResult: false,
    smDone: false,
    det: 'searching',
    detStarted: false,
    found: [],
    fuId: null,
    fuState: 'idle',
    cl: 'idle',
    clPct: 0,
    lo: 'idle',
    loInsPct: 0,
    loPct: 0,
    chosen: null,
    committing: false,
  }
}

// ---------- local primitives (prototype-exact; Logo copied from App.tsx pattern) ----------

function Logo() {
  return (
    <span style={{
      width: 32, height: 32, borderRadius: 9, background: 'var(--accent)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
    }}>
      <i className="fa-solid fa-hammer" style={{ color: '#0b0d11', fontSize: 15 }} />
    </span>
  )
}

function AccentBtn({ children, onClick, style }: {
  children: React.ReactNode; onClick?: (e: React.MouseEvent) => void; style?: React.CSSProperties
}) {
  const [hov, setHov] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        background: hov ? 'var(--accent-hover)' : 'var(--accent)', color: 'var(--on-accent)',
        border: 'none', borderRadius: 8, padding: '9px 14px', fontWeight: 600, fontSize: 13,
        cursor: 'pointer', transition: 'background .15s ease', ...style,
      }}
    >
      {children}
    </button>
  )
}

function SubtleBtn({ children, onClick, style }: {
  children: React.ReactNode; onClick?: (e: React.MouseEvent) => void; style?: React.CSSProperties
}) {
  const [hov, setHov] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        background: 'rgba(255,255,255,.05)', color: 'var(--text-2em)',
        border: `1px solid ${hov ? 'var(--border-hover)' : 'var(--border-btn)'}`,
        borderRadius: 8, padding: '9px 14px', fontWeight: 500, fontSize: 13,
        cursor: 'pointer', transition: 'border-color .15s ease', alignSelf: 'flex-start', ...style,
      }}
    >
      {children}
    </button>
  )
}

function LinkBtn({ children, onClick, faint }: {
  children: React.ReactNode; onClick?: (e: React.MouseEvent) => void; faint?: boolean
}) {
  const [hov, setHov] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        background: 'none', border: 'none', padding: 0,
        color: faint ? (hov ? 'var(--text-2)' : 'var(--text-faint)') : (hov ? 'var(--link-hover)' : 'var(--accent)'),
        fontWeight: 500, fontSize: 12, cursor: 'pointer', transition: 'color .15s ease',
      }}
    >
      {children}
    </button>
  )
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
      <div style={{ height: '100%', background: 'var(--accent)', width: `${Math.round(pct)}%`, transition: 'width .12s linear' }} />
    </div>
  )
}

/** Amber pulsing-dot notice ("macOS is asking for your permission…"). */
function SudoNotice({ body }: { body: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%', background: 'var(--amber)',
        animation: 'adPulse 1.2s ease-in-out infinite', flex: 'none', marginTop: 5,
      }} />
      <div>
        <div style={{ fontWeight: 500, fontSize: 13 }}>macOS is asking for your permission…</div>
        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', marginTop: 2 }}>{body}</div>
      </div>
    </div>
  )
}

function GreenCheck({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, animation: 'adFadeUp .3s ease both' }}>
      <i className="fa-solid fa-check" style={{ color: 'var(--green)', fontSize: 13 }} />
      <span style={{ fontWeight: 500, fontSize: 13, color: 'var(--green)' }}>{label}</span>
    </div>
  )
}

// ---------- page ----------

export default function Onboarding() {
  const agents = useStore((s) => s.agents)
  const autos = useStore((s) => s.autos)
  const showToast = useStore((s) => s.showToast)
  const setSurface = useStore((s) => s.setSurface)

  const [, bump] = useReducer((n: number) => n + 1, 0)
  const obRef = useRef<Ob | null>(null)
  if (!obRef.current) obRef.current = freshOb()
  const ob = obRef.current

  const timers = useRef<number[]>([])
  const ivals = useRef<number[]>([])
  const t = (fn: () => void, ms: number) => { const id = window.setTimeout(fn, ms); timers.current.push(id); return id }
  const iv = (fn: () => void, ms: number) => { const id = window.setInterval(fn, ms); ivals.current.push(id); return id }
  const up = (fn: (o: Ob) => void) => { fn(ob); bump() }

  useEffect(() => () => {
    timers.current.forEach((id) => clearTimeout(id))
    ivals.current.forEach((id) => clearInterval(id))
    savedOb = obRef.current
  }, [])

  // ----- step 1: live self-check (prototype runSample timings) -----
  useEffect(() => {
    if (ob.phase !== 'welcome' || ob.smStarted) return
    ob.smStarted = true
    t(() => up((o) => { o.smSteps[0].status = 'executing' }), 500)
    t(() => up((o) => { o.smSteps[0].status = 'done'; o.smSteps[0].dur = '1.1s'; o.smSteps[1].status = 'executing' }), 1700)
    t(() => up((o) => { o.smSteps[1].status = 'done'; o.smSteps[1].dur = '1.4s'; o.smSteps[2].status = 'executing' }), 3100)
    const finish = () => {
      // Real verification: the store booted against the backend before this
      // surface rendered — only report "ready" once that connection is live.
      if (useStore.getState().connected === true) {
        up((o) => { o.smSteps[2].status = 'done'; o.smSteps[2].dur = '0.8s'; o.smShowResult = true })
        t(() => up((o) => { o.smDone = true }), 550)
      } else {
        t(finish, 300)
      }
    }
    t(finish, 3950)
    bump()
    // Re-arm after StrictMode's dev remount (the timer-clearing cleanup above
    // fires between the two effect passes, so the guard must reset with it).
    return () => { ob.smStarted = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ----- step 2: detection (real api.detectAgents, ≥1.9 s spinner as designed) -----
  const startDetect = () => {
    if (ob.detStarted) return
    up((o) => { o.detStarted = true; o.det = 'searching' })
    const started = Date.now()
    void api.detectAgents()
      .catch(() => [] as Det[])
      .then((found) => {
        const wait = Math.max(0, 1900 - (Date.now() - started))
        t(() => up((o) => { o.det = 'cards'; o.found = found }), wait)
      })
  }

  useEffect(() => {
    if (ob.phase === 'connect') startDetect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ob.phase])

  // ----- Use Claude state machine (prototype claudeInstall/claudeFinish) -----
  const claudeFinish = () => {
    const id = iv(() => {
      up((o) => { o.clPct = Math.min(100, o.clPct + 4) })
      if (ob.clPct >= 100) {
        clearInterval(id)
        up((o) => { o.cl = 'waiting' })
        claudeSignIn()
      }
    }, 80)
  }
  const claudeSignIn = () => {
    t(() => { if (ob.cl === 'waiting') up((o) => { o.cl = 'connected'; if (!o.chosen) o.chosen = 'claude' }) }, 3400)
  }
  const claudeSudoWait = (ms: number) => {
    t(() => {
      if (ob.cl !== 'sudo') return
      up((o) => { o.cl = 'installing' })
      claudeFinish()
    }, ms)
  }
  const claudeRise = () => {
    const id = iv(() => {
      up((o) => { o.clPct = Math.min(55, o.clPct + 4) })
      if (ob.clPct >= 55) {
        clearInterval(id)
        up((o) => { o.cl = 'sudo' })
        claudeSudoWait(2400)
      }
    }, 80)
  }
  const claudeInstall = (afterRetry: boolean) => {
    up((o) => { o.cl = 'installing'; o.clPct = afterRetry ? 55 : 0 })
    if (afterRetry) {
      up((o) => { o.cl = 'sudo' })
      claudeSudoWait(2000)
      return
    }
    claudeRise()
  }

  // ----- Use a free local AI state machine (prototype ollamaInstall/ollamaFinish) -----
  const ollamaDownload = () => {
    const id = iv(() => {
      up((o) => { o.loPct = Math.min(100, o.loPct + 1.6) })
      if (ob.loPct >= 100) {
        clearInterval(id)
        up((o) => { o.lo = 'ready'; if (!o.chosen) o.chosen = 'local' })
      }
    }, 70)
  }
  const ollamaFinish = () => {
    const id = iv(() => {
      up((o) => { o.loInsPct = Math.min(100, o.loInsPct + 5) })
      if (ob.loInsPct >= 100) {
        clearInterval(id)
        up((o) => { o.lo = 'downloading' })
        ollamaDownload()
      }
    }, 80)
  }
  const ollamaSudoWait = (ms: number) => {
    t(() => {
      if (ob.lo !== 'sudo') return
      up((o) => { o.lo = 'installing' })
      ollamaFinish()
    }, ms)
  }
  const ollamaRise = () => {
    const id = iv(() => {
      up((o) => { o.loInsPct = Math.min(60, o.loInsPct + 5) })
      if (ob.loInsPct >= 60) {
        clearInterval(id)
        up((o) => { o.lo = 'sudo' })
        ollamaSudoWait(2400)
      }
    }, 80)
  }
  const ollamaInstall = (afterRetry: boolean) => {
    if (afterRetry) {
      up((o) => { o.lo = 'sudo' })
      ollamaSudoWait(2000)
      return
    }
    up((o) => { o.lo = 'installing'; o.loInsPct = 0; o.loPct = 0 })
    ollamaRise()
  }

  // ----- resume in-flight machines after remount (back from step 3) -----
  // Timers died with the previous mount; pick each machine up where it left
  // off — the local model download "finishes in the background" as designed.
  useEffect(() => {
    if (ob.fuState === 'busy' && ob.fuId) {
      const id = ob.fuId
      t(() => { if (ob.fuId === id && ob.fuState === 'busy') up((o) => { o.fuState = 'connected'; if (!o.chosen) o.chosen = 'found' }) }, 1400)
    }
    if (ob.cl === 'installing') { if (ob.clPct < 55) claudeRise(); else claudeFinish() }
    else if (ob.cl === 'sudo') claudeSudoWait(2400)
    else if (ob.cl === 'waiting') claudeSignIn()
    if (ob.lo === 'installing') { if (ob.loInsPct < 60) ollamaRise(); else ollamaFinish() }
    else if (ob.lo === 'sudo') ollamaSudoWait(2400)
    else if (ob.lo === 'downloading') ollamaDownload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ----- derived (prototype obVals) -----
  const agentPre = agents.length > 0
  const autoPre = autos.length > 0
  // With prior data (agents or automations), step 1 still shows but Continue
  // goes straight to the app instead of step 2.
  const pre = agentPre || autoPre
  const foundConn = ob.fuState === 'connected'
  const foundObj = ob.found.find((f) => f.id === ob.fuId) ?? null
  const readyCount = (ob.cl === 'connected' ? 1 : 0) + (ob.lo === 'ready' ? 1 : 0) + (foundConn ? 1 : 0)
  const choice = readyCount > 1
  const chosen = ob.chosen ?? (foundConn ? 'found' : ob.cl === 'connected' ? 'claude' : ob.lo === 'ready' ? 'local' : null)
  const chosenName = chosen === 'claude' ? 'Claude'
    : chosen === 'local' ? 'the local AI'
    : chosen === 'found' && foundObj ? foundObj.name : null

  // ----- commit.sh connected providers as real agent records -----
  const commitOnboardAgents = async (): Promise<void> => {
    type Spec = { key: 'claude' | 'codex' | 'gemini' | 'opencode' | 'found-ollama' | 'local'; body: { name: string | null; harness: string; mode: string; model: string | null } }
    const specs: Spec[] = []
    if (foundConn && ob.fuId === 'claude') specs.push({ key: 'claude', body: { name: null, harness: 'Claude Code', mode: 'default', model: null } })
    if (foundConn && ob.fuId === 'codex') specs.push({ key: 'codex', body: { name: null, harness: 'Codex', mode: 'default', model: null } })
    if (foundConn && ob.fuId === 'gemini') specs.push({ key: 'gemini', body: { name: null, harness: 'Gemini CLI', mode: 'default', model: null } })
    if (foundConn && ob.fuId === 'opencode') specs.push({ key: 'opencode', body: { name: null, harness: 'OpenCode', mode: 'default', model: null } })
    if (foundConn && ob.fuId === 'ollama') specs.push({ key: 'found-ollama', body: { name: 'Ollama', harness: 'Ollama', mode: 'default', model: null } })
    if (ob.cl === 'connected' && !specs.some((s) => s.key === 'claude')) specs.push({ key: 'claude', body: { name: null, harness: 'Claude Code', mode: 'default', model: null } })
    if (ob.lo === 'ready') specs.push({ key: 'local', body: { name: 'Qwen3 8B', harness: 'Ollama', mode: 'ollama', model: 'qwen3:8b' } })
    if (specs.length === 0) return
    const foundKey: Spec['key'] = ob.fuId === 'claude' ? 'claude'
      : ob.fuId === 'codex' ? 'codex'
      : ob.fuId === 'gemini' ? 'gemini'
      : ob.fuId === 'opencode' ? 'opencode'
      : 'found-ollama'
    const defKey: Spec['key'] | undefined = chosen === 'claude' ? 'claude'
      : chosen === 'local' ? 'local'
      : chosen === 'found' ? foundKey
      : specs[0].key
    const existing = useStore.getState().agents
    let defaultId: string | null = null
    for (const s of specs) {
      const dup = existing.find((a) => a.harness === s.body.harness && a.model === s.body.model)
      let id: string
      if (dup) {
        id = dup.id
      } else {
        const created = await api.addAgent(s.body)
        id = created.id
      }
      if (s.key === defKey) defaultId = id
    }
    if (defaultId) {
      await api.patchAgent(defaultId, { default: true })
      // §10: every seed automation gets the chosen default agent.
      const autos = useStore.getState().autos
      await Promise.all(
        autos.filter((a) => a.agentId !== defaultId)
          .map((a) => api.patchAuto(a.id, { agentId: defaultId })),
      )
    }
  }

  // ----- navigation -----
  const obToConnect = () => {
    if (pre) { setSurface('app'); return }
    up((o) => { o.phase = 'connect' })
  }
  const obContinue = () => {
    if (ob.committing) return
    up((o) => { o.committing = true })
    void (async () => {
      try {
        await commitOnboardAgents()
      } catch (e) {
        showToast((e as Error).message)
        up((o) => { o.committing = false })
        return
      }
      // Step 3 = the Create flow, labelled by that page. Mark onboarding done first.
      localStorage.setItem('ad-onboarded', '1')
      resumeAtConnect = true
      setSurface('create', 'onboard')
    })()
  }
  const obSkip = () => {
    void (async () => {
      try {
        await commitOnboardAgents()
      } catch (e) {
        showToast((e as Error).message)
      }
      setSurface('app')
    })()
  }

  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      background: 'radial-gradient(1000px 480px at 50% -12%, oklch(0.74 0.155 52 / .05), transparent 70%)',
    }}>
      <div className="ad-drag" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 18, padding: '13px 28px', flex: 'none' }}>
        <div style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11, color: 'var(--text-faint)' }}>
          {ob.phase === 'welcome' ? 'Step 1 of 3' : 'Step 2 of 3'}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {ob.phase === 'welcome' ? renderWelcome() : renderConnect()}
      </div>

      <div style={{ flex: 'none', borderTop: '1px solid var(--hairline)', padding: '13px 28px', display: 'flex', justifyContent: 'center', gap: 26, flexWrap: 'wrap' }}>
        {['Everything executes on this Mac', 'Nothing executes until you review it', 'Passwords stay in your Keychain'].map((p) => (
          <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--green)' }} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p}</span>
          </div>
        ))}
      </div>
    </div>
  )

  // ---------- step 1 ----------
  function renderWelcome() {
    const stepDot = (s: Ob['smSteps'][number]) =>
      s.status === 'executing' ? { dot: 'var(--cyan)', anim: 'adPulse 1.2s ease-in-out infinite', c: 'var(--text)' }
      : s.status === 'done' ? { dot: 'var(--green)', anim: 'none', c: 'var(--text-2em)' }
      : { dot: '#3a414c', anim: 'none', c: 'var(--text-faint)' }
    const chips = ['Settings created', 'Folders in place']
    if (agentPre) chips.push('Agent found')
    if (autoPre) chips.push('Automations found')
    const para = autoPre
      ? 'Auto Dave created fresh settings and folders, and found your existing automations. You’re ready to go.'
      : agentPre
      ? 'Auto Dave created fresh settings and folders, and found an AI already connected. You’re ready to go.'
      : 'Auto Dave created fresh settings and folders, and everything is loaded. You’re ready to go.'
    const nextPara = autoPre
      ? 'Setup only happens once. Your automations are already here, so you can go straight to them.'
      : agentPre
      ? 'Setup only happens once. Your AI is already connected, so you can go straight to creating automations.'
      : 'Setup only happens once. Next, connect your AI so you can create your own automations.'
    const nextLabel = pre ? 'Continue →' : 'Connect your AI →'

    return (
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '30px 32px 60px', animation: 'adFadeUp .5s ease both' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <Logo />
          <span style={{ fontWeight: 600, fontSize: 15, letterSpacing: '-.01em' }}>Auto Dave</span>
        </div>
        <h1 style={{ fontWeight: 600, fontSize: 30, lineHeight: 1.25, letterSpacing: '-.02em', margin: '0 0 12px' }}>
          Recurring jobs, done exactly the same way every time.
        </h1>
        <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--text-2)', margin: '0 0 28px' }}>
          Describe a job in plain words. Your AI writes it as scripts you can read. Auto Dave executes them on your schedule and shows you the result.
        </p>

        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--hairline)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>Getting Auto Dave ready</span>
            </div>
          </div>
          <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {ob.smSteps.map((s) => {
              const d = stepDot(s)
              return (
                <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: d.dot, animation: d.anim, flex: 'none' }} />
                  <span style={{ flex: 1, fontSize: 13, color: d.c }}>{s.name}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)' }}>{s.dur}</span>
                </div>
              )
            })}
          </div>
          {ob.smShowResult && (
            <div style={{ borderTop: '1px solid var(--hairline)', background: 'var(--bg-inset)', padding: '16px 18px', animation: 'adFadeUp .4s ease' }}>
              <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 10, letterSpacing: '.09em', color: 'var(--text-faint)', marginBottom: 10 }}>READY</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <span style={{
                  display: 'inline-flex', padding: '3px 9px', borderRadius: 6, fontFamily: 'var(--mono)',
                  fontWeight: 600, fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase',
                  background: 'var(--green-bg)', color: 'var(--green)',
                }}>
                  All set
                </span>
                {chips.map((ch) => (
                  <span key={ch} style={{
                    display: 'inline-flex', padding: '3px 9px', borderRadius: 6, fontFamily: 'var(--mono)',
                    fontWeight: 500, fontSize: 11.5, background: 'rgba(255,255,255,.05)',
                    border: '1px solid var(--border-card)', color: 'var(--text-2em)',
                  }}>
                    {ch}
                  </span>
                ))}
              </div>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-2em)' }}>{para}</p>
            </div>
          )}
        </div>

        <p style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-2)', margin: '20px 0 16px' }}>{nextPara}</p>
        {ob.smDone
          ? <AccentBtn onClick={obToConnect} style={{ padding: '10px 18px', fontSize: 13.5, animation: 'adFadeUp .3s ease both' }}>{nextLabel}</AccentBtn>
          : <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 12, color: 'var(--text-faint)' }}>Setting things up…</span>}
      </div>
    )
  }

  // ---------- step 2 ----------
  function renderConnect() {
    const anyFound = ob.found.length > 0
    const showSuggestions = !ob.found.some((f) => f.id === 'ollama')
    const sugClaude = ob.found.length === 0

    return (
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '44px 32px 60px', animation: 'adFadeUp .5s ease both' }}>
        <h1 style={{ fontWeight: 600, fontSize: 26, lineHeight: 1.25, letterSpacing: '-.02em', margin: '0 0 10px' }}>Connect your AI</h1>
        <p style={{ fontSize: 14.5, lineHeight: 1.6, color: 'var(--text-2)', margin: '0 0 26px' }}>
          The AI only writes the scripts — Auto Dave executes them. Nothing executes before you review it.
        </p>

        {ob.det === 'searching' && (
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, padding: 22, display: 'flex', alignItems: 'center', gap: 12 }}>
            <Spinner size={14} style={{ animationDuration: '.8s', flex: 'none' }} />
            <span style={{ fontSize: 13.5, color: 'var(--text-2)' }}>Looking for an AI already on this Mac…</span>
          </div>
        )}

        {ob.det === 'cards' && (
          <>
            {anyFound && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 26, animation: 'adFadeUp .35s ease both' }}>
                <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 10, letterSpacing: '.09em', color: 'var(--accent)' }}>FOUND ON THIS MAC</div>
                {ob.found.map((f) => renderFoundCard(f))}
              </div>
            )}

            {!anyFound && (
              <div style={{
                background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 10, padding: '12px 16px',
                marginBottom: 18, display: 'flex', alignItems: 'center', gap: 10, animation: 'adFadeUp .35s ease both',
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-faint)', flex: 'none' }} />
                <span style={{ fontSize: 13, color: 'var(--text-2)' }}>No AI app was found on this Mac — here are two suggestions for moving forward.</span>
              </div>
            )}

            {showSuggestions && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 16, alignItems: 'start', animation: 'adFadeUp .35s ease both' }}>
                {sugClaude && renderClaudeCard()}
                {renderLocalCard()}
              </div>
            )}

            {choice && (
              <div style={{
                marginTop: 22, background: 'oklch(0.74 0.155 52 / .07)', border: '1px solid oklch(0.74 0.155 52 / .25)',
                borderRadius: 10, padding: '11px 14px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-2em)', animation: 'adFadeUp .3s ease both',
              }}>
                {readyCount} AIs are ready — pick the one Auto Dave should use. You can switch anytime under Agents.
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 24 }}>
              {readyCount > 0 && (
                <AccentBtn onClick={obContinue} style={{ padding: '10px 18px', fontSize: 13.5, animation: 'adFadeUp .3s ease both', opacity: ob.committing ? 0.6 : 1 }}>
                  {choice && chosenName ? `Continue with ${chosenName} →` : 'Continue →'}
                </AccentBtn>
              )}
              <button
                onClick={obSkip}
                style={{ background: 'none', border: 'none', color: 'var(--text-faint)', fontWeight: 500, fontSize: 12.5, cursor: 'pointer', padding: '6px 2px' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-2)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-faint)' }}
              >
                Skip for now
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  function renderFoundCard(f: Det) {
    const conn = ob.fuId === f.id && ob.fuState === 'connected'
    const busy = ob.fuId === f.id && ob.fuState === 'busy'
    const idle = !busy && !conn
    const sel = choice && chosen === 'found' && conn
    const pickable = choice && conn
    const borderC = sel ? 'oklch(0.74 0.155 52 / .7)' : pickable ? 'rgba(255,255,255,.12)' : 'oklch(0.74 0.155 52 / .35)'
    return (
      <div
        key={f.id}
        onClick={() => { if (pickable) up((o) => { o.chosen = 'found' }) }}
        style={{
          background: 'var(--bg-card-sel)', border: `1px solid ${borderC}`, borderRadius: 12, padding: '17px 22px',
          display: 'flex', alignItems: 'center', gap: 16, cursor: pickable ? 'pointer' : 'default', transition: 'border-color .2s',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{f.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{f.detail}</div>
        </div>
        {idle && (
          <AccentBtn
            onClick={(e) => {
              e.stopPropagation()
              up((o) => { o.fuId = f.id; o.fuState = 'busy' })
              t(() => { if (ob.fuId === f.id) up((o) => { o.fuState = 'connected'; if (!o.chosen) o.chosen = 'found' }) }, 1400)
            }}
            style={{ flex: 'none' }}
          >
            {`Use ${f.name} →`}
          </AccentBtn>
        )}
        {busy && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 'none' }}>
            <Spinner size={13} style={{ animationDuration: '.8s' }} />
            <span style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2)' }}>Connecting…</span>
          </div>
        )}
        {conn && (
          <div style={{ flex: 'none' }}>
            <GreenCheck label={choice ? 'Connected' : `Connected — Auto Dave will use ${f.name}.`} />
          </div>
        )}
        {choice && conn && <RadioRing selected={sel} />}
      </div>
    )
  }

  function renderClaudeCard() {
    const sel = choice && chosen === 'claude'
    const pickable = choice && ob.cl === 'connected'
    return (
      <div
        onClick={() => { if (pickable) up((o) => { o.chosen = 'claude' }) }}
        style={{
          background: 'var(--bg-card-sel)', border: `1px solid ${sel ? 'oklch(0.74 0.155 52 / .7)' : 'rgba(255,255,255,.09)'}`,
          borderRadius: 12, padding: 22, display: 'flex', flexDirection: 'column', gap: 10,
          cursor: pickable ? 'pointer' : 'default', transition: 'border-color .2s',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>Use Claude</div>
          {choice && ob.cl === 'connected' && <RadioRing selected={sel} />}
        </div>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-2)', flex: 1 }}>
          You&rsquo;ll need Claude Code installed and a Claude account on Pro or higher.
        </p>
        {ob.cl === 'idle' && (
          <AccentBtn onClick={(e) => { e.stopPropagation(); claudeInstall(false) }} style={{ alignSelf: 'flex-start' }}>Set up Claude Code</AccentBtn>
        )}
        {ob.cl === 'installing' && (
          <div>
            <div style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2em)', marginBottom: 8 }}>
              Installing the helper…{' '}
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 12, color: 'var(--text-muted)' }}>{Math.round(ob.clPct)}%</span>
            </div>
            <ProgressBar pct={ob.clPct} />
          </div>
        )}
        {ob.cl === 'sudo' && (
          <SudoNotice body="Your Mac shows its own password or Touch ID prompt for this step — Auto Dave never sees your password." />
        )}
        {ob.cl === 'denied' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontWeight: 500, fontSize: 13 }}>Install paused — permission was declined.</div>
            <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)' }}>
              Nothing was changed on your Mac. When you&rsquo;re ready, try again and approve the macOS prompt.
            </div>
            <AccentBtn onClick={(e) => { e.stopPropagation(); claudeInstall(true) }} style={{ alignSelf: 'flex-start' }}>Try again</AccentBtn>
          </div>
        )}
        {ob.cl === 'waiting' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
              <span style={{
                width: 7, height: 7, borderRadius: '50%', background: 'var(--amber)',
                animation: 'adPulse 1.2s ease-in-out infinite', flex: 'none', marginTop: 5,
              }} />
              <div>
                <div style={{ fontWeight: 500, fontSize: 13 }}>Waiting for you to sign in…</div>
                <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', marginTop: 2 }}>
                  We opened your browser — sign in to your Claude account there and come back. We&rsquo;ll notice on our own.
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingLeft: 16 }}>
              <LinkBtn onClick={(e) => { e.stopPropagation(); showToast('Opened the sign-in page in your browser again.') }}>Reopen the sign-in page</LinkBtn>
              <LinkBtn faint onClick={(e) => { e.stopPropagation(); up((o) => { o.cl = 'idle'; o.clPct = 0 }) }}>Cancel</LinkBtn>
            </div>
          </div>
        )}
        {ob.cl === 'connected' && <GreenCheck label="Connected — signed in as you." />}
      </div>
    )
  }

  function renderLocalCard() {
    const sel = choice && chosen === 'local'
    const pickable = choice && ob.lo === 'ready'
    return (
      <div
        onClick={() => { if (pickable) up((o) => { o.chosen = 'local' }) }}
        style={{
          background: 'var(--bg-card)', border: `1px solid ${sel ? 'oklch(0.74 0.155 52 / .7)' : 'var(--border-card)'}`,
          borderRadius: 12, padding: 22, display: 'flex', flexDirection: 'column', gap: 10,
          cursor: pickable ? 'pointer' : 'default', transition: 'border-color .2s',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>Use a free local AI</div>
          {choice && ob.lo === 'ready' && <RadioRing selected={sel} />}
        </div>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-2)', flex: 1 }}>
          Sets up Ollama with Qwen3 8B. Local to this Mac, works offline.
        </p>
        {ob.lo === 'idle' && (
          <SubtleBtn onClick={(e) => { e.stopPropagation(); ollamaInstall(false) }}>Download and install · 5.2 GB</SubtleBtn>
        )}
        {ob.lo === 'installing' && (
          <div>
            <div style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2em)', marginBottom: 8 }}>
              Step 1 of 2 — Installing Ollama…{' '}
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 12, color: 'var(--text-muted)' }}>{Math.round(ob.loInsPct)}%</span>
            </div>
            <ProgressBar pct={ob.loInsPct} />
          </div>
        )}
        {ob.lo === 'sudo' && (
          <SudoNotice body="Your Mac shows its own password or Touch ID prompt to finish installing Ollama — Auto Dave never sees your password." />
        )}
        {ob.lo === 'denied' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontWeight: 500, fontSize: 13 }}>Install paused — permission was declined.</div>
            <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)' }}>
              Nothing was changed on your Mac. When you&rsquo;re ready, try again and approve the macOS prompt.
            </div>
            <SubtleBtn onClick={(e) => { e.stopPropagation(); ollamaInstall(true) }}>Try again</SubtleBtn>
          </div>
        )}
        {ob.lo === 'downloading' && (
          <div>
            <div style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2em)', marginBottom: 8 }}>
              Step 2 of 2 — Downloading Qwen3 8B…{' '}
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 12, color: 'var(--text-muted)' }}>
                {(ob.loPct / 100 * 5.2).toFixed(1)} GB of 5.2 GB
              </span>
            </div>
            <ProgressBar pct={ob.loPct} />
            <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', marginTop: 8 }}>
              Ollama is installed. You can keep using your Mac — this finishes in the background.
            </div>
          </div>
        )}
        {ob.lo === 'ready' && <GreenCheck label="Ready to go." />}
      </div>
    )
  }
}
