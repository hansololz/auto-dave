// Menu-bar surface (§13): 334px translucent panel — one row per automation.
import React, { useEffect, useRef } from 'react'
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
  const ref = useRef<HTMLDivElement>(null)

  const failed = autos.filter((a) => a.lastStatus === 'failed').length
  const aggregate = failed > 0
    ? `${failed} need${failed === 1 ? 's' : ''} attention`
    : `All good · ${autos.length} automation${autos.length === 1 ? '' : 's'}`

  useEffect(() => {
    if (ref.current) void window.autowright?.resizePanel(ref.current.scrollHeight)
  }, [autos.length])

  const openAuto = (id: string) => { void window.autowright?.openApp(`/app?auto=${id}`) }

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
        <Eyebrow>Autowright</Eyebrow>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500, color: failed ? 'var(--red-hover)' : 'var(--text-faint)' }}>{aggregate}</div>
      </div>
      <div>
        {autos.map((a) => {
          const d = dotColor(a)
          const subColor = a.live
            ? 'var(--cyan)'
            : a.lastStatus === 'failed'
              ? 'var(--red-hover)'
              : a.resultChip
                ? 'var(--accent)'
                : 'var(--text-faint)'
          return (
            <div
              key={a.id}
              className="ad-hover-row"
              onClick={() => openAuto(a.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
                cursor: 'pointer',
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
                className="ad-btn-link"
                onClick={(e) => {
                  e.stopPropagation()
                  if (!a.live) void api.executeNow(a.id, undefined, 'Menu bar').catch(() => undefined)
                }}
                title="Execute now"
                style={{
                  width: 24, height: 24, borderRadius: 6, flex: 'none',
                  border: '1px solid rgba(255,255,255,.12)', background: 'rgba(255,255,255,.05)',
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
            No automations yet — open Autowright to create one.
          </div>
        )}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '9px 16px', borderTop: '1px solid var(--hairline)',
      }}>
        <button
          className="ad-btn-link"
          onClick={() => void window.autowright?.openApp('/app')}
        >
          Open Autowright
        </button>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faintest)' }}>v{version || '0.1.0'}</span>
      </div>
    </div>
  )
}
