import React from 'react'
import { CountPill } from 'autowright'

// Next to nav labels — active row brighter, inactive dimmer.
export const InNav = () => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 'fit-content', display: 'flex', flexDirection: 'column', gap: 12 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Automations</span>
      <CountPill n={8} active />
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Executions</span>
      <CountPill n={124} />
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Agents</span>
      <CountPill n={3} />
    </div>
  </div>
)

// n=0 renders nothing — label stands alone.
export const ZeroHidden = () => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 'fit-content', display: 'flex', alignItems: 'center', gap: 8 }}>
    <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Drafts</span>
    <CountPill n={0} />
    <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>(pill hidden at n=0)</span>
  </div>
)
