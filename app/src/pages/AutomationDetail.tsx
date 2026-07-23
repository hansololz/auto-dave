// Automation detail (§4.3/§4.4/§7, prototype "Automation detail" screen).
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Auto, ParamDef, SnapshotSettings, Step, Trigger } from '../types'
import {
  Badge, BtnPrimary, ConfirmModal, EXECUTING_TOAST, Eyebrow, FailureNotice, MenuRow, MiniBadge,
  PyCode, Toggle, menuStyle, nextIn, usePopover, validUrl,
} from '../ui'
import { cronLabels, cronNext, cronValid, fmtMoment, nextTriggerShort, timeAt, triggerShort, tzSuffix } from '../cron'
import { ResultSection, SpecMarkdown } from '../result'

const badgeAnim = (s: string) => (s === 'executing' ? 'adPulse 1.4s ease-in-out infinite' : 'none')

// ---------- §9.2 MEMORY snapshot-row text buttons: shared sizing (colors + hover live in ad-btn-text) ----------

const memRowSize: React.CSSProperties = { fontWeight: 500, fontSize: 11.5, padding: '3px 7px' }

// §6.3 automatic-snapshot toggles — label + plain-language explanation per reason
const SNAP_SETTINGS: Array<{ key: keyof SnapshotSettings; label: string; help: string }> = [
  {
    key: 'preVersion', label: 'Before a new version executes',
    help: 'Saves a copy of memory right before the first execution of a newly saved version, so you can restore how memory was if the new version mishandles it.',
  },
  {
    key: 'preClear', label: 'Before clearing memory',
    help: 'Saves a copy right before Clear memory empties the directory, so a clear can be undone.',
  },
  {
    key: 'preRestore', label: 'Before restoring a snapshot',
    help: 'Saves a copy of the current memory right before a restore replaces it, so a restore can be undone.',
  },
]

// ---------- §9.2 Add-trigger editor (kind picker → cron expr / one-shot time) ----------

const pickChipStyle = (active: boolean): React.CSSProperties => ({
  fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11,
  background: active ? 'var(--accent-chip-bg)' : 'rgba(255,255,255,.04)',
  border: `1px solid ${active ? 'oklch(0.74 0.155 52 / .4)' : 'rgba(255,255,255,.1)'}`,
  color: active ? 'var(--accent)' : 'var(--text-2em)', borderRadius: 6, padding: '4px 10px', flex: 'none',
})

const TZ_LIST: string[] = Intl.supportedValuesOf('timeZone')

function AddTrigger({ hasAppStart, onAdd }: {
  hasAppStart: boolean
  onAdd: (t: { kind: 'cron' | 'time' | 'app_start'; expr?: string; at?: string; tz?: string }) => void
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<'cron' | 'time' | 'app_start'>('cron')
  const [expr, setExpr] = useState('')
  const [at, setAt] = useState('')
  const [tz, setTz] = useState('') // '' → local time, no tz stored (§4.3)
  const exprOk = cronValid(expr)
  const atDate = at ? timeAt(at, tz || undefined) : null
  const atOk = !!atDate && !Number.isNaN(atDate.getTime()) && atDate > new Date()
  const canAdd = kind === 'cron' ? exprOk : kind === 'time' ? atOk : true
  const nxt = kind === 'cron' && exprOk ? cronNext(expr, undefined, tz || undefined) : null
  const preview = kind === 'cron'
    ? (exprOk ? `${cronLabels(expr, tz || undefined).label}${nxt ? ` · next: ${fmtMoment(nxt)}` : ''}` : (expr ? 'Not a valid cron expression' : ''))
    : kind === 'time'
    ? (atOk ? `Once at ${fmtMoment(new Date(at))}${tzSuffix(tz || undefined)}` : (at ? 'Pick a time in the future' : ''))
    : 'On app start — executes when you launch the app'
  const reset = () => { setOpen(false); setKind('cron'); setExpr(''); setAt(''); setTz('') }

  if (!open) {
    return (
      <button className="ad-btn-dashed" onClick={() => setOpen(true)} style={{ marginTop: 9 }}>
        <i className="fa-solid fa-plus" style={{ fontSize: 9 }} /> Add trigger
      </button>
    )
  }
  return (
    <div style={{ marginTop: 10, border: '1px dashed rgba(255,255,255,.12)', borderRadius: 8, padding: '11px 12px' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <button onClick={() => setKind('cron')} style={pickChipStyle(kind === 'cron')}>Cron</button>
        <button onClick={() => setKind('time')} style={pickChipStyle(kind === 'time')}>One time</button>
        <button
          onClick={() => { if (!hasAppStart) setKind('app_start') }}
          disabled={hasAppStart}
          title={hasAppStart ? 'Already added' : undefined}
          style={{ ...pickChipStyle(kind === 'app_start'), ...(hasAppStart ? { color: 'var(--text-faintest)', cursor: 'default' } : {}) }}
        >
          App start
        </button>
        {['Discord', 'iMessage', 'Pub/Sub'].map((n) => (
          <span
            key={n} title="Coming soon"
            style={{
              fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11, color: 'var(--text-faintest)',
              border: '1px dashed rgba(255,255,255,.1)', borderRadius: 6, padding: '4px 10px', flex: 'none',
            }}
          >
            {n} — coming soon
          </span>
        ))}
      </div>
      {kind === 'cron' ? (
        <input
          className="ad-input"
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          placeholder="0 8 * * *   (minute hour day month weekday, Sun = 0)"
          spellCheck={false}
          style={{
            width: '100%', fontFamily: 'var(--mono)', fontSize: 12, padding: '7px 10px',
            ...(expr && !exprOk ? { border: '1px solid oklch(0.7 0.19 25 / .55)' } : {}),
          }}
        />
      ) : kind === 'time' ? (
        <input
          className="ad-input"
          type="datetime-local"
          value={at}
          onChange={(e) => setAt(e.target.value)}
          style={{
            fontFamily: 'var(--mono)', fontSize: 12, padding: '6px 10px', colorScheme: 'dark',
            ...(at && !atOk ? { border: '1px solid oklch(0.7 0.19 25 / .55)' } : {}),
          }}
        />
      ) : null}
      {kind !== 'app_start' && (
        <select
          className="ad-input"
          value={tz}
          onChange={(e) => setTz(e.target.value)}
          title="Timezone the trigger's times read in"
          style={{
            display: 'block', marginTop: 8, fontFamily: 'var(--mono)', fontSize: 12,
            padding: '6px 10px', colorScheme: 'dark',
            color: tz ? 'var(--text)' : 'var(--text-muted)',
          }}
        >
          <option value="">Local time</option>
          {TZ_LIST.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 9 }}>
        <span style={{
          flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: 11,
          color: canAdd ? 'var(--accent)' : 'var(--red-text)',
        }}>
          {preview}
        </span>
        <button
          className="ad-btn-accent-ghost"
          onClick={() => {
            onAdd(kind === 'app_start' ? { kind }
              : { ...(kind === 'cron' ? { kind, expr: expr.trim() } : { kind, at }), ...(tz ? { tz } : {}) })
            reset()
          }}
          disabled={!canAdd}
          style={{
            fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11.5, padding: '5px 11px',
            flex: 'none', opacity: canAdd ? 1 : 0.45, cursor: canAdd ? 'pointer' : 'default',
          }}
        >
          Add
        </button>
        <button className="ad-btn-text dim" onClick={reset} style={{ fontWeight: 500, fontSize: 12, flex: 'none' }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function ParamRow({ autoId, p, last }: { autoId: string; p: ParamDef; last: boolean }) {
  const showToast = useStore((s) => s.showToast)
  const loadAuto = useStore((s) => s.loadAuto)
  const [lines, setLines] = useState<string[]>(() => [...(p.lines ?? [])])
  const [rows, setRows] = useState<{ k: string; v: string }[]>(() => (p.rows ?? []).map((r) => ({ ...r })))
  const [text, setText] = useState<string | null>(null)
  const [num, setNum] = useState<string | null>(null)
  const [tog, setTog] = useState<boolean | null>(null) // optimistic toggle — a double-click must not compute twice from stale props
  const [foc, setFoc] = useState(false)

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<unknown>(undefined)

  // Resync from the server value when it changes underneath (a restore, a new
  // version's defaults, an edit from another window) — but never while an edit
  // is pending or an input is focused, so typing is never clobbered.
  const serverLines = JSON.stringify(p.lines ?? [])
  useEffect(() => {
    if (!timer.current && !foc) setLines([...(p.lines ?? [])])
  }, [serverLines])
  const serverRows = JSON.stringify(p.rows ?? [])
  useEffect(() => {
    if (!timer.current && !foc) setRows((p.rows ?? []).map((r) => ({ ...r })))
  }, [serverRows])
  useEffect(() => { setTog(null) }, [p.on])

  const commit = (value: unknown) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    pending.current = undefined
    void (async () => {
      try {
        await api.patchAuto(autoId, { paramValues: { [p.name]: value } })
        void loadAuto(autoId)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }
  // Debounced commit: saves as the user types, without one PATCH per keystroke.
  const commitSoon = (value: unknown) => {
    pending.current = value
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { timer.current = null; commit(pending.current) }, 600)
  }
  const flush = () => { if (timer.current) commit(pending.current) }
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); commit(pending.current) } }, [])

  const setLinesSaved = (next: string[], now = false) => { setLines(next); now ? commit(next) : commitSoon(next) }
  const setRowsSaved = (next: { k: string; v: string }[], now = false) => { setRows(next); now ? commit(next) : commitSoon(next) }

  let good = 0
  let bad = 0
  if (p.kind === 'list' && p.validate) {
    good = lines.filter((l) => l.trim() && validUrl(l)).length
    bad = lines.filter((l) => l.trim() && !validUrl(l)).length
  }

  // §9.2 hybrid layout: compact controls (toggle/number) sit on the label's line,
  // wide editors (text/list/kv) stack below the full-width label + help.
  const compact = p.kind === 'toggle' || p.kind === 'number'
  const labelBlock = (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{p.label}</span>
        {p.kind === 'text' && !p.value && (
          <MiniBadge c="var(--amber)" bg="var(--amber-bg)">NOT SET</MiniBadge>
        )}
      </div>
      <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', marginTop: 3 }}>{p.help}</div>
    </div>
  )

  return (
    <div style={{
      padding: '14px 18px', borderBottom: last ? 'none' : '1px solid var(--hairline-dim)',
      display: 'flex', gap: compact ? 18 : 8, flexDirection: compact ? 'row' : 'column',
      alignItems: compact ? 'center' : 'stretch',
    }}>
      {labelBlock}
      <div style={{ minWidth: 0, display: 'flex', flex: 'none' }}>
        {p.kind === 'toggle' && (
          <Toggle
            on={tog ?? !!p.on}
            onChange={() => {
              const v = !(tog ?? !!p.on)
              setTog(v)
              void (async () => {
                try {
                  await api.patchAuto(autoId, { paramValues: { [p.name]: v } })
                  void loadAuto(autoId)
                } catch (err) {
                  setTog(null) // roll the optimistic value back — the server still holds the old one
                  showToast((err as Error).message)
                }
              })()
            }}
          />
        )}
        {p.kind === 'number' && (
          <input
            value={num ?? String(p.value ?? '')}
            inputMode="numeric"
            onChange={(e) => {
              const s = e.target.value.replace(/[^0-9]/g, '')
              setNum(s)
              const min = p.min ?? 0
              const v = s === '' ? min : Math.max(min, parseInt(s, 10))
              commitSoon(v)
            }}
            onFocus={() => setFoc(true)}
            onBlur={() => {
              setFoc(false)
              flush()
              setNum(null)
            }}
            className="ad-input"
            style={{
              width: 70, fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 13,
              textAlign: 'center', padding: '6px 10px',
            }}
          />
        )}
        {p.kind === 'text' && (
          <input
            value={text ?? String(p.value ?? '')}
            placeholder={p.placeholder ?? ''}
            onChange={(e) => { setText(e.target.value); commitSoon(e.target.value) }}
            onFocus={() => setFoc(true)}
            onBlur={() => {
              setFoc(false)
              flush()
              setText(null)
            }}
            className="ad-input"
            style={{ width: '100%', maxWidth: 520, fontSize: 12.5, padding: '8px 12px' }}
          />
        )}
        {p.kind === 'list' && (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {lines.map((l, j) => {
              const inv = !!p.validate && !!l.trim() && !validUrl(l)
              return (
                <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    className="ad-input"
                    value={l}
                    onChange={(e) => setLinesSaved(lines.map((x, i) => (i === j ? e.target.value : x)))}
                    onBlur={flush}
                    style={{
                      flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: 12, padding: '7px 10px',
                      ...(inv ? { border: '1px solid oklch(0.7 0.19 25 / .45)', color: 'var(--red-hover)' } : {}),
                    }}
                  />
                  {inv && (
                    <MiniBadge c="var(--red-hover)" bg="oklch(0.7 0.19 25 / .14)" style={{ flex: 'none' }}>
                      NOT A VALID LINK
                    </MiniBadge>
                  )}
                  <button className="ad-btn-x" onClick={() => setLinesSaved(lines.filter((_, i) => i !== j), true)}>
                    <i className="fa-solid fa-xmark" style={{ fontSize: 12 }} />
                  </button>
                </div>
              )
            })}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <button className="ad-btn-dashed" onClick={() => setLinesSaved([...lines, ''])}>
                + Add line
              </button>
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11, color: 'var(--text-faint)' }}>
                {lines.length}{p.validate ? ` lines · ${good} valid links${bad ? ` · ${bad} needs attention` : ''}` : ' entries'}
              </span>
            </div>
          </div>
        )}
        {p.kind === 'kv' && (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rows.map((r, j) => (
              <div key={j} style={{ display: 'flex', gap: 6 }}>
                <input
                  className="ad-input"
                  value={r.k}
                  onChange={(e) => setRowsSaved(rows.map((x, i) => (i === j ? { ...x, k: e.target.value } : x)))}
                  onBlur={flush}
                  style={{
                    flex: 1.3, minWidth: 0, color: 'var(--text-2)',
                    fontFamily: 'var(--mono)', fontSize: 11.5, padding: '7px 10px',
                  }}
                />
                <input
                  className="ad-input"
                  value={r.v}
                  onChange={(e) => setRowsSaved(rows.map((x, i) => (i === j ? { ...x, v: e.target.value } : x)))}
                  onBlur={flush}
                  style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '7px 10px' }}
                />
                <button className="ad-btn-x" onClick={() => setRowsSaved(rows.filter((_, i) => i !== j), true)}>
                  <i className="fa-solid fa-xmark" style={{ fontSize: 12 }} />
                </button>
              </div>
            ))}
            <button className="ad-btn-dashed" onClick={() => setRowsSaved([...rows, { k: '', v: '' }])}>
              + Add row
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- steps ----------

function StepRow({ s, n, open, onToggle, last, agentName }: {
  s: Step; n: number; open: boolean; onToggle: () => void; last: boolean; agentName: string
}) {
  const stepSecrets = [...new Set([...(s.code || '').matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))]
  return (
    <div style={{ borderBottom: last ? 'none' : '1px solid var(--hairline-dim)' }}>
      <div className="ad-hover-row" onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '12px 18px', cursor: 'pointer' }}>
        <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11, color: 'var(--text-faint)', width: 14, flex: 'none' }}>{n}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</span>
            {s.agent && (
              <span
                className="ad-btn-accent-ghost"
                title={s.why ?? undefined}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 6,
                  padding: '2px 8px', fontFamily: 'var(--mono)', fontSize: 10, whiteSpace: 'nowrap',
                }}
              >
                <i className="fa-solid fa-robot" style={{ fontSize: 8.5 }} /> {agentName}
              </span>
            )}
            {stepSecrets.map((name) => (
              <span
                key={name}
                title={`This step uses the ${name} secret from your Keychain`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)',
                  borderRadius: 6, padding: '2px 8px', fontFamily: 'var(--mono)', fontWeight: 600,
                  fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap',
                }}
              >
                <i className="fa-solid fa-key" style={{ fontSize: 8.5 }} /> {name}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-muted)', marginTop: 1 }}>{s.desc}</div>
        </div>
        <span style={{ color: 'var(--text-faintest)', fontSize: 11, whiteSpace: 'nowrap' }}>
          <i className={open ? 'fa-solid fa-caret-up' : 'fa-solid fa-caret-down'} style={{ fontSize: 9 }} /> {open ? 'hide script' : 'view script'}
        </span>
      </div>
      {open && (
        <>
          {s.agent && s.why && (
            <div style={{
              display: 'flex', gap: 9, alignItems: 'flex-start', borderTop: '1px solid var(--hairline-dim)',
              background: 'oklch(0.74 0.155 52 / .05)', padding: '10px 18px 10px 45px', animation: 'adFadeUp .22s ease both',
            }}>
              <i className="fa-solid fa-robot" style={{ color: 'oklch(0.78 0.13 52)', fontSize: 10, marginTop: 3 }} />
              <span style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-muted)' }}>
                <span style={{ fontWeight: 500, color: 'var(--text-2em)' }}>Why an agent: </span>{s.why}
              </span>
            </div>
          )}
          <PyCode className="ad-copy" code={s.code} style={{
            margin: 0, background: 'var(--bg-code)', borderTop: '1px solid var(--hairline-dim)',
            padding: '14px 18px 14px 45px', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.75,
            color: 'var(--code-text)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', minWidth: 0,
            animation: 'adFadeUp .22s ease both',
          }} />
        </>
      )}
    </div>
  )
}

// ---------- page ----------

export default function AutomationDetail() {
  const { autoId, autos, agents, execs, go, setSurface, showToast, loadAuto } = useStore()
  const auto: Auto | undefined = autos.find((a) => a.id === autoId)

  const [verOpen, setVerOpen, verRef] = usePopover()
  const [actOpen, setActOpen, actRef] = usePopover()
  const [delAsk, setDelAsk] = useState(false)
  const [stepOpen, setStepOpen] = useState<number | null>(null)
  const [specOpen, setSpecOpen] = useState(true)
  const [confirmClear, setConfirmClear] = useState(false)
  const [snapAsk, setSnapAsk] = useState(false)
  const [snapName, setSnapName] = useState('')
  const [snapRow, setSnapRow] = useState<{ sid: string; kind: 'restore' | 'rename' | 'delete' } | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [, setTick] = useState(0)

  // Full record (params/steps/latest) only comes from the full fetch.
  useEffect(() => {
    if (autoId) { void loadAuto(autoId); setConfirmClear(false); setSnapAsk(false); setSnapRow(null) }
  }, [autoId])
  // §4.3: refresh the countdown every 30 s.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000)
    return () => clearInterval(t)
  }, [])
  // autoId may point at a deleted automation.
  useEffect(() => { if (!auto) go('automations') }, [auto, go])

  if (!auto) return null

  const executing = !!auto.live
  const trigs = auto.triggers
  const noTrigs = trigs.length === 0
  const allOff = auto.triggersOff
  const countdown = auto.nextAt == null ? '' : nextIn(auto)
  const nextShort = nextTriggerShort(trigs)
  // §4.3: an enabled app_start has no computable next — nextAt stays null.
  const appStartOnly = auto.nextAt == null && trigs.some((t) => t.kind === 'app_start' && !t.off)
  // nextAt can be null with an enabled non-app_start trigger too (e.g. an
  // elapsed one-shot not yet consumed) — never render a dangling "next in ".
  const noNext = auto.nextAt == null
  const trigChip = executing ? `${auto.triggerChip} · executing now`
    : noTrigs ? 'No triggers'
    : allOff ? `${auto.triggerChip} · triggers off`
    : appStartOnly ? `${auto.triggerChip} · on app start`
    : noNext ? auto.triggerChip
    : `${auto.triggerChip} · next in ${countdown}`
  const trigStatusText = executing ? 'Executing now… the triggers are unchanged.'
    : noTrigs ? 'No triggers set — executes only when you press Execute now or use the menu bar.'
    : allOff ? 'All triggers are off — won’t execute on its own. Execute now and the menu bar still work.'
    : appStartOnly ? 'Executes when this app next starts — Execute now and the menu bar still work.'
    : noNext ? 'No upcoming occurrence — Execute now and the menu bar still work.'
    : `Next execution in ${countdown}${nextShort ? ` (${nextShort})` : ''} · executes even when the app is closed.`
  const trigChipOn = executing || (!allOff && !noTrigs)
  const execLabel = executing ? 'Executing…' : 'Execute now'
  const execIconCls = executing ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-play'

  const doExecute = (ver?: string, toastMsg?: string) => {
    if (auto.live) { showToast(EXECUTING_TOAST); return }
    void (async () => {
      try {
        await api.executeNow(auto.id, ver)
        if (toastMsg) showToast(toastMsg)
      } catch (err) {
        const er = err as Error & { status?: number }
        showToast(er.status === 409 ? EXECUTING_TOAST : er.message)
      }
    })()
  }

  // §4.3 trigger edits are user-owned operational state: whole-list PATCH, no version, no AI.
  const putTriggers = (next: Array<Partial<Trigger>>, toastMsg: string) => {
    void (async () => {
      try {
        await api.patchAuto(auto.id, { triggers: next })
        showToast(toastMsg)
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }
  const toggleTrigger = (t: Trigger) => {
    putTriggers(
      trigs.map((x) => (x.id === t.id ? { ...x, off: !x.off } : x)),
      t.off ? `Trigger turned on — ${t.short}.` : `Trigger turned off — ${t.short}. Execute now still works.`,
    )
  }
  const removeTrigger = (t: Trigger) => {
    putTriggers(trigs.filter((x) => x.id !== t.id), `Trigger removed — ${t.short}.`)
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
    if (!p) return
    void window.autowright?.revealPath(p)
    showToast(`Shown in Finder — Autowright › Memory › ${auto.name}`)
  }

  const doClearMemory = () => {
    setConfirmClear(false)
    void (async () => {
      try {
        await api.clearMemory(auto.id)
        showToast('Memory cleared — the next execution starts fresh.')
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }

  // §6.3 memory snapshots
  const doSnapshot = () => {
    const name = snapName.trim()
    setSnapAsk(false)
    setSnapName('')
    void (async () => {
      try {
        await api.createSnapshot(auto.id, name || undefined)
        showToast('Snapshot saved.')
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }
  const doRestoreSnap = (sid: string) => {
    setSnapRow(null)
    void (async () => {
      try {
        await api.restoreSnapshot(auto.id, sid)
        showToast('Memory restored — the next execution continues from the snapshot.')
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }
  const doRenameSnap = (sid: string) => {
    const name = renameVal.trim()
    setSnapRow(null)
    void (async () => {
      try {
        await api.renameSnapshot(auto.id, sid, name || null)
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }
  // §6.3 automatic-snapshot toggles — user-owned operational state, applies immediately (§19 PATCH)
  const setSnapSetting = (key: keyof SnapshotSettings, on: boolean) => {
    void (async () => {
      try {
        await api.patchAuto(auto.id, { snapshotSettings: { [key]: on } })
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }

  const doDeleteSnap = (sid: string) => {
    setSnapRow(null)
    void (async () => {
      try {
        await api.deleteSnapshot(auto.id, sid)
        showToast('Snapshot deleted.')
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
  // §9.2 failure notice: latest execution (skipped ones never count as latest)
  // failed → its §4.5 error leads the LATEST RESULT card.
  const latestExec = execs.find((e) => e.autoId === auto.id && e.status !== 'skipped' && !e.test)
  const failedExec = latestExec?.status === 'failed' && latestExec.error ? latestExec : null
  const params = auto.params ?? []
  const steps = auto.steps ?? []
  const spec = auto.spec ?? []
  const olderVersions = (auto.versions ?? []).filter((v) => v.v !== auto.version)
  // §11 test executions are draft-scoped — never listed among real executions
  const recentExecs = execs.filter((e) => e.autoId === auto.id && !e.test).slice(0, 6)

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 30px 70px', animation: 'adFadeUp .4s ease' }}>
      <button className="ad-btn-text" onClick={() => go('automations')} style={{ fontWeight: 500, fontSize: 12.5, padding: '4px 0' }}>
        <i className="fa-solid fa-chevron-left" style={{ fontSize: 10 }} /> Automations
      </button>

      {/* title row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 13, margin: '14px 0 6px' }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.01em', margin: 0 }}>{auto.name}</h1>
        <div ref={verRef} style={{ position: 'relative' }}>
          <button className="ad-btn-pill" onClick={() => setVerOpen(!verOpen)}>
            <span>v{auto.version}</span>
            <i className="fa-solid fa-caret-down" style={{ color: 'var(--text-faint)', fontSize: 9 }} />
          </button>
          {verOpen && (
            <div style={{
              ...menuStyle, top: 'calc(100% + 6px)', left: 0, minWidth: 360,
              padding: 0, overflow: 'hidden',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                borderBottom: '1px solid var(--hairline-dim)', background: 'rgba(255,255,255,.03)',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 12.5, color: 'var(--text)' }}>
                    v{auto.version} · current
                  </div>
                  <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-muted)', marginTop: 1 }}>
                    What triggers and Execute now always use.
                  </div>
                </div>
              </div>
              {olderVersions.map((v) => (
                <div key={v.v} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                  borderBottom: '1px solid var(--hairline-dim)',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 12.5, color: 'var(--text-2em)' }}>v{v.v}</div>
                    <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-muted)', marginTop: 1 }}>
                      {(v.note ? `${v.note} — ` : '') + v.when}
                    </div>
                  </div>
                  <button
                    className="ad-btn-accent-ghost"
                    onClick={() => {
                      setVerOpen(false)
                      doExecute(`v${v.v}`, `Executing v${v.v} once — triggers and Execute now stay on v${auto.version}.`)
                    }}
                    style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11.5, padding: '5px 10px', flex: 'none' }}
                  >
                    <i className="fa-solid fa-play" style={{ fontSize: 9 }} /> Execute once
                  </button>
                </div>
              ))}
              <div style={{
                padding: '10px 14px', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-faint)',
                background: 'var(--bg-card)',
              }}>
                Executing an older version once doesn’t change anything — triggers and{' '}
                <i className="fa-solid fa-play" style={{ fontSize: 9 }} /> Execute now always use the current version.
                To make an older version current, open Edit and restore it from the Version menu.
              </div>
            </div>
          )}
        </div>
        <Badge status={auto.lastStatus} style={{ animation: badgeAnim(auto.lastStatus) }} />
        <div style={{ flex: 1 }} />
        <BtnPrimary onClick={() => doExecute()} style={{ flex: 'none' }}>
          <i className={execIconCls} style={{ fontSize: 10 }} /> {execLabel}
        </BtnPrimary>
        <button className="ad-btn-ghost" onClick={() => setSurface('create', 'edit')} style={{ flex: 'none' }}>
          Edit
        </button>
        <div ref={actRef} style={{ position: 'relative', flex: 'none' }}>
          <button
            className="ad-btn-ghost"
            onClick={() => setActOpen(!actOpen)}
            title="More actions"
            style={{ padding: '8px 11px' }}
          >
            <i className="fa-solid fa-ellipsis" style={{ fontSize: 12 }} />
          </button>
          {actOpen && (
            <div style={{ ...menuStyle, top: 'calc(100% + 6px)', right: 0, minWidth: 210 }}>
              <MenuRow danger onClick={() => { setActOpen(false); setDelAsk(true) }}>
                <i className="fa-solid fa-trash-can" style={{ fontSize: 11, width: 14, textAlign: 'center', marginRight: 9 }} />
                Delete automation…
              </MenuRow>
            </div>
          )}
        </div>
      </div>

      {/* §4.3 trigger status chip */}
      <div style={{ margin: '0 0 24px' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontWeight: 500,
          fontSize: 11.5, color: trigChipOn ? 'var(--accent)' : 'var(--gray)',
          background: trigChipOn ? 'oklch(0.74 0.155 52 / .1)' : 'var(--gray-bg)',
          borderRadius: 6, padding: '3px 9px', transition: 'color .18s ease,background .18s ease',
        }}>
          <i
            className={executing ? 'fa-solid fa-spinner fa-spin' : (allOff || noTrigs) ? 'fa-solid fa-pause' : 'fa-solid fa-clock'}
            style={{ fontSize: 9 }}
          />
          {trigChip}
        </span>
      </div>

      {/* §4.4 draft banner */}
      {auto.draft && (
        <div style={{
          margin: '0 0 24px', background: 'var(--bg-card)', border: '1px dashed oklch(0.74 0.155 52 / .45)',
          borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12,
          animation: 'adFadeUp .3s ease both',
        }}>
          <MiniBadge c="var(--accent)" bg="var(--accent-chip-bg)" style={{ flex: 'none' }}>Draft</MiniBadge>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-2em)' }}>
            Unsaved edit based on v{auto.version} — kept from your last edit session. Execute it like any other version, or resume editing.
          </span>
          <button
            className="ad-btn-accent-ghost"
            onClick={() => doExecute('Draft')}
            style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 12, padding: '6px 11px', flex: 'none' }}
          >
            <i className="fa-solid fa-play" style={{ fontSize: 9 }} /> Execute draft
          </button>
          <button
            className="ad-btn-soft"
            onClick={() => setSurface('create', 'edit')}
            style={{ fontSize: 12, padding: '6px 12px', flex: 'none' }}
          >
            Resume editing
          </button>
          <button className="ad-btn-text dim" onClick={discardDraft} style={{ fontWeight: 500, fontSize: 12, flex: 'none' }}>
            Discard
          </button>
        </div>
      )}

      {/* latest result */}
      {(lr || failedExec) ? (
        <div style={{ marginBottom: 26 }}>
          {failedExec && (
            <FailureNotice
              error={failedExec.error!}
              onView={() => go('execution', { execId: failedExec.id })}
              style={{ marginBottom: lr ? 10 : 0 }}
            />
          )}
          {lr && <ResultSection label="LATEST RESULT" result={lr} execId={lr.execId} measure={640} />}
        </div>
      ) : (
        <div style={{
          marginBottom: 26, background: 'var(--bg-card)', border: '1px dashed rgba(255,255,255,.12)',
          borderRadius: 12, padding: 22, textAlign: 'center',
        }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 4 }}>No executions yet</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Press Execute now — the first result will appear right here.</div>
        </div>
      )}

      {/* triggers */}
      <div style={{ marginBottom: 26 }}>
        <Eyebrow style={{ color: 'var(--text-faint)', marginBottom: 10 }}>TRIGGERS</Eyebrow>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '13px 18px' }}>
            {trigs.map((t) => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '5px 0' }}>
                <span style={{
                  width: 28, height: 28, borderRadius: 7,
                  background: t.off ? 'rgba(255,255,255,.05)' : 'var(--accent-chip-bg)',
                  color: t.off ? 'var(--text-faint)' : 'var(--accent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
                  transition: 'background .18s ease,color .18s ease',
                }}>
                  <i className={t.kind === 'cron' ? 'fa-solid fa-clock' : t.kind === 'app_start' ? 'fa-solid fa-rocket' : 'fa-solid fa-calendar-day'} style={{ fontSize: 12 }} />
                </span>
                <span
                  className="ad-copy"
                  style={{
                    flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 12,
                    color: t.off ? 'var(--text-faint)' : 'var(--text-2em)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {t.label}
                </span>
                <Toggle on={!t.off} onChange={() => toggleTrigger(t)} title={t.off ? 'Turn this trigger on' : 'Turn this trigger off'} />
                <button className="ad-btn-x" onClick={() => removeTrigger(t)} title="Remove trigger" style={{ fontSize: 13 }}>
                  <i className="fa-solid fa-xmark" />
                </button>
              </div>
            ))}
            {noTrigs && (
              <div style={{
                border: '1px dashed rgba(255,255,255,.1)', borderRadius: 8, padding: '9px 12px',
                fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11.5, color: 'var(--text-faint)',
              }}>
                No triggers
              </div>
            )}
            <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', marginTop: 8 }}>{trigStatusText}</div>
            <AddTrigger
              hasAppStart={trigs.some((t) => t.kind === 'app_start')}
              onAdd={(t) => putTriggers([...trigs, { ...t, off: false }], `Trigger added — ${triggerShort(t)}.`)}
            />
          </div>
        </div>
      </div>

      {/* parameters */}
      {params.length > 0 && (
        <div style={{ marginBottom: 26 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
            <Eyebrow style={{ color: 'var(--text-faint)' }}>PARAMETERS</Eyebrow>
            <span style={{ fontSize: 11.5, color: 'var(--text-faintest)' }}>
              Changes apply on the next execution — no new version, no AI involved.
            </span>
          </div>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
            {params.map((p, i) => (
              <ParamRow key={p.name} autoId={auto.id} p={p} last={i === params.length - 1} />
            ))}
          </div>
        </div>
      )}

      {/* recent executions */}
      {recentExecs.length > 0 && (
        <div style={{ marginBottom: 26 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
            <Eyebrow style={{ color: 'var(--text-faint)' }}>RECENT EXECUTIONS</Eyebrow>
            <button className="ad-btn-text" onClick={() => go('executions')} style={{ fontWeight: 500, fontSize: 11.5 }}>
              All executions <i className="fa-solid fa-chevron-right" style={{ fontSize: 9 }} />
            </button>
          </div>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
            {recentExecs.map((e, i) => (
              <div
                className="ad-hover-row"
                key={e.id}
                onClick={() => go('execution', { execId: e.id })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 14, padding: '10px 18px',
                  borderBottom: i === recentExecs.length - 1 ? 'none' : '1px solid var(--hairline-dim)',
                  cursor: 'pointer',
                }}
              >
                <Badge
                  status={e.status}
                  style={{
                    width: 88, display: 'inline-flex', justifyContent: 'center', flex: 'none',
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
                <span style={{ color: 'var(--text-faintest)' }}><i className="fa-solid fa-chevron-right" style={{ fontSize: 10 }} /></span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* memory (§9.2 MEMORY card, snapshots per §6.3) */}
      {auto.memory && (
        <div style={{ marginBottom: 26 }}>
          <Eyebrow style={{ color: 'var(--text-faint)', marginBottom: 10 }}>MEMORY</Eyebrow>
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12,
            padding: '13px 18px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span className="ad-copy" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-muted)' }}>
                {auto.memory.size} · {auto.memory.updated}
              </span>
              <div style={{ flex: 1 }} />
              {confirmClear ? (
                <>
                  <span style={{ fontSize: 12.5, color: 'var(--text-2em)' }}>
                    {auto.snapshotSettings.preClear
                      ? 'Next execution starts fresh, like the first time. Current memory is snapshotted first.'
                      : "Next execution starts fresh, like the first time. Automatic snapshots are off — this can't be undone."}
                  </span>
                  <button className="ad-btn-danger-ghost" onClick={doClearMemory} style={{ fontSize: 12, padding: '6px 13px' }}>
                    Clear
                  </button>
                  <button className="ad-btn-soft" onClick={() => setConfirmClear(false)}>
                    Keep
                  </button>
                </>
              ) : snapAsk ? (
                <>
                  <input
                    className="ad-input"
                    value={snapName}
                    onChange={(e) => setSnapName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') doSnapshot() }}
                    placeholder="Name — optional"
                    autoFocus
                    style={{ width: 220, fontSize: 12, padding: '5px 10px' }}
                  />
                  <button
                    className="ad-btn-soft"
                    onClick={doSnapshot}
                    style={{ border: '1px solid oklch(0.74 0.155 52 / .4)', color: 'var(--accent)', fontWeight: 600 }}
                  >
                    Save
                  </button>
                  <button className="ad-btn-soft" onClick={() => { setSnapAsk(false); setSnapName('') }}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button className="ad-btn-soft" onClick={revealMemory}>
                    Show in Finder
                  </button>
                  {auto.memory.size === 'empty' ? (
                    <button className="ad-btn-soft" disabled title="Memory is empty">
                      Snapshot
                    </button>
                  ) : (
                    <button className="ad-btn-soft" onClick={() => setSnapAsk(true)}>
                      Snapshot
                    </button>
                  )}
                  <button className="ad-btn-text danger" onClick={() => setConfirmClear(true)} style={{ fontWeight: 500, fontSize: 12 }}>
                    Clear memory
                  </button>
                </>
              )}
            </div>
            {(auto.snapshots ?? []).length > 0 && (
              <div style={{ marginTop: 12, borderTop: '1px solid var(--hairline)' }}>
                {(auto.snapshots ?? []).map((s) => (
                  <div
                    key={s.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                      padding: '9px 0', borderBottom: '1px solid var(--hairline-dim)',
                    }}
                  >
                    {snapRow?.sid === s.id && snapRow.kind === 'restore' ? (
                      <>
                        <span style={{ fontSize: 12.5, color: 'var(--text-2em)' }}>
                          {auto.snapshotSettings.preRestore
                            ? 'Replaces current memory — the current state is snapshotted first.'
                            : 'Replaces current memory — automatic snapshots are off, so the current state is lost.'}
                        </span>
                        <div style={{ flex: 1 }} />
                        <button
                          className="ad-btn-soft"
                          onClick={() => { if (!auto.live) doRestoreSnap(s.id) }}
                          style={{
                            border: '1px solid oklch(0.74 0.155 52 / .4)',
                            color: auto.live ? 'var(--text-faintest)' : 'var(--accent)', fontWeight: 600,
                          }}
                        >
                          Restore
                        </button>
                        <button className="ad-btn-soft" onClick={() => setSnapRow(null)}>
                          Keep
                        </button>
                      </>
                    ) : snapRow?.sid === s.id && snapRow.kind === 'rename' ? (
                      <>
                        <input
                          className="ad-input"
                          value={renameVal}
                          onChange={(e) => setRenameVal(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') doRenameSnap(s.id) }}
                          placeholder="Name — optional"
                          autoFocus
                          style={{ width: 220, fontSize: 12, padding: '5px 10px' }}
                        />
                        <div style={{ flex: 1 }} />
                        <button className="ad-btn-text" onClick={() => doRenameSnap(s.id)} style={memRowSize}>
                          Save
                        </button>
                        <button className="ad-btn-text" onClick={() => setSnapRow(null)} style={memRowSize}>
                          Cancel
                        </button>
                      </>
                    ) : snapRow?.sid === s.id && snapRow.kind === 'delete' ? (
                      <>
                        <span style={{ fontSize: 12.5, color: 'var(--text-2em)' }}>Delete this snapshot?</span>
                        <div style={{ flex: 1 }} />
                        <button className="ad-btn-text danger" onClick={() => doDeleteSnap(s.id)} style={{ ...memRowSize, fontWeight: 600 }}>
                          Delete
                        </button>
                        <button className="ad-btn-text" onClick={() => setSnapRow(null)} style={memRowSize}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <>
                        <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-2)' }}>
                          {s.name ?? 'Snapshot'}
                        </span>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)' }}>
                          {s.reason} · {s.version} · {s.size} · {s.files} {s.files === 1 ? 'file' : 'files'} · {s.when}
                        </span>
                        <div style={{ flex: 1 }} />
                        <button className="ad-btn-text" onClick={() => setSnapRow({ sid: s.id, kind: 'restore' })} style={memRowSize}>
                          Restore
                        </button>
                        <button
                          className="ad-btn-text"
                          onClick={() => { setRenameVal(s.name ?? ''); setSnapRow({ sid: s.id, kind: 'rename' }) }}
                          style={memRowSize}
                        >
                          Rename
                        </button>
                        <button className="ad-btn-text danger" onClick={() => setSnapRow({ sid: s.id, kind: 'delete' })} style={memRowSize}>
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            {/* §6.3 automatic-snapshot toggles */}
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hairline)' }}>
              <Eyebrow style={{ marginBottom: 4 }}>AUTOMATIC SNAPSHOTS</Eyebrow>
              {SNAP_SETTINGS.map(({ key, label, help }) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '7px 0' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-2)' }}>{label}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>{help}</div>
                  </div>
                  <Toggle
                    on={auto.snapshotSettings[key]}
                    onChange={() => setSnapSetting(key, !auto.snapshotSettings[key])}
                    title={auto.snapshotSettings[key] ? 'Turn this automatic snapshot off' : 'Turn this automatic snapshot on'}
                  />
                </div>
              ))}
            </div>
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
                agentName={(() => {
                  const g = s.agentId ? agents.find((z) => z.id === s.agentId) : undefined
                  return g ? (g.name || g.harness) : 'agent'
                })()}
              />
            ))}
          </div>
        </div>
      )}

      {/* spec */}
      {spec.length > 0 && (
        <div>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
            <div
              className="ad-hover-row"
              onClick={() => setSpecOpen(!specOpen)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', cursor: 'pointer' }}
            >
              <Eyebrow style={{ color: 'var(--text-faint)' }}>SPEC</Eyebrow>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>{auto.specMeta}</span>
              <div style={{ flex: 1 }} />
              <span style={{ color: 'var(--text-faintest)', fontSize: 11 }}>
                <i className={specOpen ? 'fa-solid fa-caret-up' : 'fa-solid fa-caret-down'} style={{ fontSize: 9 }} /> {specOpen ? 'collapse' : 'expand'}
              </span>
            </div>
            {specOpen && (
              <div style={{ borderTop: '1px solid var(--hairline)', padding: '8px 22px 18px' }}>
                <SpecMarkdown blocks={spec} />
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
              {' '}will be deleted — its triggers stop, and its versions and memory go with it. Past results stay in Executions.
              {auto.live && (
                <p style={{ color: 'var(--amber)', margin: '8px 0 0' }}>An execution is in progress — deleting cancels it.</p>
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
