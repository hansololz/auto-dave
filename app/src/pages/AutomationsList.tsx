// Automations list (§4, prototype "Automations list" screen).
import React, { useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Auto } from '../types'
import { Badge, BtnPrimary, resultChipColors } from '../ui'

const RUNNING_TOAST = 'Already running — one run at a time. A schedule firing now would be skipped.'

function AutoCard({ a }: { a: Auto }) {
  const go = useStore((s) => s.go)
  const showToast = useStore((s) => s.showToast)
  const [hov, setHov] = useState(false)
  const [runHov, setRunHov] = useState(false)
  const running = !!a.live

  const run = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (running) return
    void (async () => {
      try {
        await api.runNow(a.id)
      } catch (err) {
        const er = err as Error & { status?: number }
        showToast(er.status === 409 ? RUNNING_TOAST : er.message)
      }
    })()
  }

  return (
    <div
      onClick={() => go('automation', { autoId: a.id })}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        background: hov ? '#141823' : 'var(--bg-card)',
        border: `1px solid ${hov ? 'rgba(255,255,255,.16)' : 'var(--border-card)'}`,
        borderRadius: 12, padding: 16, cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <div style={{ flex: 1, fontSize: 14, fontWeight: 600, minWidth: 0 }}>{a.name}</div>
        <button
          onClick={run}
          disabled={running}
          title={running ? 'Running…' : 'Run now'}
          onMouseEnter={() => setRunHov(true)}
          onMouseLeave={() => setRunHov(false)}
          style={{
            width: 28, height: 28, borderRadius: 7, border: 'none',
            background: running
              ? 'oklch(0.74 0.155 52 / .16)'
              : runHov ? 'var(--accent-hover)' : 'var(--accent)',
            color: running ? 'oklch(0.74 0.155 52 / .55)' : 'var(--on-accent)',
            cursor: running ? 'default' : 'pointer', fontSize: 10, fontWeight: 500, flex: 'none',
          }}
        >
          <i className={running ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-play'} style={{ fontSize: 9 }} />
        </button>
      </div>
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-muted)', minHeight: 37 }}>{a.desc}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <span style={{
          fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11,
          color: a.schedOff ? 'var(--text-faint)' : 'var(--text-muted)',
          background: 'rgba(255,255,255,.05)', borderRadius: 6, padding: '3px 8px',
        }}>
          {a.scheduleShort}
        </span>
        {a.schedOff && (
          <span style={{
            display: 'inline-flex', padding: '3px 7px', borderRadius: 6,
            fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 9.5, letterSpacing: '.06em',
            background: 'rgba(152,161,173,.16)', color: 'var(--gray)',
          }}>
            OFF
          </span>
        )}
        <Badge
          status={a.lastStatus}
          style={{
            padding: '3px 8px', letterSpacing: '.05em',
            animation: a.lastStatus === 'running' ? 'adPulse 1.4s ease-in-out infinite' : 'none',
          }}
        />
        {a.resultChip && (
          <span style={{
            fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11,
            color: resultChipColors({ status: a.resultStatus ?? 'ok' }).c,
            background: resultChipColors({ status: a.resultStatus ?? 'ok' }).bg,
            borderRadius: 6, padding: '3px 8px',
          }}>
            {a.resultChip}
          </span>
        )}
      </div>
    </div>
  )
}

export default function AutomationsList() {
  const autos = useStore((s) => s.autos)
  const setSurface = useStore((s) => s.setSurface)

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '26px 30px 70px', animation: 'adFadeUp .4s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.01em', margin: 0 }}>Automations</h1>
        <BtnPrimary onClick={() => setSurface('create', 'app')} style={{ padding: '8px 14px' }}>
          New automation
        </BtnPrimary>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(310px,1fr))', gap: 14 }}>
        {autos.map((a) => <AutoCard key={a.id} a={a} />)}
      </div>
      {autos.length === 0 && (
        <div style={{
          background: 'var(--bg-card)', border: '1px dashed rgba(255,255,255,.12)', borderRadius: 12,
          padding: '36px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 12, textAlign: 'center',
        }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)', maxWidth: 420 }}>
            No automations yet. Describe a job in plain words — your AI writes it as scripts you can read, and Auto Dave runs them on your schedule.
          </p>
          <BtnPrimary onClick={() => setSurface('create', 'app')}>Create your first automation</BtnPrimary>
        </div>
      )}
    </div>
  )
}
