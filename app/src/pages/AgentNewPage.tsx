// New/Edit agent form (§12): harness radio cards, mode/model choice, Ollama model pulls.
// One form for both — title and submit switch to "Edit agent" / "Save changes" when editing.
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Agent } from '../types'
import { BtnPrimary, Eyebrow, GreenCheck, P, ProgressBar, RadioRing, Spinner } from '../ui'

type HarnessId = 'claude' | 'gemini' | 'codex' | 'opencode'

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
  { id: 'opencode', name: 'OpenCode', desc: 'Open-source — works with any provider you’ve already set up, or a local model.' },
]

const HARNESS_NAME: Record<HarnessId, string> = {
  claude: 'Claude Code', gemini: 'Gemini CLI', codex: 'Codex', opencode: 'OpenCode',
}

const DEFAULT_NOTE: Record<HarnessId, string> = {
  claude: 'Whatever Claude Code is already configured with',
  gemini: 'Whatever Gemini CLI is already configured with',
  codex: 'Whatever Codex is already configured with',
  opencode: 'Whatever OpenCode is already configured with',
}

// §4.7 custom mode: free-text model string, passed verbatim as `--model`
const CUSTOM_PLACEHOLDER: Record<HarnessId, string> = {
  claude: 'e.g. claude-opus-4-8',
  gemini: 'e.g. gemini-2.5-pro',
  codex: 'e.g. gpt-5-codex',
  opencode: 'e.g. anthropic/claude-opus-4-8',
}

const SUGGESTED = [
  { id: 'qwen3-coder:30b', note: 'Best local coding model', meta: '19 GB' },
  { id: 'gemma4:e4b', note: 'Good local default', meta: '9.6 GB' },
  { id: 'deepseek-coder:6.7b', note: 'Light and quick', meta: '3.8 GB' },
]

/** Amber notice card (§12): pulsless dot + body + amber action button — used for
 * the signed-out reconnect banner and the missing-Ollama install prompt. */
function AmberNotice({ body, btn, onBtn, style }: {
  body: string; btn: string; onBtn: () => void; style?: React.CSSProperties
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      background: 'oklch(0.8 0.13 85 / .08)', border: '1px solid oklch(0.8 0.13 85 / .25)',
      borderRadius: 10, padding: '12px 14px', animation: 'adFadeUp .3s ease both', ...style,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: P.amber, flex: 'none' }} />
      <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.5, color: '#e6d9b8' }}>{body}</span>
      <button
        onClick={onBtn}
        style={{
          background: P.amber, color: '#1a1508', border: 'none', borderRadius: 7,
          padding: '6px 13px', fontWeight: 600, fontSize: 12, cursor: 'pointer', flex: 'none',
        }}
      >
        {btn}
      </button>
    </div>
  )
}

const HARNESS_ID: Record<string, HarnessId> = {
  'Claude Code': 'claude', 'Gemini CLI': 'gemini', 'Codex': 'codex', 'OpenCode': 'opencode',
}

export default function AgentNewPage() {
  const { go, showToast, ollamaPull, runAgentCheck } = useStore()
  // Consume the edit hand-off on mount. The initializer must stay pure
  // (StrictMode double-invokes it), so the stash is cleared in an effect.
  const [editing] = useState(() => pendingEdit)
  useEffect(() => { pendingEdit = null }, [])
  const editAgent = editing?.agent ?? null
  const editHid = editAgent ? (HARNESS_ID[editAgent.harness] ?? 'claude') : null
  const [harness, setHarness] = useState<HarnessId | null>(editHid)
  const [mode, setMode] = useState<'default' | 'ollama' | 'custom' | null>(
    editAgent ? editAgent.mode : null)
  const [model, setModel] = useState<string | null>(editAgent?.model ?? null)
  const [name, setName] = useState(editAgent ? (editAgent.name || editAgent.harness) : '')
  const [desc, setDesc] = useState(editAgent?.desc ?? '')
  const [nameErr, setNameErr] = useState(false)
  const [fix, setFix] = useState<'needs' | 'busy' | 'done'>(editing?.needsFix ? 'needs' : 'done')
  const [st, setSt] = useState<{ ready: boolean; models: string[] } | null>(null)
  const [pulling, setPulling] = useState<string | null>(null)
  const [pullText, setPullText] = useState('')
  const [inst, setInst] = useState<'idle' | 'installing' | 'failed'>('idle')
  const [instPct, setInstPct] = useState<number | null>(null)
  const [instErr, setInstErr] = useState<string | null>(null)
  const harnessInstall = useStore((s) => s.harnessInstall)
  const pullingRef = useRef<string | null>(null)
  pullingRef.current = pulling

  // Inline Ollama install (§12) — the real §19 backend install; progress
  // arrives on the `harness.install` WS stream.
  const installOllama = () => {
    setInst('installing')
    setInstPct(null)
    setInstErr(null)
    // A previous attempt's terminal harness.install event may still sit in the
    // store — clear it or the effect below would instantly fail this retry.
    useStore.setState((s) => ({ harnessInstall: Object.fromEntries(Object.entries(s.harnessInstall).filter(([k]) => k !== 'ollama')) }))
    api.installHarness('ollama').catch((e: Error & { status?: number }) => {
      // 409 = an install is already running — its stream still lands here.
      if (e.status !== 409) { setInst('failed'); setInstErr(e.message) }
    })
  }
  useEffect(() => {
    const evt = harnessInstall.ollama
    if (!evt || inst !== 'installing') return
    if (!evt.done) {
      if (evt.pct !== undefined) setInstPct(evt.pct)
    } else if (evt.ok) {
      setInst('idle')
      // Done — re-poll status so the Ollama-gated options ungate.
      void api.ollamaStatus().then(setSt).catch(() => setSt(null))
    } else {
      setInst('failed')
      setInstErr(evt.error ?? 'install failed')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harnessInstall])

  useEffect(() => {
    api.ollamaStatus().then(setSt).catch(() => setSt({ ready: false, models: [] }))
  }, [])

  // Success confirmation: poll status every 2s while a pull is in progress —
  // the model appearing in the installed list is the source of truth.
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

  // Failure: the backend's terminal `ollama.pull` event carries ok=false —
  // without this the "Downloading…" card and the poll would spin forever.
  useEffect(() => {
    if (!pulling || !ollamaPull?.done || ollamaPull.model !== pulling) return
    if (ollamaPull.ok === false) {
      setPulling(null)
      showToast(`Download failed — ${ollamaPull.line || `couldn't pull ${pulling}`}`)
    }
  }, [ollamaPull, pulling, showToast])

  const ready = st?.ready ?? false
  const models = st?.models ?? []
  const needsOllama = mode === 'ollama'
  const canAdd = !!harness && !!mode
    && (!needsOllama || ready)
    && (mode === 'default' || !!model?.trim())
    && !!name.trim()

  const startPull = (raw: string) => {
    const nm = raw.trim()
    if (!nm) { showToast('Type a model name, like qwen3-coder:30b.'); return }
    if (pulling) { showToast(`One download at a time — ${pulling} is still downloading.`); return }
    if (models.includes(nm)) { showToast(`${nm} is already installed.`); return }
    // A previous attempt's terminal ollama.pull event may still sit in the
    // store — clear it or the failure effect would instantly kill this retry.
    useStore.setState({ ollamaPull: null })
    setPulling(nm)
    setPullText('')
    api.ollamaPull(nm).catch((e: Error) => { setPulling(null); showToast(e.message) })
  }

  // §12 reconnect flow, started from the form banner when editing a signed-out
  // agent. Runs through the store check so the cached Agents-page badge updates too.
  const reconnect = () => {
    if (!editAgent) return
    setFix('busy')
    const t0 = Date.now()
    void runAgentCheck(editAgent.id, 'connecting').then((st) => {
      const ok = st === 'ready'
      window.setTimeout(() => {
        setFix(ok ? 'done' : 'needs')
        showToast(ok
          ? 'Connected — signed in as you.'
          : 'Still signed out — finish signing in, then try again.', 2600)
      }, Math.max(0, 1700 - (Date.now() - t0)))
    })
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
      model: mode === 'default' ? null : (model?.trim() ?? null),
      name: name.trim(),
      desc: desc.trim(),
    }
    try {
      if (editAgent) {
        await api.patchAgent(editAgent.id, payload)
        // Saved config may change readiness — refresh the cached badge (§12).
        void runAgentCheck(editAgent.id, 'connecting')
        go('agents')
        showToast(`Changes saved — ${payload.name} is ready.`)
      } else {
        await api.addAgent(payload)
        go('agents')
        showToast(`${payload.name} added — ready to write automations.`)
      }
    } catch (e) { showToast((e as Error).message) }
  }

  const olMissingMsg = 'Local models need Ollama, which isn’t installed on this Mac yet.'

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
      <button
        className="ad-btn-text"
        onClick={() => go('agents')}
        style={{ marginBottom: 10 }}
      >
        <i className="fa-solid fa-chevron-left" style={{ fontSize: 10 }} /> Agents
      </button>
      <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.01em', margin: '0 0 6px' }}>
        {editAgent ? 'Edit agent' : 'Add an agent'}
      </h1>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)', margin: '0 0 22px' }}>
        Pick the harness that writes your automations, then choose which model it uses. The agent never executes anything — Autowright does.
      </p>

      {fix === 'needs' && (
        <AmberNotice
          body="This agent is signed out — reconnect it to create or edit automations."
          btn="Reconnect"
          onBtn={reconnect}
          style={{ marginBottom: 22 }}
        />
      )}
      {fix === 'busy' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 22 }}>
          <Spinner size={13} />
          <span style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2)' }}>Reconnecting…</span>
        </div>
      )}

      <Eyebrow style={{ margin: '0 0 10px' }}>NAME</Eyebrow>
      <input
        className="ad-input"
        value={name}
        onChange={(e) => { setName(e.target.value); if (e.target.value.trim()) setNameErr(false) }}
        placeholder="Name this agent"
        style={{
          width: '100%', boxSizing: 'border-box', padding: '11px 14px', fontWeight: 500, fontSize: 13,
          color: 'var(--text)', marginBottom: 16,
          ...(nameErr ? {
            border: '1px solid oklch(0.7 0.19 25 / .65)',
            boxShadow: '0 0 0 3px oklch(0.7 0.19 25 / .1)',
          } : null),
        }}
      />
      {nameErr && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '-10px 0 16px', animation: 'adFadeUp .25s ease both' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: P.red, flex: 'none' }} />
          <span style={{ fontWeight: 500, fontSize: 12, color: 'var(--red-hover)' }}>
            A name is required — give this agent a name before saving.
          </span>
        </div>
      )}

      <Eyebrow style={{ margin: '0 0 10px' }}>DESCRIPTION <span style={{ color: 'var(--text-faintest)' }}>· OPTIONAL</span></Eyebrow>
      <textarea
        className="ad-input"
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder="What this agent is for — shown on the Agents page and given to the drafting agent"
        rows={2}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '11px 14px',
          fontWeight: 400, fontSize: 13, lineHeight: 1.5, color: 'var(--text)',
          resize: 'vertical', marginBottom: 22,
        }}
      />

      <Eyebrow style={{ margin: '0 0 10px' }}>HARNESS</Eyebrow>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        {HARNESSES.map((h) => {
          const on = harness === h.id
          return (
            <div
              key={h.id}
              onClick={() => { setHarness(h.id); setMode('default'); setModel(null) }}
              style={{
                background: on ? 'var(--bg-card-sel)' : 'var(--bg-card)',
                border: `1px solid ${on ? 'var(--accent-sel)' : 'var(--border-card)'}`,
                borderRadius: 12, padding: '16px 18px', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', gap: 7,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                <RadioRing selected={on} />
                <span style={{ fontWeight: 600, fontSize: 14 }}>{h.name}</span>
              </div>
              <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-2)' }}>{h.desc}</p>
            </div>
          )
        })}
      </div>

      {harness && (
        <>
          <Eyebrow style={{ margin: '0 0 10px' }}>MODEL</Eyebrow>
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border-card)',
            borderRadius: 12, overflow: 'hidden', marginBottom: 16,
          }}>
            {([
              { id: 'default' as const, name: 'Default model', note: DEFAULT_NOTE[harness] },
              // §4.7: a user-typed model string — valid with every harness
              { id: 'custom' as const, name: 'A specific model', note: 'Type the model this harness should use' },
              // §4.7: local models run only through OpenCode (Ollama behind it)
              ...(harness === 'opencode'
                ? [{ id: 'ollama' as const, name: 'A local model', note: 'Pick a model served on this Mac through Ollama — best for simple steps' }]
                : []),
            ]).map((md) => {
              const on = mode === md.id
              return (
                <button
                  key={md.id}
                  onClick={() => { setMode(md.id); setModel(null) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 11, padding: '14px 16px',
                    borderBottom: '1px solid var(--hairline-dim)', width: '100%', textAlign: 'left',
                  }}
                >
                  <RadioRing selected={on} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 13, color: on ? 'var(--text)' : 'var(--text-2em)' }}>{md.name}</div>
                    <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--text-muted)', marginTop: 2 }}>{md.note}</div>
                  </div>
                </button>
              )
            })}
          </div>

          {mode === 'custom' && (
            <>
              <Eyebrow style={{ margin: '0 0 10px' }}>MODEL NAME</Eyebrow>
              <input
                className="ad-input"
                value={model ?? ''}
                onChange={(e) => setModel(e.target.value)}
                placeholder={CUSTOM_PLACEHOLDER[harness]}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '11px 14px',
                  font: `500 13px var(--mono)`, color: 'var(--text)', marginBottom: 16,
                }}
              />
            </>
          )}

          {needsOllama && st && !ready && (
            inst === 'installing' ? (
              <div style={{
                background: 'oklch(0.8 0.13 85 / .08)', border: '1px solid oklch(0.8 0.13 85 / .25)',
                borderRadius: 10, padding: '12px 14px', marginBottom: 16, animation: 'adFadeUp .3s ease both',
              }}>
                <div style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2em)', marginBottom: 8 }}>
                  Installing Ollama…{' '}
                  {instPct !== null && (
                    <span style={{ font: `500 12px var(--mono)`, color: 'var(--text-muted)' }}>{Math.round(instPct)}%</span>
                  )}
                </div>
                {instPct !== null ? (
                  <ProgressBar pct={instPct} />
                ) : (
                  <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: '30%', background: 'var(--accent)',
                      animation: 'adBarSlide 1.2s ease-in-out infinite',
                    }} />
                  </div>
                )}
              </div>
            ) : (
              <AmberNotice
                body={inst === 'failed' ? `Install failed — ${instErr ?? 'something went wrong'}` : olMissingMsg}
                btn={inst === 'failed' ? 'Try again' : 'Install Ollama'}
                onBtn={() => installOllama()}
                style={{ marginBottom: 16 }}
              />
            )
          )}
          {needsOllama && ready && (
            <div style={{ marginBottom: 16 }}>
              <GreenCheck label="Ollama is installed and active." />
            </div>
          )}

          {mode === 'ollama' && ready && (
            <>
              <Eyebrow style={{ margin: '0 0 10px' }}>LOCAL MODEL</Eyebrow>
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
                          borderBottom: '1px solid var(--hairline-dim)', cursor: 'pointer',
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

              <Eyebrow style={{ margin: '0 0 10px' }}>DOWNLOAD A MODEL</Eyebrow>
              {!pulling ? (
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <input
                    className="ad-input"
                    value={pullText}
                    onChange={(e) => setPullText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') startPull(pullText) }}
                    placeholder="e.g. qwen3-coder:30b"
                    style={{
                      flex: 1, padding: '11px 14px', font: `500 13px var(--mono)`, color: 'var(--text)',
                    }}
                  />
                  <BtnPrimary onClick={() => startPull(pullText)} style={{ flex: 'none' }}>
                    Download
                  </BtnPrimary>
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
                  <Eyebrow style={{ margin: '0 0 8px' }}>SUGGESTED</Eyebrow>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                    {sugRows.map((sg) => (
                      <button
                        key={sg.id}
                        title={sg.note}
                        className="ad-chip-btn"
                        onClick={() => setPullText(sg.id)}
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
                className="ad-chip-btn"
                style={{ textDecoration: 'none', marginBottom: 22 }}
              >
                Browse more models on Ollama <span style={{ fontWeight: 400, fontSize: 11 }}>↗</span>
              </a>
            </>
          )}
        </>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <BtnPrimary onClick={() => { void addAgent() }} disabled={!canAdd}>
          {editAgent ? 'Save changes' : 'Add agent'}
        </BtnPrimary>
        <button
          className="ad-btn-text dim"
          onClick={() => go('agents')}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
