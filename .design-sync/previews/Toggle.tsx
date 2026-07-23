import React from 'react'
import { Toggle } from 'autowright'

const frame: React.CSSProperties = {
  background: 'var(--bg-window)', padding: 20, borderRadius: 10,
  width: 'fit-content', display: 'flex', gap: 14, alignItems: 'center',
}

// Automation enabled — the on state used on every automation card.
export const On = () => (
  <div style={frame}>
    <span style={{ fontSize: 13, color: 'var(--text-2em)' }}>Automation enabled</span>
    <Toggle on={true} onChange={() => {}} />
  </div>
)

// Automation paused — off state.
export const Off = () => (
  <div style={frame}>
    <span style={{ fontSize: 13, color: 'var(--text-2em)' }}>Automation enabled</span>
    <Toggle on={false} onChange={() => {}} />
  </div>
)

// Locked on while an execution is in flight — disabled keeps the on tint at half opacity.
export const DisabledOn = () => (
  <div style={frame}>
    <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Enabled (executing — locked)</span>
    <Toggle on={true} disabled onChange={() => {}} />
  </div>
)
