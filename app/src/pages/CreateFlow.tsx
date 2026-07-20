// Create / edit flow (§11): Ask → Review — no separate building screen. Drafting/
// editing/syncing are §8 backend jobs (POST /drafts + polling); on create, Review
// renders in a drafting state and fills in as the pipeline delivers (spec card first,
// steps skeletons after). This page also renders the Review dirty-gating, version
// menu, per-step agent/secret tags, and the secrets/agents warning cards.
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Agent, Auto, Blocker, DraftPayload, DraftTrigger, PackageDep, ParamDef, SpecBlock, Step, VersionInfo } from '../types'
import { Badge, BtnGhost, BtnPrimary, Chip, ConfirmModal, Modal, PyCode, Toggle, agName, dispModel, logColor, paramSummary, resultChipColors, usePopover, validUrl } from '../ui'
import { nextTriggerShort, triggerShort } from '../cron'
import { Markdown, SpecMarkdown } from '../result'

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

// §11 Build-instructions card: bare lines (no markdown block syntax, outside code fences)
// become bullets so plain one-rule-per-line text renders as a list, not one paragraph.
function instrToMd(text: string): string {
  let fence = false
  return text.split('\n').map((raw) => {
    const l = raw.trim()
    if (l.startsWith('```')) { fence = !fence; return raw }
    if (fence || !l || /^(#{1,3}\s|[-*]\s|\d+\.\s|\|)/.test(l)) return raw
    return `- ${l}`
  }).join('\n')
}

// The two §8 instruction files (framework-instructions.md, shown verbatim in the read-only
// Framework-instructions card, and default-build-instructions.md, the Build-instructions
// pre-fill). Loaded from the backend (GET /instructions) so both cards always show exactly
// what the agent is told.
let fwCache: string | null = null
let defaultBuildCache = ''

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

/** §11 blocker cards — one per blocker, three labeled, editable fields pre-filled
 * from the agent's answer; the user edits any of them (usually the fix). */
function BlockerCards({ blockers, onChange }: {
  blockers: Blocker[]; onChange?: (i: number, patch: Partial<Blocker>) => void
}) {
  const field = (label: string, value: string, rows: number, set: (v: string) => void, placeholder?: string) => (
    <div style={{ padding: '8px 16px 0' }}>
      <div style={eyebrowStyle}>{label}</div>
      <textarea
        value={value} rows={rows} placeholder={placeholder}
        onChange={(e) => set(e.target.value)}
        style={{
          width: '100%', margin: '5px 0 2px', background: 'var(--bg-inset)',
          border: '1px solid rgba(255,255,255,.08)', borderRadius: 7, color: 'var(--text)',
          font: "400 12.5px/1.55 var(--sans)", padding: '7px 10px', resize: 'vertical', outline: 'none',
        }}
      />
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
function AgentPick({ agents, selected, onPick, disabled }: {
  agents: Agent[]; selected: Agent | null; onPick: (g: Agent) => void; disabled?: boolean
}) {
  const [open, setOpen, ref] = usePopover()
  return (
    <div ref={ref} style={{ position: 'relative', flex: 'none' }}>
      <button
        className="ad-btn-pill" disabled={disabled}
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
            Writes the spec and generates the steps for this automation. Auto Dave still executes everything.
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
  packages: PackageDep[]    // §6.2 declared packages — display-only, the pipeline owns the list
  triggers: DraftTrigger[]  // §11 TRIGGERS card preview — what saving stores (§4.3 cron-subset replace)
  instr: string
  enabledAgents: string[]
  allowedSecrets: string[]
  // §11 dirty gating: true only for spec/instruction/agent-ask changes — grant
  // (agent/secret) sync state is derived from steps vs grants, never stored.
  dirty: boolean
  touched: boolean
  specEdit: boolean
  specText: string
  specTextOrig: string
  // §11 spec undo: one-level snapshot taken before an agent rewrite or an
  // in-editor Save lands; editor-state only, never serialized into the draft.
  specUndo: { spec: SpecBlock[]; dirty: boolean } | null
  instrEdit: boolean
  instrDraft: string | null
  ask: string
  syncBusy: boolean
  askBusy: boolean
  // §11 Packages card: an install/retry call in flight; the §8 job's live stage
  // (drives the "Installing the packages…" skeleton + save-hint labels)
  pkgBusy: boolean
  genStage: string | null
  // §8 live progress: the job's finer in-flight line under the stage
  genDetail: string | null
  // §11 drafting-on-Review (create): call-1/call-2 in-flight flags drive the
  // spec-card spinner and the right-column skeletons; a spec-call blocker is
  // the clarification case (editable cards inside the spec card); spec/steps
  // call failures render inside their cards.
  specBusy: boolean
  stepsBusy: boolean
  specBlockers: Blocker[] | null
  specErr: { msg: string; detail?: string[] } | null
  stepsErr: { msg: string; detail?: string[] } | null
  // §11: one repair modal, three entry points — a create job blocked at the
  // steps call, a blocked `sync`, and a failed test's issue analysis all land
  // here; `resolved` is the session's applied resolutions ("Previously
  // resolved"). A blocked `edit` (ask box) shows an amber notice under the
  // ask box instead.
  repair: { source: 'create' | 'sync' | 'test'; blockers: Blocker[] } | null
  resolved: string[]
  askBlockers: Blocker[] | null
  stepOpen: number | null
  viewing: 'draft' | number
  specSecOpen: boolean | null
  agSecOpen: boolean | null
  secSecOpen: boolean | null
  pkgSecOpen: boolean | null
  instrSecOpen: boolean | null
  fwOpen: boolean
}

const revDefaults = {
  dirty: false, touched: false,
  specEdit: false, specText: '', specTextOrig: '',
  specUndo: null as Rev['specUndo'],
  instrEdit: false, instrDraft: null as string | null,
  ask: '', syncBusy: false, askBusy: false,
  pkgBusy: false, genStage: null as string | null, genDetail: null as string | null,
  specBusy: false, stepsBusy: false,
  specBlockers: null as Rev['specBlockers'], specErr: null as Rev['specErr'], stepsErr: null as Rev['stepsErr'],
  repair: null as Rev['repair'], resolved: [] as string[], askBlockers: null as Rev['askBlockers'],
  stepOpen: null as number | null,
  viewing: 'draft' as Rev['viewing'],
  specSecOpen: null as boolean | null, agSecOpen: null as boolean | null, secSecOpen: null as boolean | null, pkgSecOpen: null as boolean | null, instrSecOpen: null as boolean | null, fwOpen: false,
}

// §11 drafting-on-Review: the Review page mounts empty the moment the create
// job starts — the spec card spins on call 1 and the right column shows
// skeletons until call 2 delivers.
function seedDrafting(agents: Agent[]): Rev {
  return {
    ...revDefaults,
    name: 'New automation', desc: '', note: '',
    spec: [], steps: [], params: [], packages: [],
    triggers: [],
    instr: defaultBuildCache,
    enabledAgents: agents.map((g) => g.id),
    allowedSecrets: [],
    specBusy: true,
  }
}

function seedFromPayload(d: DraftPayload, agents: Agent[]): Rev {
  return {
    ...revDefaults,
    name: d.name || 'New automation', desc: d.desc || '', note: d.note || '',
    spec: d.spec ?? [], steps: d.steps ?? [], params: d.params ?? [],
    packages: d.packages ?? [],
    triggers: d.triggers ?? [],
    instr: d.instr ?? defaultBuildCache, // backend seeds instr from default-build-instructions.md
    // §4.4: a resumed pending draft carries its grant selections; a fresh
    // drafting-job payload has none — default to everything enabled.
    enabledAgents: d.stepAgents
      ? d.stepAgents.filter((id) => agents.some((g) => g.id === id))
      : agents.map((g) => g.id),
    allowedSecrets: d.allowedSecrets ?? [],
  }
}

function seedFromAuto(a: Auto, agents: Agent[], secretNames: string[]): Rev {
  const src: Pick<VersionInfo, 'spec' | 'steps' | 'instr'> & { params?: VersionInfo['params']; packages?: VersionInfo['packages'] } =
    a.draft ?? {
      spec: a.spec ?? [], steps: a.steps ?? [], instr: a.instr || '', params: a.params,
      packages: a.packages,
    }
  const refs = secretRefsOf(a.steps ?? [])
  return {
    ...revDefaults,
    name: a.name, desc: a.desc, note: '',
    spec: (src.spec ?? []).map((b) => ({ ...b })),
    steps: (src.steps ?? []).map((s) => ({ ...s })),
    params: (src.params ?? a.params ?? []).map((p) => ({ ...p })),
    packages: (src.packages ?? []).map((p) => ({ ...p })),
    triggers: (a.draft?.triggers ?? a.triggers).map(({ id, kind, off, expr, at, tz }) => ({ id, kind, off, expr, at, tz })),
    instr: src.instr || '',
    // §4.4: a draft carries its own grant selections — resume restores them
    enabledAgents: (() => {
      const g = a.draft?.stepAgents ?? a.stepAgents
      return g ? g.filter((id) => agents.some((x) => x.id === id)) : agents.map((x) => x.id)
    })(),
    allowedSecrets: (() => {
      const g = a.draft?.allowedSecrets ?? a.allowedSecrets
      return g
        ? g.filter((n) => secretNames.includes(n))
        : refs.filter((r) => secretNames.includes(r.name)).map((r) => r.name)
    })(),
    touched: !!a.draft,
  }
}

function loadVersionInto(r: Rev, snap: { spec: SpecBlock[]; steps: Step[]; instr: string; params?: VersionInfo['params']; packages?: VersionInfo['packages'] }, viewing: Rev['viewing']): Rev {
  return {
    ...r,
    spec: (snap.spec ?? []).map((b) => ({ ...b })),
    steps: (snap.steps ?? []).map((s) => ({ ...s })),
    params: snap.params ? snap.params.map((p) => ({ ...p })) : r.params,
    packages: (snap.packages ?? []).map((p) => ({ ...p })),
    instr: snap.instr || '',
    specEdit: false, specText: '', specTextOrig: '', specUndo: null, instrEdit: false, instrDraft: null,
    dirty: false, syncBusy: false, askBusy: false,
    repair: null, resolved: [], askBlockers: null, stepOpen: null, ask: '',
    viewing,
  }
}

function finalizeSteps(steps: Step[], enabled: string[]): Step[] {
  return steps.map((s) => ({
    ...s,
    agentId: s.agent ? (s.agentId && enabled.includes(s.agentId) ? s.agentId : enabled[0] ?? null) : null,
  }))
}

// §4.3 cron-subset replace: a sync's drafted crons take over the schedule — an
// entry matching an existing cron on (expr, tz) keeps its id and off state,
// and one-shot `time` and `app_start` triggers survive untouched.
function mergeDraftTriggers(cur: DraftTrigger[], drafted: DraftTrigger[]): DraftTrigger[] {
  const crons = cur.filter((t) => t.kind === 'cron')
  const used = new Set<number>()
  const next = drafted.map((d) => {
    const i = crons.findIndex((c, j) => !used.has(j) && c.expr === d.expr && (c.tz ?? '') === (d.tz ?? ''))
    if (i < 0) return { ...d, off: false }
    used.add(i)
    return crons[i]
  })
  return [...next, ...cur.filter((t) => t.kind !== 'cron')]
}

function serializeDraft(r: Rev): DraftPayload {
  return {
    name: r.name, desc: r.desc, note: r.note,
    params: r.params,
    packages: r.packages.map(({ pip, import: imp }) => ({ pip, import: imp })),
    steps: finalizeSteps(r.steps, r.enabledAgents),
    spec: r.spec,
    instr: r.instr,
    triggers: r.triggers,
    stepAgents: r.enabledAgents,
    allowedSecrets: r.allowedSecrets,
  }
}

// ---------- step row (read-only agent + secret tags) ----------

function StepRow({ step, i, open, onToggle, availAgents, allAgents, pkgImports }: {
  step: Step; i: number; open: boolean; onToggle: () => void
  availAgents: Agent[]
  allAgents: Agent[]    // full roster — resolves the assigned agent's name even when disabled
  pkgImports: string[]  // §6.2 declared package import names — tagged when the step imports one
}) {
  const asg = step.agent
    ? (step.agentId ? availAgents.find((g) => g.id === step.agentId) ?? null : availAgents[0] ?? null)
    : null
  const orig = !asg && step.agentId ? allAgents.find((g) => g.id === step.agentId) ?? null : null
  const stepSecrets = [...new Set([...(step.code || '').matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))]
  const stepPkgs = pkgImports.filter((n) => new RegExp(`\\b(?:import|from)\\s+${n}\\b`).test(step.code || ''))
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
              <span
                title={asg
                  ? `This step calls ${agName(asg)} · ${dispModel(asg)} mid-execution`
                  : orig
                    ? `${agName(orig)} isn’t enabled for steps — this step would fail`
                    : 'No agent is enabled for steps — this step would fail'}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  background: asg ? 'oklch(0.74 0.155 52 / .1)' : 'oklch(0.7 0.19 25 / .14)',
                  border: `1px solid ${asg ? 'oklch(0.74 0.155 52 / .3)' : 'oklch(0.7 0.19 25 / .4)'}`,
                  borderRadius: 6, padding: '2px 8px', font: "600 10px var(--mono)",
                  color: asg ? 'oklch(0.78 0.13 52)' : 'oklch(0.78 0.15 25)', whiteSpace: 'nowrap',
                }}
              >
                <i className="fa-solid fa-robot" style={{ fontSize: 8.5 }} /> {asg ? agName(asg) : orig ? agName(orig) : 'no agent'}
              </span>
            )}
            {stepSecrets.map((name) => (
              <span
                key={name}
                title={`This step uses the ${name} secret from your Keychain`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)',
                  borderRadius: 6, padding: '2px 8px', font: "600 10px var(--mono)",
                  color: 'var(--text-muted)', whiteSpace: 'nowrap',
                }}
              >
                <i className="fa-solid fa-key" style={{ fontSize: 8.5 }} /> {name}
              </span>
            ))}
            {stepPkgs.map((name) => (
              <span
                key={name}
                title={`This step uses the ${name} Python package — installed automatically`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)',
                  borderRadius: 6, padding: '2px 8px', font: "600 10px var(--mono)",
                  color: 'var(--text-muted)', whiteSpace: 'nowrap',
                }}
              >
                <i className="fa-solid fa-cube" style={{ fontSize: 8.5 }} /> {name}
              </span>
            ))}
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

// ---------- param value editor (§4.2 kinds — create-mode card + §11 test values) ----------

function ParamEditor({ p, upd }: { p: ParamDef; upd: (patch: Record<string, unknown>) => void }) {
  const inputStyle: React.CSSProperties = {
    flex: 1, minWidth: 0, background: 'var(--bg-inset)', border: '1px solid rgba(255,255,255,.09)',
    borderRadius: 7, color: 'var(--text)', font: "400 12px var(--mono)", padding: '7px 10px', outline: 'none',
  }
  if (p.kind === 'toggle') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '13px 20px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
        <div>
          <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
          <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: 3 }}>{p.help}</div>
        </div>
        <Toggle on={!!p.on} onChange={(v) => upd({ on: v, default: v })} />
      </div>
    )
  }
  if (p.kind === 'list') {
    const lines = p.lines ?? []
    const setLines = (next: string[]) => upd({ lines: next, default: next })
    const good = lines.filter((l) => l.trim() && validUrl(l)).length
    const bad = lines.filter((l) => l.trim() && !validUrl(l)).length
    return (
      <div style={{ padding: '14px 20px 15px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
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
    const setRows = (next: { k: string; v: string }[]) => upd({ rows: next, default: next })
    return (
      <div style={{ padding: '14px 20px 15px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '13px 20px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
          <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: 3 }}>{p.help}</div>
        </div>
        <input
          value={String(p.value ?? '')}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '')
            upd({ value: digits === '' ? '' : Number(digits), default: digits === '' ? mn : Number(digits) })
          }}
          onBlur={() => {
            const n = typeof p.value === 'number' ? p.value : NaN
            if (Number.isNaN(n) || n < mn) upd({ value: mn, default: mn })
          }}
          style={{ ...inputStyle, flex: 'none', width: 84, textAlign: 'right' }}
        />
      </div>
    )
  }
  // text
  return (
    <div style={{ padding: '14px 20px 15px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
      <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
      <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', margin: '3px 0 9px' }}>{p.help}</div>
      <input
        value={String(p.value ?? '')} placeholder={p.placeholder}
        onChange={(e) => upd({ value: e.target.value, default: e.target.value })}
        style={{ ...inputStyle, width: '100%' }}
      />
    </div>
  )
}

// ---------- the page ----------

export default function CreateFlow() {
  const store = useStore()
  const { agents, secrets, autos, createFrom, autoId, go, setSurface, showToast, loadAuto, test, beginTest, clearTest, consumeTestIssue } = store
  const isEdit = createFrom === 'edit'
  const isOnboard = createFrom === 'onboard'
  const auto = isEdit ? autos.find((a) => a.id === autoId) ?? null : null

  const [phase, setPhase] = useState<'ask' | 'review'>(isEdit ? 'review' : 'ask')
  const [text, setText] = useState('')
  const [askHint, setAskHint] = useState(false)
  const [textFocus, setTextFocus] = useState(false)
  const [agentId, setAgentId] = useState<string | null>(() =>
    isEdit ? (auto?.agentId ?? null) : ((agents.find((g) => g.default) ?? agents[0])?.id ?? null))

  const jobIdRef = useRef<string | null>(null)

  const [rev, setRev] = useState<Rev | null>(null)
  // §11 test parameter values (edit mode): null = collapsed — the test uses the
  // automation's stored values; non-null = the per-test overrides being edited.
  const [testParams, setTestParams] = useState<ParamDef[] | null>(null)
  const [confirmSpecCancel, setConfirmSpecCancel] = useState(false)
  // Blocker-modal apply travels through Modal's animated close (ConfirmModal pattern).
  const applyBlockedRef = useRef(false)
  const draftSnap = useRef<Rev | null>(null)
  const seededRef = useRef(false)

  // §4.4: any exit path keeps the draft — system back/forward unmounts the editor
  // without going through close(), so the persist lives in unmount cleanup.
  // Discard and save settle the draft so leaving afterwards writes nothing.
  // Create mode keeps to the pending slot (<root>/draft/) once a draft landed.
  const revRef = useRef(rev)
  revRef.current = rev
  const autoRef = useRef(auto)
  autoRef.current = auto
  const agentIdRef = useRef(agentId)
  agentIdRef.current = agentId
  const draftSettled = useRef(false)
  useEffect(() => () => {
    const r = revRef.current
    const a = autoRef.current
    if (draftSettled.current) return
    if (isEdit) {
      if (!a) return
      if (r && r.viewing === 'draft' && (r.touched || a.draft)) {
        void api.putDraft(a.id, serializeDraft(r)).catch(() => { /* backend restarting */ })
      }
      return
    }
    if (r && !r.specBusy && (r.spec.length || r.steps.length)) {
      void api.putPendingDraft(serializeDraft(r), agentIdRef.current).catch(() => { /* backend restarting */ })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // §4.4: opening the create flow while the pending slot holds a draft resumes
  // it straight on Review; guarded so a fast Ask submission wins the race.
  // Opening also makes the slot's container exist (empty memory/workspace/
  // result) before any drafting — §11 tests execute in draft/workspace/.
  useEffect(() => {
    if (isEdit) return
    void api.openPendingDraft().catch(() => { /* backend restarting */ })
    let dead = false
    void api.getPendingDraft().then(({ draft, agentId: gid }) => {
      if (dead || !draft || seededRef.current || revRef.current) return
      seededRef.current = true
      const seeded = seedFromPayload(draft, agents)
      // A draft kept mid-steps-generation resumes spec-only — mark it out of
      // sync so the §11 sync panel offers the rebuild.
      setRev({ ...seeded, touched: true, ...(seeded.steps.length ? {} : { dirty: true }) })
      if (gid && agents.some((g) => g.id === gid)) setAgentId(gid)
      setPhase('review')
      showToast('Resumed your unsaved draft — Start over discards it.', 3400)
    }).catch(() => { /* backend restarting; the Ask page still works */ })
    return () => { dead = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
    onSpec?: (spec: SpecBlock[]) => void, // §11: create job's call-1 spec, mid-job
  ) => {
    stopPoll()
    jobIdRef.current = jobId
    let specDelivered = false
    let lastStage: string | null = null
    let lastDetail: string | null = null
    // Staleness guard: a slow in-flight tick may resolve after this job was
    // cancelled/replaced (jobIdRef changed) or after another tick already
    // handled the terminal status (jobIdRef cleared below). Checking the ref
    // covers both — callbacks fire once, and never against a different job.
    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const j = await api.getDraftJob(jobId)
          if (jobIdRef.current !== jobId) return
          if (j.status !== 'building') jobIdRef.current = null
          // §8/§11: the job's live stage drives the skeleton + save-hint labels
          // ("Installing the packages…" after the steps land); `detail` is the
          // finer live-progress line under it.
          if (j.status === 'building' && (j.stage !== lastStage || (j.detail ?? null) !== lastDetail)) {
            lastStage = j.stage
            lastDetail = j.detail ?? null
            setRev((r) => (r ? { ...r, genStage: j.stage, genDetail: lastDetail } : r))
          }
          if (onSpec && !specDelivered && j.status === 'building' && j.draft?.spec) {
            specDelivered = true
            onSpec(j.draft.spec)
          }
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
          if (jobIdRef.current !== jobId) return
          jobIdRef.current = null
          stopPoll()
          onFail((e as Error).message)
        }
      })()
    }, 700)
  }
  useEffect(() => () => {
    stopPoll()
    // Leaving the editor any way (sidebar nav, system back) must not orphan an
    // in-flight §8 drafting job — nobody would poll it and the harness would
    // keep working for a discarded result. Cancelling a finished job is a no-op.
    if (jobIdRef.current) void api.cancelDraftJob(jobIdRef.current).catch(() => { /* already gone */ })
    // Leaving the editor abandons any live test — it's ephemeral (§11).
    const t = useStore.getState().test
    if (t?.status === 'executing') void api.cancelTest(t.testId).catch(() => { /* already gone */ })
    useStore.getState().clearTest()
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

  // ---- ask → review, drafting state (§11: no separate building screen) ----
  // Review mounts empty right away; the spec card spins on call 1, renders the
  // spec the moment it validates (onSpec, mid-job), and the right column stays
  // skeleton until call 2 delivers the steps.
  const submitAsk = async (description?: string) => {
    const request = (description ?? text).trim()
    if (!request) { setAskHint(true); return }
    setAskHint(false)
    setPhase('review')
    setRev(seedDrafting(agents))
    try {
      const { jobId } = await api.postDraftJob({ mode: 'create', text: request, agentId })
      startPoll(
        jobId,
        (d) => setRev({
          ...seedFromPayload(d, agents),
          // §11 title: the manifest name replaces the spec-title provisional
          name: d.name || (d.spec ?? []).find((b) => b.k === 'h1')?.text || 'New automation',
        }),
        (msg, detail) => setRev((r) => r && (r.specBusy
          ? { ...r, specBusy: false, specErr: { msg, detail } }
          : { ...r, stepsBusy: false, stepsErr: { msg, detail } })),
        () => { setRev(null); setPhase('ask') },
        // §11 Blockers & clarifications: a spec-call block renders editable
        // cards inside the spec card; a steps-call block opens the repair
        // modal over Review and leaves the workflow out of sync.
        (blockers, at, spec) => setRev((r) => r && (at === 'spec'
          ? { ...r, specBusy: false, stepsBusy: false, specBlockers: blockers }
          : {
            ...r, stepsBusy: false, spec: spec ?? r.spec, dirty: true,
            repair: { source: 'create', blockers },
          })),
        (spec) => setRev((r) => r && ({
          ...r, specBusy: false, stepsBusy: true, spec,
          name: spec.find((b) => b.k === 'h1')?.text || r.name,
        })),
      )
    } catch (e) {
      setRev((r) => r && ({ ...r, specBusy: false, specErr: { msg: (e as Error).message } }))
    }
  }

  // §11 clarification case: the user answers the spec-call blockers by editing
  // the cards; the answers are appended to the description and a new create
  // job starts in place.
  const answerBlockers = () => {
    if (!rev?.specBlockers || rev.specBlockers.some((b) => !b.reason.trim() || !b.fix.trim())) return
    const combined = `${text.trim()}\n\n${rev.specBlockers.map(blockerLine).join('\n')}`
    setText(combined)
    void submitAsk(combined)
  }

  // Back to Ask from a drafting-state card (clarification/failure/Start over) —
  // the description survives for a rephrase.
  const backToAsk = () => {
    stopPoll()
    if (jobIdRef.current) void api.cancelDraftJob(jobIdRef.current).catch(() => { /* already gone */ })
    jobIdRef.current = null
    // §4.4: Start over / Back to Ask discards the pending slot.
    void api.deletePendingDraft().catch(() => { /* none kept */ })
    setRev(null)
    setPhase('ask')
  }

  // §11: any spec / instruction / agent-ask / grant change while the steps are
  // still generating cancels the in-flight steps call — the landed spec is
  // kept and the standard sync panel rebuilds the steps. Returns true when a
  // steps call was cancelled (callers add stepsBusy:false + dirty to their patch).
  const cancelStepsGen = (): boolean => {
    if (!rev?.stepsBusy) return false
    stopPoll()
    if (jobIdRef.current) void api.cancelDraftJob(jobIdRef.current).catch(() => { /* already gone */ })
    jobIdRef.current = null
    return true
  }

  // ---- review: derived ----
  const availAgents = rev ? rev.enabledAgents.map((id) => agents.find((g) => g.id === id)).filter((g): g is Agent => !!g) : []
  const resolveAg = (s: Step): Agent | null =>
    s.agentId ? availAgents.find((g) => g.id === s.agentId) ?? null : availAgents[0] ?? null
  const agentStepIdx = rev ? rev.steps.map((s, i) => (s.agent ? i : -1)).filter((i) => i >= 0) : []
  // Memoized: this regex-scans every step's code and would otherwise re-run on
  // every keystroke anywhere in the editor.
  const secRefs = React.useMemo(() => (rev ? secretRefsOf(rev.steps) : []), [rev?.steps])
  const secNotAllowed = secRefs.filter((r) => secrets.some((z) => z.name === r.name) && !(rev?.allowedSecrets ?? []).includes(r.name))
  const secMissing = secRefs.filter((r) => !secrets.some((z) => z.name === r.name))
  const agWarn = !!rev && agentStepIdx.length > 0 && availAgents.length === 0
  const secWarn = !!rev && (secNotAllowed.length > 0 || secMissing.length > 0)
  // §11 dirty gating: grant sync state is derived, never stored — the workflow
  // is out of sync from grants exactly while a step needs a grant it doesn't
  // have. Re-checking the grant clears it instantly; toggles alone never dirty.
  const agentGap = !!rev && agentStepIdx.some((i) => {
    const s = rev.steps[i]
    return s.agentId ? !rev.enabledAgents.includes(s.agentId) : rev.enabledAgents.length === 0
  })
  const secretGap = secNotAllowed.length > 0
  // §11: the spec, agents, and secrets cards default open; the spec card is
  // force-open while the spec is writing, showing clarification cards, or
  // being edited.
  const specOpenEff = !!rev?.specEdit || !!rev?.specBusy || !!rev?.specBlockers || !!rev?.specErr
    || ((rev?.specSecOpen ?? null) == null ? true : !!rev?.specSecOpen)
  const agSecOpenEff = ((rev?.agSecOpen ?? null) == null ? true : !!rev?.agSecOpen) || agWarn
  const secSecOpenEff = ((rev?.secSecOpen ?? null) == null ? true : !!rev?.secSecOpen) || secWarn
  // §11 Packages card: default collapsed when everything is installed; forced
  // open while any row is installing, not installed, or failed.
  const pkgProblem = !!rev && rev.packages.some((p) => p.status && p.status !== 'installed')
  const pkgSecOpenEff = (((rev?.pkgSecOpen ?? null) == null ? pkgProblem : !!rev?.pkgSecOpen) || pkgProblem || !!rev?.pkgBusy)
  const instrOpenEff = (rev?.instrSecOpen ?? null) == null ? isEdit : !!rev?.instrSecOpen
  const viewingOld = isEdit && !!rev && !!auto && rev.viewing !== 'draft' && rev.viewing !== auto.version
  // §5: permissions are never versioned — a grant gap never blocks restoring an
  // old version; it fails at execution time instead (the cards still warn).
  const outOfSync = !!rev && (rev.dirty || (!viewingOld && (agentGap || secretGap)))
  const drafting = !!rev && (rev.specBusy || rev.stepsBusy)
  const saveBlocked = !!rev && (outOfSync || rev.syncBusy || rev.askBusy || rev.specEdit
    || drafting || (!isEdit && rev.steps.length === 0))
  const busyRewrite = !!rev && (rev.syncBusy || rev.askBusy)
  // Sync panel: the button disables (never hides) while any §8 job runs, while
  // drafting, while viewing an old version, and while there are no steps yet.
  const syncDisabled = !rev || busyRewrite || drafting || viewingOld || rev.steps.length === 0
  // §11 inputs-lock: while a sync or spec rewrite runs, every input disables —
  // buttons get `disabled`, non-button rows get this style. One shared look.
  const lockStyle: React.CSSProperties | undefined = busyRewrite ? { opacity: 0.45, pointerEvents: 'none' } : undefined
  // Right-column skeleton label — §11 drafting stages
  const installingPkgs = rev?.genStage === 'Installing the packages'
  const stageLabel = rev?.specBusy ? 'Waiting for the spec…'
    : installingPkgs ? 'Installing the packages…' : 'Generating the steps…'

  // ---- review: agent-ask + sync jobs ----
  const currentSerialized = () => (rev ? serializeDraft(rev) : null)

  // §11: the ask box starts one §8 `edit` job (spec call only) — the drafting
  // agent gets the in-editor draft (spec + steps + build instructions) and
  // grants context and returns the rewritten spec. The steps stay untouched:
  // the new spec lands out of sync and the sync panel rebuilds them later.
  const sendAsk = async () => {
    if (!rev || rev.syncBusy || rev.askBusy) return
    if (!rev.ask.trim()) { showToast('Type the change you want first.'); return }
    const request = rev.ask.trim()
    askReqRef.current = request
    const genCancelled = cancelStepsGen()
    up({
      specEdit: false, specText: '', specTextOrig: '', instrDraft: null, instrEdit: false, // one edit at a time
      ask: '', askBusy: true, askBlockers: null, genStage: null, genDetail: null, touched: true,
      ...(genCancelled ? { stepsBusy: false, dirty: true } : {}),
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
            // §11 spec undo: stash the pre-rewrite spec + dirty flag
            ...(d.spec ? { specUndo: { spec: r.spec, dirty: r.dirty } } : {}),
            spec: d.spec ?? r.spec, dirty: true,
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

  // §11 spec undo: restore the one-level snapshot, dirty flag included — grant
  // sync state is derived, so an intervening agent/secret change keeps its own
  // out-of-sync state regardless.
  const undoSpec = () => {
    setRev((r) => {
      if (!r || !r.specUndo) return r
      const snap = r.specUndo
      return { ...r, spec: snap.spec, specUndo: null, touched: true, dirty: snap.dirty }
    })
    showToast('Last spec change undone.', 3200)
  }

  // §11: a blocked sync opens the repair modal; applying amends the in-editor
  // spec (specOverride) and repeats the sync with it.
  const runSync = async (specOverride?: SpecBlock[]) => {
    if (!rev || rev.syncBusy || rev.askBusy) return
    // A cancel must return the panel to the state it was in (§11) — a sync
    // started from a clean draft must not leave it marked out-of-sync.
    dirtyBeforeSync.current = rev.dirty
    up({
      specEdit: false, specText: '', specTextOrig: '', instrDraft: null, instrEdit: false, // discard unsaved edits
      syncBusy: true, genStage: null, genDetail: null, touched: true, stepsErr: null,
      // §11 spec undo: a repair amend replaces the spec outside the undo flow
      ...(specOverride ? { spec: specOverride, specUndo: null } : {}),
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
              ...r, syncBusy: false, genStage: null, dirty: false, specUndo: null,
              steps, params: d.params ?? r.params, packages: d.packages ?? [], stepOpen: null,
              triggers: d.triggers ? mergeDraftTriggers(r.triggers, d.triggers) : r.triggers,
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

  // §11 Packages card: check statuses once per package list (§19 /packages/check,
  // fast, no pip) — a saved automation whose packages went missing shows
  // "not installed" without waiting for an execution to self-heal.
  const pkgKey = rev ? rev.packages.map((p) => p.pip).join('\n') : ''
  useEffect(() => {
    if (!rev || rev.packages.length === 0 || !rev.packages.some((p) => !p.status)) return
    let stale = false
    void api.checkPackages(rev.packages.map(({ pip, import: imp }) => ({ pip, import: imp })))
      .then(({ packages }) => {
        if (stale) return
        setRev((r) => r && ({
          ...r,
          packages: r.packages.map((p) => {
            const c = packages.find((z) => z.pip === p.pip)
            return p.status || !c ? p : { ...p, status: c.status }
          }),
        }))
      })
      .catch(() => { /* statuses stay unknown; the engine still ensures at execution (§7) */ })
    return () => { stale = true }
  }, [pkgKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // §11/§6.2 update badges: one read-only PyPI check per package list (§19
  // /packages/outdated) — advisory, a failure just leaves the badges off.
  useEffect(() => {
    if (!rev || rev.packages.length === 0) return
    let stale = false
    void api.outdatedPackages(rev.packages.map(({ pip, import: imp }) => ({ pip, import: imp })))
      .then(({ packages }) => {
        if (stale) return
        setRev((r) => r && ({
          ...r,
          packages: r.packages.map((p) => {
            const c = packages.find((z) => z.pip === p.pip)
            return c ? { ...p, latest: c.latest } : p
          }),
        }))
      })
      .catch(() => { /* badges stay off */ })
    return () => { stale = true }
  }, [pkgKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // §11/§6.2 Update / Update all — manifest-first: the §19 update call rewrites
  // the pin across every automation declaring the distribution, then installs.
  const updatePkgs = async (pips: string[]) => {
    if (!rev || rev.pkgBusy) return
    const pipName = (s: string) => s.split('==')[0].replace(/[-_.]+/g, '-').toLowerCase()
    const targets = rev.packages.filter((p) => p.latest && pips.includes(p.pip))
    if (targets.length === 0) return
    const before = rev.packages
    const list = targets.map((p) => ({ pip: `${p.pip.split('==')[0]}==${p.latest}`, import: p.import }))
    up({
      pkgBusy: true,
      packages: rev.packages.map((p) => (targets.includes(p) ? { ...p, status: 'installing' as const, error: undefined } : p)),
    })
    try {
      const { packages, updated } = await api.updatePackages(list)
      setRev((r) => r && ({
        ...r, pkgBusy: false,
        packages: r.packages.map((p) => {
          const c = p.status === 'installing' && packages.find((z) => pipName(z.pip) === pipName(p.pip))
          return c ? { ...c, latest: undefined } : p
        }),
      }))
      showToast(updated.length > 0
        ? `Updated — the new pin now applies to ${updated.length === 1 ? '1 automation' : `${updated.length} automations`}.`
        : 'Updated.', 3600)
    } catch (e) {
      setRev((r) => r && ({ ...r, pkgBusy: false, packages: before }))
      showToast((e as Error).message)
    }
  }

  // §11: Install / Retry on the Packages card — the blocking §19 ensure; rows
  // show spinners while it runs. An install failure never blocks saving (§6.2).
  const installPkgs = async () => {
    if (!rev || rev.pkgBusy) return
    const list = rev.packages.map(({ pip, import: imp }) => ({ pip, import: imp }))
    up({
      pkgBusy: true,
      packages: rev.packages.map((p) => (p.status === 'installed' ? p : { ...p, status: 'installing' as const, error: undefined })),
    })
    try {
      const { packages } = await api.installPackages(list)
      setRev((r) => r && ({
        ...r, pkgBusy: false,
        packages: r.packages.map((p) => packages.find((z) => z.pip === p.pip) ?? p),
      }))
    } catch (e) {
      setRev((r) => r && ({
        ...r, pkgBusy: false,
        packages: r.packages.map((p) => (p.status === 'installing' ? { ...p, status: 'missing' as const } : p)),
      }))
      showToast((e as Error).message)
    }
  }

  // §11: Cancel on the in-flight agent-ask spinner — kill the job; the draft
  // is untouched and the request text returns to the ask box for editing.
  const askReqRef = useRef('')
  const cancelAsk = () => {
    if (!rev?.askBusy) return
    stopPoll()
    if (jobIdRef.current) void api.cancelDraftJob(jobIdRef.current).catch(() => { /* already gone */ })
    jobIdRef.current = null
    setRev((r) => r && ({ ...r, askBusy: false, ask: r.ask || askReqRef.current }))
    showToast('Edit stopped — the spec is unchanged.', 4200)
  }

  // §11: Cancel on the in-flight sync spinner — kill the job, keep the steps
  // and spec untouched, return the panel to the state it was in before.
  const dirtyBeforeSync = useRef(false)
  const cancelSync = () => {
    if (!rev?.syncBusy) return
    stopPoll()
    if (jobIdRef.current) void api.cancelDraftJob(jobIdRef.current).catch(() => { /* already gone */ })
    jobIdRef.current = null
    const wasDirty = dirtyBeforeSync.current
    setRev((r) => r && ({ ...r, syncBusy: false, dirty: wasDirty }))
    showToast(wasDirty
      ? 'Sync stopped — the workflow is still out of sync.'
      : 'Sync stopped — nothing changed.', 4200)
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

  // §11: a failed test's issue analysis lands in the same repair modal.
  useEffect(() => {
    if (!test?.issue || !rev) return
    up({ repair: { source: 'test', blockers: test.issue } })
    consumeTestIssue()
  }, [test?.issue]) // eslint-disable-line react-hooks/exhaustive-deps

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
    // Leaving create mid-generation abandons the job — kill the harness.
    if (!isEdit && jobIdRef.current && drafting) {
      void api.cancelDraftJob(jobIdRef.current).catch(() => { /* already gone */ })
      jobIdRef.current = null
    }
    if (isEdit && auto) {
      if (rev && rev.viewing === 'draft' && (rev.touched || auto.draft)) {
        try { await api.putDraft(auto.id, serializeDraft(rev)) } catch { /* backend restarting */ }
        draftSettled.current = true
        showToast('Draft kept — resume or execute it from this automation anytime.', 3400)
      }
      setSurface('app')
      go('automation')
      return
    }
    // §4.4: leaving create mode after a draft landed keeps the pending slot.
    if (!isEdit && rev && !rev.specBusy && (rev.spec.length || rev.steps.length)) {
      try { await api.putPendingDraft(serializeDraft(rev), agentId) } catch { /* backend restarting */ }
      draftSettled.current = true
      showToast('Draft kept — Resume draft picks it up anytime.', 3400)
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
      draftSettled.current = true
      setSurface('app')
      go('automation')
      showToast(`Changes discarded — back to v${auto.version} as saved.`, 3200)
      return
    }
    backToAsk()
  }

  const doSave = async () => {
    if (!rev || saveBlocked) return
    try {
      draftSettled.current = true
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
            ? `Version ${version} saved. The execution in progress finishes on v${version - 1} — v${version} applies from the next execution.`
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
        showToast('Created — nothing has executed yet. Press Execute now when you’re ready.', 3600)
      }
    } catch (e) {
      draftSettled.current = false
      showToast((e as Error).message)
    }
  }

  const skipOnboard = () => {
    localStorage.setItem('ad-onboarded', '1')
    setSurface('app')
    go('automations')
  }

  // ---- test (§11: create and edit mode) — executes the draft's REAL steps ----
  // §11 test values: seed from the automation's current values (draft default when a param
  // is new to the draft; create mode has no automation, so pure draft defaults) — edited
  // copies live only in this card.
  const seedTestParams = (): ParamDef[] => (rev?.params ?? []).map((d) => {
    const cur = (auto?.params ?? []).find((p) => p.name === d.name && p.kind === d.kind)
    if (d.kind === 'toggle') return { ...d, on: cur ? !!cur.on : !!d.default }
    if (d.kind === 'list') return { ...d, lines: cur?.lines ?? (Array.isArray(d.default) ? d.default as string[] : []) }
    if (d.kind === 'kv') return { ...d, rows: cur?.rows ?? (Array.isArray(d.default) ? d.default as { k: string; v: string }[] : []) }
    return { ...d, value: cur?.value ?? (d.default as string | number | undefined) }
  })
  // A synced/reloaded draft may rename or retype params — collapse back to stored values.
  useEffect(() => { setTestParams(null) }, [rev?.params])
  const testParamValues = (ps: ParamDef[]) => Object.fromEntries(ps.map((p) => [p.name,
    p.kind === 'toggle' ? !!p.on
    : p.kind === 'list' ? (p.lines ?? [])
    : p.kind === 'kv' ? (p.rows ?? [])
    : p.kind === 'number' ? (typeof p.value === 'number' ? p.value : (p.min ?? 0))
    : String(p.value ?? ''),
  ]))
  const runTest = async () => {
    if (!rev || rev.steps.length === 0 || test?.status === 'executing' || busyRewrite) return
    clearTest()
    try {
      const { testId } = await api.postTest({
        draft: serializeDraft(rev),
        ...(isEdit && auto ? { autoId: auto.id } : {}), // edit: scratch memory copies the automation's
        ...(testParams ? { paramValues: testParamValues(testParams) } : {}), // §11 test-only values
        agentId, // the drafting agent also handles the §8 issue analysis on failure
        enabledAgents: rev.enabledAgents, allowedSecrets: rev.allowedSecrets,
      })
      beginTest(testId)
    } catch (e) {
      showToast((e as Error).message)
    }
  }
  const cancelTest = () => {
    if (test?.status === 'executing') void api.cancelTest(test.testId).catch(() => { /* already done */ })
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
              Describe the job in plain words. Your AI writes it as scripts — you review everything before it executes.
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
                {isEdit ? `Edit “${auto?.name ?? 'automation'}”`
                  : rev.specBusy ? 'New automation…'
                    : rev.spec.find((b) => b.k === 'h1')?.text && rev.name === 'New automation'
                      ? rev.spec.find((b) => b.k === 'h1')!.text
                      : rev.name}
              </h1>
              {isEdit && auto && (
                <div ref={verRef} style={{ position: 'relative' }}>
                  <button className="ad-btn-pill" disabled={busyRewrite} onClick={() => setVerOpen(!verOpen)}>
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
                agents={agents} selected={selAgent} disabled={busyRewrite}
                onPick={(g) => {
                  if (busyRewrite || drafting) { showToast('Wait for the current rewrite to finish first.'); return }
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
                    {rev.specBusy ? 'Writing the spec…'
                      : rev.stepsBusy ? (installingPkgs ? 'Installing the packages…' : 'Generating the steps…')
                        : rev.syncBusy ? (installingPkgs ? 'Installing the packages…' : 'Syncing steps…')
                          : rev.askBusy ? 'Rewriting the spec…'
                            : rev.specEdit ? 'Finish editing the spec first — save or cancel your edits'
                              : 'Sync and review the steps before saving'}
                  </span>
                )}
                <button className="ad-btn-text dim" disabled={busyRewrite} onClick={() => void startOver()} style={{ font: "500 12.5px var(--sans)", padding: '6px 4px' }}>
                  {isEdit ? 'Discard draft' : 'Start over'}
                </button>
                {isEdit && (rev.touched || !!auto?.draft) && (
                  <button className="ad-btn-ghost" onClick={() => void close()} style={{ padding: '8px 15px' }}>
                    Keep draft
                  </button>
                )}
                <BtnPrimary onClick={() => void doSave()} disabled={saveBlocked} style={{ padding: '9px 16px' }}>
                  {isEdit && auto
                    ? (viewingOld ? `Restore v${rev.viewing} as v${auto.version + 1}` : `Save as v${auto.version + 1}`)
                    : 'Create automation'}
                </BtnPrimary>
              </div>
            </div>
            <p style={{ font: "400 13.5px/1.6 var(--sans)", color: 'var(--text-2)', margin: '0 0 20px' }}>
              Read what your AI wrote. Change anything — nothing executes until you create it.
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
                <button className="ad-btn-soft" disabled={busyRewrite} onClick={() => pickVersion('draft')} style={{ borderRadius: 7, font: "500 12px var(--sans)", padding: '6px 12px', flex: 'none' }}>
                  Back to draft
                </button>
              </div>
            )}

            {/* live-execution note */}
            {isEdit && auto?.live && (
              <div style={{
                background: 'oklch(0.78 0.12 210 / .07)', border: '1px solid oklch(0.78 0.12 210 / .3)',
                borderRadius: 10, padding: '11px 16px', margin: '0 0 18px',
                display: 'flex', alignItems: 'center', gap: 11, animation: 'adFadeUp .3s ease both',
              }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--cyan)', animation: 'adPulse 1.4s ease-in-out infinite', flex: 'none' }} />
                <span style={{ flex: 1, font: "400 12.5px/1.5 var(--sans)", color: 'var(--text)' }}>
                  {`An execution is happening right now on v${auto.version}. Saving won’t interrupt it — that execution finishes on v${auto.version}. v${auto.version + 1} takes over from the next execution (${nextTriggerShort(auto.triggers) ?? auto.triggerChip}).`}
                </span>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,.95fr)', gap: 18, alignItems: 'start' }}>
              {/* ===== left column ===== */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* SPEC */}
                <div style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: specOpenEff ? '1px solid var(--hairline)' : 'none' }}>
                    <span
                      onClick={() => { if (!rev.specEdit) up({ specSecOpen: !specOpenEff }) }}
                      style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: rev.specEdit ? 'default' : 'pointer', userSelect: 'none' }}
                    >
                      <i className={specOpenEff ? 'fa-solid fa-caret-down' : 'fa-solid fa-caret-right'} style={{ width: 14, flex: 'none', textAlign: 'center', fontSize: 10, color: '#4a515c' }} />
                      <span style={eyebrowStyle}>SPEC</span>
                    </span>
                    {specOpenEff && !rev.specBusy && !rev.specBlockers && !rev.specErr && (!rev.specEdit ? (
                      <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
                      {rev.specUndo && (
                        <button
                          className="ad-btn-text dim" disabled={busyRewrite}
                          onClick={undoSpec}
                          style={{ font: "500 11.5px var(--sans)", padding: '4px 4px' }}
                        >
                          Undo
                        </button>
                      )}
                      <button
                        className="ad-btn-soft" disabled={busyRewrite}
                        onClick={() => {
                          if (busyRewrite) return
                          // §11: starting a spec edit while the steps are still
                          // generating cancels the steps call — sync rebuilds later.
                          const genCancelled = cancelStepsGen()
                          const t = specToText(rev.spec)
                          up({
                            instrDraft: null, instrEdit: false, specText: t, specTextOrig: t, specEdit: true,
                            ...(genCancelled ? { stepsBusy: false, dirty: true } : {}),
                          })
                          if (genCancelled) showToast('Step generation stopped — sync the steps when you finish editing.', 4200)
                        }}
                      >
                        Edit
                      </button>
                      </div>
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
                              specUndo: { spec: rev.spec, dirty: rev.dirty },
                              spec: textToSpec(rev.specText), specEdit: false, specText: '', specTextOrig: '',
                              dirty: true, touched: true,
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
                    ))}
                  </div>
                  {!specOpenEff && (
                    <div onClick={() => up({ specSecOpen: true })} style={{ padding: '0 20px 13px 43px', font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-faintest)', cursor: 'pointer', userSelect: 'none' }}>
                      What the automation should do, in plain words. The AI regenerates the steps from this document when it changes.
                    </div>
                  )}
                  {specOpenEff && (<>
                  {/* §11 drafting-on-Review: call 1 in flight */}
                  {rev.specBusy ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '46px 20px 50px' }}>
                      <span style={{
                        width: 22, height: 22, border: '2.5px solid rgba(255,255,255,.1)', borderTopColor: 'var(--accent)',
                        borderRadius: '50%', animation: 'adSpin .9s linear infinite',
                      }} />
                      <span style={{ font: "500 13px var(--sans)", color: 'var(--text-2)' }}>Writing the spec…</span>
                      {/* §8/§11 live progress: streamed detail line */}
                      {rev.genDetail && (
                        <span style={{ font: "400 12px var(--sans)", color: 'var(--text-muted)' }}>{rev.genDetail}</span>
                      )}
                      <span style={{ font: "500 11px var(--mono)", color: 'var(--text-faintest)' }}>
                        {selAgent ? `${agName(selAgent)} · ${dispModel(selAgent)}` : 'No agent'}
                      </span>
                    </div>
                  ) : rev.specErr ? (
                    /* §11: a spec-call failure renders inside the spec card */
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '30px 20px 26px' }}>
                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--red)' }} />
                      <div style={{ font: "500 13.5px var(--sans)", color: 'var(--text)', textAlign: 'center' }}>
                        {rev.specErr.msg || 'The spec didn’t validate — try again or rephrase.'}
                      </div>
                      {(rev.specErr.detail ?? []).length > 0 && (
                        <div style={{
                          alignSelf: 'stretch', background: 'var(--bg-inset)', border: '1px solid rgba(255,255,255,.07)',
                          borderRadius: 9, padding: '10px 14px', font: "400 11.5px/1.7 var(--mono)", color: 'var(--text-muted)',
                        }}>
                          {(rev.specErr.detail ?? []).map((d, i) => <div key={i}>{d}</div>)}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 10 }}>
                        <BtnGhost onClick={backToAsk}>Back to the request</BtnGhost>
                        <BtnPrimary onClick={() => void submitAsk()}>Try again</BtnPrimary>
                      </div>
                    </div>
                  ) : rev.specBlockers ? (
                    /* §11 clarification case: spec-call blockers, editable, in place of the spec body */
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 16px 18px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--amber)', flex: 'none' }} />
                        <span style={{ font: "600 13.5px var(--sans)", color: 'var(--text)' }}>
                          {rev.specBlockers.length > 1 ? `Your AI hit ${rev.specBlockers.length} blockers` : 'Your AI hit a blocker'}
                        </span>
                      </div>
                      <div style={{ font: "400 12.5px/1.6 var(--sans)", color: 'var(--text-2)', margin: '-6px 0 0 17px' }}>
                        It couldn’t write a spec for this request. Answer below — your answers are added to the request and the spec is rewritten.
                      </div>
                      <BlockerCards
                        blockers={rev.specBlockers}
                        onChange={(i, patch) => setRev((r) => r && r.specBlockers && ({
                          ...r, specBlockers: r.specBlockers.map((b, k) => (k === i ? { ...b, ...patch } : b)),
                        }))}
                      />
                      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                        <BtnGhost onClick={backToAsk}>Back to the request</BtnGhost>
                        <BtnPrimary
                          onClick={answerBlockers}
                          disabled={rev.specBlockers.some((b) => !b.reason.trim() || !b.fix.trim())}
                        >
                          Answer & rewrite the spec
                        </BtnPrimary>
                      </div>
                    </div>
                  ) : rev.specEdit ? (
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
                    <div style={{ padding: '6px 20px 18px', maxHeight: 440, overflowY: 'auto' }}>
                      <SpecMarkdown blocks={rev.spec} />
                    </div>
                  )}
                  {/* ask-the-agent box — hidden until a spec exists to edit */}
                  {!rev.specBusy && !rev.specErr && !rev.specBlockers && (<>
                  <div style={{ borderTop: '1px solid var(--hairline)', padding: '12px 14px', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <textarea
                      value={rev.ask} rows={1} disabled={busyRewrite}
                      ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }}
                      onChange={(e) => up({ ask: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendAsk() } }}
                      placeholder="Ask for a change — “also check on weekends”"
                      style={{
                        flex: 1, background: 'var(--bg-inset)', border: '1px solid rgba(255,255,255,.08)',
                        borderRadius: 8, color: 'var(--text)', font: "400 12.5px/1.5 var(--sans)", padding: '8px 12px', outline: 'none',
                        resize: 'none', overflow: 'hidden', display: 'block',
                      }}
                    />
                    {rev.askBusy ? (<>
                      <span style={{
                        width: 14, height: 14, border: '2px solid rgba(255,255,255,.15)', borderTopColor: 'var(--accent)',
                        borderRadius: '50%', animation: 'adSpin .8s linear infinite', flex: 'none', margin: '0 8px 9px',
                      }} />
                      <button className="ad-btn-ghost" onClick={cancelAsk} style={{ borderRadius: 8, padding: '8px 12px', font: "500 12px var(--sans)", whiteSpace: 'nowrap', flex: 'none' }}>
                        Cancel
                      </button>
                    </>) : (
                      <button className="ad-btn-soft" disabled={rev.syncBusy} onClick={() => void sendAsk()} style={{ borderRadius: 8, padding: '8px 12px', font: "500 12px var(--sans)", whiteSpace: 'nowrap' }}>
                        Edit with agent
                      </button>
                    )}
                  </div>
                  {/* §8/§11 live progress: streamed detail line while the edit job runs */}
                  {rev.askBusy && rev.genDetail && (
                    <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', padding: '0 14px 10px' }}>
                      {rev.genDetail}
                    </div>
                  )}
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
                  </>)}
                  </>)}
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
                      Which agents steps may call mid-execution. Fewer enabled means more predictable executions.
                    </div>
                  )}
                  {agSecOpenEff && (
                    <div style={{ borderTop: '1px solid var(--hairline)' }}>
                      {agWarn && (
                        <WarnBanner text={`Step${agentStepIdx.length > 1 ? 's' : ''} ${stepList(agentStepIdx)} need${agentStepIdx.length > 1 ? '' : 's'} an agent, but none is enabled — the execution would fail there. Enable one below.`} />
                      )}
                      {agents.map((g) => {
                        const on = rev.enabledAgents.includes(g.id)
                        const used = agentStepIdx.filter((i) => { const r = resolveAg(rev.steps[i]); return !!r && r.id === g.id })
                        return (
                          <div
                            key={g.id}
                            onClick={() => {
                              if (busyRewrite) return
                              if (rev.specBusy) { showToast('Wait for the spec first.'); return }
                              const genCancelled = cancelStepsGen() // §11: grant changes cancel an in-flight steps call
                              const genPatch = genCancelled ? { stepsBusy: false as const, dirty: true } : {}
                              if (on) {
                                up({ ...genPatch, enabledAgents: rev.enabledAgents.filter((z) => z !== g.id), ...(isEdit ? { touched: true } : {}) })
                                if (used.length) showToast(`Step${used.length > 1 ? 's' : ''} ${stepList(used)} ${used.length > 1 ? 'are' : 'is'} out of sync — ${agName(g)} is no longer available here. Re-enable it or sync the steps before saving.`, 5000)
                              } else {
                                up({ ...genPatch, enabledAgents: [...rev.enabledAgents, g.id], ...(isEdit ? { touched: true } : {}) })
                                showToast(`${agName(g)} is now available to steps — Sync with spec if the steps should be rewritten to use it.`, 3600)
                              }
                            }}
                            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 20px', borderBottom: '1px solid rgba(255,255,255,.05)', cursor: 'pointer', userSelect: 'none', ...lockStyle }}
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
                        Steps marked <i className="fa-solid fa-robot" style={{ fontSize: 9, color: 'oklch(0.78 0.13 52)' }} /> call one of these mid-execution — for the parts plain code can’t do, like reading a messy page or writing prose. Fewer enabled means more predictable executions.
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
                      Only checked secrets are handed to this automation at execution time. Values come from your Keychain.
                    </div>
                  )}
                  {secSecOpenEff && (
                    <div style={{ borderTop: '1px solid var(--hairline)' }}>
                      {secWarn && (
                        <WarnBanner text={[
                          ...secNotAllowed.map((r) => `Step${r.steps.length > 1 ? 's' : ''} ${stepList(r.steps)} use${r.steps.length > 1 ? '' : 's'} ${r.name}, but it isn’t allowed here — the execution would fail there. Allow it below.`),
                          ...secMissing.map((r) => `${r.name} isn’t in your Keychain — the execution would fail at step${r.steps.length > 1 ? 's' : ''} ${stepList(r.steps)}. Click it below to add the value.`),
                        ].join(' ')} />
                      )}
                      {secrets.map((s) => {
                        const ref = secRefs.find((r) => r.name === s.name)
                        const on = rev.allowedSecrets.includes(s.name)
                        return (
                          <div
                            key={s.name}
                            onClick={() => {
                              if (busyRewrite) return
                              if (rev.specBusy) { showToast('Wait for the spec first.'); return }
                              const genCancelled = cancelStepsGen() // §11: grant changes cancel an in-flight steps call
                              const genPatch = genCancelled ? { stepsBusy: false as const, dirty: true } : {}
                              if (on) {
                                up({ ...genPatch, allowedSecrets: rev.allowedSecrets.filter((z) => z !== s.name), ...(isEdit ? { touched: true } : {}) })
                                if (ref) showToast(`Step${ref.steps.length > 1 ? 's' : ''} ${stepList(ref.steps)} use${ref.steps.length > 1 ? '' : 's'} ${s.name} — re-allow it or sync the steps before saving.`, 4500)
                              } else {
                                up({ ...genPatch, allowedSecrets: [...rev.allowedSecrets, s.name], ...(isEdit ? { touched: true } : {}) })
                              }
                            }}
                            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 20px', borderBottom: '1px solid rgba(255,255,255,.05)', cursor: 'pointer', userSelect: 'none', ...lockStyle }}
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
                        <div key={r.name} style={lockStyle}>
                          <MissingSecretRow
                            name={r.name}
                            sub={`used by step${r.steps.length > 1 ? 's' : ''} ${stepList(r.steps)} — not in your Keychain`}
                            onAdded={() => up({ allowedSecrets: [...rev.allowedSecrets, r.name], ...(isEdit ? { touched: true } : {}) })}
                          />
                        </div>
                      ))}
                      {secrets.length === 0 && secRefs.length === 0 && (
                        <div style={{ padding: '11px 20px', borderBottom: '1px solid rgba(255,255,255,.05)', font: "400 12px var(--sans)", color: 'var(--text-faintest)' }}>
                          No secrets in your Keychain yet — add passwords and keys under Secrets.
                        </div>
                      )}
                      <div style={{ padding: '11px 20px', font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-faintest)' }}>
                        Only checked secrets are handed to this automation at execution time — a step that asks for anything else fails. Values come from your Keychain and never appear in scripts or logs.
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
                        className="ad-btn-soft" disabled={busyRewrite}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (busyRewrite) return
                          if (rev.specBusy) { showToast('Wait for the spec first.'); return }
                          const genCancelled = cancelStepsGen() // §11: instruction edits cancel an in-flight steps call
                          up({
                            specEdit: false, specText: '', specTextOrig: '', instrDraft: rev.instr, instrEdit: true, instrSecOpen: true,
                            ...(genCancelled ? { stepsBusy: false, dirty: true } : {}),
                          })
                          if (genCancelled) showToast('Step generation stopped — sync the steps when you finish editing.', 4200)
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
                            up({ instr: rev.instrDraft, instrDraft: null, instrEdit: false, touched: true, dirty: true })
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
                    <div style={{ borderTop: '1px solid var(--hairline)', padding: '10px 20px 16px' }}>
                      {rev.instr.trim() ? (
                        <div style={{ padding: '0 18px', margin: '0 -18px' }}>
                          <Markdown text={instrToMd(rev.instr)} />
                        </div>
                      ) : (
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
                      placeholder="Markdown — one rule per line: “Prefer Python.” “Never delete files — move them to the Trash.”"
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
                {/* Sync panel — persistent, above the cards, not inside Steps: a sync rewrites the steps AND the param definitions */}
                <div style={{ ...cardStyle, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* the indicator sits in an 18px box matching the title's line-height,
                        so it stays centered on the first line even when the text wraps */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                      <span style={{ height: 18, display: 'flex', alignItems: 'center', flex: 'none' }}>
                        {rev.syncBusy ? (
                          <span style={{
                            width: 13, height: 13, border: '2px solid rgba(255,255,255,.15)', borderTopColor: 'var(--accent)',
                            borderRadius: '50%', animation: 'adSpin .8s linear infinite',
                          }} />
                        ) : (
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: outOfSync ? 'var(--amber)' : 'var(--green)' }} />
                        )}
                      </span>
                      <span style={{
                        minWidth: 0,
                        font: rev.syncBusy ? "500 12.5px/18px var(--sans)" : outOfSync ? "500 12.5px/18px var(--sans)" : "400 12.5px/18px var(--sans)",
                        color: rev.syncBusy ? 'var(--text-2)' : outOfSync ? 'var(--text)' : 'var(--text-muted)',
                      }}>
                        {rev.syncBusy
                          ? `${selAgent ? `${agName(selAgent)} · ${dispModel(selAgent)}` : 'Your agent'} is rewriting the steps from your spec…`
                          : outOfSync
                            ? (rev.dirty ? 'The workflow is out of sync — these steps still match the old spec.'
                              : agentGap ? 'The workflow is out of sync — steps call an agent that isn’t enabled.'
                                : 'The workflow is out of sync — steps use a secret that isn’t allowed.')
                            : 'Steps are generated from the spec.'}
                      </span>
                    </div>
                    {/* §8/§11 live progress: streamed detail line while syncing */}
                    {rev.syncBusy && rev.genDetail && (
                      <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', margin: '2px 0 0 16px' }}>
                        {rev.genDetail}
                      </div>
                    )}
                    {!rev.syncBusy && outOfSync && (
                      <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', margin: '2px 0 0 16px' }}>
                        {rev.dirty ? 'Sync the steps to the new spec, then review them. Saving is locked until you do — nothing ships unreviewed.'
                          : agentGap ? 'Re-enable the agent, or sync the steps so they only call agents available here. Saving is locked until you do.'
                            : 'Re-allow the secret, or sync the steps so they only use secrets allowed here. Saving is locked until you do.'}
                      </div>
                    )}
                  </div>
                  {rev.syncBusy ? (
                    <button className="ad-btn-ghost" onClick={cancelSync} style={{ padding: '5px 10px', flex: 'none', whiteSpace: 'nowrap' }}>
                      Cancel
                    </button>
                  ) : (
                    <button
                      className="ad-btn-soft" disabled={syncDisabled}
                      onClick={() => void runSync()}
                      style={{ padding: '5px 10px', flex: 'none', whiteSpace: 'nowrap' }}
                    >
                      {outOfSync ? 'Sync now' : 'Sync with spec'}
                    </button>
                  )}
                </div>
                {/* STEPS */}
                <div style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
                    <span style={eyebrowStyle}>STEPS · GENERATED</span>
                  </div>
                  {/* §11 drafting-on-Review: skeleton until call 2 delivers — plain text
                      while waiting on the spec, spinner only once call 2 runs */}
                  {drafting && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '18px 20px 20px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {rev.stepsBusy && (
                          <span style={{
                            width: 13, height: 13, border: '2px solid rgba(255,255,255,.15)', borderTopColor: 'var(--accent)',
                            borderRadius: '50%', animation: 'adSpin .8s linear infinite', flex: 'none',
                          }} />
                        )}
                        <span style={{ font: "500 12.5px var(--sans)", color: 'var(--text-2)' }}>{stageLabel}</span>
                        {rev.stepsBusy && (
                          <span style={{ font: "500 10.5px var(--mono)", color: 'var(--text-faintest)' }}>
                            {selAgent ? `${agName(selAgent)} · ${dispModel(selAgent)}` : ''}
                          </span>
                        )}
                      </div>
                      {/* §8/§11 live progress: streamed detail under the stage label */}
                      {rev.stepsBusy && rev.genDetail && (
                        <div style={{ font: "400 11.5px var(--sans)", color: 'var(--text-muted)', margin: '0 0 0 23px' }}>
                          {rev.genDetail}
                        </div>
                      )}
                    </div>
                  )}
                  {/* §11: a steps-call failure renders here; Rebuild runs a §8 sync against the landed spec */}
                  {rev.stepsErr && !rev.syncBusy && (
                    <div style={{
                      background: 'oklch(0.7 0.19 25 / .07)', border: '1px solid oklch(0.7 0.19 25 / .3)',
                      borderRadius: 9, padding: '10px 12px', margin: '12px 14px',
                      display: 'flex', alignItems: 'flex-start', gap: 9, animation: 'adFadeUp .3s ease both',
                    }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', flex: 'none', marginTop: 5 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ font: "500 12.5px var(--sans)", color: 'var(--text)' }}>
                          {rev.stepsErr.msg || 'The steps didn’t validate — try again or rephrase.'}
                        </div>
                        {(rev.stepsErr.detail ?? []).length > 0 && (
                          <div style={{ font: "400 11px/1.6 var(--mono)", color: 'var(--text-muted)', marginTop: 4 }}>
                            {(rev.stepsErr.detail ?? []).map((d, i) => <div key={i}>{d}</div>)}
                          </div>
                        )}
                      </div>
                      <button className="ad-btn-soft" onClick={() => void runSync()} style={{ padding: '5px 10px', flex: 'none', whiteSpace: 'nowrap' }}>
                        Rebuild the steps
                      </button>
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', opacity: outOfSync || busyRewrite ? 0.45 : 1, transition: 'opacity .2s', marginBottom: -1 }}>
                    {rev.steps.map((s, i) => (
                      <StepRow
                        key={i} step={s} i={i}
                        open={rev.stepOpen === i}
                        onToggle={() => up({ stepOpen: rev.stepOpen === i ? null : i })}
                        availAgents={availAgents} allAgents={agents}
                        pkgImports={rev.packages.map((p) => p.import)}
                      />
                    ))}
                  </div>
                </div>

                {/* TRIGGERS — display-only (§11): what saving stores — drafted crons
                    merged over the saved list (§4.3); one-shots/on-off edited on the
                    automation page */}
                <div style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
                    <span style={eyebrowStyle}>TRIGGERS</span>
                  </div>
                  {drafting ? (
                    <div style={{ padding: '13px 20px', font: "400 12px var(--sans)", color: 'var(--text-faint)' }}>{stageLabel}</div>
                  ) : (
                    <div style={{ padding: '13px 20px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                      {rev.triggers.map((t, i) => (
                        <span key={i} style={{
                          font: "500 12px var(--mono)", color: 'var(--accent)', background: 'oklch(0.74 0.155 52 / .12)',
                          borderRadius: 6, padding: '3px 9px', whiteSpace: 'nowrap',
                        }}>
                          {triggerShort(t)}
                        </span>
                      ))}
                      <span style={{ font: "400 11.5px var(--sans)", color: 'var(--text-faint)' }}>
                        {rev.triggers.length > 0
                          ? 'Executes even when the app is closed. The schedule follows the spec — one-shots and on/off live on the automation page.'
                          : 'No triggers — executes only via Execute now and the menu bar.'}
                      </span>
                    </div>
                  )}
                </div>

                {/* PARAMETERS — display-only (§16): value input lives on the automation page,
                    test-only values in the Test card */}
                <div style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
                    <span style={eyebrowStyle}>PARAMETERS · YOUR AI ASKED FOR THESE</span>
                    {!drafting && rev.params.length > 0 && (
                      <span style={{ font: "500 10px var(--mono)", letterSpacing: '.06em', color: 'var(--text-faintest)' }}>READ-ONLY HERE</span>
                    )}
                  </div>
                  {drafting ? (
                    <div style={{ padding: '14px 20px 16px', font: "400 12px var(--sans)", color: 'var(--text-faint)' }}>{stageLabel}</div>
                  ) : rev.params.length === 0 ? (
                    <div style={{ padding: '14px 20px 16px', font: "400 12.5px var(--sans)", color: 'var(--text-muted)' }}>
                      No settings needed — your AI didn’t ask for any.
                    </div>
                  ) : (
                    <>
                      {rev.params.map((p) => {
                        // §16: value summary — edit mode shows the live value (§5 name+kind
                        // match), create mode the drafted default
                        const live = auto?.params?.find((q) => q.name === p.name && q.kind === p.kind)
                        return (
                          <div key={p.name} style={{ padding: '11px 20px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                              <div style={{ font: "600 12.5px var(--sans)" }}>{p.label}</div>
                              <div style={{ font: "500 12px var(--mono)", color: 'var(--text-2em)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '55%' }}>
                                {paramSummary(live ?? p)}
                              </div>
                            </div>
                            <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: 2 }}>{p.help}</div>
                          </div>
                        )
                      })}
                      <div style={{ padding: '11px 20px', font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-faintest)' }}>
                        Values aren’t part of a version — set them on the automation page after saving; for a test, set test-only values in the Test card.
                      </div>
                    </>
                  )}
                </div>

                {/* PACKAGES · PYTHON LIBRARIES (§6.2) — display-only, right column like
                    Triggers/Parameters: the drafting pipeline owns the list */}
                <div style={cardStyle}>
                  <div
                    onClick={() => rev.packages.length > 0 && up({ pkgSecOpen: !pkgSecOpenEff })}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 20px', cursor: rev.packages.length > 0 ? 'pointer' : 'default', userSelect: 'none' }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      {rev.packages.length > 0 && (
                        <i className={pkgSecOpenEff ? 'fa-solid fa-caret-down' : 'fa-solid fa-caret-right'} style={{ width: 14, flex: 'none', textAlign: 'center', fontSize: 10, color: '#4a515c' }} />
                      )}
                      <span style={eyebrowStyle}>PACKAGES · PYTHON LIBRARIES</span>
                    </span>
                    {rev.packages.length > 0 && (
                      <span style={{ font: "500 10.5px var(--mono)", color: 'var(--text-faintest)', whiteSpace: 'nowrap', flex: 'none' }}>
                        {rev.packages.filter((p) => p.status === 'installed').length} of {rev.packages.length} installed
                        {rev.packages.filter((p) => p.latest).length > 0 &&
                          ` · ${rev.packages.filter((p) => p.latest).length} update${rev.packages.filter((p) => p.latest).length === 1 ? '' : 's'}`}
                      </span>
                    )}
                  </div>
                  {drafting ? (
                    <div style={{ borderTop: '1px solid var(--hairline)', padding: '14px 20px 16px', font: "400 12px var(--sans)", color: 'var(--text-faint)' }}>{stageLabel}</div>
                  ) : rev.packages.length === 0 ? (
                    <div style={{ borderTop: '1px solid var(--hairline)', padding: '14px 20px 16px', font: "400 12.5px var(--sans)", color: 'var(--text-muted)' }}>
                      No extra packages — the steps use only the built-in libraries.
                    </div>
                  ) : !pkgSecOpenEff ? (
                    <div onClick={() => up({ pkgSecOpen: true })} style={{ padding: '0 20px 13px 43px', font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-faintest)', cursor: 'pointer', userSelect: 'none' }}>
                      Python packages this automation needs. They install automatically — nothing for you to run.
                    </div>
                  ) : (
                    <div style={{ borderTop: '1px solid var(--hairline)' }}>
                      {rev.packages.map((p) => (
                        <div key={p.pip} style={{ padding: '11px 20px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{ flex: 1, minWidth: 0, font: "500 12px var(--mono)", color: 'var(--text)' }}>
                              {p.pip}
                              {p.latest && p.status !== 'installing' && (
                                <span style={{ color: 'var(--accent)', marginLeft: 8 }}>→ {p.latest}</span>
                              )}
                            </div>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', whiteSpace: 'nowrap', font: "600 10px var(--mono)",
                              color: p.status === 'installed' ? 'var(--green)'
                                : p.status === 'failed' ? 'var(--red)'
                                  : p.status === 'missing' ? 'var(--amber)' : 'var(--text-faint)' }}>
                              {p.status === 'installed' && <><i className="fa-solid fa-check" style={{ fontSize: 9 }} /> installed</>}
                              {p.status === 'installing' && <><i className="fa-solid fa-spinner fa-spin" style={{ fontSize: 9 }} /> installing…</>}
                              {p.status === 'missing' && 'not installed'}
                              {p.status === 'failed' && 'failed'}
                              {!p.status && 'checking…'}
                            </span>
                            {p.latest && p.status !== 'installing' && (
                              <button className="ad-btn-soft" disabled={rev.pkgBusy || busyRewrite}
                                onClick={() => void updatePkgs([p.pip])} style={{ flex: 'none', padding: '3px 9px' }}>
                                Update
                              </button>
                            )}
                          </div>
                          {p.status === 'failed' && p.error && (
                            <div style={{ margin: '6px 0 0', font: "400 10.5px/1.5 var(--mono)", color: 'var(--red)', overflowWrap: 'break-word' }}>{p.error}</div>
                          )}
                        </div>
                      ))}
                      {rev.packages.filter((p) => p.latest).length >= 2 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 20px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                          <span style={{ flex: 1, font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)' }}>
                            Newer versions are available. Updating changes the pin for every automation that uses the package.
                          </span>
                          <button className="ad-btn-soft" disabled={rev.pkgBusy || busyRewrite}
                            onClick={() => void updatePkgs(rev.packages.filter((p) => p.latest).map((p) => p.pip))} style={{ flex: 'none' }}>
                            Update all
                          </button>
                        </div>
                      )}
                      {rev.packages.some((p) => p.status === 'missing' || p.status === 'failed') && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 20px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                          <span style={{ flex: 1, font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)' }}>
                            {rev.packages.some((p) => p.status === 'failed')
                              ? 'A package couldn’t be installed — check your connection, then retry. Saving still works; executions retry on their own too.'
                              : 'Some packages aren’t installed yet. Executions install them automatically — or install now.'}
                          </span>
                          <button className="ad-btn-soft" disabled={rev.pkgBusy || busyRewrite} onClick={() => void installPkgs()} style={{ flex: 'none' }}>
                            {rev.packages.some((p) => p.status === 'failed') ? 'Retry install' : 'Install'}
                          </button>
                        </div>
                      )}
                      <div style={{ padding: '11px 20px', font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-faintest)' }}>
                        Your AI picked these Python packages for the steps. They install automatically — nothing for you to run.
                      </div>
                    </div>
                  )}
                </div>

                {/* TEST — §11: executes the draft's real steps, scratch memory */}
                <div style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
                      <span style={eyebrowStyle}>TEST</span>
                      {test?.status === 'executing' ? (
                        <button className="ad-btn-soft" onClick={cancelTest} style={{ padding: '4px 10px' }}>
                          Cancel
                        </button>
                      ) : (
                        <button
                          className="ad-btn-soft" disabled={rev.steps.length === 0 || busyRewrite}
                          onClick={() => void runTest()}
                          style={{ padding: '4px 10px' }}
                        >
                          {test ? 'Test again' : 'Test the draft'}
                        </button>
                      )}
                    </div>
                    {/* §11 test parameter values (create + edit) — collapsed: the test uses the
                        automation's stored values (edit) or the draft defaults (create) */}
                    {rev.params.length > 0 && (
                      testParams === null ? (
                        <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--hairline)', ...lockStyle }}>
                          <button className="ad-btn-dashed" onClick={() => setTestParams(seedTestParams())}>
                            <i className="fa-solid fa-sliders" style={{ fontSize: 10 }} /> Set parameter values for this test
                          </button>
                        </div>
                      ) : (
                        <div style={{ borderBottom: '1px solid var(--hairline)', ...lockStyle }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 20px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                            <span style={{ font: "500 10px var(--mono)", letterSpacing: '.06em', color: 'var(--text-faintest)' }}>
                              PARAMETER VALUES · THIS TEST ONLY
                            </span>
                            <button className="ad-btn-soft" onClick={() => setTestParams(null)} style={{ padding: '3px 9px' }}>
                              {isEdit ? 'Use current values' : 'Use defaults'}
                            </button>
                          </div>
                          {testParams.map((p) => (
                            <ParamEditor
                              key={p.name} p={p}
                              upd={(patch) => setTestParams((ps) => ps && ps.map((x) => (x.name === p.name ? { ...x, ...patch } : x)))}
                            />
                          ))}
                          <div style={{ padding: '10px 20px', font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-faintest)' }}>
                            These values apply to this test only — nothing is saved.
                          </div>
                        </div>
                      )
                    )}
                    {test ? (
                      <>
                        {test.steps.length > 0 && (
                          <div style={{ padding: '10px 20px 4px' }}>
                            {test.steps.map((s, i) => (
                              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '3px 0' }}>
                                <span style={{ font: "500 11px var(--mono)", color: 'var(--text-faint)', width: 14, flex: 'none' }}>{i + 1}</span>
                                <span style={{ flex: 1, minWidth: 0, font: "400 12px var(--sans)", color: '#c6cdd6', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                                <Badge status={s.status} />
                              </div>
                            ))}
                          </div>
                        )}
                        <div style={{ padding: '10px 20px 12px', font: "400 11.5px/1.8 var(--mono)", background: '#07090d', maxHeight: 260, overflowY: 'auto' }}>
                          {test.lines.map((l, i) => (
                            <div key={i} style={{ color: logColor(l.k), whiteSpace: 'pre-wrap', overflowWrap: 'break-word', fontStyle: l.k === 'sys' ? 'italic' : 'normal' }}>{l.text}</div>
                          ))}
                          {test.status === 'executing' && (
                            <div style={{ color: 'var(--text-faint)', marginTop: 6 }}>
                              <span style={{
                                display: 'inline-block', width: 11, height: 11, border: '2px solid rgba(255,255,255,.15)',
                                borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'adSpin .8s linear infinite',
                                marginRight: 7, verticalAlign: -1,
                              }} />
                              executing the draft…
                            </div>
                          )}
                          {test.status === 'succeeded' && (
                            <div style={{ marginTop: 6 }}>
                              <div style={{ color: 'var(--green)' }}>
                                <i className="fa-solid fa-check" style={{ fontSize: 11 }} /> Test finished — the memory copy was discarded.
                              </div>
                              {test.result?.chip && (
                                <Chip {...resultChipColors(test.result.chipStatus)} style={{ marginTop: 7 }}>{test.result.chip}</Chip>
                              )}
                              {(test.result?.values ?? []).map((v) => (
                                <div key={v.name} style={{ color: '#9fb3c8', marginTop: 4 }}>
                                  <span style={{ color: 'var(--text-faint)' }}>{v.name}: </span>
                                  {Array.isArray(v.value) ? v.value.join(' · ') : v.value}
                                </div>
                              ))}
                              {(test.result?.files ?? []).length > 0 && (
                                <div style={{ marginTop: 6 }}>
                                  {(test.result?.files ?? []).map((f) => (
                                    <div key={f.name} style={{ color: '#9fb3c8' }}>
                                      <i className="fa-solid fa-file-lines" style={{ fontSize: 10, color: 'var(--text-faint)', marginRight: 6 }} />
                                      {f.name} <span style={{ color: 'var(--text-faintest)' }}>{f.size}</span>
                                    </div>
                                  ))}
                                  {test.result?.path && (
                                    <button
                                      className="ad-btn-ghost"
                                      onClick={() => { void window.autodave?.revealPath(test.result!.path!) }}
                                      style={{ fontSize: 11.5, marginTop: 4 }}
                                    >
                                      <i className="fa-solid fa-folder-open" style={{ fontSize: 10 }} /> Show in Finder
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                          {test.status === 'failed' && test.analyzing && (
                            <div style={{ color: 'var(--amber)', marginTop: 6 }}>
                              <span style={{
                                display: 'inline-block', width: 11, height: 11, border: '2px solid rgba(255,255,255,.15)',
                                borderTopColor: 'var(--amber)', borderRadius: '50%', animation: 'adSpin .8s linear infinite',
                                marginRight: 7, verticalAlign: -1,
                              }} />
                              Analyzing the failure… {selAgent ? `(${agName(selAgent)})` : ''}
                            </div>
                          )}
                          {test.status === 'failed' && !test.analyzing && (
                            <div style={{ color: 'var(--amber)', marginTop: 6 }}>
                              <i className="fa-solid fa-triangle-exclamation" style={{ fontSize: 11 }} /> Test failed.
                            </div>
                          )}
                          {test.status === 'cancelled' && (
                            <div style={{ color: 'var(--text-faint)', marginTop: 6 }}>
                              Test cancelled.
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div style={{ padding: '12px 20px', font: "400 11.5px/1.6 var(--mono)", color: '#4a515c' }}>
                        Executes the draft's real steps on this Mac — emails send, files move. Memory is a scratch copy; real executions aren't affected.
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
          {['Everything executes on this Mac', 'Nothing executes until you review it', 'Passwords stay in your Keychain'].map((t) => (
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

      {/* §11: the repair modal — one convergent loop, three entry points: a
          create job blocked at the steps call ('create'), a blocked sync
          ('sync'), and a failed test's issue analysis ('test'). Applying
          amends the in-editor spec and runs a sync; closing a 'create'/'sync'
          repair leaves the workflow out of sync with the banner up. */}
      {rev?.repair && (
        <Modal
          onClose={() => { if (applyBlockedRef.current) { applyBlockedRef.current = false; applyRepair() } else up({ repair: null }) }}
          width={620} zIndex={80} cardStyle={{ padding: 22, maxHeight: '80vh', overflowY: 'auto' }}
        >
          {(close) => (
            <>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                {rev.repair!.source === 'test'
                  ? (rev.repair!.blockers.length > 1 ? `The test hit ${rev.repair!.blockers.length} issues` : 'The test hit an issue')
                  : (rev.repair!.blockers.length > 1 ? `Your AI hit ${rev.repair!.blockers.length} blockers` : 'Your AI hit a blocker')}
              </div>
              <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-muted)', marginBottom: 14 }}>
                {rev.repair!.source === 'test'
                  ? 'A step failed when the draft executed. Edit the fix below, then apply it to the spec and sync the steps.'
                  : rev.repair!.source === 'create'
                    ? 'It couldn’t build the steps as the spec asks. Edit the fix below, then apply it to the spec and rebuild.'
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
                  {rev.repair!.source === 'test' ? 'Apply to the spec & sync the steps'
                    : rev.repair!.source === 'create' ? 'Apply to the spec & rebuild the steps'
                      : 'Apply to the spec & sync again'}
                </BtnPrimary>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}
