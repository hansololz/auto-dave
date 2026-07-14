// Shared UI primitives — one source of truth for badges, toggles, radios,
// popovers, toasts (prototype Component helpers, §14 tokens). The result
// section and its views live in result.tsx.
import React, { useEffect, useRef, useState } from 'react'
import type { ParamDef, Status } from './types'

export const P = {
  accent: 'var(--accent)', accentBg: 'var(--accent-bg)',
  green: 'var(--green)', greenBg: 'var(--green-bg)',
  cyan: 'var(--cyan)', cyanBg: 'var(--cyan-bg)',
  red: 'var(--red)', redBg: 'var(--red-bg)',
  amber: 'var(--amber)', amberBg: 'var(--amber-bg)',
  orange: 'var(--orange)', orangeBg: 'var(--orange-bg)',
  gray: 'var(--gray)', grayBg: 'var(--gray-bg)',
  magenta: 'var(--magenta)', magentaBg: 'var(--magenta-bg)',
}

export function badgeOf(status: Status | string): { label: string; c: string; bg: string } {
  const map: Record<string, [string, string, string]> = {
    queued: ['Queued', P.gray, P.grayBg],
    running: ['Running', P.cyan, P.cyanBg],
    succeeded: ['Succeeded', P.green, P.greenBg],
    failed: ['Failed', P.red, P.redBg],
    cancelled: ['Cancelled', P.gray, P.grayBg],
    skipped: ['Skipped', P.gray, P.grayBg],
    reused: ['Reused', P.gray, P.grayBg],
    interrupted: ['Interrupted', P.magenta, P.magentaBg],
    none: ['Not run yet', P.gray, P.grayBg],
  }
  const b = map[status] ?? map.none
  return { label: b[0], c: b[1], bg: b[2] }
}

export function Badge({ status, style }: { status: Status | string; style?: React.CSSProperties }) {
  const b = badgeOf(status)
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase',
      letterSpacing: '.06em', color: b.c, background: b.bg, padding: '3px 9px',
      borderRadius: 6, whiteSpace: 'nowrap', ...style,
    }}>
      {b.label}
    </span>
  )
}

export function Chip({ children, c, bg, style }: {
  children: React.ReactNode; c?: string; bg?: string; style?: React.CSSProperties
}) {
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: 11, color: c ?? 'var(--text-muted)',
      background: bg ?? 'rgba(255,255,255,.05)', padding: '3px 10px', borderRadius: 16,
      whiteSpace: 'nowrap', ...style,
    }}>
      {children}
    </span>
  )
}

export function resultChipColors(status: 'changes' | 'ok' | 'attention' | null | undefined): { c: string; bg: string } {
  if (status === 'changes') return { c: P.accent, bg: P.accentBg }
  // §14: attention-flavored result chips use the dedicated chip orange, not status amber.
  if (status === 'attention') return { c: P.orange, bg: P.orangeBg }
  return { c: P.green, bg: P.greenBg }
}

export function Eyebrow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, letterSpacing: '.09em',
      textTransform: 'uppercase', color: 'var(--text-faint)', ...style,
    }}>
      {children}
    </div>
  )
}

export function Spinner({ size = 16, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: '50%',
      border: '2px solid rgba(255,255,255,.15)', borderTopColor: 'var(--accent)',
      animation: 'adSpin .85s linear infinite', ...style,
    }} />
  )
}

export function Toggle({ on, onChange, disabled, title }: {
  on: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string
}) {
  return (
    <button
      onClick={() => !disabled && onChange(!on)}
      title={title}
      style={{
        width: 36, height: 21, borderRadius: 11, position: 'relative', flex: 'none',
        border: '1px solid rgba(255,255,255,.08)',
        background: on ? 'var(--accent)' : 'rgba(255,255,255,.12)',
        transition: 'background .18s ease', opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: 2, width: 15, height: 15, borderRadius: '50%',
        background: '#f2f4f7', transition: 'transform .18s ease',
        transform: on ? 'translateX(15px)' : 'translateX(0)',
      }} />
    </button>
  )
}

export function RadioRing({ selected, size = 16 }: { selected: boolean; size?: number }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%', flex: 'none',
      border: `1.5px solid ${selected ? 'var(--accent)' : 'rgba(255,255,255,.25)'}`,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      transition: 'border-color .18s ease',
    }}>
      <span style={{
        width: size - 8, height: size - 8, borderRadius: '50%', background: selected ? 'var(--accent)' : 'transparent',
        transform: selected ? 'scale(1)' : 'scale(.4)', transition: 'all .18s ease',
      }} />
    </span>
  )
}

export function BtnPrimary({ children, onClick, disabled, style }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; style?: React.CSSProperties
}) {
  return (
    <button className="ad-btn-primary" onClick={onClick} disabled={disabled} style={style}>
      {children}
    </button>
  )
}

export function BtnGhost({ children, onClick, danger, style }: {
  children: React.ReactNode; onClick?: () => void; danger?: boolean; style?: React.CSSProperties
}) {
  return (
    <button className={`ad-btn-ghost${danger ? ' danger' : ''}`} onClick={onClick} style={style}>
      {children}
    </button>
  )
}

/** Popover that closes on outside mousedown (§9). Render children absolutely inside. */
export function usePopover(): [boolean, (v: boolean) => void, React.RefObject<HTMLDivElement>] {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open])
  return [open, setOpen, ref]
}

export const menuStyle: React.CSSProperties = {
  position: 'absolute', zIndex: 60, background: 'var(--bg-menu)',
  border: '1px solid rgba(255,255,255,.09)', borderRadius: 10,
  boxShadow: '0 18px 44px rgba(0,0,0,.5)', padding: 5, minWidth: 200,
  animation: 'adFadeUp .18s ease',
}

export function MenuRow({ children, onClick, danger, active }: {
  children: React.ReactNode; onClick?: () => void; danger?: boolean; active?: boolean
}) {
  return (
    <div className={`ad-menu-row${danger ? ' danger' : ''}${active ? ' active' : ''}`} onClick={onClick}>
      {children}
    </div>
  )
}

/** One-line read-only summary of a parameter's value (§4.2).
 * Works on merged params (server `on`/`lines`/`value`) and on raw definitions
 * (draft payloads in the Review screen) by falling back to the default. */
export function paramSummary(p: ParamDef): string {
  const validUrl = (s: string) => /^https?:\/\/\S+\.\S+/.test(s.trim())
  if (p.kind === 'toggle') return (p.on ?? p.default === true) ? 'On' : 'Off'
  if (p.kind === 'list') {
    const lines = p.lines ?? (Array.isArray(p.default) ? (p.default as string[]) : [])
    return p.validate
      ? `${lines.filter((l) => l.trim() && validUrl(l)).length} links`
      : `${lines.filter((l) => l.trim()).length} entries`
  }
  if (p.kind === 'kv') {
    const rows = p.rows ?? (Array.isArray(p.default) ? (p.default as { k: string; v: string }[]) : [])
    return `${rows.length} entries`
  }
  if (p.kind === 'number') return String(p.value ?? p.default ?? p.min ?? 0)
  const text = p.value ?? p.default ?? ''
  return String(text || 'Not set')
}

export function validUrl(s: string): boolean {
  return /^https?:\/\/\S+\.\S+/.test(s.trim())
}

/** §4.3 countdown "next in Xd Xh" / "Xh Xm". */
export function nextIn(a: { hour: number | null; min: number; dow: number | null }): string {
  const now = new Date()
  const nxt = new Date(now)
  nxt.setHours(a.hour ?? 8, a.min || 0, 0, 0)
  if (a.dow != null) {
    let add = (a.dow - nxt.getDay() + 7) % 7
    if (add === 0 && nxt <= now) add = 7
    nxt.setDate(nxt.getDate() + add)
  } else if (nxt <= now) {
    nxt.setDate(nxt.getDate() + 1)
  }
  const mTot = Math.max(1, Math.round((nxt.getTime() - now.getTime()) / 60000))
  const dd = Math.floor(mTot / 1440)
  const hh = Math.floor((mTot % 1440) / 60)
  const mm = mTot % 60
  return dd > 0 ? `${dd}d ${hh}h` : `${hh}h ${mm}m`
}

export function Toast({ msg }: { msg: string | null }) {
  if (!msg) return null
  return (
    // Centered with left/right+margin, not translateX — adFadeUp animates
    // `transform`, which would override the centering while it runs.
    <div key={msg} style={{
      position: 'fixed', bottom: 26, left: 0, right: 0, margin: '0 auto', width: 'fit-content', zIndex: 100,
      background: 'var(--bg-toast)', border: '1px solid rgba(255,255,255,.12)',
      boxShadow: '0 10px 30px rgba(0,0,0,.4)', borderRadius: 9, padding: '10px 18px',
      fontSize: 12.5, fontWeight: 500, color: '#e9ecf1', animation: 'adFadeUp .25s ease', maxWidth: 520,
    }}>
      {msg}
    </div>
  )
}

export function CountPill({ n, active }: { n: number; active?: boolean }) {
  if (!n) return null
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600, padding: '1px 7px', borderRadius: 20,
      background: 'rgba(255,255,255,.06)',
      color: active ? 'var(--text-2em)' : 'var(--text-faint)',
    }}>
      {n}
    </span>
  )
}

export function PageTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.01em' }}>{children}</h1>
      {right}
    </div>
  )
}

/** Modal shell: dimmed backdrop + centered card, enter (.18s fade-up) and exit
 * (.12s fade-down) animations. Children get `close`, which plays the exit before
 * firing `onClose` (the caller's unmount) — backdrop click and Escape close the
 * same way, so no dismissal path skips the animation. */
export function Modal({ onClose, width, zIndex = 60, cardStyle, children }: {
  onClose: () => void; width: number; zIndex?: number; cardStyle?: React.CSSProperties
  children: (close: () => void) => React.ReactNode
}) {
  const [closing, setClosing] = useState(false)
  const closed = useRef(false)
  const finish = () => { if (!closed.current) { closed.current = true; onClose() } }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setClosing(true) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (!closing) return
    // Unmount even if animationend never fires (e.g. reduced-motion setups).
    const t = setTimeout(finish, 200)
    return () => clearTimeout(t)
  }, [closing])
  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) setClosing(true) }}
      onAnimationEnd={(e) => { if (closing && e.target === e.currentTarget) finish() }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(5,7,10,.6)', zIndex,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: closing ? 'adFadeOut .12s ease both' : 'adFadeIn .18s ease both',
      }}
    >
      <div style={{
        background: 'var(--bg-menu)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 12,
        boxShadow: '0 24px 60px rgba(0,0,0,.5)', width,
        animation: closing ? 'adFadeOutDown .12s ease both' : 'adFadeUp .18s ease both',
        ...cardStyle,
      }}>
        {children(() => setClosing(true))}
      </div>
    </div>
  )
}

export function ConfirmModal({ title, body, confirmLabel, danger, onConfirm, onCancel }: {
  title: string; body: React.ReactNode; confirmLabel: string; danger?: boolean
  onConfirm: () => void; onCancel: () => void
}) {
  const confirmed = useRef(false)
  return (
    <Modal
      onClose={() => { if (confirmed.current) onConfirm(); else onCancel() }}
      width={400} zIndex={90} cardStyle={{ padding: 22 }}
    >
      {(close) => (
        <>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>{title}</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)', marginBottom: 18 }}>{body}</div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <BtnGhost onClick={close}>Cancel</BtnGhost>
            <BtnPrimary
              onClick={() => { confirmed.current = true; close() }}
              style={danger ? {
                background: 'oklch(0.7 0.19 25 / .16)', border: '1px solid oklch(0.7 0.19 25 / .4)',
                color: 'oklch(0.78 0.15 25)', fontWeight: 600, fontSize: 12.5,
              } : undefined}
            >
              {confirmLabel}
            </BtnPrimary>
          </div>
        </>
      )}
    </Modal>
  )
}

// ---------- Python syntax highlighting ----------
// Step scripts are always Python (SPEC §15 — single bundled CPython). Tiny
// zero-dependency tokenizer keeps the bundle lean and Vite-friendly.

const PY_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if',
  'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield', 'match', 'case',
])
const PY_CONSTS = new Set(['True', 'False', 'None'])
const PY_BUILTINS = new Set([
  'abs', 'all', 'any', 'bool', 'bytes', 'bytearray', 'dict', 'enumerate',
  'filter', 'float', 'format', 'frozenset', 'getattr', 'hasattr', 'hash',
  'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'map',
  'max', 'min', 'next', 'object', 'open', 'ord', 'print', 'range', 'repr',
  'reversed', 'round', 'set', 'setattr', 'sorted', 'str', 'sum', 'super',
  'tuple', 'type', 'zip', 'Exception', 'ValueError', 'KeyError', 'TypeError',
])
const PY_COLOR = {
  keyword: '#c792ea', const: '#f78c6c', string: '#c3e88d', number: '#f78c6c',
  comment: '#5c6b7a', builtin: '#82aaff', call: '#82aaff', def: '#ffcb6b',
  decorator: '#ffcb6b',
}

// Whitespace, newline, (prefix)string, comment, decorator, number, identifier, symbol.
const PY_TOKEN = /([ \t]+)|(\r?\n)|((?:[rbfuRBFU]{0,2})(?:'''[\s\S]*?'''|"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?))|(#[^\n]*)|(@[A-Za-z_][\w.]*)|(\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?[jJ]?)|([A-Za-z_]\w*)|([\s\S])/g

function highlightPython(code: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let m: RegExpExecArray | null
  let prevIdent = ''
  PY_TOKEN.lastIndex = 0
  while ((m = PY_TOKEN.exec(code)) !== null) {
    const [full, ws, nl, str, comment, deco, num, ident] = m
    const key = out.length
    if (ws) { out.push(ws); continue }
    if (nl) { out.push('\n'); prevIdent = ''; continue }
    let color: string | undefined
    if (str !== undefined) color = PY_COLOR.string
    else if (comment !== undefined) color = PY_COLOR.comment
    else if (deco !== undefined) color = PY_COLOR.decorator
    else if (num !== undefined) color = PY_COLOR.number
    else if (ident !== undefined) {
      if (PY_KEYWORDS.has(ident)) color = PY_COLOR.keyword
      else if (PY_CONSTS.has(ident)) color = PY_COLOR.const
      else if (prevIdent === 'def' || prevIdent === 'class') color = PY_COLOR.def
      else if (PY_BUILTINS.has(ident)) color = PY_COLOR.builtin
      else if (code[PY_TOKEN.lastIndex] === '(') color = PY_COLOR.call
    }
    if (ident !== undefined) prevIdent = ident
    else if (str === undefined && comment === undefined) prevIdent = ''
    if (color) {
      const italic = comment !== undefined
      out.push(<span key={key} style={{ color, ...(italic ? { fontStyle: 'italic' } : null) }}>{full}</span>)
    } else {
      out.push(full)
    }
  }
  return out
}

// Highlighted Python <pre>. Pass the same style/className the plain <pre> used;
// per-token colors override the base text color for recognized tokens.
export function PyCode({ code, className, style }: {
  code: string; className?: string; style?: React.CSSProperties
}) {
  return <pre className={className} style={style}>{highlightPython(code)}</pre>
}
