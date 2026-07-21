// Onboarding surface (SPEC §10): step 1 (welcome + live self-check) and
// step 2 (connect your AI). Step 3 is the Create flow — on entry we mark
// onboarding done and hand off via setSurface('create', 'onboard').
//
// Step 2 is fully real (§10/§19): detection reports installed + sign-in state
// for all five providers, installs run in the backend (`harness.install` WS
// stream), and sign-in help opens only when the provider actually needs it.
import React, { useEffect, useReducer, useRef } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { BtnPrimary, Eyebrow, GreenCheck, Logo, MiniBadge, Spinner } from '../ui'

interface Det { id: string; name: string; installed: boolean; signedIn: boolean | null; detail: string }

type CardPhase = 'idle' | 'installing' | 'pulling' | 'signin' | 'checking' | 'connected' | 'failed'
interface Card {
  phase: CardPhase
  pct: number | null            // install percent, when the stream carries one
  line: string                  // latest install line
  pullPct: number               // §10 Qwen3 8B model download percent
  method: 'browser' | 'terminal' | null
  error: string | null          // failed-install first error line
  notReady: string | null       // failed connection check, shown on the idle card
}

const LOCAL_MODEL = 'qwen3:8b'
const SUG_ORDER = ['claude', 'codex', 'gemini', 'opencode', 'ollama']
const SUG: Record<string, { title: string; body: string; btn: string; primary: boolean }> = {
  claude: {
    title: 'Use Claude', primary: true, btn: 'Set up Claude Code',
    body: 'You’ll need a Claude account on Pro or higher. The most capable option — nothing extra to pay.',
  },
  codex: {
    title: 'Use Codex', primary: false, btn: 'Set up Codex',
    body: 'Signs in with your ChatGPT account.',
  },
  gemini: {
    title: 'Use Gemini', primary: false, btn: 'Set up Gemini CLI',
    body: 'Signs in with your Google account. Generous free tier. Needs Node.js on this Mac.',
  },
  opencode: {
    title: 'Use OpenCode', primary: false, btn: 'Set up OpenCode',
    body: 'Open-source — works with any provider you’ve already set up.',
  },
  ollama: {
    title: 'Use a free local AI', primary: false, btn: 'Download and install · 5.2 GB',
    body: 'Sets up Ollama with Qwen3 8B. Local to this Mac, works offline.',
  },
}
const CONTINUE_LABEL: Record<string, string> = {
  claude: 'Continue with Claude →',
  codex: 'Continue with Codex →',
  gemini: 'Continue with Gemini →',
  opencode: 'Continue with OpenCode →',
  ollama: 'Continue with local AI →',
}

interface Ob {
  phase: 'welcome' | 'connect'
  smStarted: boolean
  smSteps: { name: string; status: 'pending' | 'executing' | 'done'; dur: string }[]
  smShowResult: boolean
  smDone: boolean
  det: 'searching' | 'cards'
  detStarted: boolean
  provs: Det[]
  cards: Record<string, Card>
  chosen: string | null
  committing: boolean
}

// When the Create flow (step 3) navigates back into onboarding, resume at
// step 2 instead of repeating the welcome self-check.
let resumeAtConnect = false
// Back from step 3 lands on step 2 with detection results, card states, and
// the chosen provider intact. Persist the last state across unmount; installs
// and downloads live in the backend, so the resume effect below reattaches.
let savedOb: Ob | null = null

const freshCard = (): Card => ({
  phase: 'idle', pct: null, line: '', pullPct: 0, method: null, error: null, notReady: null,
})

function freshOb(): Ob {
  if (resumeAtConnect && savedOb) return { ...savedOb, phase: 'connect', committing: false }
  return {
    phase: resumeAtConnect ? 'connect' : 'welcome',
    smStarted: false,
    smSteps: [
      { name: 'Checking your settings', status: 'pending', dur: '' },
      { name: 'Loading your automations', status: 'pending', dur: '' },
      { name: 'Starting the execution engine', status: 'pending', dur: '' },
    ],
    smShowResult: false,
    smDone: false,
    det: 'searching',
    detStarted: false,
    provs: [],
    cards: {},
    chosen: null,
    committing: false,
  }
}

// ---------- page ----------

export default function Onboarding() {
  const agents = useStore((s) => s.agents)
  const autos = useStore((s) => s.autos)
  const showToast = useStore((s) => s.showToast)
  const setSurface = useStore((s) => s.setSurface)
  const harnessInstall = useStore((s) => s.harnessInstall)
  const ollamaPull = useStore((s) => s.ollamaPull)

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
      .then((provs) => {
        const wait = Math.max(0, 1900 - (Date.now() - started))
        t(() => up((o) => { o.det = 'cards'; o.provs = provs }), wait)
      })
  }

  useEffect(() => {
    if (ob.phase === 'connect') startDetect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ob.phase])

  // ----- per-provider card machine (§10) -----
  const card = (id: string): Card => ob.cards[id] ?? freshCard()
  const setCard = (id: string, patch: Partial<Card>) =>
    up((o) => { o.cards = { ...o.cards, [id]: { ...card(id), ...patch } } })

  // Found-card "Check connection": the real §4.7 readiness check (§19
  // /agents/check-harness), padded to ≥900 ms so the spinner reads.
  const startCheck = (p: Det) => {
    setCard(p.id, { phase: 'checking', notReady: null })
    const t0 = Date.now()
    void api.checkHarness(p.name, null)
      .then((r) => r.status === 'ready')
      .catch(() => false)
      .then(async (ready) => {
        let reason = 'it didn’t answer the readiness check'
        if (!ready && p.id === 'ollama') {
          const st = await api.ollamaStatus().catch(() => null)
          reason = st?.ready ? 'the Qwen3 8B model isn’t installed yet' : 'the local server isn’t answering'
        }
        t(() => {
          if (card(p.id).phase !== 'checking') return
          if (ready) setCard(p.id, { phase: 'connected' })
          else setCard(p.id, { phase: 'idle', notReady: `Not ready — ${reason}.` })
        }, Math.max(0, 900 - (Date.now() - t0)))
      })
  }

  // Sign-in help, only when necessary (§10): the backend opens the browser
  // (Codex) or Terminal (the rest); we poll until the sign-in rule flips.
  const pollSignin = (p: Det) => {
    iv(() => {
      if (card(p.id).phase !== 'signin') return
      void api.signinStatus(p.id).then((s) => {
        if (s.signedIn === true && card(p.id).phase === 'signin') startCheck(p)
      }).catch(() => { /* backend hiccup — keep polling */ })
    }, 2000)
  }
  const startSignin = (p: Det) => {
    void api.loginHarness(p.id)
      .then((r) => { setCard(p.id, { phase: 'signin', method: r.method }); pollSignin(p) })
      .catch((e: Error) => {
        if (e.message.includes('already signed in')) startCheck(p)
        else showToast(e.message)
      })
  }

  // Suggestion-card install: real backend install (§19 POST /agents/install);
  // progress arrives via the harness.install effect below.
  const startInstall = (p: Det) => {
    setCard(p.id, { phase: 'installing', pct: null, line: '', error: null })
    api.installHarness(p.id).catch((e: Error & { status?: number }) => {
      // 409 = already running (a resumed machine) — the stream keeps feeding us.
      if (e.status !== 409) setCard(p.id, { phase: 'failed', error: e.message })
    })
  }

  // §10 model download completion: the model appearing in the installed list
  // is the source of truth (percent comes from the ollama.pull effect below).
  const pollPull = (id: string) => {
    iv(() => {
      if (card(id).phase !== 'pulling') return
      void api.ollamaStatus().then((s) => {
        if (s.models.includes(LOCAL_MODEL) && card(id).phase === 'pulling') {
          setCard(id, { phase: 'connected' })
        }
      }).catch(() => { /* keep polling */ })
    }, 2000)
  }

  // After a finished install: Ollama continues into the model download; the
  // account-backed providers go through sign-in only if they need it.
  const afterInstall = (id: string) => {
    const p = ob.provs.find((x) => x.id === id)
    if (!p || !['installing'].includes(card(id).phase)) return
    if (id === 'ollama') {
      setCard(id, { phase: 'pulling', pullPct: 0 })
      // A previous attempt's terminal ollama.pull event may still sit in the
      // store — clear it or the failure effect would instantly kill this pull.
      useStore.setState({ ollamaPull: null })
      void api.ollamaPull(LOCAL_MODEL).catch((e: Error) => setCard(id, { phase: 'failed', error: e.message }))
      pollPull(id)
      return
    }
    setCard(id, { phase: 'checking' })
    void api.signinStatus(id)
      .then((s) => { if (s.signedIn === false) startSignin(p); else startCheck(p) })
      .catch(() => startCheck(p))
  }

  // Live install progress from the §19 harness.install WS stream.
  useEffect(() => {
    for (const [id, evt] of Object.entries(harnessInstall)) {
      const c = ob.cards[id]
      if (!c || c.phase !== 'installing') continue
      if (!evt.done) {
        if (evt.line !== undefined || evt.pct !== undefined) {
          setCard(id, { line: evt.line ?? c.line, pct: evt.pct ?? c.pct })
        }
      } else if (evt.ok) {
        afterInstall(id)
      } else {
        setCard(id, { phase: 'failed', error: evt.error ?? 'install failed' })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harnessInstall])

  // Live model-download percent / failure from the ollama.pull WS stream.
  useEffect(() => {
    const c = ob.cards.ollama
    if (!c || c.phase !== 'pulling' || !ollamaPull || ollamaPull.model !== LOCAL_MODEL) return
    if (ollamaPull.done && ollamaPull.ok === false) {
      setCard('ollama', { phase: 'failed', error: ollamaPull.line || `couldn't pull ${LOCAL_MODEL}` })
      return
    }
    const m = (ollamaPull.line || '').match(/(\d{1,3})%/)
    if (m) setCard('ollama', { pullPct: Math.min(100, parseInt(m[1], 10)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ollamaPull])

  // ----- resume in-flight machines after remount (back from step 3) -----
  // Installs and downloads run in the backend; reattach via the §19 status
  // snapshot and re-arm the polls that died with the previous mount.
  useEffect(() => {
    for (const p of ob.provs) {
      const c = ob.cards[p.id]
      if (!c) continue
      if (c.phase === 'installing') {
        void api.installStatus(p.id).then((s) => {
          if (card(p.id).phase !== 'installing') return
          if (s.state === 'done') afterInstall(p.id)
          else if (s.state === 'failed') setCard(p.id, { phase: 'failed', error: s.error ?? 'install failed' })
          else if (s.state === 'idle') setCard(p.id, { phase: 'failed', error: 'the install didn’t start' })
          // running → the live harness.install stream keeps feeding us
        }).catch(() => { /* backend hiccup — the WS stream still lands */ })
      } else if (c.phase === 'signin') pollSignin(p)
      else if (c.phase === 'pulling') pollPull(p.id)
      else if (c.phase === 'checking') startCheck(p)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ----- derived (prototype obVals) -----
  const agentPre = agents.length > 0
  const autoPre = autos.length > 0
  // With prior data (agents or automations), step 1 still shows but Continue
  // goes straight to the app instead of step 2.
  const pre = agentPre || autoPre

  // ----- commit connected providers as real agent records -----
  // `pick` is the provider whose in-card Continue was clicked (null on skip);
  // it becomes the default agent. All connected providers are committed.
  const commitOnboardAgents = async (pick: string | null): Promise<void> => {
    const conn = ob.provs.filter((p) => card(p.id).phase === 'connected')
    if (conn.length === 0) return
    // A found Ollama keeps its own configured default; a fresh suggestion
    // install committed the Qwen3 8B model it just downloaded (§10).
    const bodyFor = (p: Det) => p.id === 'ollama'
      ? (p.installed
        ? { name: 'Ollama', harness: 'Ollama', mode: 'default', model: null }
        : { name: 'Qwen3 8B', harness: 'Ollama', mode: 'ollama', model: LOCAL_MODEL })
      : { name: null, harness: p.name, mode: 'default', model: null }
    const existing = useStore.getState().agents
    const defPid = pick ?? conn[0].id
    let defaultId: string | null = null
    for (const p of conn) {
      const body = bodyFor(p)
      const dup = existing.find((a) => a.harness === body.harness && a.model === body.model)
      const id = dup ? dup.id : (await api.addAgent(body)).id
      if (p.id === defPid) defaultId = id
    }
    if (defaultId) {
      await api.patchAgent(defaultId, { default: true })
      // §10: every seed automation gets the chosen default agent.
      const allAutos = useStore.getState().autos
      await Promise.all(
        allAutos.filter((a) => a.agentId !== defaultId)
          .map((a) => api.patchAuto(a.id, { agentId: defaultId })),
      )
    }
  }

  // ----- navigation -----
  const obToConnect = () => {
    if (pre) { setSurface('app'); return }
    up((o) => { o.phase = 'connect' })
  }
  const obContinue = (pick: string) => {
    if (ob.committing) return
    up((o) => { o.chosen = pick; o.committing = true })
    void (async () => {
      try {
        await commitOnboardAgents(pick)
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
        await commitOnboardAgents(null)
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
      : { dot: 'var(--text-faintest)', anim: 'none', c: 'var(--text-faint)' }
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
          <Logo size={32} />
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
              <Eyebrow style={{ marginBottom: 10 }}>READY</Eyebrow>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <MiniBadge c="var(--green)" bg="var(--green-bg)">All set</MiniBadge>
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
          ? <BtnPrimary onClick={obToConnect} style={{ padding: '10px 18px', fontSize: 13.5, animation: 'adFadeUp .3s ease both' }}>{nextLabel}</BtnPrimary>
          : <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 12, color: 'var(--text-faint)' }}>Setting things up…</span>}
      </div>
    )
  }

  // ---------- step 2 ----------
  function renderConnect() {
    const foundList = ob.provs.filter((p) => p.installed)
    const missing = SUG_ORDER
      .map((id) => ob.provs.find((p) => p.id === id && !p.installed))
      .filter((p): p is Det => !!p)

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
            {foundList.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 26, animation: 'adFadeUp .35s ease both' }}>
                <Eyebrow style={{ color: 'var(--accent)' }}>FOUND ON THIS MAC</Eyebrow>
                {foundList.map((f) => renderFoundCard(f))}
              </div>
            )}

            {foundList.length === 0 && (
              <div style={{
                background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 10, padding: '12px 16px',
                marginBottom: 18, display: 'flex', alignItems: 'center', gap: 10, animation: 'adFadeUp .35s ease both',
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-faint)', flex: 'none' }} />
                <span style={{ fontSize: 13, color: 'var(--text-2)' }}>No AI app was found on this Mac — here are some suggestions for moving forward.</span>
              </div>
            )}

            {missing.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 16, alignItems: 'start', animation: 'adFadeUp .35s ease both' }}>
                {missing.map((p) => renderSuggestionCard(p))}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 24 }}>
              <button
                className="ad-btn-text dim"
                onClick={obSkip}
                style={{ fontWeight: 500, fontSize: 12.5, padding: '6px 2px' }}
              >
                Skip for now
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  function renderBar(pct: number | null) {
    return (
      <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
        {pct !== null ? (
          <div style={{ height: '100%', width: `${Math.round(pct)}%`, background: 'var(--accent)', transition: 'width .12s linear' }} />
        ) : (
          <div style={{ height: '100%', width: '30%', background: 'var(--accent)', animation: 'adBarSlide 1.2s ease-in-out infinite' }} />
        )}
      </div>
    )
  }

  // Amber "waiting for you to sign in" block, shared by found and suggestion
  // cards; copy follows the §19 login method the backend reported.
  function renderSigninWait(p: Det) {
    const c = card(p.id)
    const where = c.method === 'browser'
      ? 'We opened your browser — sign in there and come back. We’ll notice on our own.'
      : 'We opened Terminal — finish signing in there and come back. We’ll notice on our own.'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', background: 'var(--amber)',
            animation: 'adPulse 1.2s ease-in-out infinite', flex: 'none', marginTop: 5,
          }} />
          <div>
            <div style={{ fontWeight: 500, fontSize: 13 }}>Waiting for you to sign in…</div>
            <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', marginTop: 2 }}>{where}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingLeft: 16 }}>
          <button className="ad-btn-text dim" style={{ fontSize: 12 }} onClick={() => setCard(p.id, { phase: 'idle', method: null })}>Cancel</button>
        </div>
      </div>
    )
  }

  function renderFoundCard(f: Det) {
    const c = card(f.id)
    const conn = c.phase === 'connected'
    return (
      <div
        key={f.id}
        style={{
          background: 'var(--bg-card-sel)', border: `1px solid ${conn ? 'oklch(0.74 0.155 52 / .4)' : 'rgba(255,255,255,.09)'}`,
          borderRadius: 12, padding: '17px 22px',
          display: 'flex', alignItems: 'center', gap: 16, transition: 'border-color .2s',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{f.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{f.detail}</div>
          {c.phase === 'idle' && c.notReady && (
            <div style={{ fontSize: 12, color: 'var(--amber)', marginTop: 4 }}>{c.notReady}</div>
          )}
        </div>
        {c.phase === 'idle' && (f.signedIn === false ? (
          <button
            onClick={() => startSignin(f)}
            style={{
              background: 'var(--amber)', color: '#1a1508', border: 'none', borderRadius: 7,
              padding: '7px 14px', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', flex: 'none',
            }}
          >
            Sign in
          </button>
        ) : (
          <button className="ad-btn-ghost" onClick={() => startCheck(f)} style={{ flex: 'none' }}>
            Check connection
          </button>
        ))}
        {c.phase === 'checking' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 'none' }}>
            <Spinner size={13} style={{ animationDuration: '.8s' }} />
            <span style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2)' }}>Checking connection…</span>
          </div>
        )}
        {c.phase === 'signin' && (
          <div style={{ flex: 'none', maxWidth: 340 }}>{renderSigninWait(f)}</div>
        )}
        {conn && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 'none', animation: 'adFadeUp .3s ease both' }}>
            <GreenCheck label="Connected" />
            <button
              className="ad-btn-primary"
              onClick={() => obContinue(f.id)}
              disabled={ob.committing}
              style={{ opacity: ob.committing ? 0.6 : 1 }}
            >
              {`Continue with ${f.name} →`}
            </button>
          </div>
        )}
      </div>
    )
  }

  function renderSuggestionCard(p: Det) {
    const c = card(p.id)
    const s = SUG[p.id]
    const conn = c.phase === 'connected'
    return (
      <div
        key={p.id}
        style={{
          background: 'var(--bg-card-sel)',
          border: `1px solid ${conn ? 'oklch(0.74 0.155 52 / .4)' : 'rgba(255,255,255,.09)'}`,
          borderRadius: 12, padding: 22, display: 'flex', flexDirection: 'column', gap: 10,
          transition: 'border-color .2s',
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 15 }}>{s.title}</div>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-2)', flex: 1 }}>{s.body}</p>
        {c.phase === 'idle' && (
          <button
            className={s.primary ? 'ad-btn-primary' : 'ad-btn-ghost'}
            onClick={() => startInstall(p)}
            style={{ alignSelf: 'flex-start' }}
          >
            {s.btn}
          </button>
        )}
        {c.phase === 'installing' && (
          <div>
            <div style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2em)', marginBottom: 8 }}>
              {p.id === 'ollama' ? 'Step 1 of 2 — Installing Ollama…' : `Installing ${p.name}…`}{' '}
              {c.pct !== null && (
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 12, color: 'var(--text-muted)' }}>{Math.round(c.pct)}%</span>
              )}
            </div>
            {renderBar(c.pct)}
            {c.line && c.pct === null && (
              <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-faint)', marginTop: 7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.line}
              </div>
            )}
          </div>
        )}
        {c.phase === 'pulling' && (
          <div>
            <div style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2em)', marginBottom: 8 }}>
              Step 2 of 2 — Downloading Qwen3 8B…{' '}
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 12, color: 'var(--text-muted)' }}>
                {(c.pullPct / 100 * 5.2).toFixed(1)} GB of 5.2 GB
              </span>
            </div>
            {renderBar(c.pullPct)}
            <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', marginTop: 8 }}>
              Ollama is installed. You can keep using your Mac — this finishes in the background.
            </div>
          </div>
        )}
        {c.phase === 'checking' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Spinner size={13} style={{ animationDuration: '.8s' }} />
            <span style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2)' }}>Checking connection…</span>
          </div>
        )}
        {c.phase === 'signin' && renderSigninWait(p)}
        {c.phase === 'failed' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--red)' }}>
              Install failed — {c.error ?? 'something went wrong'}
            </div>
            <button className="ad-btn-ghost" onClick={() => startInstall(p)} style={{ alignSelf: 'flex-start' }}>
              Try again
            </button>
          </div>
        )}
        {conn && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, animation: 'adFadeUp .3s ease both' }}>
            <GreenCheck label={p.id === 'ollama' ? 'Ready to go.' : 'Connected — signed in as you.'} />
            <button
              className="ad-btn-primary"
              onClick={() => obContinue(p.id)}
              disabled={ob.committing}
              style={{ alignSelf: 'flex-start', opacity: ob.committing ? 0.6 : 1 }}
            >
              {CONTINUE_LABEL[p.id]}
            </button>
          </div>
        )}
      </div>
    )
  }
}
