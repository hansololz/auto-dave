// Create / edit flow (§11): Ask → Building → Review. Drafting/editing/syncing are §8
// backend jobs (POST /drafts + polling); this page renders the three phases and the
// Review dirty-gating, version menu, per-step agent menus, secrets and dry-run panels.
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Agent, Auto, Blocker, DraftPayload, SpecBlock, Step, VersionInfo } from '../types'
import { Badge, BtnGhost, BtnPrimary, Chip, ConfirmModal, Modal, PyCode, Toggle, paramSummary, resultChipColors, usePopover, validUrl } from '../ui'
import { Markdown } from '../result'

// ---------- helpers ----------

function dispModel(ag: Agent): string {
  const def = ({ 'Claude Code': 'Claude Sonnet 4.5', 'Gemini CLI': 'Gemini 2.5 Pro', 'Codex': 'GPT-5 Codex' } as Record<string, string>)[ag.harness] || 'Configured default'
  return ag.model === def ? 'Default configured model' : ag.model
}
const agName = (ag: Agent) => ag.name || ag.harness

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
function schedLabel(s?: { hour: number; min: number; dow: number | null } | null): string {
  if (!s) return 'No schedule'
  const t = `${s.hour}:${String(s.min || 0).padStart(2, '0')}`
  return s.dow == null ? `Daily at ${t}` : `${DAYS[s.dow]} at ${t}`
}

// markdown-ish text ↔ SpecBlock[] ('# ', '## ', '- ', plain lines)
function specToText(blocks: SpecBlock[]): string {
  return blocks.map((b) => (b.k === 'h1' ? '# ' + b.text : b.k === 'h2' ? '## ' + b.text : b.k === 'li' ? '- ' + b.text : b.text)).join('\n')
}
function textToSpec(text: string): SpecBlock[] {
  return text.split('\n').map((s) => s.trim()).filter(Boolean).map((s): SpecBlock =>
    s.startsWith('## ') ? { k: 'h2', text: s.slice(3) }
      : s.startsWith('# ') ? { k: 'h1', text: s.slice(2) }
        : s.startsWith('- ') ? { k: 'li', text: s.slice(2) }
          : { k: 'p', text: s })
}

// §11 Blocker panel: each blocker's reason + edited fix lands in the spec under
// a "Constraints & resolutions" section — the resolution lives in the document
// itself, so it survives later edits and syncs and versions like any spec text.
const CONSTRAINTS_TITLE = 'Constraints & resolutions'
function amendSpec(spec: SpecBlock[], blockers: Blocker[]): SpecBlock[] {
  const items: SpecBlock[] = blockers.map((b) => ({ k: 'li', text: `${b.reason.trim()} — ${b.fix.trim()}` }))
  const at = spec.findIndex((b) => b.k === 'h2' && b.text.trim().toLowerCase() === CONSTRAINTS_TITLE.toLowerCase())
  if (at < 0) return [...spec, { k: 'h2', text: CONSTRAINTS_TITLE }, ...items]
  let end = at + 1
  while (end < spec.length && spec[end].k !== 'h2' && spec[end].k !== 'h1') end++
  return [...spec.slice(0, end), ...items, ...spec.slice(end)]
}

const blockerLine = (b: Blocker) => `${b.reason.trim()} — ${b.fix.trim()}`

interface SecretRef { name: string; steps: number[] }
function secretRefsOf(steps: Step[]): SecretRef[] {
  const refs: SecretRef[] = []
  steps.forEach((s, i) => {
    for (const m of (s.code || '').matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)/g)) {
      const nm = m[1]
      let e = refs.find((z) => z.name === nm)
      if (!e) { e = { name: nm, steps: [] }; refs.push(e) }
      if (!e.steps.includes(i)) e.steps.push(i)
    }
  })
  return refs
}

const stepList = (idx: number[]) => idx.map((i) => i + 1).join(', ')

// The two §8 instruction files (framework-instructions.md, shown verbatim in the read-only
// Framework-instructions card, and default-build-instructions.md, the Build-instructions
// pre-fill). Loaded from the backend (GET /instructions) so both cards always show exactly
// what the agent is told.
let fwCache: string | null = null
let defaultBuildCache = ''

// §4.5 log-line kinds streamed by the §11 test run
function logColor(kind: string): string {
  if (kind === 'err') return 'var(--red)'
  if (kind === 'wrn') return 'var(--amber)'
  if (kind === 'out') return '#c6cdd6'
  return 'var(--text-faint)' // sys
}

// ---------- small shared bits ----------

const eyebrowStyle: React.CSSProperties = {
  font: "600 10px var(--mono)", letterSpacing: '.09em', color: 'var(--text-faint)',
}
const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden',
}

function CheckBox({ on }: { on: boolean }) {
  return (
    <span style={{
      width: 15, height: 15, borderRadius: 4, flex: 'none', display: 'inline-flex',
      alignItems: 'center', justifyContent: 'center',
      background: on ? 'var(--accent)' : 'transparent',
      border: `1px solid ${on ? 'var(--accent)' : 'rgba(255,255,255,.22)'}`,
    }}>
      {on && <i className="fa-solid fa-check" style={{ fontSize: 9, color: 'var(--on-accent)' }} />}
    </span>
  )
}

function WarnBanner({ text }: { text: string }) {
  return (
    <div style={{
      background: 'oklch(0.7 0.19 25 / .07)', border: '1px solid oklch(0.7 0.19 25 / .3)',
      borderRadius: 9, padding: '10px 12px', margin: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 9,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', flex: 'none', marginTop: 5 }} />
      <div style={{ font: "400 11.5px/1.5 var(--sans)", color: '#c6cdd6' }}>{text}</div>
    </div>
  )
}

/** §11 Blocker panel cards — one per blocker, three labeled fields pre-filled
 * from the agent's answer; the user edits any of them (usually the fix).
 * readOnly for spec-call blockers, where the cards are informational. */
function BlockerCards({ blockers, onChange, readOnly }: {
  blockers: Blocker[]; onChange?: (i: number, patch: Partial<Blocker>) => void; readOnly?: boolean
}) {
  const field = (label: string, value: string, rows: number, set: (v: string) => void, placeholder?: string) => (
    <div style={{ padding: '8px 16px 0' }}>
      <div style={eyebrowStyle}>{label}</div>
      {readOnly ? (
        value && (
          <div style={{ font: "400 12.5px/1.6 var(--sans)", color: '#c6cdd6', padding: '4px 0 6px' }}>{value}</div>
        )
      ) : (
        <textarea
          value={value} rows={rows} placeholder={placeholder}
          onChange={(e) => set(e.target.value)}
          style={{
            width: '100%', margin: '5px 0 2px', background: 'var(--bg-inset)',
            border: '1px solid rgba(255,255,255,.08)', borderRadius: 7, color: 'var(--text)',
            font: "400 12.5px/1.55 var(--sans)", padding: '7px 10px', resize: 'vertical', outline: 'none',
          }}
        />
      )}
    </div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
      {blockers.map((b, i) => (
        <div key={i} style={{ ...cardStyle, borderColor: 'oklch(0.75 0.13 75 / .35)', paddingBottom: 12, textAlign: 'left' }}>
          {field('REASON', b.reason, 2, (v) => onChange?.(i, { reason: v }))}
          {field('HOW TO FIX', b.fix, 2, (v) => onChange?.(i, { fix: v }), 'What should change so this can be built')}
          {field('DETAILS', b.details ?? '', 2, (v) => onChange?.(i, { details: v }))}
        </div>
      ))}
    </div>
  )
}

/** "Written by <agent>" / Review agent picker — prototype agpick menu. */
function AgentPick({ agents, selected, onPick }: {
  agents: Agent[]; selected: Agent | null; onPick: (g: Agent) => void
}) {
  const [open, setOpen, ref] = usePopover()
  return (
    <div ref={ref} style={{ position: 'relative', flex: 'none' }}>
      <button
        className="ad-btn-pill"
        onClick={() => setOpen(!open)}
        title="The agent that writes the spec and generates the steps"
      >
        <i className="fa-solid fa-robot" style={{ color: 'var(--text-faint)', fontSize: 9 }} />
        <span>{selected ? `${agName(selected)} · ${dispModel(selected)}` : 'No agent'}</span>
        <i className="fa-solid fa-caret-down" style={{ color: 'var(--text-faint)', fontSize: 9 }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth: 290, background: 'var(--bg-menu)',
          border: '1px solid rgba(255,255,255,.1)', borderRadius: 10, boxShadow: '0 18px 44px rgba(0,0,0,.5)',
          zIndex: 50, overflow: 'hidden', animation: 'adFadeUp .18s ease both',
        }}>
          {agents.map((g) => {
            const sel = !!selected && g.id === selected.id
            return (
              <div
                key={g.id}
                onClick={() => { setOpen(false); onPick(g) }}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', cursor: 'pointer',
                  borderBottom: '1px solid rgba(255,255,255,.04)',
                  background: sel ? 'oklch(0.74 0.155 52 / .07)' : 'transparent',
                }}
              >
                <span style={{ width: 14, flex: 'none', textAlign: 'center', font: "600 12px var(--mono)", color: 'var(--accent)' }}>{sel ? '✓' : ''}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ font: "600 12.5px var(--sans)", color: sel ? 'var(--text)' : '#c6cdd6' }}>{agName(g)}</div>
                  <div style={{ font: "400 11.5px/1.45 var(--mono)", color: 'var(--text-muted)', marginTop: 1 }}>{dispModel(g)}</div>
                </div>
              </div>
            )
          })}
          <div style={{ padding: '9px 14px', font: "400 11px/1.5 var(--sans)", color: 'var(--text-faintest)' }}>
            Writes the spec and generates the steps for this automation. Auto Dave still runs everything.
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- review working-copy state ----------

interface Rev {
  name: string
  desc: string
  note: string
  spec: SpecBlock[]
  steps: Step[]
  params: NonNullable<DraftPayload['params']>
  sched: { hour: number; min: number; dow: number | null } | null
  schedLabel: string
  instr: string
  enabledAgents: string[]
  allowedSecrets: string[]
  dirty: boolean
  dirtyWhy: 'spec' | 'agents' | 'secrets' | null
  touched: boolean
  specEdit: boolean
  specText: string
  specTextOrig: string
  instrEdit: boolean
  instrDraft: string | null
  ask: string
  syncBusy: boolean
  askBusy: boolean
  // §11: one repair modal, two entry points — a blocked `sync` and a failed
  // test run's issue analysis both land here; `resolved` is the session's
  // applied resolutions ("Previously resolved"). A blocked `edit` (ask box)
  // shows an amber notice under the ask box instead.
  repair: { source: 'sync' | 'test'; blockers: Blocker[] } | null
  resolved: string[]
  askBlockers: Blocker[] | null
  stepsMeta: string | null
  stepOpen: number | null
  viewing: 'draft' | number
  agSecOpen: boolean | null
  secSecOpen: boolean | null
  instrSecOpen: boolean | null
  fwOpen: boolean
}

const revDefaults = {
  dirty: false, dirtyWhy: null as Rev['dirtyWhy'], touched: false,
  specEdit: false, specText: '', specTextOrig: '',
  instrEdit: false, instrDraft: null as string | null,
  ask: '', syncBusy: false, askBusy: false,
  repair: null as Rev['repair'], resolved: [] as string[], askBlockers: null as Rev['askBlockers'],
  stepsMeta: null as string | null, stepOpen: null as number | null,
  viewing: 'draft' as Rev['viewing'],
  agSecOpen: null as boolean | null, secSecOpen: null as boolean | null, instrSecOpen: null as boolean | null, fwOpen: false,
}

function seedFromPayload(d: DraftPayload, agents: Agent[]): Rev {
  return {
    ...revDefaults,
    name: d.name || 'New automation', desc: d.desc || '', note: d.note || '',
    spec: d.spec ?? [], steps: d.steps ?? [], params: d.params ?? [],
    sched: d.schedule ?? null, schedLabel: schedLabel(d.schedule),
    instr: d.instr ?? defaultBuildCache, // backend seeds instr from default-build-instructions.md
    enabledAgents: agents.map((g) => g.id),
    allowedSecrets: [],
  }
}

function seedFromAuto(a: Auto, agents: Agent[], secretNames: string[]): Rev {
  const src: Pick<VersionInfo, 'spec' | 'steps' | 'instr'> & { params?: VersionInfo['params'] } =
    a.draft ?? { spec: a.spec ?? [], steps: a.steps ?? [], instr: a.instr || '', params: a.params }
  const refs = secretRefsOf(a.steps ?? [])
  return {
    ...revDefaults,
    name: a.name, desc: a.desc, note: '',
    spec: (src.spec ?? []).map((b) => ({ ...b })),
    steps: (src.steps ?? []).map((s) => ({ ...s })),
    params: (src.params ?? a.params ?? []).map((p) => ({ ...p })),
    sched: a.hour == null ? null : { hour: a.hour, min: a.min, dow: a.dow }, schedLabel: a.schedule,
    instr: src.instr || '',
    enabledAgents: a.stepAgents ? a.stepAgents.filter((id) => agents.some((g) => g.id === id)) : agents.map((g) => g.id),
    allowedSecrets: a.allowedSecrets
      ? a.allowedSecrets.filter((n) => secretNames.includes(n))
      : refs.filter((r) => secretNames.includes(r.name)).map((r) => r.name),
    touched: !!a.draft,
  }
}

function loadVersionInto(r: Rev, snap: { spec: SpecBlock[]; steps: Step[]; instr: string; params?: VersionInfo['params'] }, viewing: Rev['viewing']): Rev {
  return {
    ...r,
    spec: (snap.spec ?? []).map((b) => ({ ...b })),
    steps: (snap.steps ?? []).map((s) => ({ ...s })),
    params: snap.params ? snap.params.map((p) => ({ ...p })) : r.params,
    instr: snap.instr || '',
    specEdit: false, specText: '', specTextOrig: '', instrEdit: false, instrDraft: null,
    dirty: false, dirtyWhy: null, syncBusy: false, askBusy: false,
    repair: null, resolved: [], askBlockers: null, stepsMeta: null, stepOpen: null, ask: '',
    viewing,
  }
}

function finalizeSteps(steps: Step[], enabled: string[]): Step[] {
  return steps.map((s) => ({
    ...s,
    agentId: s.agent ? (s.agentId && enabled.includes(s.agentId) ? s.agentId : enabled[0] ?? null) : null,
  }))
}

function serializeDraft(r: Rev): DraftPayload {
  return {
    name: r.name, desc: r.desc, note: r.note,
    params: r.params,
    steps: finalizeSteps(r.steps, r.enabledAgents),
    spec: r.spec,
    instr: r.instr,
    schedule: r.sched ?? undefined,
  }
}

// ---------- step row (per-step agent menu) ----------

function StepRow({ step, i, open, onToggle, availAgents, onPickAgent }: {
  step: Step; i: number; open: boolean; onToggle: () => void
  availAgents: Agent[]; onPickAgent: (agentId: string) => void
}) {
  const [menuOpen, setMenuOpen, ref] = usePopover()
  const asg = step.agent
    ? (step.agentId ? availAgents.find((g) => g.id === step.agentId) ?? null : availAgents[0] ?? null)
    : null
  return (
    <div style={{ borderBottom: '1px solid rgba(255,255,255,.05)' }}>
      <div
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', cursor: 'pointer' }}
      >
        <span style={{ font: "500 11px var(--mono)", color: 'var(--text-faint)', width: 14, flex: 'none' }}>{i + 1}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ font: "600 12.5px var(--sans)" }}>{step.name}</div>
            {step.agent && (
              <div ref={ref} onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen) }}
                  title={asg
                    ? `This step calls ${agName(asg)} · ${dispModel(asg)} mid-run — click to switch`
                    : 'No agent is enabled for steps — this step would fail'}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    background: asg ? 'oklch(0.74 0.155 52 / .1)' : 'oklch(0.7 0.19 25 / .14)',
                    border: `1px solid ${asg ? 'oklch(0.74 0.155 52 / .3)' : 'oklch(0.7 0.19 25 / .4)'}`,
                    borderRadius: 6, padding: '2px 8px', font: "600 10px var(--mono)",
                    color: asg ? 'oklch(0.78 0.13 52)' : 'oklch(0.78 0.15 25)', cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  <i className="fa-solid fa-robot" style={{ fontSize: 8.5 }} /> {asg ? agName(asg) : 'no agent'}{' '}
                  <i className="fa-solid fa-caret-down" style={{ fontSize: 8, opacity: 0.7 }} />
                </button>
                {menuOpen && (
                  <div style={{
                    position: 'absolute', top: 'calc(100% + 5px)', left: 0, minWidth: 250, background: 'var(--bg-menu)',
                    border: '1px solid rgba(255,255,255,.1)', borderRadius: 10, boxShadow: '0 18px 44px rgba(0,0,0,.5)',
                    zIndex: 25, padding: 5, animation: 'adFadeUp .18s ease both',
                  }}>
                    {availAgents.map((g) => {
                      const sel = !!asg && g.id === asg.id
                      return (
                        <div
                          key={g.id}
                          onClick={(e) => { e.stopPropagation(); setMenuOpen(false); if (!sel) onPickAgent(g.id) }}
                          style={{
                            display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 12px', cursor: 'pointer',
                            borderRadius: 7, background: sel ? 'rgba(255,255,255,.04)' : 'transparent',
                          }}
                        >
                          <span style={{ width: 14, flex: 'none', textAlign: 'center', font: "600 12px var(--mono)", color: 'var(--accent)' }}>{sel ? '✓' : ''}</span>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ font: "600 12px var(--sans)", color: 'var(--text)', whiteSpace: 'nowrap' }}>{agName(g)}</div>
                            <div style={{ font: "400 11px var(--sans)", color: 'var(--text-muted)' }}>{dispModel(g)}</div>
                          </div>
                        </div>
                      )
                    })}
                    {availAgents.length === 0 && (
                      <div style={{ padding: '9px 12px', font: "400 11.5px/1.5 var(--sans)", color: 'oklch(0.78 0.15 25)' }}>
                        No agents enabled — turn one on under “Agents · available to steps”.
                      </div>
                    )}
                    <div style={{ padding: '8px 12px 6px', font: "400 10.5px/1.5 var(--sans)", color: 'var(--text-faintest)', borderTop: '1px solid rgba(255,255,255,.05)' }}>
                      The agent this step calls mid-run. Only agents enabled below are offered.
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          <div style={{ font: "400 11.5px/1.45 var(--sans)", color: 'var(--text-muted)' }}>{step.desc}</div>
        </div>
        <span style={{ color: '#4a515c', font: "400 11px var(--sans)", flex: 'none', whiteSpace: 'nowrap' }}>
          <i className={open ? 'fa-solid fa-caret-up' : 'fa-solid fa-caret-down'} style={{ fontSize: 9 }} /> {open ? 'hide script' : 'view script'}
        </span>
      </div>
      {open && (
        <>
          {step.agent && (
            <div style={{
              display: 'flex', gap: 9, alignItems: 'flex-start', borderTop: '1px solid rgba(255,255,255,.05)',
              background: 'oklch(0.74 0.155 52 / .05)', padding: '10px 20px 10px 44px', animation: 'adFadeUp .22s ease both',
            }}>
              <i className="fa-solid fa-robot" style={{ color: 'oklch(0.78 0.13 52)', fontSize: 10, marginTop: 3 }} />
              <span style={{ font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-muted)' }}>
                <span style={{ font: "500 11.5px var(--sans)", color: '#c6cdd6' }}>Why an agent: </span>{step.why || ''}
              </span>
            </div>
          )}
          <PyCode className="ad-copy" code={step.code || '# script not written yet'} style={{
            margin: 0, background: '#07090d', borderTop: '1px solid rgba(255,255,255,.05)',
            padding: '12px 20px 12px 44px', font: "400 11.5px/1.75 var(--mono)", color: '#9fb3c8',
            whiteSpace: 'pre-wrap', overflowWrap: 'break-word', minWidth: 0, animation: 'adFadeUp .22s ease both',
          }} />
        </>
      )}
    </div>
  )
}

// ---------- missing secret inline add ----------

function MissingSecretRow({ name, sub, onAdded }: { name: string; sub: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  const showToast = useStore((s) => s.showToast)
  const add = async () => {
    if (!val.trim() || busy) return
    setBusy(true)
    try {
      await api.putSecret(name, val)
      showToast('Saved to your Keychain.')
      onAdded()
    } catch (e) {
      showToast((e as Error).message)
    }
    setBusy(false)
  }
  return (
    <div style={{ borderBottom: '1px solid rgba(255,255,255,.05)' }}>
      <div
        onClick={() => setOpen(!open)}
        title={`Add ${name} to your Keychain`}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 20px', cursor: 'pointer', userSelect: 'none' }}
      >
        <span style={{ width: 15, height: 15, borderRadius: 4, flex: 'none', border: '1px dashed oklch(0.7 0.19 25 / .5)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: "500 12px var(--mono)", color: 'var(--text)' }}>{name}</div>
          <div style={{ font: "400 11.5px var(--sans)", color: 'var(--text-muted)' }}>{sub}</div>
        </div>
        <span style={{
          display: 'inline-flex', padding: '3px 8px', borderRadius: 6, font: "600 10px var(--mono)",
          background: 'oklch(0.7 0.19 25 / .14)', border: '1px solid oklch(0.7 0.19 25 / .4)',
          color: 'oklch(0.78 0.15 25)', flex: 'none', whiteSpace: 'nowrap',
        }}>
          add to Keychain
        </span>
      </div>
      {open && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '0 20px 12px 47px' }}>
          <input
            type="password" value={val} autoFocus placeholder="Value — goes straight to your Keychain"
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
            style={{
              flex: 1, minWidth: 0, background: 'var(--bg-inset)', border: '1px solid rgba(255,255,255,.09)',
              borderRadius: 7, color: 'var(--text)', font: "400 12px var(--mono)", padding: '7px 10px', outline: 'none',
            }}
          />
          <BtnPrimary onClick={() => void add()} disabled={!val.trim() || busy} style={{ padding: '6px 12px', fontSize: 12 }}>
            Add secret
          </BtnPrimary>
        </div>
      )}
    </div>
  )
}

// ---------- the page ----------

export default function CreateFlow() {
  const store = useStore()
  const { agents, secrets, autos, createFrom, autoId, go, setSurface, showToast, loadAuto, testrun, beginTestrun, clearTestrun, consumeTestIssue } = store
  const isEdit = createFrom === 'edit'
  const isOnboard = createFrom === 'onboard'
  const auto = isEdit ? autos.find((a) => a.id === autoId) ?? null : null

  const [phase, setPhase] = useState<'ask' | 'building' | 'review'>(isEdit ? 'review' : 'ask')
  const [text, setText] = useState('')
  const [askHint, setAskHint] = useState(false)
  const [textFocus, setTextFocus] = useState(false)
  const [agentId, setAgentId] = useState<string | null>(() =>
    isEdit ? (auto?.agentId ?? null) : ((agents.find((g) => g.default) ?? agents[0])?.id ?? null))

  const [buildStage, setBuildStage] = useState(0)
  const [buildErr, setBuildErr] = useState<{ msg: string; detail?: string[] } | null>(null)
  // §11 Blocker panel (Building screen): `spec` is call 1's spec for the
  // steps-call case (amended + rebuilt from here); `resolved` lists this
  // session's earlier resolutions so a fix that didn't take is visible.
  const [blocked, setBlocked] = useState<{
    at: 'spec' | 'steps'; blockers: Blocker[]; spec: SpecBlock[] | null; resolved: string[]
  } | null>(null)
  const jobIdRef = useRef<string | null>(null)

  const [rev, setRev] = useState<Rev | null>(null)
  const [confirmSpecCancel, setConfirmSpecCancel] = useState(false)
  // Blocker-modal apply travels through Modal's animated close (ConfirmModal pattern).
  const applyBlockedRef = useRef(false)
  const draftSnap = useRef<Rev | null>(null)
  const seededRef = useRef(false)

  const up = (patch: Partial<Rev>) => setRev((r) => (r ? { ...r, ...patch } : r))

  // ---- polling ----
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  const startPoll = (
    jobId: string,
    onDone: (d: DraftPayload) => void,
    onFail: (msg: string, detail?: string[]) => void,
    onCancelled?: () => void,
    onBlocked?: (blockers: Blocker[], at: 'spec' | 'steps', spec: SpecBlock[] | null) => void,
  ) => {
    stopPoll()
    jobIdRef.current = jobId
    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const j = await api.getDraftJob(jobId)
          if (j.stage) setBuildStage(/step/i.test(j.stage) ? 1 : 0)
          if (j.status === 'done') {
            stopPoll()
            if (j.draft) onDone(j.draft)
            else onFail('The agent returned an empty draft.')
          } else if (j.status === 'blocked') {
            stopPoll()
            if (onBlocked) onBlocked(j.blockers ?? [], j.blockedAt ?? 'steps', j.draft?.spec ?? null)
            else onFail(j.error || 'Your AI hit a blocker.')
          } else if (j.status === 'failed') {
            stopPoll()
            onFail(j.error || '', j.errorDetail)
          } else if (j.status === 'cancelled') {
            stopPoll()
            onCancelled?.()
          }
        } catch (e) {
          stopPoll()
          onFail((e as Error).message)
        }
      })()
    }, 700)
  }
  useEffect(() => () => {
    stopPoll()
    // Leaving the editor abandons any live test run — it's ephemeral (§11).
    const t = useStore.getState().testrun
    if (t?.status === 'running') void api.cancelTestRun(t.runId).catch(() => { /* already gone */ })
    useStore.getState().clearTestrun()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- guards + edit-mode seeding ----
  useEffect(() => {
    if (!isEdit && !isOnboard && agents.length === 0) {
      setSurface('app')
      go('agents')
      showToast('No agent yet — add one here first. Creating and editing automations needs an AI.', 3600)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isEdit && autoId) void loadAuto(autoId)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- instruction files (§8) — fetched once per app session ----
  const [fw, setFw] = useState<string>(fwCache ?? '')
  useEffect(() => {
    if (fwCache) return
    api.instructions()
      .then(({ framework, defaultBuild }) => {
        fwCache = framework
        defaultBuildCache = defaultBuild
        setFw(framework)
      })
      .catch(() => { /* panel renders empty; next mount retries */ })
  }, [])

  useEffect(() => {
    if (!isEdit || seededRef.current || !auto || !auto.spec) return
    seededRef.current = true
    setRev(seedFromAuto(auto, agents, secrets.map((s) => s.name)))
    if (auto.agentId) setAgentId(auto.agentId)
    setPhase('review')
  }, [auto, isEdit, agents, secrets])

  const selAgent = agents.find((g) => g.id === agentId) ?? agents.find((g) => g.default) ?? agents[0] ?? null

  // ---- ask → building ----
  const submitAsk = async () => {
    if (!text.trim()) { setAskHint(true); return }
    setAskHint(false)
    setBuildErr(null)
    setBlocked(null)
    setBuildStage(0)
    setPhase('building')
    try {
      const { jobId } = await api.postDraftJob({ mode: 'create', text: text.trim(), agentId })
      startPoll(
        jobId,
        (d) => { setRev(seedFromPayload(d, agents)); setPhase('review') },
        (msg, detail) => setBuildErr({ msg, detail }),
        () => setPhase('ask'),
        (blockers, at, spec) => setBlocked({ at, blockers, spec, resolved: [] }),
      )
    } catch (e) {
      setBuildErr({ msg: (e as Error).message })
    }
  }
  const cancelBuild = () => {
    stopPoll()
    if (jobIdRef.current) void api.cancelDraftJob(jobIdRef.current).catch(() => { /* already gone */ })
    setBuildErr(null)
    setBlocked(null)
    setPhase('ask')
  }

  // §11 Blocker panel, steps-call case: write each card (edited text) into the
  // spec's "Constraints & resolutions" section, then rebuild the steps against
  // the amended spec — one §8 `sync` call; the checklist re-enters step 2.
  const applyBlockers = async () => {
    if (!blocked?.spec || blocked.blockers.some((b) => !b.reason.trim() || !b.fix.trim())) return
    const spec = amendSpec(blocked.spec, blocked.blockers)
    const resolved = [...blocked.resolved, ...blocked.blockers.map(blockerLine)]
    setBlocked(null)
    setBuildStage(1)
    try {
      const { jobId } = await api.postDraftJob({
        mode: 'sync', agentId, current: { spec, instr: defaultBuildCache },
      })
      startPoll(
        jobId,
        (d) => {
          const r = seedFromPayload(d, agents)
          // sync payloads never carry the spec (or, without a manifest name, a
          // useful one) — the amended spec and its # title are the truth here.
          setRev({ ...r, spec, name: d.name || spec.find((b) => b.k === 'h1')?.text || r.name })
          setPhase('review')
        },
        (msg, detail) => setBuildErr({ msg, detail }),
        () => setPhase('ask'),
        (blockers, at, sp) => setBlocked({ at, blockers, spec: sp ?? spec, resolved }),
      )
    } catch (e) {
      setBuildErr({ msg: (e as Error).message })
    }
  }

  // ---- review: derived ----
  const availAgents = rev ? rev.enabledAgents.map((id) => agents.find((g) => g.id === id)).filter((g): g is Agent => !!g) : []
  const resolveAg = (s: Step): Agent | null =>
    s.agentId ? availAgents.find((g) => g.id === s.agentId) ?? null : availAgents[0] ?? null
  const agentStepIdx = rev ? rev.steps.map((s, i) => (s.agent ? i : -1)).filter((i) => i >= 0) : []
  const secRefs = rev ? secretRefsOf(rev.steps) : []
  const secNotAllowed = secRefs.filter((r) => secrets.some((z) => z.name === r.name) && !(rev?.allowedSecrets ?? []).includes(r.name))
  const secMissing = secRefs.filter((r) => !secrets.some((z) => z.name === r.name))
  const agWarn = !!rev && agentStepIdx.length > 0 && availAgents.length === 0
  const secWarn = !!rev && (secNotAllowed.length > 0 || secMissing.length > 0)
  const agSecOpenEff = ((rev?.agSecOpen ?? null) == null ? isEdit : !!rev?.agSecOpen) || agWarn
  const secSecOpenEff = ((rev?.secSecOpen ?? null) == null ? isEdit : !!rev?.secSecOpen) || secWarn
  const instrOpenEff = (rev?.instrSecOpen ?? null) == null ? isEdit : !!rev?.instrSecOpen
  const viewingOld = isEdit && !!rev && !!auto && rev.viewing !== 'draft' && rev.viewing !== auto.version
  const saveBlocked = !!rev && (rev.dirty || rev.syncBusy || rev.askBusy || rev.specEdit)
  const busyRewrite = !!rev && (rev.syncBusy || rev.askBusy)

  // ---- review: agent-ask + sync jobs ----
  const currentSerialized = () => (rev ? serializeDraft(rev) : null)

  // §11: the ask box runs one §8 `edit` job (spec call only) — the drafting
  // agent gets the in-editor draft (spec + steps + build instructions) and
  // grants context and returns the rewritten spec. The steps stay untouched:
  // the new spec lands out of sync and the sync banner rebuilds them later.
  const sendAsk = async () => {
    if (!rev || rev.syncBusy || rev.askBusy) return
    if (!rev.ask.trim()) { showToast('Type the change you want first.'); return }
    const request = rev.ask.trim()
    up({
      specEdit: false, specText: '', specTextOrig: '', instrDraft: null, instrEdit: false, // one edit at a time
      ask: '', askBusy: true, askBlockers: null, touched: true,
    })
    try {
      const { jobId } = await api.postDraftJob({
        mode: 'edit', text: request, ...(isEdit && auto ? { autoId: auto.id } : {}),
        agentId, current: currentSerialized(),
        enabledAgents: rev.enabledAgents, allowedSecrets: rev.allowedSecrets,
      })
      startPoll(
        jobId,
        (d) => {
          setRev((r) => r && ({
            ...r, askBusy: false,
            spec: d.spec ?? r.spec, dirty: true, dirtyWhy: 'spec',
          }))
          showToast('Spec updated — the workflow is out of sync. Sync the steps before saving.', 5800)
        },
        (msg) => {
          setRev((r) => r && ({ ...r, askBusy: false }))
          showToast(msg || 'The spec didn’t validate — try again or rephrase.', 4500)
        },
        () => setRev((r) => r && ({ ...r, askBusy: false })),
        // §11: a blocked edit call shows a persistent amber notice under the
        // ask box — the draft is untouched, the user rephrases the request.
        (blockers) => setRev((r) => r && ({ ...r, askBusy: false, askBlockers: blockers })),
      )
    } catch (e) {
      up({ askBusy: false })
      showToast((e as Error).message)
    }
  }

  // §11: a blocked sync opens the repair modal; applying amends the in-editor
  // spec (specOverride) and re-runs the sync with it.
  const runSync = async (specOverride?: SpecBlock[]) => {
    if (!rev || rev.syncBusy || rev.askBusy) return
    up({
      specEdit: false, specText: '', specTextOrig: '', instrDraft: null, instrEdit: false, // discard unsaved edits
      syncBusy: true, touched: true,
      ...(specOverride ? { spec: specOverride } : {}),
    })
    try {
      const { jobId } = await api.postDraftJob({
        mode: 'sync', ...(isEdit && auto ? { autoId: auto.id } : {}),
        agentId, current: { ...serializeDraft(rev), spec: specOverride ?? rev.spec },
        enabledAgents: rev.enabledAgents, allowedSecrets: rev.allowedSecrets,
      })
      startPoll(
        jobId,
        (d) => {
          setRev((r) => {
            if (!r) return r
            const steps = (d.steps ?? r.steps).map((s) => ({
              ...s,
              agentId: s.agent && s.agentId && !r.enabledAgents.includes(s.agentId) ? r.enabledAgents[0] ?? null : s.agentId,
            }))
            return {
              ...r, syncBusy: false, dirty: false, dirtyWhy: null,
              steps, params: d.params ?? r.params, stepsMeta: 'synced just now', stepOpen: null,
            }
          })
          showToast('Steps synced with the spec — review them, then save.', 3600)
        },
        (msg) => {
          setRev((r) => r && ({ ...r, syncBusy: false }))
          showToast(`The draft didn’t validate — try again or rephrase.${msg ? ' ' + msg : ''}`, 4500)
        },
        () => setRev((r) => r && ({ ...r, syncBusy: false })),
        (blockers) => setRev((r) => r && ({
          ...r, syncBusy: false, repair: { source: 'sync', blockers },
        })),
      )
    } catch (e) {
      up({ syncBusy: false })
      showToast((e as Error).message)
    }
  }

  // §11 repair modal apply — same door for both sources: write the edited cards
  // into the spec's "Constraints & resolutions" section, then sync the steps.
  const applyRepair = () => {
    if (!rev?.repair) return
    const { blockers } = rev.repair
    if (blockers.some((b) => !b.reason.trim() || !b.fix.trim())) return
    up({ repair: null, resolved: [...rev.resolved, ...blockers.map(blockerLine)] })
    void runSync(amendSpec(rev.spec, blockers))
  }

  // §11: a failed test run's issue analysis lands in the same repair modal.
  useEffect(() => {
    if (!testrun?.issue || !rev) return
    up({ repair: { source: 'test', blockers: testrun.issue } })
    consumeTestIssue()
  }, [testrun?.issue]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- version menu (edit mode) ----
  const [verOpen, setVerOpen, verRef] = usePopover()
  const pickVersion = (key: 'draft' | number) => {
    if (!auto || !rev) return
    setVerOpen(false)
    if (rev.viewing === key) return
    if (rev.viewing === 'draft' && (rev.touched || auto.draft)) {
      draftSnap.current = rev
      void api.putDraft(auto.id, serializeDraft(rev)).catch(() => { /* keep local snapshot */ })
    }
    if (key === 'draft') {
      if (draftSnap.current) setRev({ ...draftSnap.current, viewing: 'draft' })
      else if (auto.draft) setRev(seedFromAuto(auto, agents, secrets.map((s) => s.name)))
      else setRev((r) => r && loadVersionInto(r, { spec: auto.spec ?? [], steps: auto.steps ?? [], instr: auto.instr, params: auto.params }, 'draft'))
    } else if (key === auto.version) {
      setRev((r) => r && loadVersionInto(r, { spec: auto.spec ?? [], steps: auto.steps ?? [], instr: auto.instr, params: auto.params }, key))
    } else {
      const s = (auto.versions ?? []).find((v) => v.v === key)
      if (s) setRev((r) => r && loadVersionInto(r, s, key))
    }
  }

  // ---- leave / start over / save ----
  const close = async () => {
    stopPoll()
    if (isEdit && auto) {
      if (rev && rev.viewing === 'draft' && (rev.touched || auto.draft)) {
        try { await api.putDraft(auto.id, serializeDraft(rev)) } catch { /* backend restarting */ }
        showToast('Draft kept — resume or run it from this automation anytime.', 3400)
      }
      setSurface('app')
      go('automation')
      return
    }
    if (isOnboard) { setSurface('onboard'); return }
    setSurface('app')
    go('automations')
  }

  const startOver = async () => {
    if (isEdit && auto) {
      // Discard draft → back to detail
      try { await api.deleteDraft(auto.id) } catch { /* none saved yet */ }
      draftSnap.current = null
      setSurface('app')
      go('automation')
      showToast(`Changes discarded — back to v${auto.version} as saved.`, 3200)
      return
    }
    stopPoll()
    setRev(null)
    setBuildErr(null)
    setBlocked(null)
    setPhase('ask')
  }

  const doSave = async () => {
    if (!rev || saveBlocked) return
    try {
      if (isEdit && auto) {
        if (typeof rev.viewing === 'number' && rev.viewing !== auto.version) {
          const { version } = await api.restore(auto.id, rev.viewing)
          setSurface('app')
          go('automation')
          showToast(`v${rev.viewing} restored as version ${version} — earlier versions stay in the Version menu.`, 3200)
        } else {
          const { version } = await api.saveVersion(auto.id, {
            draft: serializeDraft(rev), agentId,
            stepAgents: rev.enabledAgents, allowedSecrets: rev.allowedSecrets,
          })
          setSurface('app')
          go('automation')
          showToast(auto.live
            ? `Version ${version} saved. The run in progress finishes on v${version - 1} — v${version} applies from the next run.`
            : `Version ${version} saved — earlier versions are in the Version menu when you edit.`, 3200)
        }
      } else {
        const created = await api.createAuto({
          draft: serializeDraft(rev), name: rev.name, agentId,
          stepAgents: rev.enabledAgents, allowedSecrets: rev.allowedSecrets,
        })
        // The detail page guards against unknown ids — make sure the store
        // knows the new automation before navigating (WS refresh may lag).
        await useStore.getState().loadAuto(created.id)
        if (isOnboard) localStorage.setItem('ad-onboarded', '1')
        setSurface('app')
        go('automation', { autoId: created.id })
        showToast('Created — nothing has run yet. Press Run now when you’re ready.', 3600)
      }
    } catch (e) {
      showToast((e as Error).message)
    }
  }

  const skipOnboard = () => {
    localStorage.setItem('ad-onboarded', '1')
    setSurface('app')
    go('automations')
  }

  // ---- test run (§11: create and edit mode) — runs the draft's REAL steps ----
  const runTest = async () => {
    if (!rev || testrun?.status === 'running') return
    clearTestrun()
    try {
      const { runId } = await api.postTestRun({
        draft: serializeDraft(rev),
        ...(isEdit && auto ? { autoId: auto.id } : {}), // edit: scratch memory copies the automation's
        agentId, // the drafting agent also runs the §8 issue analysis on failure
        enabledAgents: rev.enabledAgents, allowedSecrets: rev.allowedSecrets,
      })
      beginTestrun(runId)
    } catch (e) {
      showToast((e as Error).message)
    }
  }
  const cancelTest = () => {
    if (testrun?.status === 'running') void api.cancelTestRun(testrun.runId).catch(() => { /* already done */ })
  }

  // Create-mode param editing (§4.2 behaviors): edits write both the merged display
  // field and the definition's default — create_automation starts with empty
  // param_values, so the default IS the initial value.
  const updParam = (name: string, patch: Record<string, unknown>) => {
    setRev((r) => r && ({ ...r, params: r.params.map((p) => (p.name === name ? { ...p, ...patch } : p)) }))
  }

  // ---------- render ----------
  const isReview = phase === 'review'
  const backLabel = isEdit ? (auto?.name ?? 'Automation') : isOnboard ? 'Back' : 'Automations'

  return (
    <div style={{
      minHeight: '100%', display: 'flex', flexDirection: 'column',
      background: isOnboard ? 'radial-gradient(1000px 480px at 50% -12%, oklch(0.74 0.155 52 / .05), transparent 70%), #0b0e12' : 'transparent',
    }}>
      {/* header */}
      <div style={{ flex: 'none', padding: `${isReview && isOnboard ? '38px' : '20px'} 0 0`, animation: 'adFadeUp .4s ease' }}>
        <div style={{
          maxWidth: isReview ? 1800 : 620, margin: '0 auto',
          padding: `0 30px 0 ${isReview ? '30px' : '32px'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <button className="ad-btn-text" onClick={() => void close()} style={{ font: "500 12.5px var(--sans)", padding: '4px 0' }}>
            <i className="fa-solid fa-chevron-left" style={{ fontSize: 10 }} /> {backLabel}
          </button>
          {isOnboard && <span style={{ font: "500 11px var(--mono)", color: 'var(--text-faint)' }}>Step 3 of 3</span>}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {/* ============ ASK ============ */}
        {phase === 'ask' && (
          <div style={{ maxWidth: 620, margin: '0 auto', padding: '44px 32px 60px', animation: 'adFadeUp .4s ease' }}>
            <h1 style={{ font: "600 26px/1.25 var(--sans)", letterSpacing: '-.02em', margin: '0 0 10px' }}>
              What should Auto Dave do for you?
            </h1>
            <p style={{ font: "400 14.5px/1.6 var(--sans)", color: 'var(--text-2)', margin: '0 0 22px' }}>
              Describe the job in plain words. Your AI writes it as scripts — you review everything before it runs.
            </p>
            <textarea
              value={text} rows={4} autoFocus
              placeholder="Check the manga I follow for new chapters every morning at 8."
              onChange={(e) => { setText(e.target.value); if (e.target.value.trim()) setAskHint(false) }}
              onFocus={() => setTextFocus(true)} onBlur={() => setTextFocus(false)}
              style={{
                width: '100%', background: 'var(--bg-card)',
                border: `1px solid ${textFocus ? 'oklch(0.74 0.155 52 / .6)' : 'rgba(255,255,255,.1)'}`,
                borderRadius: 10, color: 'var(--text)', font: "400 15px/1.55 var(--sans)",
                padding: 16, resize: 'vertical', outline: 'none',
              }}
            />
            <div style={{ margin: '16px 0 30px' }}>
              <div style={eyebrowStyle}>OR START FROM AN EXAMPLE</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {[
                  { label: 'Track manga chapters', icon: 'fa-book-open', s: 'Check the manga I follow for new chapters every morning at 8.' },
                  { label: 'Back up a folder every night', icon: 'fa-box-archive', s: 'Back up my Projects folder to the Vault drive every night at 2.' },
                  { label: 'Email me a weekly report', icon: 'fa-envelope', s: 'Gather the week’s numbers and email the team a summary every Monday at 9.' },
                  { label: 'Watch a product’s price', icon: 'fa-tag', s: 'Watch the price of the keyboard I want and tell me when it drops below €120.' },
                  { label: 'Tidy my screenshots folder', icon: 'fa-broom', s: 'File my desktop screenshots into monthly folders every Sunday night.' },
                ].map((c) => (
                  <button key={c.label} className="ad-chip-btn" onClick={() => { setText(c.s); setAskHint(false) }}>
                    <i className={`fa-solid ${c.icon}`} />
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 18px' }}>
              <span style={{ font: "400 11.5px var(--sans)", color: 'var(--text-faintest)' }}>Written by</span>
              <AgentPick
                agents={agents} selected={selAgent}
                onPick={(g) => { setAgentId(g.id) }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <BtnPrimary onClick={() => void submitAsk()} style={{ padding: '10px 18px', fontSize: 13.5 }}>
                Draft the automation
              </BtnPrimary>
              {isOnboard && (
                <button className="ad-btn-text dim" onClick={skipOnboard} style={{ font: "500 12.5px var(--sans)", padding: '6px 2px' }}>
                  Skip for now
                </button>
              )}
              {askHint && (
                <span style={{ font: "400 12px var(--sans)", color: 'var(--amber)' }}>
                  Describe the job first — one sentence is enough.
                </span>
              )}
            </div>
          </div>
        )}

        {/* ============ BUILDING ============ */}
        {phase === 'building' && !buildErr && blocked && (
          <div style={{
            maxWidth: 660, margin: '0 auto', display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: 18, padding: '48px 32px 60px', animation: 'adFadeUp .3s ease',
          }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--amber)' }} />
            <div style={{ font: "600 16px var(--sans)", color: 'var(--text)' }}>
              {blocked.blockers.length > 1 ? `Your AI hit ${blocked.blockers.length} blockers` : 'Your AI hit a blocker'}
            </div>
            <div style={{ font: "400 13px/1.6 var(--sans)", color: 'var(--text-2)', textAlign: 'center', margin: '-8px 0 2px' }}>
              {blocked.at === 'steps'
                ? 'It couldn’t build the steps as the spec asks. Edit the fix below, then apply it to the spec and rebuild.'
                : 'It couldn’t write a spec for this request. Rephrase the request with the advice below.'}
            </div>
            <BlockerCards
              blockers={blocked.blockers}
              readOnly={blocked.at === 'spec'}
              onChange={(i, patch) => setBlocked((z) => z && ({
                ...z, blockers: z.blockers.map((b, k) => (k === i ? { ...b, ...patch } : b)),
              }))}
            />
            {blocked.resolved.length > 0 && (
              <div style={{ width: '100%', font: "400 11.5px/1.7 var(--sans)", color: 'var(--text-faint)' }}>
                <div style={eyebrowStyle}>PREVIOUSLY RESOLVED</div>
                {blocked.resolved.map((s, i) => <div key={i}>– {s}</div>)}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              {blocked.at === 'steps' ? (
                <>
                  <BtnGhost onClick={() => { setBlocked(null); setPhase('ask') }}>Back</BtnGhost>
                  <BtnPrimary
                    onClick={() => void applyBlockers()}
                    disabled={blocked.blockers.some((b) => !b.reason.trim() || !b.fix.trim())}
                  >
                    Apply to the spec & rebuild the steps
                  </BtnPrimary>
                </>
              ) : (
                <BtnPrimary onClick={() => { setBlocked(null); setPhase('ask') }}>Back to the request</BtnPrimary>
              )}
            </div>
          </div>
        )}
        {phase === 'building' && !buildErr && !blocked && (
          <div style={{
            minHeight: 420, height: '100%', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 28, padding: 40,
          }}>
            <span style={{
              width: 30, height: 30, border: '2.5px solid rgba(255,255,255,.1)', borderTopColor: 'var(--accent)',
              borderRadius: '50%', animation: 'adSpin .9s linear infinite',
            }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
              {['Writing the spec', 'Generating the steps'].map((label, i) => {
                const done = buildStage > i
                const cur = buildStage === i
                return (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                    <i
                      className={done ? 'fa-solid fa-check' : cur ? 'fa-solid fa-circle' : 'fa-regular fa-circle'}
                      style={{ width: 16, textAlign: 'center', fontSize: 12, color: done ? 'var(--green)' : cur ? 'var(--accent)' : '#4a515c' }}
                    />
                    <span style={{ font: "500 14px var(--sans)", color: done ? '#c6cdd6' : cur ? 'var(--text)' : 'var(--text-faint)' }}>{label}</span>
                  </div>
                )
              })}
            </div>
            <div style={{ font: "500 11px var(--mono)", color: 'var(--text-faintest)' }}>
              {selAgent ? `${agName(selAgent)} · ${dispModel(selAgent)}` : 'No agent'}
            </div>
            <BtnGhost onClick={cancelBuild}>Cancel</BtnGhost>
          </div>
        )}

        {phase === 'building' && buildErr && (
          <div style={{
            minHeight: 420, height: '100%', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 18, padding: 40, animation: 'adFadeUp .3s ease',
          }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--red)' }} />
            <div style={{ font: "500 14.5px var(--sans)", color: 'var(--text)' }}>
              {buildErr.msg || 'The draft didn’t validate — try again or rephrase.'}
            </div>
            {(buildErr.detail ?? []).length > 0 && (
              <div style={{
                maxWidth: 560, background: 'var(--bg-inset)', border: '1px solid rgba(255,255,255,.07)',
                borderRadius: 9, padding: '10px 14px', font: "400 11.5px/1.7 var(--mono)", color: 'var(--text-muted)',
              }}>
                {(buildErr.detail ?? []).map((d, i) => <div key={i}>{d}</div>)}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <BtnGhost onClick={() => { setBuildErr(null); setPhase('ask') }}>Back</BtnGhost>
              <BtnPrimary onClick={() => void submitAsk()}>Try again</BtnPrimary>
            </div>
          </div>
        )}

        {/* ============ REVIEW ============ */}
        {phase === 'review' && !rev && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
            <span style={{
              width: 24, height: 24, border: '2.5px solid rgba(255,255,255,.1)', borderTopColor: 'var(--accent)',
              borderRadius: '50%', animation: 'adSpin .9s linear infinite',
            }} />
          </div>
        )}
        {phase === 'review' && rev && (
          <div style={{ maxWidth: 1800, margin: '0 auto', padding: '14px 30px 60px', animation: 'adFadeUp .4s ease' }}>
            {/* title row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 13, margin: '0 0 6px' }}>
              <h1 style={{
                font: "600 20px var(--sans)", letterSpacing: '-.01em', margin: 0,
                minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {isEdit ? `Edit “${auto?.name ?? 'automation'}”` : 'Review before creating'}
              </h1>
              {isEdit && auto && (
                <div ref={verRef} style={{ position: 'relative' }}>
                  <button className="ad-btn-pill" onClick={() => setVerOpen(!verOpen)}>
                    <span>{rev.viewing === 'draft' ? 'Draft' : `v${rev.viewing}${rev.viewing === auto.version ? ' · current' : ''}`}</span>
                    <i className="fa-solid fa-caret-down" style={{ color: 'var(--text-faint)', fontSize: 9 }} />
                  </button>
                  {verOpen && (
                    <div style={{
                      position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth: 360, background: 'var(--bg-menu)',
                      border: '1px solid rgba(255,255,255,.1)', borderRadius: 10, boxShadow: '0 18px 44px rgba(0,0,0,.5)',
                      zIndex: 50, overflow: 'hidden', animation: 'adFadeUp .18s ease both',
                    }}>
                      {([
                        {
                          key: 'draft' as const, label: 'Draft',
                          sub: 'your working copy — unsaved',
                        },
                        {
                          key: auto.version, label: `v${auto.version}`,
                          sub: 'current · ' + (((auto.specMeta || '').split('·')[1] || '').trim()),
                        },
                        ...(auto.versions ?? []).map((v) => ({
                          key: v.v, label: `v${v.v}`, sub: v.when + (v.note ? ' · ' + v.note : ''),
                        })),
                      ]).map((it) => {
                        const sel = rev.viewing === it.key
                        return (
                          <div
                            key={String(it.key)}
                            onClick={() => pickVersion(it.key)}
                            style={{
                              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', cursor: 'pointer',
                              borderBottom: '1px solid rgba(255,255,255,.04)',
                              background: sel ? 'oklch(0.74 0.155 52 / .07)' : 'transparent',
                            }}
                          >
                            <span style={{ width: 14, flex: 'none', textAlign: 'center', font: "600 12px var(--mono)", color: 'var(--accent)' }}>{sel ? '✓' : ''}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ font: "600 12.5px var(--mono)", color: sel ? 'var(--text)' : '#c6cdd6' }}>{it.label}</div>
                              <div style={{ font: "400 11.5px/1.45 var(--sans)", color: 'var(--text-muted)', marginTop: 1 }}>{it.sub}</div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
              <AgentPick
                agents={agents} selected={selAgent}
                onPick={(g) => {
                  if (busyRewrite) { showToast('Wait for the current rewrite to finish first.'); return }
                  if (selAgent && selAgent.id === g.id) return
                  setAgentId(g.id)
                  if (isEdit) up({ touched: true })
                  showToast(`${agName(g)} · ${dispModel(g)} now writes the spec and steps here.`, 3000)
                }}
              />
              <div style={{ flex: 1 }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
                {saveBlocked && (
                  <span style={{ font: "400 12px var(--sans)", color: 'var(--amber)' }}>
                    {rev.syncBusy ? 'Syncing steps…'
                      : rev.askBusy ? 'Rewriting the spec…'
                        : rev.specEdit ? 'Finish editing the spec first — save or cancel your edits'
                          : 'Sync and review the steps before saving'}
                  </span>
                )}
                <button className="ad-btn-text dim" onClick={() => void startOver()} style={{ font: "500 12.5px var(--sans)", padding: '6px 4px' }}>
                  {isEdit ? 'Discard draft' : 'Start over'}
                </button>
                <BtnPrimary onClick={() => void doSave()} disabled={saveBlocked} style={{ padding: '9px 16px' }}>
                  {isEdit && auto
                    ? (viewingOld ? `Restore v${rev.viewing} as v${auto.version + 1}` : `Save as v${auto.version + 1}`)
                    : 'Create automation'}
                </BtnPrimary>
              </div>
            </div>
            <p style={{ font: "400 13.5px/1.6 var(--sans)", color: 'var(--text-2)', margin: '0 0 20px' }}>
              Read what your AI wrote. Change anything — nothing runs until you create it.
            </p>

            {/* old-version banner */}
            {viewingOld && auto && (
              <div style={{
                background: 'oklch(0.74 0.155 52 / .07)', border: '1px solid oklch(0.74 0.155 52 / .3)',
                borderRadius: 10, padding: '11px 16px', margin: '0 0 18px',
                display: 'flex', alignItems: 'center', gap: 11, animation: 'adFadeUp .3s ease both',
              }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', flex: 'none' }} />
                <span style={{ flex: 1, font: "400 12.5px/1.5 var(--sans)", color: 'var(--text)' }}>
                  {`Loaded v${rev.viewing} from history. Saving restores it as v${auto.version + 1} — your draft stays in the Version menu.`}
                </span>
                <button className="ad-btn-soft" onClick={() => pickVersion('draft')} style={{ borderRadius: 7, font: "500 12px var(--sans)", padding: '6px 12px', flex: 'none' }}>
                  Back to draft
                </button>
              </div>
            )}

            {/* live-run note */}
            {isEdit && auto?.live && (
              <div style={{
                background: 'oklch(0.78 0.12 210 / .07)', border: '1px solid oklch(0.78 0.12 210 / .3)',
                borderRadius: 10, padding: '11px 16px', margin: '0 0 18px',
                display: 'flex', alignItems: 'center', gap: 11, animation: 'adFadeUp .3s ease both',
              }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--cyan)', animation: 'adPulse 1.4s ease-in-out infinite', flex: 'none' }} />
                <span style={{ flex: 1, font: "400 12.5px/1.5 var(--sans)", color: 'var(--text)' }}>
                  {`A run is happening right now on v${auto.version}. Saving won’t interrupt it — that run finishes on v${auto.version}. v${auto.version + 1} takes over from the next run (${auto.schedule.toLowerCase()}).`}
                </span>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,.95fr)', gap: 18, alignItems: 'start' }}>
              {/* ===== left column ===== */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* SPEC */}
                <div style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
                    <span style={eyebrowStyle}>SPEC</span>
                    {!rev.specEdit ? (
                      <button
                        className="ad-btn-soft"
                        onClick={() => {
                          if (busyRewrite) return
                          const t = specToText(rev.spec)
                          up({ instrDraft: null, instrEdit: false, specText: t, specTextOrig: t, specEdit: true })
                        }}
                      >
                        Edit
                      </button>
                    ) : (
                      <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
                        <button
                          className="ad-btn-text dim"
                          onClick={() => {
                            if (rev.specText !== rev.specTextOrig) { setConfirmSpecCancel(true); return }
                            up({ specEdit: false, specText: '', specTextOrig: '' })
                          }}
                          style={{ font: "500 11.5px var(--sans)", padding: '4px 4px' }}
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => {
                            if (rev.specText === rev.specTextOrig) return
                            up({
                              spec: textToSpec(rev.specText), specEdit: false, specText: '', specTextOrig: '',
                              dirty: true, dirtyWhy: 'spec', touched: true,
                            })
                            showToast('Spec saved — the workflow is out of sync. Sync the steps before saving.', 5800)
                          }}
                          style={{
                            background: rev.specText !== rev.specTextOrig ? 'var(--accent)' : 'rgba(255,255,255,.06)',
                            color: rev.specText !== rev.specTextOrig ? 'var(--on-accent)' : 'var(--text-faint)',
                            borderRadius: 6, font: "600 11.5px var(--sans)", padding: '5px 11px',
                            cursor: rev.specText !== rev.specTextOrig ? 'pointer' : 'default',
                          }}
                        >
                          Save
                        </button>
                      </div>
                    )}
                  </div>
                  {rev.specEdit ? (
                    <>
                      <textarea
                        value={rev.specText} rows={19}
                        onChange={(e) => up({ specText: e.target.value, touched: true })}
                        style={{
                          width: '100%', background: 'var(--bg-inset)', border: 'none', color: '#c6cdd6',
                          font: "400 12.5px/1.7 var(--mono)", padding: '16px 20px', resize: 'vertical', outline: 'none', display: 'block',
                        }}
                      />
                      <div style={{ padding: '9px 20px', borderTop: '1px solid rgba(255,255,255,.05)', font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-faintest)' }}>
                        Saving rewrites the steps to match the new spec.
                      </div>
                    </>
                  ) : (
                    <div className="ad-copy" style={{ padding: '6px 20px 18px', maxHeight: 440, overflowY: 'auto' }}>
                      {rev.spec.map((b, i) => {
                        if (b.k === 'h1') return <div key={i} style={{ font: "600 17px var(--sans)", margin: '14px 0 4px' }}>{b.text}</div>
                        if (b.k === 'h2') return <div key={i} style={{ font: "600 10.5px var(--mono)", letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '16px 0 6px' }}>{b.text}</div>
                        if (b.k === 'li') return (
                          <div key={i} style={{ display: 'flex', gap: 8, margin: '3px 0' }}>
                            <span style={{ color: 'var(--text-faint)' }}>–</span>
                            <span style={{ font: "400 13px/1.55 var(--sans)", color: '#c6cdd6' }}>{b.text}</span>
                          </div>
                        )
                        return <p key={i} style={{ margin: '4px 0', font: "400 13px/1.6 var(--sans)", color: '#c6cdd6' }}>{b.text}</p>
                      })}
                    </div>
                  )}
                  {/* ask-the-agent box */}
                  <div style={{ borderTop: '1px solid var(--hairline)', padding: '12px 14px', display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      value={rev.ask}
                      onChange={(e) => up({ ask: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter') void sendAsk() }}
                      placeholder="Ask for a change — “also check on weekends”"
                      style={{
                        flex: 1, background: 'var(--bg-inset)', border: '1px solid rgba(255,255,255,.08)',
                        borderRadius: 8, color: 'var(--text)', font: "400 12.5px var(--sans)", padding: '8px 12px', outline: 'none',
                      }}
                    />
                    {rev.syncBusy || rev.askBusy ? (
                      <span style={{
                        width: 14, height: 14, border: '2px solid rgba(255,255,255,.15)', borderTopColor: 'var(--accent)',
                        borderRadius: '50%', animation: 'adSpin .8s linear infinite', flex: 'none', margin: '0 8px',
                      }} />
                    ) : (
                      <button className="ad-btn-soft" onClick={() => void sendAsk()} style={{ borderRadius: 8, padding: '8px 12px', font: "500 12px var(--sans)", whiteSpace: 'nowrap' }}>
                        Edit with agent
                      </button>
                    )}
                  </div>
                  {/* §11: blocked edit call — persistent amber notice, draft untouched */}
                  {rev.askBlockers && (
                    <div style={{
                      borderTop: '1px solid var(--hairline)', background: 'oklch(0.75 0.13 75 / .06)',
                      padding: '10px 14px', display: 'flex', alignItems: 'flex-start', gap: 9,
                    }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--amber)', flex: 'none', marginTop: 5 }} />
                      <div style={{ flex: 1, minWidth: 0, font: "400 12px/1.6 var(--sans)", color: '#c6cdd6' }}>
                        {rev.askBlockers.map((b, i) => (
                          <div key={i}>Your AI hit a blocker: {blockerLine(b)}</div>
                        ))}
                      </div>
                      <button
                        className="ad-btn-text dim" title="Dismiss"
                        onClick={() => up({ askBlockers: null })}
                        style={{ font: "500 12px var(--sans)", padding: '0 2px', flex: 'none' }}
                      >
                        <i className="fa-solid fa-xmark" style={{ fontSize: 11 }} />
                      </button>
                    </div>
                  )}
                </div>

                {/* AGENTS · AVAILABLE TO STEPS */}
                <div style={cardStyle}>
                  <div
                    onClick={() => up({ agSecOpen: !agSecOpenEff })}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 20px', cursor: 'pointer', userSelect: 'none' }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <i className={agSecOpenEff ? 'fa-solid fa-caret-down' : 'fa-solid fa-caret-right'} style={{ width: 14, flex: 'none', textAlign: 'center', fontSize: 10, color: '#4a515c' }} />
                      <span style={eyebrowStyle}>AGENTS · AVAILABLE TO STEPS</span>
                    </span>
                    <span style={{ font: "500 10.5px var(--mono)", color: 'var(--text-faintest)', whiteSpace: 'nowrap', flex: 'none' }}>
                      {availAgents.length} of {agents.length} enabled
                    </span>
                  </div>
                  {!agSecOpenEff && (
                    <div onClick={() => up({ agSecOpen: true })} style={{ padding: '0 20px 13px 43px', font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-faintest)', cursor: 'pointer', userSelect: 'none' }}>
                      Which agents steps may call mid-run. Fewer enabled means more predictable runs.
                    </div>
                  )}
                  {agSecOpenEff && (
                    <div style={{ borderTop: '1px solid var(--hairline)' }}>
                      {agWarn && (
                        <WarnBanner text={`Step${agentStepIdx.length > 1 ? 's' : ''} ${stepList(agentStepIdx)} need${agentStepIdx.length > 1 ? '' : 's'} an agent, but none is enabled — the run would fail there. Enable one below.`} />
                      )}
                      {agents.map((g) => {
                        const on = rev.enabledAgents.includes(g.id)
                        const used = agentStepIdx.filter((i) => { const r = resolveAg(rev.steps[i]); return !!r && r.id === g.id })
                        return (
                          <div
                            key={g.id}
                            onClick={() => {
                              if (on) {
                                up({ enabledAgents: rev.enabledAgents.filter((z) => z !== g.id), dirty: true, dirtyWhy: 'agents', ...(isEdit ? { touched: true } : {}) })
                                if (used.length) showToast(`Step${used.length > 1 ? 's' : ''} ${stepList(used)} ${used.length > 1 ? 'are' : 'is'} out of sync — ${agName(g)} is no longer available here. Sync the steps before saving.`, 5000)
                              } else {
                                up({ enabledAgents: [...rev.enabledAgents, g.id], dirty: true, dirtyWhy: 'agents', ...(isEdit ? { touched: true } : {}) })
                              }
                            }}
                            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 20px', borderBottom: '1px solid rgba(255,255,255,.05)', cursor: 'pointer', userSelect: 'none' }}
                          >
                            <CheckBox on={on} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ font: "600 12.5px var(--sans)" }}>{agName(g)}</div>
                              <div style={{ font: "400 11.5px var(--sans)", color: 'var(--text-muted)' }}>{dispModel(g)}</div>
                            </div>
                            {used.length > 0 && (
                              <span style={{ font: "500 10px var(--mono)", color: 'var(--text-faint)', flex: 'none', whiteSpace: 'nowrap' }}>
                                called by step{used.length > 1 ? 's' : ''} {stepList(used)}
                              </span>
                            )}
                          </div>
                        )
                      })}
                      <div style={{ padding: '11px 20px', font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-faintest)' }}>
                        Steps marked <i className="fa-solid fa-robot" style={{ fontSize: 9, color: 'oklch(0.78 0.13 52)' }} /> call one of these mid-run — for the parts plain code can’t do, like reading a messy page or writing prose. Fewer enabled means more predictable runs.
                      </div>
                    </div>
                  )}
                </div>

                {/* SECRETS · ALLOWED FOR STEPS */}
                <div style={cardStyle}>
                  <div
                    onClick={() => up({ secSecOpen: !secSecOpenEff })}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 20px', cursor: 'pointer', userSelect: 'none' }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <i className={secSecOpenEff ? 'fa-solid fa-caret-down' : 'fa-solid fa-caret-right'} style={{ width: 14, flex: 'none', textAlign: 'center', fontSize: 10, color: '#4a515c' }} />
                      <span style={eyebrowStyle}>SECRETS · ALLOWED FOR STEPS</span>
                    </span>
                    <span style={{ font: "500 10.5px var(--mono)", color: 'var(--text-faintest)', whiteSpace: 'nowrap', flex: 'none' }}>
                      {rev.allowedSecrets.length} of {secrets.length} allowed
                    </span>
                  </div>
                  {!secSecOpenEff && (
                    <div onClick={() => up({ secSecOpen: true })} style={{ padding: '0 20px 13px 43px', font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-faintest)', cursor: 'pointer', userSelect: 'none' }}>
                      Only checked secrets are handed to this automation at run time. Values come from your Keychain.
                    </div>
                  )}
                  {secSecOpenEff && (
                    <div style={{ borderTop: '1px solid var(--hairline)' }}>
                      {secWarn && (
                        <WarnBanner text={[
                          ...secNotAllowed.map((r) => `Step${r.steps.length > 1 ? 's' : ''} ${stepList(r.steps)} use${r.steps.length > 1 ? '' : 's'} ${r.name}, but it isn’t allowed here — the run would fail there. Allow it below.`),
                          ...secMissing.map((r) => `${r.name} isn’t in your Keychain — the run would fail at step${r.steps.length > 1 ? 's' : ''} ${stepList(r.steps)}. Click it below to add the value.`),
                        ].join(' ')} />
                      )}
                      {secrets.map((s) => {
                        const ref = secRefs.find((r) => r.name === s.name)
                        const on = rev.allowedSecrets.includes(s.name)
                        return (
                          <div
                            key={s.name}
                            onClick={() => {
                              if (on) {
                                up({ allowedSecrets: rev.allowedSecrets.filter((z) => z !== s.name), dirty: true, dirtyWhy: 'secrets', ...(isEdit ? { touched: true } : {}) })
                                if (ref) showToast(`Step${ref.steps.length > 1 ? 's' : ''} ${stepList(ref.steps)} use${ref.steps.length > 1 ? '' : 's'} ${s.name} — the run would fail there until it’s allowed again.`, 4500)
                              } else {
                                up({ allowedSecrets: [...rev.allowedSecrets, s.name], dirty: true, dirtyWhy: 'secrets', ...(isEdit ? { touched: true } : {}) })
                              }
                            }}
                            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 20px', borderBottom: '1px solid rgba(255,255,255,.05)', cursor: 'pointer', userSelect: 'none' }}
                          >
                            <CheckBox on={on} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ font: "500 12px var(--mono)", color: 'var(--text)' }}>{s.name}</div>
                            </div>
                            {ref && (
                              <span style={{ font: "500 10px var(--mono)", color: 'var(--text-faint)', flex: 'none', whiteSpace: 'nowrap' }}>
                                used by step{ref.steps.length > 1 ? 's' : ''} {stepList(ref.steps)}
                              </span>
                            )}
                          </div>
                        )
                      })}
                      {secMissing.map((r) => (
                        <MissingSecretRow
                          key={r.name}
                          name={r.name}
                          sub={`used by step${r.steps.length > 1 ? 's' : ''} ${stepList(r.steps)} — not in your Keychain`}
                          onAdded={() => up({ allowedSecrets: [...rev.allowedSecrets, r.name], dirty: true, dirtyWhy: 'secrets', ...(isEdit ? { touched: true } : {}) })}
                        />
                      ))}
                      {secrets.length === 0 && secRefs.length === 0 && (
                        <div style={{ padding: '11px 20px', borderBottom: '1px solid rgba(255,255,255,.05)', font: "400 12px var(--sans)", color: 'var(--text-faintest)' }}>
                          No secrets in your Keychain yet — add passwords and keys under Secrets.
                        </div>
                      )}
                      <div style={{ padding: '11px 20px', font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-faintest)' }}>
                        Only checked secrets are handed to this automation at run time — a step that asks for anything else fails. Values come from your Keychain and never appear in scripts or logs.
                      </div>
                    </div>
                  )}
                </div>

                {/* BUILD INSTRUCTIONS */}
                <div style={cardStyle}>
                  <div
                    onClick={() => up({ instrSecOpen: !instrOpenEff })}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', cursor: 'pointer', userSelect: 'none' }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <i className={instrOpenEff ? 'fa-solid fa-caret-down' : 'fa-solid fa-caret-right'} style={{ width: 14, flex: 'none', textAlign: 'center', fontSize: 10, color: '#4a515c' }} />
                      <span style={eyebrowStyle}>BUILD INSTRUCTIONS</span>
                    </span>
                    {instrOpenEff && !rev.instrEdit && (
                      <button
                        className="ad-btn-soft"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (busyRewrite) return
                          up({ specEdit: false, specText: '', specTextOrig: '', instrDraft: rev.instr, instrEdit: true, instrSecOpen: true })
                        }}
                        style={{ flex: 'none' }}
                      >
                        Edit
                      </button>
                    )}
                    {instrOpenEff && rev.instrEdit && (
                      <span style={{ display: 'flex', gap: 9, alignItems: 'center', flex: 'none' }}>
                        <button
                          className="ad-btn-text dim"
                          onClick={(e) => { e.stopPropagation(); up({ instrDraft: null, instrEdit: false }) }}
                          style={{ font: "500 11.5px var(--sans)", padding: '4px 4px' }}
                        >
                          Cancel
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            if (rev.instrDraft == null || rev.instrDraft === rev.instr) return
                            up({ instr: rev.instrDraft, instrDraft: null, instrEdit: false, touched: true, dirty: true, dirtyWhy: 'spec' })
                            showToast('Instructions saved — the workflow is out of sync. Sync the steps before saving.', 5800)
                          }}
                          style={{
                            background: (rev.instrDraft != null && rev.instrDraft !== rev.instr) ? 'var(--accent)' : 'rgba(255,255,255,.06)',
                            color: (rev.instrDraft != null && rev.instrDraft !== rev.instr) ? 'var(--on-accent)' : 'var(--text-faint)',
                            borderRadius: 6, padding: '4px 12px', font: "600 11.5px var(--sans)",
                            cursor: (rev.instrDraft != null && rev.instrDraft !== rev.instr) ? 'pointer' : 'default',
                          }}
                        >
                          Save
                        </button>
                      </span>
                    )}
                  </div>
                  {!instrOpenEff && (
                    <div onClick={() => up({ instrSecOpen: true })} style={{ padding: '0 20px 13px 43px', font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-faintest)', cursor: 'pointer', userSelect: 'none' }}>
                      Standing rules your AI follows every time it writes or edits this automation.
                    </div>
                  )}
                  {instrOpenEff && !rev.instrEdit && (
                    <div className="ad-copy" style={{ borderTop: '1px solid var(--hairline)', padding: '10px 20px 16px' }}>
                      {rev.instr.split('\n').map((s) => s.trim()).filter(Boolean).map((t, i) => (
                        <div key={i} style={{ display: 'flex', gap: 8, margin: '3px 0' }}>
                          <span style={{ color: 'var(--text-faint)' }}>–</span>
                          <span style={{ font: "400 13px/1.55 var(--sans)", color: '#c6cdd6' }}>{t}</span>
                        </div>
                      ))}
                      {!rev.instr.trim() && (
                        <div style={{ margin: '3px 0', font: "400 13px/1.55 var(--sans)", color: 'var(--text-faintest)' }}>
                          No instructions yet — press Edit to add standing rules.
                        </div>
                      )}
                    </div>
                  )}
                  {instrOpenEff && rev.instrEdit && (
                    <textarea
                      value={rev.instrDraft ?? rev.instr} rows={6}
                      onChange={(e) => up({ instrDraft: e.target.value })}
                      placeholder="One rule per line — “Prefer Python.” “Never delete files — move them to the Trash.”"
                      style={{
                        width: '100%', background: 'var(--bg-inset)', border: 'none', borderTop: '1px solid var(--hairline)',
                        color: '#c6cdd6', font: "400 12.5px/1.7 var(--mono)", padding: '14px 20px',
                        resize: 'vertical', outline: 'none', display: 'block',
                      }}
                    />
                  )}
                </div>

                {/* FRAMEWORK INSTRUCTIONS */}
                <div style={cardStyle}>
                  <div
                    onClick={() => up({ fwOpen: !rev.fwOpen })}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', cursor: 'pointer', userSelect: 'none' }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <i className={rev.fwOpen ? 'fa-solid fa-caret-down' : 'fa-solid fa-caret-right'} style={{ width: 14, flex: 'none', textAlign: 'center', fontSize: 10, color: '#4a515c' }} />
                      <span style={eyebrowStyle}>FRAMEWORK INSTRUCTIONS</span>
                    </span>
                  </div>
                  {!rev.fwOpen && (
                    <div onClick={() => up({ fwOpen: true })} style={{ padding: '0 20px 13px 43px', font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-faintest)', cursor: 'pointer', userSelect: 'none' }}>
                      The built-in instructions your AI reads before writing anything, word for word. They update with the app, nothing for you to maintain.
                    </div>
                  )}
                  {rev.fwOpen && (
                    <div style={{ padding: '12px 20px 16px', borderTop: '1px solid var(--hairline)' }}>
                      {/* 18px side padding + matching negative margin so Markdown's full-bleed tables (-18px) fit */}
                      <div style={{ maxHeight: 420, overflowY: 'auto', padding: '0 18px', margin: '0 -18px' }}>
                        {fw
                          ? <Markdown text={fw} />
                          : <div style={{ font: "400 12px/1.65 var(--mono)", color: '#c6cdd6' }}>Couldn’t load framework-instructions.md — reopen this page to retry.</div>}
                      </div>
                      <div style={{ marginTop: 14, font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-faintest)' }}>
                        framework-instructions.md — sent to your AI, word for word, with every drafting request. Updates with the app, nothing for you to maintain.
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ===== right column ===== */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* STEPS */}
                <div style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
                    <span style={eyebrowStyle}>STEPS · GENERATED</span>
                    {!rev.dirty && !rev.syncBusy && rev.steps.length > 0 && (
                      <span style={{ font: "500 10.5px var(--mono)", color: 'var(--green)', whiteSpace: 'nowrap', flex: 'none' }}>
                        <i className="fa-solid fa-check" style={{ fontSize: 10 }} /> {rev.stepsMeta || 'in sync with spec'}
                      </span>
                    )}
                  </div>
                  {rev.dirty && !rev.syncBusy && !rev.askBusy && (
                    <div style={{
                      background: 'oklch(0.8 0.13 85 / .07)', border: '1px solid oklch(0.8 0.13 85 / .28)',
                      borderRadius: 9, padding: '10px 12px', margin: '12px 14px',
                      display: 'flex', alignItems: 'flex-start', gap: 9, animation: 'adFadeUp .3s ease both',
                    }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--amber)', flex: 'none', marginTop: 5 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ font: "500 12.5px var(--sans)", color: 'var(--text)' }}>
                          {rev.dirtyWhy === 'agents' ? 'The workflow is out of sync — the agents available to this automation changed.'
                            : rev.dirtyWhy === 'secrets' ? 'The workflow is out of sync — the secrets allowed for this automation changed.'
                              : 'The workflow is out of sync — these steps still match the old spec.'}
                        </div>
                        <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: 2 }}>
                          {rev.dirtyWhy === 'agents' ? 'Sync the steps so they use the agents available to this automation, then review them. Saving is locked until you do.'
                            : rev.dirtyWhy === 'secrets' ? 'Sync the steps so they only use the secrets allowed here, then review them. Saving is locked until you do.'
                              : 'Sync the steps to the new spec, then review them. Saving is locked until you do — nothing ships unreviewed.'}
                        </div>
                      </div>
                      <button className="ad-btn-soft" onClick={() => void runSync()} style={{ padding: '5px 10px', flex: 'none', whiteSpace: 'nowrap' }}>
                        Sync now
                      </button>
                    </div>
                  )}
                  {rev.syncBusy && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-inset)',
                      border: '1px solid var(--border-card)', borderRadius: 9, padding: '10px 12px', margin: '12px 14px',
                    }}>
                      <span style={{
                        width: 13, height: 13, border: '2px solid rgba(255,255,255,.15)', borderTopColor: 'var(--accent)',
                        borderRadius: '50%', animation: 'adSpin .8s linear infinite', flex: 'none',
                      }} />
                      <span style={{ font: "500 12.5px var(--sans)", color: 'var(--text-2)' }}>
                        {selAgent ? `${agName(selAgent)} · ${dispModel(selAgent)}` : 'Your agent'} is rewriting the steps from your spec…
                      </span>
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', opacity: rev.dirty || rev.syncBusy ? 0.45 : 1, transition: 'opacity .2s', marginBottom: -1 }}>
                    {rev.steps.map((s, i) => (
                      <StepRow
                        key={i} step={s} i={i}
                        open={rev.stepOpen === i}
                        onToggle={() => up({ stepOpen: rev.stepOpen === i ? null : i })}
                        availAgents={availAgents}
                        onPickAgent={(gid) => {
                          setRev((r) => r && ({
                            ...r,
                            steps: r.steps.map((st, j) => (j === i && st.agent ? { ...st, agentId: gid } : st)),
                            ...(isEdit ? { touched: true } : {}),
                          }))
                          const g = agents.find((z) => z.id === gid)
                          if (g) showToast(`Step ${i + 1} now calls ${agName(g)} · ${dispModel(g)}.`, 3000)
                        }}
                      />
                    ))}
                  </div>
                </div>

                {/* SCHEDULE */}
                <div style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
                    <span style={eyebrowStyle}>SCHEDULE</span>
                  </div>
                  <div style={{ padding: '13px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{
                      font: "500 12px var(--mono)", color: 'var(--accent)', background: 'oklch(0.74 0.155 52 / .12)',
                      borderRadius: 6, padding: '3px 9px',
                    }}>
                      {rev.schedLabel}
                    </span>
                    <span style={{ font: "400 11.5px var(--sans)", color: 'var(--text-faint)' }}>
                      {rev.sched ? 'Runs even when the app is closed.' : 'No time set — runs only when you Run now or use the menu bar.'}
                    </span>
                  </div>
                </div>

                {/* PARAMETERS */}
                <div style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
                    <span style={eyebrowStyle}>PARAMETERS · YOUR AI ASKED FOR THESE</span>
                    {isEdit && (auto?.params ?? []).length > 0 && (
                      <span style={{ font: "500 10px var(--mono)", letterSpacing: '.06em', color: 'var(--text-faintest)' }}>READ-ONLY HERE</span>
                    )}
                  </div>
                  {(() => {
                    const params = isEdit ? auto?.params ?? [] : rev.params
                    if (params.length === 0) {
                      return (
                        <div style={{ padding: '14px 20px 16px', font: "400 12.5px var(--sans)", color: 'var(--text-muted)' }}>
                          No settings needed — your AI didn’t ask for any.
                        </div>
                      )
                    }
                    if (isEdit) {
                      return (
                        <>
                          {params.map((p) => (
                            <div key={p.name} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', justifyContent: 'space-between', padding: '11px 20px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ font: "600 12.5px var(--sans)" }}>{p.label}</div>
                                <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: 2 }}>{p.help}</div>
                              </div>
                              <span style={{ font: "500 12px var(--mono)", color: '#c6cdd6', flex: 'none', paddingTop: 2 }}>{paramSummary(p)}</span>
                            </div>
                          ))}
                          <div style={{ padding: '11px 20px', font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-faintest)' }}>
                            Values aren’t part of a version — change them on the automation page; they apply on the next run.
                          </div>
                        </>
                      )
                    }
                    // create mode: definitions editable inline (§4.2 edit behaviors)
                    const inputStyle: React.CSSProperties = {
                      flex: 1, minWidth: 0, background: 'var(--bg-inset)', border: '1px solid rgba(255,255,255,.09)',
                      borderRadius: 7, color: 'var(--text)', font: "400 12px var(--mono)", padding: '7px 10px', outline: 'none',
                    }
                    return (
                      <>
                        {params.map((p) => {
                          if (p.kind === 'toggle') {
                            return (
                              <div key={p.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '13px 20px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                                <div>
                                  <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
                                  <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: 3 }}>{p.help}</div>
                                </div>
                                <Toggle on={!!p.on} onChange={(v) => updParam(p.name, { on: v, default: v })} />
                              </div>
                            )
                          }
                          if (p.kind === 'list') {
                            const lines = p.lines ?? []
                            const setLines = (next: string[]) => updParam(p.name, { lines: next, default: next })
                            const good = lines.filter((l) => l.trim() && validUrl(l)).length
                            const bad = lines.filter((l) => l.trim() && !validUrl(l)).length
                            return (
                              <div key={p.name} style={{ padding: '14px 20px 15px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                                <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
                                <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', margin: '3px 0 9px' }}>{p.help}</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  {lines.map((ln, li) => {
                                    const invalid = !!p.validate && ln.trim() !== '' && !validUrl(ln)
                                    return (
                                      <div key={li} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <input
                                          value={ln}
                                          onChange={(e) => setLines(lines.map((z, j) => (j === li ? e.target.value : z)))}
                                          style={{ ...inputStyle, borderColor: invalid ? 'oklch(0.7 0.19 25 / .65)' : 'rgba(255,255,255,.09)', color: invalid ? 'oklch(0.78 0.15 25)' : 'var(--text)' }}
                                        />
                                        {invalid && (
                                          <span style={{
                                            display: 'inline-flex', padding: '2px 7px', borderRadius: 5, font: "600 9.5px var(--mono)",
                                            letterSpacing: '.06em', background: 'oklch(0.7 0.19 25 / .14)', color: 'oklch(0.74 0.17 25)', flex: 'none',
                                          }}>
                                            NOT A VALID LINK
                                          </span>
                                        )}
                                        <button className="ad-btn-x" onClick={() => setLines(lines.filter((_, j) => j !== li))}>
                                          <i className="fa-solid fa-xmark" style={{ fontSize: 12 }} />
                                        </button>
                                      </div>
                                    )
                                  })}
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                    <button className="ad-btn-dashed" onClick={() => setLines([...lines, ''])}>
                                      + Add line
                                    </button>
                                    {p.validate && (
                                      <span style={{ font: "500 11px var(--mono)", color: 'var(--text-faint)' }}>
                                        {lines.length} lines · {good} valid links{bad > 0 ? ` · ${bad} needs attention` : ''}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )
                          }
                          if (p.kind === 'kv') {
                            const rows = p.rows ?? []
                            const setRows = (next: { k: string; v: string }[]) => updParam(p.name, { rows: next, default: next })
                            return (
                              <div key={p.name} style={{ padding: '14px 20px 15px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                                <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
                                <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', margin: '3px 0 9px' }}>{p.help}</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  {rows.map((r, ri) => (
                                    <div key={ri} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <input
                                        value={r.k} placeholder="Key"
                                        onChange={(e) => setRows(rows.map((z, j) => (j === ri ? { ...z, k: e.target.value } : z)))}
                                        style={{ ...inputStyle, flex: '0 1 38%' }}
                                      />
                                      <input
                                        value={r.v} placeholder="Value"
                                        onChange={(e) => setRows(rows.map((z, j) => (j === ri ? { ...z, v: e.target.value } : z)))}
                                        style={inputStyle}
                                      />
                                      <button className="ad-btn-x" onClick={() => setRows(rows.filter((_, j) => j !== ri))}>
                                        <i className="fa-solid fa-xmark" style={{ fontSize: 12 }} />
                                      </button>
                                    </div>
                                  ))}
                                  <button className="ad-btn-dashed" onClick={() => setRows([...rows, { k: '', v: '' }])}>
                                    + Add pair
                                  </button>
                                </div>
                              </div>
                            )
                          }
                          if (p.kind === 'number') {
                            const mn = p.min ?? 0
                            return (
                              <div key={p.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '13px 20px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
                                  <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: 3 }}>{p.help}</div>
                                </div>
                                <input
                                  value={String(p.value ?? '')}
                                  onChange={(e) => {
                                    const digits = e.target.value.replace(/\D/g, '')
                                    updParam(p.name, { value: digits === '' ? '' : Number(digits), default: digits === '' ? mn : Number(digits) })
                                  }}
                                  onBlur={() => {
                                    const n = typeof p.value === 'number' ? p.value : NaN
                                    if (Number.isNaN(n) || n < mn) updParam(p.name, { value: mn, default: mn })
                                  }}
                                  style={{ ...inputStyle, flex: 'none', width: 84, textAlign: 'right' }}
                                />
                              </div>
                            )
                          }
                          // text
                          return (
                            <div key={p.name} style={{ padding: '14px 20px 15px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                              <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
                              <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', margin: '3px 0 9px' }}>{p.help}</div>
                              <input
                                value={String(p.value ?? '')} placeholder={p.placeholder}
                                onChange={(e) => updParam(p.name, { value: e.target.value, default: e.target.value })}
                                style={{ ...inputStyle, width: '100%' }}
                              />
                            </div>
                          )
                        })}
                        <div style={{ padding: '11px 20px', font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-faintest)' }}>
                          After creation these move to the automation page — changes there apply on the next run, no new version.
                        </div>
                      </>
                    )
                  })()}
                </div>

                {/* TEST RUN — §11: runs the draft's real steps, scratch memory */}
                <div style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
                      <span style={eyebrowStyle}>TEST RUN</span>
                      {testrun?.status === 'running' ? (
                        <button className="ad-btn-soft" onClick={cancelTest} style={{ padding: '4px 10px' }}>
                          Cancel
                        </button>
                      ) : (
                        <button className="ad-btn-soft" onClick={() => void runTest()} style={{ padding: '4px 10px' }}>
                          {testrun ? 'Run again' : 'Run the draft'}
                        </button>
                      )}
                    </div>
                    {testrun ? (
                      <>
                        {testrun.steps.length > 0 && (
                          <div style={{ padding: '10px 20px 4px' }}>
                            {testrun.steps.map((s, i) => (
                              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '3px 0' }}>
                                <span style={{ font: "500 11px var(--mono)", color: 'var(--text-faint)', width: 14, flex: 'none' }}>{i + 1}</span>
                                <span style={{ flex: 1, minWidth: 0, font: "400 12px var(--sans)", color: '#c6cdd6', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                                <Badge status={s.status} />
                              </div>
                            ))}
                          </div>
                        )}
                        <div style={{ padding: '10px 20px 12px', font: "400 11.5px/1.8 var(--mono)", background: '#07090d', maxHeight: 260, overflowY: 'auto' }}>
                          {testrun.lines.map((l, i) => (
                            <div key={i} style={{ color: logColor(l.k), whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>{l.text}</div>
                          ))}
                          {testrun.status === 'running' && (
                            <div style={{ color: 'var(--text-faint)', marginTop: 6 }}>
                              <span style={{
                                display: 'inline-block', width: 11, height: 11, border: '2px solid rgba(255,255,255,.15)',
                                borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'adSpin .8s linear infinite',
                                marginRight: 7, verticalAlign: -1,
                              }} />
                              running the draft…
                            </div>
                          )}
                          {testrun.status === 'succeeded' && (
                            <div style={{ marginTop: 6 }}>
                              <div style={{ color: 'var(--green)' }}>
                                <i className="fa-solid fa-check" style={{ fontSize: 11 }} /> Test run finished — the memory copy was discarded.
                              </div>
                              {testrun.result?.chip && (
                                <Chip {...resultChipColors(testrun.result.chipStatus)} style={{ marginTop: 7 }}>{testrun.result.chip}</Chip>
                              )}
                              {(testrun.result?.values ?? []).map((v) => (
                                <div key={v.name} style={{ color: '#9fb3c8', marginTop: 4 }}>
                                  <span style={{ color: 'var(--text-faint)' }}>{v.name}: </span>
                                  {Array.isArray(v.value) ? v.value.join(' · ') : v.value}
                                </div>
                              ))}
                            </div>
                          )}
                          {testrun.status === 'failed' && testrun.analyzing && (
                            <div style={{ color: 'var(--amber)', marginTop: 6 }}>
                              <span style={{
                                display: 'inline-block', width: 11, height: 11, border: '2px solid rgba(255,255,255,.15)',
                                borderTopColor: 'var(--amber)', borderRadius: '50%', animation: 'adSpin .8s linear infinite',
                                marginRight: 7, verticalAlign: -1,
                              }} />
                              Analyzing the failure… {selAgent ? `(${agName(selAgent)})` : ''}
                            </div>
                          )}
                          {testrun.status === 'failed' && !testrun.analyzing && (
                            <div style={{ color: 'var(--amber)', marginTop: 6 }}>
                              <i className="fa-solid fa-triangle-exclamation" style={{ fontSize: 11 }} /> Test run failed.
                            </div>
                          )}
                          {testrun.status === 'cancelled' && (
                            <div style={{ color: 'var(--text-faint)', marginTop: 6 }}>
                              Test run cancelled.
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div style={{ padding: '12px 20px', font: "400 11.5px/1.6 var(--mono)", color: '#4a515c' }}>
                        Runs the draft's real steps on this Mac — emails send, files move. Memory is a scratch copy; real runs aren't affected.
                      </div>
                    )}
                  </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* onboarding trust footer */}
      {isOnboard && (
        <div style={{ flex: 'none', borderTop: '1px solid var(--hairline)', padding: '13px 28px', display: 'flex', justifyContent: 'center', gap: 26, flexWrap: 'wrap' }}>
          {['Everything runs on this Mac', 'Nothing runs until you review it', 'Passwords stay in your Keychain'].map((t) => (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--green)' }} />
              <span style={{ font: "400 12px var(--sans)", color: 'var(--text-muted)' }}>{t}</span>
            </div>
          ))}
        </div>
      )}

      {confirmSpecCancel && (
        <ConfirmModal
          title="Discard your spec edits?"
          body="The changes you typed into the spec editor will be lost."
          confirmLabel="Discard edits"
          danger
          onConfirm={() => { setConfirmSpecCancel(false); up({ specEdit: false, specText: '', specTextOrig: '' }) }}
          onCancel={() => setConfirmSpecCancel(false)}
        />
      )}

      {/* §11: the repair modal — one convergent loop, two entry points: a
          blocked sync ('sync') and a failed test run's issue analysis ('test').
          Applying amends the in-editor spec and re-runs the sync; closing a
          'sync' repair leaves the workflow out of sync with the banner up. */}
      {rev?.repair && (
        <Modal
          onClose={() => { if (applyBlockedRef.current) { applyBlockedRef.current = false; applyRepair() } else up({ repair: null }) }}
          width={620} zIndex={80} cardStyle={{ padding: 22, maxHeight: '80vh', overflowY: 'auto' }}
        >
          {(close) => (
            <>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                {rev.repair!.source === 'test'
                  ? (rev.repair!.blockers.length > 1 ? `The test run hit ${rev.repair!.blockers.length} issues` : 'The test run hit an issue')
                  : (rev.repair!.blockers.length > 1 ? `Your AI hit ${rev.repair!.blockers.length} blockers` : 'Your AI hit a blocker')}
              </div>
              <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-muted)', marginBottom: 14 }}>
                {rev.repair!.source === 'test'
                  ? 'A step failed when the draft ran. Edit the fix below, then apply it to the spec and sync the steps.'
                  : 'It couldn’t sync the steps with the spec. Edit the fix below, then apply it to the spec and sync again.'}
              </div>
              <BlockerCards
                blockers={rev.repair!.blockers}
                onChange={(i, patch) => setRev((r) => r && r.repair && ({
                  ...r,
                  repair: { ...r.repair, blockers: r.repair.blockers.map((b, k) => (k === i ? { ...b, ...patch } : b)) },
                }))}
              />
              {rev.resolved.length > 0 && (
                <div style={{ margin: '12px 0 0', font: "400 11.5px/1.7 var(--sans)", color: 'var(--text-faint)' }}>
                  <div style={eyebrowStyle}>PREVIOUSLY RESOLVED</div>
                  {rev.resolved.map((s, i) => <div key={i}>– {s}</div>)}
                </div>
              )}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
                <BtnGhost onClick={close}>Close</BtnGhost>
                <BtnPrimary
                  onClick={() => { applyBlockedRef.current = true; close() }}
                  disabled={rev.repair!.blockers.some((b) => !b.reason.trim() || !b.fix.trim())}
                >
                  {rev.repair!.source === 'test' ? 'Apply to the spec & sync the steps' : 'Apply to the spec & sync again'}
                </BtnPrimary>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}
