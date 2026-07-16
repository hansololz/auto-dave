// Menu-bar surface (§13): 334px translucent panel — one row per automation.
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { Eyebrow } from '../ui'

function dotColor(a: { lastStatus: string; live: string | null }): { c: string; pulse: boolean } {
  if (a.live) return { c: 'var(--cyan)', pulse: true }
  if (a.lastStatus === 'failed') return { c: 'var(--red)', pulse: false }
  if (a.lastStatus === 'interrupted') return { c: 'var(--magenta)', pulse: false }
  if (a.lastStatus === 'none') return { c: 'var(--gray)', pulse: false }
  return { c: 'var(--green)', pulse: false }
}

export default function MenuBarPanel() {
  const { autos, version } = useStore()
  const [hovRow, setHovRow] = useState<string | null>(null)
  const [hovBtn, setHovBtn] = useState<string | null>(null)
  const [hovLink, setHovLink] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const failed = autos.filter((a) => a.lastStatus === 'failed').length
  const aggregate = failed > 0
    ? `${failed} need${failed === 1 ? 's' : ''} attention`
    : `All good · ${autos.length} automation${autos.length === 1 ? '' : 's'}`

  useEffect(() => {
    if (ref.current) void window.autodave?.resizePanel(ref.current.scrollHeight)
  }, [autos.length])

  const openAuto = (id: string) => { void window.autodave?.openApp(`/app?auto=${id}`) }

  return (
    <div
      ref={ref}
      style={{
        width: 334, background: 'rgba(25,28,35,.94)', borderRadius: 12,
        border: '1px solid rgba(255,255,255,.1)', boxShadow: '0 18px 50px rgba(0,0,0,.55)',
        overflow: 'hidden', fontFamily: 'var(--sans)',
      }}
    >
      <div style={{ padding: '11px 14px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Eyebrow>Auto Dave</Eyebrow>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500, color: failed ? 'oklch(0.74 0.17 25)' : 'var(--text-faint)' }}>{aggregate}</div>
      </div>
      <div>
        {autos.map((a) => {
          const d = dotColor(a)
          const hov = hovRow === a.id
          const subColor = a.live
            ? 'var(--cyan)'
            : a.lastStatus === 'failed'
              ? 'oklch(0.74 0.17 25)'
              : a.resultChip
                ? 'var(--accent)'
                : 'var(--text-faint)'
          return (
            <div
              key={a.id}
              onClick={() => openAuto(a.id)}
              onMouseEnter={() => setHovRow(a.id)}
              onMouseLeave={() => setHovRow(null)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
                cursor: 'pointer',
                background: hov ? 'rgba(255,255,255,.06)' : 'transparent',
              }}
            >
              <span style={{
                width: 7, height: 7, borderRadius: '50%', background: d.c, flex: 'none',
                animation: d.pulse ? 'adPulse 1.2s ease-in-out infinite' : undefined,
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {a.name}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: subColor, marginTop: 1 }}>
                  {a.live ? 'Executing now…' : a.resultChip ?? a.triggerChip}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (!a.live) void api.executeNow(a.id, undefined, 'Menu bar').catch(() => undefined)
                }}
                title="Execute now"
                onMouseEnter={() => setHovBtn(a.id)}
                onMouseLeave={() => setHovBtn(null)}
                style={{
                  width: 24, height: 24, borderRadius: 6, flex: 'none',
                  border: `1px solid ${hovBtn === a.id ? 'var(--accent)' : 'rgba(255,255,255,.12)'}`,
                  background: 'rgba(255,255,255,.05)',
                  color: hovBtn === a.id ? 'var(--accent)' : 'var(--text-2em)',
                  opacity: hovBtn === a.id ? 1 : 0.35,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <i className="fa-solid fa-play" style={{ fontSize: 9 }} />
              </button>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)', width: 56, textAlign: 'right', flex: 'none' }}>
                {a.live ? '' : a.lastExecLabel}
              </span>
            </div>
          )
        })}
        {autos.length === 0 && (
          <div style={{ padding: '14px 12px', fontSize: 12, color: 'var(--text-faint)' }}>
            No automations yet — open Auto Dave to create one.
          </div>
        )}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '9px 16px', borderTop: '1px solid var(--hairline)',
      }}>
        <button
          onClick={() => void window.autodave?.openApp('/app')}
          onMouseEnter={() => setHovLink(true)}
          onMouseLeave={() => setHovLink(false)}
          style={{ fontSize: 12, color: hovLink ? 'var(--link-hover)' : 'var(--accent)', fontWeight: 500 }}
        >
          Open Auto Dave
        </button>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faintest)' }}>v{version || '0.1.0'}</span>
      </div>
    </div>
  )
}
