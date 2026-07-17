// New/Edit agent form (§12): harness radio cards, mode/model choice, Ollama model pulls.
// One form for both — title and submit switch to "Edit agent" / "Save changes" when editing.
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Agent } from '../types'
import { P, RadioRing, Spinner } from '../ui'

type HarnessId = 'claude' | 'gemini' | 'codex' | 'opencode' | 'ollama'

// Edit-mode hand-off from AgentsPage: stash the agent (and whether it's signed
// out) before go('agentNew'); the form consumes it on mount.
let pendingEdit: { agent: Agent; needsFix: boolean } | null = null
export function openAgentEdit(agent: Agent, needsFix: boolean): void {
  pendingEdit = { agent, needsFix }
}

const HARNESSES: { id: HarnessId; name: string; desc: string }[] = [
  { id: 'claude', name: 'Claude Code', desc: 'Uses your Claude account. The most capable option — nothing extra to pay.' },
  { id: 'gemini', name: 'Gemini CLI', desc: 'Uses your Google account. Generous free tier.' },
  { id: 'codex', name: 'Codex', desc: 'Uses your ChatGPT account.' },
  { id: 'opencode', name: 'OpenCode', desc: 'Open-source — works with any provider you’ve already set up.' },
  { id: 'ollama', name: 'Ollama', desc: 'Serves models entirely on this Mac — private, works offline.' },
]

const HARNESS_NAME: Record<HarnessId, string> = {
  claude: 'Claude Code', gemini: 'Gemini CLI', codex: 'Codex', opencode: 'OpenCode', ollama: 'Ollama',
}

const DEFAULT_NOTE: Record<HarnessId, string> = {
  claude: 'Whatever Claude Code is already configured with',
  gemini: 'Whatever Gemini CLI is already configured with',
  codex: 'Whatever Codex is already configured with',
  opencode: 'Whatever OpenCode is already configured with',
  ollama: 'The local model Ollama is already configured with',
}

const SUGGESTED = [
  { id: 'qwen3-coder:30b', note: 'Best local coding model', meta: '19 GB' },
  { id: 'gemma4:e4b', note: 'Good local default', meta: '9.6 GB' },
  { id: 'deepseek-coder:6.7b', note: 'Light and quick', meta: '3.8 GB' },
]

const eyebrow: React.CSSProperties = {
  font: `600 10px var(--mono)`, letterSpacing: '.09em', color: 'var(--text-faint)', margin: '0 0 10px',
}

type InstState = 'idle' | 'installing' | 'sudo' | 'denied'

const HARNESS_ID: Record<string, HarnessId> = {
  'Claude Code': 'claude', 'Gemini CLI': 'gemini', 'Codex': 'codex', 'OpenCode': 'opencode', 'Ollama': 'ollama',
}

export default function AgentNewPage() {
  const { go, showToast, ollamaPull } = useStore()
  // Consume the edit hand-off on mount. The initializer must stay pure
  // (StrictMode double-invokes it), so the stash is cleared in an effect.
  const [editing] = useState(() => pendingEdit)
  useEffect(() => { pendingEdit = null }, [])
  const editAgent = editing?.agent ?? null
  const editHid = editAgent ? (HARNESS_ID[editAgent.harness] ?? 'claude') : null
  const [harness, setHarness] = useState<HarnessId | null>(editHid)
  const [mode, setMode] = useState<'default' | 'ollama' | null>(
    editAgent ? (editAgent.model ? 'ollama' : 'default') : null)
  const [model, setModel] = useState<string | null>(editAgent?.model ?? null)
  const [name, setName] = useState(editAgent ? (editAgent.name || editAgent.harness) : '')
  const [desc, setDesc] = useState(editAgent?.desc ?? '')
  const [nameErr, setNameErr] = useState(false)
  const [fix, setFix] = useState<'needs' | 'busy' | 'done'>(editing?.needsFix ? 'needs' : 'done')
  const [st, setSt] = useState<{ ready: boolean; models: string[] } | null>(null)
  const [pulling, setPulling] = useState<string | null>(null)
  const [pullText, setPullText] = useState('')
  const [inst, setInst] = useState<InstState>('idle')
  const [instPct, setInstPct] = useState(0)
  const pullingRef = useRef<string | null>(null)
  pullingRef.current = pulling

  // Inline Ollama install (§12, "inline install flow, ~1.1 GB") — the same
  // simulated state machine Onboarding's "Use a free local AI" card drives.
  const instTimers = useRef<number[]>([])
  useEffect(() => () => { instTimers.current.forEach((id) => { clearTimeout(id); clearInterval(id) }) }, [])

  const instFinish = () => {
    const id = window.setInterval(() => {
      setInstPct((p) => {
        const n = Math.min(100, p + 5)
        if (n >= 100) {
          window.clearInterval(id)
          // Done — re-poll status so the Ollama-gated options ungate.
          void api.ollamaStatus()
            .then((s) => setSt({ ready: true, models: s.models }))
            .catch(() => setSt({ ready: true, models: [] }))
        }
        return n
      })
    }, 80)
    instTimers.current.push(id)
  }
  const instSudoWait = (ms: number) => {
    const id = window.setTimeout(() => {
      setInst('installing')
      instFinish()
    }, ms)
    instTimers.current.push(id)
  }
  const instRise = () => {
    const id = window.setInterval(() => {
      setInstPct((p) => {
        const n = Math.min(60, p + 5)
        if (n >= 60) {
          window.clearInterval(id)
          setInst('sudo')
          instSudoWait(2400)
        }
        return n
      })
    }, 80)
    instTimers.current.push(id)
  }
  const installOllama = (afterRetry: boolean) => {
    if (afterRetry) {
      setInst('sudo')
      instSudoWait(2000)
      return
    }
    setInst('installing')
    setInstPct(0)
    instRise()
  }

  useEffect(() => {
    api.ollamaStatus().then(setSt).catch(() => setSt({ ready: false, models: [] }))
  }, [])

  // Pull progress arrives as WS 'ollama.pull' events the store doesn't capture —
  // poll status every 2s while a pull is in progress instead.
  useEffect(() => {
    if (!pulling) return
    const id = setInterval(() => {
      api.ollamaStatus().then((s) => {
        setSt(s)
        const nm = pullingRef.current
        if (nm && s.models.includes(nm)) {
          setPulling(null)
          setModel(nm)
          showToast(`${nm} installed — selected for this agent.`)
        }
      }).catch(() => { /* backend hiccup — keep polling */ })
    }, 2000)
    return () => clearInterval(id)
  }, [pulling, showToast])

  const ready = st?.ready ?? false
  const models = st?.models ?? []
  // OpenCode serves its models through Ollama, so it's gated like the Ollama harness and local mode.
  const needsOllama = harness === 'ollama' || harness === 'opencode' || mode === 'ollama'
  const canAdd = !!harness && !!mode
    && (!needsOllama || ready)
    && (mode !== 'ollama' || !!model)
    && !!name.trim()

  const startPull = (raw: string) => {
    const nm = raw.trim()
    if (!nm) { showToast('Type a model name, like qwen3-coder:30b.'); return }
    if (pulling) { showToast(`One download at a time — ${pulling} is still downloading.`); return }
    if (models.includes(nm)) { showToast(`${nm} is already installed.`); return }
    setPulling(nm)
    setPullText('')
    api.ollamaPull(nm).catch((e: Error) => { setPulling(null); showToast(e.message) })
  }

  // §12 reconnect flow, started from the form banner when editing a signed-out agent.
  const reconnect = () => {
    if (!editAgent) return
    setFix('busy')
    const t0 = Date.now()
    const settle = (ok: boolean) => {
      window.setTimeout(() => {
        setFix(ok ? 'done' : 'needs')
        showToast(ok
          ? 'Connected — signed in as you.'
          : 'Still signed out — finish signing in, then try again.', 2600)
      }, Math.max(0, 1700 - (Date.now() - t0)))
    }
    api.checkAgent(editAgent.id)
      .then((r) => settle(r.status === 'ready'))
      .catch(() => settle(false))
  }

  const addAgent = async () => {
    if (!canAdd) {
      const needsName = harness && mode && !name.trim()
      const missingOllama = needsOllama && !ready
      if (needsName) setNameErr(true)
      if (missingOllama) showToast('Install Ollama first.')
      else if (!needsName) showToast('Pick a harness and a model first.')
      return
    }
    const h = harness as HarnessId
    const payload = {
      harness: HARNESS_NAME[h],
      mode,
      model: mode === 'ollama' ? model : null,
      name: name.trim(),
      desc: desc.trim(),
    }
    try {
      if (editAgent) {
        await api.patchAgent(editAgent.id, payload)
        go('agents')
        showToast(`Changes saved — ${payload.name} is ready.`)
      } else {
        await api.addAgent(payload)
        go('agents')
        showToast(`${payload.name} added — ready to write automations.`)
      }
    } catch (e) { showToast((e as Error).message) }
  }

  const olMissingMsg = harness === 'ollama'
    ? 'This agent works through Ollama, which isn’t installed on this Mac yet.'
    : harness === 'opencode'
      ? 'OpenCode serves its models through Ollama, which isn’t installed on this Mac yet.'
      : 'Local models need Ollama, which isn’t installed on this Mac yet.'

  const sugRows = SUGGESTED.filter((sg) => !models.includes(sg.id) && pulling !== sg.id)

  // Pull progress from the backend's `ollama.pull` WS lines — render a real %
  // bar when the line carries one ("… 45% …"), slide otherwise.
  const pullLine = pulling && ollamaPull && ollamaPull.model === pulling ? ollamaPull.line : ''
  const pullPct = (() => {
    const m = pullLine.match(/(\d{1,3})%/)
    return m ? Math.min(100, parseInt(m[1], 10)) : null
  })()

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '26px 30px 70px', animation: 'adFadeUp .4s ease' }}>
      <style>{'@keyframes adBarSlide { from { transform: translateX(-100%); } to { transform: translateX(350%); } }'}</style>
      <button
        onClick={() => go('agents')}
        style={{
          background: 'none', border: 'none', color: 'var(--text-muted)', fontWeight: 500,
          fontSize: 12.5, cursor: 'pointer', padding: '4px 0', marginBottom: 10,
        }}
      >
        <i className="fa-solid fa-chevron-left" style={{ fontSize: 10 }} /> Agents
      </button>
      <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.01em', margin: '0 0 6px' }}>
        {editAgent ? 'Edit agent' : 'Add an agent'}
      </h1>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)', margin: '0 0 22px' }}>
        Pick the harness that writes your automations, then choose which model it uses. The agent never executes anything — Auto Dave does.
      </p>

      {fix === 'needs' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'oklch(0.8 0.13 85 / .08)', border: '1px solid oklch(0.8 0.13 85 / .25)',
          borderRadius: 10, padding: '12px 14px', marginBottom: 22, animation: 'adFadeUp .3s ease both',
        }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: P.amber, flex: 'none' }} />
          <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.5, color: '#e6d9b8' }}>
            This agent is signed out — reconnect it to create or edit automations.
          </span>
          <button
            onClick={reconnect}
            style={{
              background: P.amber, color: '#1a1508', border: 'none', borderRadius: 7,
              padding: '6px 13px', fontWeight: 600, fontSize: 12, cursor: 'pointer', flex: 'none',
            }}
          >
            Reconnect
          </button>
        </div>
      )}
      {fix === 'busy' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 22 }}>
          <Spinner size={13} />
          <span style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2)' }}>Reconnecting…</span>
        </div>
      )}

      <div style={eyebrow}>NAME</div>
      <input
        value={name}
        onChange={(e) => { setName(e.target.value); if (e.target.value.trim()) setNameErr(false) }}
        placeholder="Name this agent"
        style={{
          width: '100%', boxSizing: 'border-box', background: 'var(--bg-card)',
          border: `1px solid ${nameErr ? 'oklch(0.7 0.19 25 / .65)' : 'var(--border-input)'}`,
          boxShadow: nameErr ? '0 0 0 3px oklch(0.7 0.19 25 / .1)' : 'none',
          borderRadius: 10, padding: '11px 14px', fontWeight: 500, fontSize: 13,
          color: 'var(--text)', outline: 'none', marginBottom: 16,
        }}
      />
      {nameErr && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '-10px 0 16px', animation: 'adFadeUp .25s ease both' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: P.red, flex: 'none' }} />
          <span style={{ fontWeight: 500, fontSize: 12, color: 'oklch(0.74 0.17 25)' }}>
            A name is required — give this agent a name before saving.
          </span>
        </div>
      )}

      <div style={eyebrow}>DESCRIPTION <span style={{ color: '#4a515c' }}>· OPTIONAL</span></div>
      <textarea
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder="What this agent is for — shown on the Agents page and given to the drafting agent"
        rows={2}
        style={{
          width: '100%', boxSizing: 'border-box', background: 'var(--bg-card)',
          border: '1px solid var(--border-input)', borderRadius: 10, padding: '11px 14px',
          fontWeight: 400, fontSize: 13, lineHeight: 1.5, color: 'var(--text)',
          outline: 'none', resize: 'vertical', marginBottom: 22,
        }}
      />

      <div style={eyebrow}>HARNESS</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        {HARNESSES.map((h) => {
          const on = harness === h.id
          const hasReq = (h.id === 'ollama' || h.id === 'opencode') && !ready
          return (
            <div
              key={h.id}
              onClick={() => { setHarness(h.id); setMode('default'); setModel(null) }}
              style={{
                background: on ? '#151920' : 'var(--bg-card)',
                border: `1px solid ${on ? 'oklch(0.74 0.155 52 / .7)' : 'var(--border-card)'}`,
                borderRadius: 12, padding: '16px 18px', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', gap: 7,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                <RadioRing selected={on} />
                <span style={{ fontWeight: 600, fontSize: 14 }}>{h.name}</span>
                {hasReq && (
                  <span style={{
                    display: 'inline-flex', padding: '2px 7px', borderRadius: 6,
                    font: `600 10px var(--mono)`, letterSpacing: '.05em', textTransform: 'uppercase',
                    background: P.amberBg, color: P.amber,
                  }}>
                    Needs Ollama
                  </span>
                )}
              </div>
              <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-2)' }}>{h.desc}</p>
            </div>
          )
        })}
      </div>

      {harness && (
        <>
          <div style={eyebrow}>MODEL</div>
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border-card)',
            borderRadius: 12, overflow: 'hidden', marginBottom: 16,
          }}>
            {([
              { id: 'default' as const, name: 'Default configured model', note: DEFAULT_NOTE[harness] },
              { id: 'ollama' as const, name: 'A local model', note: 'Pick a model served on this Mac through Ollama' },
            ]).map((md) => {
              const on = mode === md.id
              return (
                <div
                  key={md.id}
                  onClick={() => { setMode(md.id); setModel(null) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 11, padding: '14px 16px',
                    borderBottom: '1px solid rgba(255,255,255,.04)', cursor: 'pointer',
                  }}
                >
                  <RadioRing selected={on} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 13, color: on ? 'var(--text)' : 'var(--text-2em)' }}>{md.name}</div>
                    <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--text-muted)', marginTop: 2 }}>{md.note}</div>
                  </div>
                </div>
              )
            })}
          </div>

          {needsOllama && st && !ready && (
            <div style={{
              background: 'oklch(0.8 0.13 85 / .08)', border: '1px solid oklch(0.8 0.13 85 / .25)',
              borderRadius: 10, padding: '12px 14px', marginBottom: 16, animation: 'adFadeUp .3s ease both',
            }}>
              {inst === 'idle' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: P.amber, flex: 'none' }} />
                  <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.5, color: '#e6d9b8' }}>{olMissingMsg}</span>
                  <button
                    onClick={() => installOllama(false)}
                    style={{
                      background: P.amber, color: '#1a1508', border: 'none', borderRadius: 7,
                      padding: '6px 13px', fontWeight: 600, fontSize: 12, cursor: 'pointer', flex: 'none',
                    }}
                  >
                    Install Ollama · 1.1 GB
                  </button>
                </div>
              )}
              {inst === 'installing' && (
                <div>
                  <div style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2em)', marginBottom: 8 }}>
                    Installing Ollama…{' '}
                    <span style={{ font: `500 12px var(--mono)`, color: 'var(--text-muted)' }}>{(instPct / 100 * 1.1).toFixed(1)} GB of 1.1 GB</span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: 'var(--accent)', width: `${Math.round(instPct)}%`, transition: 'width .12s linear' }} />
                  </div>
                </div>
              )}
              {inst === 'sudo' && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: '50%', background: P.amber,
                    animation: 'adPulse 1.2s ease-in-out infinite', flex: 'none', marginTop: 5,
                  }} />
                  <div>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>macOS is asking for your permission…</div>
                    <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', marginTop: 2 }}>
                      Your Mac shows its own password or Touch ID prompt to finish installing Ollama — Auto Dave never sees your password.
                    </div>
                  </div>
                </div>
              )}
              {inst === 'denied' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>Install paused — permission was declined.</div>
                  <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)' }}>
                    Nothing was changed on your Mac. When you’re ready, try again and approve the macOS prompt.
                  </div>
                  <button
                    onClick={() => installOllama(true)}
                    style={{
                      alignSelf: 'flex-start', background: 'rgba(255,255,255,.05)', color: 'var(--text-2em)',
                      border: '1px solid var(--border-btn)', borderRadius: 8, padding: '7px 13px',
                      fontWeight: 500, fontSize: 12.5, cursor: 'pointer',
                    }}
                  >
                    Try again
                  </button>
                </div>
              )}
            </div>
          )}
          {needsOllama && ready && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <i className="fa-solid fa-check" style={{ color: P.green, fontSize: 13 }} />
              <span style={{ fontWeight: 500, fontSize: 12.5, color: P.green }}>Ollama is installed and active.</span>
            </div>
          )}

          {mode === 'ollama' && ready && (
            <>
              <div style={eyebrow}>LOCAL MODEL</div>
              {models.length > 0 ? (
                <div style={{
                  background: 'var(--bg-card)', border: '1px solid var(--border-card)',
                  borderRadius: 12, overflow: 'hidden', marginBottom: 14,
                }}>
                  {models.map((n) => {
                    const on = model === n
                    const sug = SUGGESTED.find((s) => s.id === n)
                    return (
                      <div
                        key={n}
                        onClick={() => setModel(n)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 11, padding: '12px 16px',
                          borderBottom: '1px solid rgba(255,255,255,.04)', cursor: 'pointer',
                        }}
                      >
                        <RadioRing selected={on} />
                        <span style={{ flex: 1, font: `500 13px var(--mono)`, color: on ? 'var(--text)' : 'var(--text-2em)' }}>{n}</span>
                        <span style={{ font: `400 11px var(--mono)`, color: 'var(--text-faint)' }}>{sug?.meta ?? ''}</span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div style={{
                  background: 'var(--bg-card)', border: '1px dashed rgba(255,255,255,.12)', borderRadius: 10,
                  padding: '13px 16px', marginBottom: 14, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-muted)',
                }}>
                  No local models installed yet — download one below and it will show up here.
                </div>
              )}

              <div style={{ ...eyebrow, margin: '0 0 10px' }}>DOWNLOAD A MODEL</div>
              {!pulling ? (
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <input
                    value={pullText}
                    onChange={(e) => setPullText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') startPull(pullText) }}
                    placeholder="e.g. qwen3-coder:30b"
                    style={{
                      flex: 1, background: 'var(--bg-card)', border: '1px solid var(--border-input)',
                      borderRadius: 10, padding: '11px 14px', font: `500 13px var(--mono)`,
                      color: 'var(--text)', outline: 'none',
                    }}
                  />
                  <button
                    onClick={() => startPull(pullText)}
                    style={{
                      background: pullText.trim() ? 'var(--accent)' : 'rgba(255,255,255,.05)',
                      color: pullText.trim() ? 'var(--on-accent)' : 'var(--text-2em)',
                      border: `1px solid ${pullText.trim() ? 'var(--accent)' : 'var(--border-btn)'}`,
                      borderRadius: 10, padding: '0 16px', fontWeight: 600, fontSize: 12.5,
                      cursor: 'pointer', flex: 'none',
                    }}
                  >
                    Download
                  </button>
                </div>
              ) : (
                <div style={{
                  background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 10,
                  padding: '13px 16px', marginBottom: 12,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
                    <span style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2em)' }}>
                      Downloading <span style={{ font: `500 12.5px var(--mono)`, color: 'var(--text)' }}>{pulling}</span>…
                    </span>
                    <span style={{ font: `500 12px var(--mono)`, color: 'var(--text-muted)' }}>
                      {pullPct ?? 0}%
                    </span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
                    {pullPct != null ? (
                      <div style={{ height: '100%', width: `${pullPct}%`, background: 'var(--accent)', transition: 'width .3s ease' }} />
                    ) : (
                      <div style={{
                        height: '100%', width: '30%', background: 'var(--accent)',
                        animation: 'adBarSlide 1.2s ease-in-out infinite',
                      }} />
                    )}
                  </div>
                </div>
              )}

              {sugRows.length > 0 && (
                <>
                  <div style={{ ...eyebrow, margin: '0 0 8px' }}>SUGGESTED</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                    {sugRows.map((sg) => (
                      <button
                        key={sg.id}
                        title={sg.note}
                        onClick={() => setPullText(sg.id)}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 7,
                          background: 'var(--bg-card)', border: '1px solid var(--border-input)',
                          borderRadius: 999, padding: '7px 13px', cursor: 'pointer',
                        }}
                      >
                        <span style={{ font: `500 12px var(--mono)`, color: 'var(--text-2em)' }}>{sg.id}</span>
                        <span style={{ font: `400 10.5px var(--mono)`, color: 'var(--text-faint)' }}>{sg.meta}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              <a
                href="https://ollama.com/library"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--text-muted)',
                  fontWeight: 500, fontSize: 12.5, textDecoration: 'none',
                  border: '1px solid var(--border-input)', borderRadius: 8, padding: '8px 13px', marginBottom: 22,
                }}
              >
                Browse more models on Ollama <span style={{ fontWeight: 400, fontSize: 11 }}>↗</span>
              </a>
            </>
          )}
        </>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button
          onClick={() => { void addAgent() }}
          style={{
            background: canAdd ? 'var(--accent)' : 'rgba(255,255,255,.06)',
            color: canAdd ? 'var(--on-accent)' : 'var(--text-faint)',
            border: 'none', borderRadius: 8, padding: '10px 18px',
            fontWeight: 600, fontSize: 13.5, cursor: canAdd ? 'pointer' : 'default',
          }}
        >
          {editAgent ? 'Save changes' : 'Add agent'}
        </button>
        <button
          onClick={() => go('agents')}
          style={{ background: 'none', border: 'none', color: 'var(--text-faint)', fontWeight: 500, fontSize: 12.5, cursor: 'pointer' }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
