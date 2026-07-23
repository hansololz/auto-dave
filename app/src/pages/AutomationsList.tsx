// Automations list (§4, prototype "Automations list" screen).
import React, { useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Auto } from '../types'
import { Badge, BtnGhost, BtnPrimary, ConfirmModal, MiniBadge, PageTitle, resultChipColors, EXECUTING_TOAST } from '../ui'


function AutoCard({ a }: { a: Auto }) {
  const go = useStore((s) => s.go)
  const showToast = useStore((s) => s.showToast)
  const executing = !!a.live

  const execute = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (executing) return
    void (async () => {
      try {
        await api.executeNow(a.id)
      } catch (err) {
        const er = err as Error & { status?: number }
        showToast(er.status === 409 ? EXECUTING_TOAST : er.message)
      }
    })()
  }

  return (
    <div
      className="ad-card-click"
      onClick={() => go('automation', { autoId: a.id })}
      style={{
        borderRadius: 12, padding: 16,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <div style={{ flex: 1, fontSize: 14, fontWeight: 600, minWidth: 0 }}>{a.name}</div>
        <button
          className="ad-btn-exec"
          onClick={execute}
          disabled={executing}
          title={executing ? 'Executing…' : 'Execute now'}
        >
          {/* play glyph sits 1px right of center optically */}
          <i
            className={executing ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-play'}
            style={{ fontSize: 9, marginLeft: executing ? 0 : 1 }}
          />
        </button>
      </div>
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-muted)', minHeight: 37 }}>{a.desc}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <span style={{
          fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11,
          color: (a.triggersOff || a.triggers.length === 0) ? 'var(--text-faint)' : 'var(--text-muted)',
          background: 'rgba(255,255,255,.05)', borderRadius: 6, padding: '3px 8px',
        }}>
          {a.triggerChip}
        </span>
        {a.triggersOff && (
          <MiniBadge c="var(--gray)" bg="var(--gray-bg)">OFF</MiniBadge>
        )}
        <Badge
          status={a.lastStatus}
          style={{
            padding: '3px 8px',
            animation: a.lastStatus === 'executing' ? 'adPulse 1.4s ease-in-out infinite' : 'none',
          }}
        />
        {a.resultChip && (
          <span style={{
            fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11,
            color: resultChipColors(a.resultStatus).c,
            background: resultChipColors(a.resultStatus).bg,
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
  const pendingDraft = useStore((s) => s.pendingDraft)
  const [confirmFresh, setConfirmFresh] = useState(false)

  // §4.4/§9.1: with a kept pending draft, New automation starts fresh —
  // confirm, delete the slot, then open the create flow empty.
  const startFresh = async () => {
    setConfirmFresh(false)
    try { await api.deletePendingDraft() } catch { /* backend restarting */ }
    setSurface('create', 'app')
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '26px 30px 70px', animation: 'adFadeUp .4s ease' }}>
      <PageTitle
        right={(
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {pendingDraft && (
              <BtnGhost onClick={() => setSurface('create', 'app')}>
                Resume draft
              </BtnGhost>
            )}
            <BtnPrimary
              onClick={() => (pendingDraft ? setConfirmFresh(true) : setSurface('create', 'app'))}
            >
              New automation
            </BtnPrimary>
          </div>
        )}
      >
        Automations
      </PageTitle>
      {confirmFresh && (
        <ConfirmModal
          title="Start a new automation?"
          body={`Your unsaved draft${pendingDraft?.name ? ` “${pendingDraft.name}”` : ''} will be discarded. This can't be undone.`}
          confirmLabel="Discard and start new"
          danger
          onConfirm={() => void startFresh()}
          onCancel={() => setConfirmFresh(false)}
        />
      )}
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
            No automations yet. Describe a job in plain words — your AI writes it as scripts you can read, and Autowright executes them on your schedule.
          </p>
          <BtnPrimary onClick={() => setSurface('create', 'app')}>Create your first automation</BtnPrimary>
        </div>
      )}
    </div>
  )
}
