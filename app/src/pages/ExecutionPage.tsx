// Execution page (§7): compact STEPS sidebar, Results/Logs tabs,
// live log streaming with auto-scroll, Cancel / Execute again.
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { Badge, badgeOf, FailureNotice, paramSummary, Spinner } from '../ui'
import { ResultSection } from '../result'
import type { Exec } from '../types'

type LogLine = NonNullable<Exec['logs']>[number]

const eyebrow: React.CSSProperties = {
  fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
  letterSpacing: '.09em', color: 'var(--text-faint)',
}

function logColor(k: LogLine['k']): string {
  if (k === 'sys') return 'var(--text-faint)'
  if (k === 'wrn') return 'var(--amber)'
  if (k === 'err') return 'var(--red)'
  return 'var(--text-2em)'
}

function BackLink({ onClick }: { onClick: () => void }) {
  const [hov, setHov] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        color: hov ? 'var(--text)' : 'var(--text-muted)', fontSize: 12.5,
        fontWeight: 500, padding: '4px 0', cursor: 'pointer',
      }}
    >
      <i className="fa-solid fa-chevron-left" style={{ fontSize: 10 }} /> Executions
    </button>
  )
}

/** Compact step row (§7): status dot + name + duration — no inline log expansion. */
function StepRow({ step }: { step: Exec['steps'][number] }) {
  const executing = step.status === 'executing'
  const dot = step.status === 'queued' ? '#3a414c' : badgeOf(step.status).c
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px' }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%', background: dot, flex: 'none',
        animation: executing ? 'adPulse 1.2s ease-in-out infinite' : 'none',
      }} />
      <span style={{
        flex: 1, fontSize: 12.5, lineHeight: 1.4, minWidth: 0,
        color: step.status === 'queued' ? 'var(--text-faint)' : 'var(--text-2em)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {step.name}
      </span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)', flex: 'none' }}>{step.dur}</span>
    </div>
  )
}

export default function ExecutionPage() {
  const { execId, execs, execFull, autos, go, showToast, loadExec } = useStore()
  const full = execId ? execFull[execId] : undefined
  const e = full ?? (execId ? execs.find((x) => x.id === execId) : undefined)
  const auto = e ? autos.find((a) => a.id === e.autoId) : undefined

  const [tab, setTab] = useState<'results' | 'logs'>('results')
  const [hovTitle, setHovTitle] = useState(false)
  const [hovAgain, setHovAgain] = useState(false)
  const tabInit = useRef(false)
  const logRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  // Mount / execId change: guard, reset, (re)fetch the full record.
  useEffect(() => {
    if (!execId) { go('executions'); return }
    tabInit.current = false
    stickRef.current = true
    setTab('results')
    void loadExec(execId)
  }, [execId])

  // Auto-select Logs when there is no result yet (needs the full record to know).
  useEffect(() => {
    if (!full || tabInit.current) return
    setTab(full.result ? 'results' : 'logs')
    tabInit.current = true
  }, [full])

  const logs = full?.logs ?? []
  const executing = e?.status === 'executing'

  // Live auto-scroll — only while executing and only if the user hasn't scrolled up.
  useEffect(() => {
    const el = logRef.current
    if (el && executing && stickRef.current) el.scrollTop = el.scrollHeight
  }, [logs.length, executing, tab])

  if (!execId) return null

  const shell = (body: React.ReactNode) => (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 30px 70px', animation: 'adFadeUp .4s ease' }}>
      <style>{'@keyframes adBlink{0%,100%{opacity:1}50%{opacity:0}}'}</style>
      <BackLink onClick={() => go('executions')} />
      {body}
    </div>
  )

  if (!e) {
    return shell(
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner /></div>,
    )
  }

  const cancelExecution = () => {
    void api.cancelExec(e.id).catch((err: Error) => showToast(err.message))
  }
  const runAgain = () => {
    void (async () => {
      try {
        const r = e.status === 'failed' ? await api.reexecuteExec(e.id) : await api.executeNow(e.autoId)
        go('execution', { execId: r.execId })
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }

  const canOpenAuto = !e.autoDeleted && !!auto
  const runAgainPrimary = e.status === 'failed' && !e.autoDeleted
  const runAgainQuiet = ['succeeded', 'cancelled', 'interrupted', 'skipped'].includes(e.status) && !e.autoDeleted
  // §7: values as used by this execution — snapshotted on the record; older records fall back
  // to the automation's current params.
  const params = (full?.params?.length ? full.params : auto?.params) ?? []
  const result = full?.result ?? null

  const noResultWhy = e.status === 'executing'
    ? 'The execution is still going — the result appears when it finishes.'
    : e.status === 'failed'
      ? 'The execution failed before a result was built. The logs show what happened.'
      : e.status === 'cancelled'
        ? (e.steps.length === 0 && e.note
          ? `The execution was cancelled before it started — ${e.note}.`
          : 'The execution was cancelled before a result was built.')
        : 'This execution didn’t produce a result.'

  const redactNote = (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)',
      fontSize: 10.5, fontWeight: 500, color: 'var(--text-muted)',
      background: 'rgba(255,255,255,.05)', borderRadius: 5, padding: '2px 8px',
    }}>
      <i className="fa-solid fa-key" style={{ fontSize: 8.5 }} />
      secrets redacted: {e.redact}
    </span>
  )

  return shell(
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '12px 0 4px', flexWrap: 'wrap' }}>
        <h1
          onClick={() => { if (canOpenAuto) go('automation', { autoId: e.autoId }) }}
          onMouseEnter={() => setHovTitle(true)}
          onMouseLeave={() => setHovTitle(false)}
          title={canOpenAuto ? 'Open automation' : undefined}
          style={{
            fontSize: 20, fontWeight: 600, letterSpacing: '-.01em', margin: 0,
            cursor: canOpenAuto ? 'pointer' : 'default',
            color: canOpenAuto && hovTitle ? 'var(--accent)' : 'var(--text)',
          }}
        >
          {e.autoName}
        </h1>
        {e.autoDeleted && (
          <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>(deleted)</span>
        )}
        <Badge
          status={e.status}
          style={executing ? { animation: 'adPulse 1.4s ease-in-out infinite' } : undefined}
        />
        <div style={{ flex: 1 }} />
        {executing && (
          <button
            onClick={cancelExecution}
            style={{
              background: 'oklch(0.7 0.19 25 / .14)', border: '1px solid oklch(0.7 0.19 25 / .4)',
              borderRadius: 8, color: 'oklch(0.78 0.15 25)', fontWeight: 600, fontSize: 12.5,
              padding: '8px 14px', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        )}
        {runAgainPrimary && (
          <button
            onClick={runAgain}
            onMouseEnter={() => setHovAgain(true)}
            onMouseLeave={() => setHovAgain(false)}
            title="Executes the automation again. Steps that already succeeded are reused automatically."
            style={{
              background: hovAgain ? 'var(--accent-hover)' : 'var(--accent)', color: 'var(--on-accent)',
              borderRadius: 8, padding: '8px 14px', fontWeight: 600, fontSize: 12.5, cursor: 'pointer',
            }}
          >
            Execute again
          </button>
        )}
        {runAgainQuiet && (
          <button
            onClick={runAgain}
            onMouseEnter={() => setHovAgain(true)}
            onMouseLeave={() => setHovAgain(false)}
            title="Executes the automation again from the start"
            style={{
              background: 'rgba(255,255,255,.05)', color: 'var(--text-2em)',
              border: `1px solid ${hovAgain ? 'var(--border-hover)' : 'var(--border-btn)'}`,
              borderRadius: 8, padding: '8px 14px', fontWeight: 500, fontSize: 12.5, cursor: 'pointer',
            }}
          >
            Execute again
          </button>
        )}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 18 }}>
        <span className="ad-copy">{e.id}</span>
        {` · ${e.trigger}`}{e.ver ? ` · ${e.ver}` : ''} · started {e.started} · {e.dur}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: 16, alignItems: 'start' }}>
        {/* Left column: step timeline (+ parameters) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, padding: '14px 0' }}>
            <div style={{ ...eyebrow, padding: '0 16px', marginBottom: 10 }}>STEPS</div>
            {e.steps.length === 0 && (
              <div style={{ padding: '2px 16px 6px', fontSize: 12, lineHeight: 1.5, color: 'var(--text-faint)' }}>
                {e.note ? `Nothing ran — ${e.note}.` : 'Nothing ran.'}
              </div>
            )}
            {e.steps.map((s, i) => (
              <StepRow key={i} step={s} />
            ))}
          </div>
          {params.length > 0 && (
            <div className="ad-copy" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, padding: '13px 16px' }}>
              <div style={{ ...eyebrow, marginBottom: 4 }}>PARAMETERS</div>
              {params.map((p) => (
                <div key={p.name} style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '7px 0', borderTop: '1px solid rgba(255,255,255,.05)' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{p.label}</span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-2em)' }}>{paramSummary(p)}</span>
                </div>
              ))}
              <div style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-faintest)', paddingTop: 8, borderTop: '1px solid rgba(255,255,255,.05)' }}>
                Values as used by this execution.
              </div>
            </div>
          )}
        </div>

        {/* Right column: Results / Logs */}
        <div style={{ minWidth: 0 }}>
          {e.status === 'failed' && e.error && (
            <FailureNotice error={e.error} style={{ marginBottom: 12 }} />
          )}
          <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
            {(['results', 'logs'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  borderRadius: 7, padding: '7px 14px', fontWeight: 600, fontSize: 12.5, cursor: 'pointer',
                  background: tab === t ? 'rgba(255,255,255,.08)' : 'transparent',
                  color: tab === t ? 'var(--text)' : 'var(--text-faint)',
                }}
              >
                {t === 'results' ? 'Results' : 'Logs'}
              </button>
            ))}
          </div>

          {tab === 'results' && (
            !full ? (
              <div style={{
                background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12,
                padding: 26, display: 'flex', justifyContent: 'center',
              }}>
                <Spinner />
              </div>
            ) : result ? (
              <ResultSection label="RESULT" result={result} execId={e.id} measure={620} />
            ) : (
              <div style={{
                background: 'var(--bg-card)', border: '1px dashed rgba(255,255,255,.12)',
                borderRadius: 12, padding: 26, textAlign: 'center',
              }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 4 }}>No result</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{noResultWhy}</div>
              </div>
            )
          )}

          {tab === 'logs' && (
            <div style={{ background: '#07090d', border: '1px solid rgba(255,255,255,.06)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,.05)',
              }}>
                <span style={eyebrow}>{executing ? 'LIVE LOG' : 'LOG'}</span>
                {e.redact && redactNote}
              </div>
              <div
                className="ad-copy"
                ref={logRef}
                onScroll={() => {
                  const el = logRef.current
                  if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
                }}
                style={{ maxHeight: 420, overflowY: 'auto', padding: '13px 16px', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.85 }}
              >
                {!full ? (
                  <Spinner size={14} />
                ) : (
                  <>
                    {logs.map((l, i) => (
                      <div key={i} style={{ display: 'flex', gap: 12 }}>
                        <span style={{ color: '#3d434d', flex: 'none' }}>{l.t}</span>
                        <span style={{
                          color: logColor(l.k), whiteSpace: 'pre-wrap', minWidth: 0,
                          fontStyle: l.k === 'sys' ? 'italic' : 'normal',
                        }}>
                          {l.text}
                        </span>
                      </div>
                    ))}
                    {logs.length === 0 && (
                      <div style={{ color: 'var(--text-faintest)' }}>No logs — this execution never started.</div>
                    )}
                    {executing && (
                      <span style={{
                        display: 'inline-block', width: 7, height: 13, background: 'var(--cyan)',
                        animation: 'adBlink 1s step-end infinite', verticalAlign: 'middle', marginLeft: 2,
                      }} />
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>,
  )
}
