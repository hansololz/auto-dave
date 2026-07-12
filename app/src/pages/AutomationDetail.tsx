// Automation detail (§4.3/§4.4/§7, prototype "Automation detail" screen).
import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Auto, ParamDef, Step } from '../types'
import {
  Badge, BtnPrimary, ConfirmModal, Eyebrow, ResultBody, Toggle,
  nextIn, paramSummary, resultChipColors, usePopover, validUrl,
} from '../ui'

const RUNNING_TOAST = 'Already running — one run at a time. A schedule firing now would be skipped.'
const badgeAnim = (s: string) => (s === 'running' ? 'adPulse 1.4s ease-in-out infinite' : 'none')

// ---------- small hover helpers (local — pages may not edit ui.tsx) ----------

function HoverBtn({ children, onClick, title, style, hoverStyle, disabled }: {
  children: React.ReactNode; onClick?: (e: React.MouseEvent) => void; title?: string
  style: React.CSSProperties; hoverStyle?: React.CSSProperties; disabled?: boolean
}) {
  const [hov, setHov] = useState(false)
  return (
    <button
      onClick={onClick} title={title} disabled={disabled}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ ...style, ...(hov && !disabled ? hoverStyle : undefined) }}
    >
      {children}
    </button>
  )
}

function HoverRow({ children, onClick, style, hoverBg = 'rgba(255,255,255,.02)' }: {
  children: React.ReactNode; onClick?: () => void; style: React.CSSProperties; hoverBg?: string
}) {
  const [hov, setHov] = useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ ...style, background: hov ? hoverBg : (style.background as string) ?? 'transparent' }}
    >
      {children}
    </div>
  )
}

// ---------- parameters (§4.2 inline editing) ----------

const inputBase: React.CSSProperties = {
  background: 'var(--bg-inset)', borderRadius: 8, color: 'var(--text)', outline: 'none',
}

function ParamRow({ autoId, p, last }: { autoId: string; p: ParamDef; last: boolean }) {
  const showToast = useStore((s) => s.showToast)
  const loadAuto = useStore((s) => s.loadAuto)
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [rows, setRows] = useState<{ k: string; v: string }[]>([])
  const [text, setText] = useState<string | null>(null)
  const [num, setNum] = useState<string | null>(null)
  const [foc, setFoc] = useState(false)

  const commit = (value: unknown) => {
    void (async () => {
      try {
        await api.patchAuto(autoId, { paramValues: { [p.name]: value } })
        void loadAuto(autoId)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }

  const openEditor = () => {
    if (p.kind === 'list') setLines([...(p.lines ?? [])])
    if (p.kind === 'kv') setRows((p.rows ?? []).map((r) => ({ ...r })))
    setOpen(true)
  }
  const closeEditor = () => {
    setOpen(false)
    if (p.kind === 'list' && JSON.stringify(lines) !== JSON.stringify(p.lines ?? [])) commit(lines)
    if (p.kind === 'kv' && JSON.stringify(rows) !== JSON.stringify(p.rows ?? [])) commit(rows)
  }

  const expandToggle = (
    <HoverBtn
      onClick={open ? closeEditor : openEditor}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'none', padding: 0, alignSelf: 'flex-end' }}
      hoverStyle={{}}
    >
      {!open && <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-2)' }}>{paramSummary(p)}</span>}
      <span style={{ color: '#4a515c', fontSize: 11, fontWeight: 400 }}>
        <i className={open ? 'fa-solid fa-caret-up' : 'fa-solid fa-caret-down'} style={{ fontSize: 9 }} /> {open ? 'done' : 'edit'}
      </span>
    </HoverBtn>
  )

  let good = 0
  let bad = 0
  if (p.kind === 'list' && p.validate) {
    good = lines.filter((l) => l.trim() && validUrl(l)).length
    bad = lines.filter((l) => l.trim() && !validUrl(l)).length
  }

  return (
    <div style={{
      padding: '14px 18px', borderBottom: last ? 'none' : '1px solid rgba(255,255,255,.05)',
      display: 'flex', gap: 18, alignItems: 'flex-start',
    }}>
      <div style={{ width: 215, flex: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{p.label}</span>
          {p.kind === 'text' && !p.value && (
            <span style={{
              display: 'inline-flex', padding: '2px 7px', borderRadius: 5,
              fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 9.5, letterSpacing: '.06em',
              background: 'oklch(0.8 0.13 85 / .14)', color: 'var(--amber)',
            }}>
              NOT SET
            </span>
          )}
        </div>
        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', marginTop: 3 }}>{p.help}</div>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'flex-end' }}>
        {p.kind === 'toggle' && <Toggle on={!!p.on} onChange={() => commit(!p.on)} />}
        {p.kind === 'number' && (
          <input
            value={num ?? String(p.value ?? '')}
            inputMode="numeric"
            onChange={(e) => setNum(e.target.value.replace(/[^0-9]/g, ''))}
            onFocus={() => setFoc(true)}
            onBlur={() => {
              setFoc(false)
              if (num === null) return
              const min = p.min ?? 0
              let v = num === '' ? min : parseInt(num, 10)
              if (v < min) v = min
              setNum(null)
              if (v !== p.value) commit(v)
            }}
            style={{
              ...inputBase, width: 70,
              border: `1px solid ${foc ? 'oklch(0.74 0.155 52 / .6)' : 'rgba(255,255,255,.1)'}`,
              fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 13, textAlign: 'center', padding: '6px 10px',
            }}
          />
        )}
        {p.kind === 'text' && (
          <input
            value={text ?? String(p.value ?? '')}
            placeholder={p.placeholder ?? ''}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setFoc(true)}
            onBlur={() => {
              setFoc(false)
              if (text === null) return
              setText(null)
              if (text !== String(p.value ?? '')) commit(text)
            }}
            style={{
              ...inputBase, width: '100%', maxWidth: 340,
              border: `1px solid ${foc ? 'oklch(0.74 0.155 52 / .6)' : 'rgba(255,255,255,.09)'}`,
              fontSize: 12.5, padding: '8px 12px',
            }}
          />
        )}
        {p.kind === 'list' && (
          <div style={{ width: open ? '100%' : 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {expandToggle}
            {open && lines.map((l, j) => {
              const inv = !!p.validate && !!l.trim() && !validUrl(l)
              return (
                <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    value={l}
                    onChange={(e) => setLines(lines.map((x, i) => (i === j ? e.target.value : x)))}
                    style={{
                      ...inputBase, flex: 1, minWidth: 0, borderRadius: 7,
                      border: `1px solid ${inv ? 'oklch(0.7 0.19 25 / .45)' : 'rgba(255,255,255,.09)'}`,
                      color: inv ? 'oklch(0.74 0.17 25)' : 'var(--text)',
                      fontFamily: 'var(--mono)', fontSize: 12, padding: '7px 10px',
                    }}
                  />
                  {inv && (
                    <span style={{
                      display: 'inline-flex', padding: '2px 7px', borderRadius: 5,
                      fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 9.5, letterSpacing: '.06em',
                      background: 'oklch(0.7 0.19 25 / .14)', color: 'oklch(0.74 0.17 25)', flex: 'none',
                    }}>
                      NOT A VALID LINK
                    </span>
                  )}
                  <HoverBtn
                    onClick={() => setLines(lines.filter((_, i) => i !== j))}
                    style={{ background: 'none', border: 'none', color: '#4a515c', width: 24, flex: 'none' }}
                    hoverStyle={{ color: 'oklch(0.74 0.17 25)' }}
                  >
                    <i className="fa-solid fa-xmark" style={{ fontSize: 12 }} />
                  </HoverBtn>
                </div>
              )
            })}
            {open && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <HoverBtn
                  onClick={() => setLines([...lines, ''])}
                  style={{
                    background: 'none', border: '1px dashed rgba(255,255,255,.14)', borderRadius: 7,
                    color: 'var(--text-muted)', fontWeight: 500, fontSize: 11.5, padding: '5px 11px',
                  }}
                  hoverStyle={{ color: 'var(--text)' }}
                >
                  + Add line
                </HoverBtn>
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11, color: 'var(--text-faint)' }}>
                  {lines.length}{p.validate ? ` lines · ${good} valid links${bad ? ` · ${bad} needs attention` : ''}` : ' entries'}
                </span>
              </div>
            )}
          </div>
        )}
        {p.kind === 'kv' && (
          <div style={{ width: open ? '100%' : 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {expandToggle}
            {open && rows.map((r, j) => (
              <div key={j} style={{ display: 'flex', gap: 6 }}>
                <input
                  value={r.k}
                  onChange={(e) => setRows(rows.map((x, i) => (i === j ? { ...x, k: e.target.value } : x)))}
                  style={{
                    ...inputBase, flex: 1.3, minWidth: 0, borderRadius: 7,
                    border: '1px solid rgba(255,255,255,.09)', color: 'var(--text-2)',
                    fontFamily: 'var(--mono)', fontSize: 11.5, padding: '7px 10px',
                  }}
                />
                <input
                  value={r.v}
                  onChange={(e) => setRows(rows.map((x, i) => (i === j ? { ...x, v: e.target.value } : x)))}
                  style={{
                    ...inputBase, flex: 1, minWidth: 0, borderRadius: 7,
                    border: '1px solid rgba(255,255,255,.09)', fontSize: 12, padding: '7px 10px',
                  }}
                />
                <HoverBtn
                  onClick={() => setRows(rows.filter((_, i) => i !== j))}
                  style={{ background: 'none', border: 'none', color: '#4a515c', width: 24 }}
                  hoverStyle={{ color: 'oklch(0.74 0.17 25)' }}
                >
                  <i className="fa-solid fa-xmark" style={{ fontSize: 12 }} />
                </HoverBtn>
              </div>
            ))}
            {open && (
              <HoverBtn
                onClick={() => setRows([...rows, { k: '', v: '' }])}
                style={{
                  alignSelf: 'flex-start', background: 'none', border: '1px dashed rgba(255,255,255,.14)',
                  borderRadius: 7, color: 'var(--text-muted)', fontWeight: 500, fontSize: 11.5, padding: '5px 11px',
                }}
                hoverStyle={{ color: 'var(--text)' }}
              >
                + Add row
              </HoverBtn>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- steps ----------

function StepRow({ s, n, open, onToggle, last }: {
  s: Step; n: number; open: boolean; onToggle: () => void; last: boolean
}) {
  return (
    <div style={{ borderBottom: last ? 'none' : '1px solid rgba(255,255,255,.05)' }}>
      <HoverRow onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '12px 18px', cursor: 'pointer' }}>
        <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11, color: 'var(--text-faint)', width: 14, flex: 'none' }}>{n}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</span>
            {s.agent && (
              <span
                title={s.why ?? undefined}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  background: 'oklch(0.74 0.155 52 / .1)', border: '1px solid oklch(0.74 0.155 52 / .3)',
                  borderRadius: 6, padding: '2px 8px', fontFamily: 'var(--mono)', fontWeight: 600,
                  fontSize: 10, color: 'var(--accent)', whiteSpace: 'nowrap',
                }}
              >
                <i className="fa-solid fa-robot" style={{ fontSize: 8.5 }} /> Agent step
              </span>
            )}
          </div>
          <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-muted)', marginTop: 1 }}>{s.desc}</div>
        </div>
        <span style={{ color: '#4a515c', fontSize: 11, whiteSpace: 'nowrap' }}>
          <i className={open ? 'fa-solid fa-caret-up' : 'fa-solid fa-caret-down'} style={{ fontSize: 9 }} /> {open ? 'hide script' : 'view script'}
        </span>
      </HoverRow>
      {open && (
        <>
          {s.agent && s.why && (
            <div style={{
              display: 'flex', gap: 9, alignItems: 'flex-start', borderTop: '1px solid rgba(255,255,255,.05)',
              background: 'oklch(0.74 0.155 52 / .05)', padding: '10px 18px 10px 45px', animation: 'adFadeUp .22s ease both',
            }}>
              <i className="fa-solid fa-robot" style={{ color: 'oklch(0.78 0.13 52)', fontSize: 10, marginTop: 3 }} />
              <span style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-muted)' }}>
                <span style={{ fontWeight: 500, color: 'var(--text-2em)' }}>Why an agent: </span>{s.why}
              </span>
            </div>
          )}
          <pre style={{
            margin: 0, background: '#07090d', borderTop: '1px solid rgba(255,255,255,.05)',
            padding: '14px 18px 14px 45px', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.75,
            color: '#9fb3c8', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', minWidth: 0,
            animation: 'adFadeUp .22s ease both',
          }}>
            {s.code}
          </pre>
        </>
      )}
    </div>
  )
}

// ---------- page ----------

export default function AutomationDetail() {
  const { autoId, autos, execs, go, setSurface, showToast, loadAuto } = useStore()
  const auto: Auto | undefined = autos.find((a) => a.id === autoId)

  const [verOpen, setVerOpen, verRef] = usePopover()
  const [actOpen, setActOpen, actRef] = usePopover()
  const [delAsk, setDelAsk] = useState(false)
  const [stepOpen, setStepOpen] = useState<number | null>(null)
  const [specOpen, setSpecOpen] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [, setTick] = useState(0)

  // Full record (params/steps/latest) only comes from the full fetch.
  useEffect(() => { if (autoId) { void loadAuto(autoId); setConfirmClear(false) } }, [autoId])
  // §4.3: refresh the countdown every 30 s.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000)
    return () => clearInterval(t)
  }, [])
  // autoId may point at a deleted automation.
  useEffect(() => { if (!auto) go('automations') }, [auto, go])

  if (!auto) return null

  const running = !!auto.live
  const schedOff = !!auto.schedOff
  const countdown = nextIn(auto)
  const schedChip = running ? `${auto.schedule} · running now`
    : schedOff ? `${auto.schedule} · schedule off`
    : `${auto.schedule} · next in ${countdown}`
  const schedStatusText = running ? 'Running now… the schedule is unchanged.'
    : schedOff ? 'Off — won’t run on its own. Run now and the menu bar still work.'
    : `Next run in ${countdown} · runs even when the app is closed.`
  const schedChipOn = running || !schedOff
  const runLabel = running ? 'Running…' : 'Run now'
  const runIconCls = running ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-play'

  const doRun = (ver?: string, toastMsg?: string) => {
    if (auto.live) { showToast(RUNNING_TOAST); return }
    void (async () => {
      try {
        await api.runNow(auto.id, ver)
        if (toastMsg) showToast(toastMsg)
      } catch (err) {
        const er = err as Error & { status?: number }
        showToast(er.status === 409 ? RUNNING_TOAST : er.message)
      }
    })()
  }

  const toggleSchedule = () => {
    const willOff = !auto.schedOff
    void (async () => {
      try {
        await api.patchAuto(auto.id, { schedOff: willOff })
        showToast(willOff
          ? `Schedule turned off — ${auto.name} won’t run on its own. Run now still works.`
          : `Schedule turned on — next run in ${nextIn(auto)}.`)
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }

  const confirmDelete = () => {
    setDelAsk(false)
    const nm = auto.name
    void (async () => {
      try {
        await api.deleteAuto(auto.id)
        go('automations')
        showToast(`“${nm}” deleted — its past results stay in Executions.`)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }

  const revealMemory = () => {
    const p = auto.memory?.path
    if (p) void window.autodave?.revealPath(p)
    showToast(`Revealed in Finder — Auto Dave › Memory › ${auto.name}`)
  }

  const doClearMemory = () => {
    setConfirmClear(false)
    void (async () => {
      try {
        await api.clearMemory(auto.id)
        showToast('Memory cleared — the next run starts fresh.')
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }

  const discardDraft = () => {
    void (async () => {
      try {
        await api.deleteDraft(auto.id)
        showToast(`Draft discarded — v${auto.version} is unchanged.`)
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }

  const lr = auto.latest
  const params = auto.params ?? []
  const steps = auto.steps ?? []
  const spec = auto.spec ?? []
  const olderVersions = (auto.versions ?? []).filter((v) => v.v !== auto.version)
  const runs = execs.filter((e) => e.autoId === auto.id).slice(0, 6)

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 30px 70px', animation: 'adFadeUp .4s ease' }}>
      <HoverBtn
        onClick={() => go('automations')}
        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontWeight: 500, fontSize: 12.5, padding: '4px 0' }}
        hoverStyle={{ color: 'var(--text)' }}
      >
        <i className="fa-solid fa-chevron-left" style={{ fontSize: 10 }} /> Automations
      </HoverBtn>

      {/* title row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 13, margin: '14px 0 6px' }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.01em', margin: 0 }}>{auto.name}</h1>
        <div ref={verRef} style={{ position: 'relative' }}>
          <HoverBtn
            onClick={() => setVerOpen(!verOpen)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontWeight: 600,
              fontSize: 10.5, color: 'var(--text-muted)', background: 'rgba(255,255,255,.06)',
              border: 'none', borderRadius: 6, padding: '3px 7px',
            }}
            hoverStyle={{ color: 'var(--text-2em)' }}
          >
            <span>v{auto.version}</span>
            <i className="fa-solid fa-caret-down" style={{ color: 'var(--text-faint)', fontSize: 9 }} />
          </HoverBtn>
          {verOpen && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth: 360,
              background: 'var(--bg-menu)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 10,
              boxShadow: '0 18px 44px rgba(0,0,0,.5)', zIndex: 50, overflow: 'hidden',
              animation: 'adFadeUp .18s ease both',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                borderBottom: '1px solid rgba(255,255,255,.04)', background: 'rgba(255,255,255,.03)',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 12.5, color: 'var(--text)' }}>
                    v{auto.version} · current
                  </div>
                  <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-muted)', marginTop: 1 }}>
                    What the schedule and Run now always use.
                  </div>
                </div>
              </div>
              {olderVersions.map((v) => (
                <div key={v.v} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                  borderBottom: '1px solid rgba(255,255,255,.04)',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 12.5, color: 'var(--text-2em)' }}>v{v.v}</div>
                    <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-muted)', marginTop: 1 }}>
                      {(v.note ? `${v.note} — ` : '') + v.when}
                    </div>
                  </div>
                  <HoverBtn
                    onClick={() => {
                      setVerOpen(false)
                      doRun(`v${v.v}`, `Running v${v.v} once — the schedule and Run now stay on v${auto.version}.`)
                    }}
                    style={{
                      background: 'oklch(0.74 0.155 52 / .1)', border: '1px solid oklch(0.74 0.155 52 / .3)',
                      borderRadius: 7, color: 'var(--accent)', fontFamily: 'var(--mono)', fontWeight: 500,
                      fontSize: 11.5, padding: '5px 10px', flex: 'none',
                    }}
                    hoverStyle={{ background: 'oklch(0.74 0.155 52 / .2)' }}
                  >
                    <i className="fa-solid fa-play" style={{ fontSize: 9 }} /> Run once
                  </HoverBtn>
                </div>
              ))}
              <div style={{
                padding: '10px 14px', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-faint)',
                background: 'var(--bg-card)',
              }}>
                Running an older version once doesn’t change anything — the schedule and{' '}
                <i className="fa-solid fa-play" style={{ fontSize: 9 }} /> Run now always use the current version.
                To make an older version current, open Edit and restore it from the Version menu.
              </div>
            </div>
          )}
        </div>
        <Badge status={auto.lastStatus} style={{ padding: '3px 8px', letterSpacing: '.05em', animation: badgeAnim(auto.lastStatus) }} />
        <div style={{ flex: 1 }} />
        <BtnPrimary onClick={() => doRun()} style={{ flex: 'none' }}>
          <i className={runIconCls} style={{ fontSize: 10 }} /> {runLabel}
        </BtnPrimary>
        <HoverBtn
          onClick={() => setSurface('create', 'edit')}
          style={{
            background: 'rgba(255,255,255,.05)', color: 'var(--text-2em)',
            border: '1px solid var(--border-btn)', borderRadius: 8, padding: '9px 14px',
            fontWeight: 500, fontSize: 13, flex: 'none',
          }}
          hoverStyle={{ border: '1px solid var(--border-hover)' }}
        >
          Edit
        </HoverBtn>
        <div ref={actRef} style={{ position: 'relative', flex: 'none' }}>
          <HoverBtn
            onClick={() => setActOpen(!actOpen)}
            title="More actions"
            style={{
              background: 'rgba(255,255,255,.05)', color: 'var(--text-2em)',
              border: '1px solid var(--border-btn)', borderRadius: 8, padding: '9px 11px',
              fontWeight: 500, fontSize: 13,
            }}
            hoverStyle={{ border: '1px solid var(--border-hover)' }}
          >
            <i className="fa-solid fa-ellipsis" style={{ fontSize: 12 }} />
          </HoverBtn>
          {actOpen && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', right: 0, minWidth: 210,
              background: 'var(--bg-menu)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 10,
              boxShadow: '0 18px 44px rgba(0,0,0,.5)', zIndex: 50, padding: 5,
              animation: 'adFadeUp .18s ease both',
            }}>
              <HoverBtn
                onClick={() => { setActOpen(false); setDelAsk(true) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, width: '100%', background: 'none',
                  border: 'none', borderRadius: 7, padding: '8px 10px', fontWeight: 500, fontSize: 12.5,
                  color: 'oklch(0.78 0.15 25)', textAlign: 'left',
                }}
                hoverStyle={{ background: 'oklch(0.7 0.19 25 / .1)' }}
              >
                <i className="fa-solid fa-trash-can" style={{ fontSize: 11, width: 14, textAlign: 'center' }} />
                Delete automation…
              </HoverBtn>
            </div>
          )}
        </div>
      </div>

      {/* §4.3 schedule status line */}
      <div style={{ margin: '0 0 24px' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontWeight: 500,
          fontSize: 11.5, color: schedChipOn ? 'var(--accent)' : 'var(--gray)',
          background: schedChipOn ? 'oklch(0.74 0.155 52 / .1)' : 'rgba(152,161,173,.12)',
          borderRadius: 6, padding: '3px 9px', transition: 'color .18s ease,background .18s ease',
        }}>
          <i
            className={running ? 'fa-solid fa-spinner fa-spin' : schedOff ? 'fa-solid fa-pause' : 'fa-solid fa-clock'}
            style={{ fontSize: 9 }}
          />
          {schedChip}
        </span>
      </div>

      {/* §4.4 draft banner */}
      {auto.draft && (
        <div style={{
          margin: '0 0 24px', background: 'var(--bg-card)', border: '1px dashed oklch(0.74 0.155 52 / .45)',
          borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12,
          animation: 'adFadeUp .3s ease both',
        }}>
          <span style={{
            display: 'inline-flex', padding: '3px 8px', borderRadius: 6, fontFamily: 'var(--mono)',
            fontWeight: 600, fontSize: 10.5, letterSpacing: '.05em', textTransform: 'uppercase',
            background: 'oklch(0.74 0.155 52 / .13)', color: 'var(--accent)', flex: 'none',
          }}>
            Draft
          </span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-2em)' }}>
            Unsaved edit based on v{auto.version} — kept from your last edit session. Run it like any other version, or resume editing.
          </span>
          <HoverBtn
            onClick={() => doRun('Draft')}
            style={{
              background: 'oklch(0.74 0.155 52 / .1)', border: '1px solid oklch(0.74 0.155 52 / .3)',
              borderRadius: 7, color: 'var(--accent)', fontFamily: 'var(--mono)', fontWeight: 500,
              fontSize: 12, padding: '6px 11px', flex: 'none',
            }}
            hoverStyle={{ background: 'oklch(0.74 0.155 52 / .2)' }}
          >
            <i className="fa-solid fa-play" style={{ fontSize: 9 }} /> Run draft
          </HoverBtn>
          <HoverBtn
            onClick={() => setSurface('create', 'edit')}
            style={{
              background: 'rgba(255,255,255,.05)', border: '1px solid var(--border-btn)', borderRadius: 7,
              color: 'var(--text-2em)', fontWeight: 500, fontSize: 12, padding: '6px 12px', flex: 'none',
            }}
            hoverStyle={{ border: '1px solid var(--border-hover)' }}
          >
            Resume editing
          </HoverBtn>
          <HoverBtn
            onClick={discardDraft}
            style={{ background: 'none', border: 'none', color: 'var(--text-faint)', fontWeight: 500, fontSize: 12, flex: 'none' }}
            hoverStyle={{ color: 'var(--text-2)' }}
          >
            Discard
          </HoverBtn>
        </div>
      )}

      {/* latest result */}
      {lr ? (
        <div style={{ marginBottom: 26 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
            <Eyebrow style={{ color: 'var(--text-faint)' }}>LATEST RESULT</Eyebrow>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-faintest)' }}>{lr.when}</span>
          </div>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '15px 18px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {lr.chip && (
                <span style={{
                  display: 'inline-flex', padding: '4px 11px', borderRadius: 7, fontFamily: 'var(--mono)',
                  fontWeight: 600, fontSize: 12, letterSpacing: '.03em',
                  background: resultChipColors(lr).bg, color: resultChipColors(lr).c,
                }}>
                  {lr.chip}
                </span>
              )}
              {(lr.chips ?? []).filter((t) => t !== lr.chip).map((t) => (
                <span key={t} style={{
                  display: 'inline-flex', padding: '4px 10px', borderRadius: 7, fontFamily: 'var(--mono)',
                  fontWeight: 500, fontSize: 11.5, background: 'rgba(255,255,255,.05)',
                  border: '1px solid var(--border-card)', color: 'var(--text-2em)',
                }}>
                  {t}
                </span>
              ))}
            </div>
            {(lr.body || lr.para || (lr.rows && lr.rows.length > 0)) && (
              <div style={{ padding: '0 18px 16px' }}>
                <ResultBody result={lr} />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div style={{
          marginBottom: 26, background: 'var(--bg-card)', border: '1px dashed rgba(255,255,255,.12)',
          borderRadius: 12, padding: 22, textAlign: 'center',
        }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 4 }}>No runs yet</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Press Run now — the first result will appear right here.</div>
        </div>
      )}

      {/* ways to run */}
      <div style={{ marginBottom: 26 }}>
        <Eyebrow style={{ color: 'var(--text-faint)', marginBottom: 10 }}>WAYS TO RUN</Eyebrow>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,.05)', display: 'flex', gap: 15, alignItems: 'center' }}>
            <span style={{
              width: 32, height: 32, borderRadius: 8,
              background: schedOff ? 'rgba(255,255,255,.05)' : 'oklch(0.74 0.155 52 / .13)',
              color: schedOff ? 'var(--text-faint)' : 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
              transition: 'background .18s ease,color .18s ease',
            }}>
              <i className={schedOff ? 'fa-solid fa-pause' : 'fa-solid fa-clock'} style={{ fontSize: 13 }} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Schedule</span>
                <span style={{
                  fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11, color: 'var(--text-2em)',
                  background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.08)',
                  borderRadius: 6, padding: '2px 8px',
                }}>
                  {auto.scheduleShort}
                </span>
                {schedOff && (
                  <span style={{
                    display: 'inline-flex', padding: '2px 7px', borderRadius: 5, fontFamily: 'var(--mono)',
                    fontWeight: 600, fontSize: 9.5, letterSpacing: '.06em',
                    background: 'rgba(152,161,173,.16)', color: 'var(--gray)',
                  }}>
                    OFF
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', marginTop: 3 }}>{schedStatusText}</div>
            </div>
            <Toggle on={!schedOff} onChange={toggleSchedule} title={schedOff ? 'Turn the schedule on' : 'Turn the schedule off'} />
          </div>
          <div style={{ padding: '13px 18px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <HoverBtn
              onClick={() => doRun()}
              style={{
                fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11.5, color: 'var(--accent)',
                background: 'oklch(0.74 0.155 52 / .1)', border: '1px solid oklch(0.74 0.155 52 / .3)',
                borderRadius: 7, padding: '6px 11px', flex: 'none',
              }}
              hoverStyle={{ background: 'oklch(0.74 0.155 52 / .2)' }}
            >
              <i className={runIconCls} style={{ fontSize: 9 }} /> {runLabel}
            </HoverBtn>
            <span style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', minWidth: 0 }}>
              Manual runs are always available — even when the schedule is off.
            </span>
            <div style={{ flex: 1 }} />
            <span style={{
              fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11.5, color: '#4a515c',
              border: '1px dashed rgba(255,255,255,.1)', borderRadius: 7, padding: '6px 11px', flex: 'none',
            }}>
              Message triggers (Discord, iMessage) — coming soon
            </span>
          </div>
        </div>
      </div>

      {/* parameters */}
      {params.length > 0 && (
        <div style={{ marginBottom: 26 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
            <Eyebrow style={{ color: 'var(--text-faint)' }}>PARAMETERS</Eyebrow>
            <span style={{ fontSize: 11.5, color: 'var(--text-faintest)' }}>
              Changes apply on the next run — no new version, no AI involved.
            </span>
          </div>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
            {params.map((p, i) => (
              <ParamRow key={p.name} autoId={auto.id} p={p} last={i === params.length - 1} />
            ))}
          </div>
        </div>
      )}

      {/* recent runs */}
      {runs.length > 0 && (
        <div style={{ marginBottom: 26 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
            <Eyebrow style={{ color: 'var(--text-faint)' }}>RECENT RUNS</Eyebrow>
            <HoverBtn
              onClick={() => go('executions')}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontWeight: 500, fontSize: 11.5 }}
              hoverStyle={{ color: 'var(--text)' }}
            >
              All executions <i className="fa-solid fa-chevron-right" style={{ fontSize: 9 }} />
            </HoverBtn>
          </div>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
            {runs.map((e, i) => (
              <HoverRow
                key={e.id}
                onClick={() => go('execution', { execId: e.id })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 14, padding: '10px 18px',
                  borderBottom: i === runs.length - 1 ? 'none' : '1px solid rgba(255,255,255,.04)',
                  cursor: 'pointer',
                }}
              >
                <Badge
                  status={e.status}
                  style={{
                    padding: '3px 8px', letterSpacing: '.05em', width: 88,
                    display: 'inline-flex', justifyContent: 'center', flex: 'none',
                    animation: badgeAnim(e.status),
                  }}
                />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)', flex: 'none' }}>{e.id.slice(0, 8)}</span>
                <span style={{ fontSize: 12.5, color: 'var(--text-2)', flex: 'none' }}>
                  {e.trigger}{e.ver ? ` · ${e.ver}` : ''}
                </span>
                {e.note && <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-faint)' }}>{e.note}</span>}
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>{e.dur}</span>
                <span style={{ fontSize: 12, color: 'var(--text-faint)', width: 130, textAlign: 'right', flex: 'none' }}>{e.started}</span>
                <span style={{ color: '#4a515c' }}><i className="fa-solid fa-chevron-right" style={{ fontSize: 10 }} /></span>
              </HoverRow>
            ))}
          </div>
        </div>
      )}

      {/* memory */}
      {auto.memory && (
        <div style={{ marginBottom: 26 }}>
          <Eyebrow style={{ color: 'var(--text-faint)', marginBottom: 10 }}>MEMORY</Eyebrow>
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12,
            padding: '13px 18px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-muted)' }}>
              {auto.memory.size} · {auto.memory.updated}
            </span>
            <div style={{ flex: 1 }} />
            {!confirmClear ? (
              <>
                <HoverBtn
                  onClick={revealMemory}
                  style={{
                    background: 'none', border: '1px solid rgba(255,255,255,.1)', borderRadius: 7,
                    color: 'var(--text-2)', fontWeight: 500, fontSize: 12, padding: '6px 12px',
                  }}
                  hoverStyle={{ color: 'var(--text)' }}
                >
                  Reveal in Finder
                </HoverBtn>
                <HoverBtn
                  onClick={() => setConfirmClear(true)}
                  style={{
                    background: 'none', border: '1px solid rgba(255,255,255,.1)', borderRadius: 7,
                    color: 'var(--text-2)', fontWeight: 500, fontSize: 12, padding: '6px 12px',
                  }}
                  hoverStyle={{ border: '1px solid oklch(0.7 0.19 25 / .5)', color: 'oklch(0.74 0.17 25)' }}
                >
                  Clear memory
                </HoverBtn>
              </>
            ) : (
              <>
                <span style={{ fontSize: 12.5, color: 'var(--text-2em)' }}>Next run starts fresh, like the first time.</span>
                <HoverBtn
                  onClick={doClearMemory}
                  style={{
                    background: 'oklch(0.7 0.19 25 / .16)', border: '1px solid oklch(0.7 0.19 25 / .4)',
                    borderRadius: 7, color: 'oklch(0.78 0.15 25)', fontWeight: 600, fontSize: 12, padding: '6px 13px',
                  }}
                  hoverStyle={{ background: 'oklch(0.7 0.19 25 / .26)' }}
                >
                  Clear
                </HoverBtn>
                <HoverBtn
                  onClick={() => setConfirmClear(false)}
                  style={{
                    background: 'none', border: '1px solid rgba(255,255,255,.1)', borderRadius: 7,
                    color: 'var(--text-2)', fontWeight: 500, fontSize: 12, padding: '6px 12px',
                  }}
                  hoverStyle={{ color: 'var(--text)' }}
                >
                  Keep
                </HoverBtn>
              </>
            )}
          </div>
        </div>
      )}

      {/* steps */}
      {steps.length > 0 && (
        <div style={{ marginBottom: 26 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
            <Eyebrow style={{ color: 'var(--text-faint)' }}>STEPS</Eyebrow>
            <span style={{ fontSize: 11.5, color: 'var(--text-faintest)' }}>Written by your AI — read them anytime.</span>
          </div>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
            {steps.map((s, i) => (
              <StepRow
                key={i}
                s={s}
                n={i + 1}
                open={stepOpen === i}
                onToggle={() => setStepOpen(stepOpen === i ? null : i)}
                last={i === steps.length - 1}
              />
            ))}
          </div>
        </div>
      )}

      {/* spec */}
      {spec.length > 0 && (
        <div>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
            <HoverRow
              onClick={() => setSpecOpen(!specOpen)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', cursor: 'pointer' }}
            >
              <Eyebrow style={{ color: 'var(--text-faint)' }}>SPEC</Eyebrow>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>{auto.specMeta}</span>
              <div style={{ flex: 1 }} />
              <span style={{ color: '#4a515c', fontSize: 11 }}>
                <i className={specOpen ? 'fa-solid fa-caret-up' : 'fa-solid fa-caret-down'} style={{ fontSize: 9 }} /> {specOpen ? 'collapse' : 'expand'}
              </span>
            </HoverRow>
            {specOpen && (
              <div style={{ borderTop: '1px solid var(--hairline)', padding: '8px 22px 18px' }}>
                {spec.map((sb, i) => {
                  if (sb.k === 'h1') return <div key={i} style={{ fontSize: 17, fontWeight: 600, margin: '14px 0 4px' }}>{sb.text}</div>
                  if (sb.k === 'h2') {
                    return (
                      <div key={i} style={{
                        fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 10.5, letterSpacing: '.08em',
                        textTransform: 'uppercase', color: 'var(--text-muted)', margin: '16px 0 6px',
                      }}>
                        {sb.text}
                      </div>
                    )
                  }
                  if (sb.k === 'li') {
                    return (
                      <div key={i} style={{ display: 'flex', gap: 8, margin: '3px 0' }}>
                        <span style={{ color: 'var(--text-faint)' }}>–</span>
                        <span style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-2em)' }}>{sb.text}</span>
                      </div>
                    )
                  }
                  return <p key={i} style={{ margin: '4px 0', fontSize: 13, lineHeight: 1.6, color: 'var(--text-2em)' }}>{sb.text}</p>
                })}
                <div style={{ marginTop: 14, fontSize: 11.5, color: 'var(--text-faintest)' }}>
                  The AI regenerates the steps from this document when you edit it. Every change mints a new version — older ones live in the Version menu on the edit page.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {delAsk && (
        <ConfirmModal
          title="Delete this automation?"
          body={(
            <>
              <span style={{ fontWeight: 500, color: 'var(--text)' }}>{auto.name}</span>
              {' '}will be deleted — the schedule stops, and its versions and memory go with it. Past results stay in Executions.
              {auto.live && (
                <p style={{ color: 'var(--amber)', margin: '8px 0 0' }}>A run is in progress — deleting cancels it.</p>
              )}
            </>
          )}
          confirmLabel="Delete automation"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setDelAsk(false)}
        />
      )}
    </div>
  )
}
